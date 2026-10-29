"""告警规则管理 API（XDR 风格重构版）。

- CRUD：入参支持新模型（group / type=match|stats / 嵌套条件树 /
  stats_config / field_mapping 双控件 / alert_aggregation / draft 草稿）；
  旧版扁平条件（[{field,op,value}] + match）继续兼容，保存时统一归一为
  嵌套结构 {"logic", "items"}（叶 | 组，组最多两层）；
- 规则名称全局唯一；草稿（draft=1）不参与线上匹配；
- 发布门禁：POST /{id}/publish 携带测试样例，服务端复验通过
  （匹配类任一样例命中 / 统计类模拟达阈值）后置 draft=0 并记录
  last_test_passed_at；
- 测试接口只读不落库：支持匹配链逐规则明细（嵌套条件树）+ 统计滑动
  窗口模拟（样例可带 occur_timestamp 标记同窗口）+ 最终动作预览；
- 导入导出：JSON 全量配置（重名跳过）；
- 其余：模板 / 统计卡 / 命中记录分页 / 排序 / 批量 / 启停，逻辑不变。
"""
import json
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field
from sqlalchemy import func as sa_func
from sqlalchemy.orm import Session

from app.core.log_receiver_manager.pipeline.alert_rule_stage import (
    _eval_rule_conditions,
    apply_rule_action,
    invalidate_alert_rules_cache,
    load_enabled_rules,
    match_alert_rules,
    simulate_stats,
    verify_rule_passes_samples,
)
from app.core.log_receiver_manager.pipeline.filter_stage import _match_op
from app.core.log_receiver_manager.events import NormalizedEvent
from app.core.timezone import beijing_now
from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.alert_event import AlertEvent
from app.models.alert_rule import AlertRule
from app.models.alert_rule_group import AlertRuleGroup
from app.models.alert_rule_hit import AlertRuleHit

# 路由级基线：强制登录；权限按接口单独声明
# （list/export/stats/hits/templates/test=alert_rule:view，
#   import/create/update/delete/publish/toggle/duplicate/reorder/batch=alert_rule:edit）
router = APIRouter(
    prefix="/alert-rules",
    tags=["alert-rules"],
    dependencies=[Depends(get_current_user)],
)

VALID_OPS = {
    "eq", "ne", "in", "not_in", "gte", "lte", "gt", "lt",
    "regex", "contains", "exists", "empty", "in_cidr",
}
NO_VALUE_OPS = ("exists", "empty")  # 无需比较值的操作符
VALID_TYPES = {"match", "stats"}  # correlation P2 预留
VALID_ACTIONS = {"alert", "suppress", "adjust_level"}
VALID_FIELDMAP_MODES = {"static", "map", "keep"}
_WINDOW_UNITS = {"minute", "hour", "day"}

# 字段配置 / 聚合键可选字段域：AlertEvent 标准列（保存前校验）
ALERT_EVENT_FIELDS = set(AlertEvent.__table__.columns.keys())


class _SampleParseResult:
    """测试样例 ParseResult 替身（``NormalizedEvent.from_parse_result`` 仅消费 ``.fields``）。"""

    def __init__(self, fields: dict):
        self.fields = fields or {}


# ===== 请求模型 =====
class ConditionItem(BaseModel):
    """叶条件（旧版扁平结构与新版嵌套结构共用）。"""

    field: str = Field(..., max_length=64)
    op: str = "eq"
    value: Any = None


class StatsConfigBody(BaseModel):
    """统计配置（type=stats 必填）。"""

    window: dict = Field(default_factory=lambda: {"value": 5, "unit": "minute"})
    method: str = "count"          # count 计数 / count_distinct 去重计数
    distinct_field: Optional[str] = None
    group_by: list[str] = Field(default_factory=list)
    threshold: int = 10


class AggregationBody(BaseModel):
    """告警聚合配置（告警生成侧同键同窗合并）。"""

    window: dict = Field(default_factory=lambda: {"value": 30, "unit": "minute"})
    keys: list[str] = Field(default_factory=list)


class RuleBase(BaseModel):
    """规则入参（新建/更新共用；conditions 兼容旧 list / 新嵌套 dict）。"""

    name: str = Field(..., min_length=1, max_length=255)
    description: str = ""
    enabled: bool = True
    priority: int = 100
    scope: str = "global"
    device_type: str = ""
    match: str = "all"
    conditions: Any = Field(default_factory=list)
    type: str = "match"
    action: str = "alert"
    override: dict = Field(default_factory=dict)
    stats_config: Optional[StatsConfigBody] = None
    field_mapping: dict = Field(default_factory=dict)
    alert_aggregation: Optional[AggregationBody] = None
    group: str = "其他"
    draft: bool = False


class RuleCreate(RuleBase):
    pass


class RuleUpdate(RuleBase):
    pass


class TestSample(BaseModel):
    """测试样例：fields 为解析后的标准告警模型字段值（可带 occur_timestamp
    标记统计窗口时间；缺省视为当前时间，即全部同窗）。"""

    fields: dict = Field(default_factory=dict)


class TestBody(BaseModel):
    samples: list[TestSample] = Field(..., min_length=1, max_length=10)
    draft_rule: Optional[RuleCreate] = None


class PublishBody(BaseModel):
    test_samples: list[TestSample] = Field(..., min_length=1, max_length=10)


class ImportBody(BaseModel):
    rules: list[RuleCreate] = Field(..., min_length=1)


# ===== 校验 =====
# 标准告警模型中的 IP 字段：条件值必须可解析为 IP/CIDR（in_cidr 只允许 IP/CIDR）
_IP_CONDITION_FIELDS = ("src_ip", "dst_ip", "host_ip")


def _validate_ip_condition_value(field: str, op: str, value: Any) -> None:
    """校验 IP 字段的条件值；非法直接抛 422（与保存/导入共用）。"""
    from app.core.ip_validation import validate_cidr_list, validate_ip_expression

    if field not in _IP_CONDITION_FIELDS or op in NO_VALUE_OPS or value is None:
        return
    items = value if isinstance(value, list) else [value]
    for item in items:
        if not isinstance(item, str) or not item.strip():
            continue
        try:
            if op == "in_cidr":
                validate_cidr_list(item, field)
            else:
                validate_ip_expression(item, field)
        except ValueError as exc:
            raise HTTPException(422, detail=str(exc))


def _validate_ip_conditions(node: Any) -> None:
    """递归校验条件树中的 IP 字段值（草稿测试接口复用）。"""
    if isinstance(node, dict) and node.get("type") == "group":
        for it in node.get("items") or []:
            _validate_ip_conditions(it)
        return
    if isinstance(node, dict) and node.get("field"):
        _validate_ip_condition_value(
            str(node.get("field")), node.get("op"), node.get("value")
        )


def _validate_condition_tree(node: Any, depth: int = 0) -> Any:
    """条件树校验 + 轻度归一（叶：必填字段/合法操作符；组：最多两层）。"""
    if isinstance(node, dict) and node.get("type") == "group":
        if depth >= 2:
            raise HTTPException(422, detail=f"条件组嵌套过深（最多两层）")
        if node.get("logic") not in ("all", "any"):
            raise HTTPException(422, detail=f"条件组 logic 仅支持 all/any")
        items = node.get("items")
        if not isinstance(items, list) or not items:
            raise HTTPException(422, detail=f"条件组 items 不能为空")
        return {
            "type": "group",
            "logic": node.get("logic"),
            "items": [_validate_condition_tree(it, depth + 1) for it in items],
        }
    if not isinstance(node, dict) or not node.get("field"):
        raise HTTPException(422, detail=f"条件行缺少 field：{node!r}")
    if node.get("op") not in VALID_OPS:
        raise HTTPException(422, detail=f"不支持的操作符：{node.get('op')!r}")
    if node.get("op") not in NO_VALUE_OPS and node.get("value") is None:
        raise HTTPException(422, detail=f"条件 {node['field']!r} 需要比较值")
    _validate_ip_condition_value(
        str(node["field"]), node.get("op"), node.get("value")
    )
    return {"field": str(node["field"])[:64], "op": node["op"], "value": node.get("value")}


def _normalize_conditions(payload: RuleBase) -> dict:
    """入参条件 → 嵌套结构 {logic, items}（旧版 list 自动升级，顶层逻辑取 match）。"""
    raw = payload.conditions
    if isinstance(raw, dict) and isinstance(raw.get("items"), list):
        logic = raw.get("logic") or payload.match or "all"
        if logic not in ("all", "any"):
            raise HTTPException(422, detail="顶层 logic 仅支持 all/any")
        if not raw["items"]:
            raise HTTPException(422, detail="匹配条件不能为空（严格模式下空条件不会命中任何日志）")
        return {
            "logic": logic,
            "items": [_validate_condition_tree(it) for it in raw["items"]],
        }
    if isinstance(raw, list) and raw:
        match = payload.match if payload.match in ("all", "any") else "all"
        return {
            "logic": match,
            "items": [_validate_condition_tree(it) for it in raw],
        }
    raise HTTPException(422, detail="匹配条件不能为空（严格模式下空条件不会命中任何日志）")


def _validate_stats_config(cfg: Optional[StatsConfigBody]) -> Optional[dict]:
    """统计配置校验：窗口/阈值/方式/去重字段/分组字段。"""
    if cfg is None:
        raise HTTPException(422, detail="统计类规则必须配置 stats_config")
    if cfg.window.get("unit") not in _WINDOW_UNITS:
        raise HTTPException(422, detail="统计窗口单位仅支持 minute/hour/day")
    try:
        if int(cfg.window.get("value", 0)) < 1:
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(422, detail="统计窗口数值必须 ≥ 1")
    if cfg.method not in ("count", "count_distinct"):
        raise HTTPException(422, detail="统计方式仅支持 count / count_distinct")
    if cfg.method == "count_distinct" and not cfg.distinct_field:
        raise HTTPException(422, detail="去重计数必须指定去重字段（distinct_field）")
    if cfg.threshold < 1:
        raise HTTPException(422, detail="触发阈值必须 ≥ 1")
    for f in cfg.group_by or []:
        if f not in ALERT_EVENT_FIELDS:
            raise HTTPException(422, detail=f"分组字段 {f!r} 不在标准告警模型中")
    if cfg.method == "count_distinct" and cfg.distinct_field not in ALERT_EVENT_FIELDS:
        raise HTTPException(422, detail=f"去重字段 {cfg.distinct_field!r} 不在标准告警模型中")
    return cfg.model_dump()


def _validate_field_mapping(mapping: dict) -> dict:
    """字段配置校验：目标字段必须是 AlertEvent 列；map 值必须是合法字段。"""
    if not isinstance(mapping, dict):
        raise HTTPException(422, detail="field_mapping 必须是对象")
    out = {}
    for target, cfg in mapping.items():
        if target not in ALERT_EVENT_FIELDS:
            raise HTTPException(422, detail=f"字段配置目标 {target!r} 不在标准告警模型中")
        if not isinstance(cfg, dict) or cfg.get("mode") not in VALID_FIELDMAP_MODES:
            raise HTTPException(422, detail=f"字段 {target!r} 取值方式仅支持 static/map/keep")
        mode = cfg.get("mode")
        value = cfg.get("value")
        if mode == "map":
            if not isinstance(value, str) or value not in ALERT_EVENT_FIELDS:
                raise HTTPException(422, detail=f"字段 {target!r} 的映射来源 {value!r} 不在标准告警模型中")
        if mode == "static" and target == "risk_level":
            try:
                int(value)
            except (TypeError, ValueError):
                raise HTTPException(422, detail="告警等级静态值必须是 0-4 的整数")
            if int(value) not in (0, 1, 2, 3, 4):
                raise HTTPException(422, detail="告警等级静态值必须是 0-4 的整数")
        out[target] = {"mode": mode, "value": value}
    return out


def _validate_aggregation(cfg: Optional[AggregationBody]) -> Optional[dict]:
    """告警聚合配置校验：窗口合法 + 聚合键字段在标准模型中。"""
    if cfg is None:
        return None
    if not cfg.keys:
        raise HTTPException(422, detail="启用告警聚合必须选择聚合键字段")
    if cfg.window.get("unit") not in _WINDOW_UNITS:
        raise HTTPException(422, detail="聚合窗口单位仅支持 minute/hour/day")
    try:
        if int(cfg.window.get("value", 0)) < 1:
            raise ValueError
    except (TypeError, ValueError):
        raise HTTPException(422, detail="聚合窗口数值必须 ≥ 1")
    for f in cfg.keys:
        if f not in ALERT_EVENT_FIELDS:
            raise HTTPException(422, detail=f"聚合键字段 {f!r} 不在标准告警模型中")
    return cfg.model_dump()


def _ensure_group(db: Session, name: str) -> str:
    """分组不存在时自动创建（导入/保存的分组始终有据可查）。"""
    name = (name or "其他").strip()[:64] or "其他"
    if not db.query(AlertRuleGroup.id).filter(AlertRuleGroup.name == name).first():
        db.add(AlertRuleGroup(name=name, sort_order=999))
    return name


def _validate(payload: RuleBase, db: Session, exclude_id: Optional[int] = None) -> dict:
    """入参统一校验 + 归一，返回可入库字段 dict。"""
    if payload.type not in VALID_TYPES:
        raise HTTPException(422, detail="规则类型仅支持 match（匹配）/ stats（统计）；关联类型规划中")
    if payload.action not in VALID_ACTIONS:
        raise HTTPException(422, detail="动作仅支持 alert / suppress / adjust_level")
    if payload.type == "stats" and payload.action != "alert":
        raise HTTPException(422, detail="统计类规则触发动作固定为产生告警")
    if payload.scope not in ("global", "device_type"):
        raise HTTPException(422, detail="作用域仅支持 global（全局）/ device_type（按设备类型）")
    if payload.match not in ("all", "any"):
        raise HTTPException(422, detail="条件聚合仅支持 all（全部满足）/ any（任一满足）")
    # 覆盖项校验（动作联动）
    override = payload.override or {}
    if payload.action == "adjust_level":
        level_map = override.get("level_map")
        if not isinstance(level_map, dict) or not level_map:
            raise HTTPException(422, detail="调整等级动作必须配置等级映射（原等级 → 新等级，0-4）")
        for k, v in level_map.items():
            if str(k) not in ("0", "1", "2", "3", "4") or str(v) not in ("0", "1", "2", "3", "4"):
                raise HTTPException(422, detail=f"等级映射 {k!r}→{v!r} 非法：键值均必须是 0-4 的等级")
    if override.get("risk_level") is not None:
        try:
            lv = int(override["risk_level"])
            if lv not in (0, 1, 2, 3, 4):
                raise ValueError
        except (TypeError, ValueError):
            raise HTTPException(422, detail="覆盖告警等级必须是 0-4 的整数")
    if len(override.get("tags") or []) > 10:
        raise HTTPException(422, detail="附加标签最多 10 个")
    # 名称唯一性（全局）
    q = db.query(AlertRule.id).filter(AlertRule.name == payload.name)
    if exclude_id is not None:
        q = q.filter(AlertRule.id != exclude_id)
    if q.first():
        raise HTTPException(422, detail=f"规则名称「{payload.name}」已存在（规则名称全局唯一）")
    conditions = _normalize_conditions(payload)
    stats_config = _validate_stats_config(payload.stats_config) if payload.type == "stats" else None
    field_mapping = _validate_field_mapping(payload.field_mapping)
    alert_aggregation = _validate_aggregation(payload.alert_aggregation)
    group = _ensure_group(db, payload.group)
    # 作用域校验
    if payload.scope == "device_type" and not payload.device_type.strip():
        raise HTTPException(422, detail="指定设备类型作用域时必须选择设备类型")
    return {
        "name": payload.name.strip()[:255],
        "description": (payload.description or "")[:512],
        "enabled": 1 if payload.enabled else 0,
        "priority": payload.priority,
        "scope": payload.scope,
        "device_type": payload.device_type.strip()[:64],
        "match": conditions["logic"],  # 顶层逻辑冗余存 match 列（旧消费方兼容）
        "conditions": json.dumps(conditions, ensure_ascii=False),
        "rule_type": payload.type,
        "action": "alert" if payload.type == "stats" else payload.action,
        "override": json.dumps(payload.override or {}, ensure_ascii=False),
        "stats_config": json.dumps(stats_config, ensure_ascii=False) if stats_config else "",
        "field_mapping": json.dumps(field_mapping, ensure_ascii=False),
        "alert_aggregation": json.dumps(alert_aggregation, ensure_ascii=False) if alert_aggregation else "",
        "rule_group": group,
        "draft": 1 if payload.draft else 0,
    }


def _parse_json(raw, default):
    try:
        v = json.loads(raw) if raw else default
    except (ValueError, TypeError):
        return default
    return v


def _serialize(rule: AlertRule) -> dict:
    conditions = _parse_json(rule.conditions, [])
    return {
        "id": rule.id,
        "name": rule.name,
        "description": rule.description or "",
        "enabled": bool(rule.enabled),
        "priority": rule.priority,
        "scope": rule.scope,
        "device_type": rule.device_type or "",
        "match": rule.match or "all",
        "conditions": conditions,
        "type": rule.rule_type or "match",
        "action": rule.action or "alert",
        "override": _parse_json(rule.override, {}),
        "stats_config": _parse_json(rule.stats_config, None),
        "field_mapping": _parse_json(rule.field_mapping, {}),
        "alert_aggregation": _parse_json(rule.alert_aggregation, None),
        "group": rule.rule_group or "其他",
        "draft": bool(rule.draft),
        "last_test_passed_at": (
            rule.last_test_passed_at.strftime("%Y-%m-%d %H:%M:%S") if rule.last_test_passed_at else None
        ),
        "hit_count": rule.hit_count or 0,
        "created_by": rule.created_by or "",
        "updated_by": rule.updated_by or "",
        "created_at": rule.created_at.strftime("%Y-%m-%d %H:%M:%S") if rule.created_at else None,
        "updated_at": rule.updated_at.strftime("%Y-%m-%d %H:%M:%S") if rule.updated_at else None,
    }


def _username(current_user) -> str:
    """get_current_user 返回 User 对象 → 统一取 username 字符串。"""
    return getattr(current_user, "username", None) or str(current_user or "")


def _rule_from_body(payload: RuleBase, db: Session, current_user) -> AlertRule:
    user = _username(current_user)
    fields = _validate(payload, db)
    return AlertRule(
        **fields,
        created_by=user,
        updated_by=user,
    )


def _apply_body_to_rule(rule: AlertRule, payload: RuleBase, db: Session, current_user) -> None:
    for k, v in _validate(payload, db, exclude_id=rule.id).items():
        setattr(rule, k, v)
    rule.updated_by = _username(current_user)


def _log_audit(request: Request, action: str, detail: str, current_user) -> None:
    """写审计日志（现有审计能力；失败不阻塞主流程）。"""
    current_user = _username(current_user)
    try:
        from app.models.audit_log import AuditLog
        from app.database import SessionLocal

        db = SessionLocal()
        try:
            db.add(
                AuditLog(
                    action=action,
                    resource_type="alert_rule",
                    detail=detail,
                    ip_address=request.client.host if request.client else "",
                    username=current_user,
                )
            )
            db.commit()
        finally:
            db.close()
    except Exception:  # noqa: BLE001
        pass


# ===== 模板（空状态快速开始；后端配置便于扩展）=====
_TEMPLATES = [
    {
        "key": "high_risk",
        "name": "高危及以上告警",
        "desc": "风险等级为「严重/高危」的日志产生告警（最常用）",
        "hit_note": "命中量取决于设备日志构成，通常为低频高质量告警",
        "recommended": True,
        "payload": {
            "name": "高危及以上告警",
            "description": "风险等级为严重/高危时产生告警",
            "type": "match", "action": "alert", "enabled": True,
            "scope": "global", "group": "其他",
            "match": "all",
            "conditions": {"logic": "all", "items": [{"field": "risk_level", "op": "in", "value": [0, 1]}]},
            "field_mapping": {
                "alert_name": {"mode": "keep", "value": None},
                "risk_level": {"mode": "keep", "value": None},
            },
        },
    },
    {
        "key": "bruteforce",
        "name": "暴力破解与异常登录",
        "desc": "威胁类型命中「暴力破解/异常登录/反弹Shell」类时产生告警",
        "hit_note": "适合主机安全类设备接入后优先启用",
        "recommended": False,
        "payload": {
            "name": "暴力破解与异常登录",
            "description": "威胁类型命中暴力破解/异常登录/反弹Shell类时产生告警",
            "type": "match", "action": "alert", "enabled": True,
            "scope": "global", "group": "暴力破解",
            "match": "any",
            "conditions": {"logic": "any", "items": [
                {"field": "threat_type", "op": "contains", "value": "暴力破解"},
                {"field": "threat_type", "op": "contains", "value": "异常登录"},
                {"field": "threat_type", "op": "contains", "value": "反弹Shell"},
            ]},
            "field_mapping": {
                "alert_name": {"mode": "keep", "value": None},
                "risk_level": {"mode": "keep", "value": None},
            },
        },
    },
    {
        "key": "all_alerts",
        "name": "全部告警（宽松兜底）",
        "desc": "所有成功解析且生成标准告警模型的事件全部产生告警",
        "hit_note": "量大：适合刚接入想先看全量的场景，稳定后建议收窄",
        "recommended": False,
        "payload": {
            "name": "全部告警（宽松兜底）",
            "description": "所有成功解析的事件全部产生告警（量大，适合接入初期观察）",
            "type": "match", "action": "alert", "enabled": True,
            "scope": "global", "group": "其他",
            "match": "all",
            "conditions": {"logic": "all", "items": [{"field": "parse_status", "op": "in", "value": ["success", "partial"]}]},
            "field_mapping": {
                "alert_name": {"mode": "keep", "value": None},
                "risk_level": {"mode": "keep", "value": None},
            },
        },
    },
]


# ===== 静态段路由（必须注册在 /{rule_id} 之前）=====
@router.get("/templates")
def list_templates(current_user=Depends(require_permission("alert_rule", "view"))):
    """空状态模板快速开始（前端不硬编码，便于扩展）。"""
    return {"items": _TEMPLATES}


@router.get("/export")
def export_rules(
    ids: str = "",
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("alert_rule", "view")),
):
    """导出规则（JSON 配置，含草稿）。

    ids：逗号分隔的规则 ID。传了只导选中的规则；不传导全量。
    """
    query = db.query(AlertRule).order_by(AlertRule.priority.asc(), AlertRule.id.asc())
    if (ids or "").strip():
        # 有选中即严格按选中导出（ID 非法或已删除的不出现在结果里）
        id_list = [int(p) for p in ids.split(",") if p.strip().isdigit()]
        query = query.filter(AlertRule.id.in_(id_list))
    rules = query.all()
    payload = {
        "version": 1,
        "exported_at": beijing_now().strftime("%Y-%m-%d %H:%M:%S"),
        "items": [_serialize(r) for r in rules],
    }
    return JSONResponse(
        content=payload,
        headers={
            "Content-Disposition": f'attachment; filename="alert-rules-{beijing_now().strftime("%Y%m%d%H%M%S")}.json"',
        },
    )


@router.post("/import")
def import_rules(payload: ImportBody, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """批量导入规则（JSON；重名跳过；校验同新建）。"""
    imported, skipped, errors = [], [], []
    seen_names = set()
    for idx, item in enumerate(payload.rules):
        try:
            if item.name in seen_names or db.query(AlertRule.id).filter(AlertRule.name == item.name).first():
                skipped.append(item.name)
                continue
            rule = _rule_from_body(item, db, current_user)
            db.add(rule)
            seen_names.add(item.name)
            imported.append(item.name)
        except HTTPException as e:
            errors.append(f"第 {idx + 1} 条「{item.name}」：{e.detail}")
        except Exception as e:  # noqa: BLE001
            errors.append(f"第 {idx + 1} 条「{item.name}」：{e}")
    db.commit()
    invalidate_alert_rules_cache()
    _log_audit(request, "alert_rules.import", f"导入告警规则：成功 {len(imported)} / 跳过 {len(skipped)} / 失败 {len(errors)}", current_user)
    return {"imported": len(imported), "skipped": skipped, "errors": errors}


@router.post("/test")
def test_rules(
    payload: TestBody,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("alert_rule", "view")),
):
    """规则测试（只读不落库、不产生真实告警）。

    - 匹配链：线上启用规则 + 草稿（按优先级），逐规则展示作用域判定与
      嵌套条件明细（每个条件命中/未命中）；
    - 统计模拟：统计类规则把样例依次计入临时滑动窗口（不污染线上
      计数），逐样例展示分组键 → 计数 → 是否达阈值；
    - 最终动作：命中/统计触发的规则应用字段配置与覆盖项后的告警预览
      （名称模板渲染、等级、标签）。
    """
    if len(payload.samples) > 10:
        raise HTTPException(422, detail="测试样例最多 10 条")
    draft = payload.draft_rule
    # 草稿规则：先校验 IP 条件值（测试接口不走保存路径，需独立拦截）
    if draft is not None:
        raw_conditions = draft.conditions
        if isinstance(raw_conditions, dict):
            for it in raw_conditions.get("items") or []:
                _validate_ip_conditions(it)
        elif isinstance(raw_conditions, list):
            for it in raw_conditions:
                _validate_ip_conditions(it)
    # 草稿规则按引擎 dict 同构化（优先级参与排序；未传草稿时仅测线上启用规则）
    draft_dict = None
    if draft is not None:
        draft_dict = {
            "id": 0,
            "name": draft.name or "草稿规则",
            "priority": draft.priority if isinstance(draft.priority, int) else 100,
            "scope": draft.scope if draft.scope in ("global", "device_type") else "global",
            "device_type": draft.device_type or "",
            "match": draft.match if draft.match in ("all", "any") else "all",
            "conditions": draft.conditions if isinstance(draft.conditions, (list, dict)) else [],
            "rule_type": draft.type if draft.type in VALID_TYPES else "match",
            "action": "alert" if draft.type == "stats" else draft.action,
            "override": draft.override or {},
            "stats_config": draft.stats_config.model_dump() if draft.stats_config else None,
            "field_mapping": draft.field_mapping or {},
            "alert_aggregation": draft.alert_aggregation.model_dump() if draft.alert_aggregation else None,
            "group": draft.group or "其他",
        }
    rules = [r for r in load_enabled_rules()]
    if draft_dict is not None:
        rules.append(draft_dict)
    rules.sort(key=lambda r: (r.get("priority", 100), r["id"]))
    match_rules = [r for r in rules if r.get("rule_type") != "stats"]
    stats_rules = [r for r in rules if r.get("rule_type") == "stats"]

    # 样例 → 范式化事件（fields 即解析后标准字段；parse_status 按成功注入）
    norms = []
    for s in payload.samples:
        fields = dict(s.fields or {})
        norm = NormalizedEvent.from_parse_result(_SampleParseResult(fields))
        norm.set_field("parse_status", "success")
        norms.append(norm)

    # 统计类规则全量模拟（跨样例共享窗口，展示分组计数过程）
    stats_sim: dict[int, list[dict]] = {}
    for srule in stats_rules:
        sims = simulate_stats(srule, norms)
        stats_sim[srule["id"]] = sims

    results = []
    for i, norm in enumerate(norms):
        # 1) 匹配链逐规则明细
        chain = []
        matched_rule = None
        device_type = norm.get_field("device_type") or ""
        for rule in match_rules:
            scope_ok = not (rule.get("scope") == "device_type" and rule.get("device_type") != device_type)
            if not scope_ok:
                chain.append({
                    "rule_id": rule["id"], "rule_name": rule["name"], "action": rule["action"],
                    "matched": False, "reason": f"作用域不匹配（规则限定 {rule.get('device_type') or ''}）",
                })
                continue
            ok, details = _eval_rule_conditions(norm, rule)
            chain.append({
                "rule_id": rule["id"], "rule_name": rule["name"], "action": rule["action"],
                "matched": ok, **({} if ok else {"details": details}),
            })
            if ok and matched_rule is None:
                matched_rule = rule
        # 2) 统计模拟信息（该样例在各统计规则窗口中的计数）
        stats_info = []
        for srule in stats_rules:
            sim = stats_sim[srule["id"]][i]
            stats_info.append({
                "rule_id": srule["id"], "rule_name": srule["name"], **sim,
            })
        # 3) 最终动作
        triggered_stats = next((s for s in stats_info if s.get("triggered")), None)
        if matched_rule is not None:
            if matched_rule["action"] == "suppress":
                reason = (matched_rule.get("override") or {}).get("reason") or ""
                final = {
                    "outcome": "suppressed",
                    "rule_id": matched_rule["id"], "rule_name": matched_rule["name"],
                    "note": f"命中抑制规则「{matched_rule['name']}」" + (f"：{reason}" if reason else "") + "，不产生告警",
                }
            else:
                preview = NormalizedEvent.from_parse_result(_SampleParseResult(dict(norm.to_alert_fields())))
                preview.set_field("parse_status", "success")
                fields = apply_rule_action(preview, matched_rule)
                final = {
                    "outcome": "alert",
                    "rule_id": matched_rule["id"], "rule_name": matched_rule["name"],
                    "action": matched_rule["action"],
                    "alert_name": fields.get("alert_name") or "",
                    "risk_level": fields.get("risk_level"),
                    "risk_level_name": fields.get("risk_level_name") or "",
                    "tags": fields.get("risk_tag") or "",
                }
        elif triggered_stats is not None:
            srule = next(r for r in stats_rules if r["id"] == triggered_stats["rule_id"])
            preview = NormalizedEvent.from_parse_result(_SampleParseResult(dict(norm.to_alert_fields())))
            preview.set_field("parse_status", "success")
            fields = apply_rule_action(preview, srule)
            final = {
                "outcome": "alert",
                "rule_id": srule["id"], "rule_name": srule["name"],
                "action": "stats",
                "alert_name": fields.get("alert_name") or "",
                "risk_level": fields.get("risk_level"),
                "risk_level_name": fields.get("risk_level_name") or "",
                "tags": fields.get("risk_tag") or "",
                "stats": triggered_stats,
            }
        else:
            counted = next((s for s in stats_info if s.get("matched")), None)
            if counted is not None:
                final = {
                    "outcome": "stats_waiting",
                    "rule_id": counted["rule_id"], "rule_name": counted["rule_name"],
                    "note": f"计入统计窗口（{counted.get('group_key') or '全部分组'}：当前 {counted.get('count')}/{counted.get('threshold')}），未达阈值不产生告警",
                }
            else:
                final = {
                    "outcome": "no_rule",
                    "note": "未命中任何启用中的告警规则，不产生告警（严格模式）",
                }
        results.append({
            "sample_index": i,
            "fields": norm.to_alert_fields(),
            "chain": chain,
            "stats": stats_info,
            "final": final,
        })

    return {
        "rules_enabled": len([r for r in rules if r.get("id") != 0]),
        "results": results,
        "note": "测试只读不落库；统计模拟不污染线上窗口计数",
    }


# ===== CRUD =====
@router.get("")
def list_rules(
    search: str = "",
    group: str = "",
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("alert_rule", "view")),
):
    """规则列表（含草稿；条件摘要由前端渲染）。"""
    q = db.query(AlertRule).order_by(AlertRule.priority.asc(), AlertRule.id.asc())
    if search:
        q = q.filter(AlertRule.name.ilike(f"%{search}%"))
    if group:
        q = q.filter(AlertRule.rule_group == group)
    rules = q.all()
    # 今日命中 / 最近命中（与统计卡同一口径，命中记录仅保留近 7 天）
    from datetime import datetime as _dt, timedelta as _td

    today_start = _dt.strptime(beijing_now().strftime("%Y-%m-%d"), "%Y-%m-%d")
    since_24h = beijing_now() - _td(hours=24)
    today_rows = (
        db.query(AlertRuleHit.rule_id, sa_func.count(AlertRuleHit.id))
        .filter(AlertRuleHit.matched_at >= today_start)
        .group_by(AlertRuleHit.rule_id)
        .all()
    )
    last_rows = (
        db.query(AlertRuleHit.rule_id, sa_func.max(AlertRuleHit.matched_at))
        .group_by(AlertRuleHit.rule_id)
        .all()
    )
    today_map = {r[0]: int(r[1] or 0) for r in today_rows}
    last_map = {r[0]: r[1] for r in last_rows}
    items = []
    for r in rules:
        item = _serialize(r)
        item["today_hits"] = today_map.get(r.id, 0)
        item["last_hit_at"] = last_map[r.id].strftime("%Y-%m-%d %H:%M:%S") if last_map.get(r.id) else None
        item["has_hit_24h"] = bool(last_map.get(r.id) and last_map[r.id] >= since_24h)
        items.append(item)
    return {"items": items}


@router.post("")
def create_rule(payload: RuleCreate, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """新建规则（draft=1 存为草稿，不参与线上匹配）。"""
    rule = _rule_from_body(payload, db, current_user)
    db.add(rule)
    db.commit()
    db.refresh(rule)
    invalidate_alert_rules_cache()
    _log_audit(request, "alert_rules.create", f"新建告警规则「{rule.name}」（#{rule.id}，type={rule.rule_type}，draft={rule.draft}）", current_user)
    return _serialize(rule)


@router.put("/{rule_id}")
def update_rule(rule_id: int, payload: RuleUpdate, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """更新规则（全量 PUT；draft=1 转为草稿下线）。"""
    rule = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not rule:
        raise HTTPException(404, detail="规则不存在")
    _apply_body_to_rule(rule, payload, db, current_user)
    db.commit()
    db.refresh(rule)
    invalidate_alert_rules_cache()
    _log_audit(request, "alert_rules.update", f"更新告警规则「{rule.name}」（#{rule.id}，draft={rule.draft}）", current_user)
    return _serialize(rule)


@router.delete("/{rule_id}")
def delete_rule(rule_id: int, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """删除规则（命中记录随规则清理；统计窗口随缓存失效清零）。"""
    rule = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not rule:
        raise HTTPException(404, detail="规则不存在")
    name = rule.name
    db.delete(rule)
    db.query(AlertRuleHit).filter(AlertRuleHit.rule_id == rule_id).delete()
    db.commit()
    invalidate_alert_rules_cache()
    _log_audit(request, "alert_rules.delete", f"删除告警规则「{name}」（#{rule_id}）", current_user)
    return {"ok": True}


@router.post("/{rule_id}/publish")
def publish_rule(rule_id: int, payload: PublishBody, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """发布规则（草稿门禁：服务端用测试样例复验，通过才上线）。

    - 匹配类规则：任一样例命中（作用域 + 条件）即通过；
    - 统计类规则：样例依次计入同一模拟窗口，达到阈值即通过；
    - 通过后 draft=0、记录 last_test_passed_at（发布门禁时间戳）。
    """
    rule = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not rule:
        raise HTTPException(404, detail="规则不存在")
    from app.core.log_receiver_manager.pipeline.alert_rule_stage import _rule_to_engine_dict

    engine_dict = _rule_to_engine_dict(rule)
    norms = []
    for s in payload.test_samples:
        norm = NormalizedEvent.from_parse_result(_SampleParseResult(dict(s.fields or {})))
        norm.set_field("parse_status", "success")
        norms.append(norm)
    ok, msg = verify_rule_passes_samples(engine_dict, norms)
    if not ok:
        raise HTTPException(422, detail=f"发布失败：{msg}")
    rule.draft = 0
    rule.last_test_passed_at = beijing_now()
    rule.updated_by = _username(current_user)
    db.commit()
    db.refresh(rule)
    invalidate_alert_rules_cache()
    _log_audit(request, "alert_rules.publish", f"发布告警规则「{rule.name}」（#{rule.id}）", current_user)
    return _serialize(rule)


@router.post("/{rule_id}/toggle")
def toggle_rule(rule_id: int, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """启停规则（停用后不再命中；草稿规则启停仅在发布后生效）。"""
    rule = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not rule:
        raise HTTPException(404, detail="规则不存在")
    rule.enabled = 0 if rule.enabled else 1
    rule.updated_by = _username(current_user)
    db.commit()
    db.refresh(rule)
    invalidate_alert_rules_cache()
    _log_audit(request, "alert_rules.toggle", f"{'启用' if rule.enabled else '停用'}告警规则「{rule.name}」（#{rule.id}）", current_user)
    return _serialize(rule)


@router.post("/{rule_id}/duplicate")
def duplicate_rule(rule_id: int, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """复制规则（新名称后缀「（副本）」，草稿状态）。"""
    rule = db.query(AlertRule).filter(AlertRule.id == rule_id).first()
    if not rule:
        raise HTTPException(404, detail="规则不存在")
    new_name = f"{rule.name}（副本）"
    n = 1
    while db.query(AlertRule.id).filter(AlertRule.name == new_name).first():
        n += 1
        new_name = f"{rule.name}（副本{n}）"
    copy = AlertRule(
        name=new_name,
        description=rule.description,
        enabled=rule.enabled,
        priority=rule.priority,
        scope=rule.scope,
        device_type=rule.device_type,
        match=rule.match,
        conditions=rule.conditions,
        rule_type=rule.rule_type,
        action=rule.action,
        override=rule.override,
        stats_config=rule.stats_config,
        field_mapping=rule.field_mapping,
        alert_aggregation=rule.alert_aggregation,
        rule_group=rule.rule_group,
        draft=1,  # 副本一律为草稿，避免误上线
        created_by=_username(current_user),
        updated_by=_username(current_user),
    )
    db.add(copy)
    db.commit()
    db.refresh(copy)
    invalidate_alert_rules_cache()
    _log_audit(request, "alert_rules.duplicate", f"复制告警规则「{rule.name}」→「{new_name}」", current_user)
    return _serialize(copy)


@router.post("/reorder")
def reorder_rules(payload: dict, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """批量保存优先级（按传入 id 顺序重排 priority）。"""
    ids = payload.get("ids") or []
    if not ids:
        return {"ok": True}
    for idx, rid in enumerate(ids):
        rule = db.query(AlertRule).filter(AlertRule.id == rid).first()
        if rule:
            rule.priority = (idx + 1) * 10
            rule.updated_by = _username(current_user)
    db.commit()
    invalidate_alert_rules_cache()
    return {"ok": True}


@router.post("/batch")
def batch_rules(payload: dict, request: Request, db: Session = Depends(get_db), current_user=Depends(require_permission("alert_rule", "edit"))):
    """批量启用/停用/删除（ids + op=enable|disable|delete）。"""
    ids = payload.get("ids") or []
    op = payload.get("op")
    if not ids or op not in ("enable", "disable", "delete"):
        raise HTTPException(422, detail="参数：ids + op=enable|disable|delete")
    rules = db.query(AlertRule).filter(AlertRule.id.in_(ids)).all()
    for rule in rules:
        if op == "delete":
            db.delete(rule)
            db.query(AlertRuleHit).filter(AlertRuleHit.rule_id == rule.id).delete()
        elif op == "enable":
            rule.enabled = 1
            rule.updated_by = _username(current_user)
        else:
            rule.enabled = 0
            rule.updated_by = _username(current_user)
    db.commit()
    invalidate_alert_rules_cache()
    _log_audit(request, f"alert_rules.batch_{op}", f"批量{op} {len(rules)} 条告警规则", current_user)
    return {"affected": len(rules)}


# ===== 统计卡 / 命中记录 =====
@router.get("/stats")
def rules_stats(
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("alert_rule", "view")),
):
    """列表页统计卡：总数（启用数）/ 今日告警生成数 / 今日抑制数 / 24h 无命中启用规则数。

    口径：启用数 = enabled 且非草稿（线上生效）；今日 = 北京时间自然日；
    24h 无命中 = 启用非草稿且最近 24 小时零命中（疑似失效警示）。
    """
    from datetime import timedelta as _td

    total = db.query(AlertRule).count()
    enabled = db.query(AlertRule).filter(AlertRule.enabled == 1, AlertRule.draft == 0).count()
    drafts = db.query(AlertRule).filter(AlertRule.draft == 1).count()
    today = beijing_now().strftime("%Y-%m-%d")
    since_24h = beijing_now() - _td(hours=24)
    hit_rows = db.query(AlertRuleHit).all()
    today_alerts = sum(
        1 for h in hit_rows
        if h.action == "alert" and h.matched_at and h.matched_at.strftime("%Y-%m-%d") == today
    )
    today_suppressed = sum(
        1 for h in hit_rows
        if h.action == "suppress" and h.matched_at and h.matched_at.strftime("%Y-%m-%d") == today
    )
    live_ids = {
        r.id for r in db.query(AlertRule.id).filter(AlertRule.enabled == 1, AlertRule.draft == 0).all()
    }
    hit_24h_ids = {h.rule_id for h in hit_rows if h.matched_at and h.matched_at >= since_24h}
    stale = len(live_ids - hit_24h_ids)
    return {
        "total": total,
        "enabled": enabled,
        "drafts": drafts,
        "today_alerts": today_alerts,
        "today_suppressed": today_suppressed,
        "stale": stale,
    }


@router.get("/{rule_id}/hits")
def rule_hits(
    rule_id: int,
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("alert_rule", "view")),
):
    """单规则命中记录（近 7 天；服务端分页）。"""
    q = db.query(AlertRuleHit).filter(AlertRuleHit.rule_id == rule_id)
    total = q.count()
    rows = (
        q.order_by(AlertRuleHit.matched_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": [
            {
                "id": h.id,
                "matched_at": h.matched_at.strftime("%Y-%m-%d %H:%M:%S") if h.matched_at else None,
                "rule_id": h.rule_id,
                "rule_name": h.rule_name,
                "action": h.action,
                "uuid": h.uuid,
                "source_ip": h.source_ip,
                "alert_name": h.alert_name,
                "risk_level": h.risk_level,
                "parse_status": h.parse_status,
            }
            for h in rows
        ],
    }
