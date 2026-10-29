"""对话会话（会话列表）元数据模型。

``chat_messages`` 只保存消息本身（OpenAI 格式），无法表达「有哪些对话、
标题是什么、最后更新时间」。本表为每个 (agent_id, user_id, session_id)
保存一条会话元数据，使同一账号在任意浏览器登录后都能拉取到完整的会话列表。

字段说明：
- session_id: 前端生成的会话标识（与 chat_messages.session_id 一致）
- title: 由首条用户消息自动生成（服务端统一口径，跨端展示一致）
- created_at / updated_at: 会话首次创建 / 最后一条消息时间
- deleted_at: 软删除墓碑时间；非空表示该会话已被用户删除。
  保留记录而不是物理删除，是为了阻止另一浏览器仍在途的流式请求
  （落库时 upsert）把已删除会话重新“复活”。
"""
from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint

from app.core.timezone import beijing_now
from app.database import Base


class ChatSession(Base):
    __tablename__ = "chat_sessions"
    __table_args__ = (
        UniqueConstraint("agent_id", "user_id", "session_id", name="uq_chat_session_owner"),
        Index("ix_chat_sessions_agent_user", "agent_id", "user_id"),
        # 会话列表固定按 agent + user 过滤后按 updated_at 倒序，复合索引避免全表排序
        Index("ix_chat_sessions_agent_user_updated", "agent_id", "user_id", "updated_at"),
    )

    id = Column(Integer, primary_key=True, index=True)
    agent_id = Column(Integer, ForeignKey("agents.id"), nullable=False, index=True)
    user_id = Column(Integer, nullable=False, index=True)
    session_id = Column(String(64), nullable=False)
    title = Column(String(200), default="")
    created_at = Column(DateTime, default=beijing_now, nullable=False)
    updated_at = Column(DateTime, default=beijing_now, nullable=False, index=True)
    # 软删除墓碑：非空表示该会话已被删除（列表过滤 + upsert 拒绝复活）
    deleted_at = Column(DateTime, nullable=True, index=True)
