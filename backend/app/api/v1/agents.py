"""智能体 CRUD 与测试路由。"""
import json
import logging
import os
import re
from app.core.timezone import beijing_now

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Any, Optional

from app.database import get_db
from app.dependencies import check_resource_ownership, compute_can_edit_ids, get_current_user, require_permission, resource_can_edit
from app.models.agent import Agent
from app.models.execution import Execution
from app.models.user import User
from app.schemas.common import paginate, to_dict, to_dict_list
from app.agent.prompt_assembler import assemble_system_prompt

logger = logging.getLogger(__name__)


def _create_llm(agent, db, override: "Optional[ChatOverride]" = None):
    """根据智能体配置创建 LLM 实例（ChatOpenAI / ChatAnthropic）。

    支持会话级参数覆盖：override 非 None 时按字段独立覆盖 agent 配置，
    None 字段不覆盖（按需启用模式，避免覆盖模型默认值）。

    返回 (llm, config_info) 或 (None, error_msg)。
    """
    from app.agent.decision import _load_llm_config
    from app.core.llm_helper import create_llm_from_config

    # 解析 effective model_config_id（override 优先）
    eff_model_config_id = (
        override.model_config_id
        if override and override.model_config_id is not None
        else agent.model_config_id
    )
    # 解析 effective temperature / max_tokens
    eff_temp = (
        override.temperature
        if override and override.temperature is not None
        else (agent.temperature if agent.temperature is not None else 0.7)
    )
    eff_max_tokens = (
        override.max_tokens
        if override and override.max_tokens is not None
        else (agent.max_tokens or 1024)
    )
    # 扩展参数：仅 override 非 None 时透传（None 即不传，使用模型默认）
    extra_kwargs: dict = {}
    if override:
        for k in ("top_p", "frequency_penalty", "presence_penalty", "seed"):
            v = getattr(override, k, None)
            if v is not None:
                extra_kwargs[k] = v

    llm_config = _load_llm_config(db, eff_model_config_id)
    if llm_config is not None and (llm_config.api_key or llm_config.base_url):
        try:
            llm, info = create_llm_from_config(
                llm_config,
                temperature=eff_temp,
                max_tokens=eff_max_tokens,
                **extra_kwargs,
            )
            return llm, info
        except ValueError as exc:
            return None, str(exc)
        except Exception as exc:
            logger.exception("创建 LLM 实例失败: %s", exc)
            return None, f"创建 LLM 实例失败: {exc}"

    # 尝试环境变量（Anthropic）
    from app.config import settings
    api_key = getattr(settings, "ANTHROPIC_API_KEY", "") or ""
    if not api_key:
        return None, "未配置 LLM API Key，请在「模型设置」中配置"

    try:
        from langchain_anthropic import ChatAnthropic
        # 环境变量回退路径：仅支持 top_p（Anthropic 限制），其余扩展参数忽略并告警
        env_kwargs: dict = {
            "model": "claude-3-5-haiku-20241022",
            "api_key": api_key,
            "temperature": eff_temp,
            "max_tokens": eff_max_tokens,
        }
        if "top_p" in extra_kwargs:
            env_kwargs["top_p"] = extra_kwargs["top_p"]
        for k in ("frequency_penalty", "presence_penalty", "seed"):
            if k in extra_kwargs:
                logger.warning("Anthropic 不支持 %s，已忽略", k)
        llm = ChatAnthropic(**env_kwargs)
        return llm, {"provider": "anthropic", "model": "(env)"}
    except Exception as exc:
        logger.exception("创建 LLM 实例失败: %s", exc)
        return None, f"创建 LLM 实例失败: {exc}"

router = APIRouter(
    prefix="/agents",
    tags=["agents"],
    dependencies=[Depends(get_current_user)],
)


def _sanitize_enabled_kbs(db: Session, agent: Agent) -> bool:
    """剔除智能体 enabled_kbs 中已不存在的知识库 ID，并持久化清理。

    场景：用户手动删除知识库时若清理逻辑未覆盖（如历史数据残留），
    enabled_kbs 可能含已不存在的 KB id（如已删除的 KB5），导致前端
    仍展示被删知识库。本函数在读取智能体时防御性过滤，保证配置与
    数据库一致。

    Returns:
        True 表示发生了清理并已提交。
    """
    kbs = list(agent.enabled_kbs or [])
    if not kbs:
        return False
    from app.models.knowledge_base import KnowledgeBase

    # db.query(KnowledgeBase.id).all() 返回 Row 对象列表，取首列
    existing_ids = {row[0] for row in db.query(KnowledgeBase.id).all()}
    new_kbs = [k for k in kbs if k in existing_ids]
    if len(new_kbs) != len(kbs):
        agent.enabled_kbs = new_kbs
        db.commit()
        removed = [k for k in kbs if k not in existing_ids]
        logger.warning(
            "智能体 %s 的 enabled_kbs 含无效知识库引用 %s，已自动清理",
            agent.id, removed,
        )
        return True
    return False


class AgentBase(BaseModel):
    """智能体请求体。"""

    name: str = Field(..., description="智能体名称")
    description: str = Field("", description="智能体描述")
    model_config_id: int | None = Field(None, description="关联的 LLMConfig id")
    system_prompt: str | None = Field(None, description="系统提示词")
    temperature: float = Field(0.7, description="采样温度")
    max_tokens: int = Field(1024, description="最大生成 token 数")
    enabled_tools: list[str] | None = Field(None, description="启用的工具名称列表")
    enabled_kbs: list[int] | None = Field(None, description="启用的知识库 id 列表")
    enabled_asset_types: list[str] | None = Field(None, description="启用的资产类型 code 列表")
    # 启用的技能 id 列表（纯文本指令，注入 system prompt，见 prompt_assembler.py）
    enabled_skills: list[int] | None = Field(None, description="启用的技能 id 列表（注入 system prompt）")
    enabled_workflows: list[int] | None = Field(None, description="作为工具绑定的工作流 id 列表")
    max_iterations: int = Field(5, description="最大迭代轮数")
    # 基础信息与形象
    avatar: str | None = Field(None, description="头像 URL")
    greeting: str | None = Field(None, description="开场白")
    suggested_questions: list[str] | None = Field(None, description="开场引导问题")
    # 模型参数扩展
    context_turns: int = Field(10, description="上下文轮数")
    # 记忆与高级机制
    enable_memory: bool = Field(False, description="长期记忆开关")
    tone_style: str = Field("professional", description="语气风格")
    variables: dict | None = Field(None, description="自定义变量")
    tool_configs: dict | None = Field(None, description="工具配置（key=工具名, value={timeout, retry, require_confirm}）")
    engine: str = Field("hermes", description="执行引擎：hermes（唯一引擎，传其他值将被忽略）")
    output_mode: str | None = Field(None, description="chat / soc_decision / ban_risk_analyze，不传则创建为 chat、更新保持原值")
    publish_status: str | None = Field(None, description="draft / published，创建默认草稿，更新未传则保持原值")


AGENT_DSL_VERSION = "soar/agent-dsl/1"


def _resolve_publish_status(agent: Agent) -> str:
    col = getattr(agent, "publish_status", None)
    if col in ("draft", "published"):
        vars_ = agent.variables or {}
        if vars_.get("_publish_status") == "draft":
            return "draft"
        name = agent.name or ""
        desc = agent.description or ""
        if name.startswith("（草稿）") or str(desc).startswith("[草稿]"):
            return "draft"
        return col
    vars_ = agent.variables or {}
    if vars_.get("_publish_status") == "draft":
        return "draft"
    name = agent.name or ""
    desc = agent.description or ""
    if name.startswith("（草稿）") or str(desc).startswith("[草稿]"):
        return "draft"
    return "published"


def _normalize_output_mode(raw: str | None, *, default: str) -> str:
    if raw in ("chat", "soc_decision", "ban_risk_analyze"):
        return raw
    if default in ("chat", "soc_decision", "ban_risk_analyze"):
        return default
    return "chat"


# 会话 ID 仅允许常见安全字符：前端 crypto.randomUUID 生成，外部调用方也可能自定义
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")


def _normalize_session_id(session_id: str | None) -> str:
    sid = (session_id or "default").strip() or "default"
    if not _SESSION_ID_RE.fullmatch(sid):
        raise HTTPException(
            status_code=400,
            detail="session_id 仅允许 1-64 位字母、数字、点、下划线、冒号或短横线",
        )
    return sid


def _mark_chat_sessions_deleted(
    db,
    agent_id: int,
    user_id: int,
    session_id: str | None = None,
    now=None,
) -> None:
    """给会话写软删除墓碑（不物理删除 chat_sessions），供后续请求识别“已删除”。

    两条 SQL：
    1. 已有会话元数据置 ``deleted_at``；
    2. 仅有消息、尚无元数据的旧会话用 ``INSERT ... SELECT ... ON CONFLICT`` 补墓碑
       （并发下已存在则直接更新为删除态）。

    墓碑用于阻止另一浏览器在途的流式请求在删除之后把会话重新写入/复活。
    """
    from sqlalchemy import func, literal, select as sa_select, update as sa_update
    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.chat_message import ChatMessage
    from app.models.chat_session import ChatSession

    moment = now or beijing_now()
    session_filters = [
        ChatSession.agent_id == agent_id,
        ChatSession.user_id == user_id,
    ]
    message_filters = [
        ChatMessage.agent_id == agent_id,
        ChatMessage.user_id == user_id,
    ]
    if session_id is not None:
        session_filters.append(ChatSession.session_id == session_id)
        message_filters.append(ChatMessage.session_id == session_id)

    db.execute(
        sa_update(ChatSession)
        .where(*session_filters, ChatSession.deleted_at.is_(None))
        .values(deleted_at=moment)
    )
    source = (
        sa_select(
            ChatMessage.agent_id,
            ChatMessage.user_id,
            ChatMessage.session_id,
            literal("").label("title"),
            func.min(ChatMessage.created_at).label("created_at"),
            func.max(ChatMessage.created_at).label("updated_at"),
            literal(moment).label("deleted_at"),
        )
        .where(*message_filters)
        .group_by(ChatMessage.agent_id, ChatMessage.user_id, ChatMessage.session_id)
    )
    db.execute(
        pg_insert(ChatSession)
        .from_select(
            [
                "agent_id",
                "user_id",
                "session_id",
                "title",
                "created_at",
                "updated_at",
                "deleted_at",
            ],
            source,
        )
        .on_conflict_do_update(
            index_elements=["agent_id", "user_id", "session_id"],
            set_={"deleted_at": moment},
        )
    )


def _incoming_publish_status(body: AgentBase, *, default: str) -> str:
    raw = body.publish_status
    if raw in ("draft", "published"):
        return raw
    vars_ = body.variables or {}
    if vars_.get("_publish_status") in ("draft", "published"):
        return vars_["_publish_status"]
    name = body.name or ""
    desc = body.description or ""
    if name.startswith("（草稿）") or str(desc).startswith("[草稿]"):
        return "draft"
    return default


def _agent_item(agent: Agent, can_edit: bool) -> dict:
    data = to_dict(agent)
    data["publish_status"] = _resolve_publish_status(agent)
    data["can_edit"] = can_edit
    return data


def _strip_draft_marks(agent: Agent) -> None:
    name = agent.name or ""
    if name.startswith("（草稿）"):
        agent.name = name[4:].strip() or name
    desc = agent.description or ""
    if str(desc).startswith("[草稿]"):
        agent.description = str(desc)[4:].lstrip()
    vars_ = dict(agent.variables or {})
    vars_["_publish_status"] = "published"
    agent.variables = vars_


def _require_published(agent: Agent) -> None:
    if _resolve_publish_status(agent) != "published":
        raise HTTPException(status_code=400, detail="该智能体尚未发布，无法在对话中使用")


def _agent_to_dsl(agent: Agent) -> dict[str, Any]:
    """将 Agent ORM 转为可版本化的 DSL 文档（JSON/YAML 通用结构）。"""
    variables = dict(agent.variables or {})
    for k in ("_publish_status",):
        variables.pop(k, None)
    return {
        "api_version": AGENT_DSL_VERSION,
        "name": agent.name,
        "description": agent.description or "",
        "model_config_id": agent.model_config_id,
        "system_prompt": agent.system_prompt or "",
        "temperature": agent.temperature,
        "max_tokens": agent.max_tokens,
        "enabled_tools": agent.enabled_tools or [],
        "enabled_kbs": agent.enabled_kbs or [],
        "enabled_asset_types": agent.enabled_asset_types or [],
        "enabled_skills": agent.enabled_skills or [],
        "enabled_workflows": agent.enabled_workflows or [],
        "max_iterations": agent.max_iterations,
        "avatar": agent.avatar,
        "greeting": agent.greeting,
        "suggested_questions": agent.suggested_questions or [],
        "context_turns": agent.context_turns,
        "enable_memory": agent.enable_memory,
        "tone_style": agent.tone_style,
        "variables": variables,
        "tool_configs": agent.tool_configs or {},
        "engine": agent.engine or "hermes",
        "output_mode": getattr(agent, "output_mode", None) or "chat",
        "template_meta": {
            "is_public_template": bool((agent.variables or {}).get("is_public_template")),
            "scenario": (agent.variables or {}).get("template_scenario") or "",
            "tags": (agent.variables or {}).get("template_tags") or [],
        },
    }


def _dsl_to_agent_base(dsl: dict[str, Any]) -> AgentBase:
    """DSL 文档 → AgentBase（创建/更新用）。"""
    if not isinstance(dsl, dict):
        raise HTTPException(status_code=400, detail="dsl 必须为对象")
    ver = dsl.get("api_version")
    if ver and ver != AGENT_DSL_VERSION:
        logger.warning("DSL 版本不匹配: %s (期望 %s)", ver, AGENT_DSL_VERSION)
    variables = dict(dsl.get("variables") or {})
    meta = dsl.get("template_meta") or {}
    if meta.get("is_public_template"):
        variables["is_public_template"] = True
    if meta.get("scenario"):
        variables["template_scenario"] = meta["scenario"]
    if meta.get("tags"):
        variables["template_tags"] = meta["tags"]
    return AgentBase(
        name=dsl.get("name") or "未命名智能体",
        description=dsl.get("description") or "",
        model_config_id=dsl.get("model_config_id"),
        system_prompt=dsl.get("system_prompt"),
        temperature=float(dsl.get("temperature", 0.7)),
        max_tokens=int(dsl.get("max_tokens", 1024)),
        enabled_tools=dsl.get("enabled_tools") or [],
        enabled_kbs=dsl.get("enabled_kbs") or [],
        enabled_asset_types=dsl.get("enabled_asset_types") or [],
        enabled_skills=dsl.get("enabled_skills") or [],
        enabled_workflows=dsl.get("enabled_workflows") or [],
        max_iterations=int(dsl.get("max_iterations", 5)),
        avatar=dsl.get("avatar"),
        greeting=dsl.get("greeting"),
        suggested_questions=dsl.get("suggested_questions") or [],
        context_turns=int(dsl.get("context_turns", 10)),
        enable_memory=bool(dsl.get("enable_memory", False)),
        tone_style=dsl.get("tone_style") or "professional",
        variables=variables,
        tool_configs=dsl.get("tool_configs") or {},
        engine="hermes",
        output_mode=dsl.get("output_mode") or "chat",
    )


class AgentFromDslRequest(BaseModel):
    """从 DSL 创建智能体。"""

    dsl: dict[str, Any] = Field(..., description="智能体 DSL 文档（api_version: soar/agent-dsl/1）")


class PublishTemplateRequest(BaseModel):
    """发布为团队模板（写入 variables 标记，供模板市场展示）。"""

    scenario: str = Field("", description="适用场景说明")
    tags: list[str] = Field(default_factory=list, description="场景标签")


class ChatOverride(BaseModel):
    """会话级参数覆盖（仅本次请求生效，不修改 Agent 配置）。

    每个字段独立可选：None 表示不覆盖，使用 Agent 自身配置。
    前端按需启用模式：只有用户开启的参数才写入此对象。
    借鉴 new-api Playground 的设计：避免覆盖模型默认值。
    """

    model_config_id: Optional[int] = Field(None, description="覆盖模型配置 id")
    system_prompt: Optional[str] = Field(None, description="覆盖系统提示词")
    temperature: Optional[float] = Field(None, description="覆盖采样温度")
    top_p: Optional[float] = Field(None, description="覆盖核采样概率")
    max_tokens: Optional[int] = Field(None, description="覆盖最大生成 token 数")
    frequency_penalty: Optional[float] = Field(None, description="覆盖频率惩罚")
    presence_penalty: Optional[float] = Field(None, description="覆盖存在惩罚")
    seed: Optional[int] = Field(None, description="覆盖随机种子")


class AgentTestRequest(BaseModel):
    """智能体测试请求体。"""

    input: str = Field(..., description="测试输入，可为 JSON 字符串或自由文本")
    # 会话 ID：Hermes 引擎按 (agent_id, session_id) 持久化对话历史，
    # 多轮对话（如封禁确认流程）下，下一轮请求加载同 session 的历史注入 LLM 上下文。
    # 前端为每个对话生成 UUID；缺省 "default" 兼容旧调用。
    session_id: str = Field("default", description="会话 ID（多轮对话上下文持久化键）")
    # 会话级参数覆盖：None 时走 Agent 配置（向后兼容）；非 None 时按字段独立覆盖
    override: Optional[ChatOverride] = Field(None, description="会话级参数覆盖（仅本次请求生效）")
    channel: str | None = Field(None, description="conversation 表示正式对话，草稿不可用；test 为编辑器调试")


class ResumeRequest(BaseModel):
    """恢复中断技能的请求体。"""

    decision: str = Field("approve", description="审批决定：approve | reject")


@router.get("")
def list_agents(
    usable: bool = Query(False, description="仅返回已发布、可在对话中使用的智能体"),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    logger.info("查询智能体列表 usable=%s", usable)
    agents = db.query(Agent).order_by(Agent.created_at.desc()).all()
    for agent in agents:
        _sanitize_enabled_kbs(db, agent)
    if usable:
        agents = [a for a in agents if _resolve_publish_status(a) == "published"]
    shared_ids = compute_can_edit_ids(db, current_user, "agent", [a.id for a in agents])
    return [
        _agent_item(agent, resource_can_edit(current_user, db, agent, shared_ids))
        for agent in agents
    ]


@router.get("/templates")
def list_public_agent_templates(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """列出已发布为团队模板的智能体（variables.is_public_template=true）。"""
    rows = db.query(Agent).order_by(Agent.updated_at.desc()).all()
    out = []
    for agent in rows:
        vars_ = agent.variables or {}
        if not vars_.get("is_public_template"):
            continue
        if _resolve_publish_status(agent) != "published":
            continue
        item = to_dict(agent)
        item["template_scenario"] = vars_.get("template_scenario") or ""
        item["template_tags"] = vars_.get("template_tags") or []
        shared_ids = compute_can_edit_ids(db, current_user, "agent", [agent.id])
        item["can_edit"] = resource_can_edit(current_user, db, agent, shared_ids)
        out.append(item)
    return out


@router.post("/from-dsl", status_code=201)
def create_agent_from_dsl(
    body: AgentFromDslRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """从 DSL 文档创建智能体（开发者入口）。"""
    base = _dsl_to_agent_base(body.dsl)
    logger.info("从 DSL 创建智能体: name=%s", base.name)
    agent = Agent(
        name=base.name,
        description=base.description,
        model_config_id=base.model_config_id,
        system_prompt=base.system_prompt,
        temperature=base.temperature,
        max_tokens=base.max_tokens,
        enabled_tools=base.enabled_tools or [],
        enabled_kbs=base.enabled_kbs or [],
        enabled_asset_types=base.enabled_asset_types or [],
        enabled_skills=base.enabled_skills or [],
        enabled_workflows=base.enabled_workflows or [],
        max_iterations=base.max_iterations,
        avatar=base.avatar,
        greeting=base.greeting,
        suggested_questions=base.suggested_questions or [],
        context_turns=base.context_turns,
        enable_memory=base.enable_memory,
        tone_style=base.tone_style,
        variables=base.variables or {},
        tool_configs=base.tool_configs or {},
        engine=base.engine or "hermes",
        publish_status="published",
        created_by=current_user.id,
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    return to_dict(agent)


@router.get("/{agent_id}")
def get_agent(
    agent_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """获取单个智能体详情。

    监控页面（AgentMonitor）和前端 agentsApi.get(id) 调用此端点。
    若缺少此 GET 路由，FastAPI 仅有 PUT/DELETE /{agent_id}，GET 请求返回 405。
    附带 ``can_edit`` 标志（admin/owner/被授权用户为 True）。
    """
    logger.info("查询智能体详情: agent_id=%s", agent_id)
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    # 防御性清理：剔除已不存在的知识库引用（如手动删除 KB 后的残留）
    _sanitize_enabled_kbs(db, agent)
    data = to_dict(agent)
    shared_ids = compute_can_edit_ids(db, current_user, "agent", [agent.id])
    data["can_edit"] = resource_can_edit(current_user, db, agent, shared_ids)
    data["publish_status"] = _resolve_publish_status(agent)
    return data


@router.post("", status_code=201)
def create_agent(
    body: AgentBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """创建智能体。"""
    logger.info("创建智能体: name=%s", body.name)
    agent = Agent(
        name=body.name,
        description=body.description,
        model_config_id=body.model_config_id,
        system_prompt=body.system_prompt,
        temperature=body.temperature,
        max_tokens=body.max_tokens,
        enabled_tools=body.enabled_tools or [],
        enabled_kbs=body.enabled_kbs or [],
        enabled_asset_types=body.enabled_asset_types or [],
        enabled_skills=body.enabled_skills or [],
        enabled_workflows=body.enabled_workflows or [],
        max_iterations=body.max_iterations,
        avatar=body.avatar,
        greeting=body.greeting,
        suggested_questions=body.suggested_questions or [],
        context_turns=body.context_turns,
        enable_memory=body.enable_memory,
        tone_style=body.tone_style,
        variables=body.variables or {},
        tool_configs=body.tool_configs or {},
        engine="hermes",
        output_mode=_normalize_output_mode(body.output_mode, default="chat"),
        publish_status=_incoming_publish_status(body, default="draft"),
        created_by=current_user.id,
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    logger.info("智能体已创建: id=%s, engine=%s", agent.id, agent.engine)
    return to_dict(agent)


@router.put("/{agent_id}")
def update_agent(
    agent_id: int,
    body: AgentBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """更新智能体。"""
    logger.info("更新智能体: id=%s", agent_id)
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    # 资源级 owner 校验：仅 admin/owner/被授权用户可编辑
    check_resource_ownership(current_user, db, "agent", agent_id, agent)
    agent.name = body.name
    agent.description = body.description
    agent.model_config_id = body.model_config_id
    agent.system_prompt = body.system_prompt
    agent.temperature = body.temperature
    agent.max_tokens = body.max_tokens
    agent.enabled_tools = body.enabled_tools or []
    agent.enabled_kbs = body.enabled_kbs or []
    agent.enabled_asset_types = body.enabled_asset_types or []
    agent.enabled_skills = body.enabled_skills or []
    agent.enabled_workflows = body.enabled_workflows or []
    agent.max_iterations = body.max_iterations
    agent.avatar = body.avatar
    agent.greeting = body.greeting
    agent.suggested_questions = body.suggested_questions or []
    agent.context_turns = body.context_turns
    agent.enable_memory = body.enable_memory
    agent.tone_style = body.tone_style
    agent.variables = body.variables or {}
    agent.tool_configs = body.tool_configs or {}
    # engine 固定为 hermes，不接受修改
    if body.output_mode:
        agent.output_mode = _normalize_output_mode(body.output_mode, default=agent.output_mode or "chat")
    incoming = _incoming_publish_status(body, default="")
    if incoming in ("draft", "published"):
        agent.publish_status = incoming
    db.commit()
    db.refresh(agent)
    logger.info("智能体已更新: id=%s, engine=%s", agent.id, agent.engine)
    return to_dict(agent)


@router.get("/{agent_id}/dsl")
def export_agent_dsl(
    agent_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """导出智能体 DSL（JSON 结构，可存为文件或版本管理）。"""
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    return _agent_to_dsl(agent)


@router.post("/{agent_id}/publish")
def publish_agent(
    agent_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    check_resource_ownership(current_user, db, "agent", agent_id, agent)
    agent.publish_status = "published"
    _strip_draft_marks(agent)
    db.commit()
    db.refresh(agent)
    shared_ids = compute_can_edit_ids(db, current_user, "agent", [agent.id])
    return _agent_item(agent, resource_can_edit(current_user, db, agent, shared_ids))


@router.post("/{agent_id}/publish-template")
def publish_agent_as_template(
    agent_id: int,
    body: PublishTemplateRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """将智能体发布为团队模板（模板市场数据源）。"""
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    check_resource_ownership(current_user, db, "agent", agent_id, agent)
    vars_ = dict(agent.variables or {})
    vars_["is_public_template"] = True
    vars_["template_scenario"] = body.scenario or agent.description or ""
    vars_["template_tags"] = body.tags or []
    agent.variables = vars_
    db.commit()
    db.refresh(agent)
    logger.info("智能体已发布为模板: id=%s", agent_id)
    return to_dict(agent)


@router.delete("/{agent_id}")
def delete_agent(
    agent_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """删除智能体。"""
    logger.info("删除智能体: id=%s", agent_id)
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    # 资源级 owner 校验：仅 admin/owner/被授权用户可删除
    check_resource_ownership(current_user, db, "agent", agent_id, agent)

    # 先清理智能体的全部关联数据，否则会因外键约束（chat_messages_agent_id_fkey）删除失败，
    # 并避免遗留孤儿数据（executions / agent_files 虽无 DB 约束，也一并清理）。
    try:
        from sqlalchemy import delete as sa_delete

        from app.models.agent_file import AgentFile
        from app.models.chat_message import ChatMessage

        # 该智能体上传/生成的文件（含磁盘文件）
        for rec in db.query(AgentFile).filter(AgentFile.agent_id == agent_id).all():
            try:
                if rec.file_path and os.path.exists(rec.file_path):
                    os.remove(rec.file_path)
            except OSError as exc:
                logger.warning("删除智能体文件磁盘失败: %s, error=%s", rec.file_path, exc)
            db.delete(rec)
        # 对话消息（有 DB 外键约束，必须删除）
        db.execute(sa_delete(ChatMessage).where(ChatMessage.agent_id == agent_id))
        # 执行记录
        db.execute(sa_delete(Execution).where(Execution.agent_id == agent_id))

        db.delete(agent)
        db.commit()
    except Exception:
        db.rollback()
        raise
    logger.info("智能体已删除: id=%s", agent_id)
    return {"ok": True}


@router.post("/{agent_id}/test")
async def test_agent(
    agent_id: int, body: AgentTestRequest, db: Session = Depends(get_db)
) -> dict:
    """测试智能体，返回推理结果与日志。

    输出字段由智能体 output_mode 决定，不再根据是否勾选工具推断。
    """
    logger.info("测试智能体: id=%s", agent_id)
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    # 解析输入
    user_input: str = body.input or ""
    try:
        parsed = json.loads(user_input)
        if isinstance(parsed, dict):
            alert_data = parsed
            user_text = user_input
        else:
            alert_data = {"input": user_input}
            user_text = user_input
    except (json.JSONDecodeError, TypeError):
        alert_data = {"input": user_input}
        user_text = user_input

    from app.platform.agent_runtime import (
        OUTPUT_MODE_CHAT,
        invoke_agent,
        resolve_output_mode,
        resolve_runtime_user,
        sanitize_override,
    )

    output_mode = resolve_output_mode(agent)
    try:
        result = await invoke_agent(
            db=db,
            agent=agent,
            input=alert_data if output_mode != OUTPUT_MODE_CHAT else user_text,
            user=resolve_runtime_user(db),
            channel="test",
            output_mode=output_mode,
            override=sanitize_override(body.override, channel="test"),
            session_id=_normalize_session_id(body.session_id),
        )
    except Exception as exc:
        logger.exception("智能体测试失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"Agent 测试失败（{type(exc).__name__}），详情见服务日志") from exc

    if output_mode == OUTPUT_MODE_CHAT:
        try:
            exec_record = Execution(
                agent_id=agent.id,
                status="success",
                result={"reply": result.response, "input": user_text, "mode": "chat", "engine": "hermes"},
                trigger_type="agent_test",
                finished_at=beijing_now(),
            )
            db.add(exec_record)
            db.commit()
        except Exception as exc:
            logger.warning("保存执行记录失败: %s", exc)
            db.rollback()

        return {
            "reply": result.response,
            "messages": result.messages or [
                {"role": "user", "content": user_text},
                {"role": "assistant", "content": result.response},
            ],
            "logs": [{"level": "info", "message": "Hermes 纯对话模式"}],
        }

    decision = result.decision or {}
    try:
        exec_record = Execution(
            agent_id=agent.id,
            status="success",
            result={
                "decision": decision.get("decision"),
                "target_ip": decision.get("target_ip"),
                "reason": decision.get("reason"),
                "duration": decision.get("duration"),
                "input": alert_data,
                "messages_count": len(result.messages or []),
                "engine": "hermes",
            },
            trigger_type="agent_test",
            finished_at=beijing_now(),
        )
        db.add(exec_record)
        db.commit()
        db.refresh(exec_record)
        logger.info("智能体执行记录已保存: execution_id=%s, agent_id=%s", exec_record.id, agent.id)
    except Exception as exc:  # noqa: BLE001
        logger.warning("保存智能体执行记录失败（不影响测试结果）: %s", exc)
        db.rollback()

    return {
        "decision": decision.get("decision"),
        "target_ip": decision.get("target_ip"),
        "reason": decision.get("reason"),
        "duration": decision.get("duration"),
        "messages": result.messages or [],
        "logs": (result.raw or {}).get("logs") or [],
    }


@router.post("/{agent_id}/test/stream")
async def test_agent_stream(
    agent_id: int,
    body: AgentTestRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """流式测试智能体（SSE），经 invoke_agent_sse 统一走 Hermes。"""
    logger.info("流式测试智能体: id=%s", agent_id)
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    if (body.channel or "") == "conversation":
        _require_published(agent)

    from app.platform.agent_run import AgentRun
    from app.platform.agent_runtime import sanitize_override

    channel = body.channel or "test"
    session_id = _normalize_session_id(body.session_id)
    run = AgentRun(
        db=db,
        agent=agent,
        user=current_user,
        channel=channel,
        session_id=session_id,
        user_input=body.input or "",
        override=sanitize_override(body.override, channel=channel),
        load_history=False,
        persist_history=False,
    )
    return StreamingResponse(run.stream(), media_type="text/event-stream")


@router.post("/{agent_id}/chat")
async def chat_agent(
    agent_id: int,
    body: AgentTestRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("agent", "execute")),
):
    """Hermes 引擎 SSE 对话端点。历史、执行记录和错误事件由 AgentRun 统一处理。"""
    logger.info("Agent 对话(SSE): agent_id=%s", agent_id)
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    channel = body.channel or "conversation"
    if channel != "test":
        _require_published(agent)

    from app.platform.agent_run import AgentRun
    from app.platform.agent_runtime import sanitize_override

    session_id = _normalize_session_id(body.session_id)
    # 已被删除（软删除墓碑）的会话不允许继续发送：否则另一浏览器在删除后
    # 仍能写入消息/会话元数据，导致已删除的对话“复活”。前端收到 409 后提示新建会话。
    from app.platform.chat_history import is_chat_session_deleted

    if is_chat_session_deleted(db, agent_id, int(current_user.id), session_id):
        raise HTTPException(
            status_code=409,
            detail="该对话已被删除，请新建会话后重试",
        )
    run = AgentRun(
        db=db,
        agent=agent,
        user=current_user,
        channel=channel,
        session_id=session_id,
        user_input=body.input or "",
        override=sanitize_override(body.override, channel=channel),
        load_history=True,
        persist_history=True,
    )
    return StreamingResponse(
        run.stream(),
        media_type="text/event-stream",
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
    )


@router.get("/{agent_id}/chat/sessions")
async def list_chat_sessions(
    agent_id: int,
    limit: int = Query(500, ge=1, le=500),
    offset: int = Query(0, ge=0),
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("agent", "execute")),
):
    """分页列出当前用户在该智能体下未删除的会话（新→旧）。

    会话元数据随每轮对话落库（chat_sessions），因此同一账号在任意浏览器
    登录后都能拿到完整列表；早期只有消息没有元数据的会话会被自动补建。

    返回 ``has_more`` 告知调用方是否还有下一页（按 offset 继续拉取），
    调用方只有拿到完整快照后，才能把「服务端不存在」判定为其它端的删除。
    """
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    from app.platform.chat_history import list_chat_sessions as _list_sessions, serialize_session

    # helper 内部多取一条用于 has_more 判断
    rows = _list_sessions(db, agent_id, int(current_user.id), limit=limit, offset=offset)
    has_more = len(rows) > limit
    sessions = [serialize_session(r) for r in rows[:limit]]
    return {"sessions": sessions, "has_more": has_more}


@router.get("/{agent_id}/chat/sessions/{session_id}/messages")
async def get_chat_session_messages(
    agent_id: int,
    session_id: str,
    limit: int = Query(500, ge=1, le=2000),
    before_id: int | None = Query(None, ge=1, description="只取 id 小于该值的历史消息"),
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("agent", "execute")),
):
    """分页拉取指定会话的历史消息（用于跨浏览器恢复正常对话内容）。

    返回按时间正序的消息列表，assistant 的工具调用与后续 tool 结果会合并成
    前端可直接渲染的工具时间线。

    分页契约：``has_more`` 表示还有更早的消息；需要继续翻页时，把
    ``next_before_id`` 作为 ``before_id`` 再次请求（按 id 倒序取更早一页）。
    """
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    sid = _normalize_session_id(session_id)

    from app.models.chat_message import ChatMessage
    from app.platform.chat_history import to_display_messages

    query = db.query(ChatMessage).filter(
        ChatMessage.agent_id == agent_id,
        ChatMessage.session_id == sid,
        ChatMessage.user_id == current_user.id,
    )
    if before_id:
        query = query.filter(ChatMessage.id < before_id)
    # 多取一条判断是否还有更早的消息
    rows = query.order_by(ChatMessage.id.desc()).limit(limit + 1).all()
    has_more = len(rows) > limit
    if has_more:
        rows = rows[:limit]
    rows.reverse()
    next_before_id = rows[0].id if has_more and rows else None
    return {
        "session_id": sid,
        "messages": to_display_messages(rows),
        "has_more": has_more,
        "next_before_id": next_before_id,
    }


@router.delete("/{agent_id}/chat/session")
async def clear_chat_session(
    agent_id: int,
    session_id: str = Query(..., description="要清空的会话 ID"),
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("agent", "execute")),
):
    """清空指定会话的服务端记忆（删除该会话持久化的全部消息记录）。

    用于「删除单个会话」场景。注意：「新建会话」只换新的 session_id，
    不会调用本接口；「清空历史」使用 DELETE /{agent_id}/chat/sessions。
    """
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    sid = _normalize_session_id(session_id)

    from sqlalchemy import delete as sa_delete
    from app.models.chat_message import ChatMessage

    # 先写软删除墓碑（保留会话元数据但标记 deleted_at），再删消息：
    # 墓碑阻止其它浏览器仍在途的流式请求在删除后把该会话写回来。
    _mark_chat_sessions_deleted(db, agent_id, int(current_user.id), session_id=sid)
    deleted = db.execute(
        sa_delete(ChatMessage).where(
            ChatMessage.agent_id == agent_id,
            ChatMessage.session_id == sid,
            ChatMessage.user_id == current_user.id,
        )
    ).rowcount
    db.commit()

    from app.core.audit import log_audit
    log_audit(
        db,
        user_id=current_user.id,
        username=current_user.username,
        action="agent.chat_session.clear",
        resource_type="agent",
        resource_id=str(agent_id),
        detail=f"清空会话记忆: session={sid}, 删除 {deleted} 条消息",
    )

    return {"deleted": deleted, "session_id": sid}


@router.delete("/{agent_id}/chat/sessions")
async def clear_all_chat_sessions(
    agent_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("agent", "execute")),
):
    """清空该智能体下当前用户的全部会话记忆（所有 session_id）。

    仅供前端「清空历史」显式调用；「新建会话」只生成新的 session_id，
    不会调用本接口，因此不会删除任何已存在的历史会话。
    """
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    from sqlalchemy import delete as sa_delete
    from app.models.chat_message import ChatMessage

    # 为全部会话写软删除墓碑（含只有消息、尚无元数据的旧会话），再删消息
    _mark_chat_sessions_deleted(db, agent_id, int(current_user.id))
    deleted = db.execute(
        sa_delete(ChatMessage).where(
            ChatMessage.agent_id == agent_id,
            ChatMessage.user_id == current_user.id,
        )
    ).rowcount
    db.commit()

    from app.core.audit import log_audit
    log_audit(
        db,
        user_id=current_user.id,
        username=current_user.username,
        action="agent.chat_sessions.clear_all",
        resource_type="agent",
        resource_id=str(agent_id),
        detail=f"清空全部会话记忆: 删除 {deleted} 条消息",
    )

    return {"deleted": deleted}


async def _resume_workflow_run(agent_id: int, run_id: str, body: ResumeRequest, db: Session, current_user):
    logger.info("恢复工作流运行: agent_id=%s, run_id=%s, decision=%s", agent_id, run_id, body.decision)
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    from app.agent.hermes.skill_engine import WorkflowSkillBridge

    bridge = WorkflowSkillBridge(db, agent, current_user)
    try:
        ctx = await bridge.resume_skill(run_id, body.decision)
        return {
            "skill_run_id": ctx.skill_run_id,
            "status": ctx.status,
            "execution_id": ctx.execution_id,
            "node_outputs": ctx.node_outputs,
        }
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        logger.exception("工作流运行恢复失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"工作流运行恢复失败（{type(exc).__name__}），详情见服务日志") from exc


@router.post("/{agent_id}/skills/{skill_run_id}/resume")
async def resume_skill(
    agent_id: int,
    skill_run_id: str,
    body: ResumeRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("agent", "execute")),
):
    return await _resume_workflow_run(agent_id, skill_run_id, body, db, current_user)


@router.post("/{agent_id}/workflow-runs/{run_id}/resume")
async def resume_workflow_run(
    agent_id: int,
    run_id: str,
    body: ResumeRequest,
    db: Session = Depends(get_db),
    current_user=Depends(require_permission("agent", "execute")),
):
    return await _resume_workflow_run(agent_id, run_id, body, db, current_user)


@router.get("/{agent_id}/executions")
def list_agent_executions(
    agent_id: int,
    limit: int = Query(50, ge=1, le=500, description="返回条数上限（不传 page 时生效）"),
    page: int = Query(0, ge=0, description="页码（从1开始）；传0或不传则走旧版 limit 模式"),
    size: int = Query(20, ge=1, le=200, description="每页条数（仅 page>=1 时生效）"),
    db: Session = Depends(get_db),
) -> list[dict] | dict:
    """查询智能体的执行历史记录（含测试记录）。

    支持两种模式：
    - 旧版（page=0）：返回 ``limit`` 条记录的列表（向后兼容）。
    - 分页版（page>=1）：返回 ``{items, total, page, size, pages}`` 分页结构。
    """
    logger.info("查询智能体执行历史: agent_id=%s, page=%s, size=%s", agent_id, page, size)
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    base_q = (
        db.query(Execution)
        .filter(Execution.agent_id == agent_id)
        .order_by(Execution.created_at.desc())
    )
    if page >= 1:
        return paginate(base_q, page=page, size=size)
    # 旧版兼容：直接返回 limit 条列表
    return [to_dict(e) for e in base_q.limit(limit).all()]


@router.get("/{agent_id}/monitor")
def agent_monitor_stats(agent_id: int, db: Session = Depends(get_db)) -> dict:
    """返回智能体监控统计数据。

    指标：
    - total: 总执行次数
    - success: 成功次数
    - failed: 失败次数
    - today: 今日执行次数
    - avg_duration_ms: 平均耗时（毫秒，基于 finished_at - created_at）
    - recent_7d: 最近 7 天每日执行次数列表
    """
    from sqlalchemy import func

    logger.info("查询智能体监控统计: agent_id=%s", agent_id)
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")

    query = db.query(Execution).filter(Execution.agent_id == agent_id)
    total = query.count()
    success = query.filter(Execution.status == "success").count()
    failed = query.filter(Execution.status == "failed").count()

    now = beijing_now()
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    today = query.filter(Execution.created_at >= today_start).count()

    # 平均耗时
    avg_seconds = (
        db.query(func.avg(func.extract("epoch", Execution.finished_at - Execution.created_at)))
        .filter(Execution.agent_id == agent_id)
        .filter(Execution.finished_at.isnot(None))
        .scalar()
    )
    avg_duration_ms = int(float(avg_seconds) * 1000) if avg_seconds else 0

    # 最近 7 天每日执行次数
    from datetime import timedelta
    recent_7d = []
    for i in range(6, -1, -1):
        day_start = (now - timedelta(days=i)).replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        count = (
            query.filter(Execution.created_at >= day_start)
            .filter(Execution.created_at < day_end)
            .count()
        )
        recent_7d.append({"date": day_start.strftime("%m-%d"), "count": count})

    return {
        "total": total,
        "success": success,
        "failed": failed,
        "today": today,
        "avg_duration_ms": avg_duration_ms,
        "recent_7d": recent_7d,
    }


# ============================================================================
# 工具搜索状态（tool_search 渐进式披露）
# ============================================================================


@router.get("/{agent_id}/tool-search-status")
def agent_tool_search_status(agent_id: int, db: Session = Depends(get_db)) -> dict:
    """返回智能体的工具搜索状态与装配预览。

    用于前端 AgentEditor 展示：
    - 当前 tool_search 配置（mode / threshold / limits）
    - 工具分类详情（核心 visible / 可延迟 deferrable，按 source 分组）
    - token 估算与是否激活预览

    幂等：只读端点，不修改 agent 状态。
    """
    from app.agent.hermes.tool_engine import HermesToolEngine
    from app.agent.hermes.tool_search import (
        BRIDGE_TOOL_NAMES,
        SOAR_CORE_TOOL_SOURCES,
        SOAR_DEFERRABLE_TOOL_SOURCES,
        estimate_tokens_from_schemas,
        is_deferrable_by_source,
    )

    logger.info("查询工具搜索状态: agent_id=%s", agent_id)
    agent = db.query(Agent).filter(Agent.id == agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="智能体不存在")

    # 仅 hermes 引擎支持 tool_search；其他引擎返回空状态（前端降级展示）
    if (agent.engine or "hermes") != "hermes":
        return {
            "engine": agent.engine,
            "supported": False,
            "message": "tool_search 仅 Hermes 引擎支持",
            "config": None,
            "classification": {"visible": [], "deferrable": []},
            "stats": {
                "visible_count": 0,
                "deferrable_count": 0,
                "visible_tokens": 0,
                "deferrable_tokens": 0,
                "threshold_tokens": 0,
                "would_activate": False,
                "activated": False,
            },
        }

    # 实例化 tool_engine（轻量，不创建 LLM；_build_registry 完成 source 分类）
    try:
        tool_engine = HermesToolEngine(db, agent)
    except Exception as exc:  # noqa: BLE001
        logger.exception("tool_engine 初始化失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"工具引擎初始化失败（{type(exc).__name__}），详情见服务日志")

    cfg = tool_engine.tool_search_config

    # 触发一次装配（传空 extra，专注 DB 工具分类）
    # 装配会填充 _full_tool_defs / _source_map / _assembly_result
    try:
        tool_engine.get_assembled_openai_tools()
    except Exception as exc:  # noqa: BLE001
        logger.warning("tool_search 装配预览失败: %s", exc)

    # 装配后读取 source_map（_build_source_map 从 _registry 派生，始终最新）
    source_map = tool_engine._build_source_map()
    full_defs = tool_engine._full_tool_defs or []
    assembly = tool_engine._assembly_result

    # 按工具名构建详情列表（含 source + token 估算）
    def _tool_detail(td: dict) -> dict:
        fn = td.get("function") or {}
        name = fn.get("name", "")
        source = source_map.get(name, "unknown")
        # 单工具 token 估算
        tokens = estimate_tokens_from_schemas([td])
        return {
            "name": name,
            "source": source,
            "description": (fn.get("description") or "")[:120],
            "tokens": tokens,
            "deferrable": is_deferrable_by_source(name, source),
        }

    visible_details = []
    deferrable_details = []
    for td in full_defs:
        fn = (td.get("function") or {})
        name = fn.get("name", "")
        # 跳过桥接工具（它们是替代品，不是用户配置的工具）
        if name in BRIDGE_TOOL_NAMES:
            continue
        detail = _tool_detail(td)
        if detail["deferrable"]:
            deferrable_details.append(detail)
        else:
            visible_details.append(detail)

    # 装配统计
    visible_tokens = sum(d["tokens"] for d in visible_details)
    deferrable_tokens = sum(d["tokens"] for d in deferrable_details)
    # context_length 未存库，用 None 表示（前端展示"未知"）
    context_length = None
    threshold_tokens = (
        int(context_length * (cfg.threshold_pct / 100.0)) if context_length else 0
    )
    # auto 模式下是否会激活（基于当前可延迟 token 与阈值）
    # context_length 未知时无法精确判断，前端展示"需运行时确定"
    would_activate = None
    if cfg.enabled == "on":
        # on 模式：只要有可延迟工具就激活
        would_activate = len(deferrable_details) > 0
    elif cfg.enabled == "off":
        would_activate = False
    # auto 模式：context_length 未知，无法预判（返回 None 让前端展示"运行时确定"）

    # 按 source 分组统计
    def _group_by_source(details: list) -> dict:
        groups: dict[str, list] = {}
        for d in details:
            groups.setdefault(d["source"], []).append(d)
        return {
            src: {"count": len(items), "tokens": sum(i["tokens"] for i in items), "tools": items}
            for src, items in groups.items()
        }

    return {
        "engine": "hermes",
        "supported": True,
        "config": {
            "enabled": cfg.enabled,
            "threshold_pct": cfg.threshold_pct,
            "search_default_limit": cfg.search_default_limit,
            "max_search_limit": cfg.max_search_limit,
        },
        "classification": {
            "visible": visible_details,
            "deferrable": deferrable_details,
            "visible_by_source": _group_by_source(visible_details),
            "deferrable_by_source": _group_by_source(deferrable_details),
        },
        "stats": {
            "visible_count": len(visible_details),
            "deferrable_count": len(deferrable_details),
            "visible_tokens": visible_tokens,
            "deferrable_tokens": deferrable_tokens,
            "threshold_pct": cfg.threshold_pct,
            "threshold_tokens": threshold_tokens,
            "context_length": context_length,
            "would_activate": would_activate,  # None=运行时确定, True/False=明确
            "activated": bool(assembly.activated) if assembly else False,
        },
        "source_catalog": {
            "core_sources": sorted(SOAR_CORE_TOOL_SOURCES),
            "deferrable_sources": sorted(SOAR_DEFERRABLE_TOOL_SOURCES),
        },
    }

