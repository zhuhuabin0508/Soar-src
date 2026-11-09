"""封禁工作流实例与触发规则管理 API。

- ``GET/POST /ban-workflow/instances*``：实例列表/详情（含全部节点日志、智能体调用、
  审批与封禁记录）/取消
- ``GET/POST/PUT/DELETE /ban-workflow/rules``：触发规则 CRUD（修改实时生效）
- ``GET /ban-workflow/approvals`` + ``POST .../approve|reject|escalate``：封禁审批中心
- ``GET /ban-workflow/anbotong/blacklist`` + ``GET .../blacklist/query``：安博通黑名单
  分页拉取与单个 IP 精确查询（需 ban_workflow:view）；
  ``POST .../blacklist/unban`` 行内解封（需 ban_workflow:edit）
- ``GET /ban-workflow/asset-match``：手动封禁弹窗资产匹配预检（资产发现 +
  资产清单双源并行查询，复用工单安全上下文匹配规则，需 ban_workflow:view）
- ``GET /ban-workflow/banned-ips`` + ``POST .../{id}/unban``：封禁工作台（已封禁 IP 模块）
- ``POST /ban-workflow/banned-ips/batch-delete``：封禁记录批量删除（需 ban_workflow:delete）
- ``GET /ban-workflow/banned-ips/export/csv`` / ``GET .../import/template`` /
  ``POST .../import/csv``：封禁工作台 CSV/Excel 导入导出（导入仅入库待同步）
- ``POST /ban-workflow/banned-ips/sync-preview`` / ``POST .../sync``：同步安博通封禁前
  的资产匹配预览与用户确认下发
- ``GET /ban-workflow/circuit-breaker`` / ``POST .../reset``：熔断状态查询与人工恢复
- ``GET /ban-workflow/stats``：监控页工作流统计卡片数据
"""
import csv
import io
import ipaddress
import json
import logging
from datetime import datetime, timedelta
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func, or_
from sqlalchemy.orm import Session

from app.core.timezone import BEIJING_TZ, beijing_now
from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.devices import ban_target
from app.models.alert_event import AlertEvent
from app.models.banned_ip import BannedIP
from app.models.ticket import Ticket
from app.models.user import User
from app.models.workflow_ban import (
    AgentInvocationLog, ApprovalTicket, BanRecord, MonitorLog,
    WorkflowInstance, WorkflowNodeLog, WorkflowTriggerRule,
)
from app.workflow import trigger as trigger_mod
from app.workflow.audit import write_audit
from app.workflow.engine import cancel_instance, run_instance
from app.workflow.nodes import NODE_LABELS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ban-workflow", tags=["ban-workflow"])

_INSTANCE_STATUS_LABELS = {
    "running": "运行中", "waiting_approval": "等待审批", "success": "已完成",
    "error": "异常", "skipped": "已跳过", "cancelled": "已取消", "escalated": "已升级",
}
_FINAL_RESULT_LABELS = {
    "banned": "已封禁", "already_banned": "已封禁(重复)", "waiting_approval": "待审批",
    "monitoring": "持续监控", "cancelled": "已取消", "error": "异常", "skipped": "已跳过",
    "escalated": "已升级",
}
_BAN_SOURCE_LABELS = {
    "auto": "自动封禁", "approval": "审批封禁", "manual": "手动封禁", "chat": "聊天封禁",
    "ticket": "工单同步", "import": "导入封禁",
}
# 工单智能体研判建议动作中文（工单同步封禁详情的研判结论展示用）
_TICKET_AGENT_ACTION_LABELS = {"ban": "建议封禁", "monitor": "观察监控", "ignore": "忽略（暂不处置）"}

# 封禁等级（工作台口径：critical 为最高级）中文映射，CSV 导入导出用
_LEVEL_LABELS = {"low": "低", "medium": "中", "high": "高", "critical": "严重"}


def _duration_days_label(seconds: int, is_permanent: bool) -> str:
    """封禁时长秒数 → 天数字符串（CSV 导出用）。

    保留至多 6 位小数并去掉尾零（如 43200s → ``0.5``、604800s → ``7``）；
    6 位小数对应亚秒级精度，保证「导出 → 改行 → 重新导入」往返不产生时长漂移；
    永久封禁返回空串（由「是否永久」列表达）。
    """
    if is_permanent or not seconds:
        return ""
    days = seconds / 86400
    if days == int(days):
        return str(int(days))
    return f"{days:.6f}".rstrip("0").rstrip(".")


def _parse_days(value: str) -> int:
    """解析「封禁时长(天)」列 → 秒数。

    支持小数（如 ``0.5`` 天 = 12 小时）；无效值抛 ``ValueError``（调用方记入行错误）。
    """
    days = float(value)
    if days <= 0 or days > 36500:
        raise ValueError(f"封禁时长天数无效: {value}")
    return max(1, round(days * 86400))


# ----------------------------------------------------------------------
# 封禁工作台导入解析（与资产导入同口径：CSV / XLSX / XLS + 逐行校验）
# ----------------------------------------------------------------------
_WB_IMPORT_MAX_ROWS = 20000
# 单次上传体积上限（xlsx/xls 解析会整体载入内存，必须限制，避免拖垮进程）
_WB_IMPORT_MAX_BYTES = 20 * 1024 * 1024
_WB_IMPORT_HEADER_LABELS = {
    "ip": "IP地址", "ban_level": "封禁等级", "ban_duration_days": "封禁时长(天)",
    "is_permanent": "是否永久", "reason": "封禁原因", "region": "归属地区",
    "ban_device": "封堵设备",
}
# 表头别名：兼容模板中文列名、导出列名与英文 key（归一化后比较）
_WB_IMPORT_HEADER_ALIASES = {
    "ip地址": "ip", "ip": "ip", "封禁目标": "ip",
    "封禁等级": "ban_level", "等级": "ban_level", "ban_level": "ban_level",
    "封禁时长(天)": "ban_duration_days", "封禁时长": "ban_duration_days",
    "时长(天)": "ban_duration_days", "时长": "ban_duration_days",
    "ban_duration_days": "ban_duration_days", "ban_duration": "ban_duration_days",
    "是否永久": "is_permanent", "永久": "is_permanent", "is_permanent": "is_permanent",
    "封禁原因": "reason", "原因": "reason", "封禁理由": "reason", "reason": "reason",
    "归属地区": "region", "地区": "region", "region": "region",
    "封堵设备": "ban_device", "封堵设备名称": "ban_device", "封禁设备": "ban_device",
    "设备名称": "ban_device", "设备": "ban_device", "ban_device": "ban_device",
}
# 封禁等级兼容中英文及常见等级叫法
_WB_IMPORT_LEVEL_ALIASES = {
    "低": "low", "低危": "low", "low": "low",
    "中": "medium", "中危": "medium", "medium": "medium",
    "高": "high", "高危": "high", "high": "high",
    "严重": "critical", "严重级": "critical", "critical": "critical", "serious": "critical",
}
_WB_PERMANENT_TRUE = {"是", "永久", "true", "yes", "y", "1"}
_WB_PERMANENT_FALSE = {"否", "false", "no", "n", "0"}


def _wb_norm_header(value) -> str:
    """表头归一化：去空白/BOM、全角括号转半角、转小写。"""
    text = "" if value is None else str(value)
    text = text.replace("\ufeff", "").replace("（", "(").replace("）", ")")
    return "".join(text.split()).lower()


def _wb_cell_text(value) -> str:
    """Excel 单元格 → 去空白字符串。

    兼容 Excel 常见类型：``None`` → 空串；布尔 → 是/否；整数值浮点（1.0）→ ``1``，
    避免「是否永久」列被 Excel 存成数字后判定失败。
    """
    if value is None:
        return ""
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def _decode_wb_import_text(raw: bytes) -> str:
    """解码导入文本：优先 UTF-8(SIG)，回退 GB18030（兼容 Excel 导出的中文 CSV）。"""
    for enc in ("utf-8-sig", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def _read_wb_import_matrix(filename: str, raw: bytes) -> list[list]:
    """读取 CSV/XLSX/XLS 为二维单元格矩阵（保留空行由调用方过滤）。"""
    if filename.endswith(".csv"):
        text = _decode_wb_import_text(raw)
        return [list(row) for row in csv.reader(io.StringIO(text))]
    if filename.endswith(".xlsx"):
        from openpyxl import load_workbook

        wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
        ws = wb.active
        return [list(row) for row in ws.iter_rows(values_only=True)]
    if filename.endswith(".xls"):
        import xlrd

        book = xlrd.open_workbook(file_contents=raw)
        sheet = book.sheet_by_index(0)
        return [[sheet.cell_value(r, c) for c in range(sheet.ncols)] for r in range(sheet.nrows)]
    raise ValueError(f"不支持的文件类型: {filename}（仅支持 .csv/.xlsx/.xls）")


def _parse_wb_import_file(filename: str, raw: bytes) -> tuple[list[dict], list[str]]:
    """解析导入文件为行字典（键为统一字段 key），并校验表头。

    Returns:
        ``(rows, unknown_headers)``；``rows`` 中每行额外带 ``_row``（文件行号），
        仅包含表头中实际存在的字段（调用方据此区分「列缺失」与「值非法」）。

    Raises:
        ValueError: 文件为空、缺少必需列、行数超限等可直接展示的错误。
    """
    matrix = _read_wb_import_matrix(filename, raw)
    header_idx = None
    for i, row in enumerate(matrix):
        if any(_wb_cell_text(c) for c in row):
            header_idx = i
            break
    if header_idx is None:
        raise ValueError("文件为空")

    header_row = matrix[header_idx]
    keys: list[str] = []
    unknown: list[str] = []
    for cell in header_row:
        raw_header = _wb_cell_text(cell)
        key = _WB_IMPORT_HEADER_ALIASES.get(_wb_norm_header(raw_header))
        if key is None:
            if raw_header and raw_header not in unknown:
                unknown.append(raw_header)
            continue
        if key not in keys:
            keys.append(key)
    missing = [k for k in ("ip", "reason") if k not in keys]
    if missing:
        names = "、".join(_WB_IMPORT_HEADER_LABELS[k] for k in missing)
        raise ValueError(f"缺少必需列：{names}。请使用模板或检查表头是否与模板一致")

    rows: list[dict] = []
    for row_no, row in enumerate(matrix[header_idx + 1:], start=header_idx + 2):
        values = [_wb_cell_text(c) for c in row]
        if not any(values):
            continue
        # 以 # 开头的说明行（模板底部常见）自动跳过
        if values[0].startswith("#"):
            continue
        item: dict = {"_row": row_no}
        for i in range(len(header_row)):
            # 行短于表头时按空白补齐，保证「列存在但值为空」也能被字段校验拦截
            cell = row[i] if i < len(row) else None
            # 同一列可能多个表头映射到同一 key：保留首个非空值
            key = _WB_IMPORT_HEADER_ALIASES.get(_wb_norm_header(header_row[i]))
            if key is not None:
                val = _wb_cell_text(cell)
                if key not in item or not item.get(key):
                    item[key] = val
        rows.append(item)

    if len(rows) > _WB_IMPORT_MAX_ROWS:
        raise ValueError(f"行数过多（{len(rows)}），请分批导入（每次 ≤{_WB_IMPORT_MAX_ROWS} 行）")
    return rows, unknown


def _validate_wb_import_row(row: dict) -> dict:
    """校验单行导入数据并归一化；非法时抛 ``ValueError``（消息直接展示给用户）。"""
    from app.core.ip_validation import IPValidationError, validate_ban_entry

    if "ip" not in row:
        raise ValueError("缺少 IP地址 列")
    raw_ip = _wb_cell_text(row.get("ip"))
    if not raw_ip:
        raise ValueError("IP地址不能为空")
    # IP地址列同时接受 IP / CIDR / 范围 / 域名（安博通 blist 条目两者皆可）
    try:
        ip = validate_ban_entry(raw_ip, "IP地址")
    except IPValidationError as exc:
        raise ValueError(str(exc)) from exc

    if "ban_level" in row:
        level_raw = _wb_cell_text(row.get("ban_level")).lower()
        if not level_raw:
            raise ValueError("封禁等级不能为空（低/中/高/严重）")
        ban_level = _WB_IMPORT_LEVEL_ALIASES.get(level_raw)
        if ban_level is None:
            raise ValueError("封禁等级不合法，仅支持 低/中/高/严重")
    else:
        ban_level = "medium"

    if "is_permanent" in row:
        permanent_raw = _wb_cell_text(row.get("is_permanent")).lower()
        if permanent_raw in _WB_PERMANENT_TRUE:
            is_permanent = True
        elif permanent_raw in _WB_PERMANENT_FALSE or not permanent_raw:
            # 空值按「非永久」处理（模板常留空），由封禁时长决定
            is_permanent = False
        else:
            raise ValueError("是否永久不合法，仅支持 是/否")
    else:
        is_permanent = False

    if is_permanent:
        ban_duration = 0
    elif "ban_duration_days" in row:
        days_raw = _wb_cell_text(row.get("ban_duration_days"))
        if not days_raw:
            raise ValueError("封禁时长(天)不能为空")
        try:
            ban_duration = _parse_days(days_raw)
        except (TypeError, ValueError) as exc:
            raise ValueError(str(exc) or "封禁时长(天)不是有效数字") from exc
    else:
        ban_duration = 86400

    reason = _wb_cell_text(row.get("reason"))
    if not reason:
        raise ValueError("封禁原因不能为空")
    if len(reason) > 500:
        raise ValueError("封禁原因过长（最多 500 字符）")

    region = _wb_cell_text(row.get("region")) if "region" in row else ""
    if len(region) > 64:
        raise ValueError("归属地区过长（最多 64 字符）")

    # 封堵设备可选：留空则同步时使用默认「安博通阻断器」
    ban_device = _wb_cell_text(row.get("ban_device")) if "ban_device" in row else ""
    if len(ban_device) > 255:
        raise ValueError("封堵设备名称过长（最多 255 字符）")

    return {
        "ip": ip,
        "ban_level": ban_level,
        "ban_duration": ban_duration,
        "is_permanent": is_permanent,
        "reason": reason,
        "region": region,
        "ban_device": ban_device,
    }


def _jload(raw, default=None):
    if isinstance(raw, str) and raw:
        try:
            return json.loads(raw)
        except (ValueError, TypeError):
            return raw
    return default if default is not None else raw


def _parse_dt(raw: str) -> Optional[datetime]:
    if not raw:
        return None
    try:
        dt = datetime.fromisoformat(raw)
        return dt.replace(tzinfo=None) if dt.tzinfo else dt
    except ValueError:
        return None


# ======================================================================
# 实例管理
# ======================================================================
@router.get("/instances", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def list_instances(
    status: str = Query("", description="running/waiting_approval/success/error/skipped/cancelled/escalated"),
    ip: str = Query("", description="源 IP 精确匹配"),
    rule_id: int = Query(0, description="触发规则 ID"),
    start_time: str = Query(""),
    end_time: str = Query(""),
    keyword: str = Query("", description="IP/告警名称关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """实例列表（分页 + 状态/IP/时间范围/触发规则筛选，全部后端执行）。"""
    query = db.query(WorkflowInstance)
    if status:
        query = query.filter(WorkflowInstance.status == status)
    if ip:
        query = query.filter(WorkflowInstance.src_ip == ip)
    if rule_id:
        query = query.filter(WorkflowInstance.trigger_rule_id == rule_id)
    st, et = _parse_dt(start_time), _parse_dt(end_time)
    if st:
        query = query.filter(WorkflowInstance.created_at >= st)
    if et:
        query = query.filter(WorkflowInstance.created_at < et)
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(or_(WorkflowInstance.src_ip.ilike(like), WorkflowInstance.alert_uuid.ilike(like)))

    total = query.count()
    rows = (
        query.order_by(WorkflowInstance.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    # 触发规则名映射
    rule_names = {r.id: r.rule_name for r in db.query(WorkflowTriggerRule.id, WorkflowTriggerRule.rule_name).all()}
    # 触发告警名称映射
    alert_ids = [r.alert_id for r in rows if r.alert_id]
    alert_names = {}
    if alert_ids:
        for a in db.query(AlertEvent.id, AlertEvent.alert_name).filter(AlertEvent.id.in_(alert_ids)).all():
            alert_names[a.id] = a.alert_name or ""
    items = []
    for r in rows:
        duration_ms = None
        if r.finished_at and r.started_at:
            duration_ms = int((r.finished_at - r.started_at).total_seconds() * 1000)
        items.append({
            "id": r.id,
            "alert_id": r.alert_id,
            "alert_uuid": r.alert_uuid,
            "alert_name": alert_names.get(r.alert_id, ""),
            "src_ip": r.src_ip,
            "trigger_rule_id": r.trigger_rule_id,
            "trigger_rule_name": rule_names.get(r.trigger_rule_id, ""),
            "status": r.status,
            "status_label": _INSTANCE_STATUS_LABELS.get(r.status, r.status),
            "current_node": r.current_node,
            "current_node_label": NODE_LABELS.get(r.current_node, r.current_node),
            "final_result": r.final_result,
            "final_result_label": _FINAL_RESULT_LABELS.get(r.final_result or "", ""),
            "duration_ms": duration_ms,
            "error_msg": r.error_msg,
            "created_at": r.created_at,
            "finished_at": r.finished_at,
        })
    return {"total": total, "items": items, "page": page, "page_size": page_size}


@router.get("/instances/{instance_id}", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def get_instance(instance_id: int, db: Session = Depends(get_db)) -> dict:
    """实例详情：基础信息 + 全部节点日志时间线 + 智能体调用 + 审批 + 封禁/监控记录。"""
    instance = db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
    if instance is None:
        raise HTTPException(status_code=404, detail="工作流实例不存在")

    nodes = (
        db.query(WorkflowNodeLog)
        .filter(WorkflowNodeLog.instance_id == instance_id)
        .order_by(WorkflowNodeLog.id.asc())
        .all()
    )
    node_logs = [{
        "id": n.id,
        "node_key": n.node_key,
        "node_name": n.node_name,
        "node_order": n.node_order,
        "status": n.status,
        "input": _jload(n.input),
        "output": _jload(n.output),
        "start_time": n.start_time,
        "end_time": n.end_time,
        "duration_ms": int((n.end_time - n.start_time).total_seconds() * 1000) if n.end_time and n.start_time else None,
        "error_msg": n.error_msg,
    } for n in nodes]

    agent_logs = (
        db.query(AgentInvocationLog)
        .filter(AgentInvocationLog.workflow_instance_id == instance_id)
        .order_by(AgentInvocationLog.id.asc())
        .all()
    )
    agent_invocations = [{
        "id": a.id,
        "node_key": a.node_key,
        "request_body": _jload(a.request_body),
        "response_body": _jload(a.response_body),
        "model_name": a.model_name,
        "input_tokens": a.input_tokens,
        "output_tokens": a.output_tokens,
        "duration_ms": a.duration_ms,
        "status": a.status,
        "error_msg": a.error_msg,
        "created_at": a.created_at,
    } for a in agent_logs]

    ticket = db.query(ApprovalTicket).filter(
        ApprovalTicket.workflow_instance_id == instance_id,
    ).order_by(ApprovalTicket.id.desc()).first()
    ban_record = db.query(BanRecord).filter(
        BanRecord.source_instance_id == instance_id,
    ).order_by(BanRecord.id.desc()).first()
    monitor = db.query(MonitorLog).filter(
        MonitorLog.instance_id == instance_id,
    ).order_by(MonitorLog.id.desc()).first()

    duration_ms = None
    if instance.finished_at and instance.started_at:
        duration_ms = int((instance.finished_at - instance.started_at).total_seconds() * 1000)
    alert_name = ""
    if instance.alert_id:
        alert_row = db.query(AlertEvent.alert_name).filter(AlertEvent.id == instance.alert_id).first()
        alert_name = (alert_row.alert_name if alert_row else "") or ""
    return {
        "id": instance.id,
        "alert_id": instance.alert_id,
        "alert_uuid": instance.alert_uuid,
        "alert_name": alert_name,
        "src_ip": instance.src_ip,
        "strategy_id": instance.strategy_id,
        "trigger_rule_id": instance.trigger_rule_id,
        "status": instance.status,
        "status_label": _INSTANCE_STATUS_LABELS.get(instance.status, instance.status),
        "current_node": instance.current_node,
        "current_node_label": NODE_LABELS.get(instance.current_node, instance.current_node),
        "final_result": instance.final_result,
        "final_result_label": _FINAL_RESULT_LABELS.get(instance.final_result or "", ""),
        "error_msg": instance.error_msg,
        "started_at": instance.started_at,
        "finished_at": instance.finished_at,
        "duration_ms": duration_ms,
        "created_at": instance.created_at,
        "node_logs": node_logs,
        "agent_invocations": agent_invocations,
        "approval_ticket": ({
            "id": ticket.id, "ip": ticket.ip, "status": ticket.status,
            "alert_summary": _jload(ticket.alert_summary),
            "agent_decision": _jload(ticket.agent_decision),
            "ban_plan": _jload(ticket.ban_plan),
            "asset_info": _jload(ticket.asset_info),
            "approver": ticket.approver, "approval_comment": ticket.approval_comment,
            "approved_at": ticket.approved_at, "deadline": ticket.deadline,
            "created_at": ticket.created_at,
        } if ticket else None),
        "ban_record": ({
            "id": ban_record.id, "ip": ban_record.ip, "ban_level": ban_record.ban_level,
            "ban_duration": ban_record.ban_duration, "is_permanent": ban_record.is_permanent,
            "expire_time": ban_record.expire_time, "reason": ban_record.reason,
            "record_id": ban_record.record_id, "status": ban_record.status,
            "created_at": ban_record.created_at,
        } if ban_record else None),
        "monitor_log": ({
            "id": monitor.id, "ip": monitor.ip, "risk_level": monitor.risk_level,
            "advice": monitor.advice, "reasons": _jload(monitor.reasons), "created_at": monitor.created_at,
        } if monitor else None),
    }


@router.post("/instances/{instance_id}/cancel", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def cancel_instance_api(
    instance_id: int,
    body: dict,
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """手动取消实例。运行中/等待审批可取消；已下发封禁不可取消（只能走解封）。"""
    instance = db.query(WorkflowInstance).filter(WorkflowInstance.id == instance_id).first()
    if instance is None:
        raise HTTPException(status_code=404, detail="工作流实例不存在")
    if instance.status in ("success", "error", "skipped", "cancelled", "escalated"):
        raise HTTPException(status_code=400, detail="实例已结束，无需取消")
    if instance.status == "success" and instance.final_result == "banned":
        raise HTTPException(status_code=400, detail="已下发封禁的实例不可取消，请在封禁工作台解封")
    reason = str(body.get("reason") or "手动取消")
    ok = cancel_instance(db, instance, operator=user.username, reason=reason)
    write_audit(
        db, action="workflow_cancel", resource_type="workflow_instance", resource_id=instance_id,
        detail={"ip": instance.src_ip, "reason": reason},
        operator=user.username, ip_address=request.client.host if request.client else "",
        user_id=user.id,
    )
    return {"ok": ok, "status": "cancelled"}


# ======================================================================
# 触发规则管理（修改实时生效：worker 每次按需查库）
# ======================================================================
def _validate_conditions(conditions: dict) -> None:
    """校验条件结构。"""
    allowed = {"risk_levels", "min_severity", "directions", "src_ip_tags", "alert_name_keywords", "threat_classes"}
    unknown = set(conditions.keys()) - allowed
    if unknown:
        raise HTTPException(status_code=400, detail=f"不支持的条件字段: {', '.join(unknown)}")
    for key in ("risk_levels", "directions", "src_ip_tags", "alert_name_keywords", "threat_classes"):
        if key in conditions and not isinstance(conditions[key], list):
            raise HTTPException(status_code=400, detail=f"条件 {key} 必须为列表")
    if "min_severity" in conditions and conditions["min_severity"] is not None:
        try:
            int(conditions["min_severity"])
        except (ValueError, TypeError):
            raise HTTPException(status_code=400, detail="min_severity 必须为整数")


class RuleBody(BaseModel):
    rule_name: str = Field(..., min_length=1, max_length=128)
    status: str = Field("enabled", pattern="^(enabled|disabled)$")
    conditions: dict = Field(default_factory=dict)
    cooldown_minutes: int = Field(60, ge=1, le=14400)
    priority: int = Field(0, ge=0, le=1000)


@router.get("/rules", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def list_rules(db: Session = Depends(get_db)) -> list[dict]:
    """触发规则列表。"""
    rows = db.query(WorkflowTriggerRule).order_by(WorkflowTriggerRule.priority.desc()).all()
    return [{
        "id": r.id,
        "rule_name": r.rule_name,
        "status": r.status,
        "conditions": _jload(r.conditions, {}),
        "cooldown_minutes": r.cooldown_minutes,
        "priority": r.priority,
        "created_at": r.created_at,
        "updated_at": r.updated_at,
    } for r in rows]


@router.post("/rules", status_code=201, dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def create_rule(body: RuleBody, db: Session = Depends(get_db)) -> dict:
    """创建触发规则（立即生效）。"""
    _validate_conditions(body.conditions)
    rule = WorkflowTriggerRule(
        rule_name=body.rule_name.strip(),
        status=body.status,
        conditions=json.dumps(body.conditions, ensure_ascii=False),
        cooldown_minutes=body.cooldown_minutes,
        priority=body.priority,
    )
    db.add(rule)
    db.commit()
    logger.info("触发规则创建: id=%s name=%s", rule.id, rule.rule_name)
    return {"id": rule.id, "rule_name": rule.rule_name}


@router.put("/rules/{rule_id}", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def update_rule(rule_id: int, body: RuleBody, db: Session = Depends(get_db)) -> dict:
    """更新触发规则（worker 按需查库，修改实时生效）。"""
    rule = db.query(WorkflowTriggerRule).filter(WorkflowTriggerRule.id == rule_id).first()
    if rule is None:
        raise HTTPException(status_code=404, detail="触发规则不存在")
    _validate_conditions(body.conditions)
    rule.rule_name = body.rule_name.strip()
    rule.status = body.status
    rule.conditions = json.dumps(body.conditions, ensure_ascii=False)
    rule.cooldown_minutes = body.cooldown_minutes
    rule.priority = body.priority
    db.commit()
    logger.info("触发规则更新: id=%s name=%s", rule.id, rule.rule_name)
    return {"ok": True}


@router.delete("/rules/{rule_id}", status_code=204, dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def delete_rule(rule_id: int, db: Session = Depends(get_db)) -> None:
    """删除触发规则。"""
    rule = db.query(WorkflowTriggerRule).filter(WorkflowTriggerRule.id == rule_id).first()
    if rule is None:
        raise HTTPException(status_code=404, detail="触发规则不存在")
    db.delete(rule)
    db.commit()


# ======================================================================
# 熔断
# ======================================================================
@router.get("/circuit-breaker", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def circuit_breaker_state() -> dict:
    """熔断状态查询。"""
    return trigger_mod.get_circuit_state()


@router.post("/circuit-breaker/reset", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def circuit_breaker_reset(
    request: Request,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """人工恢复熔断。"""
    state = trigger_mod.reset_circuit_breaker(operator=user.username)
    write_audit(
        db, action="circuit_breaker_reset", resource_type="ban_workflow", resource_id="circuit",
        detail={"result": state}, operator=user.username,
        ip_address=request.client.host if request.client else "", user_id=user.id,
    )
    return state


# ======================================================================
# 审批中心（封禁审批工单）
# ======================================================================
_TICKET_STATUS_LABELS = {
    "pending": "待审批", "approved": "已同意", "rejected": "已驳回",
    "escalated": "已升级", "timeout": "已超时",
}
_TAB_STATUS = {
    "pending": ["pending"],
    "approved": ["approved", "rejected", "escalated"],
    "timeout": ["timeout"],
}


def _ticket_item(t: ApprovalTicket) -> dict:
    """工单 → 前端列表项（含研判结论/封禁方案/剩余审批时间）。"""
    summary = _jload(t.alert_summary, {}) or {}
    decision = _jload(t.agent_decision, {}) or {}
    plan = _jload(t.ban_plan, {}) or {}
    remaining_ms = None
    if t.status == "pending" and t.deadline:
        remaining_ms = int((t.deadline - beijing_now()).total_seconds() * 1000)
    return {
        "id": t.id,
        "workflow_instance_id": t.workflow_instance_id,
        "ip": t.ip,
        "status": t.status,
        "status_label": _TICKET_STATUS_LABELS.get(t.status, t.status),
        "alert_name": summary.get("alert_name") or "",
        "risk_level": decision.get("risk_level") or summary.get("risk_level") or "",
        "action": decision.get("action") or "",
        "need_confirm": decision.get("need_confirm"),
        "ban_level": plan.get("ban_level") or "",
        "ban_duration": plan.get("ban_duration"),
        "is_permanent": plan.get("is_permanent"),
        "reasons": decision.get("reasons") or [],
        "monitoring_advice": decision.get("monitoring_advice") or "",
        "alert_summary": summary,
        "agent_decision": decision,
        "ban_plan": plan,
        "asset_info": _jload(t.asset_info, {}) or {},
        "approver": t.approver or "",
        "approval_comment": t.approval_comment or "",
        "approved_at": t.approved_at,
        "deadline": t.deadline,
        "remaining_ms": remaining_ms,
        "created_at": t.created_at,
    }


@router.get("/approvals", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def list_approvals(
    tab: str = Query("pending", description="pending（待审批）/ approved（已审批）/ timeout（已超时）"),
    keyword: str = Query("", description="IP / 告警名称关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """审批工单列表（三个 Tab + 关键词筛选 + 分页）。"""
    statuses = _TAB_STATUS.get(tab)
    if statuses is None:
        raise HTTPException(status_code=400, detail="tab 取值须为 pending / approved / timeout")
    query = db.query(ApprovalTicket).filter(ApprovalTicket.status.in_(statuses))
    if keyword:
        like = f"%{keyword}%"
        query = query.filter(or_(ApprovalTicket.ip.ilike(like), ApprovalTicket.alert_summary.ilike(like)))
    total = query.count()
    rows = (
        query.order_by(ApprovalTicket.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    counts = {
        key: db.query(ApprovalTicket).filter(ApprovalTicket.status.in_(sts)).count()
        for key, sts in _TAB_STATUS.items()
    }
    return {
        "total": total, "items": [_ticket_item(t) for t in rows],
        "page": page, "page_size": page_size, "counts": counts,
    }


@router.get("/approvals/{ticket_id}", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def get_approval(ticket_id: int, db: Session = Depends(get_db)) -> dict:
    """审批工单详情（完整研判结论与决策依据）。"""
    ticket = db.query(ApprovalTicket).filter(ApprovalTicket.id == ticket_id).first()
    if ticket is None:
        raise HTTPException(status_code=404, detail="审批工单不存在")
    item = _ticket_item(ticket)
    instance = db.query(WorkflowInstance).filter(WorkflowInstance.id == ticket.workflow_instance_id).first()
    if instance is not None:
        item["instance_status"] = instance.status
        item["instance_status_label"] = _INSTANCE_STATUS_LABELS.get(instance.status, instance.status)
        item["final_result_label"] = _FINAL_RESULT_LABELS.get(instance.final_result or "", "")
    return item


def _apply_approval(
    db: Session,
    ticket_id: int,
    *,
    result: str,
    user: User,
    request: Request,
    comment: str = "",
) -> dict:
    """审批操作公共逻辑：更新工单 → 恢复实例执行 → 写审计（记录操作人与来源 IP）。"""
    ticket = db.query(ApprovalTicket).filter(ApprovalTicket.id == ticket_id).first()
    if ticket is None:
        raise HTTPException(status_code=404, detail="审批工单不存在")
    if ticket.status != "pending":
        raise HTTPException(status_code=400, detail=f"工单已处理（{_TICKET_STATUS_LABELS.get(ticket.status, ticket.status)}），不可重复操作")

    instance = db.query(WorkflowInstance).filter(WorkflowInstance.id == ticket.workflow_instance_id).first()
    if instance is None:
        raise HTTPException(status_code=404, detail="关联工作流实例不存在")
    if instance.status != "waiting_approval":
        raise HTTPException(status_code=400, detail="实例不在等待审批状态，无法处理")

    ticket.status = result
    ticket.approver = user.username
    ticket.approval_comment = comment or ""
    ticket.approved_at = beijing_now()
    db.commit()

    # 恢复实例：approval_result 节点按工单状态路由（同意→执行封禁；驳回/超时→持续监控；升级→终止）
    run_instance(instance.id, start_key="approval_result")
    db.refresh(instance)
    write_audit(
        db, action="approval", resource_type="approval_ticket", resource_id=ticket.id,
        detail={"result": result, "ip": ticket.ip, "comment": comment,
                "instance_id": instance.id, "final_result": instance.final_result},
        operator=user.username, ip_address=request.client.host if request.client else "",
        user_id=user.id,
    )
    return {
        "ok": True,
        "ticket_id": ticket.id,
        "result": result,
        "instance_status": instance.status,
        "final_result": instance.final_result,
        "final_result_label": _FINAL_RESULT_LABELS.get(instance.final_result or "", ""),
    }


@router.post("/approvals/{ticket_id}/approve", dependencies=[Depends(require_permission("approval", "approve"))])
def approve_ticket(
    ticket_id: int, body: dict, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """同意封禁：触发执行封禁节点。"""
    return _apply_approval(db, ticket_id, result="approved", user=user, request=request,
                           comment=str(body.get("comment") or "同意封禁"))


@router.post("/approvals/{ticket_id}/reject", dependencies=[Depends(require_permission("approval", "approve"))])
def reject_ticket(
    ticket_id: int, body: dict, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """驳回：需填写驳回原因，实例转持续监控。"""
    comment = str(body.get("reason") or body.get("comment") or "").strip()
    if not comment:
        raise HTTPException(status_code=400, detail="驳回需填写原因")
    return _apply_approval(db, ticket_id, result="rejected", user=user, request=request, comment=comment)


@router.post("/approvals/{ticket_id}/escalate", dependencies=[Depends(require_permission("approval", "approve"))])
def escalate_ticket(
    ticket_id: int, body: dict, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """升级：转人工调查，实例终止（escalated）。"""
    return _apply_approval(db, ticket_id, result="escalated", user=user, request=request,
                           comment=str(body.get("comment") or "升级转人工调查"))


@router.get("/anbotong/blacklist", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def get_anbotong_blacklist(
    request: Request,
    page: int = Query(1, ge=1, description="页码（1 起）"),
    count: int = Query(50, ge=1, le=1000, description="每页条数（1-1000）"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """分页拉取安博通阻断器当前黑名单列表（封禁工作台数据源）。

    调用设备「查询黑名单列表」动作，原样返回设备侧每条黑名单的全部字段
    （blist / age / leftTime / effectTime / reason / policy_group_name /
    state / enable / hit_num / node_id 等），供工作台与平台台账对照。
    设备响应不含总条数：page_full（本页是否满页）用于判定是否还有下一页；
    页码翻过末页返回空 items + note 提示。
    """
    from app.devices.anbotong import list_blacklist_on_anbotong

    result = list_blacklist_on_anbotong(
        db,
        page=page,
        count=count,
        source="workbench",
        user_id=user.id,
        source_ip=request.client.host if request.client else "",
    )
    if not result["success"]:
        raise HTTPException(status_code=502, detail=result.get("error") or "安博通阻断器黑名单拉取失败")
    return {
        "device": result.get("device"),
        "page": result.get("page", page),
        "count": result.get("count", count),
        "page_full": result.get("page_full", False),
        "paginated": result.get("paginated", True),
        "items": result.get("items", []),
        "note": result.get("note"),
        "fetched_at": result.get("fetched_at"),
    }


@router.get("/anbotong/blacklist/query", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def query_anbotong_blacklist_entry(
    ip: str = Query(..., min_length=1, max_length=253, description="要查询的 IP 或域名"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """在安博通阻断器黑名单中查询单个目标是否封禁（黑名单页查询 + 手动封禁弹窗预检）。

    调用设备「查询指定黑名单」动作精确查询单个条目：条目不存在时设备返回
    HTTP 404，已在设备侧归一为业务结果（found=False，note 说明），不视为
    查询失败；其余异常（超时/网络/5xx）按 502 报错，与「未封禁」区分。

    目标接受单 IP 或域名（安博通 blist 同时存 IP 与域名条目，手动封禁支持
    封禁域名，预检必须同口径，否则域名会被误判成查询失败而漏掉「已被封禁」
    提示）；域名统一小写后再查，避免大小写差异漏判。CIDR / 范围是多条目语义，
    单条精确查询无法命中，按 400 拒绝。
    """
    target = ip.strip()
    if not _device_queryable_target(target):
        raise HTTPException(status_code=400, detail="查询目标需为合法的 IP 或域名")
    try:
        ipaddress.ip_address(target)
    except ValueError:
        from app.core.ip_validation import validate_domain_token

        target = validate_domain_token(target)

    from app.devices.anbotong import query_blacklist_on_anbotong

    result = query_blacklist_on_anbotong(db, target, source="workbench", user_id=user.id)
    if not result["success"]:
        raise HTTPException(status_code=502, detail=result.get("error") or "安博通阻断器黑名单查询失败")
    return {
        "device": result.get("device"),
        "ip": target,
        "found": bool(result.get("found")),
        "entry": result.get("entry"),
        "note": result.get("note"),
        "fetched_at": beijing_now().isoformat(),
    }


class AnbotongUnbanBody(BaseModel):
    reason: str = Field(
        "工作台-安博通黑名单手动解封", max_length=500,
        description="解封原因（可选，写入审计与封禁记录）",
    )


@router.post("/anbotong/blacklist/unban", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def unban_anbotong_blacklist_ip(
    body: AnbotongUnbanBody, request: Request,
    ip: str = Query(..., min_length=1, max_length=253, description="要解封的 IP 或域名"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """从安博通阻断器黑名单移除单个目标（工作台「安博通黑名单」行内解封）。

    目标支持单 IP / 域名（设备黑名单可能含域名条目），域名按小写精确匹配。
    以设备侧结果为准：HTTP 成功即解封完成；设备返回 404（条目本就不在黑名单中）
    按幂等成功处理，支持重复解封。设备调用失败返回 502 且不改动任何平台数据；
    成功后同步把该目标生效中的封禁记录置为已解封，避免设备与台账状态不一致。
    """
    target = ip.strip()
    if not _device_queryable_target(target):
        raise HTTPException(status_code=400, detail="解封目标需为合法的 IP 或域名")
    try:
        ipaddress.ip_address(target)
    except ValueError:
        from app.core.ip_validation import validate_domain_token

        target = validate_domain_token(target)

    from app.devices.anbotong import unblock_ip_on_anbotong

    client_ip = request.client.host if request.client else ""
    result = unblock_ip_on_anbotong(
        db, target, source="workbench", user_id=user.id, source_ip=client_ip,
    )
    # 404 = 设备黑名单中已无该条目（重复解封/已被手动删除），业务目标已达成
    already_absent = (not result.get("success")) and result.get("status_code") == 404
    if not result.get("success") and not already_absent:
        device_name = (result.get("device") or {}).get("name") or "安博通阻断器"
        raise HTTPException(
            status_code=502,
            detail=f"设备「{device_name}」解封失败：{result.get('error') or '未知错误'}",
        )

    now = beijing_now()
    reason = (body.reason or "").strip() or "工作台-安博通黑名单手动解封"
    records = db.query(BanRecord).filter(
        BanRecord.ip == target, BanRecord.status == "active",
    ).all()
    for record in records:
        record.status = "unbanned"
        record.unban_reason = reason
        record.unban_operator = user.username
        record.unban_time = now
    legacy = db.query(BannedIP).filter(BannedIP.ip == target).first()
    if legacy is not None:
        legacy.status = "unbanned"
    db.commit()

    write_audit(
        db, action="unban", resource_type="anbotong_blacklist", resource_id=target,
        detail={
            "ip": target, "reason": reason, "manual": True,
            "already_absent": already_absent,
            "device": (result.get("device") or {}).get("name", ""),
            "status_code": result.get("status_code"),
            "synced_records": len(records),
        },
        operator=user.username, ip_address=client_ip, user_id=user.id,
    )
    return {
        "ok": True,
        "ip": target,
        "already_absent": already_absent,
        "synced_records": len(records),
        "note": "设备返回 404：黑名单中已无该 IP，按已解封处理" if already_absent else None,
        "unban_time": now,
    }


@router.get("/asset-match", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def query_asset_match(
    ips: str = Query(..., min_length=1, max_length=512, description="要匹配资产的 IP 列表（逗号分隔，最多 20 个）"),
    db: Session = Depends(get_db),
) -> dict:
    """手动封禁弹窗的资产匹配预检：双数据源并行查询（资产发现全量 + 资产清单）。

    匹配逻辑复用工单安全上下文的 ``_match_asset``（经 ``_asset_match_for_ip``
    转为前端展示结构）：两来源都查、资产发现优先、结果按来源去重，
    与工单详情「安全上下文 → 资产匹配」完全同口径。仅接受单 IP（与
    安全上下文按 IP 精确匹配一致）；CIDR / 范围 / 域名不做资产预检。
    单个 IP 匹配失败不影响其余 IP（该条目带 error 返回）。
    """
    tokens = [t.strip() for t in ips.split(",") if t.strip()]
    if not tokens:
        raise HTTPException(status_code=400, detail="IP 列表不能为空")
    if len(tokens) > 20:
        raise HTTPException(status_code=400, detail="IP 数量超过上限（20 个）")
    for t in tokens:
        try:
            ipaddress.ip_address(t)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"'{t}' 不是合法的 IP 地址")

    # 输入去重：同一 IP 只匹配一次，结果顺序按输入首次出现顺序
    seen: set[str] = set()
    uniq: list[str] = []
    for t in tokens:
        if t not in seen:
            seen.add(t)
            uniq.append(t)

    items = [_asset_match_for_ip(db, t) | {"ip": t} for t in uniq]
    return {
        "items": items,
        "matched": sum(1 for i in items if i.get("matched")),
        "total": len(items),
        "fetched_at": beijing_now().isoformat(),
    }


# ======================================================================
# 封禁工作台（已封禁 IP 模块，数据源 ban_records）
# ======================================================================
_RECORD_STATUS_LABELS = {
    "active": "生效中", "pending_sync": "待同步", "syncing": "同步中",
    "pending_approval": "待审批",
    "expired": "已解封", "unbanned": "已解封", "cancelled": "已取消",
}
# 导入后仅入库、等待人工确认同步安博通的状态
_PENDING_SYNC_STATUS = "pending_sync"


def _record_risk_level(db: Session, instance_id: Optional[int]) -> str:
    """从智能体调用日志提取研判风险等级（列表徽章展示用）。"""
    if not instance_id:
        return ""
    log = (
        db.query(AgentInvocationLog)
        .filter(AgentInvocationLog.workflow_instance_id == instance_id, AgentInvocationLog.status == "success")
        .order_by(AgentInvocationLog.id.desc())
        .first()
    )
    if log is None or not log.response_body:
        return ""
    try:
        return str(json.loads(log.response_body).get("risk_level") or "")
    except (ValueError, TypeError):
        return ""


def _record_item(db: Session, r: BanRecord) -> dict:
    remaining_ms = None
    if r.status == "active" and r.expire_time and not r.is_permanent:
        remaining_ms = int((r.expire_time - beijing_now()).total_seconds() * 1000)
    alert_count = db.query(AlertEvent).filter(AlertEvent.src_ip.ilike(f'%"{r.ip}"%')).count()
    return {
        "id": r.id,
        "ip": r.ip,
        "risk_level": _record_risk_level(db, r.source_instance_id),
        "status": r.status,
        "status_label": _RECORD_STATUS_LABELS.get(r.status, r.status),
        "ban_level": r.ban_level,
        "is_permanent": r.is_permanent,
        "ban_duration": r.ban_duration,
        "reason": r.reason or "",
        "region": r.region or "",
        "record_id": r.record_id or "",
        "ban_source": r.ban_source or "auto",
        "ban_source_label": _BAN_SOURCE_LABELS.get(r.ban_source or "auto", r.ban_source or "auto"),
        "source_instance_id": r.source_instance_id,
        # 工单同步来源信息（ban_source=ticket 时有值）
        "ticket_id": r.ticket_id,
        "ticket_no": r.ticket_no,
        "ban_device": r.ban_device,
        "expire_time": r.expire_time,
        "remaining_ms": remaining_ms,
        "alert_count": alert_count,
        "unban_reason": r.unban_reason,
        "unban_operator": r.unban_operator,
        "unban_time": r.unban_time,
        "created_at": r.created_at,
    }


# ----------------------------------------------------------------------
# 同步安博通封禁：设备定位 + 资产匹配（与工单安全上下文同一套匹配逻辑）
# ----------------------------------------------------------------------
# 设备动作定位 / 下发统一走 app.devices.ban_target，解封与到期自动解封复用同一套逻辑。

# 资产匹配结果里给前端展示的常用字段（避免把发现侧整条原始记录塞进响应）
_ASSET_BRIEF_KEYS = (
    "resource_type", "resource_label", "instance_name", "inst_name", "name",
    "hostname", "cmdb_id", "department", "owner", "status", "criticality",
    "ip", "identifier", "asset_type", "os", "company", "using_unit", "using_dept",
)


def _brief_value(value) -> str:
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, default=str)[:200]
    return str(value)[:200]


def _asset_match_for_ip(db: Session, ip: str) -> dict:
    """单 IP 资产匹配（复用工单安全上下文的 ``_match_asset``），返回前端展示结构。"""
    from app.core.ticket_enrichment import _match_asset

    try:
        matched = _match_asset(db, ip)
    except Exception as exc:  # noqa: BLE001
        logger.warning("封禁同步资产匹配失败, ip=%s: %s", ip, exc)
        return {"matched": False, "error": f"资产匹配失败: {exc}", "assets": []}
    if not matched.get("matched"):
        return {"matched": False, "assets": []}

    assets: list[dict] = []
    discovery = matched.get("discovery") or {}
    for hit in (discovery.get("matches") or [])[:5]:
        if not isinstance(hit, dict):
            continue
        details = {}
        for key in _ASSET_BRIEF_KEYS:
            if hit.get(key) not in (None, "", [], {}):
                details[key] = _brief_value(hit[key])
        assets.append({
            "source": "asset_discovery",
            "source_label": hit.get("source_label") or discovery.get("source_label") or "资产发现",
            "asset_name": (
                hit.get("instance_name") or hit.get("inst_name") or hit.get("name")
                or hit.get("cmdb_id") or ""
            ),
            "asset_ip": hit.get("ip") or hit.get("asset_ip") or ip,
            "details": details,
        })
    inventory = matched.get("inventory") or {}
    if inventory:
        fields = inventory.get("fields") or {}
        details = {}
        for key in _ASSET_BRIEF_KEYS:
            if fields.get(key) not in (None, "", [], {}):
                details[key] = _brief_value(fields[key])
        tags = fields.get("tags") or []
        if tags:
            details["tags"] = "、".join(
                str(t.get("name")) for t in tags if isinstance(t, dict) and t.get("name")
            )[:200]
        assets.append({
            "source": "asset_inventory",
            "source_label": inventory.get("source_label") or "资产清单",
            "asset_name": inventory.get("asset_name") or fields.get("name") or "",
            "asset_ip": inventory.get("asset_ip") or ip,
            "details": details,
        })

    return {
        "matched": True,
        "source": matched.get("source") or "",
        "source_label": matched.get("source_label") or "",
        "asset_name": matched.get("asset_name") or "",
        "assets": assets,
    }


class BannedIpSyncBody(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=200, description="待同步的封禁记录 ID")
    device_id: Optional[int] = Field(
        None,
        description="指定执行设备（仅用于未记录「封堵设备」的记录；不覆盖记录级配置；不传则自动定位安博通阻断器）",
    )


@router.post("/banned-ips/sync-preview", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def preview_banned_ip_sync(body: BannedIpSyncBody, db: Session = Depends(get_db)) -> dict:
    """同步安博通封禁前的预览：资产匹配结果 + 是否可同步（不产生任何下发）。"""
    device, action, device_error = ban_target.resolve_default_device(db, body.device_id)
    records = db.query(BanRecord).filter(BanRecord.id.in_(body.ids)).all()
    by_id = {r.id: r for r in records}
    record_ips = [r.ip for r in records]
    # 批量取「已有生效中记录」的 IP，避免逐条查询造成 N+1
    active_ips = {
        ip for (ip,) in db.query(BanRecord.ip).filter(
            BanRecord.ip.in_(record_ips), BanRecord.status == "active",
        ).all()
    } if record_ips else set()
    asset_cache: dict[str, dict] = {}
    device_cache: dict[str, tuple] = {}
    items = []
    for rid in body.ids:
        r = by_id.get(rid)
        if r is None:
            items.append({
                "id": rid, "ip": "", "status": "", "status_label": "",
                "syncable": False, "message": "封禁记录不存在",
                "asset_match": {"matched": False, "assets": []},
                "device_name": "",
            })
            continue
        if r.ip not in asset_cache:
            asset_cache[r.ip] = _asset_match_for_ip(db, r.ip)
        # device_id 只决定「未记录封堵设备」的记录走哪台设备，不覆盖记录级配置
        target_device, _target_action, device_err = ban_target.resolve_device_for_record(
            db, r, device, action, device_error, device_cache,
        )
        message = ""
        syncable = True
        if r.status != _PENDING_SYNC_STATUS:
            syncable = False
            message = f"当前状态为「{_RECORD_STATUS_LABELS.get(r.status, r.status)}」，仅待同步记录可同步"
        elif r.ip in active_ips:
            syncable = False
            message = "该 IP 已有生效中的封禁记录，无需重复同步"
        elif device_err:
            syncable = False
            message = device_err
        items.append({
            "id": r.id,
            "ip": r.ip,
            "status": r.status,
            "status_label": _RECORD_STATUS_LABELS.get(r.status, r.status),
            "ban_level": r.ban_level,
            "ban_level_label": _LEVEL_LABELS.get(r.ban_level, r.ban_level),
            "is_permanent": r.is_permanent,
            "ban_duration": r.ban_duration,
            "reason": r.reason or "",
            "region": r.region or "",
            "ban_device": r.ban_device or "",
            "device_name": target_device.name if target_device else (r.ban_device or ""),
            "asset_match": asset_cache[r.ip],
            "syncable": syncable,
            "message": message,
        })
    matched_n = sum(1 for i in items if i.get("asset_match", {}).get("matched"))
    return {
        "ok": True,
        "device": {"id": device.id, "name": device.name} if device else None,
        "device_error": device_error or "",
        "total": len(items),
        "matched": matched_n,
        "unmatched": len(items) - matched_n,
        "syncable": sum(1 for i in items if i["syncable"]),
        "blocked": sum(1 for i in items if not i["syncable"]),
        "items": items,
    }


@router.post("/banned-ips/sync", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def sync_banned_ips_to_device(
    body: BannedIpSyncBody, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """确认同步：仅对待同步记录下发安博通封禁，成功后才置为生效中。"""
    device, action, device_error = ban_target.resolve_default_device(db, body.device_id)
    device_cache: dict[str, tuple] = {}
    client_ip = request.client.host if request.client else ""
    success_n = failed_n = skipped_n = 0
    items: list[dict] = []
    for rid in body.ids:
        r = db.query(BanRecord).filter(BanRecord.id == rid).first()
        if r is None:
            failed_n += 1
            items.append({"id": rid, "ip": "", "success": False, "message": "封禁记录不存在"})
            continue
        if r.status != _PENDING_SYNC_STATUS:
            skipped_n += 1
            items.append({
                "id": rid, "ip": r.ip, "success": False, "skipped": True,
                "message": f"当前状态为「{_RECORD_STATUS_LABELS.get(r.status, r.status)}」，仅待同步记录可同步",
            })
            continue
        dup = (
            db.query(BanRecord)
            .filter(BanRecord.ip == r.ip, BanRecord.status == "active", BanRecord.id != r.id)
            .first()
        )
        if dup is not None:
            skipped_n += 1
            items.append({
                "id": rid, "ip": r.ip, "success": False, "skipped": True,
                "message": "该 IP 已有生效中的封禁记录，无需重复同步",
            })
            continue
        # device_id 只决定「未记录封堵设备」的记录走哪台设备，不覆盖记录级配置
        target_device, target_action, device_err = ban_target.resolve_device_for_record(
            db, r, device, action, device_error, device_cache,
        )
        if device_err or target_device is None or target_action is None:
            failed_n += 1
            items.append({
                "id": rid, "ip": r.ip, "success": False,
                "message": device_err or "未找到可用的安博通封禁设备",
            })
            continue

        # 条件更新占位「同步中」：并发重复提交时只有一个请求能真正下发设备
        claimed = (
            db.query(BanRecord)
            .filter(BanRecord.id == rid, BanRecord.status == _PENDING_SYNC_STATUS)
            .update({"status": "syncing"}, synchronize_session=False)
        )
        db.commit()
        if not claimed:
            skipped_n += 1
            items.append({
                "id": rid, "ip": r.ip, "success": False, "skipped": True,
                "message": "该记录正在被其他请求同步，请稍后刷新查看结果",
            })
            continue

        duration_seconds = 0 if r.is_permanent else int(r.ban_duration or 3600)
        result = ban_target.run_block(
            db, target_device, target_action,
            ip=r.ip, duration_seconds=duration_seconds,
            reason=r.reason or "导入封禁", source="ban_workbench",
            user_id=user.id, source_ip=client_ip,
        )
        ok, err = ban_target.check_block_result(result)
        if not ok:
            # 下发失败：退回待同步，避免展示为生效中
            r.status = _PENDING_SYNC_STATUS
            db.commit()
            failed_n += 1
            items.append({
                "id": rid, "ip": r.ip, "success": False,
                "message": err, "status_code": result.get("status_code"),
            })
            continue

        # 下发成功后才更新平台记录，避免设备失败却展示为生效中
        now = beijing_now()
        expire_time = None if r.is_permanent else now + timedelta(seconds=duration_seconds)
        r.status = "active"
        r.ban_device = target_device.name
        r.expire_time = expire_time
        r.created_at = now
        body_data = result.get("response_body")
        r.record_id = ban_target.extract_record_id(body_data)
        # 同步 legacy 已封禁 IP 表（其他页面/智能体工具读该表）
        legacy = db.query(BannedIP).filter(BannedIP.ip == r.ip).first()
        if legacy is None:
            legacy = BannedIP(ip=r.ip)
            db.add(legacy)
        legacy.ban_level = r.ban_level
        legacy.ban_duration = int(r.ban_duration or 3600)
        legacy.expired_at = expire_time or (now + timedelta(days=36500))
        legacy.region = r.region or ""
        legacy.reason = r.reason or ""
        legacy.status = "active"
        legacy.source = "import"
        legacy.device_id = target_device.id
        legacy.device_name = target_device.name
        legacy.action_response = ban_target.summarize_response(result)
        db.commit()
        success_n += 1
        items.append({
            "id": rid, "ip": r.ip, "success": True,
            "message": f"已同步至{target_device.name}", "ban_device": target_device.name,
            "device_name": target_device.name,
        })

    # 本次实际涉及的封堵设备（导入记录可逐条指定设备）
    used_devices = sorted({i.get("device_name") for i in items if i.get("device_name")})
    write_audit(
        db, action="sync_ban", resource_type="ban_record", resource_id="",
        detail={
            "ids": body.ids, "success": success_n, "failed": failed_n, "skipped": skipped_n,
            "failed_items": [i for i in items if not i.get("success")][:20],
            "device": device.name if device else "",
            "devices": used_devices,
        },
        operator=user.username, ip_address=client_ip, user_id=user.id,
    )
    logger.info(
        "封禁工作台同步安博通完成: 成功 %d 条, 失败 %d 条, 跳过 %d 条, default_device=%s, devices=%s",
        success_n, failed_n, skipped_n, device.name if device else "-",
        ",".join(used_devices) or "-",
    )
    return {
        "ok": True,
        "total": len(body.ids),
        "success": success_n,
        "failed": failed_n,
        "skipped": skipped_n,
        "device": {"id": device.id, "name": device.name} if device else None,
        "device_error": device_error or "",
        "devices": used_devices,
        "items": items,
    }


@router.get("/banned-ips", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def list_banned_ips(
    status: str = Query("", description="active/pending_sync/syncing/pending_approval/expired/unbanned/cancelled"),
    ip: str = Query("", description="IP 关键词"),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
) -> dict:
    """封禁工作台列表（分页 + 状态/IP 筛选）。"""
    query = db.query(BanRecord)
    if status:
        query = query.filter(BanRecord.status == status)
    if ip:
        query = query.filter(BanRecord.ip.ilike(f"%{ip}%"))
    total = query.count()
    rows = (
        query.order_by(BanRecord.id.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
        .all()
    )
    return {"total": total, "items": [_record_item(db, r) for r in rows], "page": page, "page_size": page_size}


class BannedIpBatchDeleteBody(BaseModel):
    ids: list[int] = Field(..., min_length=1, max_length=200, description="待删除的封禁记录 ID")


@router.post("/banned-ips/batch-delete", dependencies=[Depends(require_permission("ban_workflow", "delete"))])
def batch_delete_banned_ips(
    body: BannedIpBatchDeleteBody, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """批量删除封禁记录（需 ban_workflow:delete）。

    与单条删除逻辑一致：「生效中」且由本平台下发设备的记录先联动设备解封，
    解封失败的记录保留并计入失败（避免设备侧黑名单残留），其余记录删除并记录审计日志。
    逐条独立处理，单条失败不影响其他记录。

    注意：本路由必须注册在 ``/banned-ips/{record_id}`` 之前，
    否则 Starlette 会先匹配到参数路由导致 POST 405。
    """
    client_ip = request.client.host if request.client else ""
    ids = list(dict.fromkeys(body.ids))  # 去重且保持顺序
    success_n = failed_n = 0
    items: list[dict] = []
    for rid in ids:
        record = db.query(BanRecord).filter(BanRecord.id == rid).first()
        if record is None:
            failed_n += 1
            items.append({"id": rid, "ip": "", "success": False, "message": "封禁记录不存在"})
            continue
        device = None
        unban_result: dict = {}
        err_msg = ""
        if record.status == "active" and _record_issued_to_device(record):
            device, action, device_err = ban_target.resolve_unblock_device(db, record.ban_device)
            if device_err or device is None or action is None:
                err_msg = f"{device_err or '未找到可用的解封设备'}，已保留记录（设备侧封禁仍生效）"
            else:
                unban_result = ban_target.run_unblock(
                    db, device, action, ip=record.ip, source="ban_workbench",
                    user_id=user.id, source_ip=client_ip,
                )
                ok, err = ban_target.check_unblock_result(unban_result)
                if not ok:
                    logger.error(
                        "批量删除前解封设备失败 ip=%s device=%s: %s", record.ip, device.name, err,
                    )
                    err_msg = f"设备「{device.name}」解封失败：{err}，已保留记录（设备侧封禁仍生效）"
        if err_msg:
            failed_n += 1
            items.append({
                "id": rid, "ip": record.ip, "success": False, "message": err_msg,
                "status_code": unban_result.get("status_code"),
            })
            continue
        snapshot = {"id": record.id, "ip": record.ip, "status": record.status, "record_id": record.record_id}
        db.delete(record)
        db.commit()
        write_audit(
            db, action="delete", resource_type="ban_record", resource_id=rid,
            detail={"snapshot": snapshot, "device": device.name if device else "",
                    "unblocked": bool(device),
                    "status_code": unban_result.get("status_code"),
                    "batch": True},
            operator=user.username, ip_address=client_ip,
            user_id=user.id,
        )
        success_n += 1
        items.append({"id": rid, "ip": record.ip, "success": True, "message": "已删除"})
    return {
        "ok": True,
        "total": len(ids),
        "success": success_n,
        "failed": failed_n,
        "items": items,
        "message": "批量删除完成" if failed_n == 0
        else f"成功 {success_n} 条，失败 {failed_n} 条（失败记录已保留）",
    }


@router.get("/banned-ips/{record_id}", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def get_banned_ip(record_id: int, db: Session = Depends(get_db)) -> dict:
    """封禁记录详情：封禁方案 + 研判结论 + 决策依据 + 审批记录 + 关联告警列表。"""
    record = db.query(BanRecord).filter(BanRecord.id == record_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="封禁记录不存在")
    item = _record_item(db, record)

    decision = {}
    ticket_item = None
    if record.source_instance_id:
        log = (
            db.query(AgentInvocationLog)
            .filter(AgentInvocationLog.workflow_instance_id == record.source_instance_id,
                    AgentInvocationLog.status == "success")
            .order_by(AgentInvocationLog.id.desc())
            .first()
        )
        if log is not None and log.response_body:
            decision = _jload(log.response_body, {}) or {}
        ticket = (
            db.query(ApprovalTicket)
            .filter(ApprovalTicket.workflow_instance_id == record.source_instance_id)
            .order_by(ApprovalTicket.id.desc())
            .first()
        )
        if ticket is not None:
            ticket_item = _ticket_item(ticket)
    # 工单同步来源（ban_source=ticket）：取该工单安全上下文中此 IP 的智能体研判结论
    if not decision and record.ticket_id:
        tk = db.query(Ticket).filter(Ticket.id == record.ticket_id).first()
        if tk is not None and isinstance(tk.enrichment_data, dict):
            # v2 多 IP：ips 扁平结构（每 IP 一条，roles 记录出现角色）；v1 存量：sources
            for src in (
                tk.enrichment_data.get("ips")
                or tk.enrichment_data.get("sources")
                or []
            ):
                if (
                    isinstance(src, dict)
                    and src.get("ip") == record.ip
                    and isinstance(src.get("agent"), dict)
                    and not src["agent"].get("pending")
                ):
                    action = src["agent"].get("action")
                    # 中文键结构，与详情弹窗「审批记录」等板块的展示风格一致
                    decision = {
                        "风险等级": src["agent"].get("risk_level") or "未知",
                        "建议动作": _TICKET_AGENT_ACTION_LABELS.get(action, action or "未给出"),
                        "监控建议": src["agent"].get("monitoring_advice") or "无",
                        "研判理由": src["agent"].get("reasons") or [],
                        "来源工单": f"{tk.ticket_no} {tk.title}",
                    }
                    break
    item["agent_decision"] = decision
    item["approval_ticket"] = ticket_item

    # 关联告警列表（点击可跳转告警列表按 IP 过滤）
    alerts = (
        db.query(AlertEvent.id, AlertEvent.alert_name, AlertEvent.risk_level_name,
                 AlertEvent.risk_level, AlertEvent.occur_timestamp)
        .filter(AlertEvent.src_ip.ilike(f'%"{record.ip}"%'))
        .order_by(AlertEvent.id.desc())
        .limit(50)
        .all()
    )
    item["related_alerts"] = [{
        "id": a.id, "alert_name": a.alert_name or "", "risk_level": a.risk_level,
        "risk_level_name": a.risk_level_name or "", "occur_timestamp": a.occur_timestamp,
    } for a in alerts]
    return item


def _record_issued_to_device(record: BanRecord) -> bool:
    """记录是否由本平台真实下发到封禁设备。

    仅「导入封禁 / 手动封禁 / 工单同步」且已记录封堵设备名的记录会真正调用设备
    （工单封禁同步自联动安博通下发后，设备下发成功才落生效中记录并记录实际设备名）；
    自动/审批封禁只落平台记录（设备下发由各自链路负责），解封时不能对其调用设备，
    否则会对不存在的条目发无效请求。
    """
    return bool((record.ban_device or "").strip()) and (record.ban_source or "") in ("import", "manual", "ticket")


class UnbanBody(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500, description="解封原因（必填）")


@router.post("/banned-ips/{record_id}/unban", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def unban_ip(
    record_id: int, body: UnbanBody, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """解封：先联动设备解封（已下发记录），成功后再更新平台状态并写审计。

    设备解封失败返回 502 且平台记录保持「生效中」，避免设备仍封禁却显示已解封。
    """
    record = db.query(BanRecord).filter(BanRecord.id == record_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="封禁记录不存在")
    if record.status != "active":
        raise HTTPException(status_code=400, detail="仅生效中的封禁记录可解封")

    client_ip = request.client.host if request.client else ""
    device = None
    result: dict = {}
    if _record_issued_to_device(record):
        device, action, device_err = ban_target.resolve_unblock_device(db, record.ban_device)
        if device_err or device is None or action is None:
            raise HTTPException(
                status_code=502,
                detail=f"{device_err or '未找到可用的解封设备'}，平台记录保持生效中",
            )
        result = ban_target.run_unblock(
            db, device, action, ip=record.ip, source="ban_workbench",
            user_id=user.id, source_ip=client_ip,
        )
        ok, err = ban_target.check_unblock_result(result)
        if not ok:
            logger.error(
                "解封设备下发失败 ip=%s device=%s: %s", record.ip, device.name, err,
            )
            raise HTTPException(
                status_code=502,
                detail=f"设备「{device.name}」解封失败：{err}，平台记录保持生效中",
            )

    now = beijing_now()
    record.status = "unbanned"
    record.unban_reason = body.reason.strip()
    record.unban_operator = user.username
    record.unban_time = now
    # 同步 legacy 工作台
    legacy = db.query(BannedIP).filter(BannedIP.ip == record.ip).first()
    if legacy is not None:
        legacy.status = "unbanned"
    db.commit()

    write_audit(
        db, action="unban", resource_type="ban_record", resource_id=record.id,
        detail={"ip": record.ip, "reason": body.reason.strip(), "manual": True,
                "instance_id": record.source_instance_id,
                "device": device.name if device else "",
                "status_code": result.get("status_code")},
        operator=user.username, ip_address=client_ip,
        user_id=user.id,
    )
    return {"ok": True, "status": "unbanned", "unban_time": now}


# ----------------------------------------------------------------------
# 手动封禁（admin/有编辑权限即可发起；来源标记 manual）
# ----------------------------------------------------------------------
class ManualBanBody(BaseModel):
    ip: str = Field(
        ..., min_length=1, max_length=2048,
        description="封禁目标：单 IP / CIDR / 范围 / 域名 / 多值（IPv4/IPv6）；"
                    "多值拆分逐个下发并逐条落记录，单次最多 20 个目标",
    )
    ban_level: str = Field("medium", description="封禁等级 low/medium/high/critical")
    ban_duration: int = Field(3600, gt=0, description="封禁时长（秒），is_permanent 时忽略")
    is_permanent: bool = Field(False, description="是否永久封禁")
    reason: str = Field(..., min_length=2, max_length=500, description="封禁原因（必填）")
    region: str = Field("", max_length=64, description="归属地区")


# 单次手动封禁的目标数上限：安博通黑名单接口一次只接受一个 blist 条目，
# 多值必须拆成单目标逐个下发（串行设备调用），上限防止一次请求拖垮接口
# （与批量状态查询接口的 20 个上限保持一致）
_MANUAL_BAN_MAX_TARGETS = 20


def _rollback_dispatched_bans(
    db: Session, device, action, targets: list, *,
    user_id, source_ip: str,
) -> tuple[int, list]:
    """多目标下发中途失败时，回滚本次已成功下发的设备条目（尽力而为）。

    返回 ``(回滚成功数, 回滚失败的目标列表)``；回滚失败的目标设备侧仍生效，
    由调用方提示用户到设备黑名单手动处理。
    """
    rolled, failed = 0, []
    for target in targets:
        try:
            unban = ban_target.run_unblock(
                db, device, action, ip=target, source="ban_workbench",
                user_id=user_id, source_ip=source_ip,
            )
            ok, _ = ban_target.check_unblock_result(unban)
        except Exception:  # noqa: BLE001
            ok = False
        if ok:
            rolled += 1
        else:
            failed.append(target)
    return rolled, failed


def _device_queryable_target(target: str) -> bool:
    """目标能否用「查询指定黑名单」精确查询（单 IP / 域名）。

    CIDR / 范围在设备侧是多条目语义，单条精确查询无法命中，预检同样跳过，
    这里保持同口径，避免把「查不到」误判为「未封禁」而漏掉设备侧已有网段。
    """
    try:
        ipaddress.ip_address(target)
        return True
    except ValueError:
        pass
    from app.core.ip_validation import validate_domain_token

    try:
        validate_domain_token(target)
        return True
    except ValueError:
        return False


def _skip_device_banned_targets(db: Session, targets: list) -> tuple[list, list]:
    """逐目标查询设备黑名单，跳过设备侧已封禁的目标。

    平台记录只反映本平台下发过的封禁；直接在安博通控制台封禁、或平台记录已
    解封/清理但设备条目仍在的场景，``ban_records`` 查不到，重复下发会覆盖设备
    条目并再落一条平台记录。这里复用弹窗预检的查询动作补齐该缺口。

    查询失败（网络/超时/未配置查询动作）不阻断封禁流程：目标按未封禁处理，
    只记告警日志，行为与改造前一致。

    Returns:
        ``(未在设备黑名单中的目标, 设备侧已封禁的跳过明细)``，
        跳过明细格式同平台记录跳过：``[{"ip", "ban_source", "source_label"}]``。
    """
    from concurrent.futures import ThreadPoolExecutor

    from app.devices.anbotong import (
        QUERY_TIMEOUT_CAP_SECONDS, find_anbotong_action, query_blacklist_entry,
    )

    queryable = [t for t in targets if _device_queryable_target(t)]
    if not queryable:
        return targets, []

    device, action, err = find_anbotong_action(db, "query")
    if err or device is None or action is None:
        logger.warning(
            "手动封禁跳过设备黑名单预检（%s），仅按平台封禁记录判断",
            err or "查询动作不可用",
        )
        return targets, []

    timeout = min(device.timeout or 30, QUERY_TIMEOUT_CAP_SECONDS)
    found: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=min(len(queryable), 8)) as pool:
        futures = {
            t: pool.submit(query_blacklist_entry, device, action, t, timeout=timeout)
            for t in queryable
        }
        for target, fut in futures.items():
            try:
                result = fut.result()
            except Exception as exc:  # noqa: BLE001
                logger.warning("手动封禁设备黑名单预检失败 ip=%s: %s", target, exc)
                continue
            if not result.get("success"):
                logger.warning(
                    "手动封禁设备黑名单预检失败 ip=%s: %s",
                    target, result.get("error") or result.get("note"),
                )
                continue
            if result.get("found"):
                found[target] = result.get("entry") or {}

    if not found:
        return targets, []
    logger.info(
        "手动封禁目标已在设备黑名单中，自动跳过（不重复下发）targets=%s",
        list(found),
    )
    skipped = [
        {"ip": t, "ban_source": "device", "source_label": "设备黑名单"} for t in targets if t in found
    ]
    return [t for t in targets if t not in found], skipped


def _issue_manual_ban(
    db: Session, *, user: User, ip: str, ban_level: str, ban_duration: int,
    is_permanent: bool, reason: str, region: str, client_ip: str,
) -> tuple[list, list]:
    """下发一条手动封禁（校验 → 过滤已封禁 → 下发封禁设备 → 写 ban_records → 同步 legacy 工作台）。

    与导入同步链路共用 ``app.devices.ban_target``：设备下发失败抛 502，
    **不会**落「生效中」平台记录，避免平台与设备状态不一致。

    多值目标（逗号分隔的单 IP / CIDR / 范围 / 域名）拆成单目标逐个下发：设备接口
    一次只接受一个 blist 条目，整串下发会被设备静默丢弃（返回空条目）；
    平台侧也按目标逐条落 BanRecord，否则整串表达式无法逐 IP 解封 / 到期。

    已封禁跳过：平台处于「生效中」的目标、以及设备黑名单中已存在的目标
    **自动跳过**（不下发、不落库），仅对未封禁目标执行；全部目标均已封禁时
    不下发、不落库，直接返回跳过明细。

    原子性：先全部校验再下发，任一目标下发失败立即停止并回滚本次已成功的
    设备条目，保证「全成功才落库」。

    Returns:
        ``(records, skipped)``：新建的封禁记录列表与被跳过的目标明细
        （``[{"ip", "ban_source", "source_label"}]``）。
    """
    from app.core.ip_validation import split_ip_expression, validate_ban_entry

    # 封禁目标校验：支持单 IP / CIDR / 范围 / 域名 / 多值
    # （安博通 blist 条目同时接受 IP 与域名；拒绝通配与任意文本）
    try:
        ip = validate_ban_entry(ip, "封禁目标")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if not ip:
        # 纯空白输入经归一化后为空串：不能带着空目标去下发封禁
        raise HTTPException(status_code=422, detail="封禁目标不能为空")
    if ban_level not in _LEVEL_LABELS:
        raise HTTPException(status_code=400, detail="封禁等级必须为 low/medium/high/critical")
    if not is_permanent and ban_duration <= 0:
        raise HTTPException(status_code=400, detail="封禁时长必须大于 0")
    if not reason:
        raise HTTPException(status_code=400, detail="封禁原因不能为空")

    # 多值表达式拆成单目标（去重，保留顺序）：设备侧逐个下发，平台侧逐条落库
    targets = list(dict.fromkeys(split_ip_expression(ip)))
    if len(targets) > _MANUAL_BAN_MAX_TARGETS:
        raise HTTPException(
            status_code=422,
            detail=(f"单次最多封禁 {_MANUAL_BAN_MAX_TARGETS} 个目标，当前 {len(targets)} 个，请分批提交"),
        )

    # 已封禁的目标自动跳过（不下发、不落库），仅对未封禁目标执行封禁；
    # 全部目标均已封禁时不调设备直接返回，避免无意义的下发请求
    dup_map = {
        r.ip: r
        for r in db.query(BanRecord)
        .filter(BanRecord.ip.in_(targets), BanRecord.status == "active")
        .all()
    }
    skipped = [
        {
            "ip": t,
            "ban_source": dup_map[t].ban_source,
            "source_label": _BAN_SOURCE_LABELS.get(dup_map[t].ban_source, dup_map[t].ban_source),
        }
        for t in targets if t in dup_map
    ]
    to_ban = [t for t in targets if t not in dup_map]
    if not to_ban:
        logger.info(
            "手动封禁全部目标均已封禁，自动跳过（未执行下发）ip=%s targets=%s user=%s",
            ip, [s["ip"] for s in skipped], user.username,
        )
        return [], skipped

    device, action, device_err = ban_target.resolve_default_device(db)
    if device_err or device is None or action is None:
        raise HTTPException(
            status_code=502,
            detail=device_err or "未找到可用的安博通封禁设备，请先在设备管理中接入并启用",
        )
    # 平台无生效记录但设备侧已封禁（直接在安博通控制台封禁、或记录已解封/清理
    # 而设备条目仍在）：与弹窗预检口径一致，同样跳过，避免重复下发覆盖设备条目
    to_ban, device_skipped = _skip_device_banned_targets(db, to_ban)
    skipped.extend(device_skipped)
    if not to_ban:
        logger.info(
            "手动封禁目标均已在设备黑名单中，自动跳过（未执行下发）ip=%s targets=%s user=%s",
            ip, [s["ip"] for s in skipped], user.username,
        )
        return [], skipped

    duration_seconds = 0 if is_permanent else ban_duration
    # 逐目标下发；中途失败立即停止并回滚已下发的目标（全成功才落库）
    dispatched: list = []
    for target in to_ban:
        result = ban_target.run_block(
            db, device, action, ip=target, duration_seconds=duration_seconds,
            reason=reason, source="ban_workbench", user_id=user.id, source_ip=client_ip,
        )
        ok, err = ban_target.check_block_result(result)
        if not ok:
            logger.error(
                "手动封禁下发失败 ip=%s target=%s device=%s: %s",
                ip, target, device.name, err,
            )
            rolled, rollback_failed = _rollback_dispatched_bans(
                db, device, action, [t for t, _ in dispatched],
                user_id=user.id, source_ip=client_ip,
            )
            detail = (
                f"封禁设备「{device.name}」下发失败：目标 {target}：{err}；"
                f"已回滚 {rolled} 个本次已下发的目标，未创建封禁记录"
            )
            if rollback_failed:
                detail += (
                    "；回滚失败、设备侧仍生效（请到安博通黑名单手动处理）："
                    f"{'、'.join(rollback_failed)}"
                )
            raise HTTPException(status_code=502, detail=detail)
        dispatched.append((target, result))

    now = beijing_now()
    expire_time = None if is_permanent else now + timedelta(seconds=duration_seconds)
    records: list = []
    for target, result in dispatched:
        record_id = ban_target.extract_record_id(result.get("response_body"))
        record = BanRecord(
            ip=target,
            ban_level=ban_level,
            ban_duration=ban_duration,
            is_permanent=is_permanent,
            expire_time=expire_time,
            reason=reason,
            region=region,
            ban_source="manual",
            ban_device=device.name,
            record_id=record_id,
            status="active",
        )
        db.add(record)
        # 同步 legacy 已封禁 IP 表
        legacy = db.query(BannedIP).filter(BannedIP.ip == target).first()
        if legacy is None:
            legacy = BannedIP(ip=target)
            db.add(legacy)
        legacy.ban_level = ban_level
        legacy.ban_duration = ban_duration
        legacy.expired_at = expire_time or (now + timedelta(days=36500))
        legacy.region = region
        legacy.reason = reason
        legacy.status = "active"
        legacy.source = "manual"
        legacy.device_id = device.id
        legacy.device_name = device.name
        legacy.action_response = ban_target.summarize_response(result)
        records.append(record)
    db.commit()

    for record, (_, result) in zip(records, dispatched):
        write_audit(
            db, action="manual_ban", resource_type="ban_record", resource_id=record.id,
            detail={
                "ip": record.ip, "ban_plan": {
                    "ban_level": ban_level, "ban_duration": ban_duration,
                    "is_permanent": is_permanent, "reason": reason, "region": region,
                },
                "record_id": record.record_id, "device": device.name,
                "status_code": result.get("status_code"),
                "skipped_targets": [s["ip"] for s in skipped],
            },
            operator=user.username, ip_address=client_ip, user_id=user.id,
        )
    return records, skipped


@router.post("/banned-ips", status_code=201, dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def create_manual_ban(
    body: ManualBanBody, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> dict:
    """手动发起封禁：调用封禁工具下发 → 写 ban_records（ban_source=manual）→ 同步 legacy 工作台。

    多值目标拆分逐个下发、逐条落记录；「生效中」的目标自动跳过（不下发、不落库），
    仅对未封禁目标执行。响应包含：

    - ``created_count`` / ``targets``：实际新建的记录数与目标列表；
    - ``skipped_count`` / ``skipped_targets``：自动跳过的已封禁目标数及明细
      （含原封禁来源标签）；全部目标均已封禁时 ``created_count=0``。
    """
    client_ip = request.client.host if request.client else ""
    records, skipped = _issue_manual_ban(
        db,
        user=user,
        ip=body.ip,
        ban_level=body.ban_level,
        ban_duration=body.ban_duration,
        is_permanent=body.is_permanent,
        reason=body.reason.strip(),
        region=body.region.strip(),
        client_ip=client_ip,
    )
    if not records:
        # 全部目标均已封禁：未执行任何下发，仍记审计以便追溯「谁在何时尝试封了什么」
        write_audit(
            db, action="manual_ban", resource_type="ban_record", resource_id=None,
            detail={
                "skipped_only": True, "ip": body.ip,
                "skipped_targets": [s["ip"] for s in skipped],
                "reason": body.reason.strip(),
            },
            operator=user.username, ip_address=client_ip, user_id=user.id,
        )
        return {
            "created_count": 0,
            "targets": [],
            "skipped_count": len(skipped),
            "skipped_targets": skipped,
        }
    item = _record_item(db, records[0])
    item["created_count"] = len(records)
    item["targets"] = [r.ip for r in records]
    item["skipped_count"] = len(skipped)
    item["skipped_targets"] = skipped
    return item


# ----------------------------------------------------------------------
# CSV 导入导出（封禁时长按天；导出含只读列，导入只取 IP/等级/时长/永久/原因/地区/封堵设备）
# ----------------------------------------------------------------------
# 导入解析的列（与模板列一致；导出额外的封禁方式/状态/时间列仅展示用）
_WB_CSV_COLUMNS = ["IP地址", "封禁等级", "封禁时长(天)", "是否永久", "封禁原因", "归属地区", "封堵设备"]


def _wb_csv_response(content: str, filename: str) -> StreamingResponse:
    """构造 UTF-8 BOM CSV 下载响应（Excel 可直接打开）。"""
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# 导出可选字段：key → (表头, 取值函数)
_WB_EXPORT_FIELDS = {
    "ip": ("IP地址", lambda r: r.ip),
    "ban_level": ("封禁等级", lambda r: _LEVEL_LABELS.get(r.ban_level, r.ban_level)),
    "ban_duration_days": ("封禁时长(天)", lambda r: _duration_days_label(r.ban_duration, r.is_permanent)),
    "is_permanent": ("是否永久", lambda r: "是" if r.is_permanent else "否"),
    "reason": ("封禁原因", lambda r: r.reason or ""),
    "region": ("归属地区", lambda r: r.region or ""),
    "ban_source": ("封禁方式", lambda r: _BAN_SOURCE_LABELS.get(r.ban_source, r.ban_source or "")),
    "status": ("当前状态", lambda r: _RECORD_STATUS_LABELS.get(r.status, r.status)),
    "created_at": ("开始封禁时间", lambda r: r.created_at.strftime("%Y-%m-%d %H:%M:%S") if r.created_at else ""),
    "expire_time": ("解封时间", lambda r: r.expire_time.strftime("%Y-%m-%d %H:%M:%S") if r.expire_time else ""),
    "ban_device": ("封堵设备", lambda r: r.ban_device or ""),
    "record_id": ("封禁工具记录", lambda r: r.record_id or ""),
}
_WB_EXPORT_DEFAULT_FIELDS = list(_WB_EXPORT_FIELDS.keys())


@router.get("/banned-ips/export/csv", dependencies=[Depends(require_permission("ban_workflow", "export"))])
def export_banned_ips_csv(
    ids: str = Query("", description="逗号分隔的封禁记录 ID（传了就只导出这些记录）"),
    status: str = Query("", description="按状态筛选导出"),
    ip: str = Query("", description="按 IP 关键词筛选导出"),
    fields: str = Query("", description="逗号分隔的导出字段 key；不传导出全部字段"),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    request: Request = None,
) -> StreamingResponse:
    """导出封禁记录为 CSV（需 ban_workflow:export），支持全部/当前筛选/选中与字段选择。

    前 6 列仍与导入模板一致：IP地址 / 封禁等级 / 封禁时长(天) / 是否永久 /
    封禁原因 / 归属地区；修改后可直接重新导入（时长支持小数天）。
    """
    from app.core.audit import get_client_ip, log_audit

    query = db.query(BanRecord)
    id_values: list[int] = []
    if ids.strip():
        for part in ids.split(","):
            part = part.strip()
            if not part:
                continue
            try:
                id_values.append(int(part))
            except ValueError:
                raise HTTPException(status_code=400, detail=f"记录 ID 不合法: {part}")
        query = query.filter(BanRecord.id.in_(id_values))
    else:
        if status:
            query = query.filter(BanRecord.status == status)
        if ip:
            query = query.filter(BanRecord.ip.ilike(f"%{ip}%"))
    records = query.order_by(BanRecord.id.desc()).all()

    selected_fields = [f.strip() for f in fields.split(",") if f.strip()]
    unknown = [f for f in selected_fields if f not in _WB_EXPORT_FIELDS]
    if unknown:
        raise HTTPException(status_code=400, detail=f"不支持的导出字段: {', '.join(unknown)}")
    if not selected_fields:
        selected_fields = _WB_EXPORT_DEFAULT_FIELDS

    buf = io.StringIO()
    buf.write("\ufeff")  # BOM，确保 Excel 正确识别 UTF-8
    writer = csv.writer(buf)
    writer.writerow([_WB_EXPORT_FIELDS[f][0] for f in selected_fields])
    for r in records:
        writer.writerow([_WB_EXPORT_FIELDS[f][1](r) for f in selected_fields])
    content = buf.getvalue()
    buf.close()

    # 审计：导出操作（GET 请求不被中间件捕获，需手动记录）
    log_audit(
        db, user_id=user.id, username=user.username, action="export",
        resource_type="ban_record", ip_address=get_client_ip(request) if request else "unknown",
        result="success",
        detail={
            "count": len(records), "ids": id_values[:100],
            "status": status, "ip": ip, "fields": selected_fields,
        },
    )
    db.commit()
    filename = f"ban_workbench_banned_ips_{beijing_now().strftime('%Y%m%d_%H%M%S')}.csv"
    return _wb_csv_response(content, filename)


@router.get("/banned-ips/import/template", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def download_banned_ips_template() -> StreamingResponse:
    """下载封禁工作台 CSV 导入模板（表头 + 示例 + 说明行）。

    与导入接口同权限：有导入权限的编辑者可下载模板。
    """
    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf)
    writer.writerow(_WB_CSV_COLUMNS)
    # 示例：7 天封禁 / 0.5 天（12 小时）封禁；时长支持小数天；封堵设备可留空
    writer.writerow(["203.0.113.50", "高", "7", "否", "威胁情报确认恶意IP", "美国", "安博通阻断器"])
    writer.writerow(["198.51.100.23", "中", "0.5", "否", "短时异常扫描行为", "", ""])
    # 说明行：以 # 开头，导入时自动跳过，不影响解析
    writer.writerow([
        "# 导入后记录为「待同步」，不会自动下发；请在列表中勾选并点击「同步安博通封禁」",
        "封禁等级：低/中/高/严重", "时长支持小数天", "是否永久：是/否", "封禁原因必填",
        "可选", "封堵设备：可留空，留空使用默认安博通阻断器",
    ])
    content = buf.getvalue()
    buf.close()
    return _wb_csv_response(content, "ban_workbench_import_template.csv")


@router.post("/banned-ips/import/csv", dependencies=[Depends(require_permission("ban_workflow", "edit"))])
def import_banned_ips_csv(
    file: UploadFile = File(...),
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """批量导入封禁记录（CSV/XLSX/XLS），导入后仅入库为「待同步」。

    与资产导入一致：先校验表头与逐行字段，返回总数/成功/失败/跳过及失败原因。
    本接口**不会**调用安博通下发封禁，导入成功的记录状态为 ``pending_sync``，
    需由用户在工作台手动点击「同步安博通封禁」（可批量）并在资产匹配预览中确认。

    格式：``IP地址, 封禁等级, 封禁时长(天), 是否永久, 封禁原因, 归属地区, 封堵设备``；
    封禁时长按天、支持小数（0.5 = 12 小时）；等级支持 低/中/高/严重；
    封堵设备可选，留空则同步时使用默认「安博通阻断器」。

    实现说明：本接口为同步函数（FastAPI 自动放入线程池执行），避免 xlsx/xls
    同步解析阻塞事件循环；文件体积与行数均有上限，且已存在记录按批查询去重，
    避免逐行查库造成 N+1。
    """
    filename = (file.filename or "").lower()
    if not filename.endswith((".csv", ".xlsx", ".xls")):
        raise HTTPException(status_code=400, detail="请上传 CSV 或 Excel 文件（.csv/.xlsx/.xls）")

    try:
        content = file.file.read(_WB_IMPORT_MAX_BYTES + 1)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"读取上传文件失败：{exc}")
    if len(content) > _WB_IMPORT_MAX_BYTES:
        raise HTTPException(
            status_code=400,
            detail=f"文件过大（>{_WB_IMPORT_MAX_BYTES // (1024 * 1024)}MB），请分批导入",
        )
    try:
        rows, unknown_headers = _parse_wb_import_file(filename, content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    if not rows:
        raise HTTPException(status_code=400, detail="文件为空或只有表头")

    client_ip = request.client.host if request and request.client else ""
    imported = 0
    errors: list[dict] = []
    skipped_items: list[dict] = []
    seen: set[str] = set()

    # 第一遍：纯内存校验 + 文件内去重（不查库）
    validated: list[tuple[int, dict]] = []
    for row in rows:
        row_no = int(row.get("_row") or 0)
        raw_ip = _wb_cell_text(row.get("ip"))
        try:
            data = _validate_wb_import_row(row)
        except ValueError as exc:
            errors.append({"row": row_no, "ip": raw_ip, "msg": str(exc)})
            continue
        ip = data["ip"]
        if ip in seen:
            skipped_items.append({"row": row_no, "ip": ip, "msg": "文件内重复 IP，已跳过"})
            continue
        seen.add(ip)
        validated.append((row_no, data))

    # 第二遍：批量查已存在记录（每批 500 个 IP），避免逐行 N+1 查询
    existing: dict[str, str] = {}
    candidate_ips = [data["ip"] for _row_no, data in validated]
    for start in range(0, len(candidate_ips), 500):
        chunk = candidate_ips[start:start + 500]
        hits = (
            db.query(BanRecord.ip, BanRecord.status)
            .filter(
                BanRecord.ip.in_(chunk),
                BanRecord.status.in_(["active", _PENDING_SYNC_STATUS]),
            )
            .all()
        )
        for ip, status in hits:
            # 同一 IP 同时存在两种状态时优先按「生效中」提示
            if ip not in existing or status == "active":
                existing[ip] = status

    for row_no, data in validated:
        ip = data["ip"]
        status = existing.get(ip)
        if status == "active":
            skipped_items.append({
                "row": row_no, "ip": ip,
                "msg": f"该 IP 已在封禁中（{_RECORD_STATUS_LABELS.get(status, status)}）",
            })
            continue
        if status == _PENDING_SYNC_STATUS:
            skipped_items.append({"row": row_no, "ip": ip, "msg": "该 IP 已存在待同步记录，已跳过"})
            continue
        db.add(BanRecord(
            ip=ip,
            ban_level=data["ban_level"],
            ban_duration=data["ban_duration"],
            is_permanent=data["is_permanent"],
            expire_time=None,
            reason=data["reason"],
            region=data["region"],
            ban_device=data["ban_device"] or None,
            ban_source="import",
            status=_PENDING_SYNC_STATUS,
        ))
        imported += 1

    db.commit()
    write_audit(
        db, action="import", resource_type="ban_record", resource_id="",
        detail={
            "imported": imported, "failed": len(errors),
            "skipped": len(skipped_items), "errors": errors[:20],
            "source": "ban_workbench_import", "pending_sync": True,
        },
        operator=user.username, ip_address=client_ip, user_id=user.id,
    )
    logger.info(
        "封禁工作台导入完成: 待同步 %d 条, 失败 %d 条, 跳过 %d 条",
        imported, len(errors), len(skipped_items),
    )
    return {
        "ok": True,
        "total": len(rows),
        "imported": imported,
        "failed": len(errors),
        "skipped": len(skipped_items),
        "errors": errors[:200],
        "skipped_items": skipped_items[:200],
        "errors_truncated": len(errors) > 200,
        "skipped_truncated": len(skipped_items) > 200,
        "unknown_headers": unknown_headers,
        "message": "导入成功，记录已入库为「待同步」；请勾选后点击「同步安博通封禁」",
    }


# ----------------------------------------------------------------------
# 删除（需 ban_workflow:delete）
# ----------------------------------------------------------------------
@router.delete("/banned-ips/{record_id}", status_code=204, dependencies=[Depends(require_permission("ban_workflow", "delete"))])
def delete_banned_ip(
    record_id: int, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> None:
    """删除封禁记录（需 ban_workflow:delete）。

    「生效中」且由本平台下发设备的记录会先联动解封：设备解封失败返回 502 且不删除，
    避免删除后设备侧黑名单残留（永久条目尤其无法自动清理）。
    """
    record = db.query(BanRecord).filter(BanRecord.id == record_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="封禁记录不存在")
    client_ip = request.client.host if request.client else ""
    device = None
    unban_result: dict = {}
    if record.status == "active" and _record_issued_to_device(record):
        device, action, device_err = ban_target.resolve_unblock_device(db, record.ban_device)
        if device_err or device is None or action is None:
            raise HTTPException(
                status_code=502,
                detail=f"{device_err or '未找到可用的解封设备'}，未删除记录（设备侧封禁仍生效）",
            )
        unban_result = ban_target.run_unblock(
            db, device, action, ip=record.ip, source="ban_workbench",
            user_id=user.id, source_ip=client_ip,
        )
        ok, err = ban_target.check_unblock_result(unban_result)
        if not ok:
            logger.error(
                "删除前解封设备失败 ip=%s device=%s: %s", record.ip, device.name, err,
            )
            raise HTTPException(
                status_code=502,
                detail=f"设备「{device.name}」解封失败：{err}，未删除记录（设备侧封禁仍生效）",
            )
    snapshot = {"id": record.id, "ip": record.ip, "status": record.status, "record_id": record.record_id}
    db.delete(record)
    db.commit()
    write_audit(
        db, action="delete", resource_type="ban_record", resource_id=record_id,
        detail={"snapshot": snapshot, "device": device.name if device else "",
                "unblocked": bool(device),
                "status_code": unban_result.get("status_code")},
        operator=user.username, ip_address=client_ip,
        user_id=user.id,
    )


@router.delete("/approvals/{ticket_id}", status_code=204, dependencies=[Depends(require_permission("ban_workflow", "delete"))])
def delete_approval_ticket(
    ticket_id: int, request: Request,
    db: Session = Depends(get_db), user: User = Depends(get_current_user),
) -> None:
    """删除审批工单（需 ban_workflow:delete；关联的 pending_approval 封禁记录一并置为 cancelled）。"""
    ticket = db.query(ApprovalTicket).filter(ApprovalTicket.id == ticket_id).first()
    if ticket is None:
        raise HTTPException(status_code=404, detail="审批工单不存在")
    snapshot = {"id": ticket.id, "ip": ticket.ip, "status": ticket.status}
    # 工作台关联待审批记录置为 cancelled
    if ticket.status == "pending":
        db.query(BanRecord).filter(
            BanRecord.source_instance_id == ticket.workflow_instance_id,
            BanRecord.status == "pending_approval",
        ).update({"status": "cancelled"}, synchronize_session=False)
    db.delete(ticket)
    db.commit()
    write_audit(
        db, action="delete", resource_type="approval_ticket", resource_id=ticket_id,
        detail={"snapshot": snapshot},
        operator=user.username, ip_address=request.client.host if request.client else "",
        user_id=user.id,
    )


# ======================================================================
# 监控页统计卡片
# ======================================================================
@router.get("/stats", dependencies=[Depends(require_permission("ban_workflow", "view"))])
def workflow_stats(db: Session = Depends(get_db)) -> dict:
    """工作流统计：今日触发实例数 / 自动封禁数 / 待审批数 / 审批通过率 / 平均研判耗时 + 熔断状态。"""
    from app.core.dashboard_cache import CacheKeys, resolve_cached_payload
    from app.core.dashboard_stats import compute_ban_workflow_stats

    payload = resolve_cached_payload(
        CacheKeys.BAN_WORKFLOW_STATS,
        db,
        compute_ban_workflow_stats,
    )
    # 熔断为本进程内存状态，不可使用 Celery 刷新快照中的字段
    payload["circuit"] = trigger_mod.get_circuit_state()
    return payload
