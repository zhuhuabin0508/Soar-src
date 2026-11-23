"""智能体创建助手：通过对话分析用户需求并创建工具/技能/智能体的框架级工具处理。

这些工具在 DB 中为 ``tool_type='framework'``（无 code，由 Hermes 执行器在
``_react_loop`` 中拦截后调用本模块，走受信任的 Python 逻辑，不经过代码沙箱）：

- ``list_tools`` / ``list_skills`` / ``list_agents``：盘点现有资源（命名查重、选用）
- ``create_skill`` / ``create_tool`` / ``create_agent``：创建资源
- ``test_tool_code``：对 LLM 编写的工具代码做静态安全审查与编译检查（创建前自检）

安全设计：
- 权限对齐 HTTP 端点：create_tool 需 ``tool:edit``（admin）、create_skill 需 ``skill:edit``，
  create_agent 仅需登录（与 POST /agents 一致）。
- 工具代码为 LLM 生成的字符串，存储前经 ``validate_tool_code``（AST import 白名单 +
  危险访问拦截）审查；创建后由智能体启用时仍在既有沙箱中执行。
- 创建资源的 ``created_by`` 归属为对话用户（非智能体自身）。
"""

import ast
import logging

from app.core.permissions import DEFAULT_ROLES, has_permission, migrate_permissions
from app.core.tool_runner import CodeValidationError, validate_tool_code
from app.core.tools.catalog import ToolCatalog
from app.core.tools.types import TOOL_SOURCE_CUSTOM
from app.models.role import Role

logger = logging.getLogger(__name__)

# 构建类框架工具名（执行器据此分类路由 + 按 agent.enabled_tools 门控可见性）
BUILDER_TOOL_NAMES = {
    "list_tools",
    "list_skills",
    "list_agents",
    "create_skill",
    "create_tool",
    "create_agent",
    "test_tool_code",
}

# create_agent 允许透传的字段（对齐 agents.py AgentBase）
_AGENT_DEFAULTS: dict = {
    "description": "",
    "temperature": 0.7,
    "max_tokens": 1024,
    "enabled_tools": [],
    "enabled_kbs": [],
    "enabled_asset_types": [],
    "enabled_skills": [],
    "enabled_workflows": [],
    "max_iterations": 5,
    "suggested_questions": [],
    "context_turns": 10,
    "enable_memory": False,
    "tone_style": "professional",
    "variables": {},
    "tool_configs": {},
    # 新创建智能体默认走 hermes 引擎（平台当前推荐），LLM 可显式传 engine 覆盖
    "engine": "hermes",
}
_AGENT_FIELDS = set(_AGENT_DEFAULTS) | {
    "name",
    "model_config_id",
    "system_prompt",
    "avatar",
    "greeting",
}


def _check_permission(db, user, module: str, action: str) -> None:
    """对齐 dependencies.require_permission 的权限矩阵校验（供框架工具复用）。"""
    from app.dependencies import is_admin
    if is_admin(user, db):
        return
    if getattr(user, "role_id", None):
        role = db.query(Role).filter(Role.id == user.role_id).first()
        if role and has_permission(migrate_permissions(role.permissions, grant_new_actions=False), module, action):
            return
    for default_role in DEFAULT_ROLES:
        if default_role["name"] == user.role:
            if has_permission(default_role["permissions"], module, action):
                return
            break
    raise PermissionError(f"权限不足：需要 {module}:{action} 权限（仅管理员可执行此操作）")


# ============================== 盘点 ==============================

def _list_tools(db) -> list[dict]:
    from app.models.tool import Tool

    rows = db.query(Tool).order_by(Tool.id.asc()).all()
    return [
        {
            "id": t.id,
            "name": t.name,
            "description": (t.description or "")[:200],
            "category": t.category,
            "tool_type": t.tool_type,
            "enabled": bool(t.enabled),
            "is_preset": bool(t.is_preset),
        }
        for t in rows
    ]


def _list_skills(db) -> list[dict]:
    from app.models.skill import Skill

    rows = (
        db.query(Skill)
        .order_by(Skill.priority.desc(), Skill.id.asc())
        .all()
    )
    return [
        {
            "id": s.id,
            "name": s.name,
            "description": (s.description or "")[:200],
            "category": s.category,
            "priority": s.priority,
            "enabled": bool(s.enabled),
        }
        for s in rows
    ]


def _list_agents(db) -> list[dict]:
    from app.models.agent import Agent

    rows = db.query(Agent).order_by(Agent.id.asc()).all()
    return [
        {
            "id": a.id,
            "name": a.name,
            "description": (a.description or "")[:200],
            "engine": a.engine,
            "enabled_tools": list(a.enabled_tools or []),
            "enabled_skills": list(a.enabled_skills or []),
            "enabled_workflows": list(a.enabled_workflows or []),
        }
        for a in rows
    ]


# ============================== 创建 ==============================

def _create_skill(db, user, params: dict) -> dict:
    from app.models.skill import Skill

    name = (params.get("name") or "").strip()
    content = (params.get("content") or "").strip()
    if not name:
        raise ValueError("name（技能名称）为必填项")
    if not content:
        raise ValueError("content（技能正文）为必填项")
    existing = db.query(Skill).filter(Skill.name == name).first()
    if existing:
        raise ValueError(f"技能「{name}」已存在（id={existing.id}），请改用其他名称")
    skill = Skill(
        name=name,
        description=(params.get("description") or "").strip(),
        content=content,
        category=params.get("category"),
        tags=[str(x) for x in (params.get("tags") or [])],
        enabled=bool(params.get("enabled", True)),
        priority=int(params.get("priority") or 0),
        created_by=user.id,
    )
    db.add(skill)
    db.commit()
    db.refresh(skill)
    logger.info("构建助手创建技能: id=%s, name=%s, by=%s", skill.id, skill.name, user.username)
    return {
        "ok": True,
        "id": skill.id,
        "name": skill.name,
        "message": f"技能「{skill.name}」创建成功（id={skill.id}）",
    }


def _create_tool(db, user, params: dict) -> dict:
    from app.models.tool import Tool

    name = (params.get("name") or "").strip()
    code = (params.get("code") or "").strip()
    if not name:
        raise ValueError("name（工具名）为必填项，建议小写英文下划线命名")
    if not code:
        raise ValueError("code（工具代码）为必填项，须定义 async def run(**kwargs)")
    if ToolCatalog.preset_name_index().get(name):
        raise ValueError(f"工具名「{name}」与平台预置工具冲突，请更换名称")
    existing = db.query(Tool).filter(Tool.name == name).first()
    if existing:
        raise ValueError(f"工具「{name}」已存在（id={existing.id}），请改用其他名称")
    # 静态安全审查（沙箱 import 白名单 + 危险访问拦截），与工具运行前一致
    try:
        validate_tool_code(code)
    except CodeValidationError as exc:
        raise ValueError(f"工具代码安全审查未通过：{exc}") from exc
    schema = params.get("parameters_schema")
    if schema is None:
        schema = []
    if not isinstance(schema, list):
        raise ValueError("parameters_schema 必须是数组，元素形如 {name,type,required,description}")
    tool = Tool(
        name=name,
        description=(params.get("description") or "").strip(),
        parameters_schema=schema,
        code=code,
        enabled=bool(params.get("enabled", True)),
        tool_type="code",
        category=params.get("category"),
        tags=[str(x) for x in (params.get("tags") or [])],
        tool_source=TOOL_SOURCE_CUSTOM,
        created_by=user.id,
    )
    db.add(tool)
    db.commit()
    db.refresh(tool)
    logger.info("构建助手创建工具: id=%s, name=%s, by=%s", tool.id, tool.name, user.username)
    return {
        "ok": True,
        "id": tool.id,
        "name": tool.name,
        "message": f"工具「{tool.name}」创建成功（id={tool.id}）",
    }


def _create_agent(db, user, params: dict) -> dict:
    from app.models.agent import Agent

    name = (params.get("name") or "").strip()
    if not name:
        raise ValueError("name（智能体名称）为必填项")
    existing = db.query(Agent).filter(Agent.name == name).first()
    if existing:
        raise ValueError(f"智能体「{name}」已存在（id={existing.id}），请改用其他名称")
    payload = {**_AGENT_DEFAULTS}
    for key in _AGENT_FIELDS:
        if key in params and params[key] is not None:
            payload[key] = params[key]
    payload["name"] = name
    agent = Agent(**payload, created_by=user.id)
    db.add(agent)
    db.commit()
    db.refresh(agent)
    logger.info("构建助手创建智能体: id=%s, name=%s, engine=%s, by=%s",
                agent.id, agent.name, agent.engine, user.username)
    return {
        "ok": True,
        "id": agent.id,
        "name": agent.name,
        "engine": agent.engine,
        "message": f"智能体「{agent.name}」创建成功（id={agent.id}，engine={agent.engine}）",
    }


def _test_tool_code(params: dict) -> dict:
    code = (params.get("code") or "").strip()
    if not code:
        return {"ok": False, "errors": ["code 为空，请提供工具代码"]}
    try:
        validate_tool_code(code)
    except CodeValidationError as exc:
        return {"ok": False, "errors": [f"安全审查未通过：{exc}"]}
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return {"ok": False, "errors": [f"语法错误：{exc}"]}
    has_run = any(
        isinstance(n, (ast.AsyncFunctionDef, ast.FunctionDef)) and n.name == "run"
        for n in ast.walk(tree)
    )
    if not has_run:
        return {"ok": False, "errors": ["代码未定义 async def run(**kwargs) 入口函数"]}
    return {"ok": True, "message": "代码通过安全审查与编译检查，可直接用于创建工具"}


# ============================== 入口 ==============================

async def run_builder_tool(tc, db, user) -> dict:
    """执行一个构建类框架工具，返回给 LLM 的结果 dict。

    Args:
        tc: ToolCall（含 name / arguments 已解析 dict）。
        db: SQLAlchemy Session。
        user: 当前对话用户。
    """
    name = tc.name
    args = tc.arguments or {}
    try:
        if name == "list_tools":
            return {"ok": True, "tools": _list_tools(db)}
        if name == "list_skills":
            return {"ok": True, "skills": _list_skills(db)}
        if name == "list_agents":
            return {"ok": True, "agents": _list_agents(db)}
        if name == "create_skill":
            _check_permission(db, user, "skill", "edit")
            return _create_skill(db, user, args)
        if name == "create_tool":
            _check_permission(db, user, "tool", "edit")
            return _create_tool(db, user, args)
        if name == "create_agent":
            return _create_agent(db, user, args)
        if name == "test_tool_code":
            return _test_tool_code(args)
        return {"ok": False, "error": f"未知构建工具: {name}"}
    except (ValueError, PermissionError) as exc:
        db.rollback()
        logger.warning("构建工具 %s 失败: %s", name, exc)
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("构建工具 %s 执行异常: %s", name, exc)
        return {"ok": False, "error": f"执行异常：{exc}"}
