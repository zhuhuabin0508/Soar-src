"""工单监控大屏聚合的 TTL 缓存与 single-flight。

大屏轮询和开放接口 ``ticket_monitor`` 共用 ``ticket_monitor_payload``：
TTL 内直接返回内存快照；过期后的轮询仍返回上一份，扫表在后台线程进行。
该键还没有快照时才由本次请求同步计算。轻量与全景分键，互不等待。

运行：python -m pytest tests/test_ticket_monitor_cache.py -v
"""
import threading
import time

import pytest

import app.api.v1.tickets as tickets_api


@pytest.fixture(autouse=True)
def _clear_monitor_cache():
    tickets_api._monitor_payload_cache.clear()
    tickets_api._monitor_refresh_not_before.clear()
    tickets_api._monitor_payload_flight_locks.clear()
    yield
    tickets_api._monitor_payload_cache.clear()
    tickets_api._monitor_refresh_not_before.clear()
    tickets_api._monitor_payload_flight_locks.clear()


class _DummySession:
    def close(self):
        return None


def _wait_until(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def _patch_compute(monkeypatch, fn):
    def wrapped(db, flow_id, light, include_drill, drill_limit):
        return fn(
            db,
            flow_id=flow_id,
            light=light,
            include_drill=include_drill,
            drill_limit=drill_limit,
        )

    monkeypatch.setattr(tickets_api, "_compute_ticket_monitor_payload", wrapped)


def test_ttl_hit_returns_same_payload(monkeypatch):
    calls = []

    def fake(db, **kwargs):
        calls.append(kwargs)
        return {"n": len(calls), "light": kwargs["light"]}

    _patch_compute(monkeypatch, fake)

    first = tickets_api.ticket_monitor_payload(None, light=True)
    second = tickets_api.ticket_monitor_payload(None, light=True, flow_id=9, include_drill=False)
    assert first is second
    assert first["n"] == 1
    assert len(calls) == 1


def test_full_params_are_separate_keys(monkeypatch):
    calls = []

    def fake(db, **kwargs):
        calls.append((kwargs["include_drill"], kwargs["flow_id"]))
        return {"k": len(calls)}

    _patch_compute(monkeypatch, fake)

    a = tickets_api.ticket_monitor_payload(None, include_drill=False)
    b = tickets_api.ticket_monitor_payload(None, include_drill=True)
    c = tickets_api.ticket_monitor_payload(None, include_drill=False, flow_id=3)
    again = tickets_api.ticket_monitor_payload(None, include_drill=False)
    assert a is again
    assert a is not b and b is not c
    assert len(calls) == 3


def test_expired_poll_returns_stale_without_query(monkeypatch):
    """过期轮询立刻返回旧快照；查库发生在后台线程，不在这次调用里。"""
    calls = []
    started = threading.Event()

    def fake(db, **kwargs):
        calls.append(1)
        if len(calls) > 1:
            started.set()
        return {"n": len(calls)}

    _patch_compute(monkeypatch, fake)
    monkeypatch.setattr(tickets_api, "_MONITOR_PAYLOAD_CACHE_TTL_SECONDS", 0.05)
    monkeypatch.setattr(tickets_api, "_open_monitor_refresh_session", lambda: _DummySession())

    first = tickets_api.ticket_monitor_payload(None, light=True)
    time.sleep(0.08)
    second = tickets_api.ticket_monitor_payload(None, light=True)
    assert second is first
    assert second["n"] == 1
    assert started.wait(2)
    deadline = time.monotonic() + 2
    fresh = None
    while time.monotonic() < deadline:
        fresh = tickets_api._monitor_payload_cache_get(("light",))
        if fresh is not None and fresh.get("n") == 2:
            break
        time.sleep(0.01)
    assert fresh is not None and fresh["n"] == 2
    assert len(calls) == 2


def test_failure_is_not_cached(monkeypatch):
    calls = []

    def fake(db, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("db down")
        return {"ok": True}

    _patch_compute(monkeypatch, fake)

    with pytest.raises(RuntimeError):
        tickets_api.ticket_monitor_payload(None, light=True)
    payload = tickets_api.ticket_monitor_payload(None, light=True)
    assert payload == {"ok": True}
    assert len(calls) == 2


def test_refresh_failure_backs_off(monkeypatch):
    """后台刷新失败后的下一次轮询只回旧快照，不再立刻扫表。"""
    calls = []

    def fake(db, **kwargs):
        calls.append(1)
        if len(calls) > 1:
            raise RuntimeError("db down")
        return {"n": 1}

    _patch_compute(monkeypatch, fake)
    monkeypatch.setattr(tickets_api, "_MONITOR_PAYLOAD_CACHE_TTL_SECONDS", 0.05)
    monkeypatch.setattr(tickets_api, "_open_monitor_refresh_session", lambda: _DummySession())

    first = tickets_api.ticket_monitor_payload(None, light=True)
    time.sleep(0.08)
    second = tickets_api.ticket_monitor_payload(None, light=True)
    assert second is first
    assert _wait_until(lambda: ("light",) in tickets_api._monitor_refresh_not_before)
    third = tickets_api.ticket_monitor_payload(None, light=True)
    time.sleep(0.05)
    assert third is first
    assert len(calls) == 2


def test_session_close_failure_releases_lock(monkeypatch):
    """关闭会话抛错时，刷新锁仍会放开，成功的快照保留。"""
    calls = []

    class _BoomSession:
        def close(self):
            raise RuntimeError("close failed")

    def fake(db, **kwargs):
        calls.append(1)
        return {"n": len(calls)}

    _patch_compute(monkeypatch, fake)
    monkeypatch.setattr(tickets_api, "_MONITOR_PAYLOAD_CACHE_TTL_SECONDS", 0.05)
    monkeypatch.setattr(tickets_api, "_open_monitor_refresh_session", lambda: _BoomSession())

    tickets_api.ticket_monitor_payload(None, light=True)
    time.sleep(0.08)
    stale = tickets_api.ticket_monitor_payload(None, light=True)
    assert stale["n"] == 1
    assert _wait_until(lambda: len(calls) >= 2)
    lock = tickets_api._monitor_payload_flight_lock(("light",))
    assert _wait_until(lambda: lock.acquire(blocking=False))
    lock.release()
    fresh = tickets_api._monitor_payload_cache_get(("light",))
    assert fresh is not None and fresh["n"] == 2


def test_single_flight_collapses_concurrent_calls(monkeypatch):
    calls = []
    entered = threading.Event()
    release = threading.Event()

    def fake(db, **kwargs):
        calls.append(1)
        entered.set()
        assert release.wait(2)
        return {"shared": True}

    _patch_compute(monkeypatch, fake)

    results = []
    errors = []

    def worker():
        try:
            results.append(tickets_api.ticket_monitor_payload(None, light=True))
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for t in threads:
        t.start()
    assert entered.wait(2)
    # 给其余线程时间排到同一把 flight 锁上，再放行唯一一次计算
    time.sleep(0.05)
    release.set()
    for t in threads:
        t.join(2)
        assert not t.is_alive()

    assert errors == []
    assert len(calls) == 1
    assert len(results) == 6
    assert all(r is results[0] for r in results)


def test_light_and_full_compute_concurrently(monkeypatch):
    """分键锁：轻量轮询不等全景聚合算完。"""
    state = {"inside": 0, "peak": 0}
    lock = threading.Lock()
    both_inside = threading.Event()

    def fake(db, **kwargs):
        with lock:
            state["inside"] += 1
            state["peak"] = max(state["peak"], state["inside"])
            if state["inside"] >= 2:
                both_inside.set()
        assert both_inside.wait(2)
        with lock:
            state["inside"] -= 1
        return {"light": kwargs["light"]}

    _patch_compute(monkeypatch, fake)

    done = []

    def run(light):
        done.append(tickets_api.ticket_monitor_payload(None, light=light, include_drill=False))

    threads = [
        threading.Thread(target=run, args=(True,)),
        threading.Thread(target=run, args=(False,)),
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join(2)
        assert not t.is_alive()

    assert both_inside.is_set()
    assert state["peak"] == 2
    assert {d["light"] for d in done} == {True, False}


def test_ticket_monitor_payload_json_always_str(monkeypatch):
    """全景 JSON 出口必须为 str，供开放 API 直拼回发（走真实读缓存路径）。"""
    import json

    def fake(db, **kwargs):
        return {"kpi": 42}

    _patch_compute(monkeypatch, fake)
    key = tickets_api._monitor_payload_cache_key(None, False, False, 2000)
    tickets_api._refresh_monitor_payload(None, key, None, False, False, 2000)
    text = tickets_api.ticket_monitor_payload_json(None, include_drill=False)
    assert isinstance(text, str)
    assert json.loads(text)["kpi"] == 42


def test_get_ticket_monitor_full_returns_prerendered_str(monkeypatch):
    from app.core.open_api_registry import get_ticket_monitor

    def fake_json(db, **kwargs):
        return '{"from":"cache"}'

    monkeypatch.setattr(tickets_api, "ticket_monitor_payload_json", fake_json)
    items, total = get_ticket_monitor(None, {"light": "0"})
    assert isinstance(items, str)
    assert items == '{"from":"cache"}'
    assert total == 1


def test_get_ticket_monitor_light_returns_dict(monkeypatch):
    from app.core.open_api_registry import get_ticket_monitor

    def fake(db, **kwargs):
        return {"light": True}

    monkeypatch.setattr(tickets_api, "ticket_monitor_payload", fake)
    items, _ = get_ticket_monitor(None, {"light": "1"})
    assert isinstance(items, dict)
    assert items["light"] is True


def test_open_api_envelope_accepts_prerendered_data_str():
    """与 open_api.get_resource_data 中 ticket_monitor 分支的拼接契约一致。"""
    import json

    items = '{"kpi":1}'
    resource = json.dumps({"code": "ticket_monitor", "name": "工单监控"}, ensure_ascii=False)
    content = '{"code":0,"message":"ok","resource":' + resource + ',"data":' + items + "}"
    parsed = json.loads(content)
    assert parsed["code"] == 0
    assert parsed["data"]["kpi"] == 1
