"""工单功能模型。

包含 6 张表：
- ``TicketGroup``：工单处理分组（自定义人员分组，如"监测预警组/研判分析组/应急处置组"）
- ``TicketGroupMember``：分组成员（分组-用户多对多关联）
- ``TicketFlow``：工单流程模板（节点/字段/路由全部内嵌 nodes JSON，支持草稿/发布/版本）
- ``Ticket``：工单实例（发起时对流程模板做快照，进行中工单不受模板修改影响）
- ``TicketNodeRecord``：工单节点处理记录（每个节点的处理人/填写的字段值/流转去向，构成处理时间线）
- ``TicketCc``：工单抄送对象（模板固定抄送 + 手动追加，支持人员与分组）

处理模式：节点到达分组后组内全员可见，任一人提交即代表全组（先到先得）。
"""
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, JSON, func

from app.core.timezone import to_beijing_iso
from app.database import Base


class TicketGroup(Base):
    """工单处理分组：把系统现有人员账号自定义分组。"""

    __tablename__ = "ticket_groups"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False, unique=True)
    description = Column(String(255), nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def to_dict(self, member_count: int | None = None) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        if member_count is not None:
            result["member_count"] = member_count
        return result

    def __repr__(self) -> str:
        return f"<TicketGroup id={self.id} name={self.name!r}>"


class TicketGroupMember(Base):
    """分组成员：分组与用户的多对多关联。"""

    __tablename__ = "ticket_group_members"
    __table_args__ = (
        UniqueConstraint("group_id", "user_id", name="uq_ticket_group_member"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    group_id = Column(Integer, ForeignKey("ticket_groups.id"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id"), nullable=False, index=True)
    created_at = Column(DateTime, server_default=func.now())

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result


class TicketFlow(Base):
    """工单流程模板。

    ``nodes`` JSON 结构::

        {
          "start_groups": [1, 2],          # 可发起工单的分组 ID 列表
          "nodes": [
            {
              "key": "n1",                  # 节点唯一标识（流程内唯一，不可变）
              "name": "研判分析",           # 节点显示名
              "group_id": 3,                # 处理分组（type=end 时可为空）
              "type": "task",               # task=处理节点 / end=结束节点
              "fields": [                   # 该节点需填写的字段
                {"key": "is_false_alarm", "label": "是否误报", "type": "select",
                 "required": true, "options": ["是", "否"],
                 "placeholder": "", "alert_field_mapping": "alert_name",
                 "default": ""}
              ],
              "routes": [                   # 流转路由（按序匹配，可带条件）
                {"to": "n2", "label": "需应急", "when": {"field": "is_need_emergency", "op": "eq", "value": "是"}},
                {"to": "end", "label": "默认", "when": null}
              ],
              "rollback_to": ["n1"]        # 回退白名单（可选）：本节点仅允许退回这些节点；
                                           # 空数组=禁止回退；缺省=退回上一处理节点（默认）
            },
            {
              "key": "n_sign",             # 并行会签节点：多个分组同时处理
              "name": "多方会签",
              "type": "parallel",          # parallel=并行会签（用 sign_groups 代替 group_id）
              "sign_groups": [3, 5],       # 会签分组列表（至少 2 组才有会签意义）
              "finish_policy": "all",      # all=全部会签完成才流转 / any=任一分组提交即流转
              "fields": [], "routes": [...]
            }
          ]
        }

    字段类型：text/textarea/number/datetime/select/switch/ip/url/file。
    条件操作符：eq（等于）/ ne（不等于）。
    ``is_draft``：草稿状态不会被发起工单引用；发布时做结构校验。
    ``version``：每次发布自增，仅记录当前发布版本号。
    """

    __tablename__ = "ticket_flows"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    description = Column(String(255), nullable=True)
    enabled = Column(Boolean, nullable=False, default=True)
    is_draft = Column(Boolean, nullable=False, default=True)
    version = Column(Integer, nullable=False, default=0)
    nodes = Column(JSON, nullable=False, default=dict)
    created_by = Column(String(64), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result

    def __repr__(self) -> str:
        return f"<TicketFlow id={self.id} name={self.name!r} draft={self.is_draft}>"


class TicketFlowVersion(Base):
    """流程模板发布版本存档：每次发布时写入完整快照。

    - 与 ``TicketFlow.version`` 对应：发布 version 自增后落一条存档
    - 回滚：用存档内容覆盖当前模板（name/description/nodes），回到草稿态需重新发布
    - 老模板（启用存档前发布的版本）无对应记录，自下一次发布起开始存档
    """

    __tablename__ = "ticket_flow_versions"
    __table_args__ = (
        UniqueConstraint("flow_id", "version", name="uq_ticket_flow_version"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    flow_id = Column(Integer, ForeignKey("ticket_flows.id"), nullable=False, index=True)
    version = Column(Integer, nullable=False)
    name = Column(String(100), nullable=False)
    description = Column(String(255), nullable=True)
    nodes = Column(JSON, nullable=False, default=dict)
    published_by = Column(String(64), nullable=True)
    published_at = Column(DateTime, server_default=func.now())

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result

    def __repr__(self) -> str:
        return f"<TicketFlowVersion id={self.id} flow={self.flow_id} v{self.version}>"


class Ticket(Base):
    """工单实例。

    - ``ticket_no``：工单编号，格式 ``TK-YYYYMMDD-XXXX``（当日自增序号）
    - ``flow_snapshot``：发起时的流程模板完整快照，后续模板修改不影响进行中工单
    - ``status``：processing=进行中 / completed=已完成 / cancelled=已取消
    - ``current_node_key``：当前停留节点（status=processing 时有效）
    - ``current_group_id``：当前处理分组（决定谁可见/可处理）
    - ``priority``：low/medium/high/critical
    - ``related_alert_id`` / ``related_alert_uuid``：关联告警（一键发起时写入）
    - ``arrived_at``：进入当前节点时间（节点停留超时提醒的计时起点，流转时重置）
    - ``first_reminded_at`` / ``last_reminded_at`` / ``remind_count``：超时提醒进度
    - ``archived``：归档标记（软删除，仅完结工单可归档，可取消归档恢复）
    - ``claimed_by_id``：认领人（组内先到先得认领后锁定，仅认领人/admin 可提交；
      流转/回退/转办到分组时自动释放）
    - ``enrichment_data``：发起时对 src_ip / dst_ip 自动研判的结果
      （资产库匹配 + 威胁情报查询，JSON 结构见 app.core.ticket_enrichment），
      随工单全程流转，各节点处理人只读可见
    """

    __tablename__ = "tickets"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ticket_no = Column(String(32), nullable=False, unique=True, index=True)
    title = Column(String(200), nullable=False)
    flow_id = Column(Integer, ForeignKey("ticket_flows.id"), nullable=False, index=True)
    flow_name = Column(String(100), nullable=False, default="")
    flow_snapshot = Column(JSON, nullable=False, default=dict)
    status = Column(String(20), nullable=False, default="processing", index=True)
    current_node_key = Column(String(64), nullable=True)
    current_node_name = Column(String(100), nullable=True)
    current_group_id = Column(Integer, nullable=True, index=True)
    created_by_id = Column(Integer, nullable=False, index=True)
    created_by_name = Column(String(64), nullable=False, default="")
    priority = Column(String(20), nullable=False, default="medium")
    related_alert_id = Column(Integer, nullable=True, index=True)
    related_alert_uuid = Column(String(64), nullable=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())
    closed_at = Column(DateTime, nullable=True)
    # 节点停留超时提醒（阶段2）：由定时扫描任务维护，流转到新节点时重置
    arrived_at = Column(DateTime, nullable=True)
    first_reminded_at = Column(DateTime, nullable=True)
    last_reminded_at = Column(DateTime, nullable=True)
    remind_count = Column(Integer, nullable=False, default=0)
    # 归档标记（阶段2）：软删除，列表默认排除归档工单
    archived = Column(Boolean, nullable=False, default=False)
    # 认领锁定：组内成员认领后仅认领人（或 admin）可提交，流转/回退/转办到分组时释放
    claimed_by_id = Column(Integer, nullable=True)
    # 当前待处理分组 CSV（",3,5,"）：并行会签节点为全部待签分组，普通节点为单个分组；
    # current_group_id 始终指向其中首个（兼容展示/转办），NULL = 已完结/无分组
    current_group_ids = Column(String(255), nullable=True)
    # 发起时自动研判结果（资产匹配 + 威胁情报，按 src_ip/dst_ip），随工单流转
    enrichment_data = Column(JSON, nullable=True)

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result

    def __repr__(self) -> str:
        return f"<Ticket id={self.id} no={self.ticket_no!r} status={self.status!r}>"


class TicketCc(Base):
    """工单抄送对象。

    - ``target_type``：user=个人 / group=工单分组（组内全员均在「抄送我的」可见并收到通知）
    - ``source``：template=模板固定抄送（发起时快照自流程模板 cc_targets）/ manual=手动追加
    - 通知时机：发起与被加入抄送时通知一次；工单完结（完成/取消）时通知最终结果
    - 同一工单同一对象仅一条（唯一约束去重）；发起人/当前处理人/admin 可增减
    """

    __tablename__ = "ticket_ccs"
    __table_args__ = (
        UniqueConstraint("ticket_id", "target_type", "target_id", name="uq_ticket_cc"),
    )

    id = Column(Integer, primary_key=True, autoincrement=True)
    ticket_id = Column(Integer, ForeignKey("tickets.id"), nullable=False, index=True)
    target_type = Column(String(10), nullable=False)  # user / group
    target_id = Column(Integer, nullable=False)
    target_name = Column(String(100), nullable=False, default="")
    source = Column(String(10), nullable=False, default="template")  # template / manual
    created_by_id = Column(Integer, nullable=True)
    created_by_name = Column(String(64), nullable=True, default="")
    created_at = Column(DateTime, server_default=func.now())

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result

    def __repr__(self) -> str:
        return f"<TicketCc id={self.id} ticket={self.ticket_id} {self.target_type}:{self.target_id}>"


class TicketNodeRecord(Base):
    """工单节点处理记录：每个节点一条，构成处理时间线。

    - ``node_key`` / ``node_name``：快照中的节点标识与名称（含发起节点 start）
    - ``group_id``：该节点的处理分组（发起节点为发起人所在分组，可为空）
    - ``handler_id`` / ``handler_name``：实际处理人（先到先得：组内任一人提交即代表全组）
    - ``action``：create=发起 / submit=提交流转 / cancel=取消 / end=结束落位 /
      rollback=退回上一步 / urge=催办 / transfer=转办 / claim=认领 / comment=内部评论
    - ``field_values``：本节点填写的字段值 JSON
    - ``route_to``：流转去向节点 key（结束为 end）
    - ``comment``：处理意见
    - ``attachments``：附件列表 JSON（[{name, url}]，一期预留）
    """

    __tablename__ = "ticket_node_records"

    id = Column(Integer, primary_key=True, autoincrement=True)
    ticket_id = Column(Integer, ForeignKey("tickets.id"), nullable=False, index=True)
    node_key = Column(String(64), nullable=False, default="")
    node_name = Column(String(100), nullable=False, default="")
    group_id = Column(Integer, nullable=True)
    handler_id = Column(Integer, nullable=False)
    handler_name = Column(String(64), nullable=False, default="")
    action = Column(String(20), nullable=False, default="submit")
    field_values = Column(JSON, nullable=False, default=dict)
    route_to = Column(String(64), nullable=True)
    comment = Column(Text, nullable=True)
    attachments = Column(JSON, nullable=True)
    created_at = Column(DateTime, server_default=func.now())

    def to_dict(self) -> dict:
        result = {}
        for column in self.__table__.columns:
            value = getattr(self, column.name)
            result[column.name] = to_beijing_iso(value) if hasattr(value, "isoformat") else value
        return result

    def __repr__(self) -> str:
        return f"<TicketNodeRecord id={self.id} ticket={self.ticket_id} node={self.node_key!r}>"
