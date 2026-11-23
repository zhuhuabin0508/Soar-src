# -*- coding: utf-8 -*-
"""工单研判规则注册表（声明式）。

对 ``context.gather_contexts`` 产出的多维安全上下文做确定性「证据计算」：
每条规则声明 优先级 / 触发条件 / 证据文本 / 等级与处置建议 / 提示词指导文本。
命中的证据由 ``client`` 注入 LLM 提示词辅助最终研判（规则只生产证据，
不做最终裁决）。

扩展方式：新增一个数据维度 = 在 ``context.py`` 加一个采集函数 +
在 ``RULES`` 追加一条 ``Rule`` 声明；``render_guidelines`` 会自动把
新规则的指导文本渲染进智能体系统提示词（配合 ensure 的提示词 hash
更新机制，重启后生效）。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 阈值常量（集中定义，便于调优）
# ---------------------------------------------------------------------------

# 知道创宇威胁情报：恶意 + 高危严重度 + 置信度下限（confidence 为 0-1 浮点）
TI_HIGH_CONFIDENCE = 0.8
# 可疑档置信度下限（介于可疑与高危之间视为可疑）
TI_SUSPICIOUS_CONFIDENCE = 0.6
TI_HIGH_SEVERITIES = ("high", "critical")
# 360 情报 level（0-100 整数）：>=60 记恶意 / 中危，>=70 记高危
TI360_MALICIOUS_LEVEL = 60
TI360_HIGH_LEVEL = 70
# 恶意类证据叠加升级阈值（黑名单 + 威胁情报等独立源同时命中）
MULTI_SOURCE_THRESHOLD = 2
# 地址库境外来源（源 IP 角色才参与弱证据）
OVERSEAS_LIB_TYPES = ("overseas", "hk_mo")
# 资产重要性档位
CRITICAL_ASSET_LEVELS = ("high", "critical")

# 前端展示词汇表（agent_runtime.adapt_ticket_analyst 同口径校验）
RISK_LEVELS = ("严重", "高危", "高", "中危", "中", "低危", "低")
ACTIONS = ("ban", "monitor", "ignore")


@dataclass(frozen=True)
class Rule:
    """一条研判规则声明。

    Args:
        rule_id: 规则唯一标识（审计与证据引用）。
        priority: 评估优先级，小者先。
        guideline: 提示词指导文本（render_guidelines 渲染进系统提示词）。
        condition: ``condition(ctx, hits) -> bool``，hits 为已命中证据
            （按优先级累积），供叠加类规则消费。
        evidence: ``evidence(ctx) -> str``，证据文本（决策依据素材，
            必须引用 ctx 实际数据，禁止编造）。
        level_hint: 建议风险等级（前端词汇表），空串表示仅提供证据不定级。
        action_hint: 建议处置动作（ban/monitor/ignore），空串表示不定处置。
        malicious_signal: 是否恶意类证据（multi_source_stack 计数口径）。
    """

    rule_id: str
    priority: int
    guideline: str
    condition: Callable[[dict, list], bool]
    evidence: Callable[[dict], str]
    level_hint: str = ""
    action_hint: str = ""
    malicious_signal: bool = False

    def evaluate(self, ctx: dict, hits: list) -> dict | None:
        """评估规则，命中返回证据 dict，未命中返回 None（条件异常按未命中降级）。"""
        try:
            if not self.condition(ctx, hits):
                return None
            return {
                "rule_id": self.rule_id,
                "priority": self.priority,
                "evidence": self.evidence(ctx),
                "level_hint": self.level_hint,
                "action_hint": self.action_hint,
                "malicious_signal": self.malicious_signal,
            }
        except Exception:  # noqa: BLE001
            logger.warning("研判规则评估异常, rule=%s, ip=%s", self.rule_id, ctx.get("ip"), exc_info=True)
            return None


# ---------------------------------------------------------------------------
# 条件与证据函数（均须容忍 degraded/缺失维度：None 或空结构按未命中处理）
# ---------------------------------------------------------------------------

def _asset_criticality(asset: dict | None) -> str:
    """资产重要性提取（与 ticket_enrichment._asset_criticality 同口径）。

    lite 档资产不含 fields/criticality，返回空串（不命中关键资产规则）。
    """
    if not isinstance(asset, dict) or not asset.get("matched"):
        return ""
    fields = None
    if isinstance(asset.get("inventory"), dict):
        fields = asset["inventory"].get("fields")
    if not isinstance(fields, dict) and isinstance(asset.get("fields"), dict):
        fields = asset["fields"]
    return str((fields or {}).get("criticality") or "")


def _wl_hit(ctx: dict, _hits: list) -> bool:
    wl = ctx.get("whitelist")
    return bool(isinstance(wl, dict) and wl.get("hit"))


def _wl_evidence(ctx: dict) -> str:
    wl = ctx["whitelist"]
    entries = wl.get("entries") or []
    names = "、".join(str(e.get("wlist") or "") for e in entries[:3] if isinstance(e, dict))
    return f"白名单命中（匹配方式 {wl.get('match_type')}，白名单条目: {names or '未提供'}）"


def _bl_hit(ctx: dict, _hits: list) -> bool:
    bl = ctx.get("blacklist")
    return bool(isinstance(bl, dict) and bl.get("records"))


def _bl_evidence(ctx: dict) -> str:
    r = ctx["blacklist"]["records"][0]
    return (
        f"黑名单命中：IP 处于封禁中（封禁等级 {r.get('ban_level')}，"
        f"来源 {r.get('source')}，违规 {r.get('violation_count')} 次，"
        f"到期 {r.get('expired_at')}，原因 {r.get('reason') or '未填写'}）"
    )


def _asset_hit(ctx: dict, _hits: list) -> bool:
    return _asset_criticality(ctx.get("asset")) in CRITICAL_ASSET_LEVELS


def _asset_evidence(ctx: dict) -> str:
    a = ctx["asset"]
    return (
        f"命中重要资产（资产名 {a.get('asset_name')}，"
        f"来源 {a.get('source_label') or a.get('source')}，"
        f"重要性 {_asset_criticality(a)}）：受攻击面价值高，应上调风险关注度"
    )


def _threat_high(ctx: dict) -> dict | None:
    """知道创宇情报：恶意 + 高危严重度 + 置信度达标。"""
    t = ctx.get("threat")
    if not isinstance(t, dict) or not t.get("is_malicious"):
        return None
    if t.get("severity") in TI_HIGH_SEVERITIES and float(t.get("confidence") or 0) >= TI_HIGH_CONFIDENCE:
        return t
    return None


def _ti360_high(ctx: dict) -> dict | None:
    """360 情报：任一 IOC level 达高危线。"""
    t = ctx.get("ti_360")
    if not isinstance(t, dict):
        return None
    for r in t.get("results") or []:
        if isinstance(r, dict) and int(r.get("level") or 0) >= TI360_HIGH_LEVEL:
            return r
    return None


def _ti_high_hit(ctx: dict, _hits: list) -> bool:
    return _threat_high(ctx) is not None or _ti360_high(ctx) is not None


def _ti_high_evidence(ctx: dict) -> str:
    t = _threat_high(ctx)
    if t is not None:
        tags = "、".join(str(x) for x in (t.get("tags") or [])[:3])
        return (
            f"威胁情报高危命中（来源 {t.get('source')}，严重度 {t.get('severity')}，"
            f"置信度 {t.get('confidence')}，威胁标签: {tags or '未提供'}）"
        )
    r = _ti360_high(ctx)
    return (
        f"360 威胁情报高危命中（IOC {r.get('ioc')}，"
        f"等级 {r.get('level')}（{r.get('level_label')}），"
        f"状态 {r.get('status_label') or r.get('status')}）"
    )


def _multi_source_hit(ctx: dict, hits: list) -> bool:
    return sum(1 for h in hits if h.get("malicious_signal")) >= MULTI_SOURCE_THRESHOLD


def _multi_source_evidence(ctx: dict) -> str:
    return (
        f"多源风险叠加：{MULTI_SOURCE_THRESHOLD} 个及以上独立风险维度（黑名单/威胁情报）"
        "同时命中，风险显著升级"
    )


def _ti_suspicious_hit(ctx: dict, _hits: list) -> bool:
    """可疑档：恶意但置信度/严重度未达高危，或 360 中危。"""
    t = ctx.get("threat")
    if isinstance(t, dict) and t.get("is_malicious") and _threat_high(ctx) is None:
        return True
    ti360 = ctx.get("ti_360")
    if isinstance(ti360, dict):
        for r in ti360.get("results") or []:
            if (
                isinstance(r, dict)
                and int(r.get("level") or 0) >= TI360_MALICIOUS_LEVEL
                and int(r.get("level") or 0) < TI360_HIGH_LEVEL
            ):
                return True
    return False


def _ti_suspicious_evidence(ctx: dict) -> str:
    t = ctx.get("threat")
    if isinstance(t, dict) and t.get("is_malicious") and _threat_high(ctx) is None:
        return (
            f"威胁情报可疑命中（来源 {t.get('source')}，严重度 {t.get('severity')}，"
            f"置信度 {t.get('confidence')}，未达高危阈值）"
        )
    return "360 威胁情报中危命中（level 达 60 高危线以下）"


def _geo_overseas_hit(ctx: dict, _hits: list) -> bool:
    lib = ctx.get("ip_library")
    if not isinstance(lib, dict) or "src_ip" not in (ctx.get("roles") or []):
        return False
    return any(
        isinstance(m, dict) and m.get("library_type") in OVERSEAS_LIB_TYPES
        for m in lib.get("matches") or []
    )


def _geo_overseas_evidence(ctx: dict) -> str:
    matches = [m for m in ctx["ip_library"]["matches"] if m.get("library_type") in OVERSEAS_LIB_TYPES]
    parts = []
    for m in matches[:2]:
        loc = m.get("country") or m.get("province") or ""
        isp = m.get("isp") or ""
        seg = f"{m.get('library_label')}"
        if loc:
            seg += f"（{loc}）"
        if isp:
            seg += f" ISP: {isp}"
        parts.append(seg)
    return f"地址库境外来源命中（作为源 IP）：{'；'.join(parts)}"


def _no_hit_fallback_condition(ctx: dict, hits: list) -> bool:
    """兜底规则：全部维度均无命中时触发（优先级最大，评估时 hits 已含此前全部证据）。"""
    return not hits


def _no_hit_fallback_evidence(ctx: dict) -> str:
    return "全维度（黑名单/白名单/资产/威胁情报/IP地址库）均无命中"


# ---------------------------------------------------------------------------
# 规则注册表（新增维度在此追加一条 Rule 声明即可）
# ---------------------------------------------------------------------------

RULES: tuple[Rule, ...] = (
    Rule(
        rule_id="whitelist_hit",
        priority=5,
        guideline="白名单命中（安博通设备白名单）：该 IP 为受信任对象，默认风险等级「低」、处置建议 ignore；除非黑名单或威胁情报同时高危命中，否则不得建议封禁。",
        condition=_wl_hit,
        evidence=_wl_evidence,
        level_hint="低",
        action_hint="ignore",
    ),
    Rule(
        rule_id="blacklist_hit",
        priority=10,
        guideline="黑名单命中（BannedIP 封禁中）：该 IP 处于平台封禁状态，默认风险等级「严重」、处置建议 ban；建议在决策依据中引用封禁等级、来源与违规次数。",
        condition=_bl_hit,
        evidence=_bl_evidence,
        level_hint="严重",
        action_hint="ban",
        malicious_signal=True,
    ),
    Rule(
        rule_id="asset_critical",
        priority=15,
        guideline="重要资产命中（资产重要性 high/critical）：工单涉及关键资产，应在既有风险等级基础上上调一级关注度；该证据仅影响等级评估，不单独决定处置动作。",
        condition=_asset_hit,
        evidence=_asset_evidence,
    ),
    Rule(
        rule_id="ti_malicious",
        priority=20,
        guideline="威胁情报高危命中（知道创宇恶意且严重度 high/critical 且置信度≥0.8，或 360 level≥70）：默认风险等级「高危」、处置建议 ban；决策依据必须引用实际威胁标签/置信度/IOC 数据，严禁照搬示例数值。",
        condition=_ti_high_hit,
        evidence=_ti_high_evidence,
        level_hint="高危",
        action_hint="ban",
        malicious_signal=True,
    ),
    Rule(
        rule_id="multi_source_stack",
        priority=25,
        guideline="多源叠加：两个及以上独立恶意维度（如黑名单 + 威胁情报）同时命中时，默认风险等级「严重」、处置建议 ban。",
        condition=_multi_source_hit,
        evidence=_multi_source_evidence,
        level_hint="严重",
        action_hint="ban",
    ),
    Rule(
        rule_id="ti_suspicious",
        priority=30,
        guideline="威胁情报可疑命中（恶意但置信度未达 0.8，或 360 level 在 60-69）：默认风险等级「中危」、处置建议 monitor，建议补充观察。",
        condition=_ti_suspicious_hit,
        evidence=_ti_suspicious_evidence,
        level_hint="中危",
        action_hint="monitor",
    ),
    Rule(
        rule_id="geo_overseas",
        priority=40,
        guideline="地址库境外来源（境外库/港澳库命中且该 IP 为源 IP）：境外来源本身不构成处置依据，仅作为辅助证据与等级参考，处置仍以威胁情报与黑白名单为准。",
        condition=_geo_overseas_hit,
        evidence=_geo_overseas_evidence,
    ),
    Rule(
        rule_id="no_hit_fallback",
        priority=100,
        guideline="全维度无命中：默认风险等级「低」、处置建议 monitor；决策依据须说明各维度均已核查无命中。",
        condition=_no_hit_fallback_condition,
        evidence=_no_hit_fallback_evidence,
        level_hint="低",
        action_hint="monitor",
    ),
)


def evaluate_rules(ctx: dict) -> list[dict]:
    """按优先级评估全部规则，返回命中证据列表（已按优先级排序）。"""
    hits: list[dict] = []
    for rule in sorted(RULES, key=lambda r: r.priority):
        hit = rule.evaluate(ctx, hits)
        if hit is not None:
            hits.append(hit)
    return hits


def render_guidelines() -> str:
    """渲染全部规则指导文本（按优先级），供智能体系统提示词组装。"""
    return "\n".join(f"- {r.guideline}" for r in sorted(RULES, key=lambda x: x.priority))


def rules_version() -> str:
    """规则集内容指纹：提示词 hash 更新用（规则文本变化 → ensure 刷新系统提示词）。"""
    import hashlib

    return hashlib.sha256((render_guidelines()).encode("utf-8")).hexdigest()[:16]
