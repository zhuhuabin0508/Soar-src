"""ToolVersion 数据模型，用于工具版本快照与一键回滚。

每次编辑工具（``PUT /tools/{id}``）保存前，先把当前可编辑字段写入一条快照，
供「版本历史」查看与「回滚到历史版本」使用，避免误改/误删后无法恢复。
"""
from sqlalchemy import Column, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.dialects.postgresql import JSON

from app.database import Base


class ToolVersion(Base):
    """工具版本快照。

    ``snapshot`` 保存工具全部可编辑字段（name/description/parameters_schema/
    code/enabled/tool_type/category/tags/http_config），回滚时用 snapshot 覆盖
    当前工具对应字段，并自动同步改名引用（复用 _propagate_tool_rename）。
    """

    __tablename__ = "tool_versions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    tool_id = Column(Integer, ForeignKey("tools.id"), nullable=False, index=True)
    version = Column(Integer, nullable=False)
    snapshot = Column(JSON, nullable=False)
    created_by = Column(String(100), nullable=True)
    created_at = Column(DateTime, server_default=func.now())

    def __repr__(self) -> str:
        return f"<ToolVersion id={self.id} tool_id={self.tool_id} v{self.version}>"
