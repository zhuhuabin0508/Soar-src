"""交付物管理模型。

按服务类别（网络安全服务 / 云安全服务 / 新发漏洞服务等，可自定义）
归类管理交付文件（xlsx / xls / word / zip 等办公与压缩文档）。

- ``ServiceCategory``：服务类别（灵活创建，删除前须清空其下交付物）。
- ``Deliverable``：交付物文件记录（上传的文件落盘 backend/uploads/deliverables/）。
"""
from sqlalchemy import Column, DateTime, Integer, String, Text, func

from app.core.timezone import to_beijing_iso
from app.database import Base


class ServiceCategory(Base):
    """交付物服务类别（树形目录，最多 10 级）。

    字段说明：
    - ``name``：类别名称（同级唯一，由应用层校验）。
    - ``parent_id``：父类别 ID（根类别为 NULL）。
    - ``level``：层级（根=1，最深 10）。
    - ``description``：类别描述（该服务交付范围说明）。
    - ``sort_order``：展示排序（小的在前，默认按创建顺序）。
    """

    __tablename__ = "service_categories"

    MAX_LEVEL = 10

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False, index=True)
    parent_id = Column(Integer, nullable=True, index=True)
    level = Column(Integer, nullable=False, default=1)
    description = Column(String(500), nullable=True)
    sort_order = Column(Integer, nullable=False, default=0)
    created_by = Column(Integer, nullable=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def to_dict(
        self,
        deliverable_count: int | None = None,
        descendant_count: int | None = None,
    ) -> dict:
        """序列化；``deliverable_count`` / ``descendant_count`` 由 API 聚合后传入。"""
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        if deliverable_count is not None:
            result["deliverable_count"] = deliverable_count
        if descendant_count is not None:
            result["descendant_count"] = descendant_count
        return result

    def __repr__(self) -> str:
        return f"<ServiceCategory id={self.id} level={self.level} name={self.name!r}>"


class Deliverable(Base):
    """交付物文件记录。

    字段说明：
    - ``category_id``：所属服务类别 ID。
    - ``name``：交付物名称（如「6 月巡检报告」）。
    - ``version``：版本号（如 v1.0 / 2024-06，自由文本）。
    - ``filename``：上传时的原始文件名（下载时还原）。
    - ``stored_name``：落盘文件名（uuid + 扩展名，避免重名/路径穿越）。
    - ``file_size``：文件字节数。
    - ``file_ext``：小写扩展名（白名单校验后的值）。
    - ``content_hash``：文件内容 SHA-256（上传判重：同目录同内容自动跳过）。
    """

    __tablename__ = "deliverables"

    id = Column(Integer, primary_key=True, autoincrement=True)
    category_id = Column(Integer, nullable=False, index=True)
    name = Column(String(200), nullable=False)
    version = Column(String(50), nullable=True)
    description = Column(Text, nullable=True)
    filename = Column(String(300), nullable=False)
    stored_name = Column(String(100), nullable=False)
    file_size = Column(Integer, nullable=False, default=0)
    file_ext = Column(String(10), nullable=False)
    content_hash = Column(String(64), nullable=True)
    created_by = Column(Integer, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), index=True)
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def to_dict(self, creator_name: str | None = None) -> dict:
        """序列化；``creator_name`` 由 API 关联查询后传入。"""
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        if creator_name is not None:
            result["creator_name"] = creator_name
        return result

    def __repr__(self) -> str:
        return (
            f"<Deliverable id={self.id} category_id={self.category_id} "
            f"name={self.name!r} filename={self.filename!r}>"
        )
