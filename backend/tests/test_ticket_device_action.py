import os
import sys

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.ticket_device_action import _duration_to_ban, judge_says_execute, prepare_device_params
from app.core.ticket_flow import validate_flow_structure, when_matches


def _flow(node_extra=None, node_type="task"):
    node = {
        "key": "n1",
        "name": "处置",
        "type": node_type,
        "group_id": 1,
        "fields": [],
        "routes": [{"to": "end", "when": None}],
    }
    if node_type == "parallel":
        node["sign_groups"] = [1, 2]
        node["finish_policy"] = "all"
        node.pop("group_id", None)
    if node_extra:
        node.update(node_extra)
    return {
        "start_groups": [1],
        "nodes": [
            node,
            {"key": "end", "name": "结束", "type": "end", "fields": [], "routes": []},
        ],
    }


def test_prepare_params_fills_default_and_rejects_unknown():
    schema = [
        {"name": "ip", "type": "string", "required": True},
        {"name": "duration", "type": "string", "required": False, "default": "-1"},
        {"name": "enable", "type": "enum", "required": False, "default": "1", "options": ["1", "0"]},
    ]
    params, errors = prepare_device_params(schema, {"ip": "1.2.3.4", "extra": "x"})
    assert any("extra" in e for e in errors)
    assert params["ip"] == "1.2.3.4"
    assert params["duration"] == "-1"
    assert params["enable"] == "1"


def test_prepare_params_requires_missing():
    schema = [{"name": "ip", "type": "string", "required": True, "description": "封禁对象"}]
    params, errors = prepare_device_params(schema, {})
    assert params == {}
    assert any("必填" in e for e in errors)


def test_duration_permanent_and_seconds():
    assert _duration_to_ban("-1") == (True, 0)
    assert _duration_to_ban("0") == (True, 0)
    assert _duration_to_ban("永久") == (True, 0)
    assert _duration_to_ban("3600") == (False, 3600)
    assert _duration_to_ban("30天")[0] is False
    assert _duration_to_ban("30天")[1] == 30 * 86400


def test_flow_rejects_parallel_and_missing_action():
    errors = validate_flow_structure(
        _flow({"device_action": {"device_id": 1, "action_id": 2}}, node_type="parallel"),
        group_ok=lambda _gid: True,
    )
    assert any("会签节点不能绑定设备动作" in e for e in errors)

    errors = validate_flow_structure(
        _flow({"device_action": {"device_id": "", "action_id": ""}}),
        group_ok=lambda _gid: True,
    )
    assert any("未选择设备" in e for e in errors)


def test_judge_says_execute_follows_prior_switch():
    item = {"judge_field": "go", "judge_value": "是"}
    assert judge_says_execute(item, {"go": True}) is True
    assert judge_says_execute(item, {"go": "否"}) is False
    assert judge_says_execute(item, {}) is False
    assert when_matches(None, {"need": "否"}) is True
    when = {"logic": "and", "conds": [{"field": "need", "op": "eq", "value": "是"}]}
    assert when_matches(when, {"need": "否"}) is False
    assert when_matches(when, {"need": "是"}) is True


def test_flow_device_action_uses_prior_judge():
    flow = {
        "start_groups": [1],
        "nodes": [
            {
                "key": "judge",
                "name": "判断",
                "type": "task",
                "group_id": 1,
                "fields": [{"key": "go", "label": "是否执行", "type": "switch"}],
                "routes": [{"to": "exec", "when": None}],
            },
            {
                "key": "exec",
                "name": "执行",
                "type": "task",
                "group_id": 1,
                "fields": [],
                "device_actions": [{
                    "device_id": 1,
                    "action_id": 2,
                    "judge_field": "go",
                    "judge_value": "是",
                }],
                "routes": [{"to": "end", "when": None}],
            },
            {"key": "end", "name": "结束", "type": "end", "fields": [], "routes": []},
        ],
    }
    errors = validate_flow_structure(flow, group_ok=lambda _gid: True, device_ok=lambda _d, _a: None)
    assert errors == []

    # 新语义：判断字段也可以是本节点自己的字段（处理人填写实时联动）
    same_node = _flow({
        "fields": [{"key": "go", "label": "是否执行", "type": "switch"}],
        "device_actions": [{"device_id": 1, "action_id": 2, "judge_field": "go", "judge_value": "是"}],
    })
    errors = validate_flow_structure(same_node, group_ok=lambda _gid: True, device_ok=lambda _d, _a: None)
    assert errors == []


def test_flow_accepts_judge_field_on_same_node():
    # 判断字段为本节点字段：合法（填写命中建议执行值时调用设备）
    errors = validate_flow_structure(
        _flow({
            "fields": [{"key": "need", "label": "是否处置", "type": "select", "options": ["是", "否"]}],
            "device_action": {"device_id": 3, "action_id": 9, "judge_field": "need", "judge_value": "是"},
        }),
        group_ok=lambda _gid: True,
        device_ok=lambda _d, _a: None,
    )
    assert errors == []

    # 判断字段为本节点字段但建议执行值不在可选项中：应报错
    errors = validate_flow_structure(
        _flow({
            "fields": [{"key": "need", "label": "是否处置", "type": "select", "options": ["是", "否"]}],
            "device_action": {"device_id": 3, "action_id": 9, "judge_field": "need", "judge_value": "可能"},
        }),
        group_ok=lambda _gid: True,
        device_ok=lambda _d, _a: None,
    )
    assert any("可选项" in e for e in errors)


def test_flow_device_ok_callback():
    errors = validate_flow_structure(
        _flow({"device_action": {"device_id": 3, "action_id": 9, "judge_field": "go", "judge_value": "是"}}),
        group_ok=lambda _gid: True,
        device_ok=lambda _d, _a: "设备不存在或已禁用",
    )
    assert any("设备不存在或已禁用" in e for e in errors)

    flow = {
        "start_groups": [1],
        "nodes": [
            {
                "key": "judge", "name": "判断", "type": "task", "group_id": 1,
                "fields": [{"key": "go", "label": "是否执行", "type": "switch"}],
                "routes": [{"to": "exec", "when": None}],
            },
            {
                "key": "exec", "name": "执行", "type": "task", "group_id": 1, "fields": [],
                "device_action": {"device_id": 3, "action_id": 9, "judge_field": "go", "judge_value": "是"},
                "routes": [{"to": "end", "when": None}],
            },
            {"key": "end", "name": "结束", "type": "end", "fields": [], "routes": []},
        ],
    }
    errors = validate_flow_structure(flow, group_ok=lambda _gid: True, device_ok=lambda _d, _a: None)
    assert errors == []
