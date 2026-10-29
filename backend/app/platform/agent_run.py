"""一次 Agent 流式运行：执行记录、会话历史、错误事件。"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any, AsyncIterator

from app.core.timezone import beijing_now, beijing_now_iso

logger = logging.getLogger(__name__)


def load_chat_history(db, agent_id: int, session_id: str, context_turns: int, user_id: int) -> list[dict]:
    from app.models.chat_message import ChatMessage

    limit = max(context_turns * 8, 20)
    records = (
        db.query(ChatMessage)
        .filter(
            ChatMessage.agent_id == agent_id,
            ChatMessage.session_id == session_id,
            ChatMessage.user_id == user_id,
        )
        .order_by(ChatMessage.created_at.desc(), ChatMessage.id.desc())
        .limit(limit)
        .all()
    )
    if not records:
        return []
    records = list(reversed(records))
    history: list[dict] = []
    for r in records:
        msg: dict = {"role": r.role, "content": r.content or ""}
        if r.role == "assistant" and r.tool_calls:
            msg["tool_calls"] = r.tool_calls
        if r.role == "tool":
            msg["tool_call_id"] = r.tool_call_id or ""
            msg["name"] = r.name or ""
        history.append(msg)
    while history and history[0].get("role") == "tool":
        history.pop(0)
    return history


def persist_new_messages(db, agent_id: int, session_id: str, user_id: int, new_messages: list[dict]) -> None:
    from app.models.chat_message import ChatMessage

    for m in new_messages:
        role = m.get("role", "user")
        if role not in ("user", "assistant", "tool"):
            continue
        db.add(ChatMessage(
            agent_id=agent_id,
            session_id=session_id,
            user_id=user_id,
            role=role,
            content=m.get("content", "") or "",
            tool_calls=m.get("tool_calls") if role == "assistant" else None,
            tool_call_id=m.get("tool_call_id", "") or "" if role == "tool" else "",
            name=m.get("name", "") or "" if role == "tool" else "",
        ))
    db.commit()


class AgentRun:
    def __init__(
        self,
        *,
        db,
        agent,
        user,
        channel: str,
        session_id: str,
        user_input: str,
        override=None,
        load_history: bool = False,
        persist_history: bool = False,
        trigger_type: str = "agent_test",
    ):
        self.db = db
        self.agent = agent
        self.user = user
        self.channel = channel
        self.session_id = session_id
        self.user_input = user_input
        self.override = override
        self.load_history = load_history
        self.persist_history = persist_history
        self.trigger_type = trigger_type
        self.user_id = int(getattr(user, "id", 0) or 0)

    async def stream(self) -> AsyncIterator[str]:
        from app.database import SessionLocal
        from app.models.execution import Execution
        from app.platform.agent_runtime import invoke_agent_sse

        history: list[dict] = []
        if self.load_history:
            try:
                history = load_chat_history(
                    self.db,
                    self.agent.id,
                    self.session_id,
                    self.agent.context_turns or 10,
                    self.user_id,
                )
            except Exception:
                logger.exception("加载对话历史失败，将以无历史模式继续")

        executor_holder: list = []
        exec_id: int | None = None
        exec_status = "success"
        final_reply = ""
        error_msg = ""
        tool_calls_detail: list[dict] = []
        tool_timers: dict[str, float] = {}

        try:
            with SessionLocal() as s:
                rec = Execution(
                    agent_id=self.agent.id,
                    status="running",
                    trigger_type=self.trigger_type,
                    result={
                        "input": self.user_input,
                        "engine": "hermes",
                        "mode": self.channel,
                    },
                )
                s.add(rec)
                s.commit()
                s.refresh(rec)
                exec_id = rec.id
        except Exception:
            logger.exception("创建 Execution 记录失败，继续流式输出")

        try:
            async for chunk in invoke_agent_sse(
                db=self.db,
                agent=self.agent,
                input=self.user_input,
                user=self.user,
                channel=self.channel,
                override=self.override,
                session_id=self.session_id,
                history=history or None,
                executor_holder=executor_holder,
            ):
                if chunk.startswith("data: "):
                    try:
                        data = json.loads(chunk[6:].strip())
                        etype = data.get("type", "")
                        if etype == "done":
                            final_reply = data.get("content", "") or data.get("reply", "")
                        elif etype == "error":
                            exec_status = "failed"
                            error_msg = data.get("message", "")
                        elif etype == "tool_start":
                            tc_id = data.get("tool_call_id", "")
                            tool_timers[tc_id] = time.monotonic()
                            tool_calls_detail.append({
                                "name": data.get("tool_name", ""),
                                "args": data.get("args"),
                                "status": "running",
                                "started_at": beijing_now_iso(),
                            })
                        elif etype == "tool_end":
                            tc_id = data.get("tool_call_id", "")
                            start_ts = tool_timers.pop(tc_id, None)
                            duration_ms = int((time.monotonic() - start_ts) * 1000) if start_ts else None
                            if tool_calls_detail:
                                tool_calls_detail[-1]["status"] = "done"
                                tool_calls_detail[-1]["result"] = data.get("result")
                                tool_calls_detail[-1]["duration_ms"] = duration_ms
                                tool_calls_detail[-1]["finished_at"] = beijing_now_iso()
                    except (json.JSONDecodeError, ValueError):
                        pass
                yield chunk
                await asyncio.sleep(0)
        except Exception as exc:
            logger.exception("Agent SSE 失败: %s", exc)
            exec_status = "failed"
            error_msg = str(exc)
            yield f"data: {json.dumps({'type': 'error', 'message': str(exc)}, ensure_ascii=False)}\n\n"
        finally:
            executor = executor_holder[0] if executor_holder else None
            if exec_id is not None:
                try:
                    with SessionLocal() as s:
                        rec = s.query(Execution).filter(Execution.id == exec_id).first()
                        if rec is not None:
                            rec.status = exec_status
                            rec.finished_at = beijing_now()
                            model_meta = getattr(executor, "_model_meta", {}) or {} if executor else {}
                            token_usage = getattr(executor, "_token_usage", {}) or {} if executor else {}
                            result: dict[str, Any] = {
                                "input": self.user_input,
                                "engine": "hermes",
                                "mode": self.channel,
                                "reply": final_reply,
                                "model": {
                                    "config_id": model_meta.get("model_config_id"),
                                    "name": model_meta.get("model_name", ""),
                                    "provider": model_meta.get("provider", ""),
                                },
                                "token_usage": token_usage,
                                "iterations": getattr(executor, "_iteration_count", 0) if executor else 0,
                                "thinking_chars": getattr(executor, "_thinking_chars", 0) if executor else 0,
                            }
                            if error_msg:
                                result["error"] = error_msg
                            if tool_calls_detail:
                                result["tool_calls"] = tool_calls_detail
                            rec.result = result
                            s.commit()
                except Exception:
                    logger.exception("更新 Execution 记录失败: exec_id=%s", exec_id)

            if self.persist_history:
                try:
                    new_msgs = executor.get_new_messages() if executor is not None else []
                    # 只要本轮产生了 user/assistant 消息就落库（即使模型中途失败），
                    # 保证跨浏览器能看到该次对话，而不是凭空丢失。
                    has_content = any(
                        m.get("role") in ("user", "assistant") for m in new_msgs
                    )
                    if has_content and new_msgs:
                        with SessionLocal() as s:
                            from app.platform.chat_history import (
                                is_chat_session_deleted,
                                upsert_chat_session,
                            )

                            # 用户在其它端已删除该会话：本轮消息不再落库，
                            # 否则会把已删除会话连同消息一起“复活”。
                            if is_chat_session_deleted(
                                s, self.agent.id, self.user_id, self.session_id
                            ):
                                logger.info(
                                    "会话已删除，跳过本轮落库: agent=%s, session=%s",
                                    self.agent.id,
                                    self.session_id,
                                )
                            else:
                                persist_new_messages(
                                    s, self.agent.id, self.session_id, self.user_id, new_msgs
                                )
                                # 工作室预览对话（channel=test）消息仍落库以维持
                                # 多轮上下文，但不写会话元数据，避免 preview-* 会话
                                # 混入跨端正式历史列表
                                if self.channel != "test":
                                    # 同步会话列表元数据（标题/更新时间），供任意浏览器拉取
                                    try:
                                        upsert_chat_session(
                                            s,
                                            self.agent.id,
                                            self.user_id,
                                            self.session_id,
                                            self.user_input,
                                        )
                                    except Exception:
                                        logger.exception(
                                            "更新会话元数据失败: session=%s", self.session_id
                                        )
                except Exception:
                    logger.exception("持久化对话消息失败")
