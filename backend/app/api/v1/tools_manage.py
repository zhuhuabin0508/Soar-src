"""工具管理 CRUD 路由（可编辑 Python 工具 + 声明式 HTTP 工具）。

注意：与 ``tools.py``（IP 查询/封禁能力路由）共用 ``/tools`` 前缀，
但路径不重叠：本模块仅暴露 ``/tools`` 根与 ``/tools/{int}``，
而 ``tools.py`` 使用 ``/tools/query/{ip}`` 与 ``/tools/block_ip``。
``{tool_id:int}`` 路径转换器确保 ``/tools/templates``、``/tools/block_ip`` 不会被误匹配。

工具类型：
- ``code``：用户编写 ``async def run(**kwargs)`` Python 代码，沙箱执行。
- ``http``：声明式 HTTP 接口配置（http_config），由 tool_http_runner 发起请求。
"""
import copy
import json
import logging
import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, text
from sqlalchemy.orm import Session
from typing import Any

from app.core.tool_runner import clear_tool_cache, run_tool
from app.core.tool_schema_infer import infer_tool_io
from app.core.tool_templates import TOOL_TEMPLATES
from app.core.tool_categories import CATEGORY_TREE, is_leaf_category
from app.core.tools.catalog import ToolCatalog
from app.core.tools.types import TOOL_SOURCE_CUSTOM
from app.database import get_db
from app.dependencies import check_resource_ownership, compute_can_edit_ids, get_current_user, is_admin, require_permission, require_role, resource_can_edit
from app.models.tool import Tool
from app.models.tool_version import ToolVersion
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
    status: str = Field("active", description="生命周期状态：draft | active | disabled | deprecated")
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


# 工具生命周期状态白名单。只有 active 会注册进智能体工具表；
# draft（草稿）/ disabled（停用）/ deprecated（弃用）均不注册。
TOOL_STATUSES = ("draft", "active", "disabled", "deprecated")


def _normalize_status(status: str) -> str:
    """校验并返回合法的工具状态，非法值回退到 active。"""
    status = (status or "active").strip().lower()
    return status if status in TOOL_STATUSES else "active"


def _normalize_category(category: str | None) -> str | None:
    """校验工具分类并返回落库值。

    - 空 / None → None（不分类）
    - 合法叶子分类 → 原值
    - 顶层分组 value（非叶子）→ 抛 400（工具必须挂叶子）
    - 其他未知值 → 原值（兼容自定义分类与历史数据）
    """
    if not category:
        return None
    value = category.strip()
    if is_leaf_category(value):
        return value
    # 命中顶层分组 value（非叶子）：引导用户选择叶子
    if any(g["value"] == value for g in CATEGORY_TREE):
        raise HTTPException(status_code=400, detail=f"分类 '{value}' 是分组，请选择其下的叶子分类")
    return value



# ---------------------------------------------------------------------------
# 工具导入 / 导出辅助
# ---------------------------------------------------------------------------
# 导出时敏感字段的占位符；导入覆盖时遇到占位符沿用库中旧值
_REDACTED = "__REDACTED__"
_SECRET_FIELD_RE = re.compile(
    r"(token|secret|password|passwd|api[_-]?key|authorization|access[_-]?key|salt)", re.I
)
_EXPORT_FIELDS = (
    "name", "description", "parameters_schema", "code", "enabled",
    "tool_type", "category", "tags", "http_config",
)


class ToolImportRequest(BaseModel):
    """工具导入请求体（可直接提交导出文件内容）。"""

    tools: list[dict[str, Any]] = Field(..., description="工具数组（导出文件的 tools 字段）")
    overwrite: bool = Field(False, description="同名工具是否覆盖（默认跳过）")
    dry_run: bool = Field(False, description="仅校验不落库")


def _redact_secrets(value: Any) -> Any:
    """递归脱敏：字段名命中密钥关键字，或 headers 中 key 命中。"""
    if isinstance(value, dict):
        out = {}
        for key, val in value.items():
            if isinstance(val, str) and _SECRET_FIELD_RE.search(str(key)):
                out[key] = _REDACTED
            else:
                out[key] = _redact_secrets(val)
        return out
    if isinstance(value, list):
        out = []
        for item in value:
            if (
                isinstance(item, dict)
                and isinstance(item.get("key"), str)
                and isinstance(item.get("value"), str)
                and _SECRET_FIELD_RE.search(item["key"])
            ):
                out.append({**item, "value": _REDACTED})
            else:
                out.append(_redact_secrets(item))
        return out
    return value


def _merge_redacted(new: Any, old: Any) -> Any:
    """把导入中的脱敏占位符替换为库中旧值，避免覆盖时清空密钥。"""
    if new == _REDACTED:
        return old
    if isinstance(new, dict) and isinstance(old, dict):
        return {k: _merge_redacted(v, old.get(k)) for k, v in new.items()}
    if (
        isinstance(new, list)
        and isinstance(old, list)
        and new
        and all(isinstance(i, dict) and "key" in i for i in new)
    ):
        # headers 等 [{key, value}] 结构按 key 对齐，避免顺序变化错位
        old_by_key = {i.get("key"): i for i in old if isinstance(i, dict)}
        return [_merge_redacted(item, old_by_key.get(item.get("key"))) for item in new]
    return new


def _contains_redacted(value: Any) -> bool:
    """判断配置中是否含脱敏占位符（新建时需提示用户补齐密钥）。"""
    if value == _REDACTED:
        return True
    if isinstance(value, dict):
        return any(_contains_redacted(v) for v in value.values())
    if isinstance(value, list):
        return any(_contains_redacted(v) for v in value)
    return False


def _strip_redacted(value: Any) -> Any:
    """新建工具时无旧值可复用，占位符置空由用户回填。"""
    if value == _REDACTED:
        return ""
    if isinstance(value, dict):
        return {k: _strip_redacted(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_strip_redacted(v) for v in value]
    return value


def _propagate_tool_rename(db: Session, old_name: str, new_name: str) -> list[str]:
    """工具改名后同步更新智能体里的名称引用，返回受影响的智能体名列表。

    ``enabled_tools`` 存工具名数组、``tool_configs`` 以工具名为 key，二者都
    需同步；否则改名会留下悬挂引用，导致智能体静默少一个工具。
    """
    affected: list[str] = []
    for agent in db.query(Agent).all():
        changed = False
        tools = agent.enabled_tools or []
        if old_name in tools:
            agent.enabled_tools = [new_name if t == old_name else t for t in tools]
            changed = True
        configs = dict(agent.tool_configs or {})
        if old_name in configs:
            configs[new_name] = configs.pop(old_name)
            agent.tool_configs = configs
            changed = True
        if changed:
            affected.append(agent.name or f"#{agent.id}")
    return affected


def _remove_tool_refs(db: Session, name: str) -> list[str]:
    """删除工具后从智能体中移除名称引用，返回受影响的智能体名列表。"""
    affected: list[str] = []
    for agent in db.query(Agent).all():
        changed = False
        tools = agent.enabled_tools or []
        if name in tools:
            agent.enabled_tools = [t for t in tools if t != name]
            changed = True
        configs = dict(agent.tool_configs or {})
        if name in configs:
            configs.pop(name, None)
            agent.tool_configs = configs
            changed = True
        if changed:
            affected.append(agent.name or f"#{agent.id}")
    return affected


# ---------------------------------------------------------------------------
# 工具版本快照（编辑前存档 + 一键回滚）
# ---------------------------------------------------------------------------
# 快照保存工具全部可编辑字段。回滚时用这些字段覆盖当前工具，
# 若含改名则复用 _propagate_tool_rename 同步智能体引用。
_TOOL_VERSION_FIELDS = (
    "name", "description", "parameters_schema", "code",
    "enabled", "tool_type", "category", "tags", "http_config", "status",
)

# 触发版本快照的「内容」字段：enabled 是运行开关，频繁切换不应产生快照。
_CONTENT_FIELDS = (
    "name", "description", "parameters_schema", "code",
    "tool_type", "category", "tags", "http_config", "status",
)


def _snapshot_tool(tool: Tool) -> dict:
    """深拷贝工具可编辑字段，避免 JSON 列原位修改反向污染存档。"""
    return {field: copy.deepcopy(getattr(tool, field)) for field in _TOOL_VERSION_FIELDS}


def _save_tool_version(db: Session, tool: Tool, created_by: str | None) -> ToolVersion:
    """为工具的「当前状态」落一条版本快照，版本号取现有最大版本 +1。

    在 ``update_tool`` 覆盖字段前调用，保证每次编辑都能回退到上一次内容。
    """
    max_row = (
        db.query(func.max(ToolVersion.version))
        .filter(ToolVersion.tool_id == tool.id)
        .scalar()
    )
    version = (max_row or 0) + 1
    snap = ToolVersion(
        tool_id=tool.id,
        version=version,
        snapshot=_snapshot_tool(tool),
        created_by=created_by,
    )
    db.add(snap)
    return snap


def _tool_version_payload(v: ToolVersion, with_snapshot: bool = False) -> dict:
    """序列化版本存档。列表页默认不带 snapshot（瘦身），详情页带上。"""
    payload = {
        "id": v.id,
        "tool_id": v.tool_id,
        "version": v.version,
        "created_by": v.created_by,
        "created_at": v.created_at.isoformat() if v.created_at is not None else None,
    }
    if with_snapshot:
        payload["snapshot"] = v.snapshot
    return payload


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
    # 批量聚合各工具的调用统计（来自 chat_messages 的 tool 消息），用于健康度展示：
    # total_calls=0 为僵尸工具、failed_calls 占比高为疑似坏工具。
    from app.models.chat_message import ChatMessage

    # 健康度只统计最近 90 天：既让「健康度」反映近期状态，也避免对 content 做
    # 全历史 LIKE 前导通配扫描（该模式无法走 B-tree 索引，量大时是列表页瓶颈）。
    # 用 DB 侧 func.now() 计算窗口，避免应用与数据库时钟不一致。
    health_since = func.now() - text("interval '90 days'")

    call_rows = (
        db.query(ChatMessage.name, func.count(ChatMessage.id), func.max(ChatMessage.created_at))
        .filter(ChatMessage.role == "tool", ChatMessage.name != "", ChatMessage.created_at >= health_since)
        .group_by(ChatMessage.name)
        .all()
    )
    # 失败判定为启发式：工具失败时结果为 {"error": ...} 序列化文本，按 "error" 子串匹配
    fail_rows = (
        db.query(ChatMessage.name, func.count(ChatMessage.id))
        .filter(
            ChatMessage.role == "tool",
            ChatMessage.name != "",
            ChatMessage.created_at >= health_since,
            ChatMessage.content.like('%"error"%'),
        )
        .group_by(ChatMessage.name)
        .all()
    )
    calls_map = {name: {"total": total, "last_called_at": last} for name, total, last in call_rows}
    fails_map = {name: cnt for name, cnt in fail_rows}
    # 资源级 owner 控制：批量查共享授权集合，admin 在调用处直接判 True
    shared_ids = compute_can_edit_ids(db, current_user, "tool", [t.id for t in tools])
    for item, tool in zip(result, tools):
        name = item.get("name", "")
        refs = tool_name_to_agents.get(name, [])
        item["reference_count"] = len(refs)
        item["referenced_by"] = refs
        item["can_edit"] = resource_can_edit(current_user, db, tool, shared_ids)
        stats = calls_map.get(name, {})
        last = stats.get("last_called_at")
        item["stats"] = {
            "total_calls": stats.get("total", 0),
            "failed_calls": fails_map.get(name, 0),
            "last_called_at": last.isoformat() if last is not None else None,
        }
    return result


@router.get("/templates", dependencies=[Depends(require_permission("tool", "view"))])
def list_tool_templates() -> list[dict]:
    """返回内置工具模板（供新建参考）。"""
    logger.info("查询工具模板")
    return [dict(tpl) for tpl in TOOL_TEMPLATES]


@router.get("/categories", dependencies=[Depends(require_permission("tool", "view"))])
def list_tool_categories() -> list[dict]:
    """返回工具分类树（顶层分组 + 叶子分类），供前端 optgroup 展示。"""
    return CATEGORY_TREE


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


@router.get("/export", dependencies=[Depends(require_permission("tool", "export"))])
def export_tools(
    ids: str | None = None,
    include_preset: bool = False,
    include_secrets: bool = False,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """导出工具配置为可迁移 JSON（用于跨环境部署/备份）。

    - ``ids``：逗号分隔的工具 ID；缺省导出全部（默认可编辑的自定义工具）
    - ``include_secrets``：默认脱敏 token/secret/apikey/headers 等敏感值，
      导出文件可安全入库；仅管理员可导出明文
    """
    if include_secrets and not is_admin(current_user, db):
        raise HTTPException(status_code=403, detail="仅管理员可导出含密钥的工具配置")
    query = db.query(Tool)
    if ids:
        try:
            id_list = [int(i) for i in ids.split(",") if i.strip()]
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="ids 需为逗号分隔的整数") from exc
        if not id_list:
            raise HTTPException(status_code=400, detail="ids 为空")
        query = query.filter(Tool.id.in_(id_list))
    # ids 同样受 include_preset 约束：预置工具重复导入会被拒绝，导出也不默认包含
    if not include_preset:
        query = query.filter(Tool.is_preset.is_(False))
    tools = query.order_by(Tool.id.asc()).all()
    items = []
    for tool in tools:
        item = {field: getattr(tool, field) for field in _EXPORT_FIELDS}
        if not include_secrets:
            item["http_config"] = _redact_secrets(item.get("http_config"))
        items.append(item)
    logger.info("导出工具: count=%d, include_secrets=%s", len(items), include_secrets)
    return {
        "schema_version": 1,
        "exported_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "include_secrets": include_secrets,
        "tools": items,
    }


@router.post("/import", dependencies=[Depends(require_permission("tool", "import"))])
def import_tools(
    body: ToolImportRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """导入工具配置（兼容导出文件整体或仅 ``tools`` 数组）。

    - 按 ``name`` 匹配：已存在默认跳过，``overwrite=true`` 时覆盖
    - 覆盖时导出文件中的脱敏占位符沿用库中已有密钥，不会被清空
    - 与平台预置工具重名、框架内置工具均拒绝导入，避免污染种子
    """
    if not body.tools:
        raise HTTPException(status_code=400, detail="tools 为空")
    preset_index = ToolCatalog.preset_name_index()
    result: dict[str, Any] = {"created": 0, "updated": 0, "skipped": 0, "failed": [], "warnings": []}
    for raw in body.tools:
        name = str(raw.get("name") or "").strip()
        try:
            if not name:
                raise ValueError("缺少 name")
            tool_type = str(raw.get("tool_type") or "code")
            if tool_type not in ("code", "http"):
                raise ValueError(f"不支持导入 tool_type={tool_type}")
            if preset_index.get(name):
                raise ValueError("与平台预置工具重名")
            existing = db.query(Tool).filter(Tool.name == name).first()
            if existing is not None and not body.overwrite:
                result["skipped"] += 1
                continue
            if existing is not None:
                if getattr(existing, "is_preset", False):
                    raise ValueError("内置工具不可被导入覆盖")
                check_resource_ownership(current_user, db, "tool", existing.id, existing)
                # 仅覆盖导入文件中显式提供的字段：缺失字段保留库中现值，
                # 避免手工裁剪过的文件把已有配置（尤其 http_config 密钥）静默清空
                if "description" in raw:
                    existing.description = raw.get("description") or ""
                if "parameters_schema" in raw:
                    existing.parameters_schema = raw.get("parameters_schema")
                if "code" in raw:
                    existing.code = raw.get("code") or ""
                if "enabled" in raw:
                    existing.enabled = bool(raw.get("enabled"))
                if "tool_type" in raw:
                    existing.tool_type = tool_type
                if "category" in raw:
                    existing.category = raw.get("category")
                if "tags" in raw:
                    existing.tags = raw.get("tags")
                # 脱敏占位符回填库中旧值，避免覆盖时把密钥清空
                if "http_config" in raw:
                    existing.http_config = _merge_redacted(raw.get("http_config"), existing.http_config)
                if not body.dry_run:
                    db.commit()
                    clear_tool_cache(name)
                result["updated"] += 1
            else:
                if _contains_redacted(raw.get("http_config")):
                    result["warnings"].append(f"{name}: 密钥字段已脱敏，请在编辑页补齐后再启用")
                tool = Tool(
                    name=name,
                    description=raw.get("description") or "",
                    parameters_schema=raw.get("parameters_schema"),
                    code=raw.get("code") or "",
                    enabled=bool(raw.get("enabled", True)),
                    tool_type=tool_type,
                    category=raw.get("category"),
                    tags=raw.get("tags"),
                    http_config=_strip_redacted(raw.get("http_config")),
                    tool_source=TOOL_SOURCE_CUSTOM,
                    created_by=current_user.id,
                )
                db.add(tool)
                if not body.dry_run:
                    db.commit()
                result["created"] += 1
        except HTTPException as exc:
            # 单个工具无权限/被拒绝时不影响其余工具导入
            db.rollback()
            result["failed"].append({"name": name or "(未命名)", "error": exc.detail})
        except Exception as exc:  # noqa: BLE001
            db.rollback()
            logger.warning("导入工具失败: name=%s, err=%s", name or "(未命名)", exc)
            result["failed"].append({"name": name or "(未命名)", "error": str(exc)})
    logger.info(
        "导入工具完成: created=%d, updated=%d, skipped=%d, failed=%d",
        result["created"], result["updated"], result["skipped"], len(result["failed"]),
    )
    return result


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
        status=_normalize_status(body.status),
        tool_type=body.tool_type or "code",
        category=_normalize_category(body.category),
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
    old_name = tool.name
    new_status = _normalize_status(body.status)
    new_category = _normalize_category(body.category)
    # 内容是否变化（不含 enabled 开关，避免频繁 toggle 产生无意义快照）
    content_changed = (
        tool.name != body.name
        or (tool.description or "") != (body.description or "")
        or tool.parameters_schema != body.parameters_schema
        or (tool.code or "") != (body.code or "")
        or (tool.tool_type or "code") != (body.tool_type or "code")
        or tool.category != new_category
        or tool.http_config != body.http_config
        or tool.tags != body.tags
        or tool.status != new_status
    )
    # 仅在内容真正变化时存档，保证误改后可一键回退；toggle 开关不产生快照
    if content_changed:
        _save_tool_version(db, tool, getattr(current_user, "username", None))
    tool.name = body.name
    tool.description = body.description
    tool.parameters_schema = body.parameters_schema
    tool.code = body.code
    tool.enabled = body.enabled
    tool.status = new_status
    tool.tool_type = body.tool_type or "code"
    tool.category = new_category
    tool.http_config = body.http_config
    tool.tags = body.tags
    # 改名时同步更新智能体里的名称引用（enabled_tools / tool_configs），
    # 避免改名后智能体出现悬挂引用、静默丢失该工具
    affected = _propagate_tool_rename(db, old_name, body.name) if old_name != body.name else []
    db.commit()
    db.refresh(tool)
    # 清除该工具的运行时缓存，确保下次加载新代码/配置（旧名缓存一并清除）
    clear_tool_cache(tool.name)
    if old_name != body.name:
        clear_tool_cache(old_name)
    logger.info("工具已更新: id=%s, affected_agents=%d", tool.id, len(affected))
    result = to_dict(tool)
    result["affected_agents"] = affected
    return result


@router.delete("/{tool_id:int}", dependencies=[Depends(require_permission("tool", "delete"))])
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
    # 删除前先从智能体中移除名称引用（enabled_tools / tool_configs），
    # 返回受影响智能体列表供前端提示「已从 N 个智能体移除该工具」
    affected = _remove_tool_refs(db, name)
    db.delete(tool)
    db.commit()
    clear_tool_cache(name)
    logger.info("工具已删除: id=%s, affected_agents=%d", tool_id, len(affected))
    return {"ok": True, "affected_agents": affected}


# ============ 工具版本管理（快照 + 一键回滚） ============

@router.get("/{tool_id:int}/versions", dependencies=[Depends(require_permission("tool", "view"))])
def list_tool_versions(tool_id: int, db: Session = Depends(get_db)) -> dict:
    """版本存档列表（摘要，不含 snapshot 主体），按版本号倒序。"""
    tool = db.query(Tool).filter(Tool.id == tool_id).first()
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool not found")
    rows = (
        db.query(ToolVersion)
        .filter(ToolVersion.tool_id == tool_id)
        .order_by(ToolVersion.version.desc())
        .all()
    )
    return {"items": [_tool_version_payload(v) for v in rows]}


@router.get("/{tool_id:int}/versions/{version:int}", dependencies=[Depends(require_permission("tool", "view"))])
def get_tool_version(tool_id: int, version: int, db: Session = Depends(get_db)) -> dict:
    """版本存档详情（含完整 snapshot，供前端对比）。"""
    tool = db.query(Tool).filter(Tool.id == tool_id).first()
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool not found")
    snap = (
        db.query(ToolVersion)
        .filter(ToolVersion.tool_id == tool_id, ToolVersion.version == version)
        .first()
    )
    if snap is None:
        raise HTTPException(status_code=404, detail="版本不存在")
    return _tool_version_payload(snap, with_snapshot=True)


@router.post("/{tool_id:int}/versions/{version:int}/rollback", dependencies=[Depends(require_permission("tool", "edit"))])
def rollback_tool_version(
    tool_id: int,
    version: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    """回滚到指定历史版本：用存档内容覆盖当前工具的可编辑字段。

    若存档中的工具名与当前名不同，复用改名同步逻辑，保证智能体引用不悬挂。
    """
    logger.info("回滚工具版本: id=%s → v%s", tool_id, version)
    tool = db.query(Tool).filter(Tool.id == tool_id).first()
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool not found")
    check_resource_ownership(current_user, db, "tool", tool_id, tool)
    snap = (
        db.query(ToolVersion)
        .filter(ToolVersion.tool_id == tool_id, ToolVersion.version == version)
        .first()
    )
    if snap is None:
        raise HTTPException(status_code=404, detail="版本不存在")

    old_name = tool.name
    data = snap.snapshot or {}
    # 覆盖可编辑字段；缺失字段保留当前值（与导入覆盖策略一致，避免旧快照清空新字段）
    for field in _TOOL_VERSION_FIELDS:
        if field in data:
            setattr(tool, field, copy.deepcopy(data[field]))

    # 改名时同步智能体引用
    affected = _propagate_tool_rename(db, old_name, tool.name) if old_name != tool.name else []
    db.commit()
    db.refresh(tool)
    clear_tool_cache(tool.name)
    if old_name != tool.name:
        clear_tool_cache(old_name)
    logger.info("工具已回滚: id=%s → v%s, affected_agents=%d", tool.id, version, len(affected))
    result = to_dict(tool)
    result["affected_agents"] = affected
    result["rolled_back_from"] = version
    return result


@router.post("/{tool_id:int}/test")
async def test_tool(
    tool_id: int,
    body: ToolTestRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(require_permission("tool", "execute")),
) -> dict:
    """测试执行工具，返回结果与日志。

    鉴权：需 ``tool:execute`` 权限 + 资源级 owner 校验（工具代码在沙箱执行，
    防止任意登录用户执行他人工具读写数据/触发封禁）。

    自动按 ``tool_type`` 路由：code 工具走沙箱执行，http 工具走 HTTP 请求。
    对 HTTP 工具，通过 ``log_handler`` 回传「参数分发 / 实际请求 URL / 响应状态」
    等执行链路日志，避免展示未渲染的 URL 模板造成误导。
    """
    logger.info("测试工具: id=%s, params=%s", tool_id, body.parameters)
    tool = db.query(Tool).filter(Tool.id == tool_id).first()
    if tool is None:
        raise HTTPException(status_code=404, detail="Tool not found")
    # 资源级 owner 校验：仅 admin/owner/被授权用户可测试执行
    check_resource_ownership(current_user, db, "tool", tool_id, tool)
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

    result = await run_tool(tool, body.parameters, log_handler=log_handler)
    if "error" in result:
        logs.append({"level": "error", "message": f"执行失败: {result['error']}"})
    else:
        logs.append({"level": "info", "message": f"执行成功: {result.get('result')}"})
    return {"result": result.get("result"), "logs": logs, "raw": result}


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


@router.post("/import-openapi", dependencies=[Depends(require_permission("tool", "import"))])
async def import_openapi(body: OpenAPIImportRequest) -> dict:
    """解析 OpenAPI/Swagger JSON（或从 URL 拉取），返回操作列表供前端选择。

    不会直接创建工具——前端选定操作后，把该操作的配置填入表单再保存。
    """
    logger.info("导入 OpenAPI: has_spec=%s, url=%s", bool(body.spec), body.url)
    spec_text = body.spec or ""
    if not spec_text and body.url:
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
        raise HTTPException(status_code=500, detail=f"LLM 调用失败（{type(exc).__name__}），详情见服务日志") from exc

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
        raise HTTPException(status_code=500, detail=f"LLM 调用失败（{type(exc).__name__}），详情见服务日志") from exc

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
        raise HTTPException(status_code=500, detail=f"对话调试失败（{type(exc).__name__}），详情见服务日志") from exc

    return {
        "response": result.response or "",
        "messages": result.messages or [],
        "logs": [],
    }
