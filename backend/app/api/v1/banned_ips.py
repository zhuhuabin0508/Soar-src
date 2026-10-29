"""已封禁 IP 管理 API。

提供已封禁 IP 列表查看、详情查询、手动解封、统计信息、导入导出。
供前端「已封禁 IP」页面和智能体工具使用。
"""
import csv
import io
import json
import logging
from datetime import datetime, timedelta
from app.core.timezone import beijing_now, beijing_now_iso

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.ip_validation import validate_ban_target
from app.database import get_db
from app.dependencies import get_current_user, require_role
from app.models.user import User
from app.models.banned_ip import BannedIP
from app.schemas.common import to_dict, to_dict_list

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/banned-ips",
    tags=["banned-ips"],
    dependencies=[Depends(get_current_user)],
)


def _ip_compare_key(value) -> str:
    """封禁记录查重用的宽松比较键：去首尾空白 + 小写。

    历史记录可能是未归一化写法（``2001:DB8::1``、前后带空格），严格相等会
    漏判重复；这里只做空白/大小写规整，不改变语义（多值分隔符差异仍视为不同）。
    """
    return str(value or "").strip().lower()


class ManualBanRequest(BaseModel):
    """手动新增封禁 IP 请求体。"""

    ip: str = Field(..., min_length=1, max_length=2048, description="待封禁的 IP 地址")
    ban_level: str = Field("medium", description="封禁等级：low/medium/high/serious")
    ban_duration: int = Field(3600, description="封禁时长（秒），0 表示永久")
    region: str = Field("", description="归属地区")
    reason: str = Field("", description="封禁原因")
    device_id: int = Field(..., description="执行封禁的设备 ID（调用该设备的 block_ip 动作）")


@router.get("")
def list_banned_ips(
    search: str = Query("", description="搜索 IP 地址"),
    status: str = Query("", description="状态过滤：active/expired/unblocked"),
    db: Session = Depends(get_db),
    _: object = Depends(require_role("admin")),
) -> list[dict]:
    """列出所有已封禁 IP（自动更新过期状态）（仅管理员）。"""
    query = db.query(BannedIP)
    if search:
        query = query.filter(BannedIP.ip.contains(search))
    if status:
        query = query.filter(BannedIP.status == status)

    records = query.order_by(BannedIP.created_at.desc()).all()

    # 自动将过期的 active 记录标记为 expired
    # 北京时间（UTC+8）：数据库内统一存北京时间，与前端显示一致
    now = beijing_now()
    changed = False
    for r in records:
        if r.status == "active" and r.expired_at < now:
            r.status = "expired"
            changed = True
    if changed:
        db.commit()

    return to_dict_list(records)


@router.get("/stats")
def get_banned_stats(
    db: Session = Depends(get_db),
    _: object = Depends(require_role("admin")),
) -> dict:
    """已封禁 IP 统计信息（仅管理员）。"""
    total = db.query(BannedIP).count()
    active = db.query(BannedIP).filter(BannedIP.status == "active").count()
    expired = db.query(BannedIP).filter(BannedIP.status == "expired").count()
    unblocked = db.query(BannedIP).filter(BannedIP.status == "unblocked").count()
    return {"total": total, "active": active, "expired": expired, "unblocked": unblocked}


@router.post("", status_code=201)
def manual_ban_ip(
    body: ManualBanRequest,
    db: Session = Depends(get_db),
    _: object = Depends(require_role("admin")),
) -> dict:
    """手动新增封禁 IP（仅管理员）。

    与智能体自动封禁区分：source 字段标记为 ``manual``。
    必须指定 ``device_id``，系统将调用该设备的 ``block_ip`` 动作 API 实际封禁 IP。
    若设备 API 调用失败则返回 502 错误，不创建数据库记录。
    若该 IP 已存在封禁记录，返回 409 冲突（不覆盖）。
    """
    # 校验封禁等级
    if body.ban_level not in ("low", "medium", "high", "serious"):
        raise HTTPException(status_code=400, detail="封禁等级必须为 low/medium/high/serious")

    # 校验封禁目标格式（单 IP / CIDR / 范围 / 多值；拒绝主机名/文本/通配）
    try:
        ban_ip = validate_ban_target(body.ip, "封禁目标")
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    if not ban_ip:
        # 纯空白输入经归一化后为空串：不能带着空目标去调用设备 API
        raise HTTPException(status_code=422, detail="封禁目标不能为空")

    # 查重：同 IP 已有记录则拒绝（避免浪费设备 API 调用）
    existing = db.query(BannedIP).filter(BannedIP.ip == ban_ip).first()
    if existing is None:
        # 兜底：历史记录可能是未归一化写法（大小写/空格），按规整键再查一次
        existing = (
            db.query(BannedIP)
            .filter(func.lower(func.trim(BannedIP.ip)) == _ip_compare_key(ban_ip))
            .first()
        )
    if existing is not None:
        raise HTTPException(
            status_code=409,
            detail=f"IP {ban_ip} 已存在封禁记录（id={existing.id}, status={existing.status}）",
        )

    # 查找设备的 block_ip 动作
    from app.devices.action_executor import find_device_action_by_type, execute_device_action

    device, action, dev_err = find_device_action_by_type(db, body.device_id, "block_ip")
    if dev_err:
        raise HTTPException(status_code=400, detail=dev_err)

    # 调用设备 API 执行封禁
    params = {
        "ip": ban_ip,
        "duration": str(body.ban_duration),
        "ban_level": body.ban_level,
        "reason": body.reason or "手动添加封禁",
        "region": body.region or "",
    }
    result = execute_device_action(device, action, params, db=db, source="api")
    if not result["success"]:
        logger.warning("手动封禁 IP 设备 API 调用失败: ip=%s, device=%s, error=%s",
                       ban_ip, device.name, result.get("error"))
        raise HTTPException(
            status_code=502,
            detail=f"设备 API 封禁失败: {result.get('error')} (status={result.get('status_code')})",
        )

    # 设备 API 调用成功，创建数据库记录
    now = beijing_now()
    # ban_duration=0 视为永久封禁（过期时间设为 9999 年）
    if body.ban_duration <= 0:
        expired_at = datetime(9999, 12, 31, 23, 59, 59)
    else:
        expired_at = now + timedelta(seconds=body.ban_duration)

    # 记录设备响应（截断防止溢出 Text 列）
    action_resp = ""
    try:
        action_resp = json.dumps(result.get("response_body"), ensure_ascii=False)[:4000]
    except Exception:  # noqa: BLE001
        action_resp = str(result.get("response_body"))[:4000]

    record = BannedIP(
        ip=ban_ip,
        ban_level=body.ban_level,
        ban_duration=body.ban_duration,
        expired_at=expired_at,
        region=body.region or "",
        violation_count=1,
        reason=body.reason or "手动添加封禁",
        status="active",
        source="manual",
        device_id=device.id,
        device_name=device.name,
        action_response=action_resp,
    )
    db.add(record)
    db.commit()
    db.refresh(record)
    logger.info("手动新增封禁 IP: %s, level=%s, duration=%s, device=%s",
                ban_ip, body.ban_level, body.ban_duration, device.name)
    return to_dict(record)


@router.get("/{ip}")
def get_banned_ip(
    ip: str,
    db: Session = Depends(get_db),
    _: object = Depends(require_role("admin")),
) -> dict:
    """查询单个 IP 的封禁状态（仅管理员）。"""
    record = db.query(BannedIP).filter(BannedIP.ip == ip).first()
    if record is None:
        raise HTTPException(status_code=404, detail="该 IP 不在封禁列表中")
    return to_dict(record)


@router.delete("/{ip_id}")
def unban_ip(
    ip_id: int,
    db: Session = Depends(get_db),
    _: object = Depends(require_role("admin")),
) -> dict:
    """手动解封 IP（仅管理员，逻辑删除：保留记录，状态置为 unblocked）。"""
    record = db.query(BannedIP).filter(BannedIP.id == ip_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    record.status = "unblocked"
    db.commit()
    logger.info("手动解封 IP: %s (id=%s)", record.ip, ip_id)
    return {"ok": True, "ip": record.ip}


@router.delete("/{ip_id}/hard")
def hard_delete_banned_ip(
    ip_id: int,
    db: Session = Depends(get_db),
    _: object = Depends(require_role("admin")),
) -> dict:
    """硬删除已封禁 IP 记录（仅管理员，物理删除：从数据库彻底移除）。

    与 ``DELETE /{ip_id}``（解封，逻辑删除）区分：本端点直接 ``db.delete``，
    记录不可恢复。适用于清理误录/测试数据等场景。
    """
    record = db.query(BannedIP).filter(BannedIP.id == ip_id).first()
    if record is None:
        raise HTTPException(status_code=404, detail="记录不存在")
    ip_addr = record.ip
    db.delete(record)
    db.commit()
    logger.info("硬删除已封禁 IP 记录: id=%s, ip=%s", ip_id, ip_addr)
    return {"ok": True, "ip": ip_addr, "deleted": True}


# CSV 导出的列顺序（与导入保持一致）
_CSV_COLUMNS = [
    "ip", "ban_level", "ban_duration", "expired_at", "region",
    "violation_count", "reason", "status", "created_at",
]

# ban_level 中文映射（导出时友好显示）
_LEVEL_LABELS = {"low": "低", "medium": "中", "high": "高", "serious": "严重"}
_LEVEL_REVERSE = {v: k for k, v in _LEVEL_LABELS.items()}


@router.get("/export/csv")
def export_banned_ips(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    request: Request = None,
    _: object = Depends(require_role("admin")),
):
    """导出所有已封禁 IP 为 CSV 文件（仅管理员）。"""
    # 审计：导出操作（GET 请求不被中间件捕获，需手动记录）
    from app.core.audit import get_client_ip, log_audit
    ip = get_client_ip(request) if request else "unknown"
    log_audit(db, user_id=user.id, username=user.username, action="export",
              resource_type="banned_ip", ip_address=ip, result="success")
    records = db.query(BannedIP).order_by(BannedIP.created_at.desc()).all()

    buf = io.StringIO()
    buf.write("\ufeff")  # BOM，确保 Excel 正确识别 UTF-8
    writer = csv.writer(buf)
    # 表头
    writer.writerow(["IP地址", "封禁等级", "封禁时长(秒)", "过期时间", "归属地",
                      "违规次数", "封禁原因", "状态", "创建时间"])
    for r in records:
        writer.writerow([
            r.ip,
            _LEVEL_LABELS.get(r.ban_level, r.ban_level),
            r.ban_duration,
            r.expired_at.strftime("%Y-%m-%d %H:%M:%S") if r.expired_at else "",
            r.region or "",
            r.violation_count or 0,
            r.reason or "",
            r.status or "",
            r.created_at.strftime("%Y-%m-%d %H:%M:%S") if r.created_at else "",
        ])

    content = buf.getvalue()
    buf.close()
    filename = f"banned_ips_{beijing_now().strftime('%Y%m%d_%H%M%S')}.csv"
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


@router.get("/import/template")
def download_import_template(
    _: object = Depends(require_role("admin")),
):
    """下载 CSV 导入模板（仅含表头与一行示例）（仅管理员）。

    表头与 ``import_banned_ips`` 解析逻辑及 ``export_banned_ips`` 导出格式保持一致。
    """
    buf = io.StringIO()
    buf.write("\ufeff")  # BOM，确保 Excel 正确识别 UTF-8
    writer = csv.writer(buf)
    writer.writerow(["IP地址", "封禁等级", "封禁时长(秒)", "过期时间",
                     "归属地", "违规次数", "封禁原因", "状态"])
    # 示例行（过期时间/状态留空，由系统计算）
    writer.writerow(["1.2.3.4", "中", "3600", "", "中国 北京", "1", "扫描发现可疑行为", ""])
    content = buf.getvalue()
    buf.close()
    return StreamingResponse(
        iter([content]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=banned_ips_import_template.csv"},
    )


@router.post("/import/csv")
async def import_banned_ips(
    file: UploadFile = File(...),
    device_id: int = Query(..., description="执行封禁的设备 ID（调用该设备的 block_ip 动作）"),
    db: Session = Depends(get_db),
    _: object = Depends(require_role("admin")),
) -> dict:
    """从 CSV 文件导入已封禁 IP（仅管理员）。

    CSV 格式与导出一致，第一行为表头（跳过）。
    已存在的 IP（按 ip 去重）跳过，不覆盖。
    每条导入的 IP 都会调用指定设备的 ``block_ip`` 动作 API 实际封禁；
    设备 API 调用失败的 IP 跳过并记入 errors，不影响其他 IP 的导入。

    注意：大文件导入会触发多次顺序 HTTP 调用，建议单次导入不超过 50 行。
    """
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="请上传 CSV 文件")

    # 校验设备 block_ip 动作存在
    from app.devices.action_executor import find_device_action_by_type, execute_device_action

    device, action, dev_err = find_device_action_by_type(db, device_id, "block_ip")
    if dev_err:
        raise HTTPException(status_code=400, detail=dev_err)

    content = await file.read()
    try:
        text = content.decode("utf-8-sig")
    except UnicodeDecodeError:
        try:
            text = content.decode("gbk")
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail="文件编码不支持，请使用 UTF-8 编码")

    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if len(rows) < 2:
        raise HTTPException(status_code=400, detail="CSV 文件为空或只有表头")

    now = beijing_now()
    imported = 0
    skipped = 0
    errors = []

    # 获取已存在的 IP 集合（去重；键做空白/大小写规整，兼容历史未归一化记录）
    existing_ips = {_ip_compare_key(ip) for (ip,) in db.query(BannedIP.ip).all()}

    for idx, row in enumerate(rows[1:], start=2):  # 从第 2 行开始（跳过表头）
        if not row or not row[0].strip():
            continue
        try:
            ip = row[0].strip()
            # 入库/下发设备前严格校验封禁目标（支持 CIDR/范围/多值，拒绝文本）
            try:
                ip = validate_ban_target(ip, "封禁目标")
            except ValueError as exc:
                errors.append(f"第 {idx} 行: {exc}")
                continue
            if _ip_compare_key(ip) in existing_ips:
                skipped += 1
                continue

            level_raw = row[1].strip() if len(row) > 1 else "medium"
            ban_level = _LEVEL_REVERSE.get(level_raw, level_raw if level_raw in _LEVEL_LABELS else "medium")
            ban_duration = int(row[2].strip()) if len(row) > 2 and row[2].strip() else 3600

            # 解析过期时间
            expired_at_str = row[3].strip() if len(row) > 3 else ""
            if expired_at_str:
                try:
                    expired_at = datetime.strptime(expired_at_str, "%Y-%m-%d %H:%M:%S")
                except ValueError:
                    expired_at = now + timedelta(seconds=ban_duration)
            else:
                expired_at = now + timedelta(seconds=ban_duration)

            region = row[4].strip() if len(row) > 4 else ""
            violation_count = int(row[5].strip()) if len(row) > 5 and row[5].strip() else 1
            reason = row[6].strip() if len(row) > 6 else ""
            status = row[7].strip() if len(row) > 7 else "active"

            # 调用设备 API 执行封禁
            params = {
                "ip": ip,
                "duration": str(ban_duration),
                "ban_level": ban_level,
                "reason": reason or "CSV 导入封禁",
                "region": region,
            }
            result = execute_device_action(device, action, params, db=db, source="api")
            if not result["success"]:
                errors.append(
                    f"第 {idx} 行: IP {ip} 封禁失败: {result.get('error')} "
                    f"(status={result.get('status_code')})"
                )
                continue

            # 记录设备响应（截断）
            action_resp = ""
            try:
                action_resp = json.dumps(result.get("response_body"), ensure_ascii=False)[:4000]
            except Exception:  # noqa: BLE001
                action_resp = str(result.get("response_body"))[:4000]

            record = BannedIP(
                ip=ip,
                ban_level=ban_level,
                ban_duration=ban_duration,
                expired_at=expired_at,
                region=region,
                violation_count=violation_count,
                reason=reason,
                status=status,
                source="manual",  # CSV 导入视为手动添加
                device_id=device.id,
                device_name=device.name,
                action_response=action_resp,
            )
            db.add(record)
            existing_ips.add(_ip_compare_key(ip))
            imported += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"第 {idx} 行: {exc}")
            continue

    if imported > 0:
        db.commit()
    logger.info("CSV 导入完成: 导入 %d 条, 跳过 %d 条, 错误 %d 条, device=%s",
                imported, skipped, len(errors), device.name)
    return {
        "ok": True,
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
    }
