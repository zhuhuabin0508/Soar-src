"""工单 Pydantic 请求模型。

覆盖三类对象：
- 分组管理：创建/更新/成员全量设置
- 流程模板：创建/更新（发布走专用 POST /{id}/publish）
- 工单实例：发起/流转/取消
"""
from datetime import datetime
from typing import Any, Optional

from pydantic import BaseModel, Field, model_validator


# ============ 分组 ============

class GroupCreate(BaseModel):
    """创建分组：名称/描述/启停/初始成员。"""
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=255)
    enabled: bool = True
    member_ids: list[int] = Field(default_factory=list)


class GroupUpdate(BaseModel):
    """更新分组基础信息。"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=255)
    enabled: Optional[bool] = None


class GroupMembersUpdate(BaseModel):
    """全量设置分组成员（前端勾选提交，做差集增删）。"""
    user_ids: list[int] = Field(default_factory=list)


# ============ 流程模板 ============

class FlowCreate(BaseModel):
    """创建流程模板：nodes 为完整流程结构 JSON（含 start_groups + nodes）。"""
    name: str = Field(..., min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=255)
    nodes: dict[str, Any] = Field(default_factory=dict)


class FlowUpdate(BaseModel):
    """更新流程模板：内容变更后自动回到草稿态，需重新发布。"""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    description: Optional[str] = Field(None, max_length=255)
    enabled: Optional[bool] = None
    nodes: Optional[dict[str, Any]] = None


# ============ 工单实例 ============

class CcTarget(BaseModel):
    """抄送对象：人员或工单分组。"""
    type: str = Field(..., pattern="^(user|group)$")
    id: int
    name: str = Field("", max_length=100)


class TicketCreate(BaseModel):
    """发起工单：field_values 按首节点字段定义校验。

    ``cc_targets``：发起时手动追加的抄送对象（模板固定抄送自动生效，此处无需重复）。
    """
    flow_id: int
    title: str = Field(..., min_length=1, max_length=200)
    priority: str = Field(default="medium", pattern="^(low|medium|high|critical)$")
    field_values: dict[str, Any] = Field(default_factory=dict)
    route_to: Optional[str] = None
    comment: Optional[str] = None
    related_alert_id: Optional[int] = None
    related_alert_uuid: Optional[str] = Field(None, max_length=64)
    cc_targets: list[CcTarget] = Field(default_factory=list)


class TicketCcAdd(BaseModel):
    """追加抄送对象（发起人/当前处理人/admin，进行中工单）。"""
    targets: list[CcTarget] = Field(default_factory=list)


class DeviceRunChoice(BaseModel):
    """处理人是否调用该设备动作。index 对应当前节点动作列表下标。"""
    index: int = 0
    action_id: int
    run: bool = False
    params: dict[str, Any] = Field(default_factory=dict)
    # 处理人手动改过的参数名：可编辑参数带默认值模板时，改过的用用户输入，未改的按模板重算
    overridden_params: list[str] = Field(default_factory=list)


class TicketAdvance(BaseModel):
    """流转工单：当前节点处理人提交字段值并选择去向。"""
    field_values: dict[str, Any] = Field(default_factory=dict)
    route_to: Optional[str] = None
    comment: Optional[str] = None
    run_device_action: bool = False
    device_params: dict[str, Any] = Field(default_factory=dict)
    device_runs: list[DeviceRunChoice] = Field(default_factory=list)


class TicketCancel(BaseModel):
    """取消工单：仅发起人或 admin。"""
    comment: Optional[str] = None


class TicketPauseCreate(BaseModel):
    """暂停工单（临时挂起）：处理人/发起人/admin 按类型规则发起。

    - ``pause_type``：暂停分类，决定必填信息、最长时效与到期策略
    - ``detail``：分类必填信息（补充事项/协作方/主工单号/窗口时间等）
    - ``expected_resume_at``：期望恢复时间，不得晚于系统到期时间
    - ``necessity``：紧急工单非管理员暂停时的必要性说明
    """

    pause_type: str = Field(
        ...,
        pattern="^(pending_info|external_coop|user_feedback|business_window|duplicate_merge|other)$",
        description="暂停分类",
    )
    reason: str = Field(..., min_length=1, max_length=1000, description="暂停原因（必填）")
    expected_resume_at: Optional[datetime] = Field(None, description="期望恢复时间")
    detail: dict[str, Any] = Field(default_factory=dict, description="分类必填信息")
    necessity: Optional[str] = Field(None, max_length=1000, description="暂停必要性说明（紧急工单）")


class TicketResume(BaseModel):
    """恢复工单：``force=true`` 仅管理员可用，忽略暂停发起人限制。"""

    comment: Optional[str] = Field(None, max_length=1000, description="恢复说明")
    force: bool = Field(False, description="管理员强制恢复")


class TicketBatchPause(TicketPauseCreate):
    """批量暂停：逐单校验、部分成功，单批最多 200 条。"""

    ticket_ids: list[int] = Field(..., min_length=1, max_length=200)


class TicketBatchResume(TicketResume):
    """批量恢复：逐单校验、部分成功，单批最多 200 条。"""

    ticket_ids: list[int] = Field(..., min_length=1, max_length=200)


class TicketPauseConfigUpdate(BaseModel):
    """暂停策略配置：types 由 app.core.ticket_pause 统一校验与补全。"""

    enabled: bool = True
    max_pause_minutes: int = Field(10080, gt=0)
    max_total_pause_minutes: int = Field(20160, gt=0)
    max_pause_count: int = Field(5, gt=0)
    max_batch_size: int = Field(200, gt=0)
    remind_before_expire_minutes: int = Field(240, ge=0)
    fallback_group_id: Optional[int] = None
    types: dict[str, Any] = Field(default_factory=dict)


class TicketRollback(BaseModel):
    """回退工单：当前节点处理人退回上一节点，必须填写回退原因。

    ``target``：回退目标节点 key（可选）。当前节点配置了回退白名单
    （rollback_to）时必传且必须在白名单内；未配置白名单时忽略
    （始终退回上一处理节点）。
    """
    comment: str = Field(..., min_length=1, max_length=1000, description="回退原因（必填）")
    target: Optional[str] = Field(None, max_length=64, description="回退目标节点 key（白名单模式下必传）")


class TicketTransfer(BaseModel):
    """转办/改派：当前节点处理人把工单转给其他分组或指定人，必须填写转办原因。

    ``group_id`` 与 ``user_id`` 二选一：分组接管当前节点处理（计时重置）；
    指定人个人接管（认领锁定语义，仅其可继续提交）。
    """
    group_id: Optional[int] = None
    user_id: Optional[int] = None
    reason: str = Field(..., min_length=1, max_length=1000, description="转办原因（必填）")

    @model_validator(mode="after")
    def _check_target(self) -> "TicketTransfer":
        if self.group_id is None and self.user_id is None:
            raise ValueError("请选择转办目标（分组或人员）")
        if self.group_id is not None and self.user_id is not None:
            raise ValueError("转办目标只能选择分组或人员其中之一")
        return self


class TicketComment(BaseModel):
    """时间线内部评论（区别于处置意见，不产生流转副作用）。"""
    content: str = Field(..., min_length=1, max_length=2000, description="评论内容（必填）")


class TicketDeviceActionExecute(BaseModel):
    """执行节点设备动作（如安博通阻断器封禁/解封）：当前节点处理人触发实际设备调用。

    - ``action_id``：流程节点 device_actions 配置项的标识（id），非设备动作表 ID
    - ``params``：动作参数键值对（前端按字段映射预填、处理人可改）
    - ``field_values``：触发条件复检用的当前表单值快照（与提交面板同口径）
    """
    action_id: str = Field(..., min_length=1, max_length=64, description="节点设备动作配置项标识")
    params: dict[str, Any] = Field(default_factory=dict)
    field_values: dict[str, Any] = Field(default_factory=dict)


class TicketSimilar(BaseModel):
    """相似工单推荐查询：按首节点 源/目的 IP 匹配同流程历史工单（处置中/已完成）。

    匹配优先级：源+目的 IP 均相同 > 仅源 IP 相同 > 仅目的 IP 相同，均不相同不返回。
    """
    flow_id: int
    field_values: dict[str, Any] = Field(default_factory=dict)


class TicketEnrichmentRequery(BaseModel):
    """重新研判安全上下文指定 IP（资产匹配 + 威胁情报重查，升级完整档）。

    - ips 必须是工单研判 IP 集合的子集（不在集合内的记入 unknown 忽略）；
    - 超过同步阈值（20 个）自动转后台执行（响应 pending=true，前端轮询）。
    """
    ips: list[str] = Field(min_length=1, max_length=200, description="待重查 IP 列表")
