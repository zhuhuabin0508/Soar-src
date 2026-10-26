"""数据模型汇总导出。

注册所有 ORM 模型，确保 ``Base.metadata.create_all`` 能发现全部表。
新增模型在此 import 即可完成注册。
"""
from app.models.agent import Agent
from app.models.agent_file import AgentFile
from app.models.alert_event import AlertEvent
from app.models.alert_handle_log import AlertHandleLog
from app.models.alert_rule import AlertRule
from app.models.alert_rule_group import AlertRuleGroup
from app.models.alert_rule_hit import AlertRuleHit
from app.models.asset import Asset, AssetTypeTemplate, AssetCustomField, AssetChange, AssetTag
from app.models.audit_log import AuditLog
from app.models.backup_record import BackupRecord
from app.models.banned_ip import BannedIP
from app.models.chat_message import ChatMessage
from app.models.deliverable import ServiceCategory, Deliverable
from app.models.device import Device, DeviceAction
from app.models.duty import (
    DutyMember,
    DutyRecord,
    DutyRotationCursor,
    DutyAdjustmentLog,
    DutyLeaveLog,
)
from app.models.execution import Execution
from app.models.execution_log import ExecutionLog
from app.models.execution_trace import ExecutionTrace
from app.models.feedback import Feedback, FeedbackHistory
from app.models.govcloud_asset import (
    GovCloudImportBatch,
    GovCloudCloudHost,
    GovCloudBareMetal,
    GovCloudNetwork,
    GovCloudElasticIP,
)
from app.models.ingestion_metric import IngestionMetric
from app.models.log_receiver import (
    DeviceReceiveLog,
    DeviceReceiveMetric,
    LogReceiver,
)
from app.models.log_source_entry import LogSourceEntry
from app.models.ticket import (
    TicketGroup,
    TicketGroupMember,
    TicketFlow,
    TicketFlowVersion,
    Ticket,
    TicketNodeRecord,
)
from app.models.knowledge_base import KnowledgeBase, KnowledgeDocument, KnowledgeSegment
from app.models.llm_config import LLMConfig
from app.models.model_call_log import ModelCallLog
from app.models.notification import Notification
from app.models.notification_rule import NotificationRule
from app.models.parse_error import ParseErrorQueue
from app.models.parse_strategy import ParseStrategy, ParseStrategyVersion
from app.models.resource_share import ResourceShare
from app.models.role import Role
from app.models.skill import Skill
from app.models.system_config import SystemConfig
from app.models.tool import Tool
from app.models.user import User
from app.models.workflow import Workflow
from app.models.workflow_version import WorkflowVersion
from app.models.workflow_ban import (
    WorkflowTriggerRule,
    WorkflowInstance,
    WorkflowNodeLog,
    ApprovalTicket,
    BanRecord,
    MonitorLog,
    AgentInvocationLog,
)

__all__ = [
    "Workflow",
    "WorkflowVersion",
    "Execution",
    "ExecutionTrace",
    "ExecutionLog",
    "LLMConfig",
    "ModelCallLog",
    "Tool",
    "Agent",
    "AgentFile",
    "Asset",
    "AssetTypeTemplate",
    "AssetCustomField",
    "AssetChange",
    "AssetTag",
    "AgentMemory",
    "KnowledgeBase",
    "KnowledgeDocument",
    "KnowledgeSegment",
    "User",
    "Role",
    "Skill",
    "SystemConfig",
    "AuditLog",
    "BannedIP",
    "ChatMessage",
    "Notification",
    "NotificationRule",
    "Feedback",
    "FeedbackHistory",
    "GovCloudImportBatch",
    "GovCloudCloudHost",
    "GovCloudBareMetal",
    "GovCloudNetwork",
    "GovCloudElasticIP",
    "BackupRecord",
    "Device",
    "DeviceAction",
    "ResourceShare",
    "ServiceCategory",
    "Deliverable",
    "AlertEvent",
    "AlertHandleLog",
    "AlertRule",
    "AlertRuleGroup",
    "AlertRuleHit",
    "ParseStrategy",
    "ParseStrategyVersion",
    "ParseErrorQueue",
    "IngestionMetric",
    "LogReceiver",
    "LogSourceEntry",
    "DeviceReceiveLog",
    "DeviceReceiveMetric",
    "TicketGroup",
    "TicketGroupMember",
    "TicketFlow",
    "TicketFlowVersion",
    "Ticket",
    "TicketNodeRecord",
    "WorkflowTriggerRule",
    "WorkflowInstance",
    "WorkflowNodeLog",
    "ApprovalTicket",
    "BanRecord",
    "MonitorLog",
    "AgentInvocationLog",
]
