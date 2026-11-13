"""IP地址信息库 API：5 库 IPv4 数据源的查询、导入与批次管理。

查询为主的设计（不做全量列表浏览）：

- ``GET /meta``    概览统计（5 库网段数/覆盖 IP 数/最近批次），前端卡片数据源
- ``GET /lookup``  核心点查：单 IP 跨 5 库 GiST ``@>``，毫秒级返回全部命中网段
- ``GET /lookup-batch`` 批量点查：逗号分隔多个 IP，一次返回各自命中（工单安全上下文用）
- ``GET /records`` 条件查询结果分页：IP/CIDR（GiST）或关键词（trgm）或等值筛选，
                   支持单库或全部库 UNION ALL；必须至少一个查询条件
- ``GET /export``  导出当前查询结果 CSV（keyset 流式分块，恒定内存）
- ``POST /import`` CSV 上传 → 保存临时文件 → 派发 Celery 异步导入任务 → 返回 batch_id
- ``GET /batches`` 批次历史 / 单批次进度（前端 1.5s 轮询）
"""
import csv
import io
import ipaddress
import logging
import os
import time
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import StreamingResponse
from sqlalchemy import (
    BigInteger, and_, cast, exists, func, literal, null, or_, select, text, tuple_, union_all,
)
from sqlalchemy.orm import Session

from app.core.audit import get_client_ip, log_audit
from app.core.timezone import to_beijing_iso
from app.database import get_db
from app.dependencies import require_permission
from app.models.ip_library import LIBRARY_DEFS, LIBRARY_MODELS, IpLibraryImportBatch
from app.models.user import User
from app.tasks.ip_library_tasks import MAX_FILE_SIZE, import_ip_library

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ip-library", tags=["ip_library"])

EXPORT_CHUNK = 5000
# 批量点查单次上限（工单 IP 数量通常 <100，超过部分截断并标记 truncated）
BATCH_LOOKUP_LIMIT = 100

# 全部业务属性（按 LIBRARY_DEFS 定义顺序去重），UNION ALL 的公共列
_ALL_ATTRS: list[str] = []
for _def in LIBRARY_DEFS.values():
    for _attr, _label, _spec in _def["fields"]:
        if _attr not in _ALL_ATTRS:
            _ALL_ATTRS.append(_attr)
_ATTR_LABELS = {
    _attr: _label
    for _def in LIBRARY_DEFS.values()
    for _attr, _label, _spec in _def["fields"]
}

# 上传文件保存目录：backend/uploads/ip_library/（Celery worker 同目录可读）
UPLOAD_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))),
    "uploads",
    "ip_library",
)

# meta 概览统计缓存：{library_type: (校验键, 统计值)}
# 数据仅在导入时变化 → 以「最近批次 ID + 批次状态」为校验键：
# 导入进行中可能被请求写入半成品统计，批次状态变化后自动失效重算
_STATS_CACHE: dict[str, tuple[tuple[int, str], dict]] = {}


# ============================================================================
# 查询条件识别与 SELECT 构建
# ============================================================================

def _kw_extractable_len(kw: str) -> int:
    """关键词中可被 pg_trgm 提取为 trigram 的字符数（字母/数字/中文等，标点除外）。"""
    return sum(1 for ch in kw if ch.isalnum())


def _detect_query(q: str) -> tuple[str, dict]:
    """识别查询串类型：单 IP / CIDR 网段 / 关键词。

    返回 ("ip", {"ip_int": n}) / ("cidr", {"start": s, "end": e}) / ("keyword", {"kw": s})。
    """
    t = (q or "").strip()
    try:
        addr = ipaddress.IPv4Address(t)
        return "ip", {"ip_int": int(addr)}
    except ValueError:
        pass
    try:
        net = ipaddress.ip_network(t, strict=False)
        if net.version == 4:
            return "cidr", {"start": int(net.network_address), "end": int(net.broadcast_address) + 1}
    except ValueError:
        pass
    return "keyword", {"kw": t}


def _exclude_hk_mo_overlap(model):
    """hk_mo 是境外库中港澳网段的独立视图：跨库查询时排除境外库的同 CIDR 行，避免重复返回。

    单库查询（指定 ``library_type``）不受影响，仍返回该库完整数据。
    """
    hk = LIBRARY_MODELS["hk_mo"]
    return ~exists().where(hk.cidr == model.cidr)


def _filtered_selects(
    library_type: str,
    q_kind: str,
    q_val: dict,
    country: str,
    isp: str,
    province: str,
) -> tuple[list, bool]:
    """构建各库分表的 SELECT（公共列 + 业务列对齐），返回 (union_all 列表, 短关键词标记)。

    - 等值筛选字段在该库不存在时直接跳过该库（如按国家筛选时不含 cloud_cn）
    - IP/CIDR 走 GiST ip_range；关键词走 trgm ILIKE 包含匹配
    - 短关键词（<3 可提取字符）走 strpos 顺序扫描，返回 True 提示调用方
      需 ``SET LOCAL`` 关闭索引访问（见 _force_seqscan_hint）
    """
    selects = []
    short_keyword = False
    for ltype, model in LIBRARY_MODELS.items():
        if library_type and ltype != library_type:
            continue
        attr_names = {a for a, _label, _spec in model.fields}
        conds = []
        # 全库联合查询：港澳网段只在 hk_mo 中返回，避免与 overseas 重复
        if not library_type and ltype == "overseas":
            conds.append(_exclude_hk_mo_overlap(model))
        if country:
            if "country_geo" not in attr_names:
                continue
            conds.append(model.country_geo == country)
        if isp:
            if "isp" not in attr_names:
                continue
            conds.append(model.isp == isp)
        if province:
            if "province" not in attr_names:
                continue
            conds.append(model.province == province)
        if q_kind == "ip":
            conds.append(model.ip_range.op("@>")(cast(q_val["ip_int"], BigInteger)))
        elif q_kind == "cidr":
            conds.append(
                model.ip_range.op("&&")(
                    func.int8range(cast(q_val["start"], BigInteger), cast(q_val["end"], BigInteger))
                )
            )
        elif q_kind == "keyword" and q_val["kw"]:
            kw = q_val["kw"]
            # 只搜有意义业务文本列（LIBRARY_DEFS.search_fields），URL/枚举/代码列不参与
            text_cols = [getattr(model, attr) for attr in LIBRARY_DEFS[ltype]["search_fields"]]
            if _kw_extractable_len(kw) >= 3:
                # >=3 个可提取字符：pg_trgm 可生成 trigram，GIN 精确过滤（毫秒级）
                conds.append(or_(*[col.ilike(f"%{kw}%") for col in text_cols]))
            else:
                # 不足 3 字符（如「腾讯」「UK」）：pg_trgm 无法生成 trigram，GIN 会退化为
                # 全表位图扫描（更慢）；走 strpos 顺序扫描（调用方强制并行路径）
                short_keyword = True
                conds.append(or_(*[
                    func.strpos(func.lower(col), kw.lower()) > 0 for col in text_cols
                ]))
        cols = [
            literal(ltype).label("library_type"),
            model.id.label("id"),
            model.cidr.label("cidr"),
            model.ip_start.label("ip_start"),
            model.ip_end.label("ip_end"),
            model.batch_id.label("batch_id"),
            model.updated_at.label("updated_at"),
        ]
        for attr in _ALL_ATTRS:
            cols.append(
                getattr(model, attr).label(attr) if attr in attr_names else null().label(attr)
            )
        stmt = select(*cols)
        if conds:
            stmt = stmt.where(and_(*conds))
        selects.append(stmt)
    return selects, short_keyword


def _force_seqscan_hint(db: Session) -> None:
    """短关键词 strpos 路径：事务内关闭 indexscan/bitmapscan，强制并行顺序扫描。

    strpos 无统计信息且无索引可用，但 ``ORDER BY ip_start + LIMIT`` 会让优化器
    选择 btree 索引串行扫描逐行过滤全表（Index Scan 不能并行，境外库 76 万行
    实测 1.5s）；关闭索引访问后优化器走并行顺序扫描（实测 243ms）。
    ``SET LOCAL`` 仅在本事务内生效，事务结束（请求级会话 close 回滚）自动复位。
    """
    db.execute(text("SET LOCAL enable_indexscan = off"))
    db.execute(text("SET LOCAL enable_bitmapscan = off"))
    # 默认 2 并发不够分：单库 76 万行 / 跨库 UNION ALL 下提高扫描并行度
    db.execute(text("SET LOCAL max_parallel_workers_per_gather = 6"))


def _row_to_item(row) -> dict:
    mapping = row._mapping
    item = {
        "library_type": mapping["library_type"],
        "id": mapping["id"],
        "cidr": mapping["cidr"] or "",
        "ip_start": mapping["ip_start"],
        "ip_end": mapping["ip_end"],
        "batch_id": mapping["batch_id"],
        "updated_at": to_beijing_iso(mapping["updated_at"]),
    }
    for attr in _ALL_ATTRS:
        item[attr] = mapping[attr] or ""
    return item


def _require_query_condition(q: str, country: str, isp: str, province: str) -> None:
    """查询为主设计：records/export 必须至少带一个查询条件，不做全量浏览。"""
    if not (q.strip() or country.strip() or isp.strip() or province.strip()):
        raise HTTPException(
            status_code=400,
            detail="请至少输入 IP / 网段 / 关键词，或设置国家 / 运营商 / 省份筛选条件",
        )


# ============================================================================
# 概览统计
# ============================================================================

def _library_stats(db: Session, ltype: str) -> dict:
    """单库统计：网段数、覆盖 IP 数、最近批次。以最近批次 ID 为缓存键。"""
    last_batch = (
        db.query(IpLibraryImportBatch)
        .filter(IpLibraryImportBatch.library_type == ltype)
        .order_by(IpLibraryImportBatch.id.desc())
        .first()
    )
    key = (last_batch.id, last_batch.status) if last_batch else (0, "")
    cached = _STATS_CACHE.get(ltype)
    if cached and cached[0] == key:
        return {**cached[1], "last_batch": last_batch.to_dict() if last_batch else None}

    model = LIBRARY_MODELS[ltype]
    segment_count = int(db.query(func.count(model.id)).scalar() or 0)
    covered_ips = int(
        db.execute(select(func.coalesce(func.sum(model.ip_end - model.ip_start), 0))).scalar() or 0
    )
    value = {"segment_count": segment_count, "covered_ips": covered_ips}
    _STATS_CACHE[ltype] = (key, value)
    return {**value, "last_batch": last_batch.to_dict() if last_batch else None}


@router.get("/meta")
def get_meta(
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("ip_library", "view")),  # noqa: ARG001
) -> dict:
    """5 库定义（列/标签）+ 概览统计（网段数/覆盖 IP 数/最近批次）。"""
    libraries = []
    for ltype, meta in LIBRARY_DEFS.items():
        stats = _library_stats(db, ltype)
        libraries.append({
            "library_type": ltype,
            "label": meta["label"],
            "fields": [{"key": attr, "label": label} for attr, label, _spec in meta["fields"]],
            **stats,
        })
    return {"libraries": libraries, "attr_labels": _ATTR_LABELS}


# ============================================================================
# 核心点查：单 IP 跨 5 库
# ============================================================================

def _lookup_matches(db: Session, ip_int: int) -> list[dict]:
    """单个 IPv4 整数跨 5 库点查，返回按网段起始排序的命中记录。"""
    matches = []
    for ltype, model in LIBRARY_MODELS.items():
        query = db.query(model).filter(model.ip_range.op("@>")(cast(ip_int, BigInteger)))
        if ltype == "overseas":
            # 港澳网段归属 hk_mo，点查不再重复返回 overseas 的同网段记录
            query = query.filter(_exclude_hk_mo_overlap(model))
        rows = query.order_by(model.ip_start).all()
        for r in rows:
            matches.append({
                "library_type": ltype,
                "library_label": LIBRARY_DEFS[ltype]["label"],
                **r.to_dict(),
            })
    return matches


@router.get("/lookup")
def lookup_ip(
    ip: str = Query(..., description="单个 IPv4 地址"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("ip_library", "view")),  # noqa: ARG001
) -> dict:
    """IP 点查：GiST ``ip_range @> :ip``，5 库各命中若干网段，毫秒级。"""
    try:
        addr = ipaddress.IPv4Address(ip.strip())
    except ValueError:
        raise HTTPException(status_code=400, detail=f"无效的 IPv4 地址: {ip}")
    matches = _lookup_matches(db, int(addr))
    return {"ip": str(addr), "match_count": len(matches), "matches": matches}


@router.get("/lookup-batch")
def lookup_ips_batch(
    ips: str = Query(..., description="IPv4 地址列表，逗号分隔，单次最多 100 个"),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("ip_library", "view")),  # noqa: ARG001
) -> dict:
    """批量 IP 点查：工单安全上下文等场景一次校验多个 IP。

    非法/非 IPv4 地址不整体报错，放入 ``invalid`` 由调用方忽略；超出上限的部分截断。
    """
    raw = [s.strip() for s in ips.replace("，", ",").split(",") if s.strip()]
    unique = list(dict.fromkeys(raw))
    accepted = unique[:BATCH_LOOKUP_LIMIT]
    items, invalid = [], []
    for ip in accepted:
        try:
            addr = ipaddress.IPv4Address(ip)
        except ValueError:
            invalid.append(ip)
            continue
        matches = _lookup_matches(db, int(addr))
        items.append({"ip": str(addr), "match_count": len(matches), "matches": matches})
    return {"items": items, "invalid": invalid, "truncated": len(unique) > len(accepted)}


# ============================================================================
# 条件查询结果分页
# ============================================================================

@router.get("/records")
def query_records(
    library_type: str = Query("", description="限定库（空 = 4 库联合查询）"),
    q: str = Query("", description="IP / 网段 / 关键词（自动识别）"),
    country: str = Query("", description="国家地区等值筛选"),
    isp: str = Query("", description="运营商等值筛选"),
    province: str = Query("", description="省份等值筛选"),
    page: int = Query(1, ge=1),
    page_size: int = Query(50, ge=1, le=200),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("ip_library", "view")),  # noqa: ARG001
) -> dict:
    """条件查询结果分页（不做无条件的全量浏览）。

    - ``q`` 为单 IP → GiST 点查命中网段；为 CIDR → GiST 重叠；否则 trgm 包含匹配
    - ``library_type`` 为空时全部库 UNION ALL 联合分页，按 ip_start 升序
    """
    _require_query_condition(q, country, isp, province)
    if library_type and library_type not in LIBRARY_MODELS:
        raise HTTPException(status_code=400, detail=f"未知库类型: {library_type}")
    q_kind, q_val = _detect_query(q)
    selects, short_keyword = _filtered_selects(
        library_type, q_kind, q_val, country.strip(), isp.strip(), province.strip()
    )
    if not selects:
        return {"total": 0, "page": page, "page_size": page_size, "items": []}
    if short_keyword:
        _force_seqscan_hint(db)
    u = union_all(*selects).subquery()
    # 单次查询带出总数（窗口函数），避免 count + 分页两次执行重查询
    rows = db.execute(
        select(u.c, func.count().over().label("__total"))
        .order_by(u.c.ip_start, u.c.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    if rows:
        total = int(rows[0]._mapping["__total"])
    elif page == 1:
        total = 0
    else:
        # 翻页越界（空页）：回退精确 count
        total = int(db.execute(select(func.count()).select_from(u)).scalar() or 0)
    return {"total": total, "page": page, "page_size": page_size, "items": [_row_to_item(r) for r in rows]}


# ============================================================================
# 导出当前查询结果
# ============================================================================

@router.get("/export")
def export_records(
    library_type: str = Query(""),
    q: str = Query(""),
    country: str = Query(""),
    isp: str = Query(""),
    province: str = Query(""),
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("ip_library", "view")),
) -> StreamingResponse:
    """导出当前查询结果为 CSV（UTF-8 BOM）。

    keyset 流式分块（(ip_start, id) 游标 + 5000/块），恒定内存，
    避免深 OFFSET 越翻越慢。
    """
    _require_query_condition(q, country, isp, province)
    if library_type and library_type not in LIBRARY_MODELS:
        raise HTTPException(status_code=400, detail=f"未知库类型: {library_type}")
    q_kind, q_val = _detect_query(q)
    selects, short_keyword = _filtered_selects(
        library_type, q_kind, q_val, country.strip(), isp.strip(), province.strip()
    )
    if not selects:
        raise HTTPException(status_code=400, detail="没有可导出的库（筛选条件与库字段不匹配）")

    filters_desc = f"lib={library_type or 'all'} q={q!r} country={country!r} isp={isp!r} province={province!r}"
    try:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="export",
            resource_type="ip_library",
            detail=filters_desc,
            ip_address=get_client_ip(request) if request else None,
            result="success",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("导出审计写入失败（忽略）: %s", exc)

    if short_keyword:
        # 必须在 log_audit 之后执行：审计内部 commit 会结束事务，使 SET LOCAL 复位；
        # 放在最后可让下面的流式查询复用同一事务里的 seqscan 提示
        _force_seqscan_hint(db)

    headers = ["库", "网段"] + [_ATTR_LABELS.get(a, a) for a in _ALL_ATTRS] + ["更新时间"]

    def _iter_csv():
        buf = io.StringIO()
        buf.write("\ufeff")  # BOM：Excel 直接打开不乱码
        csv.writer(buf).writerow(headers)
        yield buf.getvalue()

        u = union_all(*selects).subquery()
        last = (-1, -1)
        exported = 0
        while True:
            rows = db.execute(
                select(u)
                .where(tuple_(u.c.ip_start, u.c.id) > last)
                .order_by(u.c.ip_start, u.c.id)
                .limit(EXPORT_CHUNK)
            ).all()
            if not rows:
                break
            chunk = io.StringIO()
            writer = csv.writer(chunk)
            for row in rows:
                mapping = row._mapping
                last = (mapping["ip_start"], mapping["id"])
                exported += 1
                writer.writerow(
                    [LIBRARY_DEFS[mapping["library_type"]]["label"], mapping["cidr"]]
                    + [mapping[a] or "" for a in _ALL_ATTRS]
                    + [to_beijing_iso(mapping["updated_at"]) or ""]
                )
            yield chunk.getvalue()
            if len(rows) < EXPORT_CHUNK:
                break
        logger.info("IP库导出: %s rows=%d", filters_desc, exported)

    filename = f"ip_library_{time.strftime('%Y%m%d')}.csv"
    return StreamingResponse(
        _iter_csv(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}",
        },
    )


# ============================================================================
# 异步导入
# ============================================================================

@router.post("/import")
def import_csv(
    file: UploadFile = File(..., description="数据源导出的 CSV（首行中文表头）"),
    library_type: str = Query(..., description="cloud_cn / geo_cn / holder_cn / overseas / hk_mo"),
    mode: str = Query("full", description="full 全量对齐（删除文件外旧记录）/ incremental 增量 upsert"),
    request: Request = None,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("ip_library", "edit")),
) -> dict:
    """上传 CSV 并派发 Celery 异步导入任务，立即返回 batch_id（前端轮询进度）。"""
    if library_type not in LIBRARY_MODELS:
        raise HTTPException(status_code=400, detail=f"未知库类型: {library_type}")
    import_mode = mode if mode in ("full", "incremental") else "full"
    filename = file.filename or "upload"
    if not filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="仅支持 .csv 文件（数据源导出格式）")

    batch = IpLibraryImportBatch(
        library_type=library_type,
        filename=filename[:300],
        file_size=0,
        status="pending",
        phase="",
        percent=0,
        import_mode=import_mode,
        created_by=user.id,
    )
    db.add(batch)
    db.flush()

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    file_path = os.path.join(UPLOAD_DIR, f"{batch.id}.csv")
    total = 0
    try:
        with open(file_path, "wb") as out:
            while True:
                chunk = file.file.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_FILE_SIZE:
                    raise HTTPException(
                        status_code=413,
                        detail=f"文件超过 {MAX_FILE_SIZE // (1024 * 1024)}MB 上限",
                    )
                out.write(chunk)
    except Exception:
        # 上传失败/超限：清理临时文件，回滚批次
        try:
            os.remove(file_path)
        except OSError:
            pass
        db.rollback()
        raise
    if total == 0:
        os.remove(file_path)
        db.rollback()
        raise HTTPException(status_code=400, detail="文件为空")
    batch.file_size = total
    # 先提交批次记录再派发任务：避免 worker 早于本事务提交执行，
    # 导致任务初始 running 状态更新因行不可见而丢失
    db.commit()

    try:
        import_ip_library.delay(batch.id, library_type, import_mode, file_path)
    except Exception as exc:  # noqa: BLE001
        try:
            os.remove(file_path)
        except OSError:
            pass
        batch.status = "failed"
        batch.note = f"异步任务派发失败（Redis/Celery 未就绪）: {exc}"[:2000]
        db.commit()
        raise HTTPException(status_code=503, detail="导入任务派发失败，请确认后台任务服务已启动")

    try:
        log_audit(
            db,
            user_id=user.id,
            username=user.username,
            action="import",
            resource_type="ip_library",
            resource_id=str(batch.id),
            detail=f"{library_type} {import_mode} file={filename[:120]} size={total}",
            ip_address=get_client_ip(request) if request else None,
            result="success",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("导入审计写入失败（忽略）: %s", exc)
    db.commit()
    logger.info("IP库导入任务已派发: batch=%s type=%s mode=%s size=%d", batch.id, library_type, import_mode, total)
    return {"batch_id": batch.id, "library_type": library_type, "import_mode": import_mode, "status": "pending"}


# ============================================================================
# 批次历史与进度
# ============================================================================

@router.get("/batches")
def list_batches(
    library_type: str = Query(""),
    limit: int = Query(20, ge=1, le=100),
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("ip_library", "view")),  # noqa: ARG001
) -> dict:
    query = db.query(IpLibraryImportBatch)
    if library_type:
        if library_type not in LIBRARY_MODELS:
            raise HTTPException(status_code=400, detail=f"未知库类型: {library_type}")
        query = query.filter(IpLibraryImportBatch.library_type == library_type)
    rows = query.order_by(IpLibraryImportBatch.id.desc()).limit(limit).all()
    return {"items": [b.to_dict() for b in rows]}


@router.get("/batches/{batch_id}")
def get_batch(
    batch_id: int,
    db: Session = Depends(get_db),
    user: User = Depends(require_permission("ip_library", "view")),  # noqa: ARG001
) -> dict:
    batch = db.query(IpLibraryImportBatch).filter(IpLibraryImportBatch.id == batch_id).first()
    if not batch:
        raise HTTPException(status_code=404, detail="批次不存在")
    return batch.to_dict()
