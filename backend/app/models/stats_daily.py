"""大屏日汇总表（Beat 写入，聚合 API / Celery 刷新读取）。"""
from sqlalchemy import Column, Date, DateTime, Float, Integer, JSON, String, UniqueConstraint

from app.core.timezone import beijing_now
from app.database import Base


class StatsDailyExecution(Base):
    """按自然日汇总的执行/封禁相关指标。"""

    __tablename__ = "stats_daily_executions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    stat_date = Column(Date, nullable=False, unique=True, index=True)
    total_count = Column(Integer, default=0)
    auto_block_count = Column(Integer, default=0)
    manual_approval_count = Column(Integer, default=0)
    block_attempt_count = Column(Integer, default=0)
    block_success_count = Column(Integer, default=0)
    mttr_sum_seconds = Column(Float, default=0.0)
    mttr_sample_count = Column(Integer, default=0)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)


class StatsDailyExecutionDim(Base):
    """执行日汇总维度：告警类型、封禁 IP 等。"""

    __tablename__ = "stats_daily_execution_dims"

    id = Column(Integer, primary_key=True, autoincrement=True)
    stat_date = Column(Date, nullable=False, index=True)
    dim_type = Column(String(32), nullable=False)
    dim_key = Column(String(255), nullable=False)
    count_value = Column(Integer, default=0)
    payload = Column(JSON, nullable=True)

    __table_args__ = (
        UniqueConstraint("stat_date", "dim_type", "dim_key", name="uq_stats_daily_exec_dim"),
    )


class StatsDailyModelCall(Base):
    """按自然日汇总的模型调用指标。"""

    __tablename__ = "stats_daily_model_calls"

    id = Column(Integer, primary_key=True, autoincrement=True)
    stat_date = Column(Date, nullable=False, unique=True, index=True)
    total_calls = Column(Integer, default=0)
    success_calls = Column(Integer, default=0)
    failed_calls = Column(Integer, default=0)
    latency_sum_ms = Column(Integer, default=0)
    latency_count = Column(Integer, default=0)
    input_tokens = Column(Integer, default=0)
    output_tokens = Column(Integer, default=0)
    total_tokens = Column(Integer, default=0)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)


class StatsDailyModelCallDim(Base):
    """模型调用日汇总维度：provider / trigger / model_config / agent。"""

    __tablename__ = "stats_daily_model_call_dims"

    id = Column(Integer, primary_key=True, autoincrement=True)
    stat_date = Column(Date, nullable=False, index=True)
    dim_type = Column(String(32), nullable=False)
    dim_key = Column(String(64), nullable=False)
    call_count = Column(Integer, default=0)
    success_count = Column(Integer, default=0)
    failed_count = Column(Integer, default=0)
    latency_sum_ms = Column(Integer, default=0)
    latency_count = Column(Integer, default=0)
    input_tokens = Column(Integer, default=0)
    output_tokens = Column(Integer, default=0)
    total_tokens = Column(Integer, default=0)
    payload = Column(JSON, nullable=True)

    __table_args__ = (
        UniqueConstraint("stat_date", "dim_type", "dim_key", name="uq_stats_daily_model_dim"),
    )
