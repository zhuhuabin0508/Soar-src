"""事件循环卡死看门狗（进程级自愈）。

背景
----
后端以单进程 uvicorn 运行（开发态 ``--reload`` 单 worker）。只要有一个同步阻塞
操作占住事件循环（例如未设超时的外部 HTTP 调用、docker socket 调用、死锁、
超长同步循环），整个后端会“假活”：容器 ``Up``、端口可连，但所有接口都不响应，
前端表现为全站一直转圈加载。

机制
----
后台守护线程周期性向事件循环投递心跳协程：

1. 心跳在 ``LOOP_WATCHDOG_TIMEOUT`` 秒内没有被执行 → 判定事件循环卡死；
2. 先 ``faulthandler.dump_traceback(all_threads=True)`` 打印所有线程栈到容器日志
   （下一次可以直接看到卡死在哪一行，便于根治）；
3. 再 ``os._exit(1)`` 强制退出进程，由 Docker ``restart: unless-stopped`` 自动拉起，
   通常 3~10 秒内恢复服务。

环境变量
--------
- ``LOOP_WATCHDOG_ENABLED``：是否启用，默认 ``true``（设为 false 关闭）
- ``LOOP_WATCHDOG_TIMEOUT``：卡死判定阈值（秒），默认 ``90``
- ``LOOP_WATCHDOG_INTERVAL``：探测间隔（秒），默认 ``5``

注意
----
- 看门狗只应在应用启动完成后启动（启动期的建表/迁移耗时不应被判为卡死）。
- 若有确属预期的长时间同步任务，请调大 ``LOOP_WATCHDOG_TIMEOUT`` 或临时关闭。
"""
import asyncio
import faulthandler
import logging
import os
import sys
import threading
import time

logger = logging.getLogger(__name__)

_start_lock = threading.Lock()
_started = False


def _env_bool(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None or not raw.strip():
        return default
    try:
        return float(raw)
    except ValueError:
        logger.warning("环境变量 %s=%r 非法，回退默认值 %s", name, raw, default)
        return default


def _mark(message: str, *args: object) -> None:
    """同时写日志与 stderr：确保即使 uvicorn 覆写了 logging 配置，docker logs 也一定能看到。"""
    text = message % args if args else message
    logger.info(text)
    print(f"[watchdog] {text}", file=sys.stderr, flush=True)


def start_loop_watchdog(
    loop: "asyncio.AbstractEventLoop | None" = None,
    timeout_seconds: float | None = None,
    interval: float | None = None,
) -> bool:
    """启动事件循环看门狗（进程内只启动一次）。

    Args:
        loop: 目标事件循环，缺省取当前运行中的循环。
        timeout_seconds: 卡死判定阈值，缺省读 ``LOOP_WATCHDOG_TIMEOUT``（90 秒）。
        interval: 探测间隔，缺省读 ``LOOP_WATCHDOG_INTERVAL``（5 秒）。

    Returns:
        启动成功返回 True；已启动/被禁用/无事件循环返回 False。
    """
    global _started

    if not _env_bool("LOOP_WATCHDOG_ENABLED", True):
        _mark("事件循环看门狗未启用（LOOP_WATCHDOG_ENABLED=false）")
        return False

    timeout_seconds = float(timeout_seconds or _env_float("LOOP_WATCHDOG_TIMEOUT", 90.0))
    interval = float(interval or _env_float("LOOP_WATCHDOG_INTERVAL", 5.0))
    timeout_seconds = max(3.0, timeout_seconds)
    # 至少探测两次，避免单次调度抖动误判
    interval = max(0.5, min(interval, timeout_seconds / 2.0))

    with _start_lock:
        if _started:
            return False
        _started = True

    try:
        loop = loop or asyncio.get_running_loop()
    except RuntimeError:
        logger.warning("事件循环看门狗启动失败：当前不在事件循环上下文")
        with _start_lock:
            _started = False
        return False

    # 现场取证：卡死时能打印所有线程栈（含 C 层堆栈）
    try:
        faulthandler.enable(all_threads=True)
    except Exception:  # noqa: BLE001
        pass

    state = {"last_ok": time.monotonic()}

    async def _heartbeat() -> None:
        state["last_ok"] = time.monotonic()

    def _run() -> None:
        while True:
            time.sleep(interval)
            try:
                # 只投递不等待：循环卡死时该协程会堆积在队列里，无法更新时间戳
                asyncio.run_coroutine_threadsafe(_heartbeat(), loop)
            except Exception:  # noqa: BLE001
                # 循环已关闭（进程退出中）等场景，忽略
                pass
            lag = time.monotonic() - state["last_ok"]
            if lag < timeout_seconds:
                continue
            # ===== 判定卡死：取证 + 自愈 =====
            _mark(
                "事件循环已卡死 %.1fs（阈值 %.1fs），打印线程栈后退出进程，由 Docker 自动重启",
                lag,
                timeout_seconds,
            )
            for stream in (sys.stdout, sys.stderr):
                try:
                    stream.flush()
                except Exception:  # noqa: BLE001
                    pass
            try:
                faulthandler.dump_traceback(all_threads=True)
            except Exception:  # noqa: BLE001
                pass
            try:
                logging.shutdown()
            except Exception:  # noqa: BLE001
                pass
            # 强制退出：不使用 sys.exit，避免 uvicorn 优雅关闭再次卡在事件循环
            os._exit(1)

    thread = threading.Thread(target=_run, name="loop-watchdog", daemon=True)
    thread.start()
    _mark(
        "事件循环看门狗已启动：阈值 %.0fs，探测间隔 %.1fs",
        timeout_seconds,
        interval,
    )
    return True
