"""模型配置 reasoning_effort（推理模型思考深度）回归用例。

背景：资产管理智能体（agent id=5）使用 GLM-5.3-Flash 时思考耗时过长
（实测默认 ~350 reasoning tokens / 12-14s，DeepSeek-V4-Flash 仅 ~11s），
用户感知"卡住很久才开始回复"。

方案：llm_configs 新增 reasoning_effort 列（minimal/low/medium/high，NULL
不传用模型默认），经 create_llm_from_config 的 model_kwargs 透传到请求体
reasoning_effort（GLM-5.3-Flash 实测 low 将思考降至 ~40 tokens / 3.5s）；
executor 原生流式路径从 model_kwargs 读取后以顶层参数下发。

本用例覆盖配置 → LLM 实例 → 请求 payload 的透传链路（不依赖 DB / 真实 LLM）。
"""
from types import SimpleNamespace

import pytest

from app.core.llm_helper import create_llm_from_config
from app.api.v1.llm_config import LLMConfigBase


def _cfg(provider="other", model_name="GLM-5.3-Flash"):
    """构造最小 LLMConfig 替身（create_llm_from_config 仅读取这些字段）。"""
    return SimpleNamespace(
        api_key="sk-test-1234567890",
        base_url="http://10.0.0.1:3000/v1",
        model_name=model_name,
        provider=provider,
    )


def test_openai_compat_reasoning_effort_in_model_kwargs():
    """reasoning_effort='low' 必须进入 ChatOpenAI.model_kwargs。"""
    llm, info = create_llm_from_config(_cfg(), reasoning_effort="low")
    assert llm.model_kwargs.get("reasoning_effort") == "low"
    assert info["provider"] == "openai"


def test_openai_compat_reasoning_effort_in_request_payload():
    """model_kwargs 的 reasoning_effort 必须随 LangChain 请求体下发。"""
    llm, _ = create_llm_from_config(_cfg(), reasoning_effort="low")
    payload = llm._get_request_payload([{"role": "user", "content": "hi"}])
    assert payload.get("reasoning_effort") == "low"


def test_no_reasoning_effort_not_sent():
    """未配置（None）时不传，用模型默认值（按需启用模式）。"""
    llm, _ = create_llm_from_config(_cfg())
    assert "reasoning_effort" not in (llm.model_kwargs or {})
    payload = llm._get_request_payload([{"role": "user", "content": "hi"}])
    assert "reasoning_effort" not in payload


def test_anthropic_ignores_reasoning_effort():
    """Anthropic 不支持 reasoning_effort：忽略而非报错。"""
    from langchain_anthropic import ChatAnthropic

    llm, info = create_llm_from_config(_cfg(provider="anthropic"), reasoning_effort="low")
    assert isinstance(llm, ChatAnthropic)
    assert info["provider"] == "anthropic"


class TestAgentLevelPriority:
    """智能体维度深度思考参数的优先级：会话覆盖 > 智能体配置 > 模型高级参数。"""

    def _create_llm_with(self, monkeypatch, *, agent_effort, override_effort, model_effort):
        """打桩 _load_llm_config / create_llm_from_config，捕获下发值。"""
        import app.api.v1.agents as agents_mod
        import app.agent.decision as decision_mod
        import app.core.llm_helper as helper_mod

        cfg = SimpleNamespace(
            api_key="sk-test-1234567890",
            base_url="http://10.0.0.1:3000/v1",
            model_name="GLM-5.3-Flash",
            provider="other",
            reasoning_effort=model_effort,
        )
        captured = {}

        def fake_create_llm(c, **kwargs):
            captured.update(kwargs)
            return object(), {"provider": "openai", "model": c.model_name}

        # _create_llm 内部为函数级导入，需打桩源模块
        monkeypatch.setattr(decision_mod, "_load_llm_config", lambda db, cid: cfg)
        monkeypatch.setattr(helper_mod, "create_llm_from_config", fake_create_llm)

        agent = SimpleNamespace(
            model_config_id=3,
            temperature=0.7,
            max_tokens=1024,
            reasoning_effort=agent_effort,
        )
        override = (
            SimpleNamespace(
                model_config_id=None,
                temperature=None,
                max_tokens=None,
                reasoning_effort=override_effort,
                top_p=None,
                frequency_penalty=None,
                presence_penalty=None,
                seed=None,
            )
            if override_effort is not None else None
        )
        agents_mod._create_llm(agent, None, override)
        return captured.get("reasoning_effort")

    def test_agent_effort_wins_over_model_config(self, monkeypatch):
        """智能体配置 high 时优先于模型高级参数 low（差异化覆盖）。"""
        got = self._create_llm_with(
            monkeypatch, agent_effort="high", override_effort=None, model_effort="low"
        )
        assert got == "high"

    def test_agent_unset_falls_back_to_model_config(self, monkeypatch):
        """智能体未配置（None）时沿用模型高级参数的默认值。"""
        got = self._create_llm_with(
            monkeypatch, agent_effort=None, override_effort=None, model_effort="low"
        )
        assert got == "low"

    def test_session_override_wins(self, monkeypatch):
        """会话级覆盖优先于智能体配置与模型配置。"""
        got = self._create_llm_with(
            monkeypatch, agent_effort="high", override_effort="minimal", model_effort="low"
        )
        assert got == "minimal"

    def test_agent_level_independent_no_crosstalk(self, monkeypatch):
        """两个智能体各自的配置互不干扰：A=medium / B=None 走模型 low。"""
        got_a = self._create_llm_with(
            monkeypatch, agent_effort="medium", override_effort=None, model_effort="low"
        )
        got_b = self._create_llm_with(
            monkeypatch, agent_effort=None, override_effort=None, model_effort="low"
        )
        assert got_a == "medium"
        assert got_b == "low"

    def test_invalid_agent_value_falls_back_to_model(self, monkeypatch):
        """非法值归一化为 None，回落到模型高级参数。"""
        got = self._create_llm_with(
            monkeypatch, agent_effort="ultra", override_effort=None, model_effort="low"
        )
        assert got == "low"


@pytest.mark.parametrize("value", ["minimal", "low", "medium", "high"])
def test_api_schema_accepts_known_levels(value):
    """API 请求体接受合法档位，且缺省为 None（不传）。"""
    base = LLMConfigBase(name="t", reasoning_effort=value)
    assert base.reasoning_effort == value
    default = LLMConfigBase(name="t")
    assert default.reasoning_effort is None
