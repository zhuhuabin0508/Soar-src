"""工具分类树（可配置，无需新表）。

把原先自由字符串 ``category`` 收敛为一棵可配置的分类树：工具挂到「叶子分类」，
写工具时校验叶子合法，前端按层级（optgroup）展示，便于工具增多后按业务域归组。

设计取舍：分类树作为代码常量维护，而非独立 DB 表。理由：分类数量少、变更低频，
代码常量可评审、可版本控制，避免为「几十个分类」引入一张表 + 迁移 + CRUD 的复杂度。
若后续需要动态管理分类，再升级为表（``tool_categories``）即可，字段不变。

叶子 ``value`` 即落库到 ``tools.category`` 的值；``label`` 用于展示。
现有历史工具的分类值（如 ``security`` / ``file_operations``）均为叶子值，可直接
映射到树中，不产生迁移成本。
"""
from typing import Any

# 分类树：[{value, label, children?}]，children 为空/缺失表示叶子分类。
# 顶层 value 仅作分组，不落库；叶子 value 才是合法 category。
CATEGORY_TREE: list[dict[str, Any]] = [
    {
        "value": "security_ops",
        "label": "安全运营",
        "children": [
            {"value": "security", "label": "安全运营"},
            {"value": "threat_intel", "label": "威胁情报"},
            {"value": "blocking", "label": "封禁处置"},
            {"value": "asset", "label": "资产检索"},
        ],
    },
    {
        "value": "data_mgmt",
        "label": "数据与文件",
        "children": [
            {"value": "file_operations", "label": "文件操作"},
            {"value": "memory", "label": "记忆"},
        ],
    },
    {
        "value": "automation",
        "label": "自动化与任务",
        "children": [
            {"value": "cron_jobs", "label": "定时任务"},
            {"value": "task_planning", "label": "任务规划"},
            {"value": "task_delegation", "label": "任务委派"},
        ],
    },
    {
        "value": "interaction",
        "label": "交互与澄清",
        "children": [
            {"value": "clarifying_question", "label": "澄清提问"},
            {"value": "computer_use", "label": "计算机操作"},
        ],
    },
]

# 叶子分类 value → label（扁平化缓存）
_LEAF_MAP: dict[str, str] | None = None


def leaf_values() -> set[str]:
    """返回所有叶子分类的 value 集合。"""
    return set(leaf_map().keys())


def leaf_map() -> dict[str, str]:
    """返回 {叶子 value: label}，进程内缓存。"""
    global _LEAF_MAP
    if _LEAF_MAP is None:
        _LEAF_MAP = {}
        for group in CATEGORY_TREE:
            for child in group.get("children") or []:
                _LEAF_MAP[child["value"]] = child["label"]
    return _LEAF_MAP


def is_leaf_category(value: str | None) -> bool:
    """判断 value 是否为合法叶子分类。"""
    if not value:
        return False
    return value in leaf_values()


def category_label(value: str | None) -> str:
    """返回分类的展示名，未知分类回退为原值（历史数据兼容）。"""
    if not value:
        return ""
    return leaf_map().get(value, value)
