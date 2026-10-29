"""对话历史服务：会话列表元数据、跨端历史消息还原。

背景：``chat_messages`` 只存消息本身，前端此前把会话列表（标题/时间/消息）放在
localStorage，导致换浏览器或换设备登录同一账号时看不到历史对话。
本模块负责：

1. ``upsert_chat_session``：每轮对话落库后维护会话元数据（标题、更新时间）；
2. ``backfill_chat_sessions``：为历史上已存在消息、但尚无元数据的会话补建记录；
3. ``list_chat_sessions``：跨端拉取当前用户的会话列表；
4. ``to_display_messages``：把 OpenAI 格式消息还原为前端可渲染的消息（含工具时间线）。
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime
from typing import Any, Iterable, Optional

from app.core.timezone import beijing_now

logger = logging.getLogger(__name__)

# 会话标题最大长度（与前端展示口径一致）
SESSION_TITLE_MAX = 60

# 已做过历史补建的 (agent_id, user_id)：每个组合只在进程内回填一次，
# 避免每次打开会话列表都扫描全部消息（消息不再变化的历史无需重复补建）。
_BACKFILLED_KEYS: set[tuple[int, int]] = set()

# 仅附件消息的注入前缀：`[用户上传了以下文件…]\n\n<原始输入>`
_FILE_WRAP_RE = re.compile(r"^\[用户上传了以下文件[^\]]*\]\s*\n\n([\s\S]*)$")

# 工作室预览会话前缀：前端 AgentWorkspace 以 `preview-{agentId}-{ts}` 生成
# 调试会话（channel=test）。这类会话属于编辑器内部状态，不应出现在
# 任何端的正式历史列表中，列表与补建均需跳过。
_PREVIEW_SESSION_PREFIX = "preview-"


def is_hidden_session(session_id: Optional[str]) -> bool:
    """会话是否应从历史列表中隐藏（如工作室预览会话 ``preview-*``）。"""
    return bool(session_id) and session_id.startswith(_PREVIEW_SESSION_PREFIX)


def derive_session_title(text: Optional[str], max_len: int = SESSION_TITLE_MAX) -> str:
    """从用户输入推导会话标题：去文件注入前缀、压缩空白、截断。"""
    if not text or not isinstance(text, str):
        return ""
    matched = _FILE_WRAP_RE.match(text)
    raw = matched.group(1) if matched else text
    compact = re.sub(r"\s+", " ", raw).strip()
    if not compact:
        return ""
    return compact if len(compact) <= max_len else f"{compact[:max_len]}…"


def _iso(dt: Optional[datetime]) -> Optional[str]:
    """将数据库时间序列化为带时区的 ISO 字符串（跨端解析一致）。"""
    if dt is None:
        return None
    if dt.tzinfo is not None:
        return dt.isoformat()
    # 数据库统一存北京时间（naive），补 +08:00 避免浏览器按本地时区误解析
    return f"{dt.strftime('%Y-%m-%dT%H:%M:%S')}+08:00"


def serialize_session(row) -> dict:
    """会话元数据 -> API / 前端结构。"""
    return {
        "session_id": row.session_id,
        "title": row.title or "",
        "created_at": _iso(row.created_at),
        "updated_at": _iso(row.updated_at),
    }


def build_session_specs(
    agg_rows: Iterable[tuple],
    first_contents: dict[str, str],
    existing_sids: set[str],
    agent_id: int,
    user_id: int,
) -> list[dict]:
    """根据消息聚合结果生成缺失会话的建表参数（纯函数，便于单测）。

    Args:
        agg_rows: [(session_id, min_created_at, max_created_at), ...]
        first_contents: {session_id: 首条用户消息内容}
        existing_sids: 已有会话元数据的 session_id 集合
    """
    specs: list[dict] = []
    for row in agg_rows:
        session_id, min_at, max_at = row[0], row[1], row[2]
        if not session_id or session_id in existing_sids:
            continue
        # 工作室预览会话即使有历史消息也不补建元数据，避免污染正式列表
        if is_hidden_session(session_id):
            continue
        specs.append(
            {
                "agent_id": agent_id,
                "user_id": user_id,
                "session_id": session_id,
                "title": derive_session_title(first_contents.get(session_id)),
                "created_at": min_at or max_at or beijing_now(),
                "updated_at": max_at or min_at or beijing_now(),
            }
        )
    return specs


def _first_user_contents(db, agent_id: int, user_id: int) -> dict[str, str]:
    """每条会话的首条用户消息（用于生成标题）。"""
    from sqlalchemy import func

    from app.models.chat_message import ChatMessage

    sub = (
        db.query(
            ChatMessage.session_id.label("sid"),
            ChatMessage.content.label("content"),
            func.row_number()
            .over(partition_by=ChatMessage.session_id, order_by=ChatMessage.id)
            .label("rn"),
        )
        .filter(
            ChatMessage.agent_id == agent_id,
            ChatMessage.user_id == user_id,
            ChatMessage.role == "user",
        )
        .subquery()
    )
    rows = db.query(sub.c.sid, sub.c.content).filter(sub.c.rn == 1).all()
    return {r[0]: r[1] for r in rows if r[0]}


def backfill_chat_sessions(db, agent_id: int, user_id: int) -> int:
    """为仅有消息、尚无会话元数据的旧会话补建记录（幂等）。"""
    from sqlalchemy import func

    from app.models.chat_message import ChatMessage
    from app.models.chat_session import ChatSession

    existing = {
        r.session_id: r
        for r in db.query(ChatSession).filter(
            ChatSession.agent_id == agent_id,
            ChatSession.user_id == user_id,
        ).all()
    }
    agg_rows = (
        db.query(
            ChatMessage.session_id,
            func.min(ChatMessage.created_at),
            func.max(ChatMessage.created_at),
        )
        .filter(
            ChatMessage.agent_id == agent_id,
            ChatMessage.user_id == user_id,
        )
        .group_by(ChatMessage.session_id)
        .all()
    )
    if not agg_rows:
        return 0

    first_contents = _first_user_contents(db, agent_id, user_id)
    specs = build_session_specs(agg_rows, first_contents, set(existing), agent_id, user_id)
    touched = False
    for spec in specs:
        db.add(ChatSession(**spec))
        touched = True
    # 旧记录可能没有标题：按首条用户消息补齐
    for session_id, row in existing.items():
        if not row.title and session_id in first_contents:
            row.title = derive_session_title(first_contents[session_id])
            touched = True
    if touched:
        db.commit()
    return len(specs)


def is_chat_session_deleted(db, agent_id: int, user_id: int, session_id: str) -> bool:
    """会话是否已被删除（存在软删除墓碑）。

    流式请求开始/落库前用它判断：已删除的会话既不加载历史，也不再写入新消息，
    从根源上杜绝「A 浏览器删除、B 浏览器在途请求把会话写回来」。
    """
    from app.models.chat_session import ChatSession

    row = (
        db.query(ChatSession.id)
        .filter(
            ChatSession.agent_id == agent_id,
            ChatSession.user_id == user_id,
            ChatSession.session_id == session_id,
            ChatSession.deleted_at.isnot(None),
        )
        .first()
    )
    return row is not None


def upsert_chat_session(
    db,
    agent_id: int,
    user_id: int,
    session_id: str,
    user_input: Optional[str] = None,
    now: Optional[datetime] = None,
    commit: bool = True,
):
    """新建/更新会话元数据：首次创建时用用户输入生成标题，每轮刷新更新时间。

    已软删除（墓碑非空）的会话不会被更新或复活：即使另一浏览器的流式请求
    在删除之后才落库，也不会让已删除的会话重新出现在列表中。
    """
    from app.models.chat_session import ChatSession

    moment = now or beijing_now()
    row = (
        db.query(ChatSession)
        .filter(
            ChatSession.agent_id == agent_id,
            ChatSession.user_id == user_id,
            ChatSession.session_id == session_id,
        )
        .first()
    )
    if row is None:
        row = ChatSession(
            agent_id=agent_id,
            user_id=user_id,
            session_id=session_id,
            title=derive_session_title(user_input),
            created_at=moment,
            updated_at=moment,
        )
        db.add(row)
    elif row.deleted_at is not None:
        # 墓碑存在：保持删除状态，不刷新标题/时间
        return row
    else:
        row.updated_at = moment
        if not row.title:
            row.title = derive_session_title(user_input)
    if commit:
        db.commit()
    return row


def list_chat_sessions(
    db,
    agent_id: int,
    user_id: int,
    limit: int = 100,
    offset: int = 0,
) -> list:
    """列出当前用户在该智能体下未删除的会话（新→旧），并自动补齐历史会话。

    分页：内部多取一条用于调用方判断 ``has_more``，返回长度最多 ``limit + 1``。

    Args:
        limit: 本页最多返回的会话数（额外多取 1 条用于 has_more 判断）。
        offset: 跳过前 N 条（键集为 updated_at desc, id desc，便于翻页）。
    """
    from app.models.chat_session import ChatSession

    key = (int(agent_id), int(user_id))
    if key not in _BACKFILLED_KEYS:
        try:
            backfill_chat_sessions(db, agent_id, user_id)
            _BACKFILLED_KEYS.add(key)
        except Exception:  # noqa: BLE001
            # 补建失败不阻断列表返回，已有元数据仍可展示；下次请求会重试
            db.rollback()
            logger.warning(
                "会话历史补建失败: agent_id=%s, user_id=%s", agent_id, user_id, exc_info=True
            )

    return (
        db.query(ChatSession)
        .filter(
            ChatSession.agent_id == agent_id,
            ChatSession.user_id == user_id,
            # 已删除（墓碑）的会话不出现在任何端的列表中
            ChatSession.deleted_at.is_(None),
            # 工作室预览会话（preview-*）不进入正式历史列表
            ChatSession.session_id.notlike(f"{_PREVIEW_SESSION_PREFIX}%"),
        )
        .order_by(ChatSession.updated_at.desc(), ChatSession.id.desc())
        .offset(offset)
        .limit(limit + 1)
        .all()
    )


def _parse_tool_args(arguments: Any) -> Any:
    """tool_calls.function.arguments 可能是 JSON 字符串，尽量还原为对象。"""
    if not isinstance(arguments, str):
        return arguments
    try:
        return json.loads(arguments)
    except (json.JSONDecodeError, ValueError):
        return arguments


def _tool_calls_of(row) -> list[dict]:
    """把 assistant 消息的 OpenAI tool_calls 转为前端时间线结构。"""
    result: list[dict] = []
    for tc in row.tool_calls or []:
        if not isinstance(tc, dict):
            continue
        fn = tc.get("function") or {}
        result.append(
            {
                "id": tc.get("id") or "",
                "name": fn.get("name") or "",
                "args": _parse_tool_args(fn.get("arguments")),
                "status": "done",
            }
        )
    return result


def to_display_messages(rows: Iterable) -> list[dict]:
    """OpenAI 格式消息 -> 前端展示消息。

    - 纯工具调用的 assistant 消息（content 为空）与其后的 tool 结果合并到
      最终回答气泡的工具时间线里，避免出现空白的 AI 气泡；
    - 孤立的 tool 消息（找不到对应调用）直接丢弃；
    - tool 结果写入对应 tool_call 的 result 字段。
    """
    messages: list[dict] = []
    pending: Optional[dict] = None
    by_call_id: dict[str, dict] = {}

    def flush_pending():
        nonlocal pending
        if pending is not None:
            messages.append(pending)
            pending = None

    for row in rows:
        role = (getattr(row, "role", "") or "").strip()
        content = getattr(row, "content", "") or ""
        if role == "user":
            flush_pending()
            # 新一轮对话开始：清空上一轮的工具调用映射，避免相同 call_id
            # （模型/引擎复用 ID 时）把旧轮次的 tool 结果串到新轮次
            by_call_id.clear()
            messages.append(
                {
                    "id": f"m{row.id}",
                    "role": "user",
                    "content": content,
                    "timestamp": _iso(row.created_at),
                }
            )
        elif role == "assistant":
            tool_calls = _tool_calls_of(row)
            # 空内容且无工具调用（模型失败/中断留下的空回复）不生成空白气泡
            if not content.strip() and not tool_calls:
                continue
            if not content.strip() and tool_calls:
                if pending is None:
                    pending = {
                        "id": f"m{row.id}",
                        "role": "assistant",
                        "content": "",
                        "timestamp": _iso(row.created_at),
                        "toolCalls": [],
                    }
                pending["toolCalls"].extend(tool_calls)
                for tc in tool_calls:
                    if tc["id"]:
                        by_call_id[tc["id"]] = tc
                continue

            if pending is not None:
                item = pending
                item["content"] = content
                pending = None
            else:
                item = {
                    "id": f"m{row.id}",
                    "role": "assistant",
                    "content": "",
                    "timestamp": _iso(row.created_at),
                    "toolCalls": [],
                }
            item["content"] = content
            item["toolCalls"].extend(tool_calls)
            for tc in tool_calls:
                if tc["id"]:
                    by_call_id[tc["id"]] = tc
            # 无工具调用时不返回空 toolCalls，保持与本地消息结构一致
            if not item["toolCalls"]:
                item.pop("toolCalls", None)
            messages.append(item)
        elif role == "tool":
            call_id = getattr(row, "tool_call_id", "") or ""
            target = by_call_id.get(call_id)
            if target is None:
                continue
            target["result"] = content
            target["status"] = "done"

    flush_pending()
    return messages
