"""工单价值评分核心引擎单元测试。

覆盖文档《网络安全工单价值评估打分规则体系 V1.0》中的计算示例、修正系数上限、
强制置顶与分级阈值，以及规则配置校验。
"""
import copy

import pytest

from app.core.ticket_score import (
    DEFAULT_SCORE_RULE,
    ScoreRuleError,
    compute_score,
    normalize_rule_config,
)


def _scores(asset=5, threat=5, exploit=5, evidence=5, impact=4):
    return {
        "asset_importance": asset,
        "threat_severity": threat,
        "exploitability": exploit,
        "evidence_certainty": evidence,
        "impact_scope": impact,
    }


@pytest.fixture()
def rule():
    return normalize_rule_config(copy.deepcopy(DEFAULT_SCORE_RULE))


def test_default_rule_weights_and_levels(rule):
    assert [d["weight"] for d in rule["dimensions"]] == [30, 25, 20, 15, 10]
    assert all(len(d["levels"]) == 5 for d in rule["dimensions"])
    assert {l["score"] for l in rule["dimensions"][0]["levels"]} == {1, 2, 3, 4, 5}


def test_document_examples(rule):
    """文档第 6 章四个示例：98 / 91 / 60 / 48。"""
    assert compute_score(rule, _scores(5, 5, 5, 5, 4))["base_score"] == 98
    assert compute_score(rule, _scores(5, 5, 4, 4, 4))["base_score"] == 91
    assert compute_score(rule, _scores(5, 2, 1, 4, 2))["base_score"] == 60
    assert compute_score(rule, _scores(3, 2, 1, 4, 2))["base_score"] == 48


def test_document_ongoing_factor_capped_at_100(rule):
    """WebShell 且事件仍在进行：98 × 1.10 = 107.8，按上限计 100。"""
    result = compute_score(rule, _scores(5, 5, 5, 5, 4), ["event_ongoing"])
    assert result["base_score"] == 98
    assert result["final_score"] == 100
    assert result["grade"]["key"] == "P0"


def test_factor_cap_limit(rule):
    """多个修正系数连乘超过 1.30 时按上限计算。"""
    result = compute_score(
        rule, _scores(5, 5, 5, 5, 4),
        ["event_ongoing", "major_event", "sensitive_data"],
    )
    assert result["factor_multiplier"] == pytest.approx(1.331)
    assert result["factor_capped"] is True
    assert result["factor_capped_multiplier"] == pytest.approx(1.30)


def test_negative_factor(rule):
    """历史已闭环 0.90：98 × 0.90 = 88.2 → 88 分 P1。"""
    result = compute_score(rule, _scores(5, 5, 5, 5, 4), ["closed_history"])
    assert result["final_score"] == 88
    assert result["grade"]["key"] == "P1"


def test_override_set_to_100(rule):
    result = compute_score(rule, _scores(3, 2, 1, 4, 2), override_keys=["core_compromised"])
    assert result["final_score"] == 100
    assert result["override_rules"][0]["key"] == "core_compromised"


def test_override_floor_90(rule):
    result = compute_score(rule, _scores(3, 2, 1, 4, 2), override_keys=["core_public_exp"])
    assert result["final_score"] == 90
    assert result["grade"]["key"] == "P0"


def test_grade_boundaries(rule):
    assert compute_score(rule, _scores(1, 1, 1, 1, 1))["final_score"] == 20
    assert compute_score(rule, _scores(1, 1, 1, 1, 1))["grade"]["key"] == "P3"
    assert compute_score(rule, _scores(5, 5, 5, 5, 5))["grade"]["key"] == "P0"


def test_missing_dimension_rejected_in_strict_mode(rule):
    with pytest.raises(ScoreRuleError):
        compute_score(rule, {"asset_importance": 5})


def test_missing_dimension_defaults_to_one_in_recalc(rule):
    """按最新规则折算历史评分时，缺失维度按 1 分计（不报错）。"""
    result = compute_score(rule, {"asset_importance": 5}, strict=False)
    assert result["dimension_scores"]["threat_severity"] == 1


def test_unknown_factor_rejected(rule):
    with pytest.raises(ScoreRuleError):
        compute_score(rule, _scores(), ["not_exists"])


def test_weight_sum_must_be_100():
    data = copy.deepcopy(DEFAULT_SCORE_RULE)
    data["dimensions"][0]["weight"] = 40
    with pytest.raises(ScoreRuleError) as exc:
        normalize_rule_config(data)
    assert "100%" in str(exc.value)


def test_duplicate_dimension_key_rejected():
    data = copy.deepcopy(DEFAULT_SCORE_RULE)
    data["dimensions"][1]["key"] = data["dimensions"][0]["key"]
    with pytest.raises(ScoreRuleError):
        normalize_rule_config(data)


def test_dimension_requires_five_levels():
    data = copy.deepcopy(DEFAULT_SCORE_RULE)
    data["dimensions"][0]["levels"] = data["dimensions"][0]["levels"][:4]
    with pytest.raises(ScoreRuleError):
        normalize_rule_config(data)


def test_grades_must_cover_zero():
    data = copy.deepcopy(DEFAULT_SCORE_RULE)
    data["grades"][-1]["min"] = 10
    with pytest.raises(ScoreRuleError):
        normalize_rule_config(data)


def test_override_mode_validated():
    data = copy.deepcopy(DEFAULT_SCORE_RULE)
    data["override_rules"][0]["mode"] = "multiply"
    with pytest.raises(ScoreRuleError):
        normalize_rule_config(data)


def test_custom_weights_change_score(rule):
    """权重调整后同一组维度得分得到不同结果（规则变更自动生效）。"""
    before = compute_score(rule, _scores(5, 2, 1, 4, 2))["final_score"]
    custom = copy.deepcopy(DEFAULT_SCORE_RULE)
    custom["dimensions"][0]["weight"] = 20
    custom["dimensions"][1]["weight"] = 35
    after_rule = normalize_rule_config(custom)
    after = compute_score(after_rule, _scores(5, 2, 1, 4, 2))["final_score"]
    assert before == 60
    assert after != before
