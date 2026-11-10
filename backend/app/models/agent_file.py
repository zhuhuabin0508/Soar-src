"""智能体文件模型。

用于存储用户上传给智能体对话用的原始文件（不做 RAG 切片/向量化）。
智能体通过 ``read_document`` 工具按需读取文件内容。

与知识库文档（KnowledgeDocument）的区别：
- 知识库文档：切片 + 向量索引，走 RAG 检索
- 智能体文件：原样存储，智能体主动调用工具读取全部内容
"""
from sqlalchemy import Column, DateTime, Index, Integer, String, func

from app.database import Base


class AgentFile(Base):
    """智能体对话文件（不做 RAG，原样存储供工具读取）。

    归属隔离（2026-08-28 双层隔离）：
    - ``agent_id``：归属智能体（工具生成文件用 current_agent_id 标记）；
      NULL 表示公共文件（历史文件/未指定智能体），所有智能体可见。
    - ``created_by``：上传用户 id；NULL 表示非用户上传（工具生成且无用户上下文）。
    """

    __tablename__ = "agent_files"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # 原始文件名（用户上传时的名字，可能含中文/空格）
    original_name = Column(String(512), nullable=False)
    # 存储文件名（唯一，避免冲突；通常是 uuid + 原扩展名）
    stored_name = Column(String(512), nullable=False, unique=True)
    # 服务器上的相对路径（相对于 uploads 目录）
    file_path = Column(String(1024), nullable=False)
    # 文件类型（扩展名，小写）：xlsx / docx / pdf / csv / txt / json / md
    file_type = Column(String(32), nullable=False)
    # 文件大小（字节）
    file_size = Column(Integer, nullable=False, default=0)
    # 归属智能体 id（NULL=公共）；归属上传用户 id（NULL=非用户上传）
    agent_id = Column(Integer, nullable=True)
    created_by = Column(Integer, nullable=True)
    # 文件来源（2026-11-10）：upload=用户手动上传（展示在"已上传文件"列表）；
    # agent=对话过程中工具生成的交付/中间产物（只出现在消息气泡的下载卡片，
    # 不进入"已上传文件"列表）。历史数据默认视为 upload。
    source = Column(String(20), nullable=False, server_default="upload")
    created_at = Column(DateTime, server_default=func.now())

    __table_args__ = (
        Index("ix_agent_files_agent_id", "agent_id"),
        Index("ix_agent_files_created_by", "created_by"),
    )

    def __repr__(self) -> str:
        return f"<AgentFile id={self.id} name={self.original_name!r} type={self.file_type!r}>"
