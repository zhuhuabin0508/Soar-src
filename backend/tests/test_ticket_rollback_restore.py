"""工单回退回显单元测试：``_rollback_restore_values`` 纯函数口径。

覆盖需求场景：
- 正常回退：退回节点复用该节点上次提交的字段值
- 带附件回退：file 字段 URL 原样保留
- 多字段组合回退：text/select/datetime/textarea/file/switch 全类型保留
- 非回退场景（正常流转/首次进入）不回显
- 白名单退回更早节点、连续多轮回退取最近一次提交
- 当前节点字段定义中已不存在的 key 不回带
"""
import os
import sys
from types import SimpleNamespace

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.api.v1.tickets import _rollback_restore_values


def _rec(rid, node_key, action, route_to, field_values=None):
    return SimpleNamespace(
        id=rid, node_key=node_key, action=action,
        route_to=route_to, field_values=field_values or {},
    )


NODE_A = {
    "key": "n_a",
    "name": "研判分析",
    "type": "task",
    "fields": [
        {"key": "conclusion", "label": "研判结论", "type": "text", "required": True},
        {"key": "level", "label": "风险等级", "type": "select", "options": ["高", "中", "低"]},
    ],
}


def test_rollback_restores_last_submit_values():
    records = [
        _rec(1, "n_a", "create", "n_b", {"conclusion": "疑似攻击", "level": "高"}),
        _rec(2, "n_b", "submit", "end", {"result": "已处置"}),
        _rec(3, "n_b", "rollback", "n_a"),
    ]
    assert _rollback_restore_values(NODE_A, records) == {"conclusion": "疑似攻击", "level": "高"}


def test_rollback_with_attachment_keeps_file_url():
    node = {
        "key": "n_a",
        "fields": [
            {"key": "evidence", "label": "附件", "type": "file"},
            {"key": "note", "label": "富文本", "type": "textarea"},
        ],
    }
    url = "/api/v1/tickets/attachments/2026/10/21/abc.png"
    records = [
        _rec(1, "n_a", "submit", "n_b", {"evidence": url, "note": "见截图\n第二行"}),
        _rec(2, "n_b", "rollback", "n_a"),
    ]
    assert _rollback_restore_values(node, records) == {"evidence": url, "note": "见截图\n第二行"}


def test_rollback_restores_multi_field_types():
    node = {
        "key": "n_a",
        "fields": [
            {"key": "text", "type": "text"},
            {"key": "select", "type": "select"},
            {"key": "datetime", "type": "datetime"},
            {"key": "textarea", "type": "textarea"},
            {"key": "file", "type": "file"},
            {"key": "switch", "type": "switch"},
            {"key": "number", "type": "number"},
            {"key": "ip", "type": "ip"},
        ],
    }
    values = {
        "text": "a", "select": "高", "datetime": "2026-10-21T10:30",
        "textarea": "多行\n内容", "file": "/api/v1/tickets/attachments/x.pdf",
        "switch": True, "number": "42", "ip": "192.168.1.10",
    }
    records = [
        _rec(1, "n_a", "submit", "n_b", values),
        _rec(2, "n_b", "rollback", "n_a"),
    ]
    assert _rollback_restore_values(node, records) == values


def test_no_restore_on_normal_flow():
    # 正常流转进入 n_a：最近一次到达记录是 submit，不回显
    records = [
        _rec(1, "n_a", "submit", "n_b", {"conclusion": "x"}),
        _rec(2, "n_b", "submit", "n_a", {}),
    ]
    assert _rollback_restore_values(NODE_A, records) is None


def test_no_restore_on_first_entry():
    records = [_rec(1, "n_a", "create", "n_b", {"conclusion": "x"})]
    assert _rollback_restore_values(NODE_A, records) is None


def test_restore_ignores_interleaved_comments():
    records = [
        _rec(1, "n_a", "submit", "n_b", {"conclusion": "初判"}),
        _rec(2, "n_b", "rollback", "n_a"),
        _rec(3, "n_a", "comment", None, {}),
    ]
    assert _rollback_restore_values(NODE_A, records) == {"conclusion": "初判"}


def test_restore_whitelist_earlier_node_and_latest_submit():
    # 二次回退：取退回节点最近一次提交（而非更早的历史提交）
    records = [
        _rec(1, "n_a", "submit", "n_b", {"conclusion": "第一次"}),
        _rec(2, "n_b", "rollback", "n_a"),
        _rec(3, "n_a", "submit", "n_c", {"conclusion": "第二次"}),
        _rec(4, "n_c", "rollback", "n_a"),
    ]
    assert _rollback_restore_values(NODE_A, records) == {"conclusion": "第二次"}


def test_restore_drops_fields_removed_from_node_definition():
    records = [
        _rec(1, "n_a", "submit", "n_b", {"conclusion": "x", "legacy": "旧字段"}),
        _rec(2, "n_b", "rollback", "n_a"),
    ]
    assert _rollback_restore_values(NODE_A, records) == {"conclusion": "x"}


def test_restore_rule_extension_fields():
    node = {
        "key": "n_a",
        "fields": [{
            "key": "need_handle", "type": "select", "options": ["是", "否"],
            "rules": [{"value": "是", "fields": [{"key": "handle_advice", "type": "textarea"}]}],
        }],
    }
    records = [
        _rec(1, "n_a", "submit", "n_b", {"need_handle": "是", "handle_advice": "建议封禁"}),
        _rec(2, "n_b", "rollback", "n_a"),
    ]
    assert _rollback_restore_values(node, records) == {
        "need_handle": "是", "handle_advice": "建议封禁",
    }
