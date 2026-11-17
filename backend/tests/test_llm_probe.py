"""llm_probe 参数解析与结果展示。"""
from types import SimpleNamespace

from app.core.llm_probe import (
    LlmProbeResult,
    _llm_params_from_config,
    DEFAULT_PROBE_PROMPT,
)


def test_llm_params_from_config_defaults():
    cfg = SimpleNamespace(temperature=None, max_tokens=None, top_p=None, reasoning_effort=None)
    p = _llm_params_from_config(cfg)
    assert p["temperature"] == 0.7
    assert p["max_tokens"] == 1024
    assert p["reasoning_effort"] is None


def test_probe_display_text_reasoning_only():
    r = LlmProbeResult(success=True, reasoning="abc" * 10)
    assert "思维链" in r.display_text


def test_default_probe_prompt():
    assert DEFAULT_PROBE_PROMPT == "回复OK两个字"