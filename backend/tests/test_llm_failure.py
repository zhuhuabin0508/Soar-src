"""LLM 失败提示与结构化日志关键字。"""
from app.agent.hermes.llm_failure import (
    SOAR_LLM_CALL_FAILED_MARKER,
    format_user_llm_error_message,
    report_llm_failure,
)


def test_format_user_message_network_connection_error():
    exc = Exception("Connection error.")
    msg = format_user_llm_error_message(exc, ref="abc12345")
    assert "连接异常" in msg
    assert "abc12345" in msg
    assert SOAR_LLM_CALL_FAILED_MARKER in msg


def test_report_llm_failure_returns_user_message(caplog):
    import logging

    caplog.set_level(logging.ERROR)
    exc = Exception("Connection error.")
    msg = report_llm_failure(exc, agent_id=1, session_id="s1", attempts=3)
    assert "排查编号" in msg
    assert any(SOAR_LLM_CALL_FAILED_MARKER in r.message for r in caplog.records)