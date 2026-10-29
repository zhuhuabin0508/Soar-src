"""技能（Skill）CRUD + AI 辅助 + 测试 + 导入导出路由。

技能是一段**纯文本指令**（处置流程/角色设定/领域规则/SOP），启用后由
``app/agent/prompt_assembler.py`` 注入到 Agent 的 system prompt，持续塑造
AI 行为。技能不是可调用函数，与 ``tools_manage.py``（code/http 工具）是两类不同实体。

权限：列表/详情需 ``skill:view``，创建/更新需 ``skill:edit``，删除需 ``skill:delete``。
删除技能后，引用它的 Agent（``enabled_skills``）在下次组装 prompt 时通过
``IN`` 查询自然 miss，无需显式清理悬挂引用（惰性清理）。

引用计数：``list_skills`` 遍历所有 Agent 的 ``enabled_skills``（技能 id 列表），
计算每个技能被多少智能体引用（``reference_count`` / ``referenced_by``）。
"""
import logging

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import check_resource_ownership, compute_can_edit_ids, get_current_user, require_permission, resource_can_edit
from app.models.skill import Skill
from app.models.agent import Agent
from app.models.user import User
from app.schemas.common import to_dict, to_dict_list

logger = logging.getLogger(__name__)

# router 级鉴权：所有技能接口强制登录
router = APIRouter(
    prefix="/skills",
    tags=["skills"],
    dependencies=[Depends(get_current_user)],
)


class SkillBase(BaseModel):
    """技能请求体。"""

    name: str = Field(..., description="技能名称，唯一")
    description: str = Field("", description="简短摘要（列表展示用）")
    content: str = Field(..., description="注入 system prompt 的正文，支持 {{key}} 引用智能体变量")
    category: str | None = Field(None, description="分类：处置流程/角色设定/领域规则/SOP/其他")
    tags: list[str] | None = Field(None, description="自由标签数组")
    enabled: bool = Field(True, description="是否启用（禁用后立即从 Agent prompt 移除）")
    priority: int = Field(0, description="注入顺序，越大越靠前（同优先级按 id 升序）")


def _compute_skill_refs(db: Session) -> dict[int, list[str]]:
    """计算每个技能被哪些智能体引用。

    遍历所有 Agent 的 ``enabled_skills``（技能 id 列表），建立 {skill_id: [agent_name,...]} 映射。
    """
    agents = db.query(Agent).all()
    skill_id_to_agents: dict[int, list[str]] = {}
    for agent in agents:
        for sid in (agent.enabled_skills or []):
            try:
                sid_int = int(sid)
            except (TypeError, ValueError):
                continue
            skill_id_to_agents.setdefault(sid_int, []).append(agent.name or f"#{agent.id}")
    return skill_id_to_agents


@router.get("")
def list_skills(
    category: str | None = Query(None, description="按分类精确筛选"),
    enabled: bool | None = Query(None, description="按启用状态筛选"),
    sort: str = Query("priority", description="排序字段：priority/updated_at/name"),
    order: str = Query("desc", description="排序方向：asc/desc"),
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("skill", "view")),
) -> list[dict]:
    """列出所有技能，支持按分类/启用状态筛选与排序。

    排序默认：``priority`` 降序（注入顺序），同优先级按 ``id`` 升序。
    每个技能附加 ``reference_count`` / ``referenced_by``（被哪些智能体引用）。
    每项附带 ``can_edit`` 标志（admin/owner/被授权用户为 True）。
    """
    logger.info("查询技能列表: category=%s, enabled=%s, sort=%s, order=%s", category, enabled, sort, order)
    query = db.query(Skill)
    if category is not None:
        query = query.filter(Skill.category == category)
    if enabled is not None:
        query = query.filter(Skill.enabled.is_(enabled))

    # 排序：优先级默认降序，其余字段默认按请求 order；同序内 id 升序保证稳定
    sort_col = {
        "priority": Skill.priority,
        "updated_at": Skill.updated_at,
        "name": Skill.name,
    }.get(sort, Skill.priority)
    if order == "asc":
        query = query.order_by(sort_col.asc(), Skill.id.asc())
    else:
        query = query.order_by(sort_col.desc(), Skill.id.asc())
    skills = query.all()
    result = to_dict_list(skills)
    # 附加引用计数
    refs = _compute_skill_refs(db)
    # 资源级 owner 控制：批量查共享授权集合，admin 在调用处直接判 True
    shared_ids = compute_can_edit_ids(db, current_user, "skill", [s.id for s in skills])
    for item, skill in zip(result, skills):
        sid = item.get("id")
        ref_list = refs.get(sid, [])
        item["reference_count"] = len(ref_list)
        item["referenced_by"] = ref_list
        item["can_edit"] = resource_can_edit(current_user, db, skill, shared_ids)
    return result


@router.get("/{skill_id:int}")
def get_skill(
    skill_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("skill", "view")),
) -> dict:
    """获取单个技能详情。

    附带 ``can_edit`` 标志（admin/owner/被授权用户为 True）。
    """
    logger.info("查询技能详情: id=%s", skill_id)
    skill = db.query(Skill).filter(Skill.id == skill_id).first()
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    data = to_dict(skill)
    shared_ids = compute_can_edit_ids(db, current_user, "skill", [skill.id])
    data["can_edit"] = resource_can_edit(current_user, db, skill, shared_ids)
    return data


@router.post("", status_code=201)
def create_skill(
    body: SkillBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("skill", "edit")),
) -> dict:
    """创建技能。

    名称唯一性校验：重名返回 400。
    """
    logger.info("创建技能: name=%s, category=%s", body.name, body.category)
    existing = db.query(Skill).filter(Skill.name == body.name).first()
    if existing is not None:
        raise HTTPException(status_code=400, detail=f"Skill name '{body.name}' already exists")
    skill = Skill(
        name=body.name,
        description=body.description,
        content=body.content,
        category=body.category,
        tags=body.tags or [],
        enabled=body.enabled,
        priority=body.priority,
        created_by=current_user.id,
    )
    db.add(skill)
    db.commit()
    db.refresh(skill)
    logger.info("技能已创建: id=%s", skill.id)
    return to_dict(skill)


@router.put("/{skill_id:int}")
def update_skill(
    skill_id: int,
    body: SkillBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("skill", "edit")),
) -> dict:
    """更新技能。

    名称唯一性校验（排除自身）；启用状态变更即时生效——下次 Agent 组装
    prompt 时通过 ``enabled.is_(True)`` 过滤自动移除/纳入。
    """
    logger.info("更新技能: id=%s", skill_id)
    skill = db.query(Skill).filter(Skill.id == skill_id).first()
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    # 资源级 owner 校验：仅 admin/owner/被授权用户可编辑（require_permission 为第一道防线）
    check_resource_ownership(current_user, db, "skill", skill_id, skill)
    # 名称唯一性校验（排除自身）
    if body.name != skill.name:
        conflict = db.query(Skill).filter(Skill.name == body.name).first()
        if conflict is not None:
            raise HTTPException(status_code=400, detail=f"Skill name '{body.name}' already exists")
    skill.name = body.name
    skill.description = body.description
    skill.content = body.content
    skill.category = body.category
    skill.tags = body.tags or []
    skill.enabled = body.enabled
    skill.priority = body.priority
    db.commit()
    db.refresh(skill)
    logger.info("技能已更新: id=%s, enabled=%s", skill.id, skill.enabled)
    return to_dict(skill)


@router.delete("/{skill_id:int}")
def delete_skill(
    skill_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("skill", "delete")),
) -> dict:
    """删除技能。

    悬挂引用处理：引用该技能的 Agent（``enabled_skills`` 含此 id）不做显式清理，
    下次组装 prompt 时 ``IN`` 查询自然 miss（惰性清理）。
    """
    logger.info("删除技能: id=%s", skill_id)
    skill = db.query(Skill).filter(Skill.id == skill_id).first()
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    # 资源级 owner 校验：仅 admin/owner/被授权用户可删除（require_permission 为第一道防线）
    check_resource_ownership(current_user, db, "skill", skill_id, skill)
    db.delete(skill)
    db.commit()
    logger.info("技能已删除: id=%s", skill_id)
    return {"ok": True}


# ============ AI 辅助：优化 / 检测问题 ============

def _create_llm_for_skill(db):
    """加载默认 LLMConfig 创建 LLM 实例，用于技能优化/检测。

    返回 (llm, config_info) 或 (None, error_msg)。
    """
    from app.core.llm_helper import create_llm_from_config
    from app.models.llm_config import LLMConfig

    cfg = db.query(LLMConfig).filter(LLMConfig.is_default.is_(True)).first()
    if cfg is None:
        cfg = db.query(LLMConfig).first()
    if cfg is None or not (cfg.api_key or cfg.base_url):
        return None, "未配置 LLM，请先在「模型设置」中配置并设为默认"
    try:
        llm, info = create_llm_from_config(cfg, temperature=0.3, max_tokens=1024)
        return llm, info
    except ValueError as exc:
        return None, str(exc)
    except Exception as exc:  # noqa: BLE001
        logger.exception("创建 LLM 实例失败: %s", exc)
        return None, f"创建 LLM 实例失败: {exc}"


class SkillOptimizeRequest(BaseModel):
    """技能 AI 优化请求体。"""

    name: str = Field(..., description="技能名称")
    description: str = Field("", description="技能摘要")
    content: str = Field(..., description="技能正文")


@router.post("/optimize")
async def optimize_skill(
    body: SkillOptimizeRequest, db: Session = Depends(get_db)
) -> dict:
    """用 LLM 优化技能正文，使其更清晰、结构化、减少歧义。

    返回优化后的正文（不自动保存，由前端决定是否采纳）。
    """
    logger.info("AI 优化技能: name=%s", body.name)
    llm, err = _create_llm_for_skill(db)
    if llm is None:
        raise HTTPException(status_code=400, detail=err)

    prompt = (
        "你是一个提示词工程专家。请优化下面的技能指令（会注入到智能体的 system prompt），"
        "使其更清晰、结构化、减少歧义，让大模型能稳定遵循。\n\n"
        f"技能名称：{body.name}\n"
        f"技能摘要：{body.description or '(空)'}\n"
        f"当前正文：\n{body.content or '(空)'}\n\n"
        "要求：\n"
        "1. 保留原意和关键约束，不要增删业务规则；\n"
        "2. 用分点 / 分段结构化表达，必要时加小标题；\n"
        "3. 保留 {{变量}} 占位符原样不动；\n"
        "4. 直接输出优化后的正文，不要加引号、不要解释。"
    )
    from langchain_core.messages import HumanMessage

    try:
        resp = await llm.ainvoke([HumanMessage(content=prompt)])
        optimized = resp.content if hasattr(resp, "content") else str(resp)
        optimized = optimized.strip()
    except Exception as exc:  # noqa: BLE001
        logger.exception("LLM 优化技能失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"LLM 调用失败（{type(exc).__name__}），详情见服务日志") from exc

    return {"content": optimized}


class SkillCheckRequest(BaseModel):
    """技能问题检测请求体。"""

    name: str = Field(..., description="技能名称")
    content: str = Field(..., description="技能正文")


@router.post("/check")
async def check_skill(
    body: SkillCheckRequest, db: Session = Depends(get_db)
) -> dict:
    """检测技能正文的问题：是否缺少角色定义 / 输出格式 / 约束条件等。

    返回 JSON：{issues: [{type, message}], score, suggestions}。
    """
    logger.info("AI 检测技能问题: name=%s", body.name)
    llm, err = _create_llm_for_skill(db)
    if llm is None:
        raise HTTPException(status_code=400, detail=err)

    prompt = (
        "你是提示词质量评审专家。请审查下面的技能指令（注入智能体 system prompt），"
        "检测是否存在影响大模型执行效果的问题。\n\n"
        f"技能名称：{body.name}\n"
        f"技能正文：\n{body.content or '(空)'}\n\n"
        "请从以下维度审查：\n"
        "1. 角色定义：是否明确了 AI 应扮演的角色 / 立场；\n"
        "2. 输出格式：是否说明了期望的输出格式或结构；\n"
        "3. 约束条件：是否给出了边界 / 禁止事项 / 安全约束；\n"
        "4. 触发条件：何时执行该技能、何时跳过；\n"
        "5. 歧义 / 模糊：是否存在含糊、易误解的表述；\n"
        "6. 变量占位：{{key}} 是否合理、是否可能未提供。\n\n"
        "只返回 JSON 对象，不要加任何解释文字或代码块标记：\n"
        '{"issues":[{"type":"角色定义|输出格式|约束条件|触发条件|歧义|变量","message":"具体问题"}],'
        '"score":0-100,"suggestions":"改进建议（一句话）"}\n'
        "若无明显问题，issues 返回空数组 []，score 给高分。"
    )
    from langchain_core.messages import HumanMessage
    import json as _json

    try:
        resp = await llm.ainvoke([HumanMessage(content=prompt)])
        content = resp.content if hasattr(resp, "content") else str(resp)
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        result = _json.loads(content)
        if not isinstance(result, dict):
            result = {"issues": [], "score": 100, "suggestions": ""}
    except _json.JSONDecodeError:
        logger.warning("技能检测结果 JSON 解析失败: %s", content)
        result = {"issues": [], "score": 0, "suggestions": "检测失败：LLM 返回格式异常"}
    except Exception as exc:  # noqa: BLE001
        logger.exception("技能检测失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"LLM 调用失败（{type(exc).__name__}），详情见服务日志") from exc

    return result


# ============ 测试运行：注入技能后让智能体回答 ============

class SkillTestRequest(BaseModel):
    """技能测试请求体。"""

    agent_id: int = Field(..., description="用于测试的智能体 id")
    message: str = Field(..., description="测试问题（自然语言）")
    # 可选：直接传入未保存的技能正文进行测试（content 非空时优先于已保存的技能）
    content: str | None = Field(None, description="待测试的技能正文（支持未保存草稿）")
    name: str | None = Field(None, description="待测试技能名称（仅用于注入标记）")


@router.post("/{skill_id:int}/test")
async def test_skill(
    skill_id: int,
    body: SkillTestRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("skill", "view")),
) -> dict:
    """测试技能：把该技能注入到指定智能体的 system prompt，查看回复是否符合预期。

    - 支持测试已保存技能（``skill_id``）或未保存草稿（``body.content`` 非空时优先）。
    - 复用智能体的模型 / 工具 / 知识库配置，在其 system prompt 末尾追加本技能正文。
    - 返回注入后的完整 prompt、AI 回复、消息链路、日志，供前端对比展示。

    资源级 owner 校验：仅 admin/owner/被授权用户可测试该技能及其关联智能体。
    """
    logger.info("测试技能: skill_id=%s, agent_id=%s", skill_id, body.agent_id)
    skill = db.query(Skill).filter(Skill.id == skill_id).first()
    if skill is None:
        raise HTTPException(status_code=404, detail="Skill not found")
    agent = db.query(Agent).filter(Agent.id == body.agent_id).first()
    if agent is None:
        raise HTTPException(status_code=404, detail="Agent not found")
    # 资源级 owner 校验：技能与智能体均需可编辑，防止越权读取他人技能/驱动他人智能体
    check_resource_ownership(current_user, db, "skill", skill_id, skill)
    check_resource_ownership(current_user, db, "agent", body.agent_id, agent)

    # 待测试正文：body.content 优先（支持未保存草稿），否则用已保存技能正文
    test_content = body.content if (body.content and body.content.strip()) else (skill.content or "")
    test_name = body.name or skill.name

    # 组装 system prompt：基础提示词 + 已启用技能 + 待测试技能（追加在末尾）
    from app.agent.prompt_assembler import assemble_system_prompt, render_variables

    base_prompt = assemble_system_prompt(
        db, agent, fallback_prompt="你是一个智能助手，请根据用户输入给出有帮助的回答。"
    ) or ""
    variables = agent.variables or {}
    rendered_skill = render_variables(test_content, variables)
    skill_block = (
        f"\n\n=== 测试技能 ===\n--- 技能: {test_name} ---\n{rendered_skill}\n"
        f"--- 技能: {test_name} 结束 ---\n=== 测试技能结束 ==="
    )
    final_prompt = (base_prompt + skill_block).strip()

    user_text = body.message or ""
    alert_data = {"input": user_text}
    # enabled_asset_types 已废弃（search_assets 不再按类型勾选过滤），不计入能力判断
    has_tools = bool(agent.enabled_tools) or bool(agent.enabled_kbs) or bool(getattr(agent, "enabled_workflows", None))

    from app.platform.agent_runtime import (
        OUTPUT_MODE_CHAT,
        OUTPUT_MODE_SOC_DECISION,
        invoke_agent,
        resolve_runtime_user,
    )
    from types import SimpleNamespace

    override = SimpleNamespace(system_prompt=final_prompt)
    output_mode = OUTPUT_MODE_SOC_DECISION if has_tools else OUTPUT_MODE_CHAT

    try:
        result = await invoke_agent(
            db=db,
            agent=agent,
            input=alert_data if has_tools else user_text,
            user=resolve_runtime_user(db),
            channel="skill_test",
            output_mode=output_mode,
            override=override,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("技能测试调用失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"技能测试失败（{type(exc).__name__}），详情见服务日志") from exc

    if has_tools and result.decision:
        decision = result.decision
        return {
            "reply": result.response or decision.get("reason") or "",
            "injected_prompt": final_prompt,
            "messages": result.messages,
            "logs": (result.raw or {}).get("logs") or [],
        }

    return {
        "reply": result.response,
        "injected_prompt": final_prompt,
        "messages": result.messages or [
            {"role": "user", "content": user_text},
            {"role": "assistant", "content": result.response},
        ],
        "logs": [{"level": "info", "message": "Hermes 技能测试"}],
    }


# ============ 导入 / 导出 ============

@router.get("/export/all")
def export_skills(
    ids: str | None = Query(None, description="逗号分隔的技能 id，为空则导出全部"),
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("skill", "view")),
) -> dict:
    """导出技能为 JSON（单个或批量）。

    返回 ``{version, exported_at, skills: [...]}``，前端可直接下载为 .json 文件。
    """
    logger.info("导出技能: ids=%s", ids)
    query = db.query(Skill)
    id_list: list[int] = []
    if ids:
        for s in ids.split(","):
            s = s.strip()
            if s:
                try:
                    id_list.append(int(s))
                except ValueError:
                    pass
    if id_list:
        query = query.filter(Skill.id.in_(id_list))
    skills = query.order_by(Skill.id.asc()).all()
    from datetime import datetime, timezone

    return {
        "version": 1,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "skills": [
            {
                "name": s.name,
                "description": s.description,
                "content": s.content,
                "category": s.category,
                "tags": s.tags or [],
                "enabled": s.enabled,
                "priority": s.priority,
            }
            for s in skills
        ],
    }


class SkillImportRequest(BaseModel):
    """技能导入请求体。"""

    data: dict = Field(..., description="导出的 JSON 对象 {version, skills:[...]}")
    overwrite: bool = Field(False, description="同名是否覆盖更新（默认跳过）")


@router.post("/import")
def import_skills(
    body: SkillImportRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("skill", "edit")),
) -> dict:
    """批量导入技能。

    - ``overwrite=False``（默认）：同名跳过；
    - ``overwrite=True``：同名覆盖更新（content/category/tags/enabled/priority）。

    返回 ``{created, updated, skipped, errors}``。
    """
    logger.info("导入技能: overwrite=%s", body.overwrite)
    skills_data = body.data.get("skills") if isinstance(body.data, dict) else None
    if not isinstance(skills_data, list):
        raise HTTPException(status_code=400, detail="导入数据格式错误：缺少 skills 数组")

    created = 0
    updated = 0
    skipped = 0
    errors: list[str] = []
    for idx, item in enumerate(skills_data):
        name = (item.get("name") or "").strip()
        if not name:
            errors.append(f"第 {idx + 1} 条：缺少名称，已跳过")
            continue
        existing = db.query(Skill).filter(Skill.name == name).first()
        try:
            if existing is not None:
                if not body.overwrite:
                    skipped += 1
                    continue
                existing.description = item.get("description", "") or ""
                existing.content = item.get("content", "") or ""
                existing.category = item.get("category")
                existing.tags = item.get("tags") or []
                existing.enabled = item.get("enabled", True)
                existing.priority = item.get("priority", 0) or 0
                updated += 1
            else:
                skill = Skill(
                    name=name,
                    description=item.get("description", "") or "",
                    content=item.get("content", "") or "",
                    category=item.get("category"),
                    tags=item.get("tags") or [],
                    enabled=item.get("enabled", True),
                    priority=item.get("priority", 0) or 0,
                )
                db.add(skill)
                created += 1
        except Exception as exc:  # noqa: BLE001
            errors.append(f"{name}: {exc}")
    db.commit()
    logger.info("导入完成: created=%d, updated=%d, skipped=%d, errors=%d", created, updated, skipped, len(errors))
    return {"created": created, "updated": updated, "skipped": skipped, "errors": errors}
