"""告警解析入库 API。

- ``POST /ingest/alert``：接收原始告警 JSON（单条或批量），策略路由→解析→入库。
- ``GET/POST/PUT/PATCH/DELETE /ingest/strategies``：解析策略管理（引擎热更新，无需重启）。
- ``POST /ingest/strategies/test``：策略测试解析（纯内存执行，不写库）。
- ``GET /ingest/strategies/fields``：标准模型可选目标字段清单（供表单下拉）。
- ``GET /ingest/errors``：解析错误队列查看。
- ``GET /ingest/metrics``：按小时聚合的入库指标查看。

ingest 端点面向设备/上游系统推送（类 webhook），不做用户态鉴权；
策略/错误队列/指标等管理端点需要登录。
"""
import json
import logging
import re
import secrets
import time
from datetime import datetime, timedelta
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, text as sa_text
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip, log_audit
from app.core.timezone import BEIJING_TZ, beijing_now
from app.database import SessionLocal, get_db
from app.dependencies import get_current_user, require_permission
from app.engine.classifier import ClassifierRouter, ERR_UNKNOWN_LOG_TYPE
from app.engine.enum_translator import translate as enum_translate
from app.engine.extractor import apply_rule_map, extract_fields
from app.engine.field_mapper import apply_mappings
from app.engine.parser_engine import ParseEngine, ParseSink
from app.engine.rule_matcher import _match_condition, _match_rule, normalize_rules, resolve_rule
from app.engine.strategy_loader import StrategyLoader, get_path
from app.engine.validator import run_validations
from app.core.log_receiver_manager.pipeline.preprocessors import (
    DEFAULT_PREPROCESSOR_CHAIN,
    run_preprocessor_chain,
)
from app.models.alert_event import AlertEvent
from app.models.device import Device
from app.models.ingestion_metric import IngestionMetric
from app.models.log_receiver import LogReceiver
from app.models.log_source_entry import LogSourceEntry
from app.models.parse_error import ParseErrorQueue
from app.models.parse_strategy import ParseStrategy, ParseStrategyVersion
from app.models.system_config import SystemConfig
from app.models.user import User
from app.models.workflow_ban import WorkflowInstance

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ingest", tags=["ingest"])


# ======================================================================
# 策略缓存（进程级单例，策略变更时刷新）
# ======================================================================
_strategy_loader: Optional[StrategyLoader] = None


def _fetch_strategies() -> list[dict]:
    """从数据库加载全部策略（含 disabled，由 loader 过滤）。"""
    db = SessionLocal()
    try:
        rows = db.query(ParseStrategy).all()
        return [
            {
                "id": r.id,
                "strategy_name": r.strategy_name,
                "device_type": r.device_type,
                "version": r.version,
                "status": r.status,
                "config": r.config,
            }
            for r in rows
        ]
    finally:
        db.close()


def get_strategy_loader() -> StrategyLoader:
    """获取（惰性创建）进程级策略缓存加载器。"""
    global _strategy_loader
    if _strategy_loader is None:
        _strategy_loader = StrategyLoader(fetch_strategies=_fetch_strategies)
    return _strategy_loader


def refresh_strategy_cache() -> None:
    """策略变更后刷新内存缓存。"""
    loader = get_strategy_loader()
    loader.refresh()


# ======================================================================
# SQLAlchemy 持久化后端（ParseSink 协议实现）
# ======================================================================
class SQLAlchemySink:
    """把解析结果写入 alert_events / parse_error_queue / ingestion_metrics。"""

    def __init__(self, db: Session) -> None:
        self.db = db

    def save_alert(self, fields: dict[str, Any]) -> str:
        """写入标准告警表；uuid 重复时跳过并返回 duplicate（幂等）。

        入库成功（parse_status 为 success/partial）后发布 alert.ingested 事件，
        触发封禁工作流（进程内异步队列，不阻塞入库；发布失败不回滚）。
        """
        uuid_val = str(fields.get("uuid") or "")
        if not uuid_val:
            raise ValueError("uuid 缺失，无法入库")
        try:
            exists = self.db.query(AlertEvent.id).filter(AlertEvent.uuid == uuid_val).first()
            if exists:
                return "duplicate"
            alert_row = AlertEvent(**fields)
            self.db.add(alert_row)
            self.db.commit()
            # 发布入库事件（触发封禁工作流；只记日志不回滚入库）
            if str(fields.get("parse_status") or "") in ("success", "partial"):
                try:
                    from app.workflow.trigger import publish_alert_ingested
                    publish_alert_ingested({**fields, "id": alert_row.id})
                except Exception:  # noqa: BLE001
                    logger.exception("alert.ingested 事件发布失败（不影响入库）")
            return "inserted"
        except Exception:
            self.db.rollback()
            raise

    def save_error(
        self,
        raw_data: str,
        error_type: str,
        error_msg: str,
        uuid: Optional[str] = None,
        strategy_id: Optional[int] = None,
    ) -> None:
        """写入解析错误队列。"""
        try:
            self.db.add(
                ParseErrorQueue(
                    uuid=uuid,
                    strategy_id=strategy_id,
                    raw_data=raw_data,
                    error_type=error_type,
                    error_msg=error_msg[:2000],
                )
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise

    def record_metrics(
        self,
        stat_hour: str,
        strategy_id: Optional[int],
        strategy_name: str,
        status: str,
        parse_ms: int,
    ) -> None:
        """按小时原子累加指标（UPDATE 命中则自增，否则 INSERT）。"""
        try:
            # 原子自增（total 与对应状态计数同时 +1）；
            # IS NOT DISTINCT FROM 兼容 strategy_id 为 NULL 的全局行
            sql = sa_text(
                """
                UPDATE ingestion_metrics
                SET total_count = total_count + 1,
                    {status_col} = {status_col} + 1,
                    total_parse_ms = total_parse_ms + :ms,
                    strategy_name = :sname,
                    updated_at = :now
                WHERE stat_hour = :hour AND strategy_id IS NOT DISTINCT FROM :sid
                """.format(status_col=f"{status}_count")
            )
            result = self.db.execute(
                sql,
                {"ms": parse_ms, "sname": strategy_name, "hour": stat_hour,
                 "sid": strategy_id, "now": beijing_now()},
            )
            if result.rowcount == 0:
                self.db.add(
                    IngestionMetric(
                        stat_hour=stat_hour,
                        strategy_id=strategy_id,
                        strategy_name=strategy_name,
                        total_count=1,
                        success_count=1 if status == "success" else 0,
                        partial_count=1 if status == "partial" else 0,
                        fail_count=1 if status == "fail" else 0,
                        total_parse_ms=parse_ms,
                    )
                )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise


# ======================================================================
# Schemas
# ======================================================================
class StrategyStatusBody(BaseModel):
    """策略启停请求体。"""

    status: str = Field(..., description="enabled / disabled")


class StrategyTestRequest(BaseModel):
    """策略测试请求体：策略配置 + 样例原始数据。"""

    config: dict = Field(..., description="策略配置 JSON 全文")
    sample: dict = Field(..., description="样例原始日志 JSON")


class StrategyTestParseRequest(BaseModel):
    """模板测试解析请求体（按模板 ID，多条日志，走完整解析管道但不落库）。"""

    logs: list[str] = Field(..., min_length=1, description="原始日志文本列表（每条一项，支持多条）")
    use_draft: bool = Field(True, description="测试草稿副本（存在时）；False 测线上版本")
    context: dict = Field(
        default_factory=dict,
        description="模拟数据源/接收器上下文 {receiver_id, entry_id}（用于展示实际绑定链与生效模板）",
    )


class StrategyPublishBody(BaseModel):
    """发布请求体。"""

    remark: str = Field("", max_length=500, description="版本说明")


class StrategyRollbackBody(BaseModel):
    """回滚请求体。"""

    version_no: int = Field(..., ge=1, description="回滚到的版本号")
    remark: str = Field("", max_length=500, description="回滚备注")


class IngestResponse(BaseModel):
    """入库结果汇总。"""

    total: int
    success: int
    partial: int
    fail: int
    duplicates: int
    results: list[dict]


# 支持的字段转换类型（表单模式下拉用，与 field_mapper.convert_value 一致）
CONVERT_TYPES = {
    "string", "int", "float", "bool",
    "json_array_to_string", "json_object_to_string",
    "timestamp_to_datetime", "comma_split_to_json", "enum_int",
    "qt_datetime",
}

# 支持的校验规则类型（与 validator.run_validations 一致）
VALIDATION_RULES = {"regex", "range", "ip_list_valid", "positive_int"}

# 标准模型中由引擎自动写入的系统字段，不出现在目标字段下拉里
SYSTEM_TARGET_FIELDS = {"id", "created_at", "raw_data", "parse_status", "parse_warnings", "strategy_id", "device_type", "extensions"}


def _validate_strategy_config(config: dict) -> None:
    """校验策略配置结构，失败抛 422（带具体原因）。"""
    if not isinstance(config, dict):
        raise HTTPException(status_code=422, detail="策略配置必须是 JSON 对象")

    name = config.get("strategy_name")
    if not name or not str(name).strip():
        raise HTTPException(status_code=422, detail="strategy_name 不能为空")

    device_type = config.get("device_type")
    if not device_type or not str(device_type).strip():
        raise HTTPException(status_code=422, detail="device_type 不能为空")

    status = config.get("status", "enabled")
    if status not in ("enabled", "disabled"):
        raise HTTPException(status_code=422, detail=f"status 仅支持 enabled/disabled，当前 {status!r}")

    # 新结构：rules[] 多规则；旧结构退化为单规则校验
    if config.get("rules") is not None:
        _validate_rules_config(config)
        return

    rules = config.get("route_rules")
    if not isinstance(rules, dict) or not rules.get("match_field"):
        raise HTTPException(status_code=422, detail="route_rules.match_field 不能为空")
    match_type = str(rules.get("match_type") or "exact").lower()
    if match_type not in ("exact", "regex"):
        raise HTTPException(status_code=422, detail=f"route_rules.match_type 仅支持 exact/regex，当前 {match_type!r}")
    if rules.get("match_value") in (None, ""):
        raise HTTPException(status_code=422, detail="route_rules.match_value 不能为空")
    if match_type == "regex":
        try:
            re.compile(str(rules["match_value"]))
        except re.error as exc:
            raise HTTPException(status_code=422, detail=f"route_rules.match_value 正则非法: {exc}")

    wrapper = config.get("outer_wrapper")
    if wrapper is not None and not isinstance(wrapper, dict):
        raise HTTPException(status_code=422, detail="outer_wrapper 必须是对象")

    mappings = config.get("field_mappings")
    if mappings is not None:
        if not isinstance(mappings, list):
            raise HTTPException(status_code=422, detail="field_mappings 必须是数组")
        for i, m in enumerate(mappings, 1):
            if not isinstance(m, dict) or not m.get("source") or not m.get("target"):
                raise HTTPException(status_code=422, detail=f"field_mappings 第 {i} 行缺少 source/target")
            if m.get("type") and m["type"] not in CONVERT_TYPES:
                raise HTTPException(
                    status_code=422,
                    detail=f"field_mappings 第 {i} 行转换类型 {m['type']!r} 不支持（可选：{', '.join(sorted(CONVERT_TYPES))}）",
                )

    enum_maps = config.get("enum_maps")
    if enum_maps is not None:
        if not isinstance(enum_maps, dict):
            raise HTTPException(status_code=422, detail="enum_maps 必须是对象（枚举名 → 原值→翻译值 映射）")
        for ename, table in enum_maps.items():
            if not isinstance(table, dict):
                raise HTTPException(status_code=422, detail=f"enum_maps.{ename} 必须是对象（原值 → 翻译值）")

    validations = config.get("validations")
    if validations is not None:
        if not isinstance(validations, list):
            raise HTTPException(status_code=422, detail="validations 必须是数组")
        for i, v in enumerate(validations, 1):
            if not isinstance(v, dict) or not v.get("field") or not v.get("rule"):
                raise HTTPException(status_code=422, detail=f"validations 第 {i} 行缺少 field/rule")
            if v["rule"] not in VALIDATION_RULES:
                raise HTTPException(
                    status_code=422,
                    detail=f"validations 第 {i} 行规则 {v['rule']!r} 不支持（可选：{', '.join(sorted(VALIDATION_RULES))}）",
                )
            if v["rule"] == "regex":
                try:
                    re.compile(str(v.get("pattern") or ""))
                except re.error as exc:
                    raise HTTPException(status_code=422, detail=f"validations 第 {i} 行正则非法: {exc}")

    ext_fields = config.get("extension_fields")
    if ext_fields is not None and not isinstance(ext_fields, list):
        raise HTTPException(status_code=422, detail="extension_fields 必须是字符串数组")


def _validate_rules_config(config: dict) -> None:
    """校验新结构 rules[] 的每一规则（match / extract / map）。

    规则字段：
    - rule_id / log_type / enabled
    - match: {type: all|any, conditions:[{field,op,value}]}
    - extract: {type: fields|regex|template, ...}
    - map: {field_mappings, enum_maps, defaults, validations}
    """
    rules = config.get("rules")
    if not isinstance(rules, list) or not rules:
        raise HTTPException(status_code=422, detail="rules 必须是非空数组")

    wrapper = config.get("outer_wrapper")
    if wrapper is not None and not isinstance(wrapper, dict):
        raise HTTPException(status_code=422, detail="outer_wrapper 必须是对象")

    for i, rule in enumerate(rules, 1):
        if not isinstance(rule, dict):
            raise HTTPException(status_code=422, detail=f"rules 第 {i} 条必须是对象")
        if not rule.get("rule_id"):
            raise HTTPException(status_code=422, detail=f"rules 第 {i} 条缺少 rule_id")
        # match 校验
        match = rule.get("match") or {}
        if not isinstance(match, dict):
            raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] match 必须是对象")
        combine = str(match.get("type") or "all").lower()
        if combine not in ("all", "any"):
            raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] match.type 仅支持 all/any")
        conditions = match.get("conditions") or []
        if not isinstance(conditions, list):
            raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] match.conditions 必须是数组")
        for c in conditions:
            if not c.get("field") or not c.get("op"):
                raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] 条件缺少 field/op")
        # extract 校验
        extract = rule.get("extract") or {}
        etype = (extract or {}).get("type") or "fields"
        if etype == "regex" and not (extract or {}).get("regex"):
            raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] extract(regex) 缺少 regex 表达式")
        if etype == "fields":
            mappings = (extract or {}).get("fields") or []
            if not isinstance(mappings, list):
                raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] extract.fields 必须是数组")
            for j, m in enumerate(mappings, 1):
                if not m.get("source") or not m.get("target"):
                    raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] extract.fields 第 {j} 行缺少 source/target")
                if m.get("type") and m["type"] not in CONVERT_TYPES:
                    raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] extract.fields 第 {j} 行转换类型 {m['type']!r} 不支持")
        # map 校验
        rmap = rule.get("map") or {}
        if not isinstance(rmap, dict):
            raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] map 必须是对象")
        for ename, table in (rmap.get("enum_maps") or {}).items():
            if not isinstance(table, dict):
                raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] map.enum_maps.{ename} 必须是对象")
        for v in rmap.get("validations") or []:
            if not isinstance(v, dict) or not v.get("field") or not v.get("rule"):
                raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] map.validations 缺少 field/rule")
            if v["rule"] not in VALIDATION_RULES:
                raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] map.validations 规则 {v['rule']!r} 不支持")
            if v["rule"] == "regex":
                try:
                    re.compile(str(v.get("pattern") or ""))
                except re.error as exc:
                    raise HTTPException(status_code=422, detail=f"rules[{rule.get('rule_id')}] map.validations 正则非法: {exc}")


def _json_safe(value: Any) -> Any:
    """递归把值转为可 JSON 序列化结构（datetime → ISO 字符串）。"""
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, dict):
        return {k: _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def _preview(value: Any, limit: int = 80) -> Any:
    """测试结果展示用：长值截断。"""
    if isinstance(value, (dict, list)):
        value = json.dumps(value, ensure_ascii=False)
    if isinstance(value, datetime):
        return value.isoformat(sep=" ")
    if isinstance(value, str) and len(value) > limit:
        return value[:limit] + "…"
    return value


# ======================================================================
# 告警接入（设备/上游系统推送）
# ======================================================================
# 摄入限流（内存滑动窗口，单实例部署足够；多实例可升级为 Redis）
_INGEST_RATE_WINDOW_S = 60.0
_INGEST_RATE_MAX = 600  # 每 IP 每分钟最多推送 600 条
_INGEST_BATCH_MAX = 1000  # 单次请求最多 1000 条告警
_ingest_rate_bucket: dict[str, tuple[float, int]] = {}

_INGEST_KEY = "ingest.alert_api_key"


def _check_ingest_access(request: Request, db: Session) -> None:
    """告警摄入鉴权：X-API-Key（系统配置 ``ingest.alert_api_key``）+ IP 限流。

    安全设计：
    - Key 未配置时直接拒绝（fail-closed），避免匿名推送灌假告警、
      间接触发自动封禁工作流；
    - 恒时比较（secrets.compare_digest）防时序侧信道；
    - 单 IP 每分钟限流，防滥用。
    """
    cfg = db.query(SystemConfig).filter(SystemConfig.key == _INGEST_KEY).first()
    expected = (cfg.value or "").strip() if cfg else ""
    if not expected:
        logger.warning("告警摄入拒绝请求：未配置 API Key（system_config: %s）", _INGEST_KEY)
        raise HTTPException(
            status_code=503,
            detail="告警摄入未配置 API Key，请联系管理员在系统设置中配置 ingest.alert_api_key",
        )
    provided = (request.headers.get("X-API-Key") or "").strip()
    if not provided or not secrets.compare_digest(provided, expected):
        logger.warning("告警摄入 API Key 校验失败: client=%s", get_client_ip(request))
        raise HTTPException(status_code=401, detail="API Key 无效")

    now = time.monotonic()
    client = get_client_ip(request)
    window_start, count = _ingest_rate_bucket.get(client, (now, 0))
    if now - window_start > _INGEST_RATE_WINDOW_S:
        window_start, count = now, 0
    count += 1
    _ingest_rate_bucket[client] = (window_start, count)
    if count > _INGEST_RATE_MAX:
        raise HTTPException(status_code=429, detail="推送过于频繁，请稍后再试")


@router.post("/alert", response_model=IngestResponse)
async def ingest_alert(request: Request, db: Session = Depends(get_db)) -> IngestResponse:
    """接收原始告警 JSON（单条对象或数组），解析入库。

    - 单条：直接传对象 ``{"type": "security_alert", ...}``；
    - 批量：传数组 ``[ {...}, {...} ]``；
    - 需携带请求头 ``X-API-Key``（系统配置 ``ingest.alert_api_key``）；
    - 无匹配策略 / 解析失败的数据进入错误队列，不阻断其余数据。
    """
    _check_ingest_access(request, db)

    try:
        payload = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="请求体不是合法 JSON")

    items = payload if isinstance(payload, list) else [payload]
    if not items:
        raise HTTPException(status_code=400, detail="请求体为空")
    if len(items) > _INGEST_BATCH_MAX:
        raise HTTPException(
            status_code=413,
            detail=f"单次最多推送 {_INGEST_BATCH_MAX} 条告警，请分批提交",
        )

    # 策略缓存为空时自动刷新（首次请求或策略刚创建）
    loader = get_strategy_loader()
    if not loader.strategies:
        loader.refresh()

    engine = ParseEngine(loader=loader, sink=SQLAlchemySink(db))
    stats = engine.process(items)
    return IngestResponse(**stats)


# ======================================================================
# 策略管理（需要登录 + strategy 权限）
# ======================================================================
def _today_metrics_by_strategy(db: Session) -> dict[int, dict]:
    """按 strategy_id 聚合今日指标 ``{sid: {"total": n, "fail": n}}``。"""
    today_prefix = beijing_now().strftime("%Y-%m-%dT")
    rows = (
        db.query(IngestionMetric)
        .filter(IngestionMetric.stat_hour.like(today_prefix + "%"))
        .all()
    )
    agg: dict[int, dict] = {}
    for m in rows:
        if m.strategy_id is None:
            continue  # strategy_id 为 NULL 的行是无匹配策略告警，不计入单策略
        item = agg.setdefault(m.strategy_id, {"total": 0, "fail": 0})
        item["total"] += m.total_count or 0
        item["fail"] += m.fail_count or 0
    return agg


@router.get("/strategies", dependencies=[Depends(require_permission("strategy", "view"))])
def list_strategies(db: Session = Depends(get_db)) -> list[dict]:
    """列出全部解析策略（含今日解析统计与条目/接收器引用数）。"""
    rows = db.query(ParseStrategy).order_by(ParseStrategy.id.desc()).all()
    today_stats = _today_metrics_by_strategy(db)
    # 引用统计：数据源条目（条目级绑定）与接收器（默认模板绑定）
    entry_counts = {
        sid: int(cnt)
        for sid, cnt in db.query(
            LogSourceEntry.strategy_id, func.count(LogSourceEntry.id)
        ).group_by(LogSourceEntry.strategy_id).all()
    }
    receiver_counts = {
        sid: int(cnt)
        for sid, cnt in db.query(
            LogReceiver.strategy_id, func.count(LogReceiver.id)
        ).group_by(LogReceiver.strategy_id).all()
    }
    result = []
    for r in rows:
        try:
            config = json.loads(r.config) if isinstance(r.config, str) else (r.config or {})
        except (ValueError, TypeError):
            config = {}
        stat = today_stats.get(r.id, {"total": 0, "fail": 0})
        total, fail = stat["total"], stat["fail"]
        result.append(
            {
                "id": r.id,
                "strategy_name": r.strategy_name,
                "device_type": r.device_type,
                "version": r.version,
                "status": r.status,
                "config": config,
                "has_draft": bool(r.draft_config),
                "published_version_no": r.published_version_no,
                "today_total": total,
                "today_fail": fail,
                "today_success_rate": round((total - fail) * 100.0 / total, 1) if total else None,
                "entry_count": entry_counts.get(r.id, 0),
                "receiver_count": receiver_counts.get(r.id, 0),
                "created_at": r.created_at,
                "updated_at": r.updated_at,
            }
        )
    return result


@router.get("/strategies/stats", dependencies=[Depends(require_permission("strategy", "view"))])
def strategy_stats(db: Session = Depends(get_db)) -> dict:
    """策略列表页顶部统计卡片数据。"""
    rows = db.query(ParseStrategy).all()
    enabled_count = sum(1 for r in rows if r.status == "enabled")
    device_types = {r.device_type for r in rows if r.device_type}

    today_prefix = beijing_now().strftime("%Y-%m-%dT")
    mrows = (
        db.query(IngestionMetric)
        .filter(IngestionMetric.stat_hour.like(today_prefix + "%"))
        .all()
    )
    today_total = 0
    today_no_match = 0
    for m in mrows:
        today_total += m.total_count or 0
        if m.strategy_id is None:
            # strategy_id 为 NULL 的指标行来自「无匹配策略」错误路径
            today_no_match += m.total_count or 0

    # 近24小时解析量趋势（统计卡片 sparkline）：整点小时标签 + 逐小时接收量
    # stat_hour 形如 "2026-10-09T14:30"，上界用下一整点标签做严格小于，避免漏掉当前小时的分钟桶
    now_bj = beijing_now()
    trend_hours = [(now_bj - timedelta(hours=i)).strftime("%Y-%m-%dT%H") for i in range(24)]
    next_hour = (now_bj + timedelta(hours=1)).strftime("%Y-%m-%dT%H")
    trows = (
        db.query(IngestionMetric)
        .filter(IngestionMetric.stat_hour >= trend_hours[-1])
        .filter(IngestionMetric.stat_hour < next_hour)
        .all()
    )
    by_hour: dict[str, int] = {}
    for m in trows:
        key = (m.stat_hour or "")[:13]
        by_hour[key] = by_hour.get(key, 0) + (m.total_count or 0)
    trend_24h = [{"hour": h, "total": by_hour.get(h, 0)} for h in reversed(trend_hours)]

    return {
        "enabled_count": enabled_count,
        "strategy_count": len(rows),
        "device_type_count": len(device_types),
        "today_total": today_total,
        "today_no_match": today_no_match,
        "trend_24h": trend_24h,
    }


@router.get("/strategies/fields", dependencies=[Depends(require_permission("strategy", "view"))])
def strategy_target_fields() -> list[dict]:
    """返回标准模型（alert_events）全部可选目标字段及类型，供表单模式下拉选择。"""
    type_map = {"VARCHAR": "string", "TEXT": "string", "INTEGER": "int", "DATETIME": "datetime"}
    result = []
    for col in AlertEvent.__table__.columns:
        if col.name in SYSTEM_TARGET_FIELDS:
            continue
        result.append(
        {
            "name": col.name,
            "type": type_map.get(str(col.type).split("(")[0].upper(), "string"),
            "comment": col.comment or "",
        }
    )
    return result


def _strategy_rule_field_stats(config: dict) -> tuple[int, int]:
    """统计策略的规则数与字段覆盖数（取所有规则 extract.fields 的 target 并集）。"""
    rules = normalize_rules(config) if config else []
    targets: set[str] = set()
    for r in rules:
        for f in (r.get("extract", {}) or {}).get("fields", []) or []:
            t = (f or {}).get("target")
            if t:
                targets.add(t)
    return len(rules), len(targets)


@router.get("/strategies/recommend", dependencies=[Depends(get_current_user)])
def recommend_strategies(
    device_type: str = Query("", description="设备类型标识，空则返回全部"),
    db: Session = Depends(get_db),
) -> list[dict]:
    """按设备类型推荐解析策略（存量 enabled 优先，内置补充）。

    供设备接入向导第 3 步"解析模板"选择。返回每个策略的规则数与字段覆盖数便于判断覆盖度。
    """
    result: list[dict] = []
    seen_names: set[str] = set()

    # 1) 存量策略（数据库）：enabled 排前
    q = db.query(ParseStrategy)
    if device_type:
        q = q.filter(ParseStrategy.device_type == device_type)
    for s in q.order_by(ParseStrategy.status.desc(), ParseStrategy.id.asc()):
        name = s.strategy_name or ""
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        cfg = _load_json(s.config, {})
        rule_count, field_count = _strategy_rule_field_stats(cfg)
        result.append(
            {
                "id": s.id,
                "strategy_name": name,
                "device_type": s.device_type or "",
                "version": s.version or "",
                "status": s.status or "",
                "rule_count": rule_count,
                "field_count": field_count,
                "source": "db",
            }
        )

    # 2) 内置策略文件（补充未入库的）
    from app.engine.strategy_seed import BUILTIN_STRATEGIES, load_builtin_strategy

    for filename in BUILTIN_STRATEGIES:
        cfg = load_builtin_strategy(filename)
        if not cfg:
            continue
        dt = cfg.get("device_type", "")
        if device_type and dt != device_type:
            continue
        name = cfg.get("strategy_name", "")
        if not name or name in seen_names:
            continue
        seen_names.add(name)
        rule_count, field_count = _strategy_rule_field_stats(cfg)
        result.append(
            {
                "id": None,
                "strategy_name": name,
                "device_type": dt,
                "version": str(cfg.get("version", "1.0")),
                "status": cfg.get("status", "enabled"),
                "rule_count": rule_count,
                "field_count": field_count,
                "source": "builtin",
            }
        )

    return result


@router.post("/strategies", status_code=201)
def create_strategy(
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("strategy", "edit")),
) -> dict:
    """创建解析策略（新建即发布生效，生成 v1 版本快照，刷新内存缓存）。"""
    _validate_strategy_config(body)
    strat = ParseStrategy(
        strategy_name=str(body["strategy_name"]).strip(),
        device_type=str(body["device_type"]).strip(),
        version=str(body.get("version") or "1.0"),
        status=body.get("status") or "enabled",
        config=json.dumps(body, ensure_ascii=False),
        published_version_no=1,
    )
    db.add(strat)
    db.flush()
    db.add(
        ParseStrategyVersion(
            strategy_id=strat.id,
            version_no=1,
            config=json.dumps(body, ensure_ascii=False),
            published_by="",
            remark="初始版本（创建模板）",
        )
    )
    db.commit()
    db.refresh(strat)
    refresh_strategy_cache()
    log_audit(
        db,
        user_id=getattr(user, "id", None),
        username=getattr(user, "username", ""),
        action="create",
        resource_type="strategy",
        resource_id=strat.id,
        detail={"strategy_name": strat.strategy_name, "device_type": strat.device_type},
        ip_address=get_client_ip(request),
    )
    logger.info("解析策略创建: id=%s name=%s", strat.id, strat.strategy_name)
    return {"id": strat.id, "strategy_name": strat.strategy_name, "published_version_no": 1}


class StrategyImportBody(BaseModel):
    """模板导入请求体：单模板 config 或批量 configs（与导出文件格式一致）。"""

    config: dict | None = Field(None, description="单模板配置 JSON")
    configs: list[dict] | None = Field(None, description="批量模板配置 JSON 数组")


@router.get("/strategies/{strategy_id}/export", dependencies=[Depends(require_permission("strategy", "export"))])
def export_strategy(strategy_id: int, db: Session = Depends(get_db)) -> Response:
    """导出模板为 JSON 文件（测试/生产环境迁移）。

    导出内容即策略 config 全文（与编辑器保存的结构一致），
    可直接通过 ``POST /strategies/import`` 在目标环境导入。
    """
    strat = _get_strategy_or_404(db, strategy_id)
    cfg = _load_json(strat.config, {})
    if not isinstance(cfg, dict) or not cfg:
        raise HTTPException(status_code=422, detail="模板配置为空，无法导出")
    payload = json.dumps(cfg, ensure_ascii=False, indent=2)
    from urllib.parse import quote

    filename = quote(f"{strat.strategy_name}.json")
    return Response(
        content=payload,
        media_type="application/json",
        headers={
            "Content-Disposition": f"attachment; filename=strategy_{strat.id}.json; filename*=UTF-8''{filename}",
        },
    )


@router.post("/strategies/import")
def import_strategies(
    body: StrategyImportBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("strategy", "import")),
) -> dict:
    """从 JSON 导入模板：校验结构，名称冲突自动重命名，写入审计日志。

    - 支持单模板（``config``）或批量（``configs``）；
    - 每个模板先走 ``_validate_strategy_config`` 结构校验，任一失败则整批拒绝（不部分导入）；
    - 与存量模板同名时自动追加 ``(导入N)`` 后缀，原名在返回项 ``renamed_from`` 中保留。
    """
    items: list[dict] = []
    if body.configs:
        items.extend(body.configs)
    if body.config:
        items.append(body.config)
    if not items:
        raise HTTPException(status_code=422, detail="导入内容为空（config/configs 至少提供一项）")

    # 先整批校验，避免部分导入
    for i, cfg in enumerate(items, 1):
        _validate_strategy_config(cfg)

    results: list[dict] = []
    batch_names: set[str] = set()
    for cfg in items:
        original_name = str(cfg["strategy_name"]).strip()
        final_name = original_name
        n = 1
        # 与存量 + 同批先导入的名称冲突时追加 (导入N) 后缀
        while (
            final_name in batch_names
            or db.query(ParseStrategy.id).filter(ParseStrategy.strategy_name == final_name).first()
        ):
            n += 1
            final_name = f"{original_name}(导入{n})"
        batch_names.add(final_name)
        cfg = {**cfg, "strategy_name": final_name}
        config_text = json.dumps(cfg, ensure_ascii=False)
        strat = ParseStrategy(
            strategy_name=final_name,
            device_type=str(cfg["device_type"]).strip(),
            version=str(cfg.get("version") or "1.0"),
            status=cfg.get("status") or "enabled",
            config=config_text,
            published_version_no=1,
        )
        db.add(strat)
        db.flush()
        db.add(
            ParseStrategyVersion(
                strategy_id=strat.id,
                version_no=1,
                config=config_text,
                published_by=getattr(user, "username", "") or "",
                remark="导入模板",
            )
        )
        results.append({
            "id": strat.id,
            "strategy_name": final_name,
            "renamed_from": original_name if final_name != original_name else None,
        })
    db.commit()
    refresh_strategy_cache()
    log_audit(
        db,
        user_id=getattr(user, "id", None),
        username=getattr(user, "username", ""),
        action="upload",
        resource_type="strategy",
        detail={
            "operation": "import",
            "count": len(results),
            "items": [
                {"id": r["id"], "strategy_name": r["strategy_name"], "renamed_from": r["renamed_from"]}
                for r in results
            ],
        },
        ip_address=get_client_ip(request),
    )
    logger.info("解析策略导入: %s 个（其中重命名 %s 个）", len(results),
                sum(1 for r in results if r["renamed_from"]))
    return {"imported": len(results), "items": results}


@router.put("/strategies/{strategy_id}")
def update_strategy(
    strategy_id: int,
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("strategy", "edit")),
) -> dict:
    """保存编辑：写入草稿副本（线上版本继续生效，不刷新缓存）。

    草稿测试通过后调用 ``POST /strategies/{id}/publish`` 替换线上版本。
    """
    strat = db.query(ParseStrategy).filter(ParseStrategy.id == strategy_id).first()
    if not strat:
        raise HTTPException(status_code=404, detail="策略不存在")
    _validate_strategy_config(body)
    strat.draft_config = json.dumps(body, ensure_ascii=False)
    db.commit()
    log_audit(
        db,
        user_id=getattr(user, "id", None),
        username=getattr(user, "username", ""),
        action="update",
        resource_type="strategy",
        resource_id=strategy_id,
        detail={"operation": "save_draft", "strategy_name": strat.strategy_name},
        ip_address=get_client_ip(request),
    )
    logger.info("解析策略草稿保存: id=%s（线上版本不受影响）", strat.id)
    return {"id": strat.id, "draft_saved": True}


@router.patch("/strategies/{strategy_id}/status")
def update_strategy_status(
    strategy_id: int,
    body: StrategyStatusBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("strategy", "edit")),
) -> dict:
    """启用/停用解析策略（立即生效）。"""
    if body.status not in ("enabled", "disabled"):
        raise HTTPException(status_code=422, detail="status 仅支持 enabled/disabled")
    strat = db.query(ParseStrategy).filter(ParseStrategy.id == strategy_id).first()
    if not strat:
        raise HTTPException(status_code=404, detail="策略不存在")
    old_status = strat.status
    strat.status = body.status
    db.commit()
    refresh_strategy_cache()
    log_audit(
        db,
        user_id=getattr(user, "id", None),
        username=getattr(user, "username", ""),
        action="update",
        resource_type="strategy",
        resource_id=strategy_id,
        detail={
            "operation": "toggle_status",
            "strategy_name": strat.strategy_name,
            "changes": {"status": {"old": old_status, "new": body.status}},
        },
        ip_address=get_client_ip(request),
    )
    logger.info("解析策略启停: id=%s status=%s", strat.id, body.status)
    return {"id": strat.id, "status": strat.status}


@router.delete("/strategies/{strategy_id}", status_code=204)
def delete_strategy(
    strategy_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("strategy", "delete")),
) -> None:
    """删除解析策略。

    删除前自动解除所有引用（历史告警、解析错误、入库指标、工作流实例等
    的 strategy_id 置 NULL），避免产生指向已删策略的孤儿记录。
    """
    strat = db.query(ParseStrategy).filter(ParseStrategy.id == strategy_id).first()
    if not strat:
        raise HTTPException(status_code=404, detail="策略不存在")

    # 解除引用：历史告警 / 解析错误 / 入库指标 / 工作流封禁实例 / 日志接收器 / 设备
    db.query(AlertEvent).filter(AlertEvent.strategy_id == strategy_id).update(
        {AlertEvent.strategy_id: None}, synchronize_session=False
    )
    db.query(ParseErrorQueue).filter(ParseErrorQueue.strategy_id == strategy_id).update(
        {ParseErrorQueue.strategy_id: None}, synchronize_session=False
    )
    db.query(IngestionMetric).filter(IngestionMetric.strategy_id == strategy_id).update(
        {IngestionMetric.strategy_id: None, IngestionMetric.strategy_name: ""},
        synchronize_session=False,
    )
    db.query(WorkflowInstance).filter(WorkflowInstance.strategy_id == strategy_id).update(
        {WorkflowInstance.strategy_id: None}, synchronize_session=False
    )
    db.query(LogReceiver).filter(LogReceiver.strategy_id == strategy_id).update(
        {LogReceiver.strategy_id: None}, synchronize_session=False
    )
    db.query(Device).filter(Device.parser_strategy_id == strategy_id).update(
        {Device.parser_strategy_id: None}, synchronize_session=False
    )

    db.delete(strat)
    db.commit()
    refresh_strategy_cache()
    log_audit(
        db,
        user_id=getattr(user, "id", None),
        username=getattr(user, "username", ""),
        action="delete",
        resource_type="strategy",
        resource_id=strategy_id,
        detail={"strategy_name": strat.strategy_name, "device_type": strat.device_type},
        ip_address=get_client_ip(request),
    )
    logger.info("解析策略删除: id=%s（已解除关联引用）", strategy_id)


# ======================================================================
# 草稿 / 发布 / 版本管理（编辑写草稿，线上版本不受影响）
# ======================================================================
def _get_strategy_or_404(db: Session, strategy_id: int) -> ParseStrategy:
    strat = db.query(ParseStrategy).filter(ParseStrategy.id == strategy_id).first()
    if not strat:
        raise HTTPException(status_code=404, detail="策略不存在")
    return strat


def _load_json(text: Optional[str], default: Any = None) -> Any:
    if not text:
        return default
    try:
        return json.loads(text)
    except (ValueError, TypeError):
        return default


def _ensure_baseline_version(db: Session, strat: ParseStrategy, username: str) -> None:
    """存量模板（无版本快照）首次进入草稿/发布流程时，为线上 config 生成基线 v1。"""
    exists = (
        db.query(ParseStrategyVersion.id)
        .filter(ParseStrategyVersion.strategy_id == strat.id)
        .first()
    )
    if exists:
        return
    db.add(
        ParseStrategyVersion(
            strategy_id=strat.id,
            version_no=1,
            config=strat.config,
            published_by=username or "",
            remark="基线版本（发布前线上版本自动快照）",
        )
    )
    strat.published_version_no = 1
    db.flush()


@router.get("/strategies/{strategy_id}", dependencies=[Depends(require_permission("strategy", "view"))])
def get_strategy_detail(strategy_id: int, db: Session = Depends(get_db)) -> dict:
    """模板详情：线上版本配置 + 草稿（存在时）+ 版本摘要。编辑页据此加载。"""
    strat = _get_strategy_or_404(db, strategy_id)
    online = _load_json(strat.config, {})
    draft = _load_json(strat.draft_config)
    version_count = (
        db.query(ParseStrategyVersion)
        .filter(ParseStrategyVersion.strategy_id == strat.id)
        .count()
    )
    return {
        "id": strat.id,
        "strategy_name": strat.strategy_name,
        "device_type": strat.device_type,
        "version": strat.version,
        "status": strat.status,
        "config": online,
        "draft_config": draft,
        "has_draft": bool(strat.draft_config),
        "published_version_no": strat.published_version_no,
        "version_count": version_count,
        "created_at": strat.created_at,
        "updated_at": strat.updated_at,
    }


@router.post(
    "/strategies/{strategy_id}/publish",
    dependencies=[Depends(require_permission("strategy", "edit"))],
)
def publish_strategy(
    strategy_id: int,
    body: StrategyPublishBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """发布草稿：draft_config 替换线上 config，生成版本快照，写审计日志。"""
    strat = _get_strategy_or_404(db, strategy_id)
    draft = _load_json(strat.draft_config)
    if draft is None:
        raise HTTPException(status_code=422, detail="当前没有待发布的草稿")
    _validate_strategy_config(draft)
    _ensure_baseline_version(db, strat, getattr(user, "username", ""))

    old_no = strat.published_version_no
    new_no = (
        db.query(func.max(ParseStrategyVersion.version_no))
        .filter(ParseStrategyVersion.strategy_id == strat.id)
        .scalar()
        or 0
    ) + 1
    config_text = json.dumps(draft, ensure_ascii=False)
    strat.config = config_text
    strat.strategy_name = str(draft.get("strategy_name") or strat.strategy_name).strip()
    strat.device_type = str(draft.get("device_type") or strat.device_type).strip()
    strat.version = str(draft.get("version") or strat.version)
    strat.status = draft.get("status") or strat.status
    strat.draft_config = None
    strat.published_version_no = new_no
    db.add(
        ParseStrategyVersion(
            strategy_id=strat.id,
            version_no=new_no,
            config=config_text,
            published_by=getattr(user, "username", "") or "",
            published_at=beijing_now(),
            remark=body.remark or "",
        )
    )
    db.commit()
    refresh_strategy_cache()
    log_audit(
        db,
        user_id=getattr(user, "id", None),
        username=getattr(user, "username", ""),
        action="publish",
        resource_type="strategy",
        resource_id=strategy_id,
        detail={
            "strategy_name": strat.strategy_name,
            "from_version_no": old_no,
            "to_version_no": new_no,
            "remark": body.remark or "",
        },
        ip_address=get_client_ip(request),
    )
    logger.info("解析策略发布: id=%s v%s（原 v%s）", strat.id, new_no, old_no)
    return {"id": strat.id, "published_version_no": new_no, "published": True}


@router.delete(
    "/strategies/{strategy_id}/draft",
    dependencies=[Depends(require_permission("strategy", "edit"))],
)
def discard_strategy_draft(
    strategy_id: int,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """丢弃草稿：恢复以线上版本为准（草稿内容不保留）。"""
    strat = _get_strategy_or_404(db, strategy_id)
    if not strat.draft_config:
        raise HTTPException(status_code=422, detail="当前没有草稿")
    strat.draft_config = None
    db.commit()
    log_audit(
        db,
        user_id=getattr(user, "id", None),
        username=getattr(user, "username", ""),
        action="update",
        resource_type="strategy",
        resource_id=strategy_id,
        detail={"operation": "discard_draft", "strategy_name": strat.strategy_name},
        ip_address=get_client_ip(request),
    )
    logger.info("解析策略草稿丢弃: id=%s", strat.id)
    return {"id": strat.id, "draft_discarded": True}


@router.get("/strategies/{strategy_id}/versions", dependencies=[Depends(require_permission("strategy", "view"))])
def list_strategy_versions(strategy_id: int, db: Session = Depends(get_db)) -> list[dict]:
    """版本历史列表（含当前线上版本标记与草稿提示）。"""
    strat = _get_strategy_or_404(db, strategy_id)
    rows = (
        db.query(ParseStrategyVersion)
        .filter(ParseStrategyVersion.strategy_id == strategy_id)
        .order_by(ParseStrategyVersion.version_no.desc())
        .all()
    )
    return [
        {
            "version_no": v.version_no,
            "published_by": v.published_by,
            "published_at": v.published_at,
            "remark": v.remark,
            "is_current": v.version_no == strat.published_version_no,
        }
        for v in rows
    ]


@router.get(
    "/strategies/{strategy_id}/versions/{version_no}",
    dependencies=[Depends(require_permission("strategy", "view"))],
)
def get_strategy_version(strategy_id: int, version_no: int, db: Session = Depends(get_db)) -> dict:
    """单版本完整配置（版本 diff 的取数端点）。"""
    _get_strategy_or_404(db, strategy_id)
    row = (
        db.query(ParseStrategyVersion)
        .filter(
            ParseStrategyVersion.strategy_id == strategy_id,
            ParseStrategyVersion.version_no == version_no,
        )
        .first()
    )
    if not row:
        raise HTTPException(status_code=404, detail=f"版本 v{version_no} 不存在")
    return {
        "version_no": row.version_no,
        "config": _load_json(row.config, {}),
        "published_by": row.published_by,
        "published_at": row.published_at,
        "remark": row.remark,
    }


@router.post(
    "/strategies/{strategy_id}/rollback",
    dependencies=[Depends(require_permission("strategy", "edit"))],
)
def rollback_strategy(
    strategy_id: int,
    body: StrategyRollbackBody,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """回滚：以历史版本内容发布为新版本（线上立即生效），写审计日志。"""
    strat = _get_strategy_or_404(db, strategy_id)
    target = (
        db.query(ParseStrategyVersion)
        .filter(
            ParseStrategyVersion.strategy_id == strategy_id,
            ParseStrategyVersion.version_no == body.version_no,
        )
        .first()
    )
    if not target:
        raise HTTPException(status_code=404, detail=f"版本 v{body.version_no} 不存在")
    config = _load_json(target.config, {})
    if not isinstance(config, dict) or not config:
        raise HTTPException(status_code=422, detail=f"版本 v{body.version_no} 配置无效，无法回滚")
    _validate_strategy_config(config)
    _ensure_baseline_version(db, strat, getattr(user, "username", ""))

    old_no = strat.published_version_no
    new_no = (
        db.query(func.max(ParseStrategyVersion.version_no))
        .filter(ParseStrategyVersion.strategy_id == strat.id)
        .scalar()
        or 0
    ) + 1
    config_text = json.dumps(config, ensure_ascii=False)
    strat.config = config_text
    strat.strategy_name = str(config.get("strategy_name") or strat.strategy_name).strip()
    strat.device_type = str(config.get("device_type") or strat.device_type).strip()
    strat.version = str(config.get("version") or strat.version)
    strat.status = config.get("status") or strat.status
    strat.published_version_no = new_no
    remark = body.remark or f"回滚自 v{body.version_no}"
    db.add(
        ParseStrategyVersion(
            strategy_id=strat.id,
            version_no=new_no,
            config=config_text,
            published_by=getattr(user, "username", "") or "",
            published_at=beijing_now(),
            remark=remark,
        )
    )
    db.commit()
    refresh_strategy_cache()
    log_audit(
        db,
        user_id=getattr(user, "id", None),
        username=getattr(user, "username", ""),
        action="rollback",
        resource_type="strategy",
        resource_id=strategy_id,
        detail={
            "strategy_name": strat.strategy_name,
            "from_version_no": old_no,
            "to_version_no": new_no,
            "rollback_to": body.version_no,
            "remark": remark,
        },
        ip_address=get_client_ip(request),
    )
    logger.info("解析策略回滚: id=%s v%s → v%s（基于 v%s）", strat.id, old_no, new_no, body.version_no)
    return {"id": strat.id, "published_version_no": new_no, "rolled_back_to": body.version_no}


# ======================================================================
# 策略测试（纯内存执行，不写库）
# ======================================================================
def _eval_route(rules: dict, raw: dict) -> bool:
    """评估单条路由规则是否命中（与 StrategyLoader.match 逻辑一致）。"""
    match_type = str(rules.get("match_type") or "exact").lower()
    match_field = rules.get("match_field") or ""
    match_value = rules.get("match_value")
    if not match_field:
        return False
    actual = get_path(raw, match_field)
    if match_type == "regex":
        try:
            return re.fullmatch(str(match_value), str(actual)) is not None
        except re.error:
            return False
    return actual == match_value


@router.post("/strategies/test", dependencies=[Depends(require_permission("strategy", "edit"))])
def test_strategy(body: StrategyTestRequest) -> dict:
    """测试解析：路由匹配过程 + 逐字段映射明细 + 校验警告 + 标准模型 JSON 预览。

    纯内存执行，不写库。
    """
    config = body.config or {}
    sample = body.sample or {}
    started = time.perf_counter()

    has_rules = isinstance(config.get("rules"), list) and bool(config.get("rules"))

    # 1. 规则匹配过程（新结构）或路由匹配（旧结构）
    rule = None
    rule_detail = None
    if has_rules:
        rule = resolve_rule(sample, config)
        rule_detail = {
            "rule_id": (rule or {}).get("rule_id", ""),
            "log_type": (rule or {}).get("log_type", ""),
            "matched": rule is not None,
            "match": (rule or {}).get("match") or {},
        }
        route = {
            "mode": "rules",
            "matched": rule is not None,
            "rule_id": (rule or {}).get("rule_id", ""),
            "log_type": (rule or {}).get("log_type", ""),
        }
    else:
        rules = config.get("route_rules") or {}
        actual_value = get_path(sample, rules.get("match_field") or "")
        route = {
            "mode": "route",
            "match_type": str(rules.get("match_type") or "exact").lower(),
            "match_field": rules.get("match_field") or "",
            "match_value": rules.get("match_value"),
            "actual_value": actual_value,
            "matched": _eval_route(rules, sample),
        }

    db_hits = []
    try:
        loader = get_strategy_loader()
        if not loader.strategies:
            loader.refresh()
        for strat in loader.strategies:
            s_config = strat.get("config") or {}
            s_rules = s_config.get("route_rules") or {}
            db_hits.append(
                {
                    "id": strat.get("id"),
                    "strategy_name": strat.get("strategy_name"),
                    "version": strat.get("version"),
                    "mode": "rules" if s_config.get("rules") else "route",
                    "match_field": s_rules.get("match_field"),
                    "match_value": s_rules.get("match_value"),
                    "hit": _eval_route(s_rules, sample),
                }
            )
    except Exception:  # noqa: BLE001
        logger.exception("测试解析：数据库策略路由评估失败（忽略）")

    # 2. 外层解包
    wrapper = config.get("outer_wrapper") or {}
    data_path = wrapper.get("data_path") or ""
    data = get_path(sample, data_path, default={})
    unwrap_ok = isinstance(data, dict)
    if not unwrap_ok:
        data = {}

    # 3. 字段提取（新结构按命中规则 extract；旧结构用根级 field_mappings）
    if has_rules and rule is not None:
        extract = rule.get("extract") or {}
        rule_map = rule.get("map") or {}
        fields, mapping_warnings, enum_specs = extract_fields(data, extract, sample)
        enum_maps = rule_map.get("enum_maps") or {}
        defaults = rule_map.get("defaults") or []
        validations = rule_map.get("validations") or []
        ext_fields = rule.get("extension_fields") or config.get("extension_fields") or []
        # 默认值补充
        for d in defaults:
            target = d.get("target")
            if target and not fields.get(target):
                fields[target] = d.get("value")
        # 规则内额外映射
        apply_rule_map(fields, rule_map, sample, mapping_warnings)
    else:
        fields, mapping_warnings, enum_specs = apply_mappings(
            data, config.get("field_mappings") or [], sample,
        )
        enum_maps = config.get("enum_maps") or {}
        validations = config.get("validations") or []
        ext_fields = config.get("extension_fields") or []

    # 4. 枚举翻译
    enum_translations = []
    enum_translate(fields, enum_specs, enum_maps)
    for spec in enum_specs:
        enum_translations.append(
            {
                "target": spec.get("target"),
                "enum_target": spec.get("enum_target"),
                "value": fields.get(spec.get("target")),
                "translated": fields.get(spec.get("enum_target")),
            }
        )

    # 5. 校验
    validation_warnings = run_validations(fields, validations)
    warnings = mapping_warnings + validation_warnings

    # 6. 扩展归档（header + ext_fields → extensions）
    headers = {k: sample.get(k) for k in wrapper.get("header_fields") or [] if k in sample}
    extensions: dict[str, Any] = dict(headers)
    for src in ext_fields:
        if src in data:
            extensions[src] = data[src]
    fields["extensions"] = json.dumps(extensions, ensure_ascii=False)
    fields["device_type"] = config.get("device_type") or ""
    if has_rules and rule is not None:
        fields["rule_id"] = (rule or {}).get("rule_id", "")
        fields["log_type"] = (rule or {}).get("log_type", "")
    uuid_source = wrapper.get("uuid_source") or ""
    uuid_val = get_path(sample, uuid_source)
    if uuid_val is not None:
        fields["uuid"] = str(uuid_val)

    # 逐字段明细表（源值 → 目标字段 → 转换后值 → 是否警告）
    warning_by_field: dict[str, dict] = {}
    for w in warnings:
        warning_by_field.setdefault(w.get("field") or "", w)
    mappings_detail = []
    if has_rules and rule is not None:
        mapping_list = []
        etype = ((rule.get("extract") or {}).get("type") or "fields")
        if etype == "fields":
            mapping_list = (rule.get("extract") or {}).get("fields") or []
        for m in mapping_list:
            source = m.get("source") or ""
            target = m.get("target") or ""
            mappings_detail.append(
                {
                    "source": source,
                    "target": target,
                    "type": m.get("type") or "string",
                    "raw_value": _preview(data.get(source)) if source in data else None,
                    "missing": bool(source) and source not in data,
                    "converted": _preview(fields.get(target)),
                    "warning": (warning_by_field.get(target) or {}).get("message"),
                }
            )
    else:
        for m in config.get("field_mappings") or []:
            source = m.get("source") or ""
            target = m.get("target") or ""
            mappings_detail.append(
                {
                    "source": source,
                    "target": target,
                    "type": m.get("type") or "string",
                    "raw_value": _preview(data.get(source)) if source in data else None,
                    "missing": bool(source) and source not in data,
                    "converted": _preview(fields.get(target)),
                    "warning": (warning_by_field.get(target) or {}).get("message"),
                }
            )

    return {
        "route": route,
        "rule": rule_detail,
        "db_hits": db_hits,
        "unwrap": {"data_path": data_path, "found": unwrap_ok},
        "mappings": mappings_detail,
        "enum_translations": enum_translations,
        "warnings": warnings,
        "status": "partial" if warnings else "success",
        "fields": _json_safe(fields),
        "parse_ms": int((time.perf_counter() - started) * 1000),
    }


# ======================================================================
# 模板测试解析（按模板 ID，多条日志，走完整解析管道但不落库）
# ======================================================================
def _condition_detail(raw: dict, cond: dict) -> dict:
    """单条 match 条件的评估详情（字段/算子/期望值/实际值/是否命中）。"""
    field = cond.get("field") or ""
    op = str(cond.get("op") or "eq").lower()
    expected = cond.get("value")
    actual = get_path(raw, field) if field else None
    return {
        "field": field,
        "op": op,
        "expected": _preview(expected),
        "actual": _preview(actual),
        "hit": bool(_match_condition(raw, cond)),
    }


def _rules_match_detail(raw: dict, config: dict) -> tuple[Optional[dict], list[dict]]:
    """逐规则逐条件评估（调试视图），返回 (命中规则, 全部规则评估详情)。"""
    details: list[dict] = []
    for rule in normalize_rules(config):
        enabled = rule.get("enabled") is not False
        match = rule.get("match") or {}
        conditions = [_condition_detail(raw, c) for c in match.get("conditions") or []]
        hit = enabled and _match_rule(raw, match)
        details.append(
            {
                "rule_id": rule.get("rule_id", ""),
                "log_type": rule.get("log_type", ""),
                "enabled": enabled,
                "combine": str(match.get("type") or "all").lower(),
                "conditions": conditions,
                "hit": hit,
            }
        )
        if hit:
            return rule, details
    return None, details


def _extract_detail(rule: Optional[dict], data: dict, sample: dict, fields: dict, warnings: list[dict]) -> list[dict]:
    """字段提取明细表（源值 → 目标字段 → 转换后值 → 警告）。"""
    detail: list[dict] = []
    if not rule:
        return detail
    warning_by_field: dict[str, dict] = {}
    for w in warnings:
        warning_by_field.setdefault(w.get("field") or "", w)
    extract = rule.get("extract") or {}
    etype = (extract or {}).get("type") or "fields"
    if etype == "fields":
        for m in (extract or {}).get("fields") or []:
            source = m.get("source") or ""
            target = m.get("target") or ""
            detail.append(
                {
                    "source": source,
                    "target": target,
                    "type": m.get("type") or "string",
                    "raw_value": _preview(data.get(source)) if source in data else None,
                    "missing": bool(source) and source not in data,
                    "converted": _preview(fields.get(target)),
                    "warning": (warning_by_field.get(target) or {}).get("message"),
                }
            )
    else:
        # regex / template：无法回放捕获组原文，展示目标字段与转换结果
        for m in (extract or {}).get("mappings") or []:
            target = m.get("target") or ""
            key = m.get("group", m.get("index", ""))
            detail.append(
                {
                    "source": f"{etype}[{key}]",
                    "target": target,
                    "type": m.get("type") or "string",
                    "raw_value": None,
                    "missing": False,
                    "converted": _preview(fields.get(target)),
                    "warning": (warning_by_field.get(target) or {}).get("message"),
                }
            )
    return detail


def _fallback_trace(raw: dict, loader: StrategyLoader, engine: ParseEngine) -> dict:
    """自动路由回退路径调试：元数据 → 特征匹配 → 候选尝试 → route_rules 兜底。"""
    router = ClassifierRouter(loader)
    classification = router.classify(raw)
    table = router._current_classifier().table

    # 1. 元数据直路由
    metadata_checks = []
    for mf in table.metadata_fields:
        value = raw.get(mf)
        if value is None or str(value).strip() == "":
            continue
        hit = table._metadata_index.get((mf, str(value).strip().lower()))
        metadata_checks.append({"field": mf, "value": _preview(value, 40), "hit": hit or ""})

    # 2. 特征匹配候选
    candidates = classification.candidates

    # 3. 候选尝试（复用 ClassifierRouter 的策略选取与校验门控）
    attempts = []
    for device_type in candidates:
        for strategy in router._strategies_for(device_type):
            reason = ""
            try:
                result = engine.parse_one(raw, strategy=strategy)
            except Exception as exc:  # noqa: BLE001
                attempts.append(
                    {
                        "device_type": device_type, "strategy_id": strategy.get("id"),
                        "strategy_name": strategy.get("strategy_name"), "version": strategy.get("version"),
                        "status": "error", "accepted": False, "reason": f"解析异常: {exc}",
                    }
                )
                continue
            if result.status == "fail":
                reason = result.error_msg or "解析失败"
            elif not router._gate(device_type, result):
                reason = "路由级校验不过（YAML validators 或 severity=error 校验失败）"
            attempts.append(
                {
                    "device_type": device_type, "strategy_id": strategy.get("id"),
                    "strategy_name": strategy.get("strategy_name"), "version": strategy.get("version"),
                    "status": result.status, "accepted": reason == "",
                    "reason": reason,
                }
            )

    # 4. route_rules 兜底尝试
    legacy_hit = loader.match(raw)
    legacy = None
    if legacy_hit is not None:
        result, accepted = router._try(raw, engine, legacy_hit, str(legacy_hit.get("device_type") or ""))
        legacy = {
            "strategy_id": legacy_hit.get("id"),
            "strategy_name": legacy_hit.get("strategy_name"),
            "status": result.status if result else "error",
            "accepted": accepted,
        }

    return {
        "classification": {
            "method": classification.method,
            "reason": classification.reason,
            "candidates": candidates,
        },
        "metadata_checks": metadata_checks,
        "attempts": attempts,
        "legacy_route_rules": legacy,
        "conclusion": "unknown 兜底（无候选策略可用）",
    }


def _context_info(db: Session, strategy_id: int, context: dict) -> dict:
    """模拟数据源/接收器上下文：解析模板绑定优先级链展示。"""
    entry_id = int(context.get("entry_id") or 0)
    receiver_id = int(context.get("receiver_id") or 0)
    entry = db.query(LogSourceEntry).filter(LogSourceEntry.id == entry_id).first() if entry_id else None
    receiver = (
        db.query(LogReceiver).filter(LogReceiver.id == receiver_id).first()
        if receiver_id and entry is None
        else (db.query(LogReceiver).filter(LogReceiver.id == entry.receiver_id).first() if entry else None)
    )
    bound_id = None
    bound_source = ""
    if entry and entry.strategy_id:
        bound_id, bound_source = entry.strategy_id, "entry"
    elif receiver is not None and receiver.strategy_id:
        bound_id, bound_source = receiver.strategy_id, "receiver"
    note = ""
    if bound_id:
        if bound_id == strategy_id:
            note = "该上下文绑定当前模板，测试结果即实际链路效果"
        else:
            note = f"该上下文实际绑定模板 #{bound_id}（{bound_source}），本次测试强制使用当前模板解析"
    else:
        note = "该上下文未固定模板（自动匹配），实际路由链见回退路径"
    return {
        "entry_id": entry.id if entry else None,
        "entry_source_ip": entry.source_ip if entry else "",
        "receiver_id": receiver.id if receiver else None,
        "receiver_name": receiver.name if receiver else "",
        "bound_strategy_id": bound_id,
        "bound_strategy_source": bound_source,
        "note": note,
    }


@router.post(
    "/strategies/{strategy_id}/test-parse",
    dependencies=[Depends(require_permission("strategy", "edit"))],
)
def test_parse_strategy(
    strategy_id: int,
    body: StrategyTestParseRequest,
    db: Session = Depends(get_db),
) -> dict:
    """模板测试解析：多条原始日志 → 预处理 → 指定模板解析（不落库）。

    - 每条日志先走与接收管道一致的预处理器链（json → 青藤 syslog → 纯文本）；
    - 逐条返回：命中规则（含逐条件评估详情）、字段提取明细（源值 → 目标 →
      转换后值）、校验结果（通过/警告及原因）、标准模型 JSON；
    - 未命中规则时返回自动路由回退路径（元数据 → 特征匹配 → 候选尝试 →
      route_rules 兜底 → unknown）各环节结果；
    - use_draft=True 且存在草稿时测试草稿副本，否则测试线上版本。
    """
    strat = _get_strategy_or_404(db, strategy_id)
    using = "published"
    config = _load_json(strat.config, {})
    if body.use_draft and strat.draft_config:
        draft = _load_json(strat.draft_config)
        if isinstance(draft, dict):
            config = draft
            using = "draft"

    loader = get_strategy_loader()
    if not loader.strategies:
        loader.refresh()
    engine = ParseEngine(loader=loader, sink=None)  # 纯计算，不落库
    strategy_dict = {
        "id": strat.id,
        "strategy_name": strat.strategy_name,
        "device_type": strat.device_type,
        "version": strat.version,
        "config": config,
    }

    context_info = _context_info(db, strategy_id, body.context or {})

    results: list[dict] = []
    index = 0
    for line in body.logs:
        text = str(line).strip()
        if not text:
            continue
        payload = run_preprocessor_chain(DEFAULT_PREPROCESSOR_CHAIN, text)
        items = payload if isinstance(payload, list) else [payload]
        if not items:
            items = [None]
        for item in items:
            index += 1
            results.append(
                _test_parse_one(index, text, item, strategy_dict, config, engine, loader)
            )

    summary = {
        "total": len(results),
        "success": sum(1 for r in results if r["status"] == "success"),
        "partial": sum(1 for r in results if r["status"] == "partial"),
        "fail": sum(1 for r in results if r["status"] == "fail"),
    }
    return {
        "strategy": {"id": strat.id, "strategy_name": strat.strategy_name, "using": using},
        "context": context_info,
        "summary": summary,
        "results": results,
    }


def _test_parse_one(
    index: int,
    raw_text: str,
    item: Any,
    strategy_dict: dict,
    config: dict,
    engine: ParseEngine,
    loader: StrategyLoader,
) -> dict:
    """单条日志的测试解析（含规则命中详情 / 提取明细 / 校验 / 回退路径）。"""
    started = time.perf_counter()
    base = {
        "index": index,
        "raw": raw_text[:2000],
        "status": "fail",
        "error_type": "",
        "error_msg": "",
        "rule": None,
        "rules_detail": [],
        "unwrap": None,
        "mappings": [],
        "validations": [],
        "fields": {},
        "fallback_path": None,
        "parse_ms": 0,
    }
    if not isinstance(item, dict):
        base.update(
            {
                "error_type": "json_parse_failed",
                "error_msg": f"预处理后不是 JSON 对象: {type(item).__name__}",
                "parse_ms": int((time.perf_counter() - started) * 1000),
            }
        )
        return base

    # 逐规则逐条件评估（调试视图，与引擎 resolve_rule 同逻辑）
    rule, rules_detail = _rules_match_detail(item, config)
    base["rules_detail"] = rules_detail

    result = engine.parse_one(item, strategy=strategy_dict)
    base["status"] = result.status
    base["error_type"] = result.error_type
    base["error_msg"] = result.error_msg
    base["fields"] = _json_safe(result.fields or {})
    base["rule"] = (
        {"rule_id": result.rule_id, "log_type": result.log_type, "matched": bool(result.rule_id)}
        if result.rule_id
        else None
    )

    if rule is not None and result.status != "fail":
        # 解包详情
        wrapper = config.get("outer_wrapper") or {}
        data_path = wrapper.get("data_path") or ""
        data = get_path(item, data_path, default={})
        base["unwrap"] = {"data_path": data_path, "found": isinstance(data, dict)}
        # 提取明细
        base["mappings"] = _extract_detail(rule, data if isinstance(data, dict) else {}, item, result.fields or {}, result.warnings)
        # 校验结果：定义数 + 失败明细
        defined = len((rule.get("map") or {}).get("validations") or [])
        failed = [w for w in result.warnings if w.get("rule")]
        base["validations"] = {
            "defined": defined,
            "failed": failed,
            "passed": defined - len(failed),
        }
    else:
        # 未命中规则 / 解析失败：展示自动路由回退路径
        try:
            base["fallback_path"] = _fallback_trace(item, loader, engine)
        except Exception:  # noqa: BLE001
            logger.exception("测试解析：回退路径追踪失败（忽略）")

    base["parse_ms"] = int((time.perf_counter() - started) * 1000)
    return base


# ======================================================================
# 失败样本下钻（模板维度：原因四分类 + 样本列表）
# ======================================================================
# 原因分类 → 中文标签（前端展示用）
REASON_LABELS = {
    "no_template": "无匹配模板",
    "missing_field": "字段缺失",
    "validation_failed": "校验不通过",
    "format_error": "格式异常",
    "other": "其他",
}


def _classify_error(error_type: Optional[str], error_msg: str = "") -> str:
    """失败原因四分类（无匹配模板/字段缺失/校验不通过/格式异常，其他兜底）。"""
    et = (error_type or "").strip().lower()
    if et in ("no_strategy_matched", "unknown_log_type"):
        return "no_template"
    if et == "json_parse_failed":
        return "format_error"
    if et == "field_validation_failed":
        return "validation_failed"
    msg = error_msg or ""
    if "缺失" in msg or "missing" in msg.lower():
        return "missing_field"
    if "格式" in msg or "不是 json" in msg.lower() or "format" in msg.lower():
        return "format_error"
    if "校验" in msg or "正则" in msg or "valid" in msg.lower():
        return "validation_failed"
    return "other"


def _reason_error_types(reason: str) -> list[str]:
    """原因反查可能的 error_type 集合（用于按原因筛选）。"""
    mapping = {
        "no_template": ["no_strategy_matched", "unknown_log_type"],
        "format_error": ["json_parse_failed"],
        "validation_failed": ["field_validation_failed"],
    }
    return mapping.get(reason, [])


@router.get("/strategies/{strategy_id}/failure-samples", dependencies=[Depends(get_current_user)])
def strategy_failure_samples(
    strategy_id: int,
    reason: str = Query("", description="失败原因分类过滤（no_template/missing_field/validation_failed/format_error/other）"),
    page: int = Query(1, ge=1),
    page_size: int = Query(15, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """模板失败样本下钻：原因分类统计 + 样本列表（分页，支持按原因筛选）。"""
    strat = _get_strategy_or_404(db, strategy_id)
    query = db.query(ParseErrorQueue).filter(ParseErrorQueue.strategy_id == strategy_id)

    # 原因分类统计（全量，不受分页影响；先按 error_type 聚合再分类）
    stats = {k: 0 for k in REASON_LABELS}
    for et, cnt in (
        db.query(ParseErrorQueue.error_type, func.count(ParseErrorQueue.id))
        .filter(ParseErrorQueue.strategy_id == strategy_id)
        .group_by(ParseErrorQueue.error_type)
        .all()
    ):
        stats[_classify_error(et)] += int(cnt or 0)

    # 按原因筛选（error_type 可映射的原因直接过滤；missing_field 走消息匹配）
    if reason:
        types = _reason_error_types(reason)
        if types:
            query = query.filter(ParseErrorQueue.error_type.in_(types))
        elif reason == "missing_field":
            query = query.filter(ParseErrorQueue.error_msg.ilike("%缺失%"))
        elif reason == "other":
            known = set()
            for r in ("no_template", "format_error", "validation_failed"):
                known.update(_reason_error_types(r))
            query = query.filter(
                ~ParseErrorQueue.error_type.in_(known),
                ~ParseErrorQueue.error_msg.ilike("%缺失%"),
            )

    total = query.count()
    rows = (
        query.order_by(ParseErrorQueue.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "total": total,
        "stats": stats,
        "reason_labels": REASON_LABELS,
        "strategy": {"id": strat.id, "strategy_name": strat.strategy_name},
        "items": [
            {
                "id": r.id,
                "uuid": r.uuid,
                "error_type": r.error_type,
                "reason_class": _classify_error(r.error_type, r.error_msg or ""),
                "reason_label": REASON_LABELS.get(_classify_error(r.error_type, r.error_msg or ""), "其他"),
                "error_msg": r.error_msg,
                "raw_data": r.raw_data,
                "retry_count": r.retry_count,
                "status": r.status,
                "created_at": r.created_at,
            }
            for r in rows
        ],
    }


# ======================================================================
# 错误队列与指标（需要登录）
# ======================================================================
@router.get("/errors", dependencies=[Depends(get_current_user)])
def list_errors(
    error_type: str = Query("", description="错误类型过滤"),
    strategy_id: int = Query(0, description="按模板 ID 过滤（失败样本入口）"),
    status: str = Query("", description="状态过滤：pending/reprocessing/manual/resolved"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """查看解析错误队列。"""
    query = db.query(ParseErrorQueue)
    if error_type:
        query = query.filter(ParseErrorQueue.error_type == error_type)
    if strategy_id:
        query = query.filter(ParseErrorQueue.strategy_id == strategy_id)
    if status:
        query = query.filter(ParseErrorQueue.status == status)
    total = query.count()
    rows = (
        query.order_by(ParseErrorQueue.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {
        "total": total,
        "items": [
            {
                "id": r.id,
                "uuid": r.uuid,
                "strategy_id": r.strategy_id,
                "raw_data": r.raw_data,
                "error_type": r.error_type,
                "error_msg": r.error_msg,
                "retry_count": r.retry_count,
                "status": r.status,
                "created_at": r.created_at,
            }
            for r in rows
        ],
    }


@router.get("/metrics", dependencies=[Depends(get_current_user)])
def list_metrics(
    hours: int = Query(24, ge=1, le=720, description="最近 N 小时"),
    db: Session = Depends(get_db),
) -> list[dict]:
    """查看按小时聚合的入库指标。"""
    since = (datetime.now(BEIJING_TZ) - timedelta(hours=hours)).strftime("%Y-%m-%dT%H")
    rows = (
        db.query(IngestionMetric)
        .filter(IngestionMetric.stat_hour >= since)
        .order_by(IngestionMetric.stat_hour.desc())
        .all()
    )
    return [
        {
            "stat_hour": r.stat_hour,
            "strategy_id": r.strategy_id,
            "strategy_name": r.strategy_name,
            "total_count": r.total_count,
            "success_count": r.success_count,
            "partial_count": r.partial_count,
            "fail_count": r.fail_count,
            "avg_parse_ms": round(r.total_parse_ms / r.total_count, 1) if r.total_count else 0,
        }
        for r in rows
    ]


# ======================================================================
# 数据血缘视图（设备 → 接收器 → 条目 → 模板 → 告警聚合）
# ======================================================================
@router.get("/lineage", dependencies=[Depends(get_current_user)])
def data_lineage(db: Session = Depends(get_db)) -> dict:
    """返回数据血缘拓扑节点与边，供前端 reactflow 拓扑图渲染。

    - nodes: [{id, type, label, health, meta}]
        type ∈ device/receiver/entry/strategy
        health ∈ healthy/disabled/warning/offline
    - edges: [{id, source, target, label}]
    - 告警今日计数聚合到 strategy 节点 meta.alert_count；接收器运行态映射 health。
    """
    from app.engine.classifier import ClassifierRouter  # noqa: F401  (确保已加载)

    nodes: list[dict] = []
    edges: list[dict] = []

    # 今日告警按 strategy_id 聚合（用于 strategy 节点健康指示）
    today_start = beijing_now() - timedelta(hours=24)
    alert_rows = (
        db.query(
            AlertEvent.strategy_id,
            func.count(AlertEvent.id).label("cnt"),
        )
        .filter(AlertEvent.occur_timestamp >= today_start)
        .group_by(AlertEvent.strategy_id)
        .all()
    )
    alert_map: dict[int, int] = {r.strategy_id: r.cnt for r in alert_rows if r.strategy_id}

    # 失败样本按 strategy_id 聚合（用于 strategy 节点 warning 标记）
    fail_rows = (
        db.query(ParseErrorQueue.strategy_id, func.count(ParseErrorQueue.id).label("cnt"))
        .filter(ParseErrorQueue.created_at >= today_start)
        .group_by(ParseErrorQueue.strategy_id)
        .all()
    )
    fail_map: dict[int, int] = {r.strategy_id: r.cnt for r in fail_rows if r.strategy_id}

    # 1) 设备
    devices = db.query(Device).all()
    for d in devices:
        nodes.append({
            "id": f"device-{d.id}",
            "type": "device",
            "label": d.name or f"设备 {d.id}",
            "health": "healthy" if d.enabled else "disabled",
            "meta": {
                "type": d.type or "",
                "ip": d.ip_address or "",
                "vendor": d.vendor or "",
                "strategy_id": d.parser_strategy_id,
            },
        })
        if d.parser_strategy_id:
            edges.append({
                "id": f"e-dev-strat-{d.id}",
                "source": f"device-{d.id}",
                "target": f"strategy-{d.parser_strategy_id}",
                "label": "绑定模板",
            })

    # 2) 接收器
    receivers = db.query(LogReceiver).all()
    # 运行态：尝试从 receiver runtime 取（无则降级用 enabled）
    try:
        from app.core.log_receiver_manager import get_receiver_runtime_status
        runtime_map = {r.id: get_receiver_runtime_status(r.id) for r in receivers}
    except Exception:  # noqa: BLE001
        runtime_map = {}
    for r in receivers:
        rt = runtime_map.get(r.id) or {}
        online = rt.get("online") if rt else None
        if not r.enabled:
            health = "disabled"
        elif online is True:
            health = "healthy"
        elif online is False:
            health = "offline"
        else:
            health = "healthy"
        nodes.append({
            "id": f"receiver-{r.id}",
            "type": "receiver",
            "label": r.name or f"接收器 {r.id}",
            "health": health,
            "meta": {
                "protocol": r.protocol or "",
                "port": r.syslog_port,
                "bind": r.syslog_bind or "",
                "strategy_id": r.strategy_id,
            },
        })
        if r.device_id:
            edges.append({
                "id": f"e-dev-recv-{r.id}",
                "source": f"device-{r.device_id}",
                "target": f"receiver-{r.id}",
                "label": "接收",
            })
        if r.strategy_id:
            edges.append({
                "id": f"e-recv-strat-{r.id}",
                "source": f"receiver-{r.id}",
                "target": f"strategy-{r.strategy_id}",
                "label": "默认模板",
            })

    # 3) 数据源条目
    entries = db.query(LogSourceEntry).all()
    for e in entries:
        nodes.append({
            "id": f"entry-{e.id}",
            "type": "entry",
            "label": e.source_ip or e.name or f"条目 {e.id}",
            "health": "healthy" if e.enabled else "disabled",
            "meta": {
                "strategy_id": e.strategy_id,
                "device_id": e.device_id,
            },
        })
        edges.append({
            "id": f"e-recv-entry-{e.id}",
            "source": f"receiver-{e.receiver_id}",
            "target": f"entry-{e.id}",
            "label": "来源",
        })
        if e.strategy_id:
            edges.append({
                "id": f"e-entry-strat-{e.id}",
                "source": f"entry-{e.id}",
                "target": f"strategy-{e.strategy_id}",
                "label": "条目模板",
            })

    # 4) 解析模板
    strategies = db.query(ParseStrategy).all()
    for s in strategies:
        alert_cnt = alert_map.get(s.id, 0)
        fail_cnt = fail_map.get(s.id, 0)
        if s.status != "enabled":
            health = "disabled"
        elif fail_cnt > 0:
            health = "warning"
        else:
            health = "healthy"
        nodes.append({
            "id": f"strategy-{s.id}",
            "type": "strategy",
            "label": s.strategy_name or f"模板 {s.id}",
            "health": health,
            "meta": {
                "version": s.version or "",
                "alert_count": alert_cnt,
                "fail_count": fail_cnt,
            },
        })

    # 去重 edges（同 source-target 只保留一条）
    seen: set[tuple[str, str]] = set()
    uniq_edges = []
    for e in edges:
        key = (e["source"], e["target"])
        if key in seen:
            continue
        seen.add(key)
        uniq_edges.append(e)

    return {"nodes": nodes, "edges": uniq_edges}
