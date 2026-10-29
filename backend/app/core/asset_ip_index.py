"""资产 IP 区间索引（search_assets 持久化索引，方案 B）。

背景：资产 ip 列存储 单IP / IP范围 / CIDR / 通配 / 多值 等格式，且一条资产
可含多个区间（98k 资产 ≈ 20 万区间）。旧实现每次查询全表扫描 + Python 解析
建内存索引（冷查询 ~2.2s，60s TTL 过期即重扫）。本模块把区间落到
``asset_ip_intervals``（IPv4，int8range + GiST）与 ``asset_ipv6_intervals``
（IPv6，numrange + GiST）两张表，查询变成索引查找（~1ms 级），且数据始终
实时（写入同一事务内同步，无缓存一致性问题）。

组成：
- IP 字段解析（从 agent.tool_builders 迁入，语义与导入校验对齐）
- SQLAlchemy ORM 事件（after_insert / after_update / after_delete）：
  资产写入时自动在同一事务内同步区间行，覆盖全部 ORM 写入路径
- 点查 / 网段重叠查询接口（search_assets 使用）
- 存量回填（启动迁移调用，用 system_configs 表的 marker 增量执行）
"""
import logging
import re

from sqlalchemy import event, func, text

logger = logging.getLogger(__name__)

_EMPTY_INTERVALS: list[tuple[int, int]] = []  # 无 IP 字段行的共享空区间（省内存）

# 与 IP 无关的更新（如标签/重要等级）不需要重算区间——检查这三个字段即可
_WATCHED_FIELDS = ("ip", "identifier", "extra_fields")


# ---------------------------------------------------------------------------
# IP 字段解析（原 app/agent/tool_builders.py 实现，语义不变 + IPv6/通配支持）
# ---------------------------------------------------------------------------

def _parse_any_ip(s: str):
    """解析单个 IPv4/IPv6 地址，失败返回 None。"""
    import ipaddress

    s = (s or "").strip()
    if not s:
        return None
    try:
        return ipaddress.ip_address(s)
    except (ipaddress.AddressValueError, ValueError):
        return None


def _parse_single_ip(s: str):
    """尝试解析为单个 IPv4 地址，失败返回 None（兼容既有调用方）。"""
    import ipaddress

    s = (s or "").strip()
    if not s:
        return None
    try:
        return ipaddress.IPv4Address(s)
    except (ipaddress.AddressValueError, ValueError):
        return None


def _complete_ip(s: str):
    """对不完整 IPv4 字符串补 .0 后解析（如 ``198.51.100`` → ``198.51.100.0``）。

    资产数据存在质量问题（如 ``198.51.100-198.51.100.254`` 起始 IP 缺最后一段），
    这里做防御性补全。
    """
    s = (s or "").strip()
    if not s:
        return None
    octets = s.split(".")
    while len(octets) < 4:
        octets.append("0")
    if len(octets) > 4:
        return None
    return _parse_single_ip(".".join(octets))


def _split_fallback_versioned(stored: str) -> list[tuple[int, int, int]]:
    """整串解析失败时按通用分隔符拆分后逐段解析（拆完仍单段则放弃）。"""
    parts = [p for p in re.split(r"[,;，；、\s]+", stored or "") if p]
    if len(parts) <= 1:
        return []
    out: list[tuple[int, int, int]] = []
    for p in parts:
        out.extend(_value_to_versioned_intervals(p))
    return out


def _split_fallback(stored: str) -> list[tuple[int, int]]:
    """兼容旧名：仅返回 IPv4 ``(start, end)`` 区间视图。

    ``app.agent.tool_builders`` 与既有测试仍按旧签名引用本函数。
    """
    return [
        (s, e)
        for version, s, e in _split_fallback_versioned(stored)
        if version == 4
    ]


def _value_to_versioned_intervals(stored: str) -> list[tuple[int, int, int]]:
    """把存储值解析为 ``(version, start, end)`` 区间列表（闭区间）。

    支持的格式：
    - 逗号/换行/空白/分号/顿号分隔多值
    - CIDR（IPv4/IPv6）: ``198.51.100.0/24`` / ``240e::/96``
    - 完整范围: ``113.108.60.224-113.108.60.254`` / ``2001:db8::1-2001:db8::ff``
    - 末段简写: ``61.144.224.185-187``（仅 IPv4）
    - 通配: ``10.0.0.*`` / ``10.0.*.*`` / ``10.*.*.*``
    - 不完整 IPv4（数据质量）: ``198.51.100-198.51.100.254``（起始缺段自动补 .0）
    - 单 IP（IPv4/IPv6）

    解析失败的部分返回空区间（不影响其余部分）。
    倒置范围（start > end）仅当两端同 /24（IPv4）时交换匹配；跨网段倒置
    （如 ``172.46.9.1-17.46.9.62``）视为脏数据丢弃，避免生成误命中全网的
    巨型区间。
    """
    import ipaddress

    stored = (stored or "").strip()
    if not stored:
        return []

    if "," in stored:
        out: list[tuple[int, int, int]] = []
        for part in stored.split(","):
            out.extend(_value_to_versioned_intervals(part))
        return out

    # 1. CIDR 格式 (198.51.100.0/24)
    if "/" in stored:
        try:
            net = ipaddress.ip_network(stored, strict=False)
            return [
                (net.version, int(net.network_address), int(net.broadcast_address))
            ]
        except (ipaddress.NetmaskValueError, ipaddress.AddressValueError, ValueError):
            # 整串不是合法 CIDR：可能是 "CIDR\n单IP" 混合串，落到兜底拆分
            return _split_fallback_versioned(stored)

    # 2. IP 范围格式 (start-end)
    if "-" in stored:
        parts = stored.split("-", 1)
        if len(parts) == 2:
            start_str = parts[0].strip()
            end_str = parts[1].strip()
            is_v6 = ":" in stored
            if is_v6:
                try:
                    start_ip = ipaddress.IPv6Address(start_str)
                    end_ip = ipaddress.IPv6Address(end_str)
                except ValueError:
                    return _split_fallback_versioned(stored)
                s, e = int(start_ip), int(end_ip)
                if s <= e:
                    return [(6, s, e)]
                return []  # IPv6 倒置范围几乎必为脏数据
            start_ip = _parse_single_ip(start_str) or _complete_ip(start_str)
            if start_ip is not None:
                # 末段简写：end_str 无点且为纯数字（如 "187"）时，替换 start 的最后一段
                # 例：61.144.224.185-187 → end = 61.144.224.187
                # 必须先于 _complete_ip 判断，否则 "187" 会被补成 187.0.0.0 产生超大范围
                if "." not in end_str and end_str.isdigit():
                    octets = str(start_ip).split(".")
                    last = int(end_str)
                    if 0 <= last <= 255:
                        octets[3] = str(last)
                        end_ip = _parse_single_ip(".".join(octets))
                    else:
                        end_ip = _complete_ip(end_str)
                else:
                    end_ip = _parse_single_ip(end_str) or _complete_ip(end_str)
                if end_ip is not None:
                    s, e = int(start_ip), int(end_ip)
                    if s <= e:
                        return [(4, s, e)]
                    # 倒置范围（start > end）：两端同 /24 视为笔误，交换后继续匹配
                    # （如 61.144.227.220-61.144.227.226）；跨网段倒置几乎必为脏数据
                    # （如 172.46.9.1-17.46.9.62，交换后会生成覆盖 17.x-172.x 的
                    # 巨型区间，导致任意 IP 误命中），直接丢弃。
                    if (s >> 8) == (e >> 8):
                        return [(4, e, s)]
                    return _split_fallback_versioned(stored)
        # 范围两端无法解析（如 "10.0.0.1\n10.0.0.2-5" 整串误入此分支）：
        # 落到兜底拆分逐段解析
        return _split_fallback_versioned(stored)

    # 3. 通配（10.0.0.* / 10.0.*.* / 10.*.*.*）
    if "*" in stored:
        from app.core.ip_validation import parse_ip_token

        try:
            iv = parse_ip_token(stored)
            return [(iv.version, iv.start, iv.end)]
        except ValueError:
            return []

    # 4. 单 IP 精确匹配（IPv4/IPv6）
    single = _parse_any_ip(stored)
    if single is not None:
        return [(single.version, int(single), int(single))]

    # 5. 兜底：换行/空白/分号/顿号分隔多值（Excel 单元格换行最常见），
    #    分隔符与导入校验、查询侧 _split_tokens 对齐
    return _split_fallback_versioned(stored)


def _value_to_intervals(stored: str) -> list[tuple[int, int]]:
    """IPv4 区间视图（兼容既有调用方/测试）：仅返回 version=4 的 (start, end)。"""
    return [
        (s, e)
        for version, s, e in _value_to_versioned_intervals(stored)
        if version == 4
    ]


def parse_stored_intervals(stored) -> list[tuple[int, int, int]]:
    """公开接口：资产存储值 → ``[(version, start, end), ...]``（宽容解析）。

    与写入侧解析同一实现；用于列表检索等需要同时匹配 IPv4/IPv6 的场景。
    """
    return _value_to_versioned_intervals(stored)


# extra_fields 无字段定义，只能按 key 猜测是否 IP 字段。这里用「词元级」判断
# （下划线/非字母数字切词），而不是子串 ``"ip" in key``：子串会把
# ``description`` / ``shipping`` / ``recipient`` 这类普通字段误当 IP 字段，
# 导致自由文本里出现的 IP 被建进索引、检索时误命中。
# 比写入侧 ``ip_validation.looks_like_ip_key`` 略宽（``ip_pool`` / ``ip_list``
# 这类以 IP 词开头的 key 也纳入索引），索引侧宽一点只影响召回，不误拦截写入。
_IP_KEY_TOKENS = frozenset({
    "ip", "ips", "cidr", "cidrs", "eip", "eips", "ipaddr", "ipaddress",
    "ipv4", "ipv6", "ip4", "ip6", "ipv4addr", "ipv4address",
    "ipv6addr", "ipv6address",
})


def _is_ip_extra_key(key) -> bool:
    """扩展字段 key 是否像 IP 字段（索引专用词元判断）。"""
    k = str(key or "").lower()
    if not k:
        return False
    return any(tok in _IP_KEY_TOKENS for tok in re.split(r"[^a-z0-9]+", k) if tok)


def _versioned_intervals_from_fields(
    ip, identifier, extra_fields
) -> list[tuple[int, int, int]]:
    """一行资产的所有 IP 字段解析为 ``(version, start, end)`` 区间并集。"""
    values = [ip or "", identifier or ""]
    extra = extra_fields if isinstance(extra_fields, dict) else {}
    for key, val in extra.items():
        if not val:
            continue
        if _is_ip_extra_key(key):
            values.append(str(val))
    out: list[tuple[int, int, int]] = []
    for v in values:
        if v:
            out.extend(_value_to_versioned_intervals(v))
    return out


def _intervals_from_fields(ip, identifier, extra_fields) -> list[tuple[int, int]]:
    """IPv4 区间视图（兼容既有调用方）。"""
    return [
        (s, e)
        for version, s, e in _versioned_intervals_from_fields(ip, identifier, extra_fields)
        if version == 4
    ]


# ---------------------------------------------------------------------------
# 写入同步（ORM 事件，同一事务内完成）
# ---------------------------------------------------------------------------

# 插入区间行的显式 SQL：int8range(start, end) 生成左闭右开 [start, end)，
# 即闭区间 [start, end-1]，所以传 end = 闭区间右端 + 1。
# 必须用 int8range 而非 int4range：IPv4 整数是无符号 32 位（最大 4294967295），
# 超过 int4 上限 2147483647（=127.255.255.255），128.0.0.0 起 IP 会溢出。
# （用 text() 显式 SQL 而非 executemany 参数传 SQL 表达式，兼容性最稳）


def _insert_sql() -> str:
    from app.models.asset import AssetIpInterval

    return (
        f"INSERT INTO {AssetIpInterval.__tablename__} (asset_id, ip_range) "
        "VALUES (:asset_id, int8range(CAST(:start AS BIGINT), CAST(:end AS BIGINT))) "
        # 幂等：唯一索引 (asset_id, ip_range) 冲突时跳过（ORM 事件与回填并发安全）
        "ON CONFLICT (asset_id, ip_range) DO NOTHING"
    )


def _insert_sql_v6() -> str:
    """IPv6 区间插入：128 位地址整数超出 BIGINT，用 NUMERIC + numrange。"""
    from app.models.asset import AssetIpv6Interval

    return (
        f"INSERT INTO {AssetIpv6Interval.__tablename__} (asset_id, ip_range) "
        "VALUES (:asset_id, numrange(CAST(:start AS NUMERIC), CAST(:end AS NUMERIC))) "
        "ON CONFLICT (asset_id, ip_range) DO NOTHING"
    )


def _dedupe(intervals: list[tuple[int, int, int]]) -> list[tuple[int, int, int]]:
    """区间去重（保序）。

    同一资产 ip 与 identifier 常存相同值，解析出重复区间；去重避免
    索引表无意义膨胀一倍（查询有 distinct 不影响正确性，但浪费空间）。
    """
    return list(dict.fromkeys(intervals))


def _delete_intervals(conn, asset_id: int) -> None:
    from app.models.asset import AssetIpInterval, AssetIpv6Interval

    for model in (AssetIpInterval, AssetIpv6Interval):
        tbl = model.__table__
        conn.execute(tbl.delete().where(tbl.c.asset_id == asset_id))


def _replace_intervals(
    conn, asset_id: int, intervals: list[tuple[int, int, int]]
) -> None:
    """在给定连接（资产写入事务内）重建该资产的区间行（先删后插，幂等）。"""
    _delete_intervals(conn, asset_id)
    unique = _dedupe(intervals)
    v4 = [(s, e) for version, s, e in unique if version == 4]
    v6 = [(s, e) for version, s, e in unique if version == 6]
    if v4:
        conn.execute(
            text(_insert_sql()),
            [{"asset_id": asset_id, "start": s, "end": e + 1} for s, e in v4],
        )
    if v6:
        conn.execute(
            text(_insert_sql_v6()),
            [{"asset_id": asset_id, "start": s, "end": e + 1} for s, e in v6],
        )


def _asset_intervals(target) -> list[tuple[int, int, int]]:
    return _versioned_intervals_from_fields(
        getattr(target, "ip", None),
        getattr(target, "identifier", None),
        getattr(target, "extra_fields", None),
    )


def _watched_changed(target) -> bool:
    """检查受监听字段（ip/identifier/extra_fields）是否有变化。

    未变化的更新（如标签/重要等级/状态）不需要重算区间。
    历史判断失败时保守返回 True（宁可重算也不漏同步）。
    """
    from sqlalchemy import inspect as sa_inspect

    try:
        attrs = sa_inspect(target).attrs
        for field in _WATCHED_FIELDS:
            attr = getattr(attrs, field, None)
            if attr is None:
                continue
            hist = attr.history
            if hist.added or hist.deleted:
                return True
    except Exception:  # noqa: BLE001
        return True
    return False


_registered = False


def _validate_asset_ip_fields(target, *, is_insert: bool) -> None:
    """写入前硬拦截资产 IP 字段（ORM 层最后一道防线）。

    API 层已做字段级校验，但智能体工具（沙箱内的 add_asset / update_asset）
    直接 ORM 写库、脚本/命令行写入也绕过了 API；此处保证任何 ORM 写入路径
    都不会落库非法 IP 文本。规则与 ``app.core.ip_validation`` 完全一致。

    - 新增：校验 ``ip``、IP/CIDR 类型标识与 extra_fields 中全部 IP 类 key
    - 更新：仅校验本次实际变更的 value（历史脏数据的其余字段仍可更新）
    """
    from sqlalchemy import inspect as sa_inspect

    from app.core.ip_validation import (
        looks_like_ip_key,
        validate_ip_expression,
    )

    try:
        attrs = sa_inspect(target).attrs
    except Exception:  # noqa: BLE001
        attrs = None

    def _changed(field: str) -> bool:
        if is_insert or attrs is None:
            return True
        attr = getattr(attrs, field, None)
        if attr is None:
            return True
        hist = attr.history
        return bool(hist.added or hist.deleted)

    if _changed("ip"):
        ip_value = getattr(target, "ip", None)
        if isinstance(ip_value, str) and ip_value.strip():
            target.ip = validate_ip_expression(ip_value, "IP")

    # identifier 在模板/兼容模式下也可能是 IP 标识（identifier_type=ip/cidr）：
    # 老环境旧版工具代码/脚本直接 ORM 写入时同样需要硬拦截
    id_type = str(getattr(target, "identifier_type", "") or "").strip().lower()
    if id_type in ("ip", "cidr") and (_changed("identifier") or _changed("identifier_type")):
        ident_value = getattr(target, "identifier", None)
        if isinstance(ident_value, str) and ident_value.strip():
            target.identifier = validate_ip_expression(ident_value, "标识")

    if not _changed("extra_fields"):
        return
    extra = getattr(target, "extra_fields", None)
    if not isinstance(extra, dict):
        return

    # 更新时只校验发生变化的 key：老数据的非法扩展字段不应阻断无关更新
    old_extra: dict = {}
    if not is_insert and attrs is not None:
        hist = attrs.extra_fields.history
        if hist.deleted:
            old = hist.deleted[0]
            if isinstance(old, dict):
                old_extra = old
    for key, val in extra.items():
        if key in old_extra and old_extra.get(key) == val:
            continue
        if isinstance(val, str) and val.strip() and looks_like_ip_key(key):
            extra[key] = validate_ip_expression(val, key)


def ensure_registered() -> None:
    """注册资产 ORM 事件（幂等；本模块导入时自动调用一次）。

    事件覆盖全部 ORM 写入路径（API 新增/更新/删除/导入/批量/合并等），
    区间行与资产写入在同一事务提交，保证索引与数据始终一致。

    已确认项目内资产写入全部为 ORM 模式（db.add / 属性赋值 / db.delete），
    无 bulk update / core insert 绕过事件；如有新增 bulk 写入路径需补
    ``bulk_insert_mappings`` / core insert 事件或改回 ORM 写入。
    """
    global _registered
    if _registered:
        return
    _registered = True

    from app.models.asset import Asset

    @event.listens_for(Asset, "before_insert")
    def _on_asset_before_insert(mapper, connection, target):
        # 硬拦截：非法 IP 文本直接抛 ValueError，事务回滚（消息即用户提示）
        _validate_asset_ip_fields(target, is_insert=True)

    @event.listens_for(Asset, "before_update")
    def _on_asset_before_update(mapper, connection, target):
        _validate_asset_ip_fields(target, is_insert=False)

    @event.listens_for(Asset, "after_insert")
    def _on_asset_insert(mapper, connection, target):
        intervals = _asset_intervals(target)
        if intervals:
            _replace_intervals(connection, target.id, intervals)

    @event.listens_for(Asset, "after_update")
    def _on_asset_update(mapper, connection, target):
        if _watched_changed(target):
            _replace_intervals(connection, target.id, _asset_intervals(target))

    @event.listens_for(Asset, "after_delete")
    def _on_asset_delete(mapper, connection, target):
        # FK ON DELETE CASCADE 也会清理；这里显式删一次兜底（且不依赖迁移建出的 FK）
        _delete_intervals(connection, target.id)


# ---------------------------------------------------------------------------
# 查询接口（search_assets 使用）
# ---------------------------------------------------------------------------

def query_asset_ids_by_ip(db, ti: int, limit: int = 500) -> list[int]:
    """IPv4 点查：哪些资产包含 IP ``ti``（GiST ``@>`` 索引查找）。

    ``ti`` 必须显式 CAST 为 BIGINT：绑定参数是裸整数字面量，小于 2^31 的
    值（< 128.0.0.0 的 IP）会被解析为 integer，而 ``int8range @> integer``
    无匹配操作符（``anyrange @> anyelement`` 需要 bigint）。
    """
    from sqlalchemy import BigInteger, cast

    from app.models.asset import AssetIpInterval

    rows = (
        db.query(AssetIpInterval.asset_id)
        .filter(AssetIpInterval.ip_range.op("@>")(cast(ti, BigInteger)))
        .distinct()
        .limit(limit)
        .all()
    )
    return [r[0] for r in rows]


def query_asset_ids_by_net(db, ns: int, ne: int, limit: int = 500) -> list[int]:
    """IPv4 网段重叠查：哪些资产区间与 [ns, ne] 有交集（GiST ``&&``）。"""
    from sqlalchemy import BigInteger, cast

    from app.models.asset import AssetIpInterval

    rows = (
        db.query(AssetIpInterval.asset_id)
        .filter(
            AssetIpInterval.ip_range.op("&&")(
                func.int8range(cast(ns, BigInteger), cast(ne + 1, BigInteger))
            )
        )
        .distinct()
        .limit(limit)
        .all()
    )
    return [r[0] for r in rows]


def query_asset_ids_by_ipv6(db, ti: int, limit: int = 500) -> list[int]:
    """IPv6 点查（GiST ``@>``）。128 位整数以 NUMERIC 传入，避免 BIGINT 溢出。"""
    from sqlalchemy import Numeric, cast

    from app.models.asset import AssetIpv6Interval

    rows = (
        db.query(AssetIpv6Interval.asset_id)
        .filter(AssetIpv6Interval.ip_range.op("@>")(cast(str(ti), Numeric)))
        .distinct()
        .limit(limit)
        .all()
    )
    return [r[0] for r in rows]


def query_asset_ids_by_netv6(db, ns: int, ne: int, limit: int = 500) -> list[int]:
    """IPv6 网段重叠查（GiST ``&&``）。"""
    from sqlalchemy import Numeric, cast

    from app.models.asset import AssetIpv6Interval

    rows = (
        db.query(AssetIpv6Interval.asset_id)
        .filter(
            AssetIpv6Interval.ip_range.op("&&")(
                func.numrange(cast(str(ns), Numeric), cast(str(ne + 1), Numeric))
            )
        )
        .distinct()
        .limit(limit)
        .all()
    )
    return [r[0] for r in rows]


# ---------------------------------------------------------------------------
# 存量回填（启动迁移调用）
# ---------------------------------------------------------------------------

_BACKFILL_MARKER_KEY = "asset_ip_index_backfill_max_id"
# 索引解析规则版本：扩展字段 key 识别由「子串 "ip"」改为「词元匹配」后递增。
# 启动时发现版本落后 → 清零回填水位、按新规则全量重建，避免旧规则建出的
# 错误区间行（如 description 文本里的 IP）残留在索引表里。
_BACKFILL_RULES_KEY = "asset_ip_index_rules_version"
_BACKFILL_RULES_VERSION = 2


def backfill_asset_ip_intervals(db, batch_size: int = 2000) -> int:
    """增量回填区间表：处理 id > marker 的资产（首次全量，之后通常 0 行）。

    - marker 存 system_configs 表；写入路径由 ORM 事件实时同步，这里只兜底
      首次上线与可能漏网的脚本插入（raw SQL 更新无法覆盖，属已知边界）。
    - 每批先删后插，保证幂等（重复回填同一资产不会产生重复区间行）。
    - 用「id > marker LIMIT batch_size」分页而非 ``yield_per``：yield_per 的
      服务端游标（named cursor）会因批间 ``commit`` 失效
      （psycopg2: named cursor isn't valid anymore）。
    - 解析规则升级（``_BACKFILL_RULES_VERSION`` 落后）时自动全量重建一次。
    - 全量回填 98k 资产约 3-5 秒，仅首次启动/规则升级时发生。
    """
    from app.models.asset import Asset
    from app.models.asset import AssetIpInterval, AssetIpv6Interval
    from app.models.system_config import SystemConfig

    ensure_registered()

    marker_row = (
        db.query(SystemConfig).filter(SystemConfig.key == _BACKFILL_MARKER_KEY).first()
    )
    marker = int(marker_row.value) if marker_row and marker_row.value else 0

    ver_row = (
        db.query(SystemConfig).filter(SystemConfig.key == _BACKFILL_RULES_KEY).first()
    )
    rules_ver = int(ver_row.value) if ver_row and str(ver_row.value).isdigit() else 0
    if rules_ver < _BACKFILL_RULES_VERSION:
        # 规则升级：水位清零，本次按新规则全量重建（每批先删后插，不会残留旧行）
        if marker:
            marker = 0
            if marker_row is not None:
                marker_row.value = "0"
                db.commit()

    total = 0
    while True:
        rows = (
            db.query(Asset.id, Asset.ip, Asset.identifier, Asset.extra_fields)
            .filter(Asset.id > marker)
            .order_by(Asset.id.asc())
            .limit(batch_size)
            .all()
        )
        if not rows:
            break
        # 解析本批区间（去重：ip 与 identifier 常存同值）
        prepared = [
            (
                r.id,
                _dedupe(_versioned_intervals_from_fields(r.ip, r.identifier, r.extra_fields)),
            )
            for r in rows
        ]
        # 先清后插：幂等（重复回填同一资产不会产生重复区间行）
        ids = [aid for aid, _ in prepared]
        for model in (AssetIpInterval, AssetIpv6Interval):
            db.execute(
                text(
                    f"DELETE FROM {model.__tablename__} WHERE asset_id = ANY(:ids)"
                ),
                {"ids": ids},
            )
        v4_rows = [
            {"asset_id": aid, "start": s, "end": e + 1}
            for aid, ivs in prepared
            for version, s, e in ivs
            if version == 4
        ]
        v6_rows = [
            {"asset_id": aid, "start": s, "end": e + 1}
            for aid, ivs in prepared
            for version, s, e in ivs
            if version == 6
        ]
        if v4_rows:
            db.execute(text(_insert_sql()), v4_rows)
        if v6_rows:
            db.execute(text(_insert_sql_v6()), v6_rows)
        total += len(prepared)
        marker = prepared[-1][0]
        # 首批创建 marker 行并复用同一 ORM 对象，后续批次只更新 value
        if marker_row is None:
            marker_row = SystemConfig(
                key=_BACKFILL_MARKER_KEY,
                value=str(marker),
                description="资产IP区间索引回填水位（asset id）",
            )
            db.add(marker_row)
        else:
            marker_row.value = str(marker)
        db.commit()

    if rules_ver < _BACKFILL_RULES_VERSION:
        # 全量重建完成，记录规则版本（下次启动恢复增量模式）
        if ver_row is None:
            db.add(SystemConfig(
                key=_BACKFILL_RULES_KEY,
                value=str(_BACKFILL_RULES_VERSION),
                description="资产IP区间索引解析规则版本",
            ))
        else:
            ver_row.value = str(_BACKFILL_RULES_VERSION)
        db.commit()

    if total:
        logger.info("资产IP区间索引回填: 新处理 %d 条资产（水位 asset id=%d）", total, marker)
    return total


# 导入即注册（任何进程只要用到本模块——查询/写入/迁移——事件即生效）
ensure_registered()
