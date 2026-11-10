"""JSON 容错与自动修复（对标 Hermes 鲁棒性）。

大模型有时会输出缺少括号或包含多余 markdown 标记的 JSON。
本模块提供 ``repair_json`` 函数，剥离围栏 + 平衡括号匹配 + 截断补全。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any, Optional

logger = logging.getLogger(__name__)

# ```json ... ``` 或 ``` ... ``` 围栏正则
_FENCE_PATTERN = re.compile(r"^\s*```(?:json)?\s*\n?(.*?)\n?\s*```\s*$", re.DOTALL | re.IGNORECASE)


def repair_json(text: str) -> Optional[str]:
    """容错抽取首个完整 JSON 对象。

    步骤：
    1. 去除 ```json ... ``` 围栏（若有）
    2. 调用 ``_extract_json_object_balanced``（带字符串感知的括号匹配）
    3. 若未闭合（截断），尝试补全：补全未闭合的 {/[/"，返回最佳猜测

    Returns:
        抽取出的 JSON 字符串（未解析）；无法抽取时返回 None。
    """
    if not text or not isinstance(text, str):
        return None

    # Step 1: 剥离 markdown 围栏
    stripped = _strip_markdown_fence(text)

    # Step 2: 平衡括号匹配抽取
    extracted = _extract_json_object_balanced(stripped)
    if extracted is not None:
        # 验证可解析（strict=False 容忍字符串内的裸换行等控制字符，
        # 部分模型输出的 arguments 不转义 \n，严格模式会整段解析失败）
        try:
            json.loads(extracted, strict=False)
            return extracted
        except json.JSONDecodeError:
            # 抽取出来但仍无法解析，尝试补全
            pass

    # Step 3: 截断补全
    completed = _complete_truncated_json(stripped)
    if completed is not None:
        try:
            json.loads(completed, strict=False)
            return completed
        except json.JSONDecodeError:
            return None

    return None


def parse_json_safely(text: str) -> tuple[dict, bool]:
    """安全解析 JSON，返回 (parsed_dict, malformed)。

    Args:
        text: 可能包含 JSON 的文本（可能带围栏/截断/多余字符）

    Returns:
        (解析后的 dict, 是否格式异常)。解析失败返回 ({}, True)。
    """
    if not text:
        return {}, True
    repaired = repair_json(text)
    if repaired is None:
        return {}, True
    try:
        result = json.loads(repaired, strict=False)
        if isinstance(result, dict):
            return result, False
        return {}, True
    except json.JSONDecodeError:
        return {}, True


def _strip_markdown_fence(text: str) -> str:
    """剥离 ```json...``` 或 ```...``` 围栏。"""
    match = _FENCE_PATTERN.match(text)
    if match:
        return match.group(1).strip()
    return text.strip()


def _extract_json_object_balanced(text: str) -> Optional[str]:
    """带字符串/转义感知的平衡括号抽取。

    复用 ``app.agent.decision._extract_json_object`` 的算法
    （已正确处理字符串与转义，避免字符串内的 {/} 干扰匹配）。
    """
    try:
        from app.agent.output_adapt import _extract_json_object
        return _extract_json_object(text)
    except ImportError:
        # 降级：简易平衡匹配（不处理字符串内的括号）
        return _simple_balanced_extract(text)


def _simple_balanced_extract(text: str) -> Optional[str]:
    """简易平衡括号匹配（降级方案，不处理字符串内括号）。"""
    start = text.find("{")
    if start == -1:
        return None
    depth = 0
    for idx in range(start, len(text)):
        ch = text[idx]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start : idx + 1]
    return None


def _complete_truncated_json(text: str) -> Optional[str]:
    """尝试补全被截断的 JSON（缺少闭合括号/引号）。

    策略：
    1. 找到第一个 { 开始位置
    2. 跟踪字符串状态与括号深度
    3. 在文本末尾补全缺失的 " / ] / }
    """
    start = text.find("{")
    if start == -1:
        return None

    fragment = text[start:]
    in_string = False
    escape = False
    stack: list[str] = []  # 括号栈：{ 或 [

    for ch in fragment:
        if in_string:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_string = False
        else:
            if ch == '"':
                in_string = True
            elif ch == "{":
                stack.append("}")
            elif ch == "[":
                stack.append("]")
            elif ch in ("}", "]"):
                if stack and stack[-1] == ch:
                    stack.pop()

    # 补全缺失的闭合符号
    completion = ""
    if in_string:
        completion += '"'
    # 反向补全栈中的闭合符号
    for closer in reversed(stack):
        completion += closer

    if not completion:
        return None

    completed = fragment + completion
    logger.debug("JSON 截断补全: 追加 %d 个字符", len(completion))
    return completed
