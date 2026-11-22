"""工单价值评分请求模型。"""
from typing import Any, Optional

from pydantic import BaseModel, Field


class TicketScoreSubmit(BaseModel):
    """提交工单评分：维度得分 + 命中修正系数 + 命中的强制置顶规则。

    - ``dimension_scores``：``{维度 key: 1-5 分}``，必须覆盖当前规则全部维度
    - ``factor_keys``：命中的修正系数 key（同类不叠加，由规则配置保证）
    - ``override_keys``：命中的强制置顶规则 key
    - ``comment``：评分说明（可选）
    """

    dimension_scores: dict[str, Any] = Field(default_factory=dict, description="维度得分")
    factor_keys: list[str] = Field(default_factory=list, description="命中修正系数")
    override_keys: list[str] = Field(default_factory=list, description="命中强制置顶规则")
    comment: Optional[str] = Field(None, max_length=2000, description="评分说明")


class TicketScoreRuleUpdate(BaseModel):
    """保存评分规则：完整规则配置 + 变更说明（生成新版本并留痕）。"""

    config: dict[str, Any] = Field(..., description="评分规则配置")
    note: Optional[str] = Field(None, max_length=255, description="本次调整说明")
