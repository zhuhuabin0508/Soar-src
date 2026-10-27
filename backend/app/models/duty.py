"""值班管理模型。

包含 5 张表：
- ``DutyMember``：值班人员（含姓名/电话/组别/值班类别/排序/状态，软删除）
- ``DutyRecord``：值班记录（按日生成，含白班/晚班人员ID、日期类型、状态）
- ``DutyRotationCursor``：轮换游标（NIGHT / DAY 类别的上次轮换位置）
- ``DutyAdjustmentLog``：调班日志（手动替换记录）
- ``DutyLeaveLog``：请假记录（关联人员/日期范围/班次/审批状态）
"""
from sqlalchemy import Boolean, Column, Date, DateTime, Integer, String, Text, func

from app.core.timezone import to_beijing_iso
from app.database import Base


class DutyMember(Base):
    """值班人员。

    值班人员不再区分白班/晚班类别：所有启用人员均可被排到任意班次。
    ``duty_category`` 为历史字段，仅保留兼容旧数据，不再参与排班与界面展示。

    - ``is_primary``：历史字段（主值班人），保留兼容
    - ``sort_order``：排序权重（人员列表展示顺序）
    - ``status``：启用/停用
    - ``deleted_at``：软删除时间
    """

    __tablename__ = "duty_members"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    phone = Column(String(50), nullable=False)
    group_name = Column(String(100), nullable=False, default="")
    duty_category = Column(String(20), nullable=False, index=True)
    is_primary = Column(Boolean, nullable=False, default=False)
    sort_order = Column(Integer, nullable=False, default=0)
    status = Column(String(20), nullable=False, default="active")  # active / inactive
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    deleted_at = Column(DateTime, nullable=True)  # 软删除

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result

    def __repr__(self) -> str:
        return f"<DutyMember id={self.id} name={self.name!r} category={self.duty_category!r}>"


class DutyRecord(Base):
    """值班记录：按日生成，每天一条，含白班和晚班两个排班位。

    - ``duty_date``：值班日期
    - ``roster_type``：值班表类型，``DAILY``=日常运营 / ``RESERVE``=重保值班；
      同一日期两类表可并存，所有按日期查询的接口都需按类型隔离
    - ``day_member_ids`` / ``night_member_ids``：白班/晚班人员ID列表（逗号分隔，
      支持一个班次多人）；``day_member_id`` / ``night_member_id`` 为兼容旧逻辑的
      第一负责人冗余字段
    - ``is_holiday``：是否非工作日（周末/法定节假日）
    - ``status``：草稿 draft / 已发布 published / 已过期 expired
    - ``generated_batch``：生成批次号（同一次自动生成的记录共用）
    """

    __tablename__ = "duty_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    duty_date = Column(Date, nullable=False, index=True)
    roster_type = Column(String(20), nullable=False, default="DAILY",
                         server_default="DAILY", index=True)  # DAILY / RESERVE
    day_member_ids = Column(Text, nullable=True)   # 逗号分隔的人员ID，支持多人
    night_member_ids = Column(Text, nullable=True)
    day_member_id = Column(Integer, nullable=True, index=True)   # 兼容：第一负责人
    night_member_id = Column(Integer, nullable=True, index=True)
    is_holiday = Column(Boolean, nullable=False, default=False)
    status = Column(String(20), nullable=False, default="draft", index=True)
    generated_batch = Column(String(50), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result

    def __repr__(self) -> str:
        return f"<DutyRecord id={self.id} date={self.duty_date} status={self.status!r}>"


class DutyRotationCursor(Base):
    """轮换游标：记录 NIGHT / DAY 类别上次轮换到的位置索引。

    每次自动生成值班表时从游标的下一个位置开始轮换，
    生成完成后更新游标，保证轮换连续性。

    ``category`` 在日常运营值班表下为 ``DAY`` / ``NIGHT``；重保值班表使用
    ``RESERVE:DAY`` / ``RESERVE:NIGHT``，使两类值班表各自独立轮换。
    """

    __tablename__ = "duty_rotation_cursors"

    id = Column(Integer, primary_key=True, autoincrement=True)
    category = Column(String(20), nullable=False, unique=True)  # NIGHT / DAY
    last_index = Column(Integer, nullable=False, default=-1)  # 上次轮换到的位置（-1 表示尚未轮换）
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result


class DutyAdjustmentLog(Base):
    """调班日志：记录所有手动替换值班人员的操作。"""

    __tablename__ = "duty_adjustment_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    duty_record_id = Column(Integer, nullable=False, index=True)
    shift = Column(String(10), nullable=False)  # DAY / NIGHT
    original_member_id = Column(Integer, nullable=True)
    new_member_id = Column(Integer, nullable=True)
    reason = Column(Text, nullable=True)
    operator_id = Column(Integer, nullable=False)
    operated_at = Column(DateTime, server_default=func.now())

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result


class DutyLeaveLog(Base):
    """请假记录：人员提交请假申请，关联值班表调整。"""

    __tablename__ = "duty_leave_logs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    member_id = Column(Integer, nullable=False, index=True)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    shift = Column(String(10), nullable=False, default="ALL")  # DAY / NIGHT / ALL
    reason = Column(Text, nullable=True)
    status = Column(String(20), nullable=False, default="pending")  # pending / approved / rejected
    operator_id = Column(Integer, nullable=True)
    approve_reason = Column(Text, nullable=True)  # 审批意见（approve/reject 时填写）
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result
