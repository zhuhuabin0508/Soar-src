"""IP地址信息库 CSV 导入 Celery 任务。

由 ``POST /api/v1/ip-library/import`` 派发：接口保存上传文件、创建批次记录
（status=pending）后立即返回 batch_id，本任务在 worker 中执行解析与分块 upsert，
批次记录的 status/phase/percent/计数 随进度提交，前端通过
``GET /ip-library/batches/{id}`` 轮询展示。

复用政务云导入已验证口径：CSV 编码 UTF-8 优先 GB18030 兜底、中文表头映射、
每 UPSERT_CHUNK 行 ON CONFLICT DO UPDATE、full 模式删除文件中不存在的旧行。

内存要点（worker 容器 2GB 限额）：**全程流式**——二进制打开 + TextIOWrapper
按需解码，逐行解析、攒够一块就 upsert，不将整个文件或全部行驻留内存；
常驻内存仅有两个网段整数键集合（文件内去重 + 新增/更新统计，76 万行约 300MB）。
"""
import csv
import io
import ipaddress
import logging
import os
import time

from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert

from app.core.celery_app import celery_app
from app.core.timezone import beijing_now
from app.database import SessionLocal
from app.models.ip_library import LIBRARY_MODELS, IpLibraryImportBatch

logger = logging.getLogger(__name__)

# 导入规模上限与分块大小（境外库 76 万行、CSV 实际 113MB，覆盖到百万级）
MAX_ROWS = 1_000_000
MAX_FILE_SIZE = 200 * 1024 * 1024
UPSERT_CHUNK = 5000

# 网段列在各库 CSV 中的表头（云服务库为「IPv4 CIDR」，其余为「IPv4网段」）
_NET_HEADERS = ("IPv4网段", "IPv4 CIDR", "ipv4网段", "ipv4 cidr")

# 各库中文表头 → ORM 属性映射（与 LIBRARY_DEFS 的业务列一一对应）
_HEADER_MAPS = {
    "cloud_cn": {
        "云服务商名称": "cloud_provider",
    },
    "geo_cn": {
        "运营商": "isp",
        "省份": "province",
        "城市": "city",
        "地理信息状态": "geo_status",
        "APNIC登记状态": "apnic_status",
        "APNIC分配日期": "apnic_alloc_date",
    },
    "holder_cn": None,  # 与 overseas 同构
    "overseas": {
        "上级注册持有者名称(已核验)": "holder_name",
        "持有者匹配层级": "holder_match_level",
        "持有者官方记录URL": "holder_url",
        "运营商": "isp",
        "国家地区(GeoIP)": "country_geo",
        "省州": "province",
        "城市": "city",
        "RIR登记国家代码": "rir_country",
        "RIR管理机构": "rir_registry",
        "登记状态": "reg_status",
        "分配日期": "alloc_date",
        "GeoIP国家代码": "geo_country_code",
        "地理信息状态": "geo_status",
    },
    "hk_mo": None,  # 与 overseas 同构
}
_HEADER_MAPS["holder_cn"] = _HEADER_MAPS["overseas"]
_HEADER_MAPS["hk_mo"] = _HEADER_MAPS["overseas"]


def _update_batch(batch_id: int, **fields) -> None:
    """提交批次进度（独立短会话，前端轮询可见）。"""
    db = SessionLocal()
    try:
        db.query(IpLibraryImportBatch).filter(
            IpLibraryImportBatch.id == batch_id
        ).update(fields, synchronize_session=False)
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.warning("IP库批次进度更新失败（忽略）: batch=%s %s", batch_id, exc)
    finally:
        db.close()


def _sniff_encoding(path: str) -> str:
    """按文件头嗅探编码：UTF-8（含 BOM）优先，GB18030 兜底（与政务云导入同口径）。

    固定 8KB 头可能把多字节 UTF-8 字符从中间截断，strict 解码会报
    unexpected end of data 而误判为非 UTF-8（cloud_cn 8.5KB 文件实测踩坑：
    误回退 gb18030 后全量导入失败）。因此截掉尾部最多 4 字节重试，
    仍失败才认定非 UTF-8。
    """
    with open(path, "rb") as f:
        head = f.read(8192)
    if not head:
        return "utf-8-sig"
    for trim in range(4):
        try:
            head[: len(head) - trim].decode("utf-8-sig")
            return "utf-8-sig"
        except UnicodeDecodeError:
            continue
    return "gb18030"


def _parse_net(text: str):
    """解析网段文本（CIDR / 裸 IP），返回 (start, end_exclusive, 规范cidr) 或 None。

    ``ip_network(strict=False)`` 使主机位非零的写法（如 1.2.3.4/24）
    自动规整为 1.2.3.0/24；裸 IP（无掩码长度）按 /32 单地址处理。
    """
    t = (text or "").strip()
    if not t:
        return None
    try:
        net = ipaddress.ip_network(t, strict=False)
    except ValueError:
        return None
    if net.version != 4:
        return None
    start = int(net.network_address)
    end = int(net.broadcast_address) + 1  # 右开，与 int8range 生成列对齐
    return start, end, str(net)


@celery_app.task(
    name="import_ip_library",
    # 大文件导入耗时保护（覆盖全局 300/360s：76 万行 CSV 目标 <90s，留足余量）
    soft_time_limit=600,
    time_limit=660,
)
def import_ip_library(batch_id: int, library_type: str, mode: str, file_path: str) -> dict:
    """异步导入一个库分表 CSV（流式解析 + 分块 upsert），进度回写批次记录。"""
    model = LIBRARY_MODELS.get(library_type)
    if model is None:
        _update_batch(batch_id, status="failed", note=f"未知库类型: {library_type}")
        return {"status": "failed"}
    import_mode = mode if mode in ("full", "incremental") else "full"
    started = time.perf_counter()
    _update_batch(batch_id, status="running", phase="importing", percent=2)

    binary_file = None
    try:
        file_size = os.path.getsize(file_path)
        if file_size == 0:
            raise ValueError("上传文件为空或已被清理")
        if file_size > MAX_FILE_SIZE:
            raise ValueError(f"文件超过 {MAX_FILE_SIZE // (1024 * 1024)}MB 上限")

        # ----------------------------------------------------------
        # 0. 流式打开（二进制句柄 + TextIOWrapper 解码），表头列序映射
        # ----------------------------------------------------------
        binary_file = open(file_path, "rb")
        text_file = io.TextIOWrapper(binary_file, encoding=_sniff_encoding(file_path), newline="")
        reader = csv.reader(text_file)
        try:
            raw_headers = [h.strip() for h in next(reader)]
        except StopIteration:
            raise ValueError("CSV 为空（需首行表头 + 数据行）")

        net_idx = None
        col_map = []  # (列下标, ORM 属性)
        for i, h in enumerate(raw_headers):
            if net_idx is None and h in _NET_HEADERS:
                net_idx = i
                continue
            attr = _HEADER_MAPS[library_type].get(h)
            if attr:
                col_map.append((i, attr))
        if net_idx is None:
            raise ValueError(
                f"表头未识别到网段列（需要「IPv4网段」或「IPv4 CIDR」），实际表头: {raw_headers[:5]}"
            )

        # 库内既有网段键（新增/更新/删除统计基数；76 万行约 150MB，可控）
        db = SessionLocal()
        try:
            existing_keys = {
                (r[0], r[1]) for r in db.query(model.ip_start, model.ip_end)
            }
        finally:
            db.close()

        # ----------------------------------------------------------
        # 1. 逐行解析 → 攒块 upsert（ON CONFLICT (ip_start, ip_end) DO UPDATE）
        #    ip_range 为生成列，ORM 自动排除；进度按文件字节位置推进
        # ----------------------------------------------------------
        update_cols = [
            attr for attr, _label, _spec in model.fields
        ] + ["cidr", "batch_id", "updated_at"]
        file_keys = set()   # 文件内出现过的网段键（去重统计）
        chunk: list[dict] = []
        csv_rows = skipped = duplicate = 0
        last_percent = 2

        db = SessionLocal()
        try:
            def _flush(rows: list[dict]) -> None:
                if not rows:
                    return
                stmt = insert(model).values(rows)
                excluded = stmt.excluded
                stmt = stmt.on_conflict_do_update(
                    index_elements=["ip_start", "ip_end"],
                    set_={col: getattr(excluded, col) for col in update_cols},
                )
                db.execute(stmt)
                db.commit()

            for row in reader:
                if not any((c or "").strip() for c in row):
                    continue  # 空行
                csv_rows += 1
                if csv_rows > MAX_ROWS:
                    raise ValueError(f"行数过多，最多 {MAX_ROWS} 行")
                if net_idx >= len(row):
                    skipped += 1
                    continue
                parsed = _parse_net(row[net_idx])
                if parsed is None:
                    skipped += 1
                    continue
                start, end, cidr = parsed
                key = (start, end)
                if key in file_keys:
                    duplicate += 1  # 文件内重复：后面的 upsert 覆盖前面的，按最后一条保留
                else:
                    file_keys.add(key)
                values = {
                    "cidr": cidr,
                    "ip_start": start,
                    "ip_end": end,
                    "batch_id": batch_id,
                    "created_at": beijing_now(),
                    "updated_at": beijing_now(),
                }
                for i, attr in col_map:
                    values[attr] = (row[i] if i < len(row) else "").strip()
                chunk.append(values)
                if len(chunk) >= UPSERT_CHUNK:
                    _flush(chunk)
                    chunk = []
                    percent = 2 + int(binary_file.tell() / max(file_size, 1) * 93)
                    if percent >= last_percent + 5:  # 每 5% 提交一次，减少进度写放大
                        last_percent = percent
                        _update_batch(
                            batch_id,
                            phase="importing",
                            percent=percent,
                            csv_rows=csv_rows,
                            skipped=skipped,
                        )
            _flush(chunk)

            if not file_keys:
                raise ValueError(
                    f"{csv_rows} 行均无法解析网段，请确认表头与数据源导出口径一致"
                )

            inserted = len(file_keys - existing_keys)
            updated = len(file_keys & existing_keys)
            deleted = len(existing_keys - file_keys) if import_mode == "full" else 0
            _update_batch(
                batch_id,
                phase="importing",
                percent=96,
                csv_rows=csv_rows,
                unique_cidrs=len(file_keys),
                inserted=inserted,
                updated=updated,
                deleted=deleted,
                skipped=skipped,
            )

            # ------------------------------------------------------
            # 2. full 模式清理旧批次数据 + 收尾统计
            # ------------------------------------------------------
            _update_batch(batch_id, phase="finalizing", percent=97)
            if import_mode == "full":
                db.query(model).filter(model.batch_id != batch_id).delete(synchronize_session=False)
                db.commit()

            live = int(db.query(func.count(model.id)).scalar() or 0)
            duration_ms = int((time.perf_counter() - started) * 1000)

            notes = []
            notes.append(
                "全量导入：已删除文件中不存在的旧记录"
                if import_mode == "full"
                else "增量导入：仅新增/更新，未删除库内既有记录"
            )
            if duplicate:
                notes.append(f"文件内重复网段 {duplicate} 条，按最后一条保留")
            if skipped:
                notes.append(f"网段无法解析跳过 {skipped} 条")
            if import_mode == "full" and live != len(file_keys):
                notes.append(f"导入后库内 {live} 与文件唯一网段 {len(file_keys)} 不一致")

            _update_batch(
                batch_id,
                status="success",
                phase="",
                percent=100,
                csv_rows=csv_rows,
                unique_cidrs=len(file_keys),
                inserted=inserted,
                updated=updated,
                deleted=deleted,
                skipped=skipped,
                live_count=live,
                duration_ms=duration_ms,
                note="；".join(notes),
            )
            logger.info(
                "IP库导入完成: type=%s mode=%s rows=%d unique=%d live=%d inserted=%d "
                "updated=%d deleted=%d skipped=%d %dms",
                library_type, import_mode, csv_rows, len(file_keys), live, inserted,
                updated, deleted, skipped, duration_ms,
            )
            return {"status": "success", "live_count": live, "duration_ms": duration_ms}
        finally:
            db.close()

    except Exception as exc:  # noqa: BLE001
        duration_ms = int((time.perf_counter() - started) * 1000)
        _update_batch(
            batch_id,
            status="failed",
            phase="",
            duration_ms=duration_ms,
            note=str(exc)[:2000],
        )
        logger.exception("IP库导入失败: batch=%s type=%s %s", batch_id, library_type, exc)
        return {"status": "failed"}
    finally:
        if binary_file is not None:
            try:
                binary_file.close()
            except OSError:
                pass
        # 清理上传的临时文件（成功失败均删，避免堆积）
        try:
            os.remove(file_path)
        except OSError:
            pass
