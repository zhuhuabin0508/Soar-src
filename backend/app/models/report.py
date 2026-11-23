"""报告中心数据模型。

七张表覆盖「模板资产 → 配置 → 运行 → 产物」全链路：

- ``ReportTemplate`` / ``ReportTemplateVersion``：模板主档与版本（草稿/发布/废弃）；
- ``ReportConfig`` / ``ReportConfigVersion``：映射与采集配置的草稿/发布双态；
- ``ReportRun`` / ``ReportRunSource``：运行记录、数据快照与采集血缘；
- ``ReportArtifact``：渲染产物与审核状态。

版本模型参考 ``ParseStrategy``：配置发布时固化模板版本，保证历史运行可复现。
"""
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    JSON,
    String,
    Text,
    UniqueConstraint,
)

from app.core.timezone import beijing_now
from app.database import Base


class ReportTemplate(Base):
    """报告模板主档，逻辑标识稳定，具体内容由版本承载。"""

    __tablename__ = "report_templates"

    id = Column(Integer, primary_key=True, index=True)
    code = Column(String(64), unique=True, index=True, nullable=False, comment="模板编码")
    name = Column(String(128), nullable=False, comment="模板名称")
    category = Column(String(64), default="", index=True, comment="分类")
    description = Column(Text, default="", comment="用途说明")
    # draft / published / archived
    status = Column(String(16), default="draft", index=True)
    current_version_id = Column(Integer, nullable=True, comment="当前发布版本 ID")
    owner_id = Column(Integer, nullable=True, comment="负责人 user.id")
    tags = Column(String(255), default="", comment="标签，逗号分隔")
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    def __repr__(self) -> str:
        return f"<ReportTemplate id={self.id} code={self.code!r} status={self.status!r}>"


class ReportTemplateVersion(Base):
    """模板版本：存 docx 文件与解析后的 manifest。"""

    __tablename__ = "report_template_versions"
    __table_args__ = (
        UniqueConstraint("template_id", "version_no", name="uq_report_template_version"),
    )

    id = Column(Integer, primary_key=True, index=True)
    template_id = Column(
        Integer, ForeignKey("report_templates.id", ondelete="CASCADE"), index=True, nullable=False
    )
    version_no = Column(Integer, nullable=False, comment="模板内自增版本号")
    file_path = Column(String(512), nullable=False, comment="相对 uploads 的路径")
    file_hash = Column(String(64), nullable=False, index=True, comment="SHA-256")
    file_size = Column(Integer, default=0)
    page_count = Column(Integer, nullable=True)
    manifest_json = Column(JSON, default=dict, comment="占位符/章节/表格结构")
    # upload / ai_draft / manual
    source = Column(String(16), default="upload")
    ai_draft_json = Column(JSON, nullable=True, comment="AI 起草原始输出，便于追溯")
    changelog = Column(Text, default="")
    # draft / published / deprecated
    status = Column(String(16), default="draft", index=True)
    published_by = Column(Integer, nullable=True)
    published_at = Column(DateTime, nullable=True)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=beijing_now)

    def __repr__(self) -> str:
        return f"<ReportTemplateVersion tpl={self.template_id} v{self.version_no} {self.status!r}>"


class ReportConfig(Base):
    """报告配置主档：模板 + 调度 + 输出策略。"""

    __tablename__ = "report_configs"

    id = Column(Integer, primary_key=True, index=True)
    template_id = Column(
        Integer, ForeignKey("report_templates.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    name = Column(String(128), nullable=False)
    description = Column(Text, default="")
    # draft / published / disabled
    status = Column(String(16), default="draft", index=True)
    schedule_cron = Column(String(64), default="", comment="空=仅手动/API 触发")
    timezone = Column(String(32), default="Asia/Shanghai")
    output_name_pattern = Column(
        String(255), default="{template_name}_{period}", comment="产物命名模板"
    )
    notify_channels = Column(JSON, default=list, comment="失败/完成通知渠道")
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    def __repr__(self) -> str:
        return f"<ReportConfig id={self.id} name={self.name!r} status={self.status!r}>"


class ReportConfigVersion(Base):
    """配置版本：数据源、映射、参数 Schema 的不可变快照。"""

    __tablename__ = "report_config_versions"
    __table_args__ = (
        UniqueConstraint("config_id", "version_no", name="uq_report_config_version"),
    )

    id = Column(Integer, primary_key=True, index=True)
    config_id = Column(
        Integer, ForeignKey("report_configs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    version_no = Column(Integer, nullable=False)
    template_version_id = Column(
        Integer,
        ForeignKey("report_template_versions.id", ondelete="RESTRICT"),
        index=True,
        nullable=False,
        comment="固化的模板版本，避免模板升级导致历史配置漂移",
    )
    params_schema_json = Column(JSON, default=list, comment="运行入参定义")
    data_sources_json = Column(JSON, default=list, comment="采集配置")
    mapping_json = Column(JSON, default=dict, comment="映射与交叉核对")
    transform_json = Column(JSON, default=dict, comment="全局转换/口径说明")
    degradation_policy_json = Column(JSON, default=dict, comment="降级策略")
    changelog = Column(Text, default="")
    # draft / published / deprecated
    status = Column(String(16), default="draft", index=True)
    published_by = Column(Integer, nullable=True)
    published_at = Column(DateTime, nullable=True)
    created_by = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=beijing_now)

    def __repr__(self) -> str:
        return f"<ReportConfigVersion cfg={self.config_id} v{self.version_no} {self.status!r}>"


class ReportRun(Base):
    """一次报告运行：固化版本组合、参数、快照与校验结论。"""

    __tablename__ = "report_runs"
    __table_args__ = (
        Index("ix_report_runs_config_status", "config_id", "status"),
        UniqueConstraint("idempotency_key", name="uq_report_run_idempotency"),
    )

    id = Column(Integer, primary_key=True, index=True)
    config_id = Column(
        Integer, ForeignKey("report_configs.id", ondelete="RESTRICT"), index=True, nullable=False
    )
    config_version_no = Column(Integer, nullable=False)
    template_version_id = Column(Integer, nullable=False)
    # manual / schedule / api / agent
    trigger_type = Column(String(16), default="manual", index=True)
    trigger_user_id = Column(Integer, nullable=True)
    params_json = Column(JSON, default=dict)
    idempotency_key = Column(String(128), nullable=True, comment="配置+周期，防重复生成")
    # pending / collecting / extracting / rendering / validating /
    # succeeded / partial / failed / cancelled
    status = Column(String(16), default="pending", index=True)
    started_at = Column(DateTime, nullable=True)
    finished_at = Column(DateTime, nullable=True)
    duration_ms = Column(Integer, nullable=True)
    error_code = Column(String(32), nullable=True)
    error_message = Column(Text, nullable=True)
    stats_json = Column(JSON, default=dict, comment="耗时分解/数量统计")
    validation_json = Column(JSON, default=dict, comment="L1~L3 校验报告")
    data_snapshot_json = Column(JSON, default=dict, comment="渲染上下文 + 血缘")
    artifact_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=beijing_now, index=True)

    def __repr__(self) -> str:
        return f"<ReportRun id={self.id} cfg={self.config_id} {self.status!r}>"


class ReportRunSource(Base):
    """单个数据源的单次采集记录（血缘与排障依据）。"""

    __tablename__ = "report_run_sources"
    __table_args__ = (Index("ix_report_run_sources_run_key", "run_id", "source_key"),)

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(
        Integer, ForeignKey("report_runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    source_key = Column(String(64), nullable=False)
    source_type = Column(String(32), default="")
    device_id = Column(Integer, nullable=True)
    action_id = Column(Integer, nullable=True)
    request_summary = Column(Text, default="", comment="脱敏后的请求摘要")
    status_code = Column(Integer, nullable=True)
    latency_ms = Column(Integer, default=0)
    retry_count = Column(Integer, default=0)
    cache_hit = Column(Boolean, default=False)
    # ok / failed
    status = Column(String(16), default="ok")
    error_code = Column(String(32), nullable=True)
    error_message = Column(Text, nullable=True)
    response_hash = Column(String(64), nullable=True)
    response_size = Column(Integer, nullable=True)
    fetched_at = Column(String(40), nullable=True)

    def __repr__(self) -> str:
        return f"<ReportRunSource run={self.run_id} key={self.source_key} {self.status!r}>"


class ReportArtifact(Base):
    """渲染产物与审核状态。"""

    __tablename__ = "report_artifacts"
    __table_args__ = (Index("ix_report_artifacts_run_status", "run_id", "status"),)

    id = Column(Integer, primary_key=True, index=True)
    run_id = Column(
        Integer, ForeignKey("report_runs.id", ondelete="CASCADE"), index=True, nullable=False
    )
    file_path = Column(String(512), nullable=False)
    file_name = Column(String(255), default="")
    file_hash = Column(String(64), nullable=False)
    file_size = Column(Integer, default=0)
    pdf_path = Column(String(512), nullable=True)
    # draft / pending_review / approved / rejected
    status = Column(String(16), default="draft", index=True)
    reviewer_id = Column(Integer, nullable=True)
    review_comment = Column(Text, default="")
    published_deliverable_id = Column(Integer, nullable=True)
    created_at = Column(DateTime, default=beijing_now)

    def __repr__(self) -> str:
        return f"<ReportArtifact id={self.id} run={self.run_id} {self.status!r}>"
