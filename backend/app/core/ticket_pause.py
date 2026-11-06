"""工单暂停（临时挂起）领域服务。

职责：
- 暂停策略配置读取（SystemConfig 键 ``ticket.pause_config``，缺失时用默认值）
- 暂停/恢复的权限、状态、分类必填项、时效上限校验
- 工单与暂停记录的状态同步（含节点停留计时冻结、归属冲突检测）

约定：
- 数据库时间统一为北京时间 naive datetime（见 ``app.core.timezone``）。
- 本模块不依赖 FastAPI，异常通过 :class:`PauseError` 抛出，由接口层转换。
"""
import copy
import json
import logging
from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.core.sanitizer import sanitize_text
from app.core.timezone import BEIJING_TZ, beijing_now, to_beijing_iso
from app.models.system_config import SystemConfig
from app.models.ticket import Ticket, TicketNodeRecord, TicketPause

logger = logging.getLogger(__name__)

PAUSE_CONFIG_KEY = "ticket.pause_config"

# 暂停分类编码
PAUSE_TYPES = (
    "pending_info",
    "external_coop",
    "user_feedback",
    "business_window",
    "duplicate_merge",
    "other",
)

# 各分类在 detail 中的必填键
REQUIRED_DETAIL_KEYS: dict[str, tuple[str, ...]] = {
    "pending_info": ("supplement_items",),
    "external_coop": ("partner",),
    "user_feedback": ("feedback_items",),
    "business_window": ("window_start", "window_end"),
    "duplicate_merge": ("master_ticket_no",),
}

# 默认策略：单次上限、到期处置、可见性、必填期望恢复时间
DEFAULT_PAUSE_CONFIG: dict = {
    "enabled": True,
    "max_pause_minutes": 10080,
    "max_total_pause_minutes": 20160,
    "max_pause_count": 5,
    "max_batch_size": 200,
    "remind_before_expire_minutes": 240,
    "fallback_group_id": None,
    "types": {
        "pending_info": {
            "label": "待补充信息",
            "enabled": True,
            "max_minutes": 1440,
            "allow_roles": ["handler", "admin"],
            "require_expected_resume": True,
            "remind_percents": [50, 80],
            "timeout_policy": "auto_resume",
            "reason_visibility": "participants",
            "allow_batch": True,
            "auto_close": False,
        },
        "external_coop": {
            "label": "待外部协作",
            "enabled": True,
            "max_minutes": 4320,
            "allow_roles": ["handler", "admin"],
            "require_expected_resume": True,
            "remind_percents": [50, 80],
            "timeout_policy": "auto_resume_escalate",
            "reason_visibility": "internal",
            "allow_batch": True,
            "auto_close": False,
        },
        "user_feedback": {
            "label": "待用户反馈",
            "enabled": True,
            "max_minutes": 2880,
            "allow_roles": ["handler", "creator", "admin"],
            "require_expected_resume": True,
            "remind_percents": [50, 80],
            "timeout_policy": "auto_resume",
            "reason_visibility": "participants",
            "allow_batch": True,
            "auto_close": False,
        },
        "business_window": {
            "label": "待变更窗口",
            "enabled": True,
            "max_minutes": 10080,
            "allow_roles": ["handler", "admin"],
            "require_expected_resume": True,
            "remind_percents": [50, 80],
            "timeout_policy": "auto_resume",
            "reason_visibility": "participants",
            "allow_batch": True,
            "auto_close": False,
        },
        "duplicate_merge": {
            "label": "重复工单待合并",
            "enabled": True,
            "max_minutes": 1440,
            "allow_roles": ["handler", "creator", "admin"],
            "require_expected_resume": False,
            "remind_percents": [50, 80],
            "timeout_policy": "auto_resume",
            "reason_visibility": "participants",
            "allow_batch": True,
            "auto_close": False,
        },
        "other": {
            "label": "其他",
            "enabled": True,
            "max_minutes": 480,
            "allow_roles": ["handler", "admin"],
            "require_expected_resume": False,
            "remind_percents": [50, 80],
            "timeout_policy": "auto_resume_escalate",
            "reason_visibility": "internal",
            "allow_batch": False,
            "auto_close": False,
        },
    },
}

# 紧急工单下非管理员不可发起的暂停类型
CRITICAL_ADMIN_ONLY_TYPES = ("pending_info", "duplicate_merge")


class PauseError(Exception):
    """暂停领域异常：接口层按 ``status_code/code`` 转换为 HTTP 响应。"""

    def __init__(self, status_code: int, code: str, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message


def _deepcopy_default() -> dict:
    return copy.deepcopy(DEFAULT_PAUSE_CONFIG)


def get_pause_config(db: Session) -> dict:
    """读取暂停策略配置；键缺失、解析失败或非法时回退默认值。"""
    cfg = db.query(SystemConfig).filter(SystemConfig.key == PAUSE_CONFIG_KEY).first()
    if not cfg or not cfg.value:
        return _deepcopy_default()
    try:
        raw = json.loads(cfg.value)
        if not isinstance(raw, dict):
            raise ValueError("配置需为对象")
    except (ValueError, TypeError) as exc:
        logger.warning("暂停策略配置解析失败，使用默认值: %s", exc)
        return _deepcopy_default()

    merged = _deepcopy_default()
    merged["enabled"] = bool(raw.get("enabled", True))
    for key in ("max_pause_minutes", "max_total_pause_minutes", "max_pause_count", "max_batch_size"):
        value = raw.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            merged[key] = value
    fallback = raw.get("fallback_group_id")
    if isinstance(fallback, int) and not isinstance(fallback, bool):
        merged["fallback_group_id"] = fallback
    remind_before = raw.get("remind_before_expire_minutes")
    if isinstance(remind_before, int) and not isinstance(remind_before, bool) and remind_before >= 0:
        merged["remind_before_expire_minutes"] = remind_before

    raw_types = raw.get("types")
    if isinstance(raw_types, dict):
        for code, defaults in merged["types"].items():
            item = raw_types.get(code)
            if isinstance(item, dict):
                defaults.update(item)
    return merged


TIMEOUT_POLICIES = ("auto_resume", "auto_resume_escalate", "auto_transfer", "auto_close")
REASON_VISIBILITIES = ("participants", "internal")
PAUSE_ROLES = ("handler", "creator", "admin")


def _as_int(value, field: str, *, minimum: int = 1, maximum: int | None = None) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise PauseError(422, "PAUSE_POLICY_INVALID", f"{field} 必须为整数")
    if value < minimum or (maximum is not None and value > maximum):
        limit = f"{minimum}~{maximum}" if maximum is not None else f">= {minimum}"
        raise PauseError(422, "PAUSE_POLICY_INVALID", f"{field} 取值需在 {limit} 范围内")
    return value


def _as_bool(value, field: str) -> bool:
    if not isinstance(value, bool):
        raise PauseError(422, "PAUSE_POLICY_INVALID", f"{field} 必须为布尔值")
    return value


def validate_pause_config(raw: dict) -> dict:
    """校验并补全暂停策略；非法配置抛 422，返回可直接落库的完整配置。"""
    if not isinstance(raw, dict):
        raise PauseError(422, "PAUSE_POLICY_INVALID", "暂停策略必须为对象")

    config = _deepcopy_default()
    config["enabled"] = _as_bool(raw.get("enabled", True), "enabled")
    config["max_pause_minutes"] = _as_int(
        raw.get("max_pause_minutes", config["max_pause_minutes"]),
        "max_pause_minutes", maximum=DEFAULT_PAUSE_CONFIG["max_pause_minutes"],
    )
    config["max_total_pause_minutes"] = _as_int(
        raw.get("max_total_pause_minutes", config["max_total_pause_minutes"]),
        "max_total_pause_minutes",
    )
    if config["max_total_pause_minutes"] < config["max_pause_minutes"]:
        raise PauseError(422, "PAUSE_POLICY_INVALID", "累计暂停上限不能小于单次暂停上限")
    config["max_pause_count"] = _as_int(
        raw.get("max_pause_count", config["max_pause_count"]),
        "max_pause_count", maximum=100,
    )
    config["max_batch_size"] = _as_int(
        raw.get("max_batch_size", config["max_batch_size"]),
        "max_batch_size", maximum=500,
    )
    config["remind_before_expire_minutes"] = _as_int(
        raw.get("remind_before_expire_minutes", config["remind_before_expire_minutes"]),
        "remind_before_expire_minutes", minimum=0, maximum=config["max_pause_minutes"],
    )
    fallback = raw.get("fallback_group_id")
    if fallback is not None:
        config["fallback_group_id"] = _as_int(fallback, "fallback_group_id")

    raw_types = raw.get("types") or {}
    if not isinstance(raw_types, dict):
        raise PauseError(422, "PAUSE_POLICY_INVALID", "types 必须为对象")
    unknown = set(raw_types) - set(PAUSE_TYPES)
    if unknown:
        raise PauseError(422, "PAUSE_POLICY_INVALID", f"未知的暂停类型：{','.join(sorted(unknown))}")

    for code in PAUSE_TYPES:
        item = raw_types.get(code)
        if item is None:
            continue
        if not isinstance(item, dict):
            raise PauseError(422, "PAUSE_POLICY_INVALID", f"types.{code} 必须为对象")
        target = config["types"][code]
        if "label" in item:
            label = item.get("label")
            if not isinstance(label, str) or not label.strip():
                raise PauseError(422, "PAUSE_POLICY_INVALID", f"types.{code}.label 不能为空")
            target["label"] = label.strip()
        if "enabled" in item:
            target["enabled"] = _as_bool(item["enabled"], f"types.{code}.enabled")
        if "max_minutes" in item:
            target["max_minutes"] = _as_int(
                item["max_minutes"], f"types.{code}.max_minutes",
                maximum=config["max_pause_minutes"],
            )
        if "allow_roles" in item:
            roles = item["allow_roles"]
            if not isinstance(roles, list) or any(role not in PAUSE_ROLES for role in roles):
                raise PauseError(422, "PAUSE_POLICY_INVALID", f"types.{code}.allow_roles 取值非法")
            target["allow_roles"] = list(dict.fromkeys(roles))
        if "require_expected_resume" in item:
            target["require_expected_resume"] = _as_bool(
                item["require_expected_resume"], f"types.{code}.require_expected_resume",
            )
        if "remind_percents" in item:
            percents = item["remind_percents"]
            if not isinstance(percents, list) or not percents:
                raise PauseError(422, "PAUSE_POLICY_INVALID", f"types.{code}.remind_percents 不能为空")
            normalized = [
                _as_int(p, f"types.{code}.remind_percents", minimum=1, maximum=99)
                for p in percents
            ]
            if normalized != sorted(set(normalized)):
                raise PauseError(422, "PAUSE_POLICY_INVALID", f"types.{code}.remind_percents 必须升序且不重复")
            target["remind_percents"] = normalized
        if "timeout_policy" in item:
            policy = item["timeout_policy"]
            if policy not in TIMEOUT_POLICIES:
                raise PauseError(422, "PAUSE_POLICY_INVALID", f"types.{code}.timeout_policy 取值非法")
            if policy == "auto_close" and code != "duplicate_merge":
                raise PauseError(422, "PAUSE_POLICY_INVALID", "auto_close 仅适用于重复工单")
            target["timeout_policy"] = policy
        if "reason_visibility" in item:
            visibility = item["reason_visibility"]
            if visibility not in REASON_VISIBILITIES:
                raise PauseError(422, "PAUSE_POLICY_INVALID", f"types.{code}.reason_visibility 取值非法")
            target["reason_visibility"] = visibility
        if "allow_batch" in item:
            target["allow_batch"] = _as_bool(item["allow_batch"], f"types.{code}.allow_batch")
        if "auto_close" in item:
            target["auto_close"] = _as_bool(item["auto_close"], f"types.{code}.auto_close")
        if target["auto_close"] and code != "duplicate_merge":
            raise PauseError(422, "PAUSE_POLICY_INVALID", "auto_close 仅适用于重复工单")

    # 自动关闭开关与到期策略保持一致，避免配置保存后执行时被静默忽略
    for code in PAUSE_TYPES:
        item = config["types"][code]
        if item.get("auto_close"):
            item["timeout_policy"] = "auto_close"
        elif item.get("timeout_policy") == "auto_close":
            item["auto_close"] = True

    return config


def save_pause_config(db: Session, raw: dict) -> dict:
    """校验并持久化暂停策略，返回保存后的完整配置。"""
    from app.models.ticket import TicketGroup

    config = validate_pause_config(raw)
    fallback_id = config.get("fallback_group_id")
    if fallback_id:
        group = db.query(TicketGroup).filter(
            TicketGroup.id == fallback_id, TicketGroup.enabled.is_(True)
        ).first()
        if not group:
            raise PauseError(422, "PAUSE_POLICY_INVALID", "兜底分组不存在或已停用")

    value = json.dumps(config, ensure_ascii=False)
    row = db.query(SystemConfig).filter(SystemConfig.key == PAUSE_CONFIG_KEY).first()
    if row:
        row.value = value
        row.description = "工单暂停策略（分类时效、提醒与到期处置）"
    else:
        db.add(SystemConfig(
            key=PAUSE_CONFIG_KEY,
            value=value,
            description="工单暂停策略（分类时效、提醒与到期处置）",
        ))
    db.commit()
    return config


def pause_type_config(config: dict, pause_type: str) -> dict:
    """取分类策略；编码非法时抛 422。"""
    item = (config.get("types") or {}).get(pause_type)
    if not isinstance(item, dict) or pause_type not in PAUSE_TYPES:
        raise PauseError(422, "PAUSE_TYPE_INVALID", f"未知的暂停类型：{pause_type}")
    return item


def pause_type_label(config: dict, pause_type: str | None) -> str:
    """分类中文名（未知编码原样返回）。"""
    item = (config.get("types") or {}).get(pause_type or "")
    return item.get("label") if isinstance(item, dict) and item.get("label") else (pause_type or "")


def _to_naive_beijing(value: datetime | None) -> datetime | None:
    """前端传入的 aware datetime 统一转为北京时间 naive。"""
    if value is None:
        return None
    if value.tzinfo is not None:
        return value.astimezone(BEIJING_TZ).replace(tzinfo=None)
    return value


def _csv_group_ids(ticket: Ticket) -> set[int]:
    """当前待处理分组集合（并行会签 CSV，旧数据回退单分组）。"""
    raw = ticket.current_group_ids or ""
    ids = {
        int(part) for part in raw.split(",")
        if part.strip().isdigit()
    }
    if not ids and ticket.current_group_id:
        ids.add(ticket.current_group_id)
    return ids


def is_ticket_handler(ticket: Ticket, user_id: int, my_group_ids: set[int]) -> bool:
    """当前处理人判定：认领锁定优先，否则属于任一待处理分组。"""
    if ticket.claimed_by_id is not None:
        return ticket.claimed_by_id == user_id
    return bool(_csv_group_ids(ticket) & my_group_ids)


def can_pause_ticket(
    ticket: Ticket,
    user_id: int,
    my_group_ids: set[int],
    *,
    is_admin_user: bool,
    pause_type: str,
    config: dict,
) -> bool:
    """是否允许发起指定类型的暂停（不含状态与必填项校验）。"""
    if is_admin_user:
        return True
    item = (config.get("types") or {}).get(pause_type)
    if not isinstance(item, dict):
        return False
    roles = set(item.get("allow_roles") or [])
    if ticket.priority == "critical" and pause_type in CRITICAL_ADMIN_ONLY_TYPES:
        return False
    if "creator" in roles and ticket.created_by_id == user_id:
        return True
    if "handler" in roles and is_ticket_handler(ticket, user_id, my_group_ids):
        return True
    return False


def can_resume_ticket(
    ticket: Ticket,
    pause: TicketPause,
    user_id: int,
    my_group_ids: set[int],
    *,
    is_admin_user: bool,
) -> bool:
    """是否允许手动恢复：管理员 / 暂停发起人 / 发起人（本人发起或用户反馈类）/ 当前处理人。"""
    if is_admin_user:
        return True
    if pause.paused_by_id == user_id:
        return True
    if ticket.created_by_id == user_id and (
        pause.paused_by_id == user_id or pause.pause_type == "user_feedback"
    ):
        return True
    return is_ticket_handler(ticket, user_id, my_group_ids)


def get_active_pause(db: Session, ticket: Ticket) -> TicketPause | None:
    """取工单当前活动暂停记录。"""
    if not ticket.active_pause_id:
        return None
    return db.query(TicketPause).filter(TicketPause.id == ticket.active_pause_id).first()


def _validate_detail(ticket: Ticket, pause_type: str, detail: dict) -> None:
    """校验分类必填信息。"""
    required = REQUIRED_DETAIL_KEYS.get(pause_type, ())
    missing = [
        key for key in required
        if not str((detail or {}).get(key) or "").strip()
    ]
    if missing:
        labels = {"supplement_items": "补充事项", "partner": "协作方",
                  "feedback_items": "待确认事项", "window_start": "窗口开始时间",
                  "window_end": "窗口结束时间", "master_ticket_no": "主工单号"}
        raise PauseError(
            422, "PAUSE_DETAIL_REQUIRED",
            "缺少必填信息：" + "、".join(labels.get(k, k) for k in missing),
        )
    if pause_type == "duplicate_merge":
        master = str(detail.get("master_ticket_no") or "").strip()
        if master.upper() == (ticket.ticket_no or "").upper():
            raise PauseError(422, "PAUSE_DETAIL_INVALID", "主工单不能是当前工单本身")
    if pause_type == "business_window":
        start = _to_naive_beijing(_parse_dt(detail.get("window_start")))
        end = _to_naive_beijing(_parse_dt(detail.get("window_end")))
        if start and end and end <= start:
            raise PauseError(422, "PAUSE_DETAIL_INVALID", "变更窗口结束时间必须晚于开始时间")


def _parse_dt(value) -> datetime | None:
    """解析 detail 中可能为 ISO 字符串的时间（容错，解析失败返回 None）。"""
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def _build_snapshot(ticket: Ticket, now: datetime) -> dict:
    """暂停瞬间的归属快照，用于恢复时检测冲突。"""
    return {
        "node_key": ticket.current_node_key,
        "node_name": ticket.current_node_name,
        "current_group_id": ticket.current_group_id,
        "current_group_ids": sorted(_csv_group_ids(ticket)),
        "claimed_by_id": ticket.claimed_by_id,
        "arrived_at": to_beijing_iso(ticket.arrived_at),
        "paused_at": to_beijing_iso(now),
    }


def create_pause(
    db: Session,
    ticket: Ticket,
    *,
    user_id: int,
    user_name: str,
    my_group_ids: set[int],
    is_admin_user: bool,
    pause_type: str,
    reason: str,
    expected_resume_at: datetime | None = None,
    detail: dict | None = None,
    necessity: str | None = None,
    batch_id: str | None = None,
) -> tuple[TicketPause, bool]:
    """创建暂停。返回 ``(暂停记录, 是否新建)``；已暂停时幂等返回现有记录。"""
    if ticket.status == "paused":
        existing = get_active_pause(db, ticket)
        if existing:
            return existing, False
        raise PauseError(409, "TICKET_PAUSED", "工单已暂停")
    if ticket.status != "processing":
        raise PauseError(400, "TICKET_NOT_PROCESSING", "工单已完结，不能暂停")

    config = get_pause_config(db)
    if not config.get("enabled", True):
        raise PauseError(403, "PAUSE_DISABLED", "工单暂停功能未启用")
    item = pause_type_config(config, pause_type)
    if not item.get("enabled", True):
        raise PauseError(422, "PAUSE_TYPE_DISABLED", f"暂停类型「{item.get('label') or pause_type}」已停用")
    if batch_id and item.get("allow_batch") is False:
        raise PauseError(422, "PAUSE_BATCH_FORBIDDEN", "该暂停类型不支持批量操作")

    clean_reason = sanitize_text(str(reason or "")).strip()
    if not clean_reason:
        raise PauseError(422, "PAUSE_REASON_REQUIRED", "暂停原因不能为空")
    clean_necessity = sanitize_text(str(necessity or "")).strip() or None

    if not can_pause_ticket(
        ticket, user_id, my_group_ids,
        is_admin_user=is_admin_user, pause_type=pause_type, config=config,
    ):
        raise PauseError(403, "PAUSE_FORBIDDEN", "您无权以该类型暂停此工单")

    if ticket.priority == "critical" and not is_admin_user:
        if not clean_necessity:
            raise PauseError(422, "PAUSE_NECESSITY_REQUIRED", "紧急工单暂停必须填写必要性说明")

    _validate_detail(ticket, pause_type, detail or {})

    now = beijing_now()
    max_minutes = int(item.get("max_minutes") or config.get("max_pause_minutes") or 1440)
    max_minutes = min(max_minutes, int(config.get("max_pause_minutes") or max_minutes))
    expire_at = now + timedelta(minutes=max_minutes)

    expected = _to_naive_beijing(expected_resume_at)
    if item.get("require_expected_resume") and not expected:
        raise PauseError(422, "PAUSE_EXPECTED_REQUIRED", "该暂停类型必须填写期望恢复时间")
    if expected:
        if expected <= now:
            raise PauseError(422, "PAUSE_EXPECTED_INVALID", "期望恢复时间必须晚于当前时间")
        # 超出系统上限时按到期时间截断（不阻断操作）
        if expected > expire_at:
            expected = expire_at

    if not is_admin_user:
        total = int(ticket.pause_total_minutes or 0)
        if total >= int(config.get("max_total_pause_minutes") or 0):
            raise PauseError(422, "PAUSE_EXCEEDS_LIMIT", "工单累计暂停时长已达上限，请联系管理员")
        if int(ticket.pause_count or 0) >= int(config.get("max_pause_count") or 0):
            raise PauseError(422, "PAUSE_EXCEEDS_LIMIT", "工单暂停次数已达上限，请联系管理员")

    pause = TicketPause(
        ticket_id=ticket.id,
        pause_no=int(ticket.pause_count or 0) + 1,
        pause_type=pause_type,
        reason=clean_reason,
        detail=detail or {},
        status="active",
        active_key=ticket.id,
        paused_by_id=user_id,
        paused_by_name=user_name,
        paused_at=now,
        expected_resume_at=expected,
        expire_at=expire_at,
        policy_snapshot=copy.deepcopy(item),
        batch_id=batch_id,
    )
    db.add(pause)
    db.flush()  # 取 pause.id

    ticket.status = "paused"
    ticket.active_pause_id = pause.id
    ticket.pause_type = pause_type
    ticket.paused_at = now
    ticket.pause_expire_at = expire_at
    ticket.paused_by_id = user_id
    ticket.paused_by_name = user_name
    ticket.pause_count = int(ticket.pause_count or 0) + 1
    ticket.pause_snapshot = _build_snapshot(ticket, now)
    # 暂停瞬间的归属快照需在状态变更前取，这里以暂停前字段为准已写入 snapshot，
    # 不再修改 current_node/current_group/claimed_by，恢复时原地继续。

    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=ticket.current_node_key or "",
        node_name=ticket.current_node_name or "",
        group_id=ticket.current_group_id,
        handler_id=user_id,
        handler_name=user_name,
        action="pause",
        field_values={
            "pause_type": pause_type,
            "pause_type_label": item.get("label") or pause_type,
            "reason_visibility": item.get("reason_visibility") or "participants",
            "reason": clean_reason,
            "expected_resume_at": to_beijing_iso(expected),
            "expire_at": to_beijing_iso(expire_at),
            "necessity": clean_necessity,
        },
        comment=clean_reason,
    ))
    return pause, True


def resume_pause(
    db: Session,
    ticket: Ticket,
    *,
    user_id: int,
    user_name: str,
    my_group_ids: set[int],
    is_admin_user: bool,
    comment: str | None = None,
    force: bool = False,
    resume_mode: str | None = None,
) -> TicketPause:
    """恢复暂停：原地回到 processing，冻结的节点停留计时顺延。"""
    if ticket.status != "paused":
        raise PauseError(409, "TICKET_NOT_PAUSED", "工单当前未暂停")
    pause = get_active_pause(db, ticket)
    if not pause or pause.status != "active":
        raise PauseError(409, "TICKET_NOT_PAUSED", "未找到有效的暂停记录")

    if force and not is_admin_user:
        raise PauseError(403, "PAUSE_FORBIDDEN", "仅管理员可强制恢复工单")
    if not force and not can_resume_ticket(
        ticket, pause, user_id, my_group_ids, is_admin_user=is_admin_user,
    ):
        raise PauseError(403, "PAUSE_FORBIDDEN", "您无权恢复此工单")

    now = beijing_now()
    paused_at = ticket.paused_at or pause.paused_at or now
    duration = max(0, int((now - paused_at).total_seconds() // 60))
    mode = resume_mode or ("force" if force else "manual")

    pause.status = "resumed"
    pause.active_key = None
    pause.resumed_at = now
    pause.resumed_by_id = user_id
    pause.resumed_by_name = user_name
    pause.resume_mode = mode
    pause.duration_minutes = duration

    # 归属冲突检测：暂停期间被改派/认领/分组变更
    snapshot = ticket.pause_snapshot if isinstance(ticket.pause_snapshot, dict) else {}
    conflict = bool(
        snapshot
        and (
            set(snapshot.get("current_group_ids") or []) != _csv_group_ids(ticket)
            or snapshot.get("claimed_by_id") != ticket.claimed_by_id
            or snapshot.get("node_key") != ticket.current_node_key
        )
    )
    pause.conflict_flag = conflict

    ticket.status = "processing"
    ticket.active_pause_id = None
    ticket.paused_at = None
    ticket.pause_expire_at = None
    ticket.pause_total_minutes = int(ticket.pause_total_minutes or 0) + duration
    # 节点停留计时冻结：恢复后整体顺延暂停时长，并重置节点提醒进度
    if ticket.arrived_at:
        shifted = ticket.arrived_at + timedelta(minutes=duration)
        ticket.arrived_at = min(shifted, now)
    else:
        ticket.arrived_at = now
    ticket.first_reminded_at = None
    ticket.last_reminded_at = None
    ticket.remind_count = 0

    db.add(TicketNodeRecord(
        ticket_id=ticket.id,
        node_key=ticket.current_node_key or "",
        node_name=ticket.current_node_name or "",
        group_id=ticket.current_group_id,
        handler_id=user_id,
        handler_name=user_name,
        action="resume",
        field_values={
            "pause_type": pause.pause_type,
            "duration_minutes": duration,
            "resume_mode": mode,
            "conflict": conflict,
        },
        comment=sanitize_text(comment).strip() or None if comment else None,
    ))
    return pause


def force_resume_for_cancel(
    db: Session,
    ticket: Ticket,
    *,
    user_id: int,
    user_name: str,
) -> TicketPause | None:
    """取消暂停中的工单前补记强制恢复，保证状态链完整。"""
    if ticket.status != "paused":
        return None
    pause = get_active_pause(db, ticket)
    if not pause:
        return None
    return resume_pause(
        db, ticket,
        user_id=user_id, user_name=user_name,
        my_group_ids=set(), is_admin_user=True,
        comment="暂停期间取消工单，自动补记强制恢复",
        force=True, resume_mode="force",
    )
