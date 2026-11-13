"""IP地址信息库 ORM 模型：5 库独立分表 + 导入批次表。

五个数据源（CSV 导入）各一张表，schema 按各自 CSV 列定义：

- ``cloud_cn``   中国大陆云服务IPv4合集（CIDR + 云服务商名称）
- ``geo_cn``     中国大陆APNIC分配及运营商地理信息（网段 + 运营商/省市/状态/分配日期）
- ``holder_cn``  中国大陆APNIC含注册持有者（14 列：持有者/运营商/地理/RIR 字段）
- ``overseas``   境外IPv4地址库（与 ``holder_cn`` 同构 14 列）
- ``hk_mo``      香港澳门IPv4地址库（与 ``holder_cn`` 同构 14 列）

通用列设计（与 ``asset_ip_intervals`` 同一套已验证模式，见 app/models/asset.py）：

- ``ip_start`` / ``ip_end``：网段整数区间，右开 [start, end)。IPv4 整数是无符号
  32 位（最大 4294967295），必须 BIGINT 而非 INT，否则 128.0.0.0 以上整数溢出。
- ``ip_range``：``int8range`` 生成列（GENERATED ALWAYS AS int8range(ip_start, ip_end)
  STORED），INSERT/UPDATE 不写该列，由 PG 自动维护；GiST 索引支撑点查 ``@>``
  与网段重叠 ``&&``，百万级行毫秒级命中。
- ``UNIQUE(ip_start, ip_end)``：upsert 冲突目标。用整数键而非 CIDR 文本——
  ``1.2.3.0/24`` 与 ``1.2.3.4/24`` 规范化后整数相同，天然去重。
- ``GIN trgm``：文本列 pg_trgm 包含匹配索引（关键词搜索运营商/持有者/国家/省市），
  依赖启动时 ``CREATE EXTENSION IF NOT EXISTS pg_trgm``（见 app/main.py）。
"""
from sqlalchemy import (
    BigInteger,
    Column,
    Computed,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
)
from sqlalchemy.dialects.postgresql import INT8RANGE

from app.core.timezone import beijing_now, to_beijing_iso
from app.database import Base


# ============================================================================
# 库定义：字段为 (attr, 中文标签, 类型规格) 三元组，规格为正整数=String(n)，"text"=Text
# ============================================================================

# holder_cn / overseas 共用的 14 列（不含通用网段列）
_HOLDER_FIELDS = [
    ("holder_name", "上级注册持有者名称", 256),
    ("holder_match_level", "持有者匹配层级", 64),
    ("holder_url", "持有者官方记录URL", "text"),
    ("isp", "运营商", 128),
    ("country_geo", "国家地区(GeoIP)", 128),
    ("province", "省州", 64),
    ("city", "城市", 64),
    ("rir_country", "RIR登记国家代码", 8),
    ("rir_registry", "RIR管理机构", 64),
    ("reg_status", "登记状态", 32),
    ("alloc_date", "分配日期", 32),
    ("geo_country_code", "GeoIP国家代码", 8),
    ("geo_status", "地理信息状态", 64),
]

# 关键词搜索的目标列（有意义业务文本）：排除 URL / 枚举状态 / 2-8 字符国家
# 代码 / 日期等噪音列，减少每行 strpos/ILIKE 求值开销（境外库 76 万行 × 列数）
_HOLDER_SEARCH = ["holder_name", "isp", "country_geo", "province", "city", "rir_registry"]

LIBRARY_DEFS = {
    "cloud_cn": {
        "label": "中国大陆云服务IPv4",
        "table": "ip_lib_cloud_cn",
        "fields": [
            ("cloud_provider", "云服务商", 128),
        ],
        "search_fields": ["cloud_provider"],
    },
    "geo_cn": {
        "label": "中国大陆APNIC运营商地理",
        "table": "ip_lib_geo_cn",
        "fields": [
            ("isp", "运营商", 128),
            ("province", "省份", 64),
            ("city", "城市", 64),
            ("geo_status", "地理信息状态", 64),
            ("apnic_status", "APNIC登记状态", 32),
            ("apnic_alloc_date", "APNIC分配日期", 32),
        ],
        # 表仅 8.2 万行，全部业务列纳入搜索成本可忽略
        "search_fields": ["isp", "province", "city", "geo_status", "apnic_status", "apnic_alloc_date"],
    },
    "holder_cn": {
        "label": "中国大陆APNIC注册持有者",
        "table": "ip_lib_holder_cn",
        "fields": list(_HOLDER_FIELDS),
        "search_fields": list(_HOLDER_SEARCH),
    },
    "overseas": {
        "label": "境外IPv4（全球减中国大陆）",
        "table": "ip_lib_overseas",
        "fields": list(_HOLDER_FIELDS),
        "search_fields": list(_HOLDER_SEARCH),
    },
    "hk_mo": {
        "label": "香港澳门IPv4（APNIC及运营商地理）",
        "table": "ip_lib_hk_mo",
        "fields": list(_HOLDER_FIELDS),
        "search_fields": list(_HOLDER_SEARCH),
    },
}


def _record_to_dict(self) -> dict:
    data = {
        "id": self.id,
        "library_type": self.library_type,
        "cidr": self.cidr,
        "ip_start": self.ip_start,
        "ip_end": self.ip_end,
        "batch_id": self.batch_id,
        "created_at": to_beijing_iso(self.created_at),
        "updated_at": to_beijing_iso(self.updated_at),
    }
    for attr, _label, _spec in self.fields:
        data[attr] = getattr(self, attr) or ""
    return data


def _build_library_model(class_name: str, library_type: str):
    """按 LIBRARY_DEFS 配置构建一个库分表模型（参考政务云动态建表模式）。"""
    meta = LIBRARY_DEFS[library_type]
    table = meta["table"]
    fields = meta["fields"]
    trgm_cols = [attr for attr, _label, _spec in fields]
    attrs = {
        "__tablename__": table,
        "__table_args__": (
            # upsert 冲突目标：整数键天然去重不同写法的同网段
            Index(f"uq_{table}_range", "ip_start", "ip_end", unique=True),
            # GiST 点查 @> / 重叠 &&（与 asset_ip_intervals 同模式）
            Index(f"idx_{table}_gist", "ip_range", postgresql_using="gist"),
            # 查询结果按网段排序
            Index(f"idx_{table}_start", "ip_start"),
            # 关键词包含匹配（pg_trgm，依赖 main.py 启动时建扩展）
            Index(
                f"idx_{table}_trgm",
                *trgm_cols,
                postgresql_using="gin",
                postgresql_ops={col: "gin_trgm_ops" for col in trgm_cols},
            ),
        ),
        "id": Column(Integer, primary_key=True, autoincrement=True),
        "cidr": Column(String(64), nullable=False),
        "ip_start": Column(BigInteger, nullable=False),
        "ip_end": Column(BigInteger, nullable=False),
        # 生成列：INSERT/UPDATE 不写，PG 自动维护；Computed 使 ORM 自动排除该列
        "ip_range": Column(
            INT8RANGE,
            Computed("int8range(ip_start, ip_end)", persisted=True),
            nullable=False,
        ),
        "batch_id": Column(
            Integer, ForeignKey("ip_library_import_batches.id"), nullable=True, index=True
        ),
        "created_at": Column(DateTime, default=beijing_now),
        "updated_at": Column(DateTime, default=beijing_now, onupdate=beijing_now),
        "library_type": library_type,
        "fields": fields,
        "to_dict": _record_to_dict,
    }
    for attr, _label, spec in fields:
        attrs[attr] = Column(Text) if spec == "text" else Column(String(spec))
    return type(class_name, (Base,), attrs)


IpLibCloudCn = _build_library_model("IpLibCloudCn", "cloud_cn")
IpLibGeoCn = _build_library_model("IpLibGeoCn", "geo_cn")
IpLibHolderCn = _build_library_model("IpLibHolderCn", "holder_cn")
IpLibOverseas = _build_library_model("IpLibOverseas", "overseas")
IpLibHkMo = _build_library_model("IpLibHkMo", "hk_mo")

LIBRARY_MODELS = {
    "cloud_cn": IpLibCloudCn,
    "geo_cn": IpLibGeoCn,
    "holder_cn": IpLibHolderCn,
    "overseas": IpLibOverseas,
    "hk_mo": IpLibHkMo,
}


class IpLibraryImportBatch(Base):
    """一次 CSV 导入批次（Celery 异步任务执行，状态由前端轮询）。"""

    __tablename__ = "ip_library_import_batches"

    id = Column(Integer, primary_key=True, autoincrement=True)
    library_type = Column(String(32), nullable=False, index=True)
    filename = Column(String(300), nullable=False, default="")
    file_size = Column(Integer, nullable=False, default=0)
    # 异步任务状态：pending 已派发 / running 执行中 / success 成功 / failed 失败
    status = Column(String(16), nullable=False, default="pending", index=True)
    # 执行阶段：parsing 解析中 / importing 入库中 / finalizing 收尾中
    phase = Column(String(16), nullable=False, default="")
    percent = Column(Integer, nullable=False, default=0)
    csv_rows = Column(Integer, nullable=False, default=0)
    unique_cidrs = Column(Integer, nullable=False, default=0)
    inserted = Column(Integer, nullable=False, default=0)
    updated = Column(Integer, nullable=False, default=0)
    deleted = Column(Integer, nullable=False, default=0)
    skipped = Column(Integer, nullable=False, default=0)
    live_count = Column(Integer, nullable=False, default=0)
    duration_ms = Column(Integer, nullable=False, default=0)
    import_mode = Column(String(16), nullable=False, default="full")
    note = Column(Text, default="")
    created_by = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=beijing_now, index=True)

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "library_type": self.library_type,
            "filename": self.filename,
            "file_size": self.file_size,
            "status": self.status,
            "phase": self.phase or "",
            "percent": self.percent,
            "csv_rows": self.csv_rows,
            "unique_cidrs": self.unique_cidrs,
            "inserted": self.inserted,
            "updated": self.updated,
            "deleted": self.deleted,
            "skipped": self.skipped,
            "live_count": self.live_count,
            "duration_ms": self.duration_ms,
            "import_mode": self.import_mode or "full",
            "note": self.note or "",
            "created_by": self.created_by,
            "created_at": to_beijing_iso(self.created_at),
        }

    def __repr__(self):
        return f"<IpLibraryImportBatch id={self.id} type={self.library_type} status={self.status}>"
