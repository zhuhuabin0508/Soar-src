"""LLMConfig 数据模型。

存储大模型供应商配置（API Key、Base URL、模型名等），
供 Agent 决策与节点执行时动态加载。可标记 ``is_default`` 作为默认模型。

扩展字段（v2）：
- ``health_status``：健康状态（healthy/unhealthy/untested），由测试接口更新
- ``last_test_at``：最近一次测试时间
- ``last_test_error``：最近一次测试失败原因（成功时为空）
- ``temperature`` / ``max_tokens`` / ``top_p`` / ``timeout`` / ``max_retries``：高级调用参数
- ``org_id`` / ``project_id``：部分 Provider（如 OpenAI 组织、Azure 项目）所需
- ``enabled``：启用/禁用开关
"""
from sqlalchemy import Boolean, Column, DateTime, Float, Integer, String, Text, func

from app.database import Base


class LLMConfig(Base):
    """LLM 配置模型。"""

    __tablename__ = "llm_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    provider = Column(String(64), nullable=False, default="anthropic")
    api_key = Column(String(512), nullable=False, default="")
    base_url = Column(String(512), nullable=False, default="")
    model_name = Column(String(128), nullable=False, default="")
    # 模型类型：chat（对话）/ embedding（向量化）/ vision（视觉）/ rerank（重排序）
    model_type = Column(String(32), nullable=False, default="chat")
    is_default = Column(Boolean, nullable=False, default=False)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    # ===== 健康状态 =====
    # healthy / unhealthy / untested（默认 untested，测试后更新）
    health_status = Column(String(32), nullable=False, default="untested")
    last_test_at = Column(DateTime, nullable=True)
    last_test_error = Column(Text, nullable=True)
    last_test_latency_ms = Column(Integer, nullable=True)

    # ===== 高级调用参数 =====
    temperature = Column(Float, nullable=True)
    max_tokens = Column(Integer, nullable=True)
    top_p = Column(Float, nullable=True)
    # 推理模型思考深度（reasoning effort）：minimal/low/medium/high，
    # None 表示不传（用模型默认）。仅 OpenAI 兼容推理模型支持，
    # 如 GLM-5.3 / o 系列 / DeepSeek-R1 等，经请求体 reasoning_effort 下发。
    reasoning_effort = Column(String(32), nullable=True)
    timeout = Column(Integer, nullable=True)  # 超时秒数
    max_retries = Column(Integer, nullable=True)
    org_id = Column(String(128), nullable=True)
    project_id = Column(String(128), nullable=True)

    # ===== 启用/禁用 =====
    enabled = Column(Boolean, nullable=False, default=True)

    def __repr__(self) -> str:
        return f"<LLMConfig id={self.id} name={self.name!r} provider={self.provider!r}>"
