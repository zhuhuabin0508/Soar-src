"""SSE 事件序列化与流式生成器。

提供 ``SSEEvent`` 的 ``to_sse()`` 序列化方法和 ``sse_stream`` 异步生成器，
供 FastAPI ``StreamingResponse`` 使用。
"""
from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from typing import Any, AsyncIterator, Optional

logger = logging.getLogger(__name__)


@dataclass
class SSEEventDict:
    """SSE 事件数据类（与 types.SSEEvent 同构，额外提供 to_sse 方法）。

    type 取值（现有契约的超集，前端兼容）：
    - start: 会话开始
    - status: 状态更新
    - thinking: LLM 思考过程（<think> 块内容，供前端折叠展示）
    - token: LLM 流式 token
    - reset: 重置当前回答气泡（退化输出检测命中后重试/去重前，清空已流式文本）
    - tool_start: 工具开始执行
    - tool_end: 工具执行结束
    - skill_interrupt: 技能被中断
    - delegate: 子代理事件
    - log: 日志
    - done: 会话结束
    - error: 错误
    """

    type: str
    content: str = ""
    message: str = ""
    tool_name: str = ""
    tool_call_id: str = ""
    args: Any = None
    result: Any = None
    log: Optional[dict] = None
    skill: Optional[dict] = None
    # 事件特有的扩展字段（如 file 事件的 file_id/file_name/rows/columns、
    # done 的 usage、clarify 的 question/choices 等）。由 make_event 把未声明的
    # kwargs 收集到此，避免 dataclass 构造抛 TypeError 导致 SSE 流中断。
    extra: dict = field(default_factory=dict)

    def to_sse(self) -> str:
        """序列化为 SSE 格式字符串（extra 字段顶层展开，保持前端解析兼容）。"""
        data = {k: v for k, v in asdict(self).items() if v not in ("", None, [], {})}
        if self.extra:
            data.pop("extra", None)
            data.update(self.extra)
        return f"data: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


async def sse_stream(executor, user_input: str, session_id: str = "") -> AsyncIterator[str]:
    """FastAPI StreamingResponse 用的异步生成器。

    Args:
        executor: HermesAgentExecutor 实例
        user_input: 用户输入
        session_id: 会话 ID

    Yields:
        SSE 格式字符串
    """
    try:
        async for event in executor.run(user_input, session_id=session_id):
            yield event.to_sse()
    except Exception as exc:  # noqa: BLE001
        logger.exception("SSE 流异常: %s", exc)
        error_event = SSEEventDict(type="error", message=str(exc))
        yield error_event.to_sse()


# SSEEventDict 已声明的字段（其余 kwargs 由 make_event 收进 extra）
_KNOWN_FIELDS = {"content", "message", "tool_name", "tool_call_id", "args", "result", "log", "skill"}


def make_event(type: str, **kwargs) -> SSEEventDict:
    """快捷构造 SSE 事件。

    未在 ``SSEEventDict`` 中声明的 kwargs（如 file 事件的 ``file_id``、
    done 的 ``usage``、clarify 的 ``question/choices`` 等）自动收进 ``extra``，
    序列化时顶层展开——避免 dataclass 构造抛 ``TypeError`` 导致整个 SSE 流中断。
    """
    known = {k: v for k, v in kwargs.items() if k in _KNOWN_FIELDS}
    extra = {k: v for k, v in kwargs.items() if k not in _KNOWN_FIELDS}
    return SSEEventDict(type=type, **known, extra=extra)
