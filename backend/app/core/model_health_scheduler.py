"""模型连通性定时健康检查调度器。

后台守护线程，每隔 ``CHECK_INTERVAL`` 秒对所有启用的 LLM 配置执行一次
轻量连通性探测，更新 ``LLMConfig.health_status``，并在状态由「正常」转为
「异常」时向通知中心推送告警（避免重复告警：仅在状态翻转时通知）。

设计要点：
- 复用 ``llm_config`` 路由中已有的 HTTP 探测逻辑（抽取为 ``_ping_config``）。
- 单次探测失败不告警；连续 2 次失败才标记 ``unhealthy`` 并通知，避免网络抖动误报。
- 探测结果同步写入 ``model_call_logs``（trigger_type=health_check），可在监控页查看。
- 所有异常吞掉，调度器本身永不退出。
"""
import logging
import threading
import time as _time
from typing import Optional

from app.core.timezone import beijing_now

logger = logging.getLogger(__name__)

# 默认检查间隔（秒）：实际值从系统配置 model.health_check_interval 读取
DEFAULT_CHECK_INTERVAL = 300
# 允许的最小/最大间隔（秒）：防止误配置导致过密或过疏
MIN_CHECK_INTERVAL = 60
MAX_CHECK_INTERVAL = 3600
# 连续失败阈值：连续 N 次失败才标记异常并告警
FAILURE_THRESHOLD = 2

_scheduler_started = False
_scheduler_lock = threading.Lock()

# 记录每个配置的连续失败次数（内存态，重启后重置）
_failure_streak: dict[int, int] = {}


def _get_check_interval() -> int:
    """从系统配置读取健康检查间隔（秒），容错返回默认值。

    读取失败、值非法或越界时返回 ``DEFAULT_CHECK_INTERVAL``。
    读到的值会 clamp 到 [MIN_CHECK_INTERVAL, MAX_CHECK_INTERVAL]。
    """
    try:
        from app.database import SessionLocal
        from app.models.system_config import SystemConfig

        db = SessionLocal()
        try:
            cfg = (
                db.query(SystemConfig)
                .filter(SystemConfig.key == "model.health_check_interval")
                .first()
            )
            if not cfg or not cfg.value:
                return DEFAULT_CHECK_INTERVAL
            val = int(str(cfg.value).strip())
            if val < MIN_CHECK_INTERVAL:
                return MIN_CHECK_INTERVAL
            if val > MAX_CHECK_INTERVAL:
                return MAX_CHECK_INTERVAL
            return val
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("读取健康检查间隔失败，使用默认值 %ds: %s", DEFAULT_CHECK_INTERVAL, exc)
        return DEFAULT_CHECK_INTERVAL


def _ping_config(cfg) -> tuple[bool, str, Optional[int]]:
    """对单个 LLMConfig 执行轻量连通性探测。

    Returns:
        ``(success, error_message, latency_ms)``
    """
    import httpx
    import re

    provider = (cfg.provider or "anthropic").lower()
    api_key = (cfg.api_key or "").strip()
    if not api_key:
        return False, "API Key 为空", None

    # Embedding 模型走 /embeddings 端点
    if (cfg.model_type or "chat").lower() == "embedding":
        from app.core.llm_helper import _no_proxy_http_client, clean_base_url

        base = clean_base_url(cfg.base_url or "https://api.openai.com/v1")
        if base.endswith("/embeddings/multimodal"):
            url = base[: -len("/multimodal")]
        elif base.endswith("/embeddings"):
            url = base
        elif re.search(r"/v\d+$", base):
            url = f"{base}/embeddings"
        else:
            url = f"{base}/v1/embeddings"
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
        payload = {"model": cfg.model_name or "text-embedding-ada-002", "input": ["ping"]}
        t0 = _time.monotonic()
        try:
            with _no_proxy_http_client(base, 15) as client:
                r = client.post(url, json=payload, headers=headers)
            latency_ms = int((_time.monotonic() - t0) * 1000)
            if r.status_code != 200:
                return False, f"HTTP {r.status_code}: {r.text[:200]}", latency_ms
            return True, "", latency_ms
        except Exception as exc:  # noqa: BLE001
            return False, str(exc)[:300], int((_time.monotonic() - t0) * 1000)

    # Anthropic 原生 API
    if provider == "anthropic":
        from langchain_anthropic import ChatAnthropic
        from langchain_core.messages import HumanMessage

        llm_kwargs = {
            "model": cfg.model_name or "claude-3-5-sonnet-20241022",
            "api_key": api_key,
            "max_tokens": 10,
        }
        if cfg.base_url:
            llm_kwargs["anthropic_api_url"] = cfg.base_url
        t0 = _time.monotonic()
        try:
            llm = ChatAnthropic(**llm_kwargs)
            llm.invoke([HumanMessage(content="hi")])
            return True, "", int((_time.monotonic() - t0) * 1000)
        except Exception as exc:  # noqa: BLE001
            return False, str(exc)[:300], int((_time.monotonic() - t0) * 1000)

    # OpenAI 兼容接口
    from app.core.llm_helper import _no_proxy_http_client, clean_base_url

    base = clean_base_url(cfg.base_url or "https://api.openai.com/v1")
    if base.endswith("/chat/completions"):
        url = base
    elif re.search(r"/v\d+$", base):
        url = f"{base}/chat/completions"
    else:
        url = f"{base}/v1/chat/completions"
    headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}
    payload = {
        "model": cfg.model_name or "gpt-3.5-turbo",
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 10,
    }
    t0 = _time.monotonic()
    try:
        with _no_proxy_http_client(base, 15) as client:
            r = client.post(url, json=payload, headers=headers)
        latency_ms = int((_time.monotonic() - t0) * 1000)
        if r.status_code != 200:
            return False, f"HTTP {r.status_code}: {r.text[:200]}", latency_ms
        return True, "", latency_ms
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:300], int((_time.monotonic() - t0) * 1000)


def _notify_unhealthy(cfg, error: str) -> None:
    """向通知中心推送模型异常告警（吞掉异常）。"""
    try:
        from app.database import SessionLocal

        db = SessionLocal()
        try:
            # 走通知规则路由：有匹配规则则定向通知目标用户，无匹配则回退全员广播
            from app.core.notification_dispatch import dispatch_notification
            dispatch_notification(
                db,
                event_type="model_alert",
                title=f"模型异常：{cfg.name}",
                content=(
                    f"模型配置「{cfg.name}」(Provider: {cfg.provider}, "
                    f"Model: {cfg.model_name})健康检查失败。\n"
                    f"错误：{error[:300]}\n"
                    f"时间：{beijing_now().strftime('%Y-%m-%d %H:%M:%S')}"
                ),
                related_type="llm_config",
                related_id=cfg.id,
                created_by="health-checker",
            )
            db.commit()
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("推送模型异常通知失败（忽略）: %s", exc)


def _check_all_configs() -> None:
    """对所有启用的 LLM 配置执行一次健康检查。"""
    try:
        from app.database import SessionLocal
        from app.models.llm_config import LLMConfig
        from app.core.model_call_monitor import record_model_call

        db = SessionLocal()
        try:
            configs = db.query(LLMConfig).filter(LLMConfig.enabled.is_(True)).all()
            logger.info("健康检查开始，共 %d 个启用的配置", len(configs))
            for cfg in configs:
                try:
                    success, error, latency_ms = _ping_config(cfg)
                    # 记录到调用监控
                    record_model_call(
                        model_config_id=cfg.id,
                        model_name=cfg.model_name,
                        provider=cfg.provider,
                        status="success" if success else "failed",
                        latency_ms=latency_ms,
                        error_message=error,
                        trigger_type="health_check",
                    )
                    if success:
                        # 成功：重置失败计数，更新为 healthy
                        _failure_streak.pop(cfg.id, None)
                        prev_status = cfg.health_status
                        db.query(LLMConfig).filter(LLMConfig.id == cfg.id).update({
                            LLMConfig.health_status: "healthy",
                            LLMConfig.last_test_at: beijing_now(),
                            LLMConfig.last_test_error: None,
                            LLMConfig.last_test_latency_ms: latency_ms,
                        })
                        # 如果之前是 unhealthy，推送恢复通知
                        if prev_status == "unhealthy":
                            _notify_recovered(cfg)
                    else:
                        # 失败：累加失败计数
                        streak = _failure_streak.get(cfg.id, 0) + 1
                        _failure_streak[cfg.id] = streak
                        prev_status = cfg.health_status
                        # 仅在达到阈值时标记 unhealthy 并告警
                        if streak >= FAILURE_THRESHOLD:
                            db.query(LLMConfig).filter(LLMConfig.id == cfg.id).update({
                                LLMConfig.health_status: "unhealthy",
                                LLMConfig.last_test_at: beijing_now(),
                                LLMConfig.last_test_error: error,
                                LLMConfig.last_test_latency_ms: latency_ms,
                            })
                            # 仅在状态从 healthy 翻转为 unhealthy 时告警
                            if prev_status != "unhealthy":
                                _notify_unhealthy(cfg, error)
                                logger.warning(
                                    "模型健康检查异常: id=%s name=%s error=%s",
                                    cfg.id, cfg.name, error[:100],
                                )
                        else:
                            logger.info(
                                "模型探测失败(第%d次,未达阈值): id=%s name=%s",
                                streak, cfg.id, cfg.name,
                            )
                except Exception as exc:  # noqa: BLE001
                    logger.warning("探测配置 %s 时异常: %s", cfg.id, exc)
            db.commit()
            logger.info("健康检查完成")
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("健康检查循环异常（忽略）: %s", exc)


def _notify_recovered(cfg) -> None:
    """向通知中心推送模型恢复通知。"""
    try:
        from app.database import SessionLocal

        db = SessionLocal()
        try:
            from app.core.notification_dispatch import dispatch_notification
            dispatch_notification(
                db,
                event_type="model_alert",
                title=f"模型恢复：{cfg.name}",
                content=(
                    f"模型配置「{cfg.name}」健康检查已恢复正常。"
                    f"时间：{beijing_now().strftime('%Y-%m-%d %H:%M:%S')}"
                ),
                related_type="llm_config",
                related_id=cfg.id,
                created_by="health-checker",
            )
            db.commit()
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.warning("推送模型恢复通知失败（忽略）: %s", exc)


def _scheduler_loop() -> None:
    """健康检查调度器主循环：每隔「系统配置 model.health_check_interval」秒检查一次所有启用的配置。

    每轮 sleep 前重新读取间隔值，前端修改后无需重启即可在下一轮生效。
    """
    interval = _get_check_interval()
    logger.info("模型健康检查调度器已启动，间隔 %d 秒", interval)
    # 启动后延迟 30 秒再首次执行（等待应用完全就绪）
    _time.sleep(30)
    while True:
        try:
            _check_all_configs()
        except Exception as exc:  # noqa: BLE001
            logger.warning("健康检查执行异常（忽略，继续循环）: %s", exc)
        # 每轮重新读取间隔，支持运行时热更新
        new_interval = _get_check_interval()
        if new_interval != interval:
            logger.info("健康检查间隔已更新: %ds -> %ds", interval, new_interval)
            interval = new_interval
        _time.sleep(interval)


def start_health_scheduler() -> None:
    """启动健康检查调度器守护线程（幂等，仅启动一次）。"""
    global _scheduler_started
    with _scheduler_lock:
        if _scheduler_started:
            return
        _scheduler_started = True
    t = threading.Thread(target=_scheduler_loop, daemon=True, name="model-health-checker")
    t.start()
    logger.info("模型健康检查调度器线程已启动")


def run_health_check_now() -> dict:
    """手动触发一次健康检查（供 API 调用）。

    Returns:
        ``{"checked": N, "healthy": N, "unhealthy": N}``
    """
    from app.database import SessionLocal
    from app.models.llm_config import LLMConfig
    from app.core.model_call_monitor import record_model_call

    db = SessionLocal()
    checked = healthy = unhealthy = 0
    try:
        configs = db.query(LLMConfig).filter(LLMConfig.enabled.is_(True)).all()
        for cfg in configs:
            try:
                success, error, latency_ms = _ping_config(cfg)
                checked += 1
                record_model_call(
                    model_config_id=cfg.id,
                    model_name=cfg.model_name,
                    provider=cfg.provider,
                    status="success" if success else "failed",
                    latency_ms=latency_ms,
                    error_message=error,
                    trigger_type="health_check",
                )
                if success:
                    healthy += 1
                    _failure_streak.pop(cfg.id, None)
                    db.query(LLMConfig).filter(LLMConfig.id == cfg.id).update({
                        LLMConfig.health_status: "healthy",
                        LLMConfig.last_test_at: beijing_now(),
                        LLMConfig.last_test_error: None,
                        LLMConfig.last_test_latency_ms: latency_ms,
                    })
                else:
                    unhealthy += 1
                    db.query(LLMConfig).filter(LLMConfig.id == cfg.id).update({
                        LLMConfig.health_status: "unhealthy",
                        LLMConfig.last_test_at: beijing_now(),
                        LLMConfig.last_test_error: error,
                        LLMConfig.last_test_latency_ms: latency_ms,
                    })
            except Exception as exc:  # noqa: BLE001
                logger.warning("手动探测配置 %s 时异常: %s", cfg.id, exc)
        db.commit()
    finally:
        db.close()
    return {"checked": checked, "healthy": healthy, "unhealthy": unhealthy}
