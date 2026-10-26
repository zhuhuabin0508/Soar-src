"""告警自动封禁工作流模型（7 张表）。

链路：告警入库 → 触发规则过滤(workflow_trigger_rules) → 实例(workflow_instances)
→ 节点执行日志(workflow_node_logs) → 智能体研判(agent_invocation_logs)
→ 分支处置：直接/审批封禁(ban_records, approval_tickets) 或持续监控(monitor_logs)。
"""
from sqlalchemy import (
    Boolean, Column, DateTime, Integer, String, Text, UniqueConstraint,
)

from app.core.timezone import beijing_now
from app.database import Base


class WorkflowTriggerRule(Base):
    """工作流触发规则（告警入库后按条件匹配，全部条件 AND 关系）。"""

    __tablename__ = "workflow_trigger_rules"

    id = Column(Integer, primary_key=True, index=True)
    rule_name = Column(String(128), nullable=False)
    # enabled / disabled
    status = Column(String(16), nullable=False, default="enabled")
    # 条件 JSON：{risk_levels:[], min_severity, directions:[], src_ip_tags:[],
    #            alert_name_keywords:[], threat_classes:[]}（全部 AND）
    conditions = Column(Text, nullable=False, default="{}")
    cooldown_minutes = Column(Integer, nullable=False, default=60)
    priority = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, default=beijing_now)
    updated_at = Column(DateTime, default=beijing_now, onupdate=beijing_now)

    def __repr__(self) -> str:
        return f"<WorkflowTriggerRule {self.rule_name!r} status={self.status!r}>"


class WorkflowInstance(Base):
    """告警自动封禁工作流实例（一个告警至多一个实例，alert_uuid 唯一）。"""

    __tablename__ = "workflow_instances"
    __table_args__ = (UniqueConstraint("alert_uuid", name="uq_workflow_instance_alert_uuid"),)

    id = Column(Integer, primary_key=True, index=True)
    alert_id = Column(Integer, nullable=True, index=True)
    alert_uuid = Column(String(128), nullable=True, index=True)
    src_ip = Column(String(45), nullable=True, index=True)
    strategy_id = Column(Integer, nullable=True)
    trigger_rule_id = Column(Integer, nullable=True, index=True)
    # running / waiting_approval / success / error / skipped / cancelled / escalated
    status = Column(String(24), nullable=False, default="running", index=True)
    current_node = Column(String(64), nullable=False, default="")
    # 最终处置结果：banned / already_banned / waiting_approval / monitoring / cancelled / error / skipped
    final_result = Column(String(32), nullable=True)
    error_msg = Column(Text, nullable=True)
    started_at = Column(DateTime, default=beijing_now)
    finished_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=beijing_now, index=True)

    def __repr__(self) -> str:
        return f"<WorkflowInstance id={self.id} status={self.status!r} ip={self.src_ip!r}>"


class WorkflowNodeLog(Base):
    """节点执行日志（每个节点独立记录状态/输入/输出/耗时）。"""

    __tablename__ = "workflow_node_logs"

    id = Column(Integer, primary_key=True, index=True)
    instance_id = Column(Integer, nullable=False, index=True)
    node_name = Column(String(64), nullable=False)
    node_key = Column(String(64), nullable=False, default="")
    node_order = Column(Integer, nullable=False, default=0)
    # pending / running / success / fail / skipped
    status = Column(String(16), nullable=False, default="pending")
    input = Column(Text, nullable=True)
    output = Column(Text, nullable=True)
    start_time = Column(DateTime, nullable=True)
    end_time = Column(DateTime, nullable=True)
    error_msg = Column(Text, nullable=True)

    def __repr__(self) -> str:
        return f"<WorkflowNodeLog inst={self.instance_id} node={self.node_name!r} {self.status!r}>"


class ApprovalTicket(Base):
    """封禁审批工单。"""

    __tablename__ = "approval_tickets"

    id = Column(Integer, primary_key=True, index=True)
    workflow_instance_id = Column(Integer, nullable=False, index=True)
    ip = Column(String(45), nullable=False, index=True)
    alert_summary = Column(Text, nullable=True)
    # 智能体研判结论 JSON（risk_level/action/need_confirm/reasons 等）
    agent_decision = Column(Text, nullable=True)
    # 封禁方案 JSON（ban_level/ban_duration/is_permanent/reason/region）
    ban_plan = Column(Text, nullable=True)
    # 资产信息 JSON
    asset_info = Column(Text, nullable=True)
    # pending / approved / rejected / escalated / timeout
    status = Column(String(16), nullable=False, default="pending", index=True)
    approver = Column(String(64), nullable=True)
    approval_comment = Column(Text, nullable=True)
    approved_at = Column(DateTime, nullable=True)
    deadline = Column(DateTime, nullable=True, index=True)
    created_at = Column(DateTime, default=beijing_now, index=True)

    def __repr__(self) -> str:
        return f"<ApprovalTicket id={self.id} ip={self.ip!r} {self.status!r}>"


class BanRecord(Base):
    """封禁记录（工作台已封禁 IP 模块数据源）。"""

    __tablename__ = "ban_records"

    id = Column(Integer, primary_key=True, index=True)
    ip = Column(String(45), nullable=False, index=True)
    ban_level = Column(String(20), nullable=False, default="medium")
    # 秒
    ban_duration = Column(Integer, nullable=False, default=3600)
    is_permanent = Column(Boolean, nullable=False, default=False)
    expire_time = Column(DateTime, nullable=True, index=True)
    reason = Column(Text, nullable=True)
    region = Column(String(64), nullable=True)
    source_instance_id = Column(Integer, nullable=True, index=True)
    # 封禁来源：auto（工作流自动）/ approval（审批通过）/ manual（手动发起）/ ticket（工单同步）
    ban_source = Column(String(16), nullable=False, default="auto")
    # 封禁工具返回的记录 ID
    record_id = Column(String(64), nullable=True)
    # 工单同步来源信息（ban_source=ticket 时填写）
    ticket_id = Column(Integer, nullable=True, index=True, comment="来源工单 ID（详情跳转用）")
    ticket_no = Column(String(32), nullable=True, comment="来源工单号（冗余展示）")
    ticket_node = Column(String(64), nullable=True, comment="触发同步的工单节点 key（防重复同步）")
    ban_device = Column(String(255), nullable=True, comment="封禁设备（工单同步时填写的设备信息）")
    # pending_approval / active / expired / unbanned / cancelled
    status = Column(String(20), nullable=False, default="active", index=True)
    unban_reason = Column(Text, nullable=True)
    unban_operator = Column(String(64), nullable=True)
    unban_time = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=beijing_now, index=True)

    def __repr__(self) -> str:
        return f"<BanRecord ip={self.ip!r} status={self.status!r}>"


class MonitorLog(Base):
    """持续监控记录（action=持续监控 时写入）。"""

    __tablename__ = "monitor_logs"

    id = Column(Integer, primary_key=True, index=True)
    ip = Column(String(45), nullable=False, index=True)
    risk_level = Column(String(32), nullable=True)
    advice = Column(Text, nullable=True)
    # 原因列表 JSON
    reasons = Column(Text, nullable=True)
    instance_id = Column(Integer, nullable=True, index=True)
    created_at = Column(DateTime, default=beijing_now, index=True)

    def __repr__(self) -> str:
        return f"<MonitorLog ip={self.ip!r}>"


class AgentInvocationLog(Base):
    """智能体调用日志（全链路：请求/响应/模型/token/耗时/状态）。"""

    __tablename__ = "agent_invocation_logs"

    id = Column(Integer, primary_key=True, index=True)
    workflow_instance_id = Column(Integer, nullable=True, index=True)
    node_key = Column(String(64), nullable=True)
    request_body = Column(Text, nullable=True)
    response_body = Column(Text, nullable=True)
    model_name = Column(String(128), nullable=True)
    input_tokens = Column(Integer, nullable=True)
    output_tokens = Column(Integer, nullable=True)
    # 耗时（毫秒）
    duration_ms = Column(Integer, nullable=True)
    # success / fail
    status = Column(String(16), nullable=False, default="success")
    error_msg = Column(Text, nullable=True)
    created_at = Column(DateTime, default=beijing_now, index=True)

    def __repr__(self) -> str:
        return f"<AgentInvocationLog inst={self.workflow_instance_id} {self.status!r}>"
