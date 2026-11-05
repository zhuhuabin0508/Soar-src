import json
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.ticket_device_action import (
    MAX_DEVICE_DURATION_SECONDS, _duration_to_ban, ban_record_reason, build_device_action_form,
    build_field_context, execute_prepared_runs, finalize_device_params, judge_says_execute,
    normalized_param_config, prepare_device_params, resolve_param_template,
)
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


def test_prepare_params_duration_type_converts_human_values():
    """duration 类型参数：人类可读时长（永久/3天/45分钟/秒数）→ 设备侧取值（-1/秒数字符串）。"""
    schema = [{"name": "duration", "type": "duration", "required": True, "description": "封禁时长"}]
    # 人类可读 → 秒数
    params, errors = prepare_device_params(schema, {"duration": "3天"})
    assert not errors and params["duration"] == str(3 * 86400)
    params, _ = prepare_device_params(schema, {"duration": "45分钟"})
    assert params["duration"] == "2700"
    params, _ = prepare_device_params(schema, {"duration": "1.5小时"})
    assert params["duration"] == "5400"
    # 永久语义（多种写法）→ -1
    for raw in ("永久", "-1", "0", 0):
        params, _ = prepare_device_params(schema, {"duration": raw})
        assert params["duration"] == "-1", raw
    # 纯秒数原样（字符串化）
    params, _ = prepare_device_params(schema, {"duration": 300})
    assert params["duration"] == "300"
    # 非法格式拒绝
    params, errors = prepare_device_params(schema, {"duration": "abc"})
    assert params == {} and any("时长格式无法识别" in e for e in errors)


def test_prepare_params_string_duration_and_upper_limit():
    """schema 标成 string 的 duration 参数同样归一，并按 max / 全局兜底校验上限。"""
    schema = [{"name": "duration", "type": "string", "required": False, "default": "-1", "max": 2592000}]
    params, errors = prepare_device_params(schema, {"duration": "3天"})
    assert not errors and params["duration"] == str(3 * 86400)
    params, errors = prepare_device_params(schema, {"duration": "2592001"})
    assert params == {} and any("超出上限 2592000 秒" in e for e in errors)
    # 未配置 max 时使用全局兜底上限
    schema_no_max = [{"name": "duration", "type": "string", "required": False}]
    params, errors = prepare_device_params(schema_no_max, {"duration": str(MAX_DEVICE_DURATION_SECONDS + 1)})
    assert params == {} and any("超出上限" in e for e in errors)
    # -1 永久不受上限影响
    params, errors = prepare_device_params(schema, {"duration": "-1"})
    assert not errors and params["duration"] == "-1"


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


def test_flow_param_presets_validation():
    """参数快捷选项（param_presets）：结构合法通过；缺 label/value 或格式错误报错。"""
    base_fields = [{"key": "need", "label": "是否处置", "type": "select", "options": ["是", "否"]}]

    def make(presets):
        return _flow({
            "fields": base_fields,
            "device_action": {
                "device_id": 3, "action_id": 9, "judge_field": "need", "judge_value": "是",
                "param_presets": presets,
            },
        })

    ok_kw = dict(group_ok=lambda _gid: True, device_ok=lambda _d, _a: None)

    # 合法：多参数、表达式/数值/负值混合
    errors = validate_flow_structure(make({
        "duration": [
            {"label": "3天", "value": "3*24*3600"},
            {"label": "7天", "value": 604800},
            {"label": "永久", "value": -1},
        ],
        "reason": [{"label": "攻击行为", "value": "attack"}],
    }), **ok_kw)
    assert errors == []

    # 未配置实际值
    errors = validate_flow_structure(make({"duration": [{"label": "3天"}]}), **ok_kw)
    assert any("未配置实际值" in e for e in errors)

    # 未命名快捷选项
    errors = validate_flow_structure(make({"duration": [{"value": 300}]}), **ok_kw)
    assert any("未命名" in e for e in errors)

    # 快捷选项不是数组
    errors = validate_flow_structure(make({"duration": "3天"}), **ok_kw)
    assert any("必须为非空数组" in e for e in errors)

    # 整体不是对象
    errors = validate_flow_structure(make(["3天"]), **ok_kw)
    assert any("必须为对象" in e for e in errors)


def test_flow_param_config_validation():
    """参数配置（param_config）：三种展示方式合法通过；非法 display / 超长模板 / 格式错误报错。"""
    base_fields = [{"key": "need", "label": "是否处置", "type": "select", "options": ["是", "否"]}]

    def make(cfg):
        return _flow({
            "fields": base_fields,
            "device_action": {
                "device_id": 3, "action_id": 9, "judge_field": "need", "judge_value": "是",
                "param_config": cfg,
            },
        })

    ok_kw = dict(group_ok=lambda _gid: True, device_ok=lambda _d, _a: None)

    # 合法：只读 + 变量模板 / 隐藏 / 可编辑
    errors = validate_flow_structure(make({
        "reason": {"display": "readonly", "default_template": "工单同步：{ticket_no}"},
        "enable": {"display": "hidden", "default_template": "true"},
        "duration": {"display": "editable"},
    }), **ok_kw)
    assert errors == []

    # 非法展示方式
    errors = validate_flow_structure(make({"reason": {"display": "fixed"}}), **ok_kw)
    assert any("展示方式须为 可编辑/只读/隐藏" in e for e in errors)

    # 超长模板
    errors = validate_flow_structure(make({"reason": {"display": "readonly", "default_template": "x" * 201}}), **ok_kw)
    assert any("不能超过 200" in e for e in errors)

    # 条目不是对象
    errors = validate_flow_structure(make({"reason": "readonly"}), **ok_kw)
    assert any("配置必须为对象" in e for e in errors)

    # 整体不是对象
    errors = validate_flow_structure(make(["reason"]), **ok_kw)
    assert any("参数配置必须为对象" in e for e in errors)


def test_resolve_param_template():
    """默认值模板变量解析：工单上下文替换、{f:字段} 取值、未知占位符保留、解析不到置空。"""
    ctx = {
        "ticket_no": "TK-20261103-0030",
        "ticket_title": "暴力破解",
        "creator": "张三",
        "node": "处置",
        "field_values": {"src_ip": "1.2.3.4"},
    }
    assert resolve_param_template("工单同步：{ticket_no}", ctx) == "工单同步：TK-20261103-0030"
    assert resolve_param_template("{f:src_ip} by {creator}", ctx) == "1.2.3.4 by 张三"
    assert resolve_param_template("{node}-{ticket_title}", ctx) == "处置-暴力破解"
    # 未识别的占位符原样保留；解析不到值的置空
    assert resolve_param_template("{unknown_var}", ctx) == "{unknown_var}"
    assert resolve_param_template("{f:not_exist}", ctx) == ""
    assert resolve_param_template("plain text", ctx) == "plain text"
    assert resolve_param_template(None, ctx) == ""
    assert resolve_param_template("{ticket_no}", None) == ""


def test_normalized_param_config():
    """param_config 归一化：非法 display / 非对象条目剔除，超长模板截断 200。"""
    assert normalized_param_config(None) == {}
    assert normalized_param_config({"param_config": None}) == {}
    assert normalized_param_config({"param_config": {
        "reason": {"display": "readonly", "default_template": "工单同步：{ticket_no}"},
    }}) == {"reason": {"display": "readonly", "default_template": "工单同步：{ticket_no}"}}
    # 非法 display / 非对象条目 / 空参数名 → 剔除
    assert normalized_param_config({"param_config": {
        "a": {"display": "fixed"},
        "b": "readonly",
        "": {"display": "hidden"},
        "c": {"display": "hidden"},
    }}) == {"c": {"display": "hidden"}}
    # 模板截断 200
    out = normalized_param_config({"param_config": {"a": {"display": "readonly", "default_template": "x" * 300}}})
    assert len(out["a"]["default_template"]) == 200


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


# ===== 设备动作修复回归 =====

def _fake_action(action_type, schema):
    return SimpleNamespace(
        id=2,
        name="动作",
        action_type=action_type,
        enabled=True,
        params_schema=json.dumps(schema),
        http_method="POST",
    )


def _device():
    return SimpleNamespace(id=1, name="设备", enabled=True)


def _patch_resolve(monkeypatch, action):
    import app.core.ticket_device_action as mod

    monkeypatch.setattr(mod, "resolve_device_action", lambda db, cfg: (_device(), action, None))


def test_block_reason_builtin_hidden_only_for_block_ip(monkeypatch):
    schema = [{"name": "reason", "type": "string", "required": True, "label": "封禁原因"}]
    node = {"device_actions": [{"device_id": 1, "action_id": 2}]}

    _patch_resolve(monkeypatch, _fake_action("block_ip", schema))
    item = build_device_action_form(None, node)["items"][0]
    reason = item["params"][0]
    assert reason["display"] == "hidden"
    assert reason["default_template"] == "工单同步：{ticket_no}"

    # 显式可编辑覆盖内置隐藏，且不带模板
    cfg = {"device_id": 1, "action_id": 2, "param_config": {"reason": {"display": "editable"}}}
    _patch_resolve(monkeypatch, _fake_action("block_ip", schema))
    reason = build_device_action_form(None, {"device_actions": [cfg]})["items"][0]["params"][0]
    assert reason["display"] == "editable"
    assert "default_template" not in reason

    # 只配置了只读/隐藏、未配置模板时，仍回填内置「工单同步」默认值
    for display in ("readonly", "hidden"):
        cfg = {"device_id": 1, "action_id": 2, "param_config": {"reason": {"display": display}}}
        _patch_resolve(monkeypatch, _fake_action("block_ip", schema))
        reason = build_device_action_form(None, {"device_actions": [cfg]})["items"][0]["params"][0]
        assert reason["display"] == display
        assert reason["default_template"] == "工单同步：{ticket_no}"

    # 解封/查询动作的 reason 不接管
    _patch_resolve(monkeypatch, _fake_action("unblock_ip", schema))
    reason = build_device_action_form(None, node)["items"][0]["params"][0]
    assert reason["display"] == "editable"
    assert "default_template" not in reason


def test_finalize_readonly_reason_ignores_client_value():
    item = {"action_type": "block_ip", "params": [{
        "name": "reason", "type": "string", "required": True, "description": "封禁原因",
        "display": "readonly", "default_template": "工单同步：{ticket_no}",
    }]}
    params, errors = finalize_device_params(
        item, {"reason": "手工改原因"}, ctx={"ticket_no": "TK-1"},
    )
    assert errors == []
    assert params == {"reason": "工单同步：TK-1"}


def test_finalize_editable_template_and_overridden():
    item = {"params": [{
        "name": "ip", "type": "ip", "required": True, "description": "目标 IP",
        "display": "editable", "default_template": "{f:src_ip}",
    }]}
    ctx = {"ticket_no": "TK", "field_values": {"src_ip": "1.1.1.1"}}

    # 未手改：按本次字段值重算模板，不用请求里的旧值
    params, errors = finalize_device_params(item, {"ip": "9.9.9.9"}, ctx=ctx)
    assert errors == []
    assert params["ip"] == "1.1.1.1"

    # 手改：保留用户输入，其他字段变化也不覆盖
    params, errors = finalize_device_params(
        item, {"ip": "9.9.9.9"}, overridden=["ip"], ctx={"field_values": {"src_ip": "2.2.2.2"}},
    )
    assert errors == []
    assert params["ip"] == "9.9.9.9"


def test_finalize_hidden_template_and_falsy_values():
    item = {"params": [
        {"name": "ip", "type": "ip", "required": True, "display": "hidden",
         "default_template": "{f:src_ip}"},
        {"name": "enable", "type": "enum", "required": False, "default": "1",
         "options": ["1", "0"], "display": "editable"},
        {"name": "n", "type": "number", "required": False, "default": 5, "display": "editable"},
    ]}
    params, errors = finalize_device_params(
        item, {"ip": "9.9.9.9", "enable": 0, "n": False},
        ctx={"field_values": {"src_ip": "3.3.3.3"}},
    )
    assert errors == []
    # 隐藏参数忽略请求值；0 / False 按出现值保留，不被默认值替代
    assert params == {"ip": "3.3.3.3", "enable": 0, "n": False}


def test_finalize_required_template_empty_reports_param():
    item = {"device_name": "设备", "action_name": "封禁", "params": [{
        "name": "ip", "type": "ip", "required": True, "display": "hidden",
        "default_template": "{f:src_ip}",
    }]}
    params, errors = finalize_device_params(item, {}, ctx={"field_values": {}})
    assert params == {}
    assert errors and "必填" in errors[0] and "ip" in errors[0]


def test_field_context_uses_submitted_falsy_values():
    records = [{"field_values": {"src_ip": "1.1.1.1", "n": 5, "flag": True}}]
    ctx = build_field_context(records, {"src_ip": "", "n": 0, "flag": False})
    # 本次提交按 key 出现覆盖历史值：空串 / 0 / False 都生效
    assert ctx["src_ip"] == ""
    assert ctx["n"] == 0
    assert ctx["flag"] is False
    assert resolve_param_template("ip={f:src_ip}", {"field_values": ctx}) == "ip="
    assert resolve_param_template("{f:n}", {"field_values": ctx}) == "0"


def test_ban_record_reason_matches_device_reason():
    assert ban_record_reason({"reason": "手工原因"}, "TK-1") == "手工原因"
    assert ban_record_reason({}, "TK-1") == "工单同步：TK-1"


def _run_item(index, params, action_id=2):
    return {
        "index": index, "device_id": 1, "action_id": action_id,
        "device_name": "设备", "action_name": "动作", "params": params,
    }


def _fake_executor(monkeypatch, calls):
    from app.devices import action_executor

    def fake_execute(*args, **kwargs):
        calls.append(1)
        return {"success": True, "status_code": 200, "response_body": "ok", "error": None, "latency_ms": 1}

    monkeypatch.setattr(action_executor, "execute_device_action", fake_execute)


def test_no_device_call_until_all_params_valid(monkeypatch):
    calls = []
    _fake_executor(monkeypatch, calls)
    _patch_resolve(monkeypatch, _fake_action("block_ip", [{
        "name": "ip", "type": "ip", "required": True, "description": "目标 IP",
    }]))
    items = [
        _run_item(0, [{"name": "ip", "type": "ip", "required": True, "display": "editable"}]),
        _run_item(1, [{"name": "ip", "type": "ip", "required": True, "display": "editable"}]),
    ]
    runs = {0: {"params": {"ip": "1.2.3.4"}}, 1: {"params": {"ip": "not-an-ip"}}}

    outcomes, errors = execute_prepared_runs(None, items, runs, {"field_values": {}}, user_id=None)

    assert outcomes == []
    assert errors and "not-an-ip" in "；".join(errors)
    assert len(calls) == 0


def test_no_device_call_when_required_template_empty(monkeypatch):
    calls = []
    _fake_executor(monkeypatch, calls)
    _patch_resolve(monkeypatch, _fake_action("block_ip", [{
        "name": "ip", "type": "ip", "required": True, "description": "目标 IP",
    }]))
    items = [
        _run_item(0, [{"name": "ip", "type": "ip", "required": True, "display": "editable"}]),
        _run_item(1, [{"name": "ip", "type": "ip", "required": True, "display": "hidden",
                       "default_template": "{f:src_ip}"}]),
    ]
    runs = {0: {"params": {"ip": "1.2.3.4"}}, 1: {"params": {}}}

    outcomes, errors = execute_prepared_runs(None, items, runs, {"field_values": {}}, user_id=None)

    assert outcomes == []
    assert errors and "ip" in "；".join(errors)
    assert len(calls) == 0


def test_valid_params_execute_each_action_once(monkeypatch):
    calls = []
    _fake_executor(monkeypatch, calls)
    _patch_resolve(monkeypatch, _fake_action("block_ip", [{
        "name": "ip", "type": "ip", "required": True, "description": "目标 IP",
    }]))
    items = [
        _run_item(0, [{"name": "ip", "type": "ip", "required": True, "display": "editable"}]),
        _run_item(1, [{"name": "ip", "type": "ip", "required": True, "display": "editable"}]),
    ]
    runs = {0: {"params": {"ip": "1.2.3.4"}}, 1: {"params": {"ip": "5.6.7.8"}}}

    outcomes, errors = execute_prepared_runs(None, items, runs, {"field_values": {}}, user_id=None)

    assert errors == []
    assert len(outcomes) == 2
    assert len(calls) == 2


def test_strip_legacy_ban_sync_keeps_action_fields():
    from app.api.v1.ticket_flows import _strip_legacy_ban_sync

    payload = {
        "start_groups": [1],
        "nodes": [
            {
                "key": "n1", "id": "da1", "when": {"logic": "and", "conds": []},
                "params": {"ip": "src_ip"}, "ban_sync": {"ip_field": "src_ip"},
            },
            {"key": "end"},
        ],
    }
    out = _strip_legacy_ban_sync(payload)
    node = out["nodes"][0]
    assert "ban_sync" not in node
    assert node["id"] == "da1" and node["when"] == {"logic": "and", "conds": []}
    assert node["params"] == {"ip": "src_ip"}
