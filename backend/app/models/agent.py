"""Agent 数据模型。

存储智能体配置：关联的 LLMConfig、系统提示词、采样参数、启用的工具与知识库列表。
``enabled_tools`` / ``enabled_kbs`` 为 JSON 数组，存放 Tool 名称与 KnowledgeBase id。
"""
from sqlalchemy import Boolean, Column, DateTime, Float, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSON

from app.database import Base


class Agent(Base):
    """智能体配置模型。"""

    __tablename__ = "agents"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    model_config_id = Column(Integer, ForeignKey("llm_configs.id"), nullable=True)
    system_prompt = Column(Text, nullable=True)
    temperature = Column(Float, nullable=False, default=0.7)
    max_tokens = Column(Integer, nullable=False, default=1024)
    # 深度思考参数（推理模型 reasoning effort）：minimal/low/medium/high。
    # None 表示未配置 → 跟随模型高级参数（llm_configs.reasoning_effort）；
    # 配置后优先生效，支持每个智能体独立差异化设置。
    reasoning_effort = Column(String(32), nullable=True)
    # 启用的工具名称列表（对应 Tool.name）
    enabled_tools = Column(JSON, nullable=True, default=list)
    # 启用的知识库 id 列表
    enabled_kbs = Column(JSON, nullable=True, default=list)
    # 启用的资产类型 code 列表（关联 AssetTypeTemplate.code，如 ["host_asset"]）
    # 非空时 Hermes 路径追加 search_assets 工具，LLM 按需检索关联类型的资产
    enabled_asset_types = Column(JSON, nullable=True, default=list)
    # 启用的技能 id 列表（注入到 system prompt，见 app/agent/prompt_assembler.py）
    enabled_skills = Column(JSON, nullable=True, default=list)
    enabled_workflows = Column(JSON, nullable=True, default=list)
    max_iterations = Column(Integer, nullable=False, default=5)
    # 创建者用户ID（资源级 owner 权限控制），null 表示历史数据/系统创建
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    # ===== 基础信息与形象 =====
    # 头像 URL（支持本地上传路径或 AI 生成 URL）
    avatar = Column(String(512), nullable=True)
    # 开场白：用户与 Agent 开启对话时自动发送的第一条消息
    greeting = Column(Text, nullable=True)
    # 开场引导问题（JSON 数组，如 ["你们的产品有哪些？", "价格是多少？"]）
    suggested_questions = Column(JSON, nullable=True, default=list)

    # ===== 模型与参数扩展 =====
    # 上下文轮数：Agent 能记住的前面对话轮数
    context_turns = Column(Integer, nullable=False, default=10)

    # ===== 记忆与高级机制 =====
    # 长期记忆开关
    enable_memory = Column(Boolean, nullable=False, default=False)
    # 语气风格：professional / humorous / casual / formal 等
    tone_style = Column(String(32), nullable=False, default="professional")
    # 自定义变量（JSON 对象，如 {"product_version": "v2.0"}），在提示词中用 {{key}} 引用
    variables = Column(JSON, nullable=True, default=dict)
    # 工具配置（JSON 对象，key=工具名，value={timeout, retry, require_confirm}）
    tool_configs = Column(JSON, nullable=True, default=dict)

    # ===== 引擎选择 =====
    # 执行引擎：固定 hermes（写入时强制，runtime 统一走 Hermes）
    engine = Column(String(16), nullable=False, default="hermes")
    output_mode = Column(String(32), nullable=False, default="chat")
    publish_status = Column(String(16), nullable=False, default="published")

    def __repr__(self) -> str:
        return f"<Agent id={self.id} name={self.name!r} engine={self.engine!r}>"
