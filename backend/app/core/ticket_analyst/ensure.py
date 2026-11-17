# -*- coding: utf-8 -*-
"""工单安全分析研判智能体幂等初始化。

启动时（main.py lifespan）与本链路首次解析失败时惰性兜底调用：

- 按 ``TICKET_ANALYST_AGENT_ID``（>0）精确解析；否则按名称兜底
- 不存在则自动创建（engine=hermes、output_mode=ticket_analyst、
  单轮无工具、published、``variables._managed_by="ticket_analyst"``）
- 带 ``_managed_by`` 标记且提示词指纹（规则+模板+示例）变化时自动刷新
  system_prompt（提示词变更 → 重启即生效）；手工创建/编辑过的智能体不覆盖
"""

from __future__ import annotations

import logging
import threading

from sqlalchemy.orm import Session

from app.core.ticket_analyst.prompt import (
    AGENT_DESCRIPTION,
    AGENT_NAME,
    build_system_prompt,
    prompt_version,
)

logger = logging.getLogger(__name__)

_MANAGED_BY = "ticket_analyst"
_PROMPT_VARIABLES_KEY = "_prompt_version"
# 创建互斥：启动钩子与并发调用同时命中缺失时只创建一个同名智能体
_CREATE_LOCK = threading.Lock()


def resolve_ticket_analyst_agent(db: Session, create: bool = True):
    """解析（可选在缺失时创建）工单研判智能体，返回 Agent 或 None。

    ``create=False`` 供研判运行时使用：只解析不创建，避免并发调用同时
    创建同名智能体（Agent.name 无唯一约束）。创建入口仅保留启动 ensure。
    """
    from app.config import settings
    from app.models.agent import Agent

    configured = int(getattr(settings, "TICKET_ANALYST_AGENT_ID", 0) or 0)
    if configured > 0:
        agent = db.query(Agent).filter(Agent.id == configured).first()
        if agent is not None:
            return agent
        logger.warning(
            "TICKET_ANALYST_AGENT_ID=%s 未命中，回退按名称解析: %s", configured, AGENT_NAME
        )

    agent = db.query(Agent).filter(Agent.name == AGENT_NAME).first()
    if agent is not None:
        return agent
    if not create:
        return None

    with _CREATE_LOCK:
        # 双检：并发调用下只创建一个
        agent = db.query(Agent).filter(Agent.name == AGENT_NAME).first()
        if agent is not None:
            return agent
        return _create_managed_agent(db)


def _create_managed_agent(db: Session):
    from app.models.agent import Agent

    prompt = build_system_prompt()
    agent = Agent(
        name=AGENT_NAME,
        description=AGENT_DESCRIPTION,
        system_prompt=prompt,
        model_config_id=_resolve_model_config_id(db),
        temperature=0.2,
        # 5 要素结构化依据约 600-900 汉字，768 会截断，默认给足 2048
        max_tokens=2048,
        # 低推理强度：规则引擎已产全量证据，削减推理 token 满足 3s SLA
        reasoning_effort="low",
        # 单轮调用：全量数据由调用方预注入，禁用 agentic 工具循环（3s SLA 关键）
        max_iterations=1,
        context_turns=1,
        enable_memory=False,
        tone_style="professional",
        enabled_tools=[],
        enabled_kbs=[],
        enabled_skills=[],
        enabled_asset_types=[],
        tool_configs={},
        engine="hermes",
        output_mode="ticket_analyst",
        publish_status="published",
        created_by=None,  # 系统托管，见 Agent.created_by 注释
        variables={
            "_managed_by": _MANAGED_BY,
            _PROMPT_VARIABLES_KEY: prompt_version(),
        },
    )
    db.add(agent)
    db.commit()
    db.refresh(agent)
    logger.info("已自动创建工单安全分析研判智能体: id=%s, prompt_version=%s", agent.id, prompt_version())
    return agent


def _resolve_model_config_id(db: Session):
    """解析默认模型配置（不硬编码任何主键，主键在不同环境不一致）。

    优先级：封禁研判智能体（生产验证过的 GLM）绑定的模型 →
    默认且启用的 chat 模型 → 首个启用的 chat 模型 → None。
    """
    from app.config import settings
    from app.models.agent import Agent
    from app.models.llm_config import LLMConfig

    configured = int(getattr(settings, "BAN_ANALYST_AGENT_ID", 0) or 0)
    if configured > 0:
        row = db.query(Agent).filter(Agent.id == configured).first()
        if row is not None and row.model_config_id:
            return row.model_config_id

    cfg = (
        db.query(LLMConfig)
        .filter(
            LLMConfig.model_type == "chat",
            LLMConfig.enabled.is_(True),
        )
        .order_by(LLMConfig.is_default.desc(), LLMConfig.id.asc())
        .first()
    )
    return getattr(cfg, "id", None) if cfg is not None else None


def _sync_managed_params(db: Session, agent) -> bool:
    """托管智能体参数同步：提示词指纹变化时刷新 system_prompt。

    采样参数（reasoning_effort / temperature / max_tokens）不在此处强制归一：
    运营人员在智能体配置页手工调整后必须保持生效，重启不得回退默认值。
    非托管（手工创建）智能体完全不覆盖。
    """
    if not isinstance(agent.variables, dict):
        return False
    if agent.variables.get("_managed_by") != _MANAGED_BY:
        return False  # 手工创建/编辑过：尊重人工配置，不覆盖
    current = prompt_version()
    if agent.variables.get(_PROMPT_VARIABLES_KEY) == current:
        return False
    agent.system_prompt = build_system_prompt()
    variables = {**agent.variables, _PROMPT_VARIABLES_KEY: current}
    variables.pop("_rules_version", None)  # 旧版指纹键清理
    agent.variables = variables
    db.commit()
    logger.info("工单研判提示词已更新: agent_id=%s, prompt_version=%s", agent.id, current)
    return True


def ensure_ticket_analyst_agent(db: Session) -> None:
    """幂等入口：解析/创建智能体并同步托管参数（启动时调用）。"""
    try:
        agent = resolve_ticket_analyst_agent(db)
        if agent is not None:
            _sync_managed_params(db, agent)
    except Exception:  # noqa: BLE001
        logger.exception("工单安全分析研判智能体初始化失败（不影响启动，首次调用时惰性重试）")
