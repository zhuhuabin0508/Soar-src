"""对话会话清理接口单测（确保「新建会话」与「清空历史」的数据边界）。

- 清空全部历史：只按 agent_id + user_id 删除，不区分 session_id；
- 清空单个会话：必须带 session_id 条件，不能误删该智能体其它会话；
- 智能体不存在时返回 404，不执行任何删除。

不依赖真实数据库：用 fake Session 捕获删除语句并编译成 SQL 断言过滤条件。
"""
import asyncio
import types
from datetime import datetime

import pytest
from fastapi import HTTPException
from sqlalchemy.dialects import postgresql

from app.api.v1.agents import (
    ChatSessionRenameBody,
    clear_all_chat_sessions,
    clear_chat_session,
    rename_chat_session_api,
)
from app.models.agent import Agent
from app.models.chat_session import ChatSession
from app.platform.chat_history import SESSION_TITLE_MAX, rename_chat_session


class _FakeQuery:
    def __init__(self, agent):
        self._agent = agent

    def filter(self, *args):  # noqa: ARG002
        return self

    def first(self):
        return self._agent


class _FakeResult:
    def __init__(self, rowcount):
        self.rowcount = rowcount


class _FakeDB:
    def __init__(self, agent=None, rowcount=3):
        self._agent = agent
        self._rowcount = rowcount
        self.executed = []
        self.commits = 0
        self.added = []

    def query(self, model):  # noqa: ARG002
        return _FakeQuery(self._agent)

    def execute(self, stmt):
        self.executed.append(stmt)
        return _FakeResult(self._rowcount)

    def commit(self):
        self.commits += 1

    def add(self, obj):
        self.added.append(obj)

    def rollback(self):
        pass


def _sql(stmt) -> str:
    return str(
        stmt.compile(
            dialect=postgresql.dialect(),
            compile_kwargs={"literal_binds": True},
        )
    )


def _user(user_id=7, username="tester"):
    return types.SimpleNamespace(id=user_id, username=username)


class TestClearAllChatSessions:
    def test_scoped_to_agent_and_user_without_session_filter(self):
        agent = types.SimpleNamespace(id=1)
        db = _FakeDB(agent=agent, rowcount=5)

        result = asyncio.run(clear_all_chat_sessions(1, db=db, current_user=_user()))

        assert result == {"deleted": 5}
        # 先给会话元数据写软删除墓碑（UPDATE + INSERT...SELECT 补旧会话），再删消息。
        # 墓碑用于阻止其它浏览器在途的流式请求把已删除会话写回来。
        assert len(db.executed) == 3
        update_sql = _sql(db.executed[0])
        tombstone_sql = _sql(db.executed[1])
        msg_sql = _sql(db.executed[2])
        # 只按智能体 + 用户过滤：覆盖该用户在该智能体下的全部会话
        assert update_sql.startswith("UPDATE chat_sessions")
        assert "agent_id = 1" in update_sql
        assert "user_id = 7" in update_sql
        assert "deleted_at" in update_sql
        assert "session_id =" not in update_sql
        assert tombstone_sql.startswith("INSERT INTO chat_sessions")
        assert "SELECT chat_messages.agent_id" in tombstone_sql
        assert "agent_id = 1" in tombstone_sql
        assert "user_id = 7" in tombstone_sql
        assert "ON CONFLICT (agent_id, user_id, session_id) DO UPDATE" in tombstone_sql
        assert msg_sql.startswith("DELETE FROM chat_messages")
        assert "agent_id = 1" in msg_sql
        assert "user_id = 7" in msg_sql
        assert "session_id" not in msg_sql
        assert db.commits >= 1

    def test_cannot_clear_other_users_messages(self):
        """删除条件必须带 user_id，避免清空同一智能体下其他用户的会话。"""
        agent = types.SimpleNamespace(id=2)
        db = _FakeDB(agent=agent, rowcount=0)

        asyncio.run(clear_all_chat_sessions(2, db=db, current_user=_user(user_id=99)))

        sql = _sql(db.executed[0])
        assert "user_id = 99" in sql
        assert "session_id" not in sql

    def test_audit_log_written(self):
        agent = types.SimpleNamespace(id=3)
        db = _FakeDB(agent=agent, rowcount=2)

        asyncio.run(clear_all_chat_sessions(3, db=db, current_user=_user()))

        assert len(db.added) == 1
        log = db.added[0]
        assert log.action == "agent.chat_sessions.clear_all"
        assert log.resource_type == "agent"
        assert log.resource_id == "3"

    def test_missing_agent_returns_404_without_delete(self):
        db = _FakeDB(agent=None)

        with pytest.raises(HTTPException) as exc:
            asyncio.run(clear_all_chat_sessions(404, db=db, current_user=_user()))

        assert exc.value.status_code == 404
        assert db.executed == []


class TestClearSingleChatSession:
    def test_delete_filters_session_id(self):
        """单会话清理只删除指定 session，不能波及该智能体其它历史会话。"""
        agent = types.SimpleNamespace(id=1)
        db = _FakeDB(agent=agent, rowcount=4)

        result = asyncio.run(
            clear_chat_session(1, session_id="s-keep-other", db=db, current_user=_user())
        )

        assert result["deleted"] == 4
        assert result["session_id"] == "s-keep-other"
        # 墓碑 UPDATE、墓碑补建 INSERT...SELECT、消息 DELETE 三条语句，
        # 且都只命中指定会话（不能波及该智能体其它历史会话）
        assert len(db.executed) == 3
        for stmt in db.executed:
            sql = _sql(stmt)
            assert "session_id = 's-keep-other'" in sql
            assert "agent_id = 1" in sql
            assert "user_id = 7" in sql

    def test_default_session_id_normalized(self):
        """空 session_id 归一化为 default，避免误删。"""
        agent = types.SimpleNamespace(id=1)
        db = _FakeDB(agent=agent)

        result = asyncio.run(
            clear_chat_session(1, session_id="", db=db, current_user=_user())
        )

        assert result["session_id"] == "default"
        # 第一条是会话元数据的墓碑 UPDATE，必须命中 default 会话
        assert "session_id = 'default'" in _sql(db.executed[0])

    def test_missing_agent_returns_404(self):
        db = _FakeDB(agent=None)

        with pytest.raises(HTTPException) as exc:
            asyncio.run(clear_chat_session(404, session_id="s1", db=db, current_user=_user()))

        assert exc.value.status_code == 404
        assert db.executed == []


class _RenameQuery:
    def __init__(self, db, model):
        self._db = db
        self._model = model

    def filter(self, *args, **kwargs):  # noqa: ARG002
        return self

    def first(self):
        # 接口先校验智能体存在（query(Agent)），helper 再查会话（query(ChatSession)）
        return self._db.agent if self._model is Agent else self._db.row


class _RenameDB:
    def __init__(self, agent=None, row=None):
        self.agent = agent
        self.row = row
        self.commits = 0
        self.refreshed = []
        self.added = []

    def query(self, model):
        return _RenameQuery(self, model)

    def commit(self):
        self.commits += 1

    def refresh(self, obj):
        self.refreshed.append(obj)

    def add(self, obj):
        self.added.append(obj)


class TestRenameChatSession:
    def test_rename_updates_title_without_touching_updated_at(self):
        moment = datetime(2026, 1, 1, 12, 0)
        row = types.SimpleNamespace(
            session_id="s1",
            title="旧标题",
            created_at=moment,
            updated_at=moment,
            deleted_at=None,
        )
        db = _RenameDB(agent=types.SimpleNamespace(id=1), row=row)

        result = asyncio.run(
            rename_chat_session_api(
                1, "s1", ChatSessionRenameBody(title="  排查告警  "), db=db, current_user=_user()
            )
        )

        assert row.title == "排查告警"
        # 重命名不改变会话活跃时间，避免旧会话被顶到列表最前
        assert row.updated_at == moment
        # helper 提交一次标题更新，审计日志再提交一次
        assert db.commits >= 1
        assert result["session_id"] == "s1"
        assert result["title"] == "排查告警"
        assert db.added[0].action == "agent.chat_session.rename"

    def test_long_title_is_truncated(self):
        row = types.SimpleNamespace(
            session_id="s1", title="", created_at=None, updated_at=None, deleted_at=None
        )
        db = _RenameDB(agent=types.SimpleNamespace(id=1), row=row)

        rename_chat_session(db, 1, 7, "s1", "x" * (SESSION_TITLE_MAX + 20))

        assert len(row.title) == SESSION_TITLE_MAX + 1  # 截断后补一个省略号
        assert row.title.endswith("…")

    def test_blank_title_rejected(self):
        db = _RenameDB(agent=types.SimpleNamespace(id=1), row=None)

        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                rename_chat_session_api(
                    1, "s1", ChatSessionRenameBody(title="   "), db=db, current_user=_user()
                )
            )

        assert exc.value.status_code == 404
        assert db.commits == 0

    def test_missing_session_returns_404(self):
        db = _RenameDB(agent=types.SimpleNamespace(id=1), row=None)

        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                rename_chat_session_api(
                    1, "s1", ChatSessionRenameBody(title="新标题"), db=db, current_user=_user()
                )
            )

        assert exc.value.status_code == 404

    def test_missing_agent_returns_404(self):
        db = _RenameDB(agent=None, row=types.SimpleNamespace(session_id="s1", title=""))

        with pytest.raises(HTTPException) as exc:
            asyncio.run(
                rename_chat_session_api(
                    404, "s1", ChatSessionRenameBody(title="新标题"), db=db, current_user=_user()
                )
            )

        assert exc.value.status_code == 404

