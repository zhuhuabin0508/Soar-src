"""llm_probe_errors 分类与文案。"""
from types import SimpleNamespace

from app.core.llm_probe_errors import (
    SOAR_LLM_PROBE_FAILED_MARKER,
    enrich_probe_error,
)


def test_enrich_connection_error_network_kind():
    cfg = SimpleNamespace(
        id=1, name="t", provider="openai", model_name="m",
        model_type="chat", base_url="https://api.example.com/v1", timeout=60,
    )
    body = enrich_probe_error(Exception("Connection error."), cfg=cfg, latency_ms=4800)
    assert body["error_kind"] == "network"
    assert body["error_label"] == "网络连接异常"
    assert body["probe_ref"]
    assert SOAR_LLM_PROBE_FAILED_MARKER in body["error"]
    assert any("4800" in x for x in body["error_checklist"])