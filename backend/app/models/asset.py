"""资产记录模型。

存储从知识库梳理或对话录入的资产信息，按 (agent_id, identifier) 去重。
供资产管理智能体的 discover_new_kbs / query_asset / add_asset / update_asset /
list_assets 工具使用，以及前端「资产管理」页面展示。

设计要点：
- ``agent_id`` 作用域：每个资产智能体独立维护各自资产表，互不污染。
- ``identifier`` + ``identifier_type``：由智能体灵活判断的唯一标识（IP/主机名/工号等）。
- ``extra_fields`` (JSON)：不同知识库字段不同时，非常规字段统一存这里。
- ``source``：kb_ingest（KB 梳理）/ manual（前端手动）/ agent_add（对话录入）。
- ``status``：资产生命周期状态（in_use/idle/repair/retired/lost）。
- ``tags``：多对多标签分组（AssetTag），支持按标签筛选和批量打标。
"""
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Index, Integer, String, Table, Text
from sqlalchemy.dialects.postgresql import JSON
from sqlalchemy.orm import relationship

from app.core.timezone import beijing_now
from app.database import Base


# 资产-标签多对多关联表（Base.metadata 注册后由 create_all 建表）
asset_tag_association = Table(
    "asset_tag_association",
    Base.metadata,
    Column("asset_id", Integer, ForeignKey("assets.id", ondelete="CASCADE"), primary_key=True),
    Column("tag_id", Integer, ForeignKey("asset_tags.id", ondelete="CASCADE"), primary_key=True),
    Index("idx_asset_tag_tag", "tag_id"),
)


class AssetTypeTemplate(Base):
    """资产类型模板：定义某一类资产的数据模型（字段 schema + 元信息）。

    每个模板描述一种资产类型（如主机资产、网段信息、出口地址），
    包含字段定义数组（fields JSON）、图标、配色、标识字段等元信息。
    预设模板（is_preset=True）不可删除，仅可编辑字段定义。
    用户可创建自定义模板扩展新的资产类型。

    fields 数组每项结构：
    {"key": "eip", "label": "EIP", "type": "text|number|date|select|textarea|ip|cidr",
     "mapped_to": "extra|standard:ip|standard:name|standard:department|...",
     "required": false, "options": [...], "placeholder": "", "default": "",
     "width": "half|full", "sort_order": 0, "show_in_list": true, "show_in_detail": true}
    """

    __tablename__ = "asset_type_templates"

    id = Column(Integer, primary_key=True, index=True)
    # 稳定机器码（host_asset / network_segment / egress_ip / 自定义）
    code = Column(String(64), unique=True, nullable=False, index=True)
    # 中文显示名
    name = Column(String(64), nullable=False)
    description = Column(Text, default="")
    # 前端 lucide 图标名
    icon = Column(String(32), default="server")
    # 主题色令牌（chart-1..5）
    color = Column(String(32), default="chart-1")
    # 该类型用作唯一标识的字段 key（必须在 fields 中存在）
    identifier_field = Column(String(64), default="ip")
    # 字段定义 JSON schema 数组
    fields = Column(JSON, nullable=False, default=list)
    # 是否系统预设（预设模板不可删除）
    is_preset = Column(Boolean, default=False)
    # 是否允许标识聚合：开启后同一标识（如网段）允许不同使用单位共存，
    # 列表中按标识分组展开显示。关闭时标识全局唯一。
    allow_aggregate = Column(Boolean, default=False)
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    def __repr__(self):
        return f"<AssetTypeTemplate id={self.id} code={self.code!r} name={self.name!r}>"


class AssetCustomField(Base):
    """资产自定义字段（全局共享，所有知识库可用）。

    用于扩展 Asset 模型的映射目标字段。标准字段（ip/name/department 等）是
    Asset 表的实际列，自定义字段的值存储在 Asset.extra_fields JSON 中。

    在知识库资产映射配置和资产管理页面均可增删，所有知识库共用同一套字段定义。
    """

    __tablename__ = "asset_custom_fields"

    id = Column(Integer, primary_key=True, index=True)
    # 字段键名（英文，用于 field_mapping 的 target 和 extra_fields 的 key）
    field_key = Column(String(64), unique=True, nullable=False)
    # 显示标签（中文，前端展示用）
    field_label = Column(String(128), nullable=False)
    # 字段类型：text/number/date/select
    field_type = Column(String(32), default="text")
    # select 类型的选项列表（["选项1", "选项2"]），其他类型为空
    options = Column(JSON, nullable=True, default=list)
    # 排序权重（越小越靠前）
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    def __repr__(self):
        return f"<AssetCustomField id={self.id} key={self.field_key!r} label={self.field_label!r}>"


class AssetTag(Base):
    """资产标签（全局共享，多对多分组）。

    用于给资产打标签分组（如「核心系统」「互联网暴露」「等保三级」），
    支持按标签筛选和批量打标。与部门（单值）互补，标签是多对多。
    """

    __tablename__ = "asset_tags"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(64), unique=True, nullable=False)
    # 标签颜色（tailwind 色名或 hex，前端配色用）
    color = Column(String(32), default="brand")
    # 标签分类（如"安全等级"/"业务线"/"合规"），便于分组展示
    category = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=beijing_now)

    # 反向关系：标签下的资产（通过关联表）
    assets = relationship("Asset", secondary=asset_tag_association, back_populates="tags")

    def __repr__(self):
        return f"<AssetTag id={self.id} name={self.name!r}>"


class Asset(Base):
    """资产记录。"""

    __tablename__ = "assets"

    id = Column(Integer, primary_key=True, index=True)
    # 作用域：资产归属于哪个智能体梳理（固定为 0，保留兼容）
    agent_id = Column(Integer, index=True, nullable=False)
    # 资产类型模板代码（外键到 AssetTypeTemplate.code，软外键）
    # 为空表示未分类资产（老数据兼容）
    type_code = Column(String(64), index=True, nullable=True)
    # 来源知识库（0 表示对话录入，无 KB 来源）
    kb_id = Column(Integer, index=True, nullable=False, default=0)
    # 冗余存储 KB 名称（KB 删除后仍可展示来源）
    kb_name = Column(String(255), default="")
    # 去重主标识：IP/资产名/主机名/工号等，由智能体灵活判定填入
    identifier = Column(String(255), index=True, nullable=False)
    # 标识类型：ip/hostname/asset_name/employee_id/mac/custom
    identifier_type = Column(String(32), default="custom")
    # 资产名称（展示用）
    name = Column(String(255), default="")
    # 资产类型：服务器/工作站/网络设备/应用/账号等
    asset_type = Column(String(64), default="")
    department = Column(String(128), default="")
    owner = Column(String(128), default="")
    location = Column(String(128), default="")
    # IP/网段表达式：支持多值（逗号分隔的多 IP 或多 CIDR 列表），128 不够用
    # （历史案例：129 字符多 CIDR 列表被截断成 128，末段 /24 变 /2 产生脏数据）
    ip = Column(String(256), default="")
    # 重要性：low/medium/high/critical
    criticality = Column(String(16), default="medium")
    # 生命周期状态：in_use(在用)/idle(闲置)/repair(维修)/retired(报废)/lost(丢失)
    status = Column(String(32), default="in_use", index=True)
    # 灵活字段：每个 KB 字段不同时，非常规字段塞这里
    extra_fields = Column(JSON, nullable=True, default=dict)
    # 来源：kb_ingest（KB 梳理）/ manual（前端手动）/ agent_add（对话录入）
    source = Column(String(20), default="agent_add")
    # LLM 提取时的原始 KB 片段（便于溯源审计）
    raw_content = Column(Text, default="")
    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    # 多对多标签关系
    tags = relationship("AssetTag", secondary=asset_tag_association, back_populates="assets", lazy="selectin")

    __table_args__ = (
        # 按 (type_code, identifier) 索引（非唯一）：聚合模式下同标识可有多条不同部门记录
        # 唯一性由应用层根据模板 allow_aggregate 配置控制：
        #   - allow_aggregate=False: (type_code, identifier) 唯一
        #   - allow_aggregate=True:  (type_code, identifier, department) 唯一
        Index("idx_assets_type_identifier", "type_code", "identifier"),
    )

    def __repr__(self):
        return f"<Asset id={self.id} agent_id={self.agent_id} identifier={self.identifier!r}>"


class AssetChange(Base):
    """资产变更历史：记录每次 create/update/delete/batch_update/import 的字段级 diff。

    用于资产详情页展示变更时间线，追溯旧值→新值、操作人、时间。
    记录失败不阻断主流程（在 API 层 try/except）。

    设计要点：
    - ``asset_id``：即使资产被删除，历史记录保留（物理删除不级联清理）。
    - ``changes`` (JSON)：``{field: {"old": v, "new": v}}``；create 时 old=None，
      delete 时 new=None，batch_update/import 时记录批量设置的快照字段。
    - ``summary``：人类可读一句话摘要（如「负责人: 张三 → 李四」），便于列表展示。
    """

    __tablename__ = "asset_changes"

    id = Column(Integer, primary_key=True, index=True)
    # 资产 ID（删除后保留，便于追溯已删除资产的变更）
    asset_id = Column(Integer, index=True, nullable=False)
    # 冗余 agent_id，便于按智能体筛选变更历史
    agent_id = Column(Integer, index=True, nullable=True)
    # 操作类型：create / update / delete / batch_update / import / merge
    action = Column(String(32), nullable=False, index=True)
    # 字段级 diff：{field: {"old": ..., "new": ...}}
    changes = Column(JSON, nullable=True, default=dict)
    # 人类可读摘要（如 "负责人: 张三 → 李四"）
    summary = Column(String(255), default="")
    # 操作者
    user_id = Column(Integer, nullable=True)
    username = Column(String(64), nullable=True)
    ip_address = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=beijing_now, index=True)

    def __repr__(self):
        return f"<AssetChange id={self.id} asset_id={self.asset_id} action={self.action!r}>"
