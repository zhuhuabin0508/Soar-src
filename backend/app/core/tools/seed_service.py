import ast
import logging

from sqlalchemy.orm import Session

from app.core.tools.catalog import ToolCatalog
from app.core.tools.types import TOOL_SOURCE_CUSTOM
from app.database import SessionLocal
from app.models.tool import Tool

logger = logging.getLogger(__name__)


def _code_has_imports(code: str) -> bool:
    if not code or not code.strip():
        return True
    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError:
        return True
    for node in ast.walk(tree):
        if isinstance(node, (ast.Import, ast.ImportFrom)):
            return True
    return False


def _cleanup_removed_and_legacy(db: Session) -> int:
    removed = 0
    for name in ToolCatalog.removed_names() | ToolCatalog.legacy_deprecated_names():
        existing = db.query(Tool).filter(Tool.name == name).first()
        if existing is not None:
            db.delete(existing)
            removed += 1
    legacy_dup = (
        db.query(Tool)
        .filter(Tool.name == "check_whitelist", Tool.is_preset.is_(False))
        .first()
    )
    if legacy_dup is not None:
        db.delete(legacy_dup)
        removed += 1
    return removed


def _prune_agent_tool_refs(db: Session, retired_names: set[str]) -> int:
    """从智能体的 ``enabled_tools`` / ``tool_configs`` 中摘除已退役工具名。

    工具从 ``tools`` 表物理删除后，智能体配置里仍可能残留旧名称；运行时会因
    查不到工具而反复输出 warning。此处按退役名单就地清理两处引用，
    返回被修改的智能体数量。

    Args:
        db: 数据库会话。
        retired_names: 已退役/遗留工具名集合。
    """
    if not retired_names:
        return 0
    from app.models.agent import Agent

    pruned = 0
    for agent in db.query(Agent).all():
        stale: set[str] = set()

        names = agent.enabled_tools
        if isinstance(names, list):
            kept = [n for n in names if n not in retired_names]
            if len(kept) != len(names):
                agent.enabled_tools = kept
                stale.update(n for n in names if n in retired_names)

        configs = agent.tool_configs
        if isinstance(configs, dict):
            kept_configs = {k: v for k, v in configs.items() if k not in retired_names}
            if len(kept_configs) != len(configs):
                agent.tool_configs = kept_configs
                stale.update(k for k in configs if k in retired_names)

        if stale:
            pruned += 1
            logger.info("智能体「%s」摘除已退役工具引用: %s", agent.name, sorted(stale))
    return pruned


def _sync_preset_tool(db: Session, defn: dict, seed_code_map: dict[str, str]) -> tuple[bool, bool, bool, bool, bool]:
    inserted = categorized = repaired = source_synced = desc_synced = False
    name = defn["name"]
    existing = db.query(Tool).filter(Tool.name == name).first()
    if existing is not None:
        if existing.category is None and defn.get("category"):
            existing.category = defn["category"]
            categorized = True
        if not getattr(existing, "is_preset", False):
            existing.is_preset = True
        expected_source = defn.get("tool_source")
        if expected_source and getattr(existing, "tool_source", None) != expected_source:
            existing.tool_source = expected_source
            source_synced = True
        # 预置工具的定义以目录为准：description / parameters_schema 变化时同步
        # （如 XDR 动作描述补充「计数首选」路由提示），避免 DB 行停留在旧文案
        if defn.get("description") and existing.description != defn["description"]:
            existing.description = defn["description"]
            desc_synced = True
        if defn.get("parameters_schema") and existing.parameters_schema != defn["parameters_schema"]:
            existing.parameters_schema = defn["parameters_schema"]
            desc_synced = True
        seed_code = seed_code_map.get(name)
        if (
            seed_code
            and (existing.tool_type or "code").lower() == "code"
            and existing.code != seed_code
            and _code_has_imports(existing.code or "")
        ):
            logger.warning("工具 %s 代码含 import 语句（沙箱禁止），自动修复为 seed 版本", name)
            existing.code = seed_code
            repaired = True
        return inserted, categorized, repaired, source_synced, desc_synced

    db.add(Tool(**defn))
    inserted = True
    return inserted, categorized, repaired, source_synced, desc_synced


def ensure_preset_tools() -> None:
    """幂等同步平台预置工具（内置 + 框架 + 安全），并清理退役/遗留工具。"""
    seed_code_map = ToolCatalog.seed_code_map()
    db: Session = SessionLocal()
    try:
        removed = _cleanup_removed_and_legacy(db)
        retired = ToolCatalog.removed_names() | ToolCatalog.legacy_deprecated_names()
        pruned = _prune_agent_tool_refs(db, retired)
        if removed or pruned:
            db.commit()
            logger.info(
                "已清理 %d 个退役/遗留工具，摘除 %d 个智能体的失效工具引用",
                removed,
                pruned,
            )

        inserted = categorized = repaired = source_synced = desc_synced = 0
        for defn in ToolCatalog.preset_definitions():
            ins, cat, rep, src, desc = _sync_preset_tool(db, defn, seed_code_map)
            inserted += int(ins)
            categorized += int(cat)
            repaired += int(rep)
            source_synced += int(src)
            desc_synced += int(desc)

        if inserted or categorized or repaired or source_synced or desc_synced:
            db.commit()
            logger.info(
                "工具目录同步: 新插入 %d，补充分类 %d，代码修复 %d，来源标记 %d，定义同步 %d（共 %d 个预置定义）",
                inserted,
                categorized,
                repaired,
                source_synced,
                desc_synced,
                len(ToolCatalog.preset_definitions()),
            )
        else:
            logger.debug(
                "工具目录同步: 全部 %d 个预置工具已存在且无需修复",
                len(ToolCatalog.preset_definitions()),
            )
    except Exception as exc:
        logger.exception("工具目录同步失败: %s", exc)
        db.rollback()
    finally:
        db.close()


def backfill_tool_sources(db: Session) -> int:
    """为历史用户工具补全 tool_source=custom，预置工具按目录回填。"""
    updated = 0
    for tool in db.query(Tool).all():
        expected = ToolCatalog.preset_source_for_name(tool.name)
        if expected:
            if tool.tool_source != expected or not tool.is_preset:
                tool.tool_source = expected
                tool.is_preset = True
                updated += 1
        elif not tool.tool_source:
            tool.tool_source = TOOL_SOURCE_CUSTOM
            updated += 1
    return updated


ensure_hermes_tools = ensure_preset_tools
ensure_security_tools = ensure_preset_tools
