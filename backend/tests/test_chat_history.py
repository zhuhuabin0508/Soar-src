"""跨浏览器对话历史服务单测。

覆盖：
- 会话标题推导（去附件注入前缀 / 截断 / 空值）；
- 历史会话补建的纯函数 ``build_session_specs``（跳过已存在会话）；
- 会话序列化的时区口径（naive 北京时间补 +08:00）；
- 服务端消息 -> 前端消息的还原（工具调用合并、孤立 tool 丢弃）；
- ``upsert_chat_session`` 的建/更语义与账号隔离条件；
- 历史消息接口的账号/session 过滤与 404 行为；
- 工作室预览会话（preview-*）不进列表/不补建，channel=test 不写会话元数据。

不依赖真实数据库：用 fake Session 捕获过滤条件并编译成 SQL 断言。
"""
import asyncio
import types
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.api.v1.agents import get_chat_session_messages, list_chat_sessions as list_sessions_route
from app.platform.chat_history import (
    build_session_specs,
    derive_session_title,
    is_hidden_session,
    list_chat_sessions,
    serialize_session,
    to_display_messages,
    upsert_chat_session,
)


# ---------------------------------------------------------------------------
# 纯函数
# ---------------------------------------------------------------------------

def test_derive_session_title_strips_file_wrapper():
    text = (
        "[用户上传了以下文件，可使用 read_document 工具按文件名读取完整内容：\n"
        "- a.xlsx\n]\n\n请分析这张表"
    )
    assert derive_session_title(text) == "请分析这张表"


def test_derive_session_title_truncates_and_handles_empty():
    assert derive_session_title("一" * 80, max_len=10) == "一" * 10 + "…"
    assert derive_session_title("  多个   空白\n换行  ") == "多个 空白 换行"
    assert derive_session_title(None) == ""
    assert derive_session_title("   ") == ""
    assert derive_session_title("") == ""


def test_serialize_session_adds_beijing_offset_for_naive_datetime():
    row = types.SimpleNamespace(
        session_id="s1",
        title="标题",
        created_at=datetime(2026, 10, 29, 10, 0, 0),
        updated_at=datetime(2026, 10, 29, 11, 30, 0),
    )
    data = serialize_session(row)
    assert data == {
        "session_id": "s1",
        "title": "标题",
        "created_at": "2026-10-29T10:00:00+08:00",
        "updated_at": "2026-10-29T11:30:00+08:00",
    }


def test_build_session_specs_skips_existing_and_empty_sids():
    t1 = datetime(2026, 10, 1, 9, 0, 0)
    t2 = datetime(2026, 10, 2, 9, 0, 0)
    specs = build_session_specs(
        [("s1", t1, t2), ("s2", t1, t2), ("", t1, t2)],
        {"s1": "旧会话第一个问题"},
        {"s2"},
        agent_id=3,
        user_id=7,
    )
    assert len(specs) == 1
    spec = specs[0]
    assert spec["agent_id"] == 3
    assert spec["user_id"] == 7
    assert spec["session_id"] == "s1"
    assert spec["title"] == "旧会话第一个问题"
    assert spec["created_at"] == t1
    assert spec["updated_at"] == t2


def _row(**kwargs):
    base = {
        "id": 1,
        "role": "user",
        "content": "",
        "tool_calls": None,
        "tool_call_id": "",
        "name": "",
        "created_at": datetime(2026, 10, 29, 10, 0, 0),
    }
    base.update(kwargs)
    return types.SimpleNamespace(**base)


def test_to_display_messages_merges_tool_calls_into_final_answer():
    rows = [
        _row(id=1, role="user", content="查一下资产"),
        _row(
            id=2,
            role="assistant",
            content="",
            tool_calls=[
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "search_assets", "arguments": '{"q": "1.1.1.1"}'},
                }
            ],
        ),
        _row(id=3, role="tool", content='{"total": 2}', tool_call_id="call-1", name="search_assets"),
        _row(
            id=4,
            role="assistant",
            content="",
            tool_calls=[
                {
                    "id": "call-2",
                    "type": "function",
                    "function": {"name": "get_asset", "arguments": "{}"},
                }
            ],
        ),
        _row(id=5, role="tool", content="资产详情", tool_call_id="call-2", name="get_asset"),
        _row(id=6, role="assistant", content="共查到 2 个资产"),
    ]

    messages = to_display_messages(rows)
    # 用户消息 + 一个合并后的回答气泡（纯工具调用的中间消息不单独成气泡）
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assistant = messages[1]
    assert assistant["content"] == "共查到 2 个资产"
    assert assistant["timestamp"] == "2026-10-29T10:00:00+08:00"
    assert [tc["name"] for tc in assistant["toolCalls"]] == ["search_assets", "get_asset"]
    assert assistant["toolCalls"][0]["args"] == {"q": "1.1.1.1"}
    assert assistant["toolCalls"][0]["result"] == '{"total": 2}'
    assert assistant["toolCalls"][1]["result"] == "资产详情"
    assert all(tc["status"] == "done" for tc in assistant["toolCalls"])


def test_to_display_messages_drops_orphan_tool_and_skips_empty_assistant():
    rows = [
        _row(id=1, role="tool", content="没有对应调用", tool_call_id="missing"),
        _row(id=2, role="assistant", content=""),
        _row(id=3, role="user", content="你好"),
        _row(id=4, role="assistant", content="你好，有什么可以帮你"),
    ]
    messages = to_display_messages(rows)
    assert [m["role"] for m in messages] == ["user", "assistant"]
    assert "toolCalls" not in messages[1]


# ---------------------------------------------------------------------------
# fake DB
# ---------------------------------------------------------------------------

class _FakeQuery:
    def __init__(self, db, model):
        self.db = db
        self.model = model

    def filter(self, *conditions):
        self.db.filters.setdefault(self.model.__name__, []).extend(conditions)
        return self

    def order_by(self, *args):  # noqa: ARG002
        return self

    def limit(self, count):  # noqa: ARG002
        return self

    def offset(self, count):  # noqa: ARG002
        return self

    def first(self):
        if self.model.__name__ == "Agent":
            return self.db.agent
        return self.db.session_row

    def all(self):
        if self.model.__name__ == "ChatMessage":
            return list(self.db.messages)
        return []


class _FakeDB:
    def __init__(self, agent=None, session_row=None, messages=None):
        self.agent = agent
        self.session_row = session_row
        self.messages = messages or []
        self.filters = {}
        self.added = []
        self.commits = 0

    def query(self, model):
        return _FakeQuery(self, model)

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        self.commits += 1

    def rollback(self):
        pass


def _sql_of(conditions) -> str:
    return " AND ".join(
        str(c.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
        for c in conditions
    )


def _user(user_id=7):
    return types.SimpleNamespace(id=user_id, username="tester")


def test_upsert_chat_session_creates_with_title():
    db = _FakeDB(session_row=None)
    moment = datetime(2026, 10, 29, 12, 0, 0)

    row = upsert_chat_session(db, 1, 7, "s-new", "  帮我查资产  ", now=moment)

    assert row.session_id == "s-new"
    assert row.title == "帮我查资产"
    assert row.created_at == moment
    assert row.updated_at == moment
    assert len(db.added) == 1
    # 查询条件必须按 agent + user + session 三元组，避免跨账号串会话
    sql = _sql_of(db.filters["ChatSession"])
    assert "agent_id = 1" in sql
    assert "user_id = 7" in sql
    assert "session_id = 's-new'" in sql


def test_upsert_chat_session_updates_existing_and_fills_empty_title():
    existing = types.SimpleNamespace(
        session_id="s1",
        title="",
        created_at=datetime(2026, 10, 1, 9, 0, 0),
        updated_at=datetime(2026, 10, 1, 9, 0, 0),
        # 与真实模型一致：未删除时墓碑为空
        deleted_at=None,
    )
    db = _FakeDB(session_row=existing)
    moment = datetime(2026, 10, 29, 12, 0, 0)

    row = upsert_chat_session(db, 1, 7, "s1", "历史标题来源", now=moment)

    assert row is existing
    assert row.updated_at == moment
    assert row.title == "历史标题来源"
    # 已存在时不重复插入
    assert db.added == []


def test_get_chat_session_messages_is_scoped_to_current_user():
    agent = types.SimpleNamespace(id=1)
    rows = [
        _row(id=2, role="user", content="第二条"),
        _row(id=1, role="user", content="第一条"),
    ]
    db = _FakeDB(agent=agent, messages=rows)

    # 直接调用路由函数时不会经过 FastAPI 参数注入，需显式传入 Query 默认值
    result = asyncio.run(
        get_chat_session_messages(
            1, "s-shared", limit=500, before_id=None, db=db, current_user=_user(user_id=99)
        )
    )

    assert result["session_id"] == "s-shared"
    # rows.reverse() 后按时间正序返回
    assert [m["content"] for m in result["messages"]] == ["第一条", "第二条"]
    sql = _sql_of(db.filters["ChatMessage"])
    assert "agent_id = 1" in sql
    assert "user_id = 99" in sql
    assert "session_id = 's-shared'" in sql


def test_get_chat_session_messages_paginates_with_before_id():
    """消息分页：多取一条判断 has_more，并返回下一页游标 next_before_id。"""
    agent = types.SimpleNamespace(id=1)
    rows = [
        _row(id=3, role="assistant", content="第三条"),
        _row(id=2, role="user", content="第二条"),
        _row(id=1, role="user", content="第一条"),
    ]
    db = _FakeDB(agent=agent, messages=rows)

    result = asyncio.run(
        get_chat_session_messages(
            1, "s1", limit=2, before_id=5, db=db, current_user=_user()
        )
    )

    # 倒序查询后裁掉多取的最旧一条，再反转成正序
    assert [m["content"] for m in result["messages"]] == ["第二条", "第三条"]
    assert result["has_more"] is True
    assert result["next_before_id"] == 2
    sql = _sql_of(db.filters["ChatMessage"])
    assert "chat_messages.id < 5" in sql
    assert "chat_messages.agent_id = 1" in sql
    assert "chat_messages.user_id = 7" in sql


def test_get_chat_session_messages_missing_agent_returns_404():
    db = _FakeDB(agent=None)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            get_chat_session_messages(404, "s1", db=db, current_user=_user())
        )
    assert exc.value.status_code == 404


def test_get_chat_session_messages_rejects_unsafe_session_id():
    """session_id 只允许安全字符，避免异常输入进入查询条件。"""
    agent = types.SimpleNamespace(id=1)
    db = _FakeDB(agent=agent)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(
            get_chat_session_messages(1, "bad id!", db=db, current_user=_user())
        )
    assert exc.value.status_code == 400


def test_upsert_chat_session_does_not_revive_deleted_row():
    """墓碑存在时 upsert 不得刷新时间/标题，更不能复活已删除会话。"""
    moment = datetime(2026, 10, 1, 9, 0, 0)
    existing = types.SimpleNamespace(
        session_id="s-deleted",
        title="已删除会话",
        created_at=moment,
        updated_at=moment,
        deleted_at=datetime(2026, 10, 2, 9, 0, 0),
    )
    db = _FakeDB(session_row=existing)

    row = upsert_chat_session(
        db, 1, 7, "s-deleted", "继续发消息", now=datetime(2026, 10, 29, 12, 0, 0)
    )

    assert row is existing
    assert row.updated_at == moment
    assert row.title == "已删除会话"
    assert row.deleted_at is not None
    assert db.added == []


def test_to_display_messages_clears_tool_map_between_turns():
    """跨轮次不继承 call_id 映射：上一轮的 tool 结果不能被后一轮同名调用覆盖。"""
    rows = [
        _row(id=1, role="user", content="第一问"),
        _row(
            id=2,
            role="assistant",
            content="",
            tool_calls=[
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "search", "arguments": "{}"},
                }
            ],
        ),
        _row(id=3, role="tool", content="第一轮结果", tool_call_id="call-1"),
        _row(id=4, role="assistant", content="第一轮回答"),
        _row(id=5, role="user", content="第二问"),
        _row(id=6, role="assistant", content="第二轮回答"),
        # 孤立的旧 call_id：不应串回第一轮
        _row(id=7, role="tool", content="串轮结果", tool_call_id="call-1"),
    ]

    messages = to_display_messages(rows)

    assert [m["role"] for m in messages] == [
        "user",
        "assistant",
        "user",
        "assistant",
    ]
    assert messages[1]["toolCalls"][0]["result"] == "第一轮结果"


def test_list_chat_sessions_returns_serialized_sessions_for_current_user(monkeypatch):
    agent = types.SimpleNamespace(id=1)
    db = _FakeDB(agent=agent)
    rows = [
        types.SimpleNamespace(
            session_id="s2",
            title="第二个会话",
            created_at=datetime(2026, 10, 2, 9, 0, 0),
            updated_at=datetime(2026, 10, 2, 10, 0, 0),
        ),
        types.SimpleNamespace(
            session_id="s1",
            title="第一个会话",
            created_at=datetime(2026, 10, 1, 9, 0, 0),
            updated_at=datetime(2026, 10, 1, 10, 0, 0),
        ),
    ]
    captured = {}

    def fake_list(db_, agent_id, user_id, limit=100, offset=0):
        captured.update(
            db=db_, agent_id=agent_id, user_id=user_id, limit=limit, offset=offset
        )
        return rows

    monkeypatch.setattr("app.platform.chat_history.list_chat_sessions", fake_list)

    # 直接调用路由函数时不会经过 FastAPI 参数注入，需显式传入 Query 默认的 offset
    result = asyncio.run(
        list_sessions_route(1, limit=50, offset=0, db=db, current_user=_user(user_id=99))
    )

    # 必须按当前登录用户查询，不能返回其他账号的会话
    assert captured == {
        "db": db,
        "agent_id": 1,
        "user_id": 99,
        "limit": 50,
        "offset": 0,
    }
    assert [s["session_id"] for s in result["sessions"]] == ["s2", "s1"]
    assert result["sessions"][0]["updated_at"] == "2026-10-02T10:00:00+08:00"
    # 两页之内已取完，不能再提示前端继续翻页
    assert result["has_more"] is False


def test_list_chat_sessions_has_more_when_helper_returns_extra_row(monkeypatch):
    """helper 多取一条用于判断 has_more，接口应裁掉多出的那条。"""
    agent = types.SimpleNamespace(id=1)
    db = _FakeDB(agent=agent)
    rows = [
        types.SimpleNamespace(
            session_id=f"s{i}",
            title=f"会话{i}",
            created_at=datetime(2026, 10, 1, 9, 0, 0),
            updated_at=datetime(2026, 10, 1, 10, 0, 0),
        )
        for i in range(3)
    ]

    monkeypatch.setattr(
        "app.platform.chat_history.list_chat_sessions",
        lambda db_, agent_id, user_id, limit=100, offset=0: rows,
    )

    result = asyncio.run(
        list_sessions_route(1, limit=2, offset=0, db=db, current_user=_user())
    )

    assert [s["session_id"] for s in result["sessions"]] == ["s0", "s1"]
    assert result["has_more"] is True


def test_list_chat_sessions_missing_agent_returns_404():
    db = _FakeDB(agent=None)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(list_sessions_route(404, db=db, current_user=_user()))
    assert exc.value.status_code == 404


# ---------------------------------------------------------------------------
# 工作室预览会话（preview-*）不污染跨端历史列表
# ---------------------------------------------------------------------------

def test_is_hidden_session_detects_preview_prefix():
    """预览会话判定：仅完整的 preview- 前缀命中，普通会话不受影响。"""
    assert is_hidden_session("preview-57-1730000000000") is True
    assert is_hidden_session("preview-") is True
    assert is_hidden_session("previews") is False
    assert is_hidden_session("s-normal") is False
    assert is_hidden_session("") is False
    assert is_hidden_session(None) is False


def test_build_session_specs_skips_preview_sessions():
    """历史补建必须跳过预览会话：即使 chat_messages 里有 preview-* 消息也不建元数据。"""
    t = datetime(2026, 10, 1, 9, 0, 0)
    specs = build_session_specs(
        [
            ("s1", t, t),
            ("preview-57-1730000000000", t, t),
        ],
        {
            "s1": "正式会话首问",
            "preview-57-1730000000000": "预览调试首问",
        },
        set(),
        agent_id=57,
        user_id=3,
    )
    # 只有正式会话被补建，预览会话不进入会话列表
    assert [s["session_id"] for s in specs] == ["s1"]


def test_list_chat_sessions_excludes_preview_sessions(monkeypatch):
    """跨端会话列表的过滤条件必须排除 preview-*（含已落库的历史污染数据）。"""
    # 跳过历史补建（fake DB 不支持聚合查询），聚焦列表过滤条件本身
    monkeypatch.setattr(
        "app.platform.chat_history.backfill_chat_sessions", lambda *args, **kwargs: 0
    )
    db = _FakeDB()

    rows = list_chat_sessions(db, 57, 3, limit=100, offset=0)

    assert rows == []
    sql = _sql_of(db.filters["ChatSession"])
    assert "agent_id = 57" in sql
    assert "user_id = 3" in sql
    assert "deleted_at IS NULL" in sql
    # PG 方言会把 LIKE 模式中的 % 转义为 %%，故只断言前缀部分
    assert "session_id NOT LIKE 'preview-" in sql


def _patch_agent_run(monkeypatch, calls):
    """为 AgentRun.stream() 打桩：替换执行记录会话与持久化依赖，记录调用。"""

    class _FakeSession:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def add(self, obj):
            pass

        def commit(self):
            pass

        def refresh(self, obj):
            obj.id = 1

        def query(self, model):
            return _FakeQuery(self, model)

    async def fake_invoke_agent_sse(**kwargs):
        holder = kwargs["executor_holder"]
        holder.append(
            types.SimpleNamespace(
                get_new_messages=lambda: [
                    {"role": "user", "content": "调试输入"},
                    {"role": "assistant", "content": "调试回复"},
                ]
            )
        )
        yield 'data: {"type": "done", "content": "调试回复"}\n\n'

    monkeypatch.setattr("app.database.SessionLocal", _FakeSession)
    monkeypatch.setattr("app.platform.agent_runtime.invoke_agent_sse", fake_invoke_agent_sse)
    monkeypatch.setattr(
        "app.platform.agent_run.persist_new_messages",
        lambda db, agent_id, session_id, user_id, msgs: calls["persist"].append(
            (agent_id, session_id, user_id, list(msgs))
        ),
    )
    monkeypatch.setattr(
        "app.platform.chat_history.is_chat_session_deleted",
        lambda db, agent_id, user_id, session_id: False,
    )
    monkeypatch.setattr(
        "app.platform.chat_history.upsert_chat_session",
        lambda db, agent_id, user_id, session_id, *args, **kwargs: calls["upsert"].append(
            (agent_id, user_id, session_id)
        ),
    )


def _run_agent_stream(channel: str, session_id: str) -> list[str]:
    from app.platform.agent_run import AgentRun

    async def _collect():
        run = AgentRun(
            db=None,
            agent=types.SimpleNamespace(id=57, context_turns=10),
            user=types.SimpleNamespace(id=3),
            channel=channel,
            session_id=session_id,
            user_input="调试输入",
            persist_history=True,
        )
        return [chunk async for chunk in run.stream()]

    return asyncio.run(_collect())


def test_agent_run_test_channel_persists_messages_but_skips_metadata(monkeypatch):
    """工作室预览对话（channel=test）：消息落库维持多轮上下文，但不写会话元数据。"""
    calls = {"persist": [], "upsert": []}
    _patch_agent_run(monkeypatch, calls)

    chunks = _run_agent_stream("test", "preview-57-1730000000000")

    # 流式输出正常，消息仍落库（预览多轮上下文依赖）
    assert chunks and '"type": "done"' in chunks[-1]
    assert calls["persist"] == [
        (57, "preview-57-1730000000000", 3, [{"role": "user", "content": "调试输入"}, {"role": "assistant", "content": "调试回复"}])
    ]
    # 关键回归点：预览会话不得写会话元数据，否则会混入跨端历史列表
    assert calls["upsert"] == []


def test_agent_run_conversation_channel_writes_session_metadata(monkeypatch):
    """正式对话（channel=conversation）：落库消息同时维护会话元数据。"""
    calls = {"persist": [], "upsert": []}
    _patch_agent_run(monkeypatch, calls)

    chunks = _run_agent_stream("conversation", "s-normal")

    assert chunks and '"type": "done"' in chunks[-1]
    assert calls["persist"] and calls["persist"][0][1] == "s-normal"
    # 正式对话必须更新会话元数据，跨浏览器才能看到该会话
    assert calls["upsert"] == [(57, 3, "s-normal")]
