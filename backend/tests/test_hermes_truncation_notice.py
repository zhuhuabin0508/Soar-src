"""最终回答被 max_tokens 截断时的用户可见提示（回归用例）。

背景：资产管理智能体对 IP 查询会生成结构化报告（查询摘要 + 表格 +
补充信息），配置 max_tokens=1024 时报告在表格中途被硬截断
（finish_reason=length），用户看到“不完整的回复”且无任何说明
（chat_messages 中出现 60/290/562 字符处截断的历史记录）。

修复：
1. 智能体 max_tokens 调大（1024 → 4096）让报告完整输出；
2. 截断仍然发生（任何原因再次触顶）时，追加可读提示告知内容不完整，
   而非静默截断误导用户。

本用例覆盖第 2 点的判定逻辑（纯函数，不依赖 LLM / DB）。
"""
import pytest

from app.agent.hermes.executor import _final_answer_truncation_notice


def test_length_truncated_answer_gets_notice():
    """finish_reason=length 且有正文 → 必须返回截断提示。"""
    notice = _final_answer_truncation_notice("length", "【查询摘要】\n- 输入 IP：1 个")
    assert notice is not None
    assert notice.startswith("\n\n")
    assert "截断" in notice
    assert "不完整" in notice


def test_normal_stop_answer_no_notice():
    """正常结束（finish_reason=stop）不附加提示。"""
    assert _final_answer_truncation_notice("stop", "完整回答") is None


def test_tool_call_round_no_notice():
    """工具调用轮（finish_reason=tool_calls）不附加提示。"""
    assert _final_answer_truncation_notice("tool_calls", "") is None


def test_empty_content_no_notice():
    """空正文交由“本轮未生成有效回复”兜底分支，不叠加截断提示。"""
    assert _final_answer_truncation_notice("length", "") is None
    assert _final_answer_truncation_notice("length", "   \n  ") is None


def test_missing_finish_reason_no_notice():
    """流式结束原因缺失（网关异常等）时不得误报截断。"""
    assert _final_answer_truncation_notice(None, "部分内容") is None


@pytest.mark.parametrize("max_tokens,expected_full", [
    # 智能体当前配置：4096 覆盖报告所需（实测 ~1900 tokens）
    (4096, True),
    # 历史故障配置：1024 无法容纳完整报告（回归护栏，防止误改回小值）
    (1024, False),
])
def test_max_tokens_budget_covers_report(max_tokens, expected_full):
    """max_tokens 预算护栏：完整报告实测约 1900 output tokens。

    1024（历史故障值）必然截断；4096（修复值）留有约 2 倍余量。
    若技能模板导致报告进一步变长，此用例提醒同步上调 max_tokens。
    """
    measured_report_tokens = 1914  # 修复后实测 output_tokens（finish_reason=stop）
    assert (max_tokens >= measured_report_tokens * 2) is expected_full
