"""工单编号生成与并发撞号重试测试。

背景：``_gen_ticket_no`` 原按「当日工单数 + 1」取号，工单被物理删除产生断号后，
计数会追上已存在编号，触发 ticket_no 唯一约束冲突（POST /api/v1/tickets 500，
线上 TK-20261029-0015 事故）。修复后改为「当日最大序号 + 1」，并在
``create_ticket`` 中增加撞号回滚重取（最多 5 次）。

覆盖：
- 取号正确性：空库首号 / 连续序号 / 断号续号（生产事故场景）/ 历史日期不干扰
- 撞号识别：``_is_ticket_no_conflict`` 约束名精确判定 + 报错文本兜底
- 端到端重试：首次取号撞已存在编号 → 自动回滚重取成功；连续撞号 → 503

运行：docker exec soar-backend-dev python -m pytest /app/tests/test_ticket_no_generation.py -v
"""
import os
import sys

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.api.v1.tickets as tickets_api
from app.api.v1.tickets import _gen_ticket_no, _is_ticket_no_conflict, router as tickets_router
from app.core.timezone import beijing_now
from app.database import Base, get_db
from app.dependencies import get_current_user
from app.models.audit_log import AuditLog
from app.models.notification import Notification
from app.models.ticket import (
    Ticket, TicketCc, TicketFlow, TicketGroup, TicketGroupMember, TicketNodeRecord,
)
from app.models.user import User

# ============ 测试基础设施：内存 SQLite + 依赖覆盖 ============

_engine = create_engine(
    "sqlite://",
    connect_args={"check_same_thread": False},
    poolclass=StaticPool,
)
_TestSessionLocal = sessionmaker(bind=_engine, autoflush=False, autocommit=False)

Base.metadata.create_all(_engine, tables=[
    User.__table__, TicketFlow.__table__, Ticket.__table__,
    TicketNodeRecord.__table__, TicketCc.__table__,
    TicketGroup.__table__, TicketGroupMember.__table__,
    Notification.__table__, AuditLog.__table__,
])

_app = FastAPI()
_app.include_router(tickets_router)


@pytest.fixture(autouse=True)
def _clean_db():
    """每个测试前清空全部表数据。"""
    db = _TestSessionLocal()
    try:
        for tbl in (AuditLog, Notification, TicketCc, TicketNodeRecord, Ticket,
                    TicketGroupMember, TicketGroup, TicketFlow, User):
            db.query(tbl).delete()
        db.commit()
    finally:
        db.close()
    yield


def _today() -> str:
    return beijing_now().strftime("%Y%m%d")


def _db():
    return _TestSessionLocal()


def _seed_user(db, name="admin", role="admin") -> User:
    u = User(username=name, password_hash="x", display_name=name, role=role)
    db.add(u)
    db.commit()
    return u


def _seed_flow(db) -> TicketFlow:
    """最小流程：发起节点 → 直通结束节点。"""
    flow = TicketFlow(
        name="测试流程",
        version=1,
        enabled=True,
        is_draft=False,
        nodes={
            "nodes": [
                {"key": "n_start", "name": "发起", "type": "task",
                 "fields": [], "routes": [{"to": "end"}]},
                {"key": "end", "name": "结束", "type": "end", "fields": [], "routes": []},
            ]
        },
    )
    db.add(flow)
    db.commit()
    return flow


def _seed_ticket(db, ticket_no: str) -> Ticket:
    """按指定编号种子一条工单（模拟历史/删除后残留的编号）。"""
    day = ticket_no.split("-")[1]
    flow = db.query(TicketFlow).first()
    t = Ticket(
        ticket_no=ticket_no,
        title=f"种子-{ticket_no}",
        flow_id=flow.id,
        flow_name=flow.name,
        flow_snapshot={"flow_id": flow.id, "flow_name": flow.name, "version": 1, "nodes": []},
        status="completed",
        created_by_id=1,
        created_by_name="seed",
        closed_at=beijing_now().replace(
            year=int(day[:4]), month=int(day[4:6]), day=int(day[6:8])
        ),
    )
    db.add(t)
    db.commit()
    return t


def _client(user: User) -> TestClient:
    """构造覆盖当前用户与测试库的 TestClient（admin 角色自动通过权限矩阵）。"""
    db = _TestSessionLocal()

    def _override_db():
        try:
            yield db
        finally:
            db.rollback()

    _app.dependency_overrides[get_db] = _override_db
    _app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(_app)


def _payload(flow_id: int) -> dict:
    return {"flow_id": flow_id, "title": "测试工单", "priority": "medium"}


# ============ 取号正确性 ============

class TestGenTicketNo:

    def test_empty_day_returns_0001(self):
        db = _db()
        try:
            _seed_flow(db)
            assert _gen_ticket_no(db) == f"TK-{_today()}-0001"
        finally:
            db.close()

    def test_contiguous_sequence(self):
        db = _db()
        try:
            _seed_flow(db)
            for i in (1, 2, 3):
                _seed_ticket(db, f"TK-{_today()}-000{i}")
            assert _gen_ticket_no(db) == f"TK-{_today()}-0004"
        finally:
            db.close()

    def test_gap_after_delete_continues_from_max(self):
        """生产事故场景：当日 0001 被物理删除，仅剩 0002~0015。

        旧逻辑（数量+1）返回 0015 与现存编号冲突；新逻辑应续 0016。
        """
        db = _db()
        try:
            _seed_flow(db)
            for i in range(2, 16):  # 0002 ~ 0015
                _seed_ticket(db, f"TK-{_today()}-{i:04d}")
            assert _gen_ticket_no(db) == f"TK-{_today()}-0016"
        finally:
            db.close()

    def test_multiple_gaps_continue_from_max(self):
        """多次删除产生多个断号：仅剩 0003/0007/0009 → 应续 0010。"""
        db = _db()
        try:
            _seed_flow(db)
            for i in (3, 7, 9):
                _seed_ticket(db, f"TK-{_today()}-{i:04d}")
            assert _gen_ticket_no(db) == f"TK-{_today()}-0010"
        finally:
            db.close()

    def test_history_days_not_interfere(self):
        """历史日期的编号不影响当日序号。"""
        db = _db()
        try:
            _seed_flow(db)
            _seed_ticket(db, f"TK-{int(_today()) - 1:08d}-0099")
            _seed_ticket(db, f"TK-{_today()}-0001")
            assert _gen_ticket_no(db) == f"TK-{_today()}-0002"
        finally:
            db.close()


# ============ 撞号识别 ============

class TestIsTicketNoConflict:

    def _exc(self, message: str, constraint_name=None):
        orig = Exception(message)
        if constraint_name is not None:
            class _Diag:
                pass
            _Diag.constraint_name = constraint_name
            orig.diag = _Diag()
        return IntegrityError("INSERT ...", {}, orig)

    def test_match_by_constraint_name(self):
        assert _is_ticket_no_conflict(self._exc("dup", "ix_tickets_ticket_no")) is True

    def test_reject_other_constraint(self):
        assert _is_ticket_no_conflict(self._exc("dup", "uq_other_column")) is False

    def test_fallback_by_message_text(self):
        exc = self._exc('duplicate key value violates unique constraint "ix_tickets_ticket_no"')
        assert _is_ticket_no_conflict(exc) is True

    def test_fallback_sqlite_dialect(self):
        """SQLite 单测环境：报错文本不含约束名，仅含列路径。"""
        exc = self._exc("UNIQUE constraint failed: tickets.ticket_no")
        assert _is_ticket_no_conflict(exc) is True

    def test_fallback_other_unique_violation(self):
        exc = self._exc('duplicate key value violates unique constraint "uq_banned_ip"')
        assert _is_ticket_no_conflict(exc) is False
        exc_sqlite = self._exc("UNIQUE constraint failed: banned_ips.ip")
        assert _is_ticket_no_conflict(exc_sqlite) is False


# ============ 端到端：发起工单 + 撞号重试 ============

class TestCreateTicketRetry:

    def test_normal_create_gets_next_no(self):
        db = _db()
        try:
            _seed_user(db)
            flow = _seed_flow(db)
            _seed_ticket(db, f"TK-{_today()}-0001")
            _seed_ticket(db, f"TK-{_today()}-0002")
            user = db.query(User).first()
            with _client(user) as c:
                resp = c.post("/tickets", json=_payload(flow.id))
            assert resp.status_code == 201, resp.text
            assert resp.json()["ticket_no"] == f"TK-{_today()}-0003"
        finally:
            db.close()

    def test_retry_on_conflict_then_success(self):
        """首次取号撞已存在编号 → 回滚重取成功（201），编号为正确续号。"""
        db = _db()
        try:
            _seed_user(db)
            flow = _seed_flow(db)
            for i in range(2, 16):  # 模拟 0001 已删：仅剩 0002~0015
                _seed_ticket(db, f"TK-{_today()}-{i:04d}")
            user = db.query(User).first()

            real_gen = tickets_api._gen_ticket_no
            calls = {"n": 0}

            def flaky_gen(session):
                calls["n"] += 1
                if calls["n"] == 1:
                    return f"TK-{_today()}-0002"  # 已存在 → 必然撞号
                return real_gen(session)

            original = tickets_api._gen_ticket_no
            tickets_api._gen_ticket_no = flaky_gen
            try:
                with _client(user) as c:
                    resp = c.post("/tickets", json=_payload(flow.id))
            finally:
                tickets_api._gen_ticket_no = original

            assert resp.status_code == 201, resp.text
            assert resp.json()["ticket_no"] == f"TK-{_today()}-0016"
            assert calls["n"] == 2  # 第一次冲突，第二次成功
            # 新工单真实落库
            db.expire_all()
            assert db.query(Ticket).filter(
                Ticket.ticket_no == f"TK-{_today()}-0016").count() == 1
        finally:
            db.close()

    def test_exhausted_retries_returns_503(self):
        """取号始终撞号 → 5 次重试耗尽后返回 503，且不产生脏数据。"""
        db = _db()
        try:
            _seed_user(db)
            flow = _seed_flow(db)
            _seed_ticket(db, f"TK-{_today()}-0002")
            user = db.query(User).first()

            def always_conflict(session):  # noqa: ARG001
                return f"TK-{_today()}-0002"

            original = tickets_api._gen_ticket_no
            tickets_api._gen_ticket_no = always_conflict
            try:
                with _client(user) as c:
                    resp = c.post("/tickets", json=_payload(flow.id))
            finally:
                tickets_api._gen_ticket_no = original

            assert resp.status_code == 503, resp.text
            assert "冲突" in resp.json()["detail"]
            db.expire_all()
            # 仅有种子那一条，无新增工单/节点记录
            assert db.query(Ticket).count() == 1
            assert db.query(TicketNodeRecord).count() == 0
        finally:
            db.close()
