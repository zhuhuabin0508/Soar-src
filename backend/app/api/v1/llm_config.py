"""LLM 配置 CRUD 路由 + 模型监控统计 + 测试历史。

v2 增强：
- 配置列表返回健康状态、最近测试时间、高级参数等扩展字段
- Provider 模板接口：返回各 Provider 的官方 Base URL、常用模型、图标
- 测试接口更新健康状态，并返回测试延迟
- 测试历史接口：保存每次测试的时间、结果、延迟
- 调用统计增加错误次数、Top3 失败原因、来源分布
- 调用明细返回请求/响应摘要、错误堆栈、来源 IP、用户、会话
- 复制配置接口
- 手动触发健康检查接口
- 查看 API Key 明文接口（审计记录）
- 创建/更新/删除接口记录字段级变更审计日志
"""
import logging
import traceback
from datetime import datetime, timedelta
from typing import Any, Optional

from app.core.timezone import beijing_now, beijing_now_iso
from app.core.provider_templates import PROVIDER_TEMPLATES, get_provider_template, get_provider_models
from app.core.llm_helper import normalize_reasoning_effort

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import case, func
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user, require_permission, require_role
from app.models.llm_config import LLMConfig
from app.models.model_call_log import ModelCallLog
from app.schemas.common import to_dict, to_dict_list
from app.core.llm_helper import clean_base_url
from app.core.audit import log_audit, get_client_ip

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/llm-configs",
    tags=["llm-configs"],
    dependencies=[Depends(get_current_user)],
)


class LLMConfigBase(BaseModel):
    """LLM 配置请求体（v2，含高级参数）。"""

    name: str = Field(..., description="配置名称")
    provider: str = Field("anthropic", description="供应商，如 anthropic/openai")
    api_key: str = Field("", description="API Key")
    base_url: str = Field("", description="自定义 Base URL，可空")
    model_name: str = Field("", description="模型名，如 claude-3-5-sonnet-20241022")
    model_type: str = Field("chat", description="模型类型：chat/embedding/vision/rerank")
    is_default: bool = Field(False, description="是否设为默认模型")
    # 高级参数
    temperature: Optional[float] = Field(None, description="采样温度")
    max_tokens: Optional[int] = Field(None, description="最大生成 token 数")
    top_p: Optional[float] = Field(None, description="核采样概率")
    reasoning_effort: Optional[str] = Field(
        None,
        description="推理模型思考深度：minimal/low/medium/high；None 表示不传用模型默认。仅 OpenAI 兼容推理模型支持",
    )
    timeout: Optional[int] = Field(None, description="超时秒数")
    max_retries: Optional[int] = Field(None, description="最大重试次数")
    org_id: Optional[str] = Field(None, description="组织 ID")
    project_id: Optional[str] = Field(None, description="项目 ID")
    enabled: bool = Field(True, description="是否启用")


def _set_default(db: Session, config_id: int) -> None:
    """将指定配置设为默认，其余取消默认。

    注：按 model_type 分类设置默认，chat/embedding/vision/rerank 各一个默认。
    """
    cfg = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if cfg is None:
        return
    mtype = cfg.model_type or "chat"
    db.query(LLMConfig).filter(
        LLMConfig.model_type == mtype,
        LLMConfig.is_default.is_(True),
    ).update({LLMConfig.is_default: False})
    db.query(LLMConfig).filter(LLMConfig.id == config_id).update({LLMConfig.is_default: True})


def _parse_sse_chat_stream(text: str) -> tuple[str, str, dict]:
    """解析 OpenAI 兼容的 SSE 流式响应，聚合正文、思维链和 token 用量。

    部分网关（如 new-api）对个别模型通道强制返回 ``text/event-stream``，
    即使请求体里传 ``stream=false`` 也不生效，因此测试连通性时需兼容 SSE。

    Returns:
        ``(content, reasoning, usage)``
    """
    import json

    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    usage: dict = {}
    for line in text.splitlines():
        line = line.strip()
        if not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            chunk = json.loads(payload)
        except (ValueError, TypeError):
            continue
        if not isinstance(chunk, dict):
            continue
        if chunk.get("usage"):
            usage = chunk["usage"] or {}
        choices = chunk.get("choices") or []
        if not choices:
            continue
        choice = choices[0] or {}
        delta = choice.get("delta") or {}
        message = choice.get("message") or {}
        val = delta.get("content") or message.get("content")
        if isinstance(val, str):
            content_parts.append(val)
        # 推理模型（GLM/DeepSeek-R1 等）的思维链字段
        reasoning = delta.get("reasoning_content") or delta.get("reasoning")
        if isinstance(reasoning, str):
            reasoning_parts.append(reasoning)
    return "".join(content_parts), "".join(reasoning_parts), usage


def _update_health(db: Session, config_id: int, status: str, error: str = "", latency_ms: Optional[int] = None) -> None:
    """更新配置的健康状态。"""
    db.query(LLMConfig).filter(LLMConfig.id == config_id).update({
        LLMConfig.health_status: status,
        LLMConfig.last_test_at: beijing_now(),
        LLMConfig.last_test_error: error or None,
        LLMConfig.last_test_latency_ms: latency_ms,
    })


@router.get("", dependencies=[Depends(require_permission("llm_config", "view"))])
def list_llm_configs(db: Session = Depends(get_db)) -> list[dict]:
    """列出所有 LLM 配置（含健康状态、高级参数）。"""
    logger.info("查询 LLM 配置列表")
    configs = db.query(LLMConfig).order_by(LLMConfig.created_at.desc()).all()
    result = []
    for c in configs:
        d = to_dict(c)
        # mask api_key for list view（前端脱敏显示）
        if d.get("api_key"):
            k = d["api_key"]
            d["api_key"] = f"{k[:4]}****{k[-4:]}" if len(k) > 8 else "****"
        result.append(d)
    return result


@router.post("", status_code=201, dependencies=[Depends(require_permission("llm_config", "edit"))])
def create_llm_config(body: LLMConfigBase, request: Request, db: Session = Depends(get_db)) -> dict:
    """创建 LLM 配置。"""
    logger.info("创建 LLM 配置: name=%s, provider=%s", body.name, body.provider)
    config = LLMConfig(
        name=body.name,
        provider=body.provider,
        api_key=body.api_key,
        base_url=body.base_url,
        model_name=body.model_name,
        model_type=body.model_type,
        is_default=body.is_default,
        temperature=body.temperature,
        max_tokens=body.max_tokens,
        top_p=body.top_p,
        reasoning_effort=normalize_reasoning_effort(body.reasoning_effort),
        timeout=body.timeout,
        max_retries=body.max_retries,
        org_id=body.org_id,
        project_id=body.project_id,
        enabled=body.enabled,
    )
    db.add(config)
    db.commit()
    db.refresh(config)
    if body.is_default:
        _set_default(db, config.id)
        db.commit()
        db.refresh(config)
    logger.info("LLM 配置已创建: id=%s", config.id)
    # 审计日志：记录新建字段
    log_audit(
        db,
        action="create",
        resource_type="llm_config",
        resource_id=str(config.id),
        detail={
            "name": config.name,
            "provider": config.provider,
            "model_name": config.model_name,
            "model_type": config.model_type,
            "is_default": config.is_default,
            "enabled": config.enabled,
        },
        ip_address=get_client_ip(request),
    )
    return to_dict(config)


@router.put("/{config_id}", dependencies=[Depends(require_permission("llm_config", "edit"))])
def update_llm_config(
    config_id: int, body: LLMConfigBase, request: Request, db: Session = Depends(get_db)
) -> dict:
    """更新 LLM 配置。

    API Key 留空（空字符串）表示不修改现有值。
    """
    logger.info("更新 LLM 配置: id=%s", config_id)
    config = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if config is None:
        raise HTTPException(status_code=404, detail="LLMConfig not found")
    # 记录字段级变更（用于审计）
    changes = {}
    # api_key 留空表示不修改
    new_api_key = body.api_key if body.api_key else None
    # 对比每个字段是否变更
    field_map = [
        ("name", body.name), ("provider", body.provider), ("base_url", body.base_url),
        ("model_name", body.model_name), ("model_type", body.model_type),
        ("is_default", body.is_default), ("temperature", body.temperature),
        ("max_tokens", body.max_tokens), ("top_p", body.top_p),
        ("reasoning_effort", body.reasoning_effort), ("timeout", body.timeout),
        ("max_retries", body.max_retries), ("org_id", body.org_id),
        ("project_id", body.project_id), ("enabled", body.enabled),
    ]
    for field, new_val in field_map:
        old_val = getattr(config, field)
        if old_val != new_val:
            changes[field] = {"old": old_val, "new": new_val}
    # api_key 单独处理（脱敏记录）
    if new_api_key and config.api_key != new_api_key:
        changes["api_key"] = {"old": "***", "new": "***"}

    config.name = body.name
    config.provider = body.provider
    if body.api_key:
        config.api_key = body.api_key
    config.base_url = body.base_url
    config.model_name = body.model_name
    config.model_type = body.model_type
    config.is_default = body.is_default
    # 高级参数
    config.temperature = body.temperature
    config.max_tokens = body.max_tokens
    config.top_p = body.top_p
    # 值域归一化（与智能体侧同口径，非法值存 None=不传）
    config.reasoning_effort = normalize_reasoning_effort(body.reasoning_effort)
    config.timeout = body.timeout
    config.max_retries = body.max_retries
    config.org_id = body.org_id
    config.project_id = body.project_id
    config.enabled = body.enabled
    db.commit()
    if body.is_default:
        _set_default(db, config.id)
        db.commit()
    db.refresh(config)
    logger.info("LLM 配置已更新: id=%s", config.id)
    # 审计日志：记录字段级变更
    log_audit(
        db,
        action="update",
        resource_type="llm_config",
        resource_id=str(config_id),
        detail={"name": config.name, "changed_fields": list(changes.keys()), "changes": changes},
        ip_address=get_client_ip(request),
    )
    return to_dict(config)


@router.delete("/{config_id}", dependencies=[Depends(require_permission("llm_config", "edit"))])
def delete_llm_config(config_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
    """删除 LLM 配置。"""
    logger.info("删除 LLM 配置: id=%s", config_id)
    config = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if config is None:
        raise HTTPException(status_code=404, detail="LLMConfig not found")
    # 审计日志：记录删除的配置信息
    log_audit(
        db,
        action="delete",
        resource_type="llm_config",
        resource_id=str(config_id),
        detail={
            "name": config.name,
            "provider": config.provider,
            "model_name": config.model_name,
            "model_type": config.model_type,
        },
        ip_address=get_client_ip(request),
    )
    db.delete(config)
    db.commit()
    logger.info("LLM 配置已删除: id=%s", config_id)
    return {"ok": True}


@router.post("/{config_id}/copy", summary="复制模型配置", dependencies=[Depends(require_permission("llm_config", "edit"))])
def copy_llm_config(config_id: int, db: Session = Depends(get_db)) -> dict:
    """复制现有配置创建新配置（名称自动加「(副本)」后缀）。"""
    logger.info("复制 LLM 配置: id=%s", config_id)
    src = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if src is None:
        raise HTTPException(status_code=404, detail="LLMConfig not found")
    new_cfg = LLMConfig(
        name=f"{src.name}(副本)",
        provider=src.provider,
        api_key=src.api_key,
        base_url=src.base_url,
        model_name=src.model_name,
        model_type=src.model_type,
        is_default=False,  # 副本不默认
        temperature=src.temperature,
        max_tokens=src.max_tokens,
        top_p=src.top_p,
        reasoning_effort=normalize_reasoning_effort(src.reasoning_effort),
        timeout=src.timeout,
        max_retries=src.max_retries,
        org_id=src.org_id,
        project_id=src.project_id,
        enabled=src.enabled,
    )
    db.add(new_cfg)
    db.commit()
    db.refresh(new_cfg)
    logger.info("LLM 配置已复制: src=%s, new=%s", config_id, new_cfg.id)
    return to_dict(new_cfg)


@router.get("/providers", summary="获取 Provider 模板列表", dependencies=[Depends(require_permission("llm_config", "view"))])
def list_provider_templates() -> dict:
    """返回所有 Provider 模板（含官方 Base URL、常用模型、图标等）。

    前端用于：
    - 创建/编辑配置时 Provider 下拉
    - 选择 Provider 后自动填充 Base URL
    - Model Name 下拉可选常用模型
    """
    return {"providers": PROVIDER_TEMPLATES}


@router.post("/health-check", summary="手动触发模型健康检查", dependencies=[Depends(require_permission("llm_config", "edit"))])
def trigger_health_check(request: Request, db: Session = Depends(get_db)) -> dict:
    """手动触发一次所有启用配置的健康检查（不等定时调度器）。

    返回每个配置的检查结果摘要。
    """
    from app.core.model_health_scheduler import run_health_check_now

    logger.info("手动触发模型健康检查")
    result = run_health_check_now()
    # 审计日志
    log_audit(
        db,
        action="execute",
        resource_type="llm_config",
        resource_id="health-check",
        detail={"action": "manual_health_check", "result": result},
        ip_address=get_client_ip(request),
    )
    return {"ok": True, **result}


@router.get(
    "/{config_id}/api-key",
    summary="查看 API Key 明文（审计记录）",
    dependencies=[Depends(require_role("admin"))],
)
def reveal_api_key(config_id: int, request: Request, db: Session = Depends(get_db)) -> dict:
    """返回指定配置的完整 API Key（仅管理员）。

    鉴权：明文密钥属最高敏感级别，仅 admin 角色可查看
    （``llm_config:view`` 默认 viewer 也持有，不足以保护密钥）。
    每次调用都会记录审计日志（谁在何时从哪个 IP 查看了明文 Key）。
    """
    logger.info("查看 API Key 明文: config_id=%s", config_id)
    cfg = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if cfg is None:
        raise HTTPException(status_code=404, detail="LLMConfig not found")
    # 审计日志：记录查看明文 Key 的操作
    log_audit(
        db,
        action="view",
        resource_type="llm_config",
        resource_id=str(config_id),
        detail={"action": "reveal_api_key", "name": cfg.name, "provider": cfg.provider},
        ip_address=get_client_ip(request),
    )
    return {"api_key": cfg.api_key or ""}


@router.post("/{config_id}/test", summary="测试 LLM 配置连通性", dependencies=[Depends(require_permission("llm_config", "view"))])
def test_llm_config(config_id: int, db: Session = Depends(get_db)) -> dict:
    """发送一条简单消息测试 LLM 配置是否可用。

    支持 Anthropic 原生 API 和 OpenAI 兼容接口（含国内厂商如火山引擎、Deepseek、Moonshot 等）。
    测试结果同步记录到 ``model_call_logs``（trigger_type=manual_test），并更新配置的健康状态。
    """
    logger.info("测试 LLM 配置连通性: id=%s", config_id)
    cfg = db.query(LLMConfig).filter(LLMConfig.id == config_id).first()
    if cfg is None:
        raise HTTPException(status_code=404, detail="配置不存在")
    # SSRF 防护：自定义 base_url 需通过出站校验（协议白名单 + 云元数据黑名单）
    if cfg.base_url:
        try:
            from app.core.security import validate_outbound_url

            validate_outbound_url(cfg.base_url, field="base_url")
        except ValueError as exc:
            _update_health(db, config_id, "unhealthy", str(exc))
            db.commit()
            return {"success": False, "error": str(exc), "model": cfg.model_name}
    try:
        provider = (cfg.provider or "anthropic").lower()
        # 清理 api_key：去除首尾空白与换行（常见于复制粘贴引入）
        api_key = (cfg.api_key or "").strip()
        if not api_key:
            _update_health(db, config_id, "unhealthy", "API Key 为空")
            db.commit()
            return {"success": False,
                    "error": "API Key 为空，请在配置中填写有效的 API Key",
                    "model": cfg.model_name}

        # ===== Embedding 模型测试：走 /embeddings 端点（非 chat completions）=====
        if (cfg.model_type or "chat").lower() == "embedding":
            import httpx
            import re
            import time
            from app.core.model_call_monitor import record_model_call
            from app.core.llm_helper import _no_proxy_http_client

            base = clean_base_url(cfg.base_url or "https://api.openai.com/v1")
            if base.endswith("/embeddings/multimodal"):
                regular_url = base[: -len("/multimodal")]
            elif base.endswith("/embeddings"):
                regular_url = base
            elif re.search(r"/v\d+$", base):
                regular_url = f"{base}/embeddings"
            else:
                regular_url = f"{base}/v1/embeddings"
            multimodal_url = regular_url + "/multimodal"
            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            model_name = cfg.model_name or "text-embedding-ada-002"
            t0 = time.monotonic()
            try:
                with _no_proxy_http_client(cfg.base_url or "", timeout=30) as client:
                    # 先尝试常规 /embeddings（支持批量）
                    payload = {"model": model_name, "input": ["连通性测试"]}
                    r = client.post(regular_url, json=payload, headers=headers)

                    if r.status_code == 400 and "does not support this api" in r.text:
                        # 多模态 embedding 模型 → 切换到 /embeddings/multimodal
                        logger.info("检测到多模态 embedding 模型，切换到 /embeddings/multimodal")
                        mm_payload = {
                            "model": model_name,
                            "input": [{"type": "text", "text": "连通性测试"}],
                            "encoding_format": "float",
                        }
                        r = client.post(multimodal_url, json=mm_payload, headers=headers)

                    latency_ms = int((time.monotonic() - t0) * 1000)
                    if r.status_code != 200:
                        err = f"HTTP {r.status_code}: {r.text[:400]}"
                        record_model_call(
                            model_config_id=cfg.id, model_name=cfg.model_name, provider=provider,
                            status="failed", latency_ms=latency_ms,
                            error_message=err,
                            trigger_type="manual_test",
                        )
                        _update_health(db, config_id, "unhealthy", err, latency_ms)
                        db.commit()
                        return {"success": False,
                                "error": err,
                                "model": cfg.model_name,
                                "latency_ms": latency_ms}
                    data = r.json()
                    # 兼容两种响应格式：
                    # 常规：{"data": [{"embedding": [...]}], "usage": {...}}
                    # 多模态：{"data": {"embedding": [...]}}
                    raw_data = data.get("data", [])
                    if isinstance(raw_data, list) and raw_data:
                        emb = raw_data[0].get("embedding") or []
                    elif isinstance(raw_data, dict):
                        emb = raw_data.get("embedding") or []
                    else:
                        emb = []
                    usage = data.get("usage", {}) or {}
                    record_model_call(
                        model_config_id=cfg.id, model_name=cfg.model_name, provider=provider,
                        status="success", latency_ms=latency_ms,
                        input_tokens=usage.get("prompt_tokens"),
                        output_tokens=usage.get("completion_tokens"),
                        trigger_type="manual_test",
                    )
                    _update_health(db, config_id, "healthy", "", latency_ms)
                    db.commit()
                    logger.info("Embedding 配置测试成功: id=%s, dim=%s", config_id, len(emb))
                    return {"success": True,
                            "response": f"向量维度: {len(emb)}",
                            "model": cfg.model_name,
                            "latency_ms": latency_ms}
            except Exception as http_exc:  # noqa: BLE001
                latency_ms = int((time.monotonic() - t0) * 1000)
                err = str(http_exc)[:500]
                record_model_call(
                    model_config_id=cfg.id, model_name=cfg.model_name, provider=provider,
                    status="failed", latency_ms=latency_ms,
                    error_message=err,
                    trigger_type="manual_test",
                )
                _update_health(db, config_id, "unhealthy", err, latency_ms)
                db.commit()
                return {"success": False, "error": err, "model": cfg.model_name, "latency_ms": latency_ms}

        if provider == "anthropic":
            # Anthropic 原生 API
            from langchain_anthropic import ChatAnthropic
            from langchain_core.messages import HumanMessage

            llm_kwargs = {
                "model": cfg.model_name or "claude-3-5-sonnet-20241022",
                "api_key": api_key,
                "max_tokens": 1024,
            }
            if cfg.base_url:
                llm_kwargs["anthropic_api_url"] = cfg.base_url
            from app.core.llm_helper import _no_proxy_http_client
            llm_kwargs["http_client"] = _no_proxy_http_client(cfg.base_url or "")
            llm = ChatAnthropic(**llm_kwargs)
            from app.core.model_call_monitor import ModelCallTimer

            try:
                with ModelCallTimer(
                    model_config_id=cfg.id, model_name=cfg.model_name, provider=provider,
                    trigger_type="manual_test",
                ) as timer:
                    resp = llm.invoke([HumanMessage(content="回复OK两个字")])
                    timer.set_response(resp)
                latency_ms = None
                # 从 timer 估算延迟（ModelCallTimer 内部已记录，但未暴露；此处取近似）
                _update_health(db, config_id, "healthy", "")
                db.commit()
                logger.info("LLM 配置测试成功(anthropic): id=%s", config_id)
                return {"success": True, "response": str(resp.content)[:200], "model": cfg.model_name}
            except Exception as exc:
                err = str(exc)[:500]
                _update_health(db, config_id, "unhealthy", err)
                db.commit()
                raise

        # OpenAI 兼容接口（openai / 火山引擎 / Deepseek / Moonshot / Zhipu 等）
        import re
        import time

        from app.core.llm_helper import _no_proxy_http_client

        # 构造请求 URL：兼容多种 base_url 写法
        base = clean_base_url(cfg.base_url or "https://api.openai.com/v1")
        if base.endswith("/chat/completions"):
            url = base
        elif re.search(r"/v\d+$", base):
            url = f"{base}/chat/completions"
        else:
            url = f"{base}/v1/chat/completions"

        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": cfg.model_name or "gpt-3.5-turbo",
            "messages": [{"role": "user", "content": "回复OK两个字"}],
            "max_tokens": 1024,
        }

        from app.core.model_call_monitor import record_model_call

        t0 = time.monotonic()
        try:
            with _no_proxy_http_client(cfg.base_url or "", timeout=30) as client:
                r = client.post(url, json=payload, headers=headers)
            latency_ms = int((time.monotonic() - t0) * 1000)
            if r.status_code != 200:
                logger.warning("LLM 配置测试失败(openai-compat): id=%s, status=%s, body=%s",
                               config_id, r.status_code, r.text[:300])
                err = f"HTTP {r.status_code}: {r.text[:400]}"
                record_model_call(
                    model_config_id=cfg.id, model_name=cfg.model_name, provider=provider,
                    status="failed", latency_ms=latency_ms,
                    error_message=err,
                    trigger_type="manual_test",
                )
                _update_health(db, config_id, "unhealthy", err, latency_ms)
                db.commit()
                return {"success": False,
                        "error": err,
                        "model": cfg.model_name,
                        "latency_ms": latency_ms}
            # 部分网关对个别模型通道强制返回 SSE（忽略 stream=false），需按流式聚合
            ctype = (r.headers.get("content-type") or "").lower()
            if "text/event-stream" in ctype or r.text.lstrip().startswith("data:"):
                content, reasoning, usage = _parse_sse_chat_stream(r.text)
                logger.info(
                    "LLM 配置测试收到 SSE 流式响应: id=%s, content_len=%d, reasoning_len=%d",
                    config_id, len(content), len(reasoning),
                )
                # 推理模型的思维链可能耗尽 token 导致正文为空，提示中带上思维链长度
                if not content and reasoning:
                    content = f"（模型仅返回思维链，共 {len(reasoning)} 字）"
            else:
                if not r.text.strip():
                    raise ValueError("HTTP 200 但响应体为空，无法解析模型返回")
                data = r.json()
                content = (data.get("choices") or [{}])[0].get("message", {}).get("content") or ""
                # 提取 token 用量
                usage = data.get("usage", {}) or {}
            record_model_call(
                model_config_id=cfg.id, model_name=cfg.model_name, provider=provider,
                status="success", latency_ms=latency_ms,
                input_tokens=usage.get("prompt_tokens"),
                output_tokens=usage.get("completion_tokens"),
                trigger_type="manual_test",
            )
            _update_health(db, config_id, "healthy", "", latency_ms)
            db.commit()
            logger.info("LLM 配置测试成功(openai-compat): id=%s", config_id)
            return {"success": True, "response": content[:200], "model": cfg.model_name, "latency_ms": latency_ms}
        except Exception as http_exc:  # noqa: BLE001
            latency_ms = int((time.monotonic() - t0) * 1000)
            err = str(http_exc)[:500]
            record_model_call(
                model_config_id=cfg.id, model_name=cfg.model_name, provider=provider,
                status="failed", latency_ms=latency_ms,
                error_message=err,
                trigger_type="manual_test",
            )
            _update_health(db, config_id, "unhealthy", err, latency_ms)
            db.commit()
            raise
    except Exception as exc:  # noqa: BLE001
        logger.warning("LLM 配置测试失败: id=%s, error=%s", config_id, exc)
        err = str(exc)[:500]
        # 确保健康状态更新（若上面分支未更新）
        try:
            _update_health(db, config_id, "unhealthy", err)
            db.commit()
        except Exception:
            pass
        return {"success": False, "error": err, "model": cfg.model_name if cfg else None}


@router.get("/{config_id}/test-history", summary="模型测试历史", dependencies=[Depends(require_permission("llm_config", "view"))])
def get_test_history(
    config_id: int,
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(get_db),
) -> dict:
    """查询指定配置的测试历史（从 model_call_logs 中过滤 trigger_type=manual_test）。"""
    logger.info("查询测试历史: config_id=%s", config_id)
    q = (
        db.query(ModelCallLog)
        .filter(ModelCallLog.model_config_id == config_id)
        .filter(ModelCallLog.trigger_type == "manual_test")
        .order_by(ModelCallLog.created_at.desc())
    )
    total = q.count()
    rows = q.limit(limit).all()
    return {
        "total": total,
        "history": [
            {
                "id": r.id,
                "status": r.status,
                "latency_ms": r.latency_ms,
                "error_message": r.error_message,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


# ============ 模型监控统计 ============

@router.get("/monitor/stats", summary="模型调用监控统计", dependencies=[Depends(require_permission("llm_config", "view"))])
def get_model_call_stats(
    days: int = Query(7, ge=1, le=90, description="统计最近 N 天"),
    trigger_type: str = Query("", description="按来源筛选：agent_test/manual_test/workflow/api/knowledge_vector"),
    db: Session = Depends(get_db),
) -> dict:
    """模型调用监控统计：按模型配置聚合调用次数、成功率、平均耗时、Token 用量。

    返回：
    - ``stats``：每个配置的汇总统计
    - ``summary``：全局汇总（总调用、平均成功率、平均耗时、总 Token）
    - ``error_top``：Top3 失败原因
    - ``source_dist``：来源分布
    - ``daily_trend``：按天聚合的趋势数据（调用次数、成功率、平均耗时）
    """
    since = beijing_now() - timedelta(days=days)
    logger.info("查询模型调用统计: days=%s, trigger_type=%s", days, trigger_type)

    base_q = db.query(ModelCallLog).filter(ModelCallLog.created_at >= since)
    if trigger_type:
        base_q = base_q.filter(ModelCallLog.trigger_type == trigger_type)

    # 按model_config_id聚合统计
    rows = (
        db.query(
            ModelCallLog.model_config_id,
            func.count(ModelCallLog.id).label("total"),
            func.sum(case((ModelCallLog.status == "success", 1), else_=0)).label("success"),
            func.sum(case((ModelCallLog.status == "failed", 1), else_=0)).label("failed"),
            func.avg(ModelCallLog.latency_ms).label("avg_latency_ms"),
            func.max(ModelCallLog.latency_ms).label("max_latency_ms"),
            func.min(ModelCallLog.latency_ms).label("min_latency_ms"),
            func.sum(ModelCallLog.input_tokens).label("total_input_tokens"),
            func.sum(ModelCallLog.output_tokens).label("total_output_tokens"),
            func.sum(ModelCallLog.total_tokens).label("total_tokens"),
        )
        .filter(ModelCallLog.created_at >= since)
    )
    if trigger_type:
        rows = rows.filter(ModelCallLog.trigger_type == trigger_type)
    rows = rows.group_by(ModelCallLog.model_config_id).all()

    # 加载所有配置（含名称，便于前端展示）
    configs = {c.id: c for c in db.query(LLMConfig).all()}
    # 获取最近调用时间
    last_call_q = (
        db.query(
            ModelCallLog.model_config_id,
            func.max(ModelCallLog.created_at).label("last_call_at"),
        )
        .filter(ModelCallLog.created_at >= since)
    )
    if trigger_type:
        last_call_q = last_call_q.filter(ModelCallLog.trigger_type == trigger_type)
    last_call_rows = last_call_q.group_by(ModelCallLog.model_config_id).all()
    last_call_map = {r.model_config_id: r.last_call_at for r in last_call_rows}

    stats = []
    total_calls_all = 0
    total_success_all = 0
    total_failed_all = 0
    total_tokens_all = 0
    total_latency_sum = 0
    total_latency_count = 0
    for r in rows:
        cfg = configs.get(r.model_config_id) if r.model_config_id else None
        total = int(r.total or 0)
        success = int(r.success or 0)
        failed = int(r.failed or 0)
        total_calls_all += total
        total_success_all += success
        total_failed_all += failed
        total_tokens_all += int(r.total_tokens or 0)
        if r.avg_latency_ms is not None:
            total_latency_sum += float(r.avg_latency_ms) * total
            total_latency_count += total
        stats.append({
            "model_config_id": r.model_config_id,
            "config_name": cfg.name if cfg else "(已删除配置)",
            "model_name": cfg.model_name if cfg else "",
            "provider": cfg.provider if cfg else "",
            "total_calls": total,
            "success": success,
            "failed": failed,
            "success_rate": round(success / total, 4) if total > 0 else 0.0,
            "avg_latency_ms": round(float(r.avg_latency_ms or 0), 1),
            "max_latency_ms": int(r.max_latency_ms or 0),
            "min_latency_ms": int(r.min_latency_ms or 0),
            "total_input_tokens": int(r.total_input_tokens or 0),
            "total_output_tokens": int(r.total_output_tokens or 0),
            "total_tokens": int(r.total_tokens or 0),
            "last_call_at": last_call_map.get(r.model_config_id).isoformat()
            if last_call_map.get(r.model_config_id)
            else None,
        })

    # 按总调用数降序
    stats.sort(key=lambda s: s["total_calls"], reverse=True)

    # ===== 全局汇总 =====
    summary = {
        "total_calls": total_calls_all,
        "total_success": total_success_all,
        "total_failed": total_failed_all,
        "avg_success_rate": round(total_success_all / total_calls_all, 4) if total_calls_all > 0 else 0.0,
        "avg_latency_ms": round(total_latency_sum / total_latency_count, 1) if total_latency_count > 0 else 0.0,
        "total_tokens": total_tokens_all,
    }

    # ===== Top3 失败原因 =====
    error_rows = (
        db.query(
            ModelCallLog.error_message,
            func.count(ModelCallLog.id).label("cnt"),
        )
        .filter(ModelCallLog.created_at >= since)
        .filter(ModelCallLog.status == "failed")
        .filter(ModelCallLog.error_message.isnot(None))
        .filter(ModelCallLog.error_message != "")
    )
    if trigger_type:
        error_rows = error_rows.filter(ModelCallLog.trigger_type == trigger_type)
    error_rows = error_rows.group_by(ModelCallLog.error_message).order_by(func.count(ModelCallLog.id).desc()).limit(3).all()
    error_top = [
        {"error": r.error_message[:200] if r.error_message else "", "count": int(r.cnt)}
        for r in error_rows
    ]

    # ===== 来源分布 =====
    source_q = (
        db.query(
            ModelCallLog.trigger_type,
            func.count(ModelCallLog.id).label("cnt"),
        )
        .filter(ModelCallLog.created_at >= since)
    )
    if trigger_type:
        source_q = source_q.filter(ModelCallLog.trigger_type == trigger_type)
    source_rows = source_q.group_by(ModelCallLog.trigger_type).all()
    source_dist = [
        {"source": r.trigger_type or "unknown", "count": int(r.cnt)}
        for r in source_rows
    ]

    # ===== 按天聚合趋势 =====
    # 用 created_at::date 分组
    daily_rows = (
        db.query(
            func.date(ModelCallLog.created_at).label("d"),
            func.count(ModelCallLog.id).label("total"),
            func.sum(case((ModelCallLog.status == "success", 1), else_=0)).label("success"),
            func.avg(ModelCallLog.latency_ms).label("avg_latency"),
            func.sum(ModelCallLog.total_tokens).label("tokens"),
        )
        .filter(ModelCallLog.created_at >= since)
    )
    if trigger_type:
        daily_rows = daily_rows.filter(ModelCallLog.trigger_type == trigger_type)
    daily_rows = daily_rows.group_by(func.date(ModelCallLog.created_at)).order_by(func.date(ModelCallLog.created_at)).all()
    daily_trend = [
        {
            "date": str(r.d) if r.d else "",
            "total": int(r.total or 0),
            "success": int(r.success or 0),
            "success_rate": round(int(r.success or 0) / int(r.total or 1), 4),
            "avg_latency_ms": round(float(r.avg_latency or 0), 1),
            "tokens": int(r.tokens or 0),
        }
        for r in daily_rows
    ]

    return {
        "days": days,
        "trigger_type": trigger_type,
        "stats": stats,
        "summary": summary,
        "error_top": error_top,
        "source_dist": source_dist,
        "daily_trend": daily_trend,
    }


@router.get("/{config_id}/monitor/calls", summary="模型最近调用明细", dependencies=[Depends(require_permission("llm_config", "view"))])
def get_model_call_logs(
    config_id: int,
    limit: int = Query(50, ge=1, le=500),
    offset: int = Query(0, ge=0),
    trigger_type: str = Query("", description="按来源筛选"),
    status: str = Query("", description="按状态筛选：success/failed"),
    db: Session = Depends(get_db),
) -> dict:
    """查询单个模型配置的最近调用明细（含请求/响应摘要、错误堆栈、来源等）。"""
    logger.info("查询模型调用明细: config_id=%s, limit=%s, offset=%s", config_id, limit, offset)
    q = (
        db.query(ModelCallLog)
        .filter(ModelCallLog.model_config_id == config_id)
        .order_by(ModelCallLog.created_at.desc())
    )
    if trigger_type:
        q = q.filter(ModelCallLog.trigger_type == trigger_type)
    if status:
        q = q.filter(ModelCallLog.status == status)
    total = q.count()
    rows = q.offset(offset).limit(limit).all()
    return {
        "total": total,
        "calls": [
            {
                "id": r.id,
                "status": r.status,
                "latency_ms": r.latency_ms,
                "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens,
                "total_tokens": r.total_tokens,
                "trigger_type": r.trigger_type,
                "agent_id": r.agent_id,
                "error_message": r.error_message,
                "error_stack": r.error_stack,
                "prompt_summary": r.prompt_summary,
                "response_summary": r.response_summary,
                "source_ip": r.source_ip,
                "user_id": r.user_id,
                "session_id": r.session_id,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }
