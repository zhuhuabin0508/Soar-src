# -*- coding: utf-8 -*-
"""XDR 设备动作智能体工具包验证用例。

覆盖：
1. 全部 63 个设备动作（告警/事件 47 + 资产/资产组 16）均生成标准化工具定义
   （命名唯一、类型合法、描述完整）；
2. 工具代码经沙箱协议透传到统一入口；
3. 正常调用、参数错误、设备/权限错误、接口异常（4xx/5xx/超时/业务失败）；
4. query_xdr_asset_group 资产组查询专用工具（树解析、名称/ID 匹配、未命中自纠错）；
5. query_xdr_alert_stats 资产组告警统计专用工具（资产组展开、按等级求和、口径参数）。
"""
import asyncio
import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import app.tools.xdr_action_tools as xdr_tools
from app.core.sangfor_xdr_actions import SANGFOR_XDR_ACTIONS
from app.core.tools.catalog import ToolCatalog
from app.core.tools.definitions.xdr_actions import XDR_ACTION_TOOLS
from app.database import Base
from app.models.device import Device, DeviceAction

_ALLOWED_TYPES = {"String", "Integer", "Number", "Boolean", "Object", "Array"}


@pytest.fixture()
def db_factory(monkeypatch):
    """内存库 + 把工具包的 SessionLocal 指向测试会话工厂。"""
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(
        bind=engine, tables=[Device.__table__, DeviceAction.__table__]
    )
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(xdr_tools, "SessionLocal", factory)
    yield factory
    engine.dispose()


@pytest.fixture()
def xdr_device(db_factory):
    """创建一台已启用的 XDR 设备并挂载全部内置动作。"""
    session = db_factory()
    device = Device(
        name="深信服XDR",
        type="custom",
        vendor="深信服",
        api_url="https://xdr.example.com",
        auth_type="sangfor_xdr",
        enabled=True,
        timeout=30,
        max_retries=2,
        verify_tls=False,
    )
    session.add(device)
    session.flush()
    for action in SANGFOR_XDR_ACTIONS:
        session.add(
            DeviceAction(
                device_id=device.id,
                name=action["name"],
                action_type=action["action_type"],
                http_method=action["http_method"],
                api_path=action["api_path"],
                params_schema=json.dumps(action["params_schema"], ensure_ascii=False),
                headers=json.dumps(action.get("headers") or {}),
                body_template=action.get("body_template") or "",
                auth_type=action["auth_type"],
                enabled=True,
                description=action["description"],
                category=action["category"],
                risk_level=action["risk_level"],
                version=1,
                example_payload=action.get("example_payload"),
                example_response=action.get("example_response"),
            )
        )
    session.commit()
    device_id = device.id
    session.close()
    return device_id


def _tool(name: str) -> dict:
    return next(t for t in XDR_ACTION_TOOLS if t["name"] == name)


# ---------------------------------------------------------------------------
# 1. 工具定义
# ---------------------------------------------------------------------------
def test_action_tools_cover_all_actions():
    """63 个动作（告警/事件 47 + 资产/资产组 16）全部生成工具，命名唯一且符合协议。"""
    assert len(SANGFOR_XDR_ACTIONS) == 63
    assert len(XDR_ACTION_TOOLS) == 63

    names = [t["name"] for t in XDR_ACTION_TOOLS]
    assert len(names) == len(set(names))
    assert {"xdr_alerts_list", "xdr_alerts_count_fusion", "xdr_incidents_list",
            "xdr_incidents_trends", "xdr_bigscreen_branchlist", "xdr_assets_list",
            "xdr_assets_total", "xdr_riskassets_list"} <= set(names)

    for tool in XDR_ACTION_TOOLS:
        assert tool["tool_type"] == "code"
        assert tool["category"] == "xdr"
        assert tool["is_preset"] is True
        # 描述包含功能、使用场景、返回结构与示例
        for keyword in ("使用场景", "返回结构化结果", "示例调用"):
            assert keyword in tool["description"]
        # 工具代码无 import（沙箱禁止），仅透传统一入口
        assert "import " not in tool["code"]
        assert "run_xdr_action" in tool["code"]
        # 参数类型合法，且统一追加可选 device_id
        params = tool["parameters_schema"]
        assert [p["name"] for p in params][-1] == "device_id"
        assert all(p["type"] in _ALLOWED_TYPES for p in params)
        assert all(p["name"] and p["description"] for p in params)


def test_action_tools_required_and_nested_fields():
    """必填项清晰；被错误平铺的嵌套字段不进入顶层参数。"""
    aggregation = _tool("xdr_alerts_aggregation")
    required = {p["name"] for p in aggregation["parameters_schema"] if p["required"]}
    assert {"startTimestamp", "endTimestamp", "timeField", "aggFuncs"} <= required

    # 资产聚合：name/func/param 是 aggFuncs 元素字段，不应作为顶层必填
    asset_agg = {p["name"] for p in _tool("xdr_alerts_asset_aggregation")["parameters_schema"]}
    assert not {"name", "func", "param"} & asset_agg

    # 攻击区域：areaName/branchIds 属于 areaInfos，不应作为顶层必填
    area = {p["name"] for p in _tool("xdr_alerts_attack_area")["parameters_schema"]}
    assert not {"areaName", "branchIds"} & area

    # 安全态势分析：startTime/endTime 属于 weekTime/dayTime
    analysis = {p["name"] for p in _tool("xdr_incidents_security_analysis")["parameters_schema"]}
    assert {"weekTime", "dayTime"} <= analysis
    assert not {"startTime", "endTime"} & analysis

    # 事件驳回：dataType/id/desc/optType 属于 data 数组元素
    reject = {p["name"] for p in _tool("xdr_incidents_reject")["parameters_schema"]}
    assert {"companyId", "data"} <= reject
    assert not {"dataType", "id", "desc", "optType"} & reject


def test_action_tools_registered_in_catalog():
    """新工具已进入预置工具目录，且与既有工具无重名。"""
    definitions = ToolCatalog.preset_definitions()
    names = [t["name"] for t in definitions]
    assert len(names) == len(set(names))

    xdr_action_names = {t["name"] for t in XDR_ACTION_TOOLS}
    assert xdr_action_names <= set(names)
    assert len(xdr_action_names) == 63
    assert all(ToolCatalog.preset_source_for_name(n) == "builtin" for n in xdr_action_names)


def test_tool_code_forwards_to_unified_entry():
    """工具代码按协议透传 action_key / params / device_id。"""
    calls = {}

    async def fake_run_xdr_action(**kwargs):
        calls.update(kwargs)
        return {"ok": True}

    namespace = {"run_xdr_action": fake_run_xdr_action}
    exec(compile(_tool("xdr_alerts_list")["code"], "<tool:xdr_alerts_list>", "exec"), namespace)
    result = asyncio.run(namespace["run"](page=2, pageSize=20, device_id=3))

    assert result == {"ok": True}
    assert calls["action_key"] == "xdr_alerts_list"
    assert calls["params"] == {"page": 2, "pageSize": 20}
    assert calls["device_id"] == 3


# ---------------------------------------------------------------------------
# 2. 正常场景
# ---------------------------------------------------------------------------
def test_run_xdr_action_success(monkeypatch, xdr_device):
    """正常调用：参数规整、结构化结果解包 XDR data。"""
    captured = {}

    def fake_execute(device, action, params, timeout, **kwargs):
        captured.update(
            {
                "device_id": device.id,
                "api_path": action.api_path,
                "params": params,
                "timeout": timeout,
                "kwargs": kwargs,
            }
        )
        return {
            "success": True,
            "status_code": 200,
            "response_body": {
                "code": "Success",
                "message": "success",
                "data": {"total": 1, "item": [{"uuId": "alert-1"}]},
            },
            "error": None,
            "latency_ms": 12,
        }

    monkeypatch.setattr(xdr_tools, "execute_device_action", fake_execute)
    out = asyncio.run(
        xdr_tools.run_xdr_action(
            "xdr_alerts_list", {"page": "2", "pageSize": 20}, agent_id=7, user_id=9
        )
    )

    assert out["ok"] is True and out["status"] == "success"
    assert out["http_status"] == 200
    assert out["code"] == "Success"
    assert out["data"] == {"total": 1, "item": [{"uuId": "alert-1"}]}
    assert out["raw_response"]["message"] == "success"
    assert out["error"] is None
    assert out["latency_ms"] == 12
    assert out["device"]["id"] == xdr_device
    assert out["action"]["key"] == "xdr_alerts_list"

    # 字符串数字被规整为整数；未传的非空默认值在工具层回填（与工具参数
    # 描述的“（默认值: …）”口径一致），空容器默认值不下发；执行器按
    # agent 来源记录并跳过原始 schema 必填校验
    assert captured["params"]["page"] == 2
    assert captured["params"]["pageSize"] == 20
    assert captured["params"]["timeField"] == "lastTime"
    assert captured["params"]["sortField"] == "lastTime"
    assert captured["params"]["sortOrder"] == "asc"
    assert "alertDealStatus" not in captured["params"]
    assert "accessDirections" not in captured["params"]
    assert captured["kwargs"]["source"] == "agent"
    assert captured["kwargs"]["skip_required_check"] is True
    assert captured["kwargs"]["agent_id"] == 7
    assert captured["kwargs"]["user_id"] == 9


# ---------------------------------------------------------------------------
# 3. 参数错误场景
# ---------------------------------------------------------------------------
def test_run_xdr_action_missing_required_params(monkeypatch, xdr_device):
    """缺少必填参数：不发请求，返回 validation_error 与缺失字段。"""
    called = {"count": 0}

    def fake_execute(*args, **kwargs):  # pragma: no cover - 不应被调用
        called["count"] += 1
        return {}

    monkeypatch.setattr(xdr_tools, "execute_device_action", fake_execute)
    out = asyncio.run(
        xdr_tools.run_xdr_action("xdr_alerts_aggregation", {"startTimestamp": 1})
    )

    assert out["ok"] is False
    assert out["error"]["type"] == "validation_error"
    assert out["error"]["retryable"] is False
    assert set(out["error"]["details"]["missing"]) >= {"endTimestamp", "timeField", "aggFuncs"}
    assert called["count"] == 0


def test_run_xdr_action_invalid_and_unknown_params(monkeypatch, xdr_device):
    """类型错误与未知参数都在本地拦截。"""
    monkeypatch.setattr(
        xdr_tools, "execute_device_action", lambda *a, **k: pytest.fail("不应发起请求")
    )
    out = asyncio.run(
        xdr_tools.run_xdr_action(
            "xdr_alerts_aggregation",
            {
                "startTimestamp": "not-a-number",
                "endTimestamp": 2,
                "timeField": "lastTime",
                "aggFuncs": [],
                "typoParam": "x",
            },
        )
    )
    assert out["ok"] is False
    assert out["error"]["type"] == "validation_error"
    details = out["error"]["details"]
    assert "startTimestamp" in details["invalid"]
    assert details["unknown"] == ["typoParam"]


def test_run_xdr_action_device_errors(monkeypatch, db_factory):
    """未配置设备 / 指定不存在的设备均返回明确错误。"""
    out = asyncio.run(xdr_tools.run_xdr_action("xdr_alerts_list", {}))
    assert out["ok"] is False
    assert out["error"]["type"] == "device_not_configured"

    out = asyncio.run(
        xdr_tools.run_xdr_action("xdr_alerts_list", {}, device_id=999)
    )
    assert out["ok"] is False
    assert out["error"]["type"] == "device_not_found"


def test_run_xdr_action_high_risk_requires_user(monkeypatch, xdr_device):
    """中风险处置动作缺少用户上下文时被服务端门禁拦截。"""
    monkeypatch.setattr(
        xdr_tools, "execute_device_action", lambda *a, **k: pytest.fail("不应发起请求")
    )
    out = asyncio.run(
        xdr_tools.run_xdr_action(
            "xdr_incidents_reject",
            {"companyId": "c1", "data": [{"dataType": 1, "id": "i1"}]},
        )
    )
    assert out["ok"] is False
    assert out["error"]["type"] == "permission_denied"


# ---------------------------------------------------------------------------
# 4. 接口异常场景
# ---------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("status_code", "error", "expected_type", "retryable"),
    [
        (401, "HTTP 401", "auth_error", False),
        (403, "HTTP 403", "auth_error", False),
        (404, "HTTP 404", "not_found_error", False),
        (429, "HTTP 429", "rate_limited", True),
        (500, "HTTP 500", "server_error", True),
        (502, "HTTP 502", "server_error", True),
        (400, "HTTP 400", "http_error", False),
    ],
)
def test_run_xdr_action_http_errors(
    monkeypatch, xdr_device, status_code, error, expected_type, retryable
):
    """HTTP 异常按状态码分类，并标记是否可重试。"""

    def fake_execute(*args, **kwargs):
        return {
            "success": False,
            "status_code": status_code,
            "response_body": {"code": "Failed", "message": "upstream failed"},
            "error": error,
            "latency_ms": 8,
        }

    monkeypatch.setattr(xdr_tools, "execute_device_action", fake_execute)
    out = asyncio.run(xdr_tools.run_xdr_action("xdr_alerts_list", {}))

    assert out["ok"] is False
    assert out["error"]["type"] == expected_type
    assert out["error"]["retryable"] is retryable
    assert out["error"]["message"] == "upstream failed"
    assert out["http_status"] == status_code


def test_run_xdr_action_timeout_and_connection_error(monkeypatch, xdr_device):
    """网络超时/连接异常可重试，并保留原始错误信息。"""
    for message, expected in (
        ("ReadTimeout: timed out", "timeout"),
        ("ConnectError: connection refused", "connection_error"),
    ):
        monkeypatch.setattr(
            xdr_tools,
            "execute_device_action",
            lambda *a, _m=message, **k: {
                "success": False,
                "status_code": None,
                "response_body": None,
                "error": _m,
                "latency_ms": 30000,
            },
        )
        out = asyncio.run(xdr_tools.run_xdr_action("xdr_alerts_list", {}))
        assert out["ok"] is False
        assert out["error"]["type"] == expected
        assert out["error"]["retryable"] is True
        assert message in out["error"]["message"]


def test_run_xdr_action_business_error(monkeypatch, xdr_device):
    """HTTP 200 但 XDR 业务码非成功时判定为 business_error。"""

    def fake_execute(*args, **kwargs):
        return {
            "success": True,
            "status_code": 200,
            "response_body": {"code": "AuthFailed", "message": "invalid signature"},
            "error": None,
            "latency_ms": 5,
        }

    monkeypatch.setattr(xdr_tools, "execute_device_action", fake_execute)
    out = asyncio.run(xdr_tools.run_xdr_action("xdr_alerts_list", {}))

    assert out["ok"] is False
    assert out["status"] == "failed"
    assert out["error"]["type"] == "business_error"
    assert out["error"]["retryable"] is False
    assert out["error"]["message"] == "invalid signature"


# ---------------------------------------------------------------------------
# 5. query_xdr_asset_group 资产组查询专用工具
# ---------------------------------------------------------------------------
_BRANCH_TREE = [
    {
        "id": 1,
        "name": "深圳SOC",
        "parentId": 0,
        "children": [
            {
                "id": 41,
                "name": "深圳市政数局资产",
                "parentId": 1,
                "children": [
                    {"id": 42, "name": "二级资产组A", "parentId": 41, "children": []},
                    {
                        "id": 43,
                        "name": "二级资产组B",
                        "parentId": 41,
                        "children": [
                            {"id": 44, "name": "三级资产组C", "parentId": 43, "children": []},
                        ],
                    },
                ],
            },
            {"id": 45, "name": "其他资产组", "parentId": 1, "children": []},
        ],
    },
]


def _fake_branchlist(monkeypatch, tree=None, ok=True):
    """把 run_xdr_action 桩为返回固定资产组树。"""

    async def fake_run(action_key, params=None, device_id=None, **kwargs):
        assert action_key == "xdr_bigscreen_branchlist"
        if not ok:
            return {"ok": False, "error": {"type": "auth_error", "message": "签名失败"}}
        return {"ok": True, "data": tree if tree is not None else _BRANCH_TREE}

    monkeypatch.setattr(xdr_tools, "run_xdr_action", fake_run)


def test_query_xdr_asset_group_by_name(monkeypatch):
    """按名称定位资产组：返回 ID、路径、二级资产组与全部后代 ID。"""
    _fake_branchlist(monkeypatch)
    out = asyncio.run(xdr_tools.query_xdr_asset_group(group_name="深圳市政数局资产"))

    assert out["ok"] is True and out["matched"] is True
    assert out["group"]["id"] == 41
    assert out["group"]["parent_id"] == 1
    assert out["group"]["depth"] == 2
    assert out["group"]["path"] == "深圳SOC/深圳市政数局资产"
    # 直接子组（二级资产组）
    assert {c["id"] for c in out["children"]} == {42, 43}
    # 全部后代（含三级）
    assert out["descendant_ids"] == [42, 43, 44]
    assert out["total_groups"] == 6


def test_query_xdr_asset_group_fuzzy_match_and_by_id(monkeypatch):
    """包含匹配生效；group_id 优先于 group_name。"""
    _fake_branchlist(monkeypatch)
    out = asyncio.run(xdr_tools.query_xdr_asset_group(group_name="政数局"))
    assert out["matched"] is True and out["group"]["id"] == 41

    out = asyncio.run(xdr_tools.query_xdr_asset_group(group_name="名称不对", group_id=41))
    assert out["matched"] is True and out["group"]["id"] == 41


def test_query_xdr_asset_group_not_found_returns_all(monkeypatch):
    """未命中时返回全量资产组清单供智能体自纠错。"""
    _fake_branchlist(monkeypatch)
    out = asyncio.run(xdr_tools.query_xdr_asset_group(group_name="不存在的组"))

    assert out["ok"] is True and out["matched"] is False
    assert out["error"]["type"] == "group_not_found"
    assert len(out["available_groups"]) == 6
    assert {g["id"] for g in out["available_groups"]} == {1, 41, 42, 43, 44, 45}


def test_query_xdr_asset_group_without_descendants(monkeypatch):
    """include_descendants=False 时只返回直接子组。"""
    _fake_branchlist(monkeypatch)
    out = asyncio.run(
        xdr_tools.query_xdr_asset_group(group_name="深圳市政数局资产", include_descendants=False)
    )
    assert out["matched"] is True
    assert {c["id"] for c in out["children"]} == {42, 43}
    assert "descendants" not in out and "descendant_ids" not in out


def test_query_xdr_asset_group_api_error(monkeypatch):
    """上游调用失败时透传结构化错误。"""
    _fake_branchlist(monkeypatch, ok=False)
    out = asyncio.run(xdr_tools.query_xdr_asset_group(group_name="任意组"))

    assert out["ok"] is False and out["matched"] is False
    assert out["error"]["type"] == "auth_error"


def test_query_xdr_asset_group_empty_data(monkeypatch):
    """空树返回明确错误。"""
    _fake_branchlist(monkeypatch, tree=[])
    out = asyncio.run(xdr_tools.query_xdr_asset_group(group_name="任意组"))
    assert out["ok"] is False
    assert out["error"]["type"] == "empty_data"


# ---------------------------------------------------------------------------
# 6. query_xdr_alert_stats 资产组告警统计专用工具
# ---------------------------------------------------------------------------
# trends + aggBy=["severity"] 实测响应形态：
# {"item": [{"name": "70", "item": [{"value": 数量, "name": <毫秒时间戳>}]}, ...]}
_TRENDS_BY_SEVERITY = {
    "item": [
        {"name": "70", "item": [{"value": 173, "name": 1794412800000}]},
        {"name": "50", "item": [{"value": 140, "name": 1794412800000}]},
        {"name": "30", "item": [{"value": 78, "name": 1794412800000}]},
    ]
}


def _fake_branch_and_trends(monkeypatch, trends_data=None, *, trends_ok=True):
    """把 run_xdr_action 桩为按 action_key 分发 branchlist / trends，并记录调用。"""
    calls: list[tuple[str, dict]] = []

    async def fake_run(action_key, params=None, device_id=None, **kwargs):
        calls.append((action_key, dict(params or {})))
        if action_key == "xdr_bigscreen_branchlist":
            return {"ok": True, "data": _BRANCH_TREE}
        if action_key != "xdr_alerts_trends":  # pragma: no cover - 防御
            raise AssertionError(f"意外的 action_key: {action_key}")
        if not trends_ok:
            return {
                "ok": False,
                "message": "upstream failed",
                "error": {"type": "server_error", "message": "upstream failed"},
            }
        return {"ok": True, "data": trends_data if trends_data is not None else _TRENDS_BY_SEVERITY}

    monkeypatch.setattr(xdr_tools, "run_xdr_action", fake_run)
    return calls


def test_query_xdr_alert_stats_success(monkeypatch):
    """正常统计：资产组展开到全部后代 ID，trends 按等级求和。"""
    calls = _fake_branch_and_trends(monkeypatch)
    out = asyncio.run(
        xdr_tools.query_xdr_alert_stats(
            group_name="深圳市政数局资产",
            start_timestamp=1794412800,
            end_timestamp=1794499199,
        )
    )

    assert out["ok"] is True and out["matched"] is True
    assert out["group"]["id"] == 41
    assert out["time_field"] == "lastTime"
    assert out["time_range"]["start_timestamp"] == 1794412800
    assert out["total"] == 391
    assert [s["name"] for s in out["by_severity"]] == ["严重", "高危", "中危"]
    assert [s["count"] for s in out["by_severity"]] == [173, 140, 78]
    assert out["group_scope"] == {
        "include_descendants": True,
        "branch_id_count": 4,
        "descendant_group_count": 3,
    }

    # 两次调用：branchlist 展开资产组，trends 按 hostBranchIds 过滤
    assert [key for key, _ in calls] == ["xdr_bigscreen_branchlist", "xdr_alerts_trends"]
    trends_params = calls[1][1]
    assert trends_params["filterParam"]["hostBranchIds"] == [41, 42, 43, 44]
    assert trends_params["timeField"] == "lastTime"
    assert trends_params["interval"] == "1d"
    assert trends_params["aggBy"] == ["severity"]
    assert trends_params["aggFuncs"] == [{"name": "count", "func": "count", "param": "uuId"}]
    assert trends_params["startTimestamp"] == 1794412800
    assert trends_params["endTimestamp"] == 1794499199


def test_query_xdr_alert_stats_multi_bucket_and_compat_shapes(monkeypatch):
    """同一等级跨多个时间桶求和；兼容等级值映射等其余桶形态。"""
    multi_bucket = {
        "item": [
            {
                "name": "70",
                "item": [
                    {"value": 100, "name": 1794412800000},
                    {"value": 73, "name": 1794499200000},
                ],
            },
            {
                "name": "50",
                "item": [
                    {"value": 40, "name": 1794412800000},
                    {"value": 100, "name": 1794499200000},
                ],
            },
        ]
    }
    _fake_branch_and_trends(monkeypatch, trends_data=multi_bucket)
    out = asyncio.run(xdr_tools.query_xdr_alert_stats(group_id=41))
    counts = {s["name"]: s["count"] for s in out["by_severity"]}
    assert counts == {"严重": 173, "高危": 140}
    assert out["total"] == 313

    # 兼容 {"severity": 70, "count": 5} 与 {"70": 5, "50": 3} 形态
    _fake_branch_and_trends(
        monkeypatch, trends_data={"item": [{"severity": 70, "count": 5}]}
    )
    out = asyncio.run(xdr_tools.query_xdr_alert_stats(group_id=41, time_field="firstTime"))
    counts = {s["name"]: s["count"] for s in out["by_severity"]}
    assert counts == {"严重": 5}
    assert out["total"] == 5
    # firstTime 口径透传到 trends
    assert out["time_field"] == "firstTime"

    _fake_branch_and_trends(monkeypatch, trends_data={"item": [{"70": 5, "50": 3}]})
    out = asyncio.run(xdr_tools.query_xdr_alert_stats(group_id=41))
    counts = {s["name"]: s["count"] for s in out["by_severity"]}
    assert counts == {"严重": 5, "高危": 3}


def test_query_xdr_alert_stats_without_descendants(monkeypatch):
    """include_descendants=False：只按目标资产组自身 ID 统计。"""
    calls = _fake_branch_and_trends(monkeypatch)
    out = asyncio.run(
        xdr_tools.query_xdr_alert_stats(group_id=41, include_descendants=False)
    )
    assert out["ok"] is True
    assert calls[1][1]["filterParam"]["hostBranchIds"] == [41]
    assert out["group_scope"]["branch_id_count"] == 1


def test_query_xdr_alert_stats_default_today(monkeypatch):
    """缺省时间范围为北京时间今日全天。"""
    calls = _fake_branch_and_trends(monkeypatch)
    out = asyncio.run(xdr_tools.query_xdr_alert_stats(group_name="深圳市政数局资产"))
    assert out["ok"] is True
    start, end = calls[1][1]["startTimestamp"], calls[1][1]["endTimestamp"]
    assert end - start == 86399
    # 今日 00:00:00 北京时间 = UTC 秒级时间戳 8 的整数倍对齐
    assert start % 86400 == 1794412800 % 86400
    assert out["time_range"]["start"].endswith("00:00:00")
    assert out["time_range"]["end"].endswith("23:59:59")


def test_query_xdr_alert_stats_invalid_params(monkeypatch):
    """缺资产组、非法口径、非法时间在本地拦截，不发起任何请求。"""
    called = []

    async def fake_run(*args, **kwargs):  # pragma: no cover - 不应被调用
        called.append(args)
        return {"ok": True, "data": []}

    monkeypatch.setattr(xdr_tools, "run_xdr_action", fake_run)

    out = asyncio.run(xdr_tools.query_xdr_alert_stats())
    assert out["ok"] is False
    assert out["error"]["type"] == "invalid_params"
    assert "group_name" in out["error"]["message"]

    out = asyncio.run(xdr_tools.query_xdr_alert_stats(group_id=41, time_field="createTime"))
    assert out["ok"] is False
    assert "time_field" in out["error"]["message"]

    out = asyncio.run(
        xdr_tools.query_xdr_alert_stats(group_id=41, start_timestamp="not-a-date")
    )
    assert out["ok"] is False
    assert "time_range" in out["error"]["message"]

    out = asyncio.run(
        xdr_tools.query_xdr_alert_stats(group_id=41, start_timestamp=200, end_timestamp=100)
    )
    assert out["ok"] is False
    assert "time_range" in out["error"]["message"]
    assert called == []


def test_query_xdr_alert_stats_group_not_found(monkeypatch):
    """资产组未命中：返回全量资产组清单供自纠错。"""
    _fake_branch_and_trends(monkeypatch)
    out = asyncio.run(xdr_tools.query_xdr_alert_stats(group_name="不存在的组"))

    assert out["ok"] is False and out["matched"] is False
    assert out["error"]["type"] == "group_not_found"
    assert {g["id"] for g in out["available_groups"]} == {1, 41, 42, 43, 44, 45}


def test_query_xdr_alert_stats_upstream_errors(monkeypatch):
    """branchlist 失败 / trends 失败均透传结构化错误。"""

    async def failing_branchlist(action_key, params=None, device_id=None, **kwargs):
        if action_key == "xdr_bigscreen_branchlist":
            return {"ok": False, "error": {"type": "auth_error", "message": "签名失败"}}
        raise AssertionError("trends 不应被调用")

    monkeypatch.setattr(xdr_tools, "run_xdr_action", failing_branchlist)
    out = asyncio.run(xdr_tools.query_xdr_alert_stats(group_id=41))
    assert out["ok"] is False and out["matched"] is False
    assert out["error"]["type"] == "auth_error"

    _fake_branch_and_trends(monkeypatch, trends_ok=False)
    out = asyncio.run(xdr_tools.query_xdr_alert_stats(group_id=41))
    assert out["ok"] is False and out["matched"] is True
    assert out["error"]["type"] == "server_error"
