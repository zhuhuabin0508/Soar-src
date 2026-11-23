"""ticket_analyst 输出契约适配器单测（纯函数，无 DB）。"""
import json

import pytest

from app.platform.agent_runtime import (
    OUTPUT_MODE_TICKET_ANALYST,
    adapt_ticket_analyst,
    resolve_output_mode,
)
from app.workflow.agent_client import AgentCallError

REASONS = [
    "【处置建议】立即封禁该 IP 24 小时（边界防火墙入向 + 出口出向）。",
    "【监测要点】监测其入向 80/443 端口高频请求与并发突增。",
    "【情报现状与触发条件】当前判定恶意（severity=high）；若状态转为活跃需重新研判。",
    "【责任归属】境外地址，无内部资产归属。",
    "【协同处置】通知责任部门复核同工单其他关联 IP。",
]
VALID = {"risk_level": "高危", "action": "ban", "reasons": REASONS}


class TestAdaptTicketAnalyst:
    def test_valid_plain_json(self):
        out = adapt_ticket_analyst(json.dumps(VALID, ensure_ascii=False))
        assert out == VALID

    def test_valid_wrapped_in_text(self):
        content = f"研判结果如下：\n```json\n{json.dumps(VALID, ensure_ascii=False)}\n```\n请查收"
        out = adapt_ticket_analyst(content)
        assert out == VALID

    def test_missing_field(self):
        for missing in ("risk_level", "action", "reasons"):
            data = {k: v for k, v in VALID.items() if k != missing}
            with pytest.raises(AgentCallError, match="缺少必填字段"):
                adapt_ticket_analyst(json.dumps(data, ensure_ascii=False))

    def test_illegal_risk_level(self):
        data = {**VALID, "risk_level": "超级危险"}
        with pytest.raises(AgentCallError, match="risk_level 非法"):
            adapt_ticket_analyst(json.dumps(data, ensure_ascii=False))

    def test_illegal_action(self):
        data = {**VALID, "action": "block"}
        with pytest.raises(AgentCallError, match="action 非法"):
            adapt_ticket_analyst(json.dumps(data, ensure_ascii=False))

    def test_reasons_not_list(self):
        with pytest.raises(AgentCallError, match="reasons"):
            adapt_ticket_analyst(json.dumps({**VALID, "reasons": "黑名单命中"}, ensure_ascii=False))

    def test_reasons_empty_list(self):
        with pytest.raises(AgentCallError, match="reasons"):
            adapt_ticket_analyst(json.dumps({**VALID, "reasons": []}, ensure_ascii=False))

    def test_reasons_blank_stripped(self):
        data = {**VALID, "reasons": ["  ", *REASONS]}
        out = adapt_ticket_analyst(json.dumps(data, ensure_ascii=False))
        assert out["reasons"] == REASONS

    def test_missing_module_rejected(self):
        data = {**VALID, "reasons": REASONS[:4]}
        with pytest.raises(AgentCallError, match="缺少 5 要素模块"):
            adapt_ticket_analyst(json.dumps(data, ensure_ascii=False))

    def test_module_order_rejected(self):
        data = {**VALID, "reasons": [REASONS[1], REASONS[0], *REASONS[2:]]}
        with pytest.raises(AgentCallError, match="缺少 5 要素模块"):
            adapt_ticket_analyst(json.dumps(data, ensure_ascii=False))

    def test_reasons_preserved_verbatim(self):
        padded = [f"  {r} \n" for r in REASONS]
        data = {**VALID, "reasons": padded}
        out = adapt_ticket_analyst(json.dumps(data, ensure_ascii=False))
        assert out["reasons"] == padded

    def test_extra_fields_stripped(self):
        data = {**VALID, "monitoring_advice": "观察", "confidence": 0.9}
        out = adapt_ticket_analyst(json.dumps(data, ensure_ascii=False))
        assert set(out) == {"risk_level", "action", "reasons"}

    def test_non_json(self):
        with pytest.raises(AgentCallError, match="JSON 解析失败"):
            adapt_ticket_analyst("这不是JSON")

    def test_empty_content(self):
        with pytest.raises(AgentCallError, match="响应为空"):
            adapt_ticket_analyst("")

    def test_not_object(self):
        with pytest.raises(AgentCallError, match="不是 JSON 对象"):
            adapt_ticket_analyst("[1,2,3]")

    def test_whitespace_normalized(self):
        data = {**VALID, "risk_level": " 高危 ", "action": " ban "}
        out = adapt_ticket_analyst(json.dumps(data, ensure_ascii=False))
        assert out == {"risk_level": "高危", "action": "ban", "reasons": REASONS}


class TestOutputModeResolution:
    def test_agent_output_mode_resolved(self):
        import types

        agent = types.SimpleNamespace(output_mode=OUTPUT_MODE_TICKET_ANALYST)
        assert resolve_output_mode(agent) == "ticket_analyst"
        # 非法值回退 chat
        assert resolve_output_mode(types.SimpleNamespace(output_mode="xxx")) == "chat"

    def test_agents_api_normalize(self):
        from app.api.v1.agents import _normalize_output_mode

        assert _normalize_output_mode("ticket_analyst", default="chat") == "ticket_analyst"
        assert _normalize_output_mode(None, default="ticket_analyst") == "ticket_analyst"
        assert _normalize_output_mode("bad", default="ticket_analyst") == "ticket_analyst"
