from typing import Any

from app.core.tools.definitions import (
    DEVICE_QUERY_TOOLS,
    HERMES_BUILTIN_TOOLS,
    HERMES_FRAMEWORK_TOOLS,
    LEGACY_DEPRECATED_TOOL_NAMES,
    REMOVED_BUILTIN_TOOLS,
    SECURITY_TOOLS,
    XDR_ACTION_TOOLS,
    XDR_TOOLS,
)
from app.core.tools.types import (
    TOOL_SOURCE_BUILTIN,
    TOOL_SOURCE_DEVICE,
    TOOL_SOURCE_FRAMEWORK,
    TOOL_SOURCE_SECURITY,
    ToolSource,
)


class ToolCatalog:
    """平台工具统一目录：内置 / 框架 / 安全 / 设备对接 / 用户自建 的唯一注册表。

    MCP 接入暂不实施，对外集成走 REST/Webhook + HTTP 工具；见 docs/soar-agent-v2-master-plan.md §九。
    """

    @staticmethod
    def _with_source(defn: dict[str, Any], source: ToolSource) -> dict[str, Any]:
        row = dict(defn)
        row["tool_source"] = source
        if source in (
            TOOL_SOURCE_BUILTIN,
            TOOL_SOURCE_FRAMEWORK,
            TOOL_SOURCE_SECURITY,
            TOOL_SOURCE_DEVICE,
        ):
            row["is_preset"] = True
        return row

    @classmethod
    def builtin_definitions(cls) -> list[dict[str, Any]]:
        return [
            cls._with_source(t, TOOL_SOURCE_BUILTIN)
            for t in HERMES_BUILTIN_TOOLS + XDR_TOOLS + XDR_ACTION_TOOLS
            if t["name"] not in REMOVED_BUILTIN_TOOLS
        ]

    @classmethod
    def framework_definitions(cls) -> list[dict[str, Any]]:
        return [
            cls._with_source(t, TOOL_SOURCE_FRAMEWORK)
            for t in HERMES_FRAMEWORK_TOOLS
            if t["name"] not in REMOVED_BUILTIN_TOOLS
        ]

    @classmethod
    def security_definitions(cls) -> list[dict[str, Any]]:
        return [cls._with_source(t, TOOL_SOURCE_SECURITY) for t in SECURITY_TOOLS]

    @classmethod
    def device_query_definitions(cls) -> list[dict[str, Any]]:
        """设备对接模块工具（如 query_device_actions 设备信息及动作查询）。"""
        return [cls._with_source(t, TOOL_SOURCE_DEVICE) for t in DEVICE_QUERY_TOOLS]

    @classmethod
    def preset_definitions(cls) -> list[dict[str, Any]]:
        return (
            cls.builtin_definitions()
            + cls.framework_definitions()
            + cls.security_definitions()
            + cls.device_query_definitions()
        )

    @classmethod
    def preset_name_index(cls) -> dict[str, dict[str, Any]]:
        return {t["name"]: t for t in cls.preset_definitions()}

    @classmethod
    def preset_source_for_name(cls, name: str) -> ToolSource | None:
        for source, defs in (
            (TOOL_SOURCE_BUILTIN, cls.builtin_definitions()),
            (TOOL_SOURCE_FRAMEWORK, cls.framework_definitions()),
            (TOOL_SOURCE_SECURITY, cls.security_definitions()),
            (TOOL_SOURCE_DEVICE, cls.device_query_definitions()),
        ):
            if any(t["name"] == name for t in defs):
                return source
        return None

    @classmethod
    def removed_names(cls) -> set[str]:
        return set(REMOVED_BUILTIN_TOOLS)

    @classmethod
    def legacy_deprecated_names(cls) -> set[str]:
        return set(LEGACY_DEPRECATED_TOOL_NAMES)

    @classmethod
    def seed_code_map(cls) -> dict[str, str]:
        return {
            t["name"]: t["code"]
            for t in cls.builtin_definitions()
            + cls.security_definitions()
            + cls.device_query_definitions()
            if t.get("tool_type", "code") != "framework" and t.get("code")
        }
