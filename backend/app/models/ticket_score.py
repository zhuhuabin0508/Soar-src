"""工单价值评估（评分）模型。

包含 2 张表：
- ``TicketScoreRuleVersion``：评分规则发布版本存档（维度/权重/分值锚点/修正系数/
  强制置顶/分级阈值），每次保存生成新版本，供历史结果回溯与报表标注；
- ``TicketScore``：工单评分结果（每单唯一，提交后不可重复评分），保存提交时的
  规则快照、维度取值、修正系数命中、置顶命中与完整计算明细。

规则当前配置存于 ``system_configs``（键 ``ticket.score_rule``），版本行仅做存档。
"""
from sqlalchemy import (
    Column, DateTime, ForeignKey, Index, Integer, JSON, String, Text,
    UniqueConstraint, func,
)

from app.core.timezone import beijing_now, to_beijing_iso
from app.database import Base


class TicketScoreRuleVersion(Base):
    """评分规则发布版本。

    - ``version``：自增版本号（从 1 开始），与 ``system_configs`` 中当前配置一致
    - ``config``：完整规则配置（dimensions / factors / override_rules / grades / scale）
    - ``note``：本次调整说明（变更留痕）
    - ``published_by_id`` / ``published_by_name`` / ``published_at``：发布人与时间
    """

    __tablename__ = "ticket_score_rule_versions"
    __table_args__ = (
        UniqueConstraint("version", name="uq_ticket_score_rule_version"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    version = Column(Integer, nullable=False, index=True)
    config = Column(JSON, nullable=False, default=dict)
    note = Column(String(255), nullable=True)
    published_by_id = Column(Integer, nullable=True)
    published_by_name = Column(String(64), nullable=False, default="")
    published_at = Column(DateTime, nullable=False, default=beijing_now)
    created_at = Column(DateTime, server_default=func.now())

    def to_dict(self, *, with_config: bool = True) -> dict:
        result = {}
        for column in self.__table__.columns:
            if column.name == "config" and not with_config:
                continue
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result

    def __repr__(self) -> str:
        return f"<TicketScoreRuleVersion version={self.version}>"


class TicketScore(Base):
    """工单价值评分结果（每张工单最多一条）。

    - ``ticket_id``：唯一约束，数据库层兜底重复评分并发
    - ``rule_version``：提交时采用的规则版本（0 = 内置默认规则未自定义发布）
    - ``rule_snapshot``：提交时的完整规则快照，保证历史结果可解释且不随规则变更漂移
    - ``dimension_scores``：``{维度 key: 1-5 分}``
    - ``factor_keys`` / ``override_keys``：命中的修正系数与强制置顶规则 key
    - ``breakdown``：完整计算明细（各维度加权、修正前后分值、命中项），用于详情展示
    - ``base_score``：未修正的加权原始分（× scale 后取整）
    - ``final_score``：修正与置顶后的最终价值分（0-100）
    - ``grade`` / ``grade_label``：按规则分级阈值得到的分级（如 P0）
    """

    __tablename__ = "ticket_scores"
    __table_args__ = (
        UniqueConstraint("ticket_id", name="uq_ticket_score_ticket"),
        Index("ix_ticket_scores_scored_at", "scored_at"),
        Index("ix_ticket_scores_final_score", "final_score"),
        Index("ix_ticket_scores_grade", "grade"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    ticket_id = Column(Integer, ForeignKey("tickets.id"), nullable=False, index=True)
    ticket_no = Column(String(32), nullable=False, default="")
    rule_version = Column(Integer, nullable=False, default=0)
    rule_snapshot = Column(JSON, nullable=True)
    dimension_scores = Column(JSON, nullable=False, default=dict)
    factor_keys = Column(JSON, nullable=False, default=list)
    override_keys = Column(JSON, nullable=False, default=list)
    breakdown = Column(JSON, nullable=True)
    base_score = Column(Integer, nullable=False, default=0)
    final_score = Column(Integer, nullable=False, default=0)
    grade = Column(String(16), nullable=False, default="")
    grade_label = Column(String(32), nullable=False, default="")
    comment = Column(Text, nullable=True)
    scored_by_id = Column(Integer, nullable=False, index=True)
    scored_by_name = Column(String(64), nullable=False, default="")
    scored_at = Column(DateTime, nullable=False, default=beijing_now)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result

    def __repr__(self) -> str:
        return f"<TicketScore ticket={self.ticket_id} score={self.final_score} grade={self.grade!r}>"
