"""用户管理 Schema。"""
from typing import Optional

from app.schemas._datetime import BeijingDatetime
from pydantic import BaseModel, ConfigDict, Field


class UserCreate(BaseModel):
    """创建用户请求体。

    安全防护：``extra="forbid"`` 拒绝未声明字段（isadmin / issso 等注入），
    防止 API 成批分配（Mass Assignment）。
    """

    model_config = ConfigDict(extra="forbid")

    username: str = Field(..., min_length=2, max_length=64, description="登录用户名")
    password: str = Field(..., min_length=1, max_length=128, description="初始密码")
    display_name: Optional[str] = Field(None, max_length=128)
    email: Optional[str] = Field(None, max_length=255)
    role: str = Field("analyst", description="角色名（关联 roles 表 name 字段）")
    role_id: Optional[int] = Field(None, description="角色 ID（优先于 role 字段）")
    is_active: bool = True
    # 允许的登录方式（为空则允许所有方式）
    allowed_login_methods: Optional[list[str]] = Field(None, description="允许的登录方式：password / otp / sso")


class UserUpdate(BaseModel):
    """更新用户请求体（不含密码）。

    安全防护：``extra="forbid"`` 拒绝未声明字段，仅允许更新白名单列出的字段。
    """

    model_config = ConfigDict(extra="forbid")

    display_name: Optional[str] = None
    email: Optional[str] = None
    role: Optional[str] = None
    role_id: Optional[int] = None
    is_active: Optional[bool] = None
    # 允许的登录方式
    allowed_login_methods: Optional[list[str]] = None


class UserOut(BaseModel):
    """用户输出 Schema。"""

    id: int
    username: str
    display_name: Optional[str] = None
    email: Optional[str] = None
    role: str
    role_id: Optional[int] = None
    role_name: Optional[str] = None  # 角色显示名（关联 roles 表 name 字段，自定义角色用）
    is_active: bool
    created_at: Optional[BeijingDatetime] = None
    last_login_at: Optional[BeijingDatetime] = None
    # 个人资料扩展字段
    phone: Optional[str] = None
    department: Optional[str] = None
    language: Optional[str] = "zh-CN"
    timezone: Optional[str] = "Asia/Shanghai"
    bio: Optional[str] = None
    avatar: Optional[str] = None
    # OTP / SSO / 登录方式
    otp_enabled: bool = False
    sso_linked: bool = False
    allowed_login_methods: Optional[list[str]] = None
    # 等保安全字段：登录失败计数与锁定截止时间（用户管理页展示冻结状态）
    failed_login_count: int = 0
    locked_until: Optional[BeijingDatetime] = None
    # 当前是否处于锁定（冻结）状态：由列表接口按安全策略计算，
    # 「需人工解锁」模式下 locked_until 过期仍为 True
    is_locked: bool = False

    model_config = {"from_attributes": True}


class ResetPasswordRequest(BaseModel):
    """管理员重置密码请求体。"""

    new_password: str = Field(..., min_length=1, max_length=128)


class UpdateProfileRequest(BaseModel):
    """用户自助修改个人资料请求体。

    安全防护：``extra="forbid"`` 仅允许白名单字段（个人资料），
    防止客户端注入 role / is_active / otp_enabled 等敏感字段。
    """

    model_config = ConfigDict(extra="forbid")

    display_name: Optional[str] = None
    email: Optional[str] = None
    phone: Optional[str] = None
    department: Optional[str] = None
    language: Optional[str] = None
    timezone: Optional[str] = None
    bio: Optional[str] = None
    avatar: Optional[str] = None
