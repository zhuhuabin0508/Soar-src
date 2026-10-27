"""值班管理 Pydantic Schema。

覆盖值班人员、值班表生成/确认/查看、手动调班、请假、调班日志、特殊日期覆盖。
pydantic v2 风格，业务校验（如类别白名单）在 API 层完成。
"""
from datetime import date as DateType
from typing import Literal, Optional

from pydantic import BaseModel, Field

# 值班类别
DUTY_CATEGORIES = ("PERMANENT_DAY", "DAY", "NIGHT")
# 值班表类型：日常运营 / 重保
ROSTER_TYPES = ("DAILY", "RESERVE")
# 班次
SHIFTS = ("DAY", "NIGHT")
# 值班记录状态
RECORD_STATUSES = ("draft", "published", "expired")
# 请假状态
LEAVE_STATUSES = ("pending", "approved", "rejected")
# 请假班次
LEAVE_SHIFTS = ("DAY", "NIGHT", "ALL")


class DutyMemberCreate(BaseModel):
    """新增值班人员。"""

    name: str = Field(..., min_length=1, max_length=100, description="姓名")
    phone: str = Field(..., min_length=1, max_length=50, description="联系电话")
    group_name: str = Field("", max_length=100, description="所属组别")
    # 值班类别已取消；保留可选字段兼容旧客户端，后端统一存 ANY
    duty_category: Optional[Literal["PERMANENT_DAY", "DAY", "NIGHT", "ANY"]] = Field(None, description="值班类别（已废弃）")
    is_primary: bool = Field(False, description="是否主值班人（已废弃）")
    sort_order: int = Field(0, description="排序权重（值小的优先轮换）")
    status: Literal["active", "inactive"] = Field("active", description="状态")


class DutyMemberUpdate(BaseModel):
    """编辑值班人员。"""

    name: Optional[str] = Field(None, min_length=1, max_length=100)
    phone: Optional[str] = Field(None, min_length=1, max_length=50)
    group_name: Optional[str] = Field(None, max_length=100)
    duty_category: Optional[Literal["PERMANENT_DAY", "DAY", "NIGHT"]] = None
    is_primary: Optional[bool] = None
    sort_order: Optional[int] = None
    status: Optional[Literal["active", "inactive"]] = None


class ScheduleGenerateRequest(BaseModel):
    """生成值班表请求。"""

    start_date: DateType = Field(..., description="起始日期")
    end_date: DateType = Field(..., description="结束日期")
    # 值班表类型：DAILY=日常运营 / RESERVE=重保值班（同一日期两类表可并存）
    roster_type: Literal["DAILY", "RESERVE"] = Field("DAILY", description="值班表类型")
    # 日期范围内已有记录时的处理策略：overwrite 覆盖重排 / fill 仅填充空缺日期
    conflict_strategy: Literal["overwrite", "fill"] = Field("overwrite", description="冲突策略")
    # 是否直接发布（True 生成后即为 published，False 仅生成 draft 供预览）
    auto_publish: bool = Field(False, description="生成后是否直接发布")


class ManualAdjustRequest(BaseModel):
    """手动调班请求。"""

    shift: Literal["DAY", "NIGHT"] = Field(..., description="班次")
    new_member_id: Optional[int] = Field(None, description="新值班人员ID（None 表示清空待分配）")
    reason: str = Field("", max_length=500, description="调整原因")


class RecordStatusUpdate(BaseModel):
    """值班记录状态变更（发布/过期）。"""

    status: Literal["draft", "published", "expired"] = Field(..., description="新状态")


class LeaveCreate(BaseModel):
    """提交请假申请。"""

    member_id: int = Field(..., description="请假人员ID")
    start_date: DateType = Field(..., description="请假开始日期")
    end_date: DateType = Field(..., description="请假结束日期")
    shift: Literal["DAY", "NIGHT", "ALL"] = Field("ALL", description="班次")
    reason: str = Field("", max_length=500, description="请假原因")


class LeaveApprove(BaseModel):
    """审批请假申请。"""

    status: Literal["approved", "rejected"] = Field(..., description="审批结果")
    reason: str = Field("", max_length=500, description="审批说明")


class SpecialDateItem(BaseModel):
    """单条特殊日期覆盖。"""

    date: DateType = Field(..., description="日期")
    day_type: Literal["holiday", "workday"] = Field(..., description="holiday=非工作日 / workday=工作日（调休上班）")
    note: Optional[str] = Field(None, max_length=100, description="备注")


class SpecialDatesUpdate(BaseModel):
    """批量设置特殊日期覆盖（整体覆盖式）。"""

    items: list[SpecialDateItem] = Field(default_factory=list, description="特殊日期列表")


class ScheduleCopyRequest(BaseModel):
    """复制值班表请求：将源日期范围的排班按天平移到目标起始日期。"""

    source_start: DateType = Field(..., description="源起始日期")
    source_end: DateType = Field(..., description="源结束日期")
    target_start: DateType = Field(..., description="目标起始日期（按天平移源记录）")
    roster_type: Literal["DAILY", "RESERVE"] = Field("DAILY", description="值班表类型（源与目标同一类型）")
    auto_publish: bool = Field(False, description="复制后是否直接发布")


class GraphAssignRequest(BaseModel):
    """图形化排班：将人员拖拽到某日某班次（member_id=None 表示清空该班次）。"""

    duty_date: DateType = Field(..., description="值班日期")
    roster_type: Literal["DAILY", "RESERVE"] = Field("DAILY", description="值班表类型")
    shift: Literal["DAY", "NIGHT"] = Field(..., description="班次")
    member_id: Optional[int] = Field(None, description="值班人员ID")
    action: Literal["add", "remove"] = Field("add", description="add=追加到班次 / remove=从班次移除")
    reason: str = Field("", max_length=500, description="调整原因")


class ManualScheduleDay(BaseModel):
    """手动新建值班表：单日白班/晚班人员。"""

    duty_date: DateType = Field(..., description="值班日期")
    day_member_ids: list[int] = Field(default_factory=list, description="白班人员ID列表")
    night_member_ids: list[int] = Field(default_factory=list, description="晚班人员ID列表")


class ManualScheduleCreateRequest(BaseModel):
    """手动新建值班表：按日期范围提交每天的白班/晚班人员（替代原自动生成）。"""

    start_date: DateType = Field(..., description="起始日期")
    end_date: DateType = Field(..., description="结束日期")
    roster_type: Literal["DAILY", "RESERVE"] = Field("DAILY", description="值班表类型")
    conflict_strategy: Literal["overwrite", "fill"] = Field("overwrite", description="已有记录处理：overwrite 覆盖 / fill 仅创建缺失")
    auto_publish: bool = Field(False, description="创建后是否直接发布")
    days: list[ManualScheduleDay] = Field(default_factory=list, description="每天的排班人员")


class RecordEditRequest(BaseModel):
    """整条值班记录编辑（草稿/已发布均可）：一次更新白班、晚班与状态。

    人员以 ID 列表提交，支持一个班次多人；旧的单值字段仅用于兼容，
    同时提供时以列表为准。
    """

    day_member_ids: Optional[list[int]] = Field(None, description="白班人员ID列表（空列表=待分配）")
    night_member_ids: Optional[list[int]] = Field(None, description="晚班人员ID列表（空列表=待分配）")
    day_member_id: Optional[int] = Field(None, description="兼容字段：白班人员ID")
    night_member_id: Optional[int] = Field(None, description="兼容字段：晚班人员ID")
    status: Optional[Literal["draft", "published"]] = Field(None, description="记录状态")
    reason: str = Field("", max_length=500, description="编辑原因（写入调班日志）")


class MemberBatchStatusUpdate(BaseModel):
    """批量启用/停用值班人员。"""

    ids: list[int] = Field(..., min_length=1, description="值班人员 ID 列表")
    status: Literal["active", "inactive"] = Field(..., description="目标状态")


class MemberReorderRequest(BaseModel):
    """批量重排值班人员顺序（重算 sort_order）。"""

    ordered_ids: list[int] = Field(..., min_length=1, description="按新顺序排列的人员 ID 列表")


class BatchIds(BaseModel):
    """批量删除通用请求体（请假记录 / 调班记录 / 值班记录）。"""

    ids: list[int] = Field(..., min_length=1, description="待删除的 ID 列表")
