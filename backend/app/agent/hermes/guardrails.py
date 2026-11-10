"""工具循环守卫 —— 移植自 Hermes ``agent/tool_guardrails.py``。

检测 Agent 陷入工具调用死循环：
- **exact_failure**：相同工具 + 相同参数反复失败（典型：参数错误不改正就重试）
- **same_tool_failure**：同一工具反复失败（不同参数，但策略未变）
- **idempotent_no_progress**：幂等工具反复返回相同结果（无进展循环）

SOAR 场景尤其重要：``block_ip`` / ``send_notification`` / ``device_action``
等写工具一旦循环，后果严重（重复封禁、重复通知、设备状态混乱）。

决策类型（与 Hermes 一致）：

- ``allow``：正常执行
- ``warn``：执行但追加警告到结果，引导 LLM 改变策略
- ``block``：阻断本次调用，返回 synthetic 错误结果（不计入迭代预算）
- ``halt``：终止整个 turn（严重循环，防止资源耗尽）

设计原则（与 Hermes 一致）：

1. **无副作用**：控制器只跟踪观察、返回决策，不直接执行阻断/警告。
   运行时代码（``tool_engine``）负责把决策变成警告文本、合成结果或 turn 终止。
2. **signature 哈希**：用工具名 + 参数规范哈希做身份，不存原始参数值
   （隐私 + 节省内存）。
3. **可配置阈值**：warn_after / block_after / halt_after 可调，默认保守
   （warn 默认开，hard_stop 默认关，交互场景给温和提示）。
4. **per-turn 重置**：每个 turn 开始调 ``reset_for_turn()``，跨 turn 不累积。
5. **refund 机制**：被 block 的调用不计入迭代预算（``budget.refund()``）。
"""
from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

from app.agent.hermes.tool_result_classification import (
    SOAR_WRITE_TOOL_NAMES,
    NO_EFFECT_TOOL_NAMES,
    classify_tool_failure,
    file_mutation_result_landed,
)

logger = logging.getLogger(__name__)


# 幂等工具集（只读查询，可安全重试）—— 与 tool_result_classification 一致
IDEMPOTENT_TOOL_NAMES = NO_EFFECT_TOOL_NAMES

# 变更工具集（写操作，重试需谨慎）—— SOAR 写工具
MUTATING_TOOL_NAMES = SOAR_WRITE_TOOL_NAMES


@dataclass(frozen=True)
class ToolCallGuardrailConfig:
    """per-turn 工具调用循环检测阈值。

    警告默认开启且永不阻止工具执行。硬停止需显式 opt-in，
    这样交互式会话得到温和提示，除非用户在配置中启用断路器行为。
    """

    warnings_enabled: bool = True
    hard_stop_enabled: bool = False
    exact_failure_warn_after: int = 2       # 相同调用失败 N 次后 warn
    exact_failure_block_after: int = 5      # 相同调用失败 N 次后 block
    same_tool_failure_warn_after: int = 3   # 同工具失败 N 次后 warn
    same_tool_failure_halt_after: int = 8   # 同工具失败 N 次后 halt
    no_progress_warn_after: int = 2         # 幂等工具无进展 N 次后 warn
    no_progress_block_after: int = 5        # 幂等工具无进展 N 次后 block
    idempotent_tools: frozenset[str] = field(default_factory=lambda: IDEMPOTENT_TOOL_NAMES)
    mutating_tools: frozenset[str] = field(default_factory=lambda: MUTATING_TOOL_NAMES)

    @classmethod
    def from_mapping(cls, data: Mapping[str, Any] | None) -> "ToolCallGuardrailConfig":
        """从配置字典构建（Agent.tool_configs.guardrails 段）。"""
        if not isinstance(data, Mapping):
            return cls()

        warn_after = data.get("warn_after", {})
        if not isinstance(warn_after, Mapping):
            warn_after = {}
        hard_stop_after = data.get("hard_stop_after", {})
        if not isinstance(hard_stop_after, Mapping):
            hard_stop_after = {}

        defaults = cls()
        return cls(
            warnings_enabled=_as_bool(data.get("warnings_enabled"), defaults.warnings_enabled),
            hard_stop_enabled=_as_bool(data.get("hard_stop_enabled"), defaults.hard_stop_enabled),
            exact_failure_warn_after=_positive_int(
                warn_after.get("exact_failure", data.get("exact_failure_warn_after")),
                defaults.exact_failure_warn_after,
            ),
            same_tool_failure_warn_after=_positive_int(
                warn_after.get("same_tool_failure", data.get("same_tool_failure_warn_after")),
                defaults.same_tool_failure_warn_after,
            ),
            no_progress_warn_after=_positive_int(
                warn_after.get("idempotent_no_progress", data.get("no_progress_warn_after")),
                defaults.no_progress_warn_after,
            ),
            exact_failure_block_after=_positive_int(
                hard_stop_after.get("exact_failure", data.get("exact_failure_block_after")),
                defaults.exact_failure_block_after,
            ),
            same_tool_failure_halt_after=_positive_int(
                hard_stop_after.get("same_tool_failure", data.get("same_tool_failure_halt_after")),
                defaults.same_tool_failure_halt_after,
            ),
            no_progress_block_after=_positive_int(
                hard_stop_after.get("idempotent_no_progress", data.get("no_progress_block_after")),
                defaults.no_progress_block_after,
            ),
        )


@dataclass(frozen=True)
class ToolCallSignature:
    """工具名 + 规范参数的稳定、不可逆身份。

    用 SHA256 哈希参数，不存原始值（隐私 + 内存）。
    """

    tool_name: str
    args_hash: str

    @classmethod
    def from_call(cls, tool_name: str, args: Mapping[str, Any] | None) -> "ToolCallSignature":
        canonical = canonical_tool_args(args or {})
        return cls(tool_name=tool_name, args_hash=_sha256(canonical))

    def to_metadata(self) -> dict[str, str]:
        """返回公开元数据（不含原始参数值）。"""
        return {"tool_name": self.tool_name, "args_hash": self.args_hash}


@dataclass(frozen=True)
class ToolGuardrailDecision:
    """守卫控制器返回的决策。"""

    action: str = "allow"  # allow | warn | block | halt
    code: str = "allow"
    message: str = ""
    tool_name: str = ""
    count: int = 0
    signature: Optional[ToolCallSignature] = None

    @property
    def allows_execution(self) -> bool:
        return self.action in {"allow", "warn"}

    @property
    def should_halt(self) -> bool:
        return self.action in {"block", "halt"}

    def to_metadata(self) -> dict[str, Any]:
        data: dict[str, Any] = {
            "action": self.action,
            "code": self.code,
            "message": self.message,
            "tool_name": self.tool_name,
            "count": self.count,
        }
        if self.signature is not None:
            data["signature"] = self.signature.to_metadata()
        return data


def canonical_tool_args(args: Mapping[str, Any]) -> str:
    """返回排序后的紧凑 JSON，用于参数身份哈希。"""
    if not isinstance(args, Mapping):
        raise TypeError(f"tool args 必须是 mapping，得到 {type(args).__name__}")
    return json.dumps(
        args,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )


class ToolCallGuardrailController:
    """per-turn 控制器：跟踪工具调用观察，返回决策。

    用法（在 ``tool_engine._execute_one`` 中）::

        # before
        decision = controller.before_call(tc.name, tc.arguments)
        if decision.should_halt:
            return synthetic_error_result(decision)
        # ... 执行工具 ...
        # after
        decision = controller.after_call(tc.name, tc.arguments, result, failed=is_error)
        if decision.action == "warn":
            result = append_toolguard_guidance(result, decision)
    """

    def __init__(self, config: ToolCallGuardrailConfig | None = None):
        self.config = config or ToolCallGuardrailConfig()
        self.reset_for_turn()

    def reset_for_turn(self) -> None:
        """每个 turn 开始时重置所有计数器。"""
        self._exact_failure_counts: dict[ToolCallSignature, int] = {}
        self._same_tool_failure_counts: dict[str, int] = {}
        # signature -> (result_hash, repeat_count)
        self._no_progress: dict[ToolCallSignature, tuple[str, int]] = {}
        # signature -> 成功结果内容（同 turn 相同参数重复调用时直接复用）
        self._successful_results: dict[ToolCallSignature, str] = {}
        self._halt_decision: Optional[ToolGuardrailDecision] = None

    def recall_success(self, signature: ToolCallSignature | None) -> Optional[str]:
        """返回同 turn 内相同签名已成功的结果；没有则返回 None。"""
        if signature is None:
            return None
        return self._successful_results.get(signature)

    def remember_success(self, signature: ToolCallSignature | None, content: str) -> None:
        """记录一次成功调用，供同 turn 内相同参数复用（避免重复下发）。"""
        if signature is None or not content:
            return
        self._successful_results[signature] = content

    @property
    def halt_decision(self) -> Optional[ToolGuardrailDecision]:
        """一旦触发 halt，整个 turn 应终止。"""
        return self._halt_decision

    def before_call(
        self, tool_name: str, args: Mapping[str, Any] | None
    ) -> ToolGuardrailDecision:
        """调用前检查：是否应阻断本次调用。"""
        signature = ToolCallSignature.from_call(tool_name, _coerce_args(args))
        if not self.config.hard_stop_enabled:
            return ToolGuardrailDecision(tool_name=tool_name, signature=signature)

        exact_count = self._exact_failure_counts.get(signature, 0)
        if exact_count >= self.config.exact_failure_block_after:
            decision = ToolGuardrailDecision(
                action="block",
                code="repeated_exact_failure_block",
                message=(
                    f"已阻断 {tool_name}：相同调用已失败 {exact_count} 次（参数完全一致）。"
                    "请停止原样重试，改变策略或说明阻碍原因。"
                ),
                tool_name=tool_name,
                count=exact_count,
                signature=signature,
            )
            self._halt_decision = decision
            return decision

        if self._is_idempotent(tool_name):
            record = self._no_progress.get(signature)
            if record is not None:
                _result_hash, repeat_count = record
                if repeat_count >= self.config.no_progress_block_after:
                    decision = ToolGuardrailDecision(
                        action="block",
                        code="idempotent_no_progress_block",
                        message=(
                            f"已阻断 {tool_name}：此只读调用已返回相同结果 {repeat_count} 次。"
                            "请停止重复，使用已有结果或换一个查询。"
                        ),
                        tool_name=tool_name,
                        count=repeat_count,
                        signature=signature,
                    )
                    self._halt_decision = decision
                    return decision

        return ToolGuardrailDecision(tool_name=tool_name, signature=signature)

    def after_call(
        self,
        tool_name: str,
        args: Mapping[str, Any] | None,
        result: Any,
        *,
        failed: bool | None = None,
    ) -> ToolGuardrailDecision:
        """调用后记录：更新计数器，返回追加指导决策。"""
        args = _coerce_args(args)
        signature = ToolCallSignature.from_call(tool_name, args)
        if failed is None:
            failed, _ = classify_tool_failure(tool_name, result)

        if failed:
            exact_count = self._exact_failure_counts.get(signature, 0) + 1
            self._exact_failure_counts[signature] = exact_count
            self._no_progress.pop(signature, None)

            same_count = self._same_tool_failure_counts.get(tool_name, 0) + 1
            self._same_tool_failure_counts[tool_name] = same_count

            # 同工具失败达 halt 阈值 → 终止 turn
            if self.config.hard_stop_enabled and same_count >= self.config.same_tool_failure_halt_after:
                decision = ToolGuardrailDecision(
                    action="halt",
                    code="same_tool_failure_halt",
                    message=(
                        f"已停止 {tool_name}：本 turn 内失败 {same_count} 次。"
                        "请停止重试同一失败路径，选择不同方法。"
                    ),
                    tool_name=tool_name,
                    count=same_count,
                    signature=signature,
                )
                self._halt_decision = decision
                return decision

            # 相同调用失败达 warn 阈值 → 警告
            if self.config.warnings_enabled and exact_count >= self.config.exact_failure_warn_after:
                return ToolGuardrailDecision(
                    action="warn",
                    code="repeated_exact_failure_warning",
                    message=(
                        f"{tool_name} 已失败 {exact_count} 次（参数完全一致）。"
                        "这看起来像循环；请检查错误并改变策略，而非原样重试。"
                    ),
                    tool_name=tool_name,
                    count=exact_count,
                    signature=signature,
                )

            # 同工具失败达 warn 阈值 → 警告 + 恢复提示
            if self.config.warnings_enabled and same_count >= self.config.same_tool_failure_warn_after:
                return ToolGuardrailDecision(
                    action="warn",
                    code="same_tool_failure_warning",
                    message=_tool_failure_recovery_hint(tool_name, same_count),
                    tool_name=tool_name,
                    count=same_count,
                    signature=signature,
                )

            return ToolGuardrailDecision(tool_name=tool_name, count=exact_count, signature=signature)

        # 成功：清除失败计数
        self._exact_failure_counts.pop(signature, None)
        self._same_tool_failure_counts.pop(tool_name, None)

        # 幂等工具：检查无进展循环
        if not self._is_idempotent(tool_name):
            self._no_progress.pop(signature, None)
            return ToolGuardrailDecision(tool_name=tool_name, signature=signature)

        result_hash = _result_hash(result)
        previous = self._no_progress.get(signature)
        repeat_count = 1
        if previous is not None and previous[0] == result_hash:
            repeat_count = previous[1] + 1
        self._no_progress[signature] = (result_hash, repeat_count)

        if self.config.warnings_enabled and repeat_count >= self.config.no_progress_warn_after:
            return ToolGuardrailDecision(
                action="warn",
                code="idempotent_no_progress_warning",
                message=(
                    f"{tool_name} 已返回相同结果 {repeat_count} 次。"
                    "请使用已有结果或改变查询，而非原样重复。"
                ),
                tool_name=tool_name,
                count=repeat_count,
                signature=signature,
            )

        return ToolGuardrailDecision(tool_name=tool_name, count=repeat_count, signature=signature)

    def _is_idempotent(self, tool_name: str) -> bool:
        if tool_name in self.config.mutating_tools:
            return False
        return tool_name in self.config.idempotent_tools


def toolguard_synthetic_result(decision: ToolGuardrailDecision) -> str:
    """为被 block 的调用构造 synthetic role=tool 内容。"""
    return json.dumps(
        {
            "error": decision.message,
            "guardrail": decision.to_metadata(),
            "blocked": True,
        },
        ensure_ascii=False,
    )


def append_toolguard_guidance(result: Any, decision: ToolGuardrailDecision) -> Any:
    """把运行时指导追加到当前工具结果内容。

    保持原结果类型：str 追加 str，dict 加 ``_guardrail`` 字段。
    """
    if decision.action not in {"warn", "halt"} or not decision.message:
        return result

    label = "工具循环硬停止" if decision.action == "halt" else "工具循环警告"
    suffix = f"\n\n[{label}: {decision.code}; count={decision.count}; {decision.message}]"

    if isinstance(result, str):
        return result + suffix
    if isinstance(result, dict):
        result = dict(result)
        result["_guardrail"] = decision.to_metadata()
        return result
    return result


def _tool_failure_recovery_hint(tool_name: str, count: int) -> str:
    """针对重复失败的工具给出行动导向的恢复提示。"""
    common = (
        f"{tool_name} 本 turn 已失败 {count} 次，这看起来像循环。"
        "不要切换为纯文本回复；继续用工具，但重试前先诊断。"
        "首先检查最新错误/输出，验证你的假设。"
    )
    if tool_name == "block_ip":
        return common + (
            "封禁失败时，先检查 IP 格式是否合法、是否在白名单、设备是否在线。"
            "尝试更窄的参数（单个 IP 而非网段），或换 check_whitelist 确认。"
        )
    if tool_name == "get_threat_intel":
        return common + (
            "威胁情报查询失败时，先检查 IP/域名格式，确认 API-TOKEN 已配置。"
            "尝试查询单个指标而非批量。"
        )
    if tool_name in ("search_knowledge_base", "query_kb_file"):
        return common + (
            "知识库查询失败时，先检查知识库 ID 是否正确、文档是否已就绪。"
            "尝试更简单的关键词，或换 search_knowledge_base 做模糊检索。"
        )
    return common + (
        "尝试不同参数、更窄的查询/路径、或换一个能取得进展的工具。"
        "若阻碍是外部的，做一次诊断尝试后报告阻碍，而非重复同一失败路径。"
    )


def _coerce_args(args: Mapping[str, Any] | None) -> Mapping[str, Any]:
    return args if isinstance(args, Mapping) else {}


def _result_hash(result: Any) -> str:
    """对工具结果做稳定哈希，用于无进展检测。"""
    if isinstance(result, (dict, list)):
        try:
            canonical = json.dumps(
                result, ensure_ascii=False, sort_keys=True,
                separators=(",", ":"), default=str,
            )
        except TypeError:
            canonical = str(result)
    else:
        canonical = str(result or "")
    return _sha256(canonical)


def _as_bool(value: Any, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"1", "true", "yes", "on", "enabled"}:
            return True
        if lowered in {"0", "false", "no", "off", "disabled"}:
            return False
    return default


def _positive_int(value: Any, default: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return parsed if parsed >= 1 else default


def _sha256(value: str) -> str:
    # surrogatepass：工具结果可能含未配对 UTF-16 代理对（如数学粗体对的一半）；
    # 严格 encode 会抛异常并拖垮整个对话循环。哈希只需确定性字节，不需合法 UTF-8。
    return hashlib.sha256(value.encode("utf-8", "surrogatepass")).hexdigest()


__all__ = [
    "IDEMPOTENT_TOOL_NAMES",
    "MUTATING_TOOL_NAMES",
    "ToolCallGuardrailConfig",
    "ToolCallSignature",
    "ToolGuardrailDecision",
    "ToolCallGuardrailController",
    "canonical_tool_args",
    "toolguard_synthetic_result",
    "append_toolguard_guidance",
]
