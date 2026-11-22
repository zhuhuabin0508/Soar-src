"""工单价值评估：评分规则、计算引擎与评分状态构建。

规则模型（与《网络安全工单价值评估打分规则体系 V1.0》一致）：

    价值分 = ROUND(Σ(维度得分 × 维度权重) × scale × 修正系数, 0)
    维度得分取 1-5 的整数，权重合计必须为 100%，scale 默认 20
    修正系数按类命中后连乘（同类不叠加），总系数受 factor_cap 限制（默认 1.30）
    强制置顶命中后不再依赖加权结果，直接抬升到指定下限（set / min）
    最终结果上下限 0-100，按分级阈值（默认 P0≥90 / P1≥75 / P2≥60 / P3<60）分级

规则当前配置存于 ``system_configs``（键 ``ticket.score_rule``），每次保存生成
``ticket_score_rule_versions`` 存档行并自增版本号；工单评分保存提交时的规则快照，
规则后续变更不影响历史结果，同时按最新规则折算展示（rule_changed）。
"""
from __future__ import annotations

import copy
import json
import logging
import math
from typing import Any

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.timezone import beijing_now
from app.models.system_config import SystemConfig
from app.models.ticket_score import TicketScore, TicketScoreRuleVersion

logger = logging.getLogger(__name__)

SCORE_RULE_CONFIG_KEY = "ticket.score_rule"

GRADE_COLORS = ("red", "orange", "amber", "blue", "emerald", "slate")

DEFAULT_SCORE_RULE: dict[str, Any] = {
    "name": "网络安全工单价值评估打分规则",
    "formula_note": "价值分 = ROUND(Σ(维度得分 × 维度权重) × 20 × 修正系数, 0)，上限 100、下限 0",
    "scale": 20,
    "dimensions": [
        {
            "key": "asset_importance",
            "name": "资产重要性",
            "weight": 30,
            "question": "这件事发生在什么资产上",
            "basis": "CMDB 资产等级、业务属性",
            "levels": [
                {"score": 5, "label": "核心资产", "criteria": "域控、生产数据库、对外核心业务系统、云管理平台、堡垒机、CA 与密钥系统、核心交易链路"},
                {"score": 4, "label": "重要资产", "criteria": "内部重要业务系统、办公 OA、邮件系统、代码仓库、VPN 与统一认证"},
                {"score": 3, "label": "一般资产", "criteria": "普通内部服务、非核心业务终端、开发联调环境"},
                {"score": 2, "label": "低价值资产", "criteria": "测试环境、演示环境、闲置主机、可随时重建的容器"},
                {"score": 1, "label": "未知或无关资产", "criteria": "未登记 IP、无归属个人终端、无法确认归属的资产"},
            ],
        },
        {
            "key": "threat_severity",
            "name": "威胁严重性",
            "weight": 25,
            "question": "这件事本身有多危险",
            "basis": "工单类型、告警规则标签",
            "levels": [
                {"score": 5, "label": "已失陷类", "criteria": "WebShell、后门、勒索软件、挖矿、数据外传、账号接管、域内提权成功"},
                {"score": 4, "label": "可直接利用类", "criteria": "高危漏洞、弱口令、未授权访问、数据库或远程管理端口暴露"},
                {"score": 3, "label": "异常行为类", "criteria": "可疑登录、异常外联、权限提升尝试、暴力破解成功前的高频尝试"},
                {"score": 2, "label": "探测扫描类", "criteria": "端口扫描、目录扫描、漏洞扫描、爬虫、暴力破解未成功"},
                {"score": 1, "label": "信息类", "criteria": "指纹识别、配置不合规提示、公开信息泄露（不含凭据）"},
            ],
        },
        {
            "key": "exploitability",
            "name": "可利用性 / 攻击阶段",
            "weight": 20,
            "question": "对方走到哪一步了",
            "basis": "漏洞 EXP 情况、攻击链阶段",
            "levels": [
                {
                    "score": 5,
                    "label": "已利用 / 在野武器化",
                    "criteria": "已有在野利用或武器化 EXP，且目标具备暴露条件",
                    "criteria_attack": "已成功利用：命令执行、文件写入、账号登录成功",
                },
                {
                    "score": 4,
                    "label": "稳定可利用 / 利用成功迹象",
                    "criteria": "公开 EXP 或 PoC 可稳定复现",
                    "criteria_attack": "已进入利用尝试，并出现成功迹象",
                },
                {
                    "score": 3,
                    "label": "有条件可利用 / 持续尝试",
                    "criteria": "有 PoC，但需要特定前置条件",
                    "criteria_attack": "持续攻击尝试，尚未成功",
                },
                {
                    "score": 2,
                    "label": "理论可利用 / 单次探测",
                    "criteria": "理论可利用，暂无公开利用代码",
                    "criteria_attack": "单次探测、低强度扫描",
                },
                {
                    "score": 1,
                    "label": "仅匹配 / 仅信息收集",
                    "criteria": "仅版本或指纹匹配，无法验证",
                    "criteria_attack": "仅信息收集与指纹识别",
                },
            ],
        },
        {
            "key": "evidence_certainty",
            "name": "证据确定性",
            "weight": 15,
            "question": "这件事有多确定",
            "basis": "证据来源数量与可信度",
            "levels": [
                {"score": 5, "label": "已证实", "criteria": "多源证据互相印证，如日志、流量、终端与样本同时命中"},
                {"score": 4, "label": "高置信", "criteria": "单一高可信来源直接证实，如 EDR 告警含完整进程链、WAF 拦截原文"},
                {"score": 3, "label": "中等置信", "criteria": "规则命中但缺少上下文，需要人工进一步确认"},
                {"score": 2, "label": "低置信", "criteria": "单条日志或单一阈值触发，存在误报可能"},
                {"score": 1, "label": "疑似误报", "criteria": "仅有推断，没有原始证据或样本"},
            ],
        },
        {
            "key": "impact_scope",
            "name": "影响范围与暴露面",
            "weight": 10,
            "question": "最坏会影响多大",
            "basis": "互联网暴露、横向条件、数据量",
            "levels": [
                {"score": 5, "label": "全局扩散", "criteria": "可横向扩散、影响多资产或核心数据，且资产互联网可直接访问"},
                {"score": 4, "label": "核心单点", "criteria": "单台核心资产受影响，且互联网可直接访问"},
                {"score": 3, "label": "多点或内网核心", "criteria": "多台一般资产受影响，或内网可访问核心资产"},
                {"score": 2, "label": "一般单点", "criteria": "单台一般资产受影响，仅内网可访问"},
                {"score": 1, "label": "无扩散", "criteria": "单点问题，无扩散可能，不可达"},
            ],
        },
    ],
    "factor_cap": 1.30,
    "factors": [
        {
            "key": "event_ongoing",
            "name": "事件仍在进行（未阻断、未隔离）",
            "multiplier": 1.10,
            "description": "处置紧迫性提升，需立即控制",
            "enabled": True,
        },
        {
            "key": "major_event",
            "name": "重大活动保障期（HVV、攻防演练）",
            "multiplier": 1.10,
            "description": "由管理员设定起止时间，过期自动失效",
            "enabled": True,
        },
        {
            "key": "sensitive_data",
            "name": "涉及个人信息、核心数据或监管报送",
            "multiplier": 1.10,
            "description": "依据数据分类分级标签判定",
            "enabled": True,
        },
        {
            "key": "closed_history",
            "name": "历史已闭环且无残留风险",
            "multiplier": 0.90,
            "description": "补录或复盘类工单，价值适度下调",
            "enabled": True,
        },
    ],
    "override_rules": [
        {
            "key": "core_compromised",
            "name": "核心资产已确认失陷（WebShell、反弹 Shell、后门进程、域控被控）",
            "mode": "set",
            "value": 100,
            "description": "命中后价值分直接置为 100",
            "enabled": True,
        },
        {
            "key": "data_extortion",
            "name": "已确认数据外传、勒索加密或大规模挖矿",
            "mode": "set",
            "value": 100,
            "description": "命中后价值分直接置为 100",
            "enabled": True,
        },
        {
            "key": "core_public_exp",
            "name": "核心资产存在互联网可直接利用的高危漏洞，且有公开 EXP",
            "mode": "min",
            "value": 90,
            "description": "命中后价值分不低于 90",
            "enabled": True,
        },
    ],
    "grades": [
        {"key": "P0", "label": "P0", "min": 90, "color": "red", "description": "紧急处置：核心资产失陷或可直接造成重大损失"},
        {"key": "P1", "label": "P1", "min": 75, "color": "orange", "description": "高优先级：应优先投入处置资源"},
        {"key": "P2", "label": "P2", "min": 60, "color": "amber", "description": "常规处置：按计划排期处理"},
        {"key": "P3", "label": "P3", "min": 0, "color": "slate", "description": "低优先级：可延后或批量处理"},
    ],
}


class ScoreRuleError(ValueError):
    """评分规则/评分提交的业务异常（携带 HTTP 状态码与错误码）。"""

    def __init__(self, message: str, *, status_code: int = 422, code: str = "TICKET_SCORE_INVALID"):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


# ============ 通用工具 ============

def _round_half_up(value: float) -> int:
    """四舍五入取整（Python round 为银行家舍入，业务口径需标准四舍五入）。"""
    return int(math.floor(float(value) + 0.5))


def _clamp(value: int, low: int = 0, high: int = 100) -> int:
    return max(low, min(high, value))


def _as_text(value: Any, field: str, *, max_len: int, required: bool = True) -> str:
    if value is None:
        if required:
            raise ScoreRuleError(f"{field}不能为空")
        return ""
    if not isinstance(value, str):
        raise ScoreRuleError(f"{field}必须为文本")
    text = value.strip()
    if required and not text:
        raise ScoreRuleError(f"{field}不能为空")
    if len(text) > max_len:
        raise ScoreRuleError(f"{field}长度不能超过 {max_len} 个字符")
    return text


def _as_int(value: Any, field: str, *, low: int, high: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        else:
            raise ScoreRuleError(f"{field}必须为整数")
    if value < low or value > high:
        raise ScoreRuleError(f"{field}取值需在 {low}~{high} 之间")
    return int(value)


def _as_number(value: Any, field: str, *, low: float, high: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ScoreRuleError(f"{field}必须为数字")
    number = float(value)
    if not math.isfinite(number):
        raise ScoreRuleError(f"{field}必须为有限数字")
    if number < low or number > high:
        raise ScoreRuleError(f"{field}取值需在 {low}~{high} 之间")
    return round(number, 4)


def _as_bool(value: Any, field: str, *, default: bool = True) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise ScoreRuleError(f"{field}必须为布尔值")
    return value


def _as_key(value: Any, field: str) -> str:
    text = _as_text(value, field, max_len=64)
    import re

    if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", text):
        raise ScoreRuleError(f"{field}需以字母开头，仅允许字母、数字与下划线")
    return text


def _default_rule_copy() -> dict[str, Any]:
    return copy.deepcopy(DEFAULT_SCORE_RULE)


# ============ 规则校验 ============

def normalize_rule_config(raw: Any) -> dict[str, Any]:
    """校验并标准化规则配置；非法配置抛 ``ScoreRuleError``（422）。"""
    if not isinstance(raw, dict):
        raise ScoreRuleError("评分规则必须为对象")

    config: dict[str, Any] = {}
    config["name"] = _as_text(raw.get("name") or DEFAULT_SCORE_RULE["name"], "规则名称", max_len=100)
    config["formula_note"] = _as_text(
        raw.get("formula_note") or DEFAULT_SCORE_RULE["formula_note"], "公式说明",
        max_len=500, required=False,
    )
    config["scale"] = _as_int(raw.get("scale", 20), "分值放大系数", low=1, high=100)

    raw_dims = raw.get("dimensions")
    if not isinstance(raw_dims, list) or not raw_dims:
        raise ScoreRuleError("至少配置 1 个评分维度")
    if len(raw_dims) > 10:
        raise ScoreRuleError("评分维度最多 10 个")

    dims: list[dict[str, Any]] = []
    seen_keys: set[str] = set()
    total_weight = 0
    for index, item in enumerate(raw_dims, start=1):
        if not isinstance(item, dict):
            raise ScoreRuleError(f"第 {index} 个评分维度必须为对象")
        key = _as_key(item.get("key"), f"第 {index} 个维度标识")
        if key in seen_keys:
            raise ScoreRuleError(f"维度标识「{key}」重复")
        seen_keys.add(key)
        weight = _as_int(item.get("weight"), f"维度「{key}」权重", low=1, high=100)
        total_weight += weight

        raw_levels = item.get("levels")
        if not isinstance(raw_levels, list) or len(raw_levels) != 5:
            raise ScoreRuleError(f"维度「{key}」需配置 1-5 共 5 个分值锚点")
        levels: list[dict[str, Any]] = []
        level_scores: set[int] = set()
        for level in raw_levels:
            if not isinstance(level, dict):
                raise ScoreRuleError(f"维度「{key}」的分值锚点必须为对象")
            score = _as_int(level.get("score"), f"维度「{key}」锚点分值", low=1, high=5)
            if score in level_scores:
                raise ScoreRuleError(f"维度「{key}」锚点分值 {score} 重复")
            level_scores.add(score)
            normalized_level = {
                "score": score,
                "label": _as_text(level.get("label"), f"维度「{key}」{score} 分等级名", max_len=50),
                "criteria": _as_text(level.get("criteria"), f"维度「{key}」{score} 分判定标准", max_len=500),
            }
            attack = level.get("criteria_attack")
            if attack is not None:
                normalized_level["criteria_attack"] = _as_text(
                    attack, f"维度「{key}」{score} 分攻击类锚点", max_len=500, required=False,
                )
            levels.append(normalized_level)
        levels.sort(key=lambda x: x["score"], reverse=True)
        dims.append({
            "key": key,
            "name": _as_text(item.get("name"), f"维度「{key}」名称", max_len=50),
            "weight": weight,
            "question": _as_text(item.get("question") or "", f"维度「{key}」回答的问题", max_len=200, required=False),
            "basis": _as_text(item.get("basis") or "", f"维度「{key}」取值依据", max_len=200, required=False),
            "levels": levels,
        })
    if total_weight != 100:
        raise ScoreRuleError(f"各维度权重合计必须为 100%（当前 {total_weight}%）")
    config["dimensions"] = dims

    config["factor_cap"] = _as_number(raw.get("factor_cap", 1.30), "修正系数总上限", low=1.0, high=5.0)

    raw_factors = raw.get("factors") or []
    if not isinstance(raw_factors, list):
        raise ScoreRuleError("修正系数必须为数组")
    if len(raw_factors) > 20:
        raise ScoreRuleError("修正系数最多 20 个")
    factors: list[dict[str, Any]] = []
    seen_factor_keys: set[str] = set()
    for index, item in enumerate(raw_factors, start=1):
        if not isinstance(item, dict):
            raise ScoreRuleError(f"第 {index} 个修正系数必须为对象")
        key = _as_key(item.get("key"), f"第 {index} 个修正系数标识")
        if key in seen_factor_keys:
            raise ScoreRuleError(f"修正系数标识「{key}」重复")
        seen_factor_keys.add(key)
        factors.append({
            "key": key,
            "name": _as_text(item.get("name"), f"修正系数「{key}」名称", max_len=100),
            "multiplier": _as_number(item.get("multiplier"), f"修正系数「{key}」系数", low=0.1, high=5.0),
            "description": _as_text(item.get("description") or "", f"修正系数「{key}」说明", max_len=300, required=False),
            "enabled": _as_bool(item.get("enabled"), f"修正系数「{key}」启用状态"),
        })
    config["factors"] = factors

    raw_overrides = raw.get("override_rules") or []
    if not isinstance(raw_overrides, list):
        raise ScoreRuleError("强制置顶规则必须为数组")
    if len(raw_overrides) > 20:
        raise ScoreRuleError("强制置顶规则最多 20 个")
    overrides: list[dict[str, Any]] = []
    seen_override_keys: set[str] = set()
    for index, item in enumerate(raw_overrides, start=1):
        if not isinstance(item, dict):
            raise ScoreRuleError(f"第 {index} 个强制置顶规则必须为对象")
        key = _as_key(item.get("key"), f"第 {index} 个置顶规则标识")
        if key in seen_override_keys:
            raise ScoreRuleError(f"置顶规则标识「{key}」重复")
        seen_override_keys.add(key)
        mode = _as_text(item.get("mode") or "min", f"置顶规则「{key}」处理方式", max_len=16)
        if mode not in ("set", "min"):
            raise ScoreRuleError(f"置顶规则「{key}」处理方式仅支持 set（直接置为）或 min（不低于）")
        overrides.append({
            "key": key,
            "name": _as_text(item.get("name"), f"置顶规则「{key}」名称", max_len=150),
            "mode": mode,
            "value": _as_int(item.get("value"), f"置顶规则「{key}」分值", low=0, high=100),
            "description": _as_text(item.get("description") or "", f"置顶规则「{key}」说明", max_len=300, required=False),
            "enabled": _as_bool(item.get("enabled"), f"置顶规则「{key}」启用状态"),
        })
    config["override_rules"] = overrides

    raw_grades = raw.get("grades")
    if not isinstance(raw_grades, list) or not raw_grades:
        raise ScoreRuleError("至少配置 1 个评分分级")
    if len(raw_grades) > 10:
        raise ScoreRuleError("评分分级最多 10 个")
    grades: list[dict[str, Any]] = []
    seen_grade_keys: set[str] = set()
    for index, item in enumerate(raw_grades, start=1):
        if not isinstance(item, dict):
            raise ScoreRuleError(f"第 {index} 个评分分级必须为对象")
        key = _as_text(item.get("key"), f"第 {index} 个分级标识", max_len=16)
        if key in seen_grade_keys:
            raise ScoreRuleError(f"分级标识「{key}」重复")
        seen_grade_keys.add(key)
        color = _as_text(item.get("color") or "slate", f"分级「{key}」颜色", max_len=16)
        if color not in GRADE_COLORS:
            raise ScoreRuleError(f"分级「{key}」颜色仅支持：{'、'.join(GRADE_COLORS)}")
        grades.append({
            "key": key,
            "label": _as_text(item.get("label") or key, f"分级「{key}」名称", max_len=32),
            "min": _as_int(item.get("min"), f"分级「{key}」最低分", low=0, high=100),
            "color": color,
            "description": _as_text(item.get("description") or "", f"分级「{key}」说明", max_len=200, required=False),
        })
    grades.sort(key=lambda x: x["min"], reverse=True)
    if grades[-1]["min"] != 0:
        raise ScoreRuleError("最低分级的分数下限必须为 0，保证 0-100 全区间可分级")
    for prev, cur in zip(grades, grades[1:]):
        if prev["min"] == cur["min"]:
            raise ScoreRuleError(f"分级最低分不能重复（{prev['min']}）")
    config["grades"] = grades

    return config


# ============ 规则读取 / 保存 ============

def _rule_payload(config: dict[str, Any], row: TicketScoreRuleVersion | None) -> dict[str, Any]:
    """把规则配置与版本元信息合并为接口返回结构。"""
    payload = copy.deepcopy(config)
    payload["version"] = int(row.version) if row else 0
    payload["builtin"] = row is None
    payload["note"] = (row.note or "") if row else ""
    payload["published_by_name"] = (row.published_by_name or "") if row else ""
    payload["published_at"] = row.to_dict().get("published_at") if row else None
    return payload


def get_score_rule(db: Session) -> dict[str, Any]:
    """读取当前生效评分规则；未配置或解析失败时回退内置默认规则（version=0）。"""
    row = db.query(SystemConfig).filter(SystemConfig.key == SCORE_RULE_CONFIG_KEY).first()
    if not row or not row.value:
        return _rule_payload(_default_rule_copy(), None)
    try:
        raw = json.loads(row.value)
        if not isinstance(raw, dict) or not isinstance(raw.get("config"), dict):
            raise ValueError("配置结构非法")
        version = int(raw.get("version") or 0)
        version_row = (
            db.query(TicketScoreRuleVersion)
            .filter(TicketScoreRuleVersion.version == version)
            .first()
        ) if version else None
        config = normalize_rule_config(raw["config"])
        payload = _rule_payload(config, version_row)
        if version_row is None:
            # 配置存在但版本存档缺失（手工写入/迁移场景）：保留真实版本号，避免误标为内置规则
            payload["version"] = version
            payload["builtin"] = False
        return payload
    except (ValueError, TypeError, ScoreRuleError) as exc:
        logger.warning("评分规则配置解析失败，使用内置默认规则: %s", exc)
        return _rule_payload(_default_rule_copy(), None)


def default_rule_payload() -> dict[str, Any]:
    """内置默认规则（版本 0），供配置页「恢复默认」载入使用。"""
    return _rule_payload(_default_rule_copy(), None)


def save_score_rule(db: Session, raw_config: Any, *, note: str = "", operator: Any = None) -> dict[str, Any]:
    """校验并保存评分规则：生成新版本存档 + 更新当前配置。"""
    config = normalize_rule_config(raw_config)
    current = get_score_rule(db)
    max_version = (
        db.query(TicketScoreRuleVersion.version)
        .order_by(TicketScoreRuleVersion.version.desc())
        .limit(1)
        .scalar()
    ) or 0
    next_version = max(int(current.get("version") or 0), int(max_version)) + 1

    value = json.dumps({"version": next_version, "config": config}, ensure_ascii=False)
    row = db.query(SystemConfig).filter(SystemConfig.key == SCORE_RULE_CONFIG_KEY).first()
    if row:
        row.value = value
        row.description = "工单价值评估评分规则"
    else:
        db.add(SystemConfig(
            key=SCORE_RULE_CONFIG_KEY,
            value=value,
            description="工单价值评估评分规则",
        ))

    version_row = TicketScoreRuleVersion(
        version=next_version,
        config=config,
        note=(note or "").strip()[:255] or None,
        published_by_id=getattr(operator, "id", None),
        published_by_name=(getattr(operator, "display_name", None) or getattr(operator, "username", "") or ""),
        published_at=beijing_now(),
    )
    db.add(version_row)
    db.commit()
    db.refresh(version_row)
    return _rule_payload(config, version_row)


def list_score_rule_versions(db: Session, *, limit: int = 50) -> dict[str, Any]:
    """规则版本列表（倒序）与当前版本号。"""
    current = get_score_rule(db)
    rows = (
        db.query(TicketScoreRuleVersion)
        .order_by(TicketScoreRuleVersion.version.desc())
        .limit(max(1, min(limit, 200)))
        .all()
    )
    return {
        "current_version": current.get("version", 0),
        "items": [r.to_dict(with_config=False) for r in rows],
    }


def get_score_rule_version(db: Session, version: int) -> dict[str, Any] | None:
    """指定版本的规则快照（含完整配置）；不存在返回 None。"""
    row = db.query(TicketScoreRuleVersion).filter(TicketScoreRuleVersion.version == version).first()
    if not row:
        return None
    payload = copy.deepcopy(row.config or {})
    payload["version"] = row.version
    payload["builtin"] = False
    payload["note"] = row.note or ""
    payload["published_by_name"] = row.published_by_name or ""
    payload["published_at"] = row.to_dict().get("published_at")
    return payload


# ============ 计算引擎 ============

def compute_score(
    config: dict[str, Any],
    dimension_scores: dict[str, Any],
    factor_keys: list[str] | None = None,
    override_keys: list[str] | None = None,
    *,
    strict: bool = True,
) -> dict[str, Any]:
    """按规则计算价值分并返回完整可解释明细。

    Args:
        config: 规则配置（normalize 后）
        dimension_scores: ``{维度 key: 1-5 分}``
        factor_keys: 命中的修正系数 key 列表（同类不重复，多类连乘）
        override_keys: 命中的强制置顶规则 key 列表
        strict: True=提交校验（缺维度/未知 key 直接报错）；
            False=历史结果按最新规则折算（缺失维度按 1 分、未知 key 忽略）
    """
    if not isinstance(dimension_scores, dict):
        raise ScoreRuleError("维度得分必须为对象")
    selected_factors = {str(k) for k in (factor_keys or []) if k}
    selected_overrides = {str(k) for k in (override_keys or []) if k}

    factor_defs = {f["key"]: f for f in config.get("factors") or []}
    override_defs = {o["key"]: o for o in config.get("override_rules") or []}
    if strict:
        unknown_factors = selected_factors - set(factor_defs)
        if unknown_factors:
            raise ScoreRuleError(f"未知的修正系数：{'、'.join(sorted(unknown_factors))}")
        unknown_overrides = selected_overrides - set(override_defs)
        if unknown_overrides:
            raise ScoreRuleError(f"未知的强制置顶规则：{'、'.join(sorted(unknown_overrides))}")

    dims: list[dict[str, Any]] = []
    weighted = 0.0
    for dim in config.get("dimensions") or []:
        key = dim["key"]
        raw_score = dimension_scores.get(key)
        if isinstance(raw_score, bool):
            raw_score = None
        try:
            score = int(raw_score)
        except (TypeError, ValueError):
            score = None
        if score is None or score < 1 or score > 5:
            if strict:
                raise ScoreRuleError(f"请为维度「{dim['name']}」选择 1-5 分")
            score = 1
        level = next((x for x in dim.get("levels") or [] if int(x["score"]) == score), None)
        weight = int(dim["weight"])
        points = score * weight / 100
        weighted += points
        dims.append({
            "key": key,
            "name": dim["name"],
            "weight": weight,
            "score": score,
            "level_label": level["label"] if level else "",
            "criteria": level["criteria"] if level else "",
            "points": round(points, 4),
        })

    scale = int(config.get("scale") or 20)
    base = weighted * scale
    base_score = _clamp(_round_half_up(base))

    applied_factors: list[dict[str, Any]] = []
    multiplier = 1.0
    for key in factor_defs:
        if key not in selected_factors:
            continue
        factor = factor_defs[key]
        if not factor.get("enabled", True):
            continue
        multiplier *= float(factor["multiplier"])
        applied_factors.append({
            "key": key,
            "name": factor["name"],
            "multiplier": factor["multiplier"],
            "description": factor.get("description") or "",
        })
    cap = float(config.get("factor_cap") or 1.30)
    capped_multiplier = min(multiplier, cap)
    adjusted = base * capped_multiplier
    final = _clamp(_round_half_up(adjusted))

    applied_overrides: list[dict[str, Any]] = []
    for key in override_defs:
        if key not in selected_overrides:
            continue
        rule = override_defs[key]
        if not rule.get("enabled", True):
            continue
        value = int(rule["value"])
        before = final
        if rule.get("mode") == "set":
            final = value
        else:
            final = max(final, value)
        final = _clamp(final)
        applied_overrides.append({
            "key": key,
            "name": rule["name"],
            "mode": rule.get("mode") or "min",
            "value": value,
            "description": rule.get("description") or "",
            "before": before,
            "after": final,
        })

    grade = None
    for item in config.get("grades") or []:
        if final >= int(item["min"]):
            grade = item
            break
    if grade is None:
        grades = config.get("grades") or []
        grade = grades[-1] if grades else {"key": "", "label": "", "min": 0, "color": "slate"}

    return {
        "dimension_scores": {d["key"]: d["score"] for d in dims},
        "dimensions": dims,
        "weighted": round(weighted, 4),
        "scale": scale,
        "base_score": base_score,
        "factors": applied_factors,
        "factor_multiplier": round(multiplier, 4),
        "factor_capped_multiplier": round(capped_multiplier, 4),
        "factor_capped": multiplier > cap,
        "adjusted_score": round(adjusted, 2),
        "override_rules": applied_overrides,
        "final_score": final,
        "grade": {
            "key": grade["key"],
            "label": grade["label"],
            "min": grade["min"],
            "color": grade.get("color") or "slate",
            "description": grade.get("description") or "",
        },
    }


def recalculate_score(row: TicketScore, config: dict[str, Any]) -> dict[str, Any] | None:
    """把历史评分按指定规则折算（不落库）；数据异常时返回 None。"""
    try:
        return compute_score(
            config,
            row.dimension_scores or {},
            list(row.factor_keys or []),
            list(row.override_keys or []),
            strict=False,
        )
    except (ScoreRuleError, TypeError, ValueError) as exc:  # noqa: BLE001
        logger.warning("工单评分按新规则折算失败: ticket=%s err=%s", row.ticket_id, exc)
        return None


# ============ 评分状态 ============

def _score_row_payload(row: TicketScore, *, include_breakdown: bool = True) -> dict[str, Any]:
    data = row.to_dict()
    if not include_breakdown:
        data.pop("breakdown", None)
        data.pop("rule_snapshot", None)
    return data


def get_ticket_score_row(db: Session, ticket_id: int) -> TicketScore | None:
    return db.query(TicketScore).filter(TicketScore.ticket_id == ticket_id).first()


def build_ticket_score_state(
    db: Session,
    ticket: Any,
    *,
    can_score_action: bool,
) -> dict[str, Any]:
    """工单评分状态：当前规则、已提交结果、按最新规则折算、可评分标记与原因。"""
    rule = get_score_rule(db)
    row = get_ticket_score_row(db, ticket.id)
    current = None
    rule_changed = False
    if row is not None and int(row.rule_version) != int(rule.get("version") or 0):
        rule_changed = True
        current = recalculate_score(row, rule)

    if row is not None:
        blocked_reason = "该工单已完成评分，不允许重复提交"
    elif ticket.status != "completed":
        blocked_reason = "仅已完成工单可评分"
    elif not can_score_action:
        blocked_reason = "没有工单评分权限"
    else:
        blocked_reason = ""

    return {
        "ticket_id": ticket.id,
        "ticket_no": ticket.ticket_no,
        "ticket_status": ticket.status,
        "rule": rule,
        "score": _score_row_payload(row) if row else None,
        "current": current,
        "rule_changed": rule_changed,
        "already_scored": row is not None,
        "can_score": bool(
            row is None and ticket.status == "completed" and can_score_action
        ),
        "blocked_reason": blocked_reason,
    }


def score_list_fields(row: TicketScore | None, rule: dict[str, Any]) -> dict[str, Any]:
    """列表行的评分摘要字段（不含大 JSON，规则变更时附带最新规则折算分）。"""
    if row is None:
        return {
            "score_status": "unscored",
            "score_value": None,
            "score_grade": None,
            "score_grade_label": None,
            "score_grade_color": None,
            "score_scored_at": None,
            "score_scored_by_name": None,
            "score_rule_version": None,
            "score_current_value": None,
            "score_current_grade": None,
            "score_rule_changed": False,
        }
    data = {
        "score_status": "scored",
        "score_value": int(row.final_score),
        "score_grade": row.grade,
        "score_grade_label": row.grade_label or row.grade,
        "score_grade_color": ((row.breakdown or {}).get("grade") or {}).get("color") or "slate",
        "score_scored_at": row.to_dict().get("scored_at"),
        "score_scored_by_name": row.scored_by_name,
        "score_rule_version": int(row.rule_version),
        "score_current_value": None,
        "score_current_grade": None,
        "score_rule_changed": False,
    }
    if int(row.rule_version) != int(rule.get("version") or 0):
        current = recalculate_score(row, rule)
        if current:
            data["score_rule_changed"] = True
            data["score_current_value"] = current["final_score"]
            data["score_current_grade"] = current["grade"]["key"]
    return data


def submit_ticket_score(
    db: Session,
    ticket: Any,
    user: Any,
    *,
    dimension_scores: dict[str, Any],
    factor_keys: list[str] | None = None,
    override_keys: list[str] | None = None,
    comment: str | None = None,
) -> dict[str, Any]:
    """提交工单评分：校验状态/重复、按当前规则计算并落库。

    并发兜底：``ticket_scores.ticket_id`` 唯一约束，重复提交捕获 IntegrityError → 409。
    """
    if ticket.status != "completed":
        raise ScoreRuleError("仅已完成工单可评分", status_code=400, code="TICKET_SCORE_STATUS_INVALID")
    if get_ticket_score_row(db, ticket.id) is not None:
        raise ScoreRuleError(
            "该工单已完成评分，不允许重复提交",
            status_code=409, code="TICKET_SCORE_DUPLICATED",
        )

    rule = get_score_rule(db)
    breakdown = compute_score(rule, dimension_scores, factor_keys, override_keys, strict=True)
    rule_snapshot = {
        key: copy.deepcopy(value)
        for key, value in rule.items()
        if key not in ("version", "builtin", "note", "published_by_name", "published_at")
    }
    row = TicketScore(
        ticket_id=ticket.id,
        ticket_no=ticket.ticket_no,
        rule_version=int(rule.get("version") or 0),
        rule_snapshot=rule_snapshot,
        dimension_scores=breakdown["dimension_scores"],
        factor_keys=list(factor_keys or []),
        override_keys=list(override_keys or []),
        breakdown=breakdown,
        base_score=int(breakdown["base_score"]),
        final_score=int(breakdown["final_score"]),
        grade=breakdown["grade"]["key"],
        grade_label=breakdown["grade"]["label"],
        comment=(comment or "").strip()[:2000] or None,
        scored_by_id=user.id,
        scored_by_name=(getattr(user, "display_name", None) or user.username or ""),
        scored_at=beijing_now(),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise ScoreRuleError(
            "该工单已完成评分，不允许重复提交",
            status_code=409, code="TICKET_SCORE_DUPLICATED",
        ) from exc
    db.refresh(row)
    return {"row": row, "breakdown": breakdown, "rule": rule}
