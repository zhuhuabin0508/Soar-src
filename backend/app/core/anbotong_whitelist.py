"""安博通全局白名单：后台同步、内存索引与手动封禁匹配。

设计目标：
- **同步延迟 ≤ 5 秒**：后台线程按固定节拍全量拉取设备白名单，内容变化时
  原子替换本地表 ``anbotong_whitelist``；拉取失败保留旧数据并记录错误。
- **匹配响应 < 200ms**：封禁预检只读进程内索引（精确表 + IP 列表），
  不访问设备；CIDR / 范围目标按网段包含判定，避免网段封禁漏掉白名单 IP。
- **增删实时一致**：工作台手动增删成功后调用 :func:`sync_now` 立即回读设备。

匹配口径（与设备「全局白名单」语义一致）：
- 单 IP → 精确匹配（IPv6 按压缩形式归一）；
- CIDR / 范围 → 白名单中的 IP 落在该网段/区间即命中（网段封禁会连带命中白名单）；
- 域名 → 小写精确匹配；
- 仅启用且生效的条目参与命中（``enable=0`` 或 ``state=0`` 视为未生效，
  避免已停用/未生效条目造成误报）。
"""
import ipaddress
import json
import logging
import os
import threading
import time as _time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
from typing import Any, Optional

from sqlalchemy import insert
from sqlalchemy.orm import Session

from app.core.timezone import beijing_now

logger = logging.getLogger(__name__)

# 同步节拍（秒）：验收要求设备变更 5 秒内同步到平台
SYNC_INTERVAL_SECONDS = max(1, int(os.environ.get("ANBOTONG_WHITELIST_SYNC_INTERVAL", "5")))
# 单页条数（设备上限 1000）与最大页数：防止设备异常返回时无限翻页
PAGE_SIZE = 1000
MAX_PAGES = 200
# 并发拉取页数：设备单页约 0.5s，10 并发可让 5 万条白名单在 3s 左右完成全量同步
SYNC_CONCURRENCY = max(1, min(20, int(os.environ.get("ANBOTONG_WHITELIST_SYNC_CONCURRENCY", "10"))))
# 单页请求超时（秒）：超过则本轮同步失败，保留旧数据
PAGE_TIMEOUT_SECONDS = max(2, min(15, int(os.environ.get("ANBOTONG_WHITELIST_PAGE_TIMEOUT", "8"))))
# 全量同步周期（秒）：设备白名单可能很大（实测 6 万+ 条，全量拉取约 20s），
# 因此全量只在后台低频校正；5 秒节拍只做「尾页增量」，新增条目仍能在 5s 内可见。
FULL_SYNC_INTERVAL_SECONDS = max(
    SYNC_INTERVAL_SECONDS, int(os.environ.get("ANBOTONG_WHITELIST_FULL_SYNC_INTERVAL", "60"))
)
# 单次匹配的目标数上限（与手动封禁 20 个目标的上限留出余量）
MAX_MATCH_TARGETS = 100
# 单目标返回的命中条目上限：网段封禁（如 /16）可能命中数万条白名单，
# 全量返回会让响应体膨胀到数十 MB；侧滑面板只需展示样本，其余用 entry_total 提示
MAX_ENTRIES_PER_TARGET = 50
# PostgreSQL BIGINT 范围：设备永久条目的 leftTime 为 uint64 最大值，需归一为 -1
_BIGINT_MAX = 9223372036854775807
_BIGINT_MIN = -9223372036854775808

_started = False
_start_lock = threading.Lock()
# 后台同步与手动增删触发的同步共用一把锁：避免并发全量替换
_sync_lock = threading.Lock()
_cache_lock = threading.Lock()
_cache: Optional[dict[str, Any]] = None

_state_lock = threading.Lock()
_state: dict[str, Any] = {
    "last_sync_at": None,
    "last_success_at": None,
    "last_delta_at": None,
    "last_full_at": None,
    "last_error": None,
    "mode": None,
    "total": 0,
    "device": None,
    "took_ms": None,
}
_synced_signature: Optional[str] = None
# 连续「设备返回空白名单」次数：本地已有数据时，首次空结果视为设备异常并保留
# 旧数据，连续第二次才接受设备确已清空（需在 _sync_lock 内读写）
_empty_sync_streak = 0


def normalize_wlist(value: Any) -> str:
    """规范化白名单条目：IP → 压缩形式；域名 → 去尾点 + 小写。"""
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        return ipaddress.ip_address(text).compressed
    except ValueError:
        return text.rstrip(".").lower()


def _to_int(value: Any) -> Optional[int]:
    """尽量把设备返回值转成整数（兼容字符串数字与 uint64 大数）。"""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    text = str(value).strip()
    if not text:
        return None
    try:
        return int(text)
    except ValueError:
        try:
            return int(float(text))
        except ValueError:
            return None


def _clamp_bigint(value: Optional[int]) -> Optional[int]:
    """设备 uint64 大数（永久 leftTime）归一为 -1，避免超出 PostgreSQL BIGINT。"""
    if value is None:
        return None
    if value > _BIGINT_MAX or value < _BIGINT_MIN:
        return -1
    return value


def _entry_from_device(item: dict[str, Any]) -> Optional[dict[str, Any]]:
    """设备条目 → 本地缓存条目（保留设备原始字段口径）。"""
    if not isinstance(item, dict):
        return None
    wlist = normalize_wlist(item.get("wlist"))
    if not wlist:
        return None
    return {
        "wlist": wlist,
        "age": _clamp_bigint(_to_int(item.get("age"))),
        "enable": _to_int(item.get("enable")),
        "reason": str(item.get("reason") or ""),
        "effectTime": str(item.get("effectTime") or ""),
        "policy_group_name": str(item.get("policy_group_name") or ""),
        "leftTime": _clamp_bigint(_to_int(item.get("leftTime"))),
        "state": _to_int(item.get("state")),
        "hit_num": _clamp_bigint(_to_int(item.get("hit_num"))),
        "node_id": str(item.get("node_id") or ""),
    }


def _row_to_entry(row: Any) -> dict[str, Any]:
    return {
        "wlist": row.wlist,
        "age": row.age,
        "enable": row.enable,
        "reason": row.reason or "",
        "effectTime": row.effect_time or "",
        "policy_group_name": row.policy_group_name or "",
        "leftTime": row.left_time,
        "state": row.state,
        "hit_num": row.hit_num,
        "node_id": row.node_id or "",
    }


def _is_active(entry: dict[str, Any]) -> bool:
    """条目是否生效：enable=0 或 state=0 视为未生效，不参与命中。"""
    enable = entry.get("enable")
    state = entry.get("state")
    if enable is not None and _to_int(enable) == 0:
        return False
    if state is not None and _to_int(state) == 0:
        return False
    return True


def entry_left_time(entry: dict[str, Any]) -> Optional[int]:
    """按 生效时间 + 有效期 - 当前时间 计算剩余秒数；-1 表示永久。"""
    age = _to_int(entry.get("age"))
    if age is None:
        return _to_int(entry.get("leftTime"))
    if age < 0:
        return -1
    effect_time = entry.get("effectTime")
    if not effect_time:
        return _to_int(entry.get("leftTime"))
    try:
        effect = datetime.fromisoformat(str(effect_time).replace("T", " ").strip())
    except ValueError:
        return _to_int(entry.get("leftTime"))
    try:
        remain = int((effect + timedelta(seconds=age) - beijing_now()).total_seconds())
    except (OverflowError, ValueError):
        return _to_int(entry.get("leftTime"))
    return max(0, remain)


def _entry_view(entry: dict[str, Any]) -> dict[str, Any]:
    """返回给前端的条目视图：leftTime 按当前时间实时计算。"""
    out = dict(entry)
    out["leftTime"] = entry_left_time(entry)
    return out


def row_entry_view(row: Any) -> dict[str, Any]:
    """本地表行 → 前端条目视图（供白名单管理页列表使用）。"""
    return _entry_view(_row_to_entry(row))


def _build_index(entries: list[dict[str, Any]]) -> dict[str, Any]:
    exact: dict[str, dict[str, Any]] = {}
    ips: list[tuple[Any, dict[str, Any]]] = []
    for entry in entries:
        key = entry["wlist"]
        exact[key] = entry
        if not _is_active(entry):
            continue
        try:
            ips.append((ipaddress.ip_address(key), entry))
        except ValueError:
            continue
    return {
        "entries": list(entries),
        "exact": exact,
        "ips": ips,
        "built_at": beijing_now().isoformat(),
    }


def _set_cache(entries: list[dict[str, Any]]) -> None:
    global _cache
    index = _build_index(entries)
    with _cache_lock:
        _cache = index


def _ensure_cache(db: Optional[Session] = None) -> dict[str, Any]:
    """获取内存索引；进程启动后尚未同步时从本地表懒加载一次。"""
    global _cache
    if _cache is not None:
        return _cache
    with _cache_lock:
        if _cache is None:
            rows: list[Any] = []
            if db is not None:
                try:
                    from app.models.anbotong_whitelist import AnbotongWhitelist

                    rows = db.query(AnbotongWhitelist).all()
                except Exception:  # noqa: BLE001
                    logger.exception("加载安博通白名单本地缓存失败")
                    rows = []
            _cache = _build_index([_row_to_entry(r) for r in rows])
    return _cache


def _get_state() -> dict[str, Any]:
    with _state_lock:
        return dict(_state)


def _update_state(**fields: Any) -> dict[str, Any]:
    with _state_lock:
        _state.update(fields)
        return dict(_state)


def get_sync_state() -> dict[str, Any]:
    """同步状态（供页面展示最近同步时间 / 错误 / 条目数）。"""
    return _get_state()


def _signature(entries: list[dict[str, Any]]) -> str:
    """内容签名：只包含影响展示/匹配的稳定字段。

    刻意排除 hit_num（随流量高频变化）与 leftTime（按时间自然递减），避免
    每轮同步都重写全表；页面剩余时长在读取时实时计算，命中次数允许略滞后。
    """
    payload = [
        {
            "wlist": e["wlist"],
            "age": e["age"],
            "enable": e["enable"],
            "reason": e["reason"],
            "effectTime": e["effectTime"],
            "policy_group_name": e["policy_group_name"],
            "state": e["state"],
            "node_id": e["node_id"],
        }
        for e in entries
    ]
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)


# 尾部增量比较时忽略的易变字段：hit_num 随流量变化、leftTime 随时间递减，
# 两者都不影响匹配结果，不应触发数据库写入或全量签名失效
_VOLATILE_FIELDS = ("hit_num", "leftTime")


def _stable_entry(entry: dict[str, Any]) -> dict[str, Any]:
    """剔除易变字段后的稳定视图（仅用于判断是否需要写库）。"""
    return {k: v for k, v in entry.items() if k not in _VOLATILE_FIELDS}


def _replace_rows(db: Session, entries: list[dict[str, Any]]) -> bool:
    """内容变化时原子替换本地表；未变化不写库。"""
    global _synced_signature
    signature = _signature(entries)
    if _synced_signature is not None and signature == _synced_signature:
        return False
    from app.models.anbotong_whitelist import AnbotongWhitelist

    now = beijing_now()
    try:
        db.query(AnbotongWhitelist).delete(synchronize_session=False)
        if entries:
            # Core executemany 批量写入：5 万条也只需一次往返，远快于 ORM 逐条
            db.execute(insert(AnbotongWhitelist), [
                {
                    "wlist": e["wlist"],
                    "age": e["age"],
                    "enable": e["enable"],
                    "reason": e["reason"][:255],
                    "effect_time": e["effectTime"][:32],
                    "policy_group_name": e["policy_group_name"][:127],
                    "left_time": e["leftTime"],
                    "state": e["state"],
                    "hit_num": e["hit_num"],
                    "node_id": e["node_id"][:64],
                    "synced_at": now,
                }
                for e in entries
            ])
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        raise
    _synced_signature = signature
    return True


def apply_local_changes(
    db: Session,
    *,
    added: Optional[list[dict[str, Any]]] = None,
    deleted: Optional[list[str]] = None,
) -> int:
    """手动增删成功后立即校准本地表与内存索引（不等待下一轮设备同步）。

    本地先按已知变更落库，保证页面与封禁预检即时一致；后台 5 秒内会用设备
    权威数据校正（签名失效后必定回写）。返回本地表当前条目数。

    注意：内存索引必须保持设备列表顺序（尾页增量按位置比对），因此这里在
    现有缓存上做增删合并，而不是重新查库（数据库无序，重排会让下一轮增量
    误判为「顺序位移」并触发全量同步）。设备按写入顺序追加，新增条目放在尾部。
    """
    global _synced_signature
    from app.models.anbotong_whitelist import AnbotongWhitelist

    now = beijing_now()
    with _sync_lock:
        new_rows: list[Any] = []
        try:
            for wlist in deleted or []:
                db.query(AnbotongWhitelist).filter(
                    AnbotongWhitelist.wlist == wlist,
                ).delete(synchronize_session=False)
            for entry in added or []:
                wlist = entry["wlist"]
                row = db.query(AnbotongWhitelist).filter(
                    AnbotongWhitelist.wlist == wlist,
                ).first()
                if row is None:
                    row = AnbotongWhitelist(wlist=wlist)
                    db.add(row)
                row.age = entry.get("age")
                row.enable = entry.get("enable")
                row.reason = str(entry.get("reason") or "")[:255]
                row.effect_time = str(
                    entry.get("effectTime") or now.strftime("%Y-%m-%d %H:%M:%S")
                )[:32]
                row.state = 1 if _to_int(entry.get("enable")) != 0 else 0
                row.synced_at = now
                new_rows.append(row)
            db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
            raise
        _synced_signature = None
        deleted_set = set(deleted or [])
        if _cache is None:
            rows = db.query(AnbotongWhitelist).all()
            entries = [_row_to_entry(r) for r in rows]
        else:
            entries = [e for e in _cache["entries"] if e["wlist"] not in deleted_set]
            replaced = {_row_to_entry(r)["wlist"]: _row_to_entry(r) for r in new_rows}
            # 已存在的条目原位更新，新条目追加到尾部（与设备写入顺序一致）
            entries = [replaced.pop(e["wlist"], e) for e in entries]
            entries.extend(replaced.values())
        _set_cache(entries)
        _update_state(total=len(entries))
        return len(entries)


def _pull_all_pages(
    db: Session, source: str,
) -> tuple[Optional[dict[str, Any]], Optional[list[dict[str, Any]]], Optional[str]]:
    """并发分批拉取设备白名单全部页。

    设备单页上限 1000 且不返回总条数：以「满页」判断还有下一页，按
    SYNC_CONCURRENCY 并发拉取一批页，遇到未满页 / 404 即结束。单页请求不碰
    DB（db=None），可安全在线程池中并发执行；数据库只保留最终结果一次写入。

    Returns:
        (设备信息, 条目列表, 错误信息)；错误时前两项为 None，保留旧数据。
    """
    from app.devices.anbotong import fetch_whitelist_page, find_anbotong_action

    device, action, err = find_anbotong_action(db, "whitelist_list")
    if err:
        return None, None, err
    device_info = {
        "id": device.id,
        "name": device.name,
        "vendor": device.vendor,
        "api_url": device.api_url,
    }
    entries: list[dict[str, Any]] = []
    page = 1
    with ThreadPoolExecutor(
        max_workers=SYNC_CONCURRENCY, thread_name_prefix="anbotong-wl",
    ) as pool:
        while page <= MAX_PAGES:
            batch = list(range(page, min(page + SYNC_CONCURRENCY, MAX_PAGES + 1)))
            futures = {
                pool.submit(
                    fetch_whitelist_page, device, action, p, PAGE_SIZE,
                    timeout=PAGE_TIMEOUT_SECONDS, source=source,
                ): p
                for p in batch
            }
            results: dict[int, tuple[dict[str, Any], list[dict], bool]] = {}
            for future in as_completed(futures):
                page_no = futures[future]
                try:
                    results[page_no] = future.result()
                except Exception as exc:  # noqa: BLE001
                    return None, None, f"拉取第 {page_no} 页异常: {exc}"
            ended = False
            for page_no in batch:
                result, items, beyond_end = results[page_no]
                if not result.get("success"):
                    return None, None, (
                        result.get("error") or f"拉取第 {page_no} 页失败"
                    )
                for item in items:
                    entry = _entry_from_device(item)
                    if entry is not None:
                        entries.append(entry)
                if beyond_end or len(items) < PAGE_SIZE:
                    ended = True
                    break
            if ended:
                break
            page += len(batch)
    return device_info, entries, None


def sync_now(db: Session, *, source: str = "scheduler") -> dict[str, Any]:
    """全量拉取设备白名单并替换本地表 / 内存索引（手动「立即同步」/ 周期校正）。"""
    with _sync_lock:
        return _full_sync_locked(db, source)


def _full_sync_locked(db: Session, source: str) -> dict[str, Any]:
    """全量同步实现（调用方需已持有 _sync_lock）。"""
    global _empty_sync_streak
    started = _time.perf_counter()
    try:
        device, entries, error = _pull_all_pages(db, source)
        if error:
            state = _update_state(
                last_sync_at=beijing_now().isoformat(),
                last_error=error,
                mode="full",
                took_ms=round((_time.perf_counter() - started) * 1000, 2),
            )
            logger.warning("安博通白名单同步失败: %s", error)
            return {"success": False, "error": error, **state}

        # 设备理论上不会返回重复条目，这里保险去重（后者覆盖前者）
        deduped: dict[str, dict[str, Any]] = {}
        for entry in entries or []:
            deduped[entry["wlist"]] = entry
        entries = list(deduped.values())

        # 空结果保护：设备路径/权限异常或临时 404 会被容错成「空列表」，
        # 若本地已有数据，首轮空结果先保留旧数据并报错，连续两轮为空才接受清空，
        # 避免一次异常把本地 6 万条白名单与匹配索引全部抹掉。
        if not entries:
            previous_total = int(_get_state().get("total") or 0)
            if _cache is not None:
                previous_total = max(previous_total, len(_cache["entries"]))
            if previous_total == 0:
                try:
                    from app.models.anbotong_whitelist import AnbotongWhitelist
                    previous_total = int(db.query(AnbotongWhitelist).count() or 0)
                except Exception:  # noqa: BLE001
                    previous_total = 0
            if previous_total > 0 and _empty_sync_streak == 0:
                _empty_sync_streak += 1
                error = (
                    f"设备返回空白名单（本地保留 {previous_total} 条）；"
                    "若设备确已清空，下一轮全量同步将接受空结果"
                )
                state = _update_state(
                    last_sync_at=beijing_now().isoformat(),
                    last_error=error,
                    mode="full",
                    took_ms=round((_time.perf_counter() - started) * 1000, 2),
                )
                logger.warning("安博通白名单同步被空结果保护拦截: %s", error)
                return {"success": False, "error": error, **state}
        _empty_sync_streak = 0

        changed = _replace_rows(db, entries)
        _set_cache(entries)
        now = beijing_now().isoformat()
        took_ms = round((_time.perf_counter() - started) * 1000, 2)
        state = _update_state(
            last_sync_at=now,
            last_success_at=now,
            last_full_at=now,
            last_error=None,
            mode="full",
            total=len(entries),
            device=device,
            took_ms=took_ms,
        )
        return {"success": True, "changed": changed, "mode": "full", **state}
    except Exception as exc:  # noqa: BLE001
        try:
            db.rollback()
        except Exception:  # noqa: BLE001
            pass
        error = f"同步异常: {exc}"
        state = _update_state(
            last_sync_at=beijing_now().isoformat(),
            last_error=error,
            mode="full",
            took_ms=round((_time.perf_counter() - started) * 1000, 2),
        )
        logger.exception("安博通白名单同步异常")
        return {"success": False, "error": error, **state}


def _upsert_entries(db: Session, entries: list[dict[str, Any]], removed: list[str]) -> None:
    """增量写入/删除本地表（只动变化的行，避免尾页增量重写 6 万行）。"""
    from app.models.anbotong_whitelist import AnbotongWhitelist

    now = beijing_now()
    try:
        if removed:
            db.query(AnbotongWhitelist).filter(
                AnbotongWhitelist.wlist.in_(removed),
            ).delete(synchronize_session=False)
        for entry in entries:
            row = db.query(AnbotongWhitelist).filter(
                AnbotongWhitelist.wlist == entry["wlist"],
            ).first()
            if row is None:
                row = AnbotongWhitelist(wlist=entry["wlist"])
                db.add(row)
            row.age = entry["age"]
            row.enable = entry["enable"]
            row.reason = entry["reason"][:255]
            row.effect_time = entry["effectTime"][:32]
            row.policy_group_name = entry["policy_group_name"][:127]
            row.left_time = entry["leftTime"]
            row.state = entry["state"]
            row.hit_num = entry["hit_num"]
            row.node_id = entry["node_id"][:64]
            row.synced_at = now
        db.commit()
    except Exception:  # noqa: BLE001
        db.rollback()
        raise


def tail_delta_sync(db: Session, *, source: str = "delta") -> dict[str, Any]:
    """5 秒节拍增量同步：只拉取设备白名单末页，检测新增 / 尾部删除。

    设备列表按写入顺序追加，新白名单出现在最后一页：从本地已知总条数推算
    末页，拉取末页（若已满页则继续向后拉），与本地尾部做差集增量落库。
    若末页首条与本地同位置条目不一致（说明发生了中部删除/重排），立即转为
    全量同步校正，保证最终一致。手动增删已即时更新本地，不受此延迟影响。

    Returns:
        与 sync_now 相同结构的同步结果；失败保留旧数据。
    """
    global _synced_signature
    started = _time.perf_counter()
    with _sync_lock:
        cache = _cache
        known_total = int(_get_state().get("total") or 0)
        # 进程刚启动 / 尚无本地快照：直接全量
        if cache is None or known_total <= 0:
            return _full_sync_locked(db, source)
        from app.devices.anbotong import fetch_whitelist_page, find_anbotong_action

        device, action, err = find_anbotong_action(db, "whitelist_list")
        if err:
            state = _update_state(
                last_sync_at=beijing_now().isoformat(), last_error=err, mode="delta",
            )
            return {"success": False, "error": err, **state}
        start_page = max(1, (known_total + PAGE_SIZE - 1) // PAGE_SIZE)
        start_index = (start_page - 1) * PAGE_SIZE
        old_entries: list[dict[str, Any]] = cache["entries"]
        cached_at_page = old_entries[start_index]["wlist"] if start_index < len(old_entries) else None
        shifted = False
        tail_entries: list[dict[str, Any]] = []
        page = start_page
        try:
            while page <= MAX_PAGES:
                result, items, beyond_end = fetch_whitelist_page(
                    device, action, page, PAGE_SIZE,
                    timeout=PAGE_TIMEOUT_SECONDS, source=source,
                )
                if not result.get("success"):
                    error = result.get("error") or f"拉取第 {page} 页失败"
                    state = _update_state(
                        last_sync_at=beijing_now().isoformat(),
                        last_error=error, mode="delta",
                        took_ms=round((_time.perf_counter() - started) * 1000, 2),
                    )
                    return {"success": False, "error": error, **state}
                if page == start_page and cached_at_page and items:
                    first = _entry_from_device(items[0])
                    if first and first["wlist"] != cached_at_page:
                        shifted = True  # 中部增删导致顺序位移，需全量校正
                for item in items:
                    entry = _entry_from_device(item)
                    if entry is not None:
                        tail_entries.append(entry)
                if beyond_end or len(items) < PAGE_SIZE:
                    break
                page += 1
            if shifted:
                return _full_sync_locked(db, source)

            # 尾部替换：本地 [start_index:] 用设备末页数据替换
            old_tail = old_entries[start_index:]
            old_map = {e["wlist"]: e for e in old_tail}
            new_map = {e["wlist"]: e for e in tail_entries}
            # 只比较稳定字段：命中次数/剩余时长的变化不落库，避免每 5 秒
            # 大量逐行 UPDATE，并防止签名被置空导致每轮全量重写 6 万行
            changed_entries = [
                e for key, e in new_map.items()
                if key not in old_map or _stable_entry(old_map[key]) != _stable_entry(e)
            ]
            removed = [key for key in old_map if key not in new_map]
            # 仅当尾部内容真的变化时才查库 / 写库
            if changed_entries or removed:
                _upsert_entries(db, changed_entries, removed)
                # 本地表已偏离上一轮全量签名，下一轮全量重新校准并回写
                _synced_signature = None
            merged = old_entries[:start_index] + tail_entries
            _set_cache(merged)
            now = beijing_now().isoformat()
            state = _update_state(
                last_sync_at=now,
                last_success_at=now,
                last_delta_at=now,
                last_error=None,
                mode="delta",
                total=len(merged),
                device={
                    "id": device.id,
                    "name": device.name,
                    "vendor": device.vendor,
                    "api_url": device.api_url,
                },
                took_ms=round((_time.perf_counter() - started) * 1000, 2),
            )
            return {
                "success": True,
                "changed": bool(changed_entries or removed),
                "mode": "delta",
                **state,
            }
        except Exception as exc:  # noqa: BLE001
            try:
                db.rollback()
            except Exception:  # noqa: BLE001
                pass
            error = f"增量同步异常: {exc}"
            state = _update_state(
                last_sync_at=beijing_now().isoformat(),
                last_error=error, mode="delta",
                took_ms=round((_time.perf_counter() - started) * 1000, 2),
            )
            logger.exception("安博通白名单增量同步异常")
            return {"success": False, "error": error, **state}


def _match_range(target: str) -> Optional[tuple[Any, Any]]:
    """解析 CIDR / IP 范围（支持 10.0.0.1-10.0.0.20 与 10.0.0.1-20）。"""
    if "/" in target:
        try:
            network = ipaddress.ip_network(target, strict=False)
            return network.network_address, network.broadcast_address
        except ValueError:
            return None
    if target.count("-") != 1:
        return None
    left, right = (part.strip() for part in target.split("-", 1))
    try:
        start = ipaddress.ip_address(left)
        start_int = int(start)
        try:
            end = ipaddress.ip_address(right)
        except ValueError:
            # 末段简写：192.0.2.1-100
            if start.version == 4 and right.isdigit():
                prefix = left.rsplit(".", 1)[0]
                end = ipaddress.ip_address(f"{prefix}.{int(right)}")
            else:
                return None
        if start.version != end.version or int(end) < start_int:
            return None
        return start, end
    except ValueError:
        return None


def _match_one(target: str, index: dict[str, Any]) -> tuple[list[dict[str, Any]], Optional[str]]:
    """单目标匹配：返回 (命中条目列表, 匹配方式 exact/contained)。"""
    text = str(target or "").strip()
    if not text:
        return [], None

    # 1) 单 IP 精确匹配
    try:
        ip = ipaddress.ip_address(text)
    except ValueError:
        ip = None
    if ip is not None:
        entry = index["exact"].get(ip.compressed)
        if entry is not None and _is_active(entry):
            return [_entry_view(entry)], "exact"
        return [], None

    # 2) CIDR / 范围：白名单 IP 落在待封禁网段内即命中
    bounds = _match_range(text)
    if bounds is not None:
        start, end = bounds
        matched = [
            _entry_view(entry)
            for wip, entry in index["ips"]
            if wip.version == start.version and int(start) <= int(wip) <= int(end)
        ]
        return matched, ("contained" if matched else None)

    # 3) 域名精确匹配（小写）
    entry = index["exact"].get(normalize_wlist(text))
    if entry is not None and _is_active(entry):
        return [_entry_view(entry)], "exact"
    return [], None


def match_targets(db: Optional[Session], targets: list[str]) -> dict[str, Any]:
    """手动封禁白名单匹配：逐目标返回命中条目（只读内存索引，毫秒级）。"""
    started = _time.perf_counter()
    index = _ensure_cache(db)
    items: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in targets:
        target = str(raw or "").strip()
        if not target or target in seen:
            continue
        seen.add(target)
        entries, match_type = _match_one(target, index)
        entry_total = len(entries)
        items.append({
            "target": target,
            "matched": bool(entry_total),
            "match_type": match_type,
            "entry_total": entry_total,
            "truncated": entry_total > MAX_ENTRIES_PER_TARGET,
            "entries": entries[:MAX_ENTRIES_PER_TARGET],
        })
        if len(items) >= MAX_MATCH_TARGETS:
            break
    state = _get_state()
    return {
        "items": items,
        "matched": sum(1 for item in items if item["matched"]),
        "total": len(items),
        "took_ms": round((_time.perf_counter() - started) * 1000, 2),
        "synced_at": state.get("last_sync_at"),
        "last_success_at": state.get("last_success_at"),
        "last_error": state.get("last_error"),
        "total_whitelist": len(index["entries"]),
    }


def _sync_loop() -> None:
    """后台同步线程：5 秒节拍做尾页增量，每 60 秒（或首次启动）做一次全量校正。

    设备白名单实测 6 万+ 条，全量拉取约 20s，无法压进 5 秒节拍；而设备列表按
    写入顺序追加、新增条目出现在末页，因此 5 秒节拍只拉末页即可满足「新增 5s
    内可见」。全量校正用于补齐中部删除/重排，保证最终一致。
    """
    from app.database import SessionLocal

    logger.info(
        "安博通白名单同步线程启动（增量 %s 秒 / 全量 %s 秒）",
        SYNC_INTERVAL_SECONDS, FULL_SYNC_INTERVAL_SECONDS,
    )
    next_at = _time.monotonic()
    last_full = 0.0
    while True:
        db = SessionLocal()
        try:
            now = _time.monotonic()
            if last_full <= 0 or now - last_full >= FULL_SYNC_INTERVAL_SECONDS:
                result = sync_now(db, source="scheduler")
                last_full = _time.monotonic()
            else:
                result = tail_delta_sync(db, source="scheduler")
                # 增量检测到顺序位移时会内部转全量，重置计时避免立刻再次全量
                if result.get("mode") == "full":
                    last_full = _time.monotonic()
        except Exception:  # noqa: BLE001
            logger.exception("安博通白名单同步线程异常")
            _update_state(last_error="同步线程异常")
        finally:
            db.close()
        next_at += SYNC_INTERVAL_SECONDS
        sleep_for = next_at - _time.monotonic()
        if sleep_for > 0:
            _time.sleep(sleep_for)
        else:
            next_at = _time.monotonic()


def start_anbotong_whitelist_sync() -> None:
    """启动后台同步线程（幂等，由 FastAPI lifespan 调用一次）。"""
    global _started
    with _start_lock:
        if _started:
            return
        _started = True
    thread = threading.Thread(
        target=_sync_loop, name="anbotong-whitelist-sync", daemon=True,
    )
    thread.start()
