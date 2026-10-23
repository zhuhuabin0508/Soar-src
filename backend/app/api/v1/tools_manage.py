"""工具管理 CRUD 路由（可编辑 Python 工具 + 声明式 HTTP 工具）。

注意：与 ``tools.py``（IP 查询/封禁能力路由）共用 ``/tools`` 前缀，
但路径不重叠：本模块仅暴露 ``/tools`` 根与 ``/tools/{int}``，
而 ``tools.py`` 使用 ``/tools/query/{ip}`` 与 ``/tools/block_ip``。
``{tool_id:int}`` 路径转换器确保 ``/tools/templates``、``/tools/block_ip`` 不会被误匹配。

工具类型：
- ``code``：用户编写 ``async def run(**kwargs)`` Python 代码，沙箱执行。
- ``http``：声明式 HTTP 接口配置（http_config），由 tool_http_runner 发起请求。
"""
import json
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from typing import Any

from app.core.tool_runner import clear_tool_cache
from app.core.tool_schema_infer import infer_tool_io
from app.core.tool_templates import TOOL_TEMPLATES
from app.core.tools.catalog import ToolCatalog
from app.core.tools.types import TOOL_SOURCE_CUSTOM
from app.database import get_db
from app.dependencies import check_resource_ownership, compute_can_edit_ids, get_current_user, require_permission, require_role, resource_can_edit
from app.models.tool import Tool
from app.models.agent import Agent
from app.models.user import User
from app.schemas.common import to_dict, to_dict_list

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/tools",
    tags=["tools-manage"],
    dependencies=[Depends(get_current_user)],
)


class ToolBase(BaseModel):
    """工具请求体。"""

    name: str = Field(..., description="工具名称，唯一")
    description: str = Field("", description="工具描述（写给 LLM 看，决定何时调用）")
    parameters_schema: list[dict[str, Any]] | None = Field(None, description="参数 schema 列表")
    code: str = Field("", description="工具代码，需定义 async def run(**kwargs)（code 类型）")
    enabled: bool = Field(True, description="是否启用")
    tool_type: str = Field("code", description="工具类型：code | http | framework")
    category: str | None = Field(None, description="工具集分类")
    http_config: dict[str, Any] | None = Field(None, description="HTTP 工具配置（http 类型）")
    tags: list[str] | None = Field(None, description="自定义标签列表，如 ['安全运营', '网络资产']")


class ToolTestRequest(BaseModel):
    """工具测试请求体。"""

    parameters: dict[str, Any] = Field(default_factory=dict, description="调用参数")


class OpenAPIImportRequest(BaseModel):
    """OpenAPI 导入请求体。"""

    spec: str | None = Field(None, description="OpenAPI/Swagger JSON 字符串")
    url: str | None = Field(None, description="OpenAPI/Swagger JSON 的 URL")


class OptimizeDescRequest(BaseModel):
    """工具描述 AI 优化请求体。"""

    name: str = Field(..., description="工具名称")
    description: str = Field("", description="当前描述")
    parameters: list[dict[str, Any]] | None = Field(None, description="参数 schema")


class ExtractParamsRequest(BaseModel):
    """从工具描述自动提取参数的请求体。"""

    name: str = Field(..., description="工具名称")
    description: str = Field("", description="工具描述")


class DebugChatRequest(BaseModel):
    """工具对话调试请求体。"""

    message: str = Field(..., description="用户自然语言输入")


@router.get("", dependencies=[Depends(require_permission("tool", "view"))])
def list_tools(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    """列出所有工具（按 id 升序：#1, #2, #3 ...）。

    每个工具附加 ``reference_count``（被多少智能体引用）和 ``referenced_by``
    （引用该工具的智能体名称列表），用于前端展示「被引用」信息。
    每项附带 ``can_edit`` 标志（admin/owner/被授权用户为 True）。
    """
    logger.info("查询工具列表")
    tools = db.query(Tool).order_by(Tool.id.asc()).all()
    result = to_dict_list(tools)
    # 批量计算引用关系：遍历所有 Agent 的 enabled_tools
    agents = db.query(Agent).all()
    tool_name_to_agents: dict[str, list[str]] = {}
    for agent in agents:
        for tool_name in (agent.enabled_tools or []):
            tool_name_to_agents.setdefault(tool_name, []).append(agent.name or f"#{agent.id}")
    # 资源级 owner 控制：批量查共享授权集合，admin 在调用处直接判 True
    shared_ids = compute_can_edit_ids(db, current_user, "tool", [t.id for t in tools])
    for item, tool in zip(result, tools):
        name = item.get("name", "")
        refs = tool_name_to_agents.get(name, [])
        item["reference_count"] = len(refs)
        item["referenced_by"] = refs
        item["can_edit"] = resource_can_edit(current_user, db, tool, shared_ids)
    return result


@router.get("/templates", dependencies=[Depends(require_permission("tool", "view"))])
def list_tool_templates() -> list[dict]:
    """返回内置工具模板（供新建参考）。"""
    logger.info("查询工具模板")
    return [dict(tpl) for tpl in TOOL_TEMPLATES]


@router.get("/catalog", dependencies=[Depends(require_permission("tool", "view"))])
def list_tool_catalog() -> dict:
    """返回平台工具统一目录（预置定义，不含用户自建实例）。"""
    preset = ToolCatalog.preset_definitions()
    by_source: dict[str, int] = {}
    for row in preset:
        src = row.get("tool_source") or "unknown"
        by_source[src] = by_source.get(src, 0) + 1
    return {
        "total": len(preset),
        "by_source": by_source,
        "tools": [
            {
                "name": t["name"],
                "description": t.get("description", ""),
                "tool_type": t.get("tool_type", "code"),
                "tool_source": t.get("tool_source"),
                "category": t.get("category"),
                "tags": t.get("tags"),
            }
            for t in preset
        ],
    }


@router.post("", status_code=201, dependencies=[Depends(require_permission("tool", "edit"))])
def create_tool(
    body: ToolBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """创建工具。"""
    logger.info("创建工具: name=%s, type=%s", body.name, body.tool_type)
    if ToolCatalog.preset_name_index().get(body.name):
        raise HTTPException(
            status_code=400,
            detail=f"工具名 '{body.name}' 与平台预置工具冲突，请更换名称",
        )
    existing = db.query(Tool).filter(Tool.name == body.name).first()
    if existing is not None:
        raise HTTPException(status_code=400, detail=f"Tool name '{body.name}' already exists")
    if (body.tool_type or "code") == "framework":
        raise HTTPException(status_code=400, detail="framework 类型工具由平台预置，不支持手动创建")
    tool = Tool(
        name=body.name,
        description=body.description,
        parameters_schema=body.parameters_schema,
        code=body.code,
        enabled=body.enabled,
        tool_type=body.tool_type or "code",
        category=body.category,
        http_config=body.http_config,
        tags=body.tags,
        tool_source=TOOL_SOURCE_CUSTOM,
        created_by=current_user.id,
    )
    db.add(tool)
    db.commit()
    db.refresh(tool)
    logger.info("工具已创建: id=%s", tool.id)
    return to_dict(tool)


@router.put("/{tool_id:int}", dependencies=[Depends(require_permission("tool", "edit"))])
def update_tool(
    tool_id: int,
    body: ToolBase,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """更新工具。"""
    logger.info("更新工具: id=%s, type=%s", tool_id, body.tool_type)
    tool = db.query(Tool).filter(Tool.id == tool_id).first()
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool not found")
    # 资源级 owner 校验：仅 admin/owner/被授权用户可编辑
    check_resource_ownership(current_user, db, "tool", tool_id, tool)
    # 名称唯一性校验（排除自身）
    if body.name != tool.name:
        if ToolCatalog.preset_name_index().get(body.name):
            raise HTTPException(
                status_code=400,
                detail=f"工具名 '{body.name}' 与平台预置工具冲突，请更换名称",
            )
        conflict = db.query(Tool).filter(Tool.name == body.name).first()
        if conflict is not None:
            raise HTTPException(status_code=400, detail=f"Tool name '{body.name}' already exists")
    if getattr(tool, "is_preset", False) and (body.tool_type or "code") == "framework":
        if (tool.tool_type or "code") != (body.tool_type or "code"):
            raise HTTPException(status_code=400, detail="预置 framework 工具类型不可修改")
    tool.name = body.name
    tool.description = body.description
    tool.parameters_schema = body.parameters_schema
    tool.code = body.code
    tool.enabled = body.enabled
    tool.tool_type = body.tool_type or "code"
    tool.category = body.category
    tool.http_config = body.http_config
    tool.tags = body.tags
    db.commit()
    db.refresh(tool)
    # 清除该工具的运行时缓存，确保下次加载新代码/配置
    clear_tool_cache(tool.name)
    logger.info("工具已更新: id=%s", tool.id)
    return to_dict(tool)


@router.delete("/{tool_id:int}", dependencies=[Depends(require_permission("tool", "edit"))])
def delete_tool(
    tool_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """删除工具。

    内置工具（is_preset=True）不可硬删除，防止容器重启后种子逻辑重新插入。
    用户可通过「禁用」（PUT enabled=False）来停用内置工具。
    """
    logger.info("删除工具: id=%s", tool_id)
    tool = db.query(Tool).filter(Tool.id == tool_id).first()
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool not found")
    # 资源级 owner 校验：仅 admin/owner/被授权用户可删除
    check_resource_ownership(current_user, db, "tool", tool_id, tool)
    if getattr(tool, "is_preset", False):
        raise HTTPException(
            status_code=400,
            detail="内置工具不可删除，请使用「禁用」功能（编辑工具将启用状态设为关）",
        )
    name = tool.name
    db.delete(tool)
    db.commit()
    clear_tool_cache(name)
    logger.info("工具已删除: id=%s", tool_id)
    return {"ok": True}


@router.post("/{tool_id:int}/test", dependencies=[Depends(require_permission("tool", "edit"))])
async def test_tool(
    tool_id: int, body: ToolTestRequest, db: Session = Depends(get_db)
) -> dict:
    """测试执行工具，返回结果与日志。

    自动按 ``tool_type`` 路由：code 工具走沙箱执行，http 工具走 HTTP 请求。
    对 HTTP 工具，通过 ``log_handler`` 回传「参数分发 / 实际请求 URL / 响应状态」
    等执行链路日志，避免展示未渲染的 URL 模板造成误导。
    """
    logger.info("测试工具: id=%s, params=%s", tool_id, body.parameters)
    tool = db.query(Tool).filter(Tool.id == tool_id).first()
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool not found")
    if not tool.enabled:
        raise HTTPException(status_code=400, detail="Tool is disabled")

    logs: list[dict[str, str]] = []
    logs.append({"level": "info", "message": f"开始执行工具 {tool.name} (type={tool.tool_type})"})
    # HTTP 工具展示 URL 模板作为「配置」信息（实际渲染后的 URL 由 run_http_tool 经
    # log_handler 回传，见下方 "实际请求" 日志），避免与真实请求混淆。
    if (tool.tool_type or "code") == "http":
        cfg = tool.http_config or {}
        logs.append({
            "level": "info",
            "message": f"URL 模板: {cfg.get('method', 'GET')} {cfg.get('url', '')}",
        })

    def log_handler(level: str, message: str) -> None:
        logs.append({"level": level, "message": message})

    from app.platform.tool_runtime import invoke_tool

    inv = await invoke_tool(
        tool.name,
        body.parameters,
        db=db,
        log_handler=log_handler,
        verify=False,          # 管理测试：跳过写工具证据验证（无证据上下文，由人工保证）
    )
    if not inv.ok:
        logs.append({"level": "error", "message": f"执行失败: {inv.error}"})
    else:
        logs.append({"level": "info", "message": "执行成功"})

    return {
        # 保持原有结构化返回，UI 表现不变；content（LLM 视角）放 raw 供排查
        "result": inv.raw_content if inv.raw_content is not None else inv.content,
        "logs": logs,
        "raw": {
            "result": inv.content,
            "error": inv.error,
            "guardrail_action": inv.guardrail_action,
            "threat_findings": inv.threat_findings,
        },
    }


@router.get("/{tool_id:int}/inferred-schema", dependencies=[Depends(require_permission("tool", "view"))])
def get_inferred_schema(tool_id: int, db: Session = Depends(get_db)) -> dict:
    """根据工具代码静态推断输入输出 schema（仅 code 类型有意义）。"""
    logger.info("推断工具 schema: id=%s", tool_id)
    tool = db.query(Tool).filter(Tool.id == tool_id).first()
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool not found")
    return infer_tool_io(tool.code or "", tool.parameters_schema)


# ============ OpenAPI 导入 ============

def _parse_openapi_spec(spec_text: str) -> dict:
    """解析 OpenAPI/Swagger JSON 字符串为字典。"""
    if not spec_text or not spec_text.strip():
        raise HTTPException(status_code=400, detail="OpenAPI spec 为空")
    try:
        return json.loads(spec_text)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"OpenAPI JSON 解析失败: {exc}") from exc


def _openapi_param_location(param: dict) -> str:
    """把 OpenAPI parameter.in 映射为内部 location。"""
    loc = (param.get("in") or "query").lower()
    if loc == "formData":
        return "body"
    return loc  # query / header / path


def _openapi_param_type(schema: dict) -> str:
    """把 OpenAPI schema.type 映射为内部类型。"""
    t = (schema or {}).get("type", "string").lower()
    if t in ("integer", "number"):
        return "Number"
    if t == "boolean":
        return "Boolean"
    if t == "array":
        return "Array"
    if t in ("object",):
        return "Object"
    return "String"


def _operations_from_spec(spec: dict) -> list[dict]:
    """从 OpenAPI spec 提取操作列表。"""
    paths = spec.get("paths") or {}
    operations: list[dict] = []
    for path, methods in paths.items():
        if not isinstance(methods, dict):
            continue
        for method, op in methods.items():
            m = method.lower()
            if m not in ("get", "post", "put", "delete", "patch"):
                continue
            if not isinstance(op, dict):
                continue
            # 收集参数
            params: list[dict] = []
            for p in op.get("parameters", []) or []:
                pschema = p.get("schema") or {}
                params.append({
                    "name": p.get("name", ""),
                    "type": _openapi_param_type(pschema),
                    "location": _openapi_param_location(p),
                    "required": bool(p.get("required", False)),
                    "description": p.get("description", "") or pschema.get("description", ""),
                    "default": pschema.get("default"),
                    "enum": pschema.get("enum"),
                })
            # requestBody 参数（OpenAPI 3.x）
            req_body = op.get("requestBody")
            if isinstance(req_body, dict):
                content = req_body.get("content") or {}
                json_media = content.get("application/json") or {}
                body_schema = json_media.get("schema") or {}
                props = body_schema.get("properties") or {}
                for pname, pschema in props.items():
                    params.append({
                        "name": pname,
                        "type": _openapi_param_type(pschema),
                        "location": "body",
                        "required": pname in (body_schema.get("required") or []),
                        "description": pschema.get("description", ""),
                        "default": pschema.get("default"),
                        "enum": pschema.get("enum"),
                    })

            summary = op.get("summary") or op.get("operationId") or f"{m.upper()} {path}"
            operations.append({
                "method": m.upper(),
                "path": path,
                "summary": summary,
                "operation_id": op.get("operationId", ""),
                "description": op.get("description", "") or summary,
                "parameters": params,
                "tool_name": (op.get("operationId") or summary).strip().replace(" ", "_")[:60],
            })
    return operations


@router.post("/import-openapi", dependencies=[Depends(require_permission("tool", "edit"))])
async def import_openapi(body: OpenAPIImportRequest) -> dict:
    """解析 OpenAPI/Swagger JSON（或从 URL 拉取），返回操作列表供前端选择。

    不会直接创建工具——前端选定操作后，把该操作的配置填入表单再保存。
    """
    logger.info("导入 OpenAPI: has_spec=%s, url=%s", bool(body.spec), body.url)
    spec_text = body.spec or ""
    if not spec_text and body.url:
        try:
            from app.core.security import validate_public_fetch_url

            validate_public_fetch_url(body.url, field="OpenAPI URL")
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        try:
            import httpx

            async with httpx.AsyncClient(timeout=15) as client:
                resp = await client.get(body.url)
                resp.raise_for_status()
                spec_text = resp.text
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"拉取 OpenAPI URL 失败: {exc}") from exc

    spec = _parse_openapi_spec(spec_text)
    operations = _operations_from_spec(spec)
    logger.info("OpenAPI 解析完成: 操作数=%d", len(operations))
    return {
        "title": spec.get("info", {}).get("title", ""),
        "version": spec.get("info", {}).get("version", ""),
        "operations": operations,
    }


@router.post("/build-from-operation")
def build_from_operation(body: dict[str, Any]) -> dict:
    """根据选定的 OpenAPI 操作构造工具配置（http_config + parameters_schema）。

    请求体：{ operation: {...}, base_url?: str, tool_name?: str }
    返回：{ name, description, tool_type, http_config, parameters_schema }
    """
    op = body.get("operation") or {}
    if not op:
        raise HTTPException(status_code=400, detail="缺少 operation 字段")
    method = (op.get("method") or "GET").upper()
    path = op.get("path") or ""
    base_url = (body.get("base_url") or "").rstrip("/")
    full_url = base_url + path if base_url else path

    http_config = {
        "method": method,
        "url": full_url,
        "headers": [{"key": "Content-Type", "value": "application/json"}] if method != "GET" else [],
        "body_type": "json" if method in ("POST", "PUT", "PATCH") else "none",
        "body_content": "",
        "auth_type": "none",
        "auth_config": {},
        "timeout": 10,
        "retry": 0,
        "response_jsonpath": "",
        "error_handling": "",
    }
    parameters_schema = op.get("parameters") or []
    name = body.get("tool_name") or op.get("tool_name") or op.get("summary") or "imported_tool"
    return {
        "name": name,
        "description": op.get("description") or op.get("summary") or "",
        "tool_type": "http",
        "http_config": http_config,
        "parameters_schema": parameters_schema,
    }


# ============ AI 优化工具描述 ============

def _create_llm_for_optimize(db):
    """加载默认 LLMConfig 创建 LLM 实例，用于工具描述优化。

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
        llm, info = create_llm_from_config(cfg, temperature=0.3, max_tokens=512)
        return llm, info
    except ValueError as exc:
        return None, str(exc)
    except Exception as exc:  # noqa: BLE001
        logger.exception("创建 LLM 实例失败: %s", exc)
        return None, f"创建 LLM 实例失败: {exc}"


@router.post("/optimize-description")
async def optimize_description(body: OptimizeDescRequest, db: Session = Depends(get_db)) -> dict:
    """用 LLM 优化工具描述，使其更符合 LLM 调用决策的需要。"""
    logger.info("AI 优化工具描述: name=%s", body.name)
    llm, err = _create_llm_for_optimize(db)
    if llm is None:
        raise HTTPException(status_code=400, detail=err)

    params_desc = ""
    if body.parameters:
        params_desc = "\n".join(
            f"- {p.get('name', '?')}({p.get('type', 'String')}, 位置:{p.get('location', 'body')}): {p.get('description', '')}"
            for p in body.parameters
        )

    prompt = (
        "你是一个工具描述优化专家。请把下面的工具描述改写得更适合大模型(LLM)理解，"
        "明确说明工具的用途、适用场景、调用时机，让 LLM 能准确判断何时调用此工具。\n\n"
        f"工具名称：{body.name}\n"
        f"当前描述：{body.description or '(空)'}\n"
        f"参数列表：\n{params_desc or '(无参数)'}\n\n"
        "要求：\n1. 用一句话说明工具做什么；\n"
        "2. 说明什么情况下应该调用此工具；\n"
        "3. 控制在 80 字以内，简洁明了；\n"
        "4. 直接输出优化后的描述，不要加引号或多余解释。"
    )
    from langchain_core.messages import HumanMessage

    try:
        resp = await llm.ainvoke([HumanMessage(content=prompt)])
        optimized = resp.content if hasattr(resp, "content") else str(resp)
        optimized = optimized.strip().strip('"').strip("'")
    except Exception as exc:  # noqa: BLE001
        logger.exception("LLM 优化描述失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"LLM 调用失败: {exc}") from exc

    return {"description": optimized}


@router.post("/extract-parameters")
async def extract_parameters(body: ExtractParamsRequest, db: Session = Depends(get_db)) -> dict:
    """从工具描述自动提取参数 schema。

    用 LLM 分析工具描述，推断工具需要哪些参数，返回 parameters_schema 列表。
    """
    logger.info("AI 提取参数: name=%s", body.name)
    llm, err = _create_llm_for_optimize(db)
    if llm is None:
        raise HTTPException(status_code=400, detail=err)

    prompt = (
        "你是一个工具参数分析专家。请分析以下工具描述，推断该工具需要哪些参数，"
        "并返回 JSON 数组。每个参数包含：name(参数名), type(String/Integer/Number/Boolean), "
        "required(是否必填true/false), description(参数说明), default(默认值,可选)。\n\n"
        f"工具名称：{body.name}\n"
        f"工具描述：{body.description or '(空)'}\n\n"
        "要求：\n"
        "1. 只返回 JSON 数组，不要加任何解释文字；\n"
        '2. 示例格式：[{"name":"ip","type":"String","required":true,"description":"要查询的IP地址","default":""}]\n'
        "3. 如果无法从描述中推断参数，返回空数组 []"
    )
    from langchain_core.messages import HumanMessage
    import json as _json

    try:
        resp = await llm.ainvoke([HumanMessage(content=prompt)])
        content = resp.content if hasattr(resp, "content") else str(resp)
        # 提取 JSON 数组（兼容 markdown 代码块包裹）
        content = content.strip()
        if content.startswith("```"):
            content = content.split("\n", 1)[-1].rsplit("```", 1)[0].strip()
        params = _json.loads(content)
        if not isinstance(params, list):
            params = []
    except _json.JSONDecodeError:
        logger.warning("LLM 返回的参数 JSON 解析失败: %s", content)
        params = []
    except Exception as exc:  # noqa: BLE001
        logger.exception("AI 提取参数失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"LLM 调用失败: {exc}") from exc

    return {"parameters": params}


# ============ 模拟对话调试 ============

@router.post("/{tool_id:int}/debug-chat")
async def debug_chat(
    tool_id: int, body: DebugChatRequest, db: Session = Depends(get_db)
) -> dict:
    """模拟对话调试：把工具绑定到 LLM，展示 LLM 思考→提取参数→调用工具→最终回答的链路。

    经 ``invoke_agent``（OUTPUT_MODE_CHAT），自定义 system_prompt 引导通用问答。
    返回 messages 与 logs 供前端展示运行链路。
    """
    logger.info("工具对话调试: id=%s, message=%s", tool_id, body.message[:100])
    tool = db.query(Tool).filter(Tool.id == tool_id).first()
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool not found")
    if not tool.enabled:
        raise HTTPException(status_code=400, detail="Tool is disabled")

    from app.config import settings
    from app.models.agent import Agent
    from app.platform.agent_runtime import (
        OUTPUT_MODE_CHAT,
        invoke_agent,
        resolve_runtime_user,
    )
    from types import SimpleNamespace

    soc_agent_id = int(getattr(settings, "WORKFLOW_SOC_AGENT_ID", 0) or 0)
    if soc_agent_id <= 0:
        raise HTTPException(
            status_code=400,
            detail="请配置 WORKFLOW_SOC_AGENT_ID 并创建对应 Hermes 智能体",
        )
    agent = db.query(Agent).filter(Agent.id == soc_agent_id).first()
    if agent is None:
        raise HTTPException(status_code=400, detail=f"智能体不存在: id={soc_agent_id}")

    system_prompt = (
        "你是一个智能助手，可以调用工具来回答用户问题。"
        "当用户的问题需要调用工具时，请提取合适的参数并调用工具；"
        "拿到工具结果后，用自然语言向用户总结回答。"
        "如果不需要工具，直接回答即可。"
    )
    alert_data = {"input": body.message, "src_ip": "unknown"}
    override = SimpleNamespace(
        system_prompt=system_prompt,
        temperature=0.3,
        max_tokens=1024,
        max_iterations=4,
    )
    try:
        result = await invoke_agent(
            db=db,
            agent=agent,
            input=alert_data,
            user=resolve_runtime_user(db),
            channel="tool_debug",
            output_mode=OUTPUT_MODE_CHAT,
            override=override,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("工具对话调试失败: %s", exc)
        raise HTTPException(status_code=500, detail=f"对话调试失败: {exc}") from exc

    return {
        "response": result.response or "",
        "messages": result.messages or [],
        "logs": [],
    }
