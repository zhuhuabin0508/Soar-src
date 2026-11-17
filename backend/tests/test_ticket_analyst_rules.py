"""工单研判规则注册表单测（纯函数，无 DB）。"""
import pytest

from app.core.ticket_analyst.rules import (
    ACTIONS,
    MULTI_SOURCE_THRESHOLD,
    RULES,
    RISK_LEVELS,
    evaluate_rules,
    render_guidelines,
    rules_version,
)


def _ctx(**overrides):
    """最小可用上下文：全维度无命中（触发兜底）。"""
    ctx = {
        "ip": "1.2.3.4",
        "roles": ["src_ip"],
        "title": "测试工单",
        "blacklist": {"records": [], "degraded": False},
        "whitelist": {"hit": False, "match_type": None, "entries": [], "degraded": False},
        "ip_library": {"matches": [], "degraded": False},
        "asset": None,
        "threat": None,
        "ti_360": None,
    }
    ctx.update(overrides)
    return ctx


class TestEvaluateRules:
    def test_no_hit_fallback(self):
        hits = evaluate_rules(_ctx())
        assert [h["rule_id"] for h in hits] == ["no_hit_fallback"]
        assert hits[0]["level_hint"] == "低"
        assert hits[0]["action_hint"] == "monitor"

    def test_all_dims_missing_tolerated(self):
        """维度为 None/缺失不得抛异常，按未命中兜底。"""
        ctx = _ctx(blacklist=None, whitelist=None, ip_library=None)
        ctx.pop("threat")
        ctx.pop("asset")
        ctx.pop("ti_360")
        hits = evaluate_rules(ctx)
        assert [h["rule_id"] for h in hits] == ["no_hit_fallback"]

    def test_blacklist_hit(self):
        ctx = _ctx(blacklist={"records": [{
            "ban_level": "serious", "source": "manual",
            "violation_count": 3, "expired_at": "2099-01-01 00:00:00", "reason": "恶意扫描",
        }], "degraded": False})
        hits = evaluate_rules(ctx)
        ids = [h["rule_id"] for h in hits]
        assert "blacklist_hit" in ids
        hit = next(h for h in hits if h["rule_id"] == "blacklist_hit")
        assert hit["level_hint"] == "严重"
        assert hit["action_hint"] == "ban"
        assert hit["malicious_signal"] is True
        assert "serious" in hit["evidence"]

    def test_whitelist_hit(self):
        ctx = _ctx(whitelist={"hit": True, "match_type": "exact",
                              "entries": [{"wlist": "1.2.3.4"}], "degraded": False})
        hits = evaluate_rules(ctx)
        hit = next(h for h in hits if h["rule_id"] == "whitelist_hit")
        assert hit["level_hint"] == "低"
        assert hit["action_hint"] == "ignore"
        assert "1.2.3.4" in hit["evidence"]

    def test_whitelist_and_blacklist_conflict_both_evidenced(self):
        """白名单与黑名单同时命中：两条证据都给出（优先级白名单在前），由 LLM 综合。"""
        ctx = _ctx(
            blacklist={"records": [{"ban_level": "high", "source": "manual",
                                    "violation_count": 1, "expired_at": "2099-01-01", "reason": ""}],
                       "degraded": False},
            whitelist={"hit": True, "match_type": "exact", "entries": [{"wlist": "1.2.3.4"}], "degraded": False},
        )
        ids = [h["rule_id"] for h in evaluate_rules(ctx)]
        assert ids.index("whitelist_hit") < ids.index("blacklist_hit")

    def test_ti_malicious_via_yunaq(self):
        ctx = _ctx(threat={"is_malicious": True, "severity": "high",
                           "confidence": 0.85, "tags": ["僵尸网络"], "source": "知道创宇"})
        hits = evaluate_rules(ctx)
        hit = next(h for h in hits if h["rule_id"] == "ti_malicious")
        assert hit["level_hint"] == "高危"
        assert hit["action_hint"] == "ban"
        assert "僵尸网络" in hit["evidence"]

    def test_ti_malicious_low_confidence_downgrades(self):
        """恶意但置信度 0.7：不命中高危，落入可疑档。"""
        ctx = _ctx(threat={"is_malicious": True, "severity": "high", "confidence": 0.7, "tags": []})
        ids = [h["rule_id"] for h in evaluate_rules(ctx)]
        assert "ti_malicious" not in ids
        assert "ti_suspicious" in ids

    def test_ti_malicious_via_360(self):
        ctx = _ctx(ti_360={"results": [{"ioc": "1.2.3.4", "level": 80, "level_label": "超危",
                                        "status_label": "恶意"}]})
        hits = evaluate_rules(ctx)
        hit = next(h for h in hits if h["rule_id"] == "ti_malicious")
        assert "1.2.3.4" in hit["evidence"]

    def test_ti_suspicious_via_360_medium(self):
        ctx = _ctx(ti_360={"results": [{"ioc": "1.2.3.4", "level": 65}]})
        ids = [h["rule_id"] for h in evaluate_rules(ctx)]
        assert "ti_malicious" not in ids
        hit = next(h for h in evaluate_rules(ctx) if h["rule_id"] == "ti_suspicious")
        assert hit["action_hint"] == "monitor"

    def test_multi_source_stack(self):
        ctx = _ctx(
            blacklist={"records": [{"ban_level": "high", "source": "manual",
                                    "violation_count": 2, "expired_at": "2099-01-01", "reason": ""}],
                       "degraded": False},
            threat={"is_malicious": True, "severity": "critical", "confidence": 0.9, "tags": []},
        )
        hits = evaluate_rules(ctx)
        malicious = [h for h in hits if h.get("malicious_signal")]
        assert len(malicious) >= MULTI_SOURCE_THRESHOLD
        hit = next(h for h in hits if h["rule_id"] == "multi_source_stack")
        assert hit["level_hint"] == "严重"

    def test_asset_critical(self):
        asset = {"matched": True, "asset_name": "核心数据库", "source": "asset_inventory",
                 "source_label": "资产清单", "inventory": {"fields": {"criticality": "critical"}}}
        hits = evaluate_rules(_ctx(asset=asset))
        hit = next(h for h in hits if h["rule_id"] == "asset_critical")
        assert hit["level_hint"] == ""  # 仅证据不定级
        assert "核心数据库" in hit["evidence"]

    def test_asset_critical_lite_no_fields(self):
        """lite 档资产无 fields：不命中关键资产规则（与展示降级一致）。"""
        asset = {"matched": True, "asset_name": "x", "source": "asset_inventory"}
        ids = [h["rule_id"] for h in evaluate_rules(_ctx(asset=asset))]
        assert "asset_critical" not in ids

    def test_geo_overseas_src_ip_only(self):
        lib = {"matches": [{"library_type": "overseas", "library_label": "境外",
                            "country": "美国", "isp": "AWS"}], "degraded": False}
        hits = evaluate_rules(_ctx(ip_library=lib))
        hit = next(h for h in hits if h["rule_id"] == "geo_overseas")
        assert "美国" in hit["evidence"]

    def test_geo_overseas_dst_ip_not_hit(self):
        """境外来源仅对源 IP 有意义。"""
        lib = {"matches": [{"library_type": "hk_mo", "library_label": "香港澳门"}], "degraded": False}
        ids = [h["rule_id"] for h in evaluate_rules(_ctx(roles=["dst_ip"], ip_library=lib))]
        assert "geo_overseas" not in ids

    def test_priority_ordering(self):
        """证据按优先级升序输出。"""
        ctx = _ctx(
            blacklist={"records": [{"ban_level": "high", "source": "manual",
                                    "violation_count": 1, "expired_at": "2099-01-01", "reason": ""}],
                       "degraded": False},
            whitelist={"hit": True, "match_type": "exact", "entries": [], "degraded": False},
        )
        priorities = [h["priority"] for h in evaluate_rules(ctx)]
        assert priorities == sorted(priorities)


class TestRenderGuidelines:
    def test_contains_all_rules(self):
        text = render_guidelines()
        assert len(text.splitlines()) == len(RULES)

    def test_version_changes_with_guidelines(self):
        v1 = rules_version()
        assert v1
        assert len(v1) == 16  # sha256 前 16 位


class TestVocabulary:
    def test_hints_within_frontend_vocabulary(self):
        """规则建议的等级/动作必须在前端展示词汇表内。"""
        for r in RULES:
            assert r.level_hint in ("",) + RISK_LEVELS, f"{r.rule_id} 非法等级 {r.level_hint}"
            assert r.action_hint in ("",) + ACTIONS, f"{r.rule_id} 非法动作 {r.action_hint}"
