"""系统配置 API。

键值对存储平台级配置，支持批量读取与更新。
预置配置项：平台名称、Logo、主题色、CORS 白名单、Webhook 限流等。
"""
import logging

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.dependencies import get_current_user, require_permission
from app.models.system_config import SystemConfig
from app.models.user import User
from app.schemas.system_config import SystemConfigOut, SystemConfigUpdate

logger = logging.getLogger(__name__)

router = APIRouter(
    prefix="/system-config",
    tags=["system-config"],
    dependencies=[Depends(get_current_user)],
)

# 预置配置项及其默认值与描述（首次访问时自动补齐）
DEFAULT_CONFIGS: dict[str, dict[str, str]] = {
    "platform_name": {"value": "SOAR 平台", "description": "平台显示名称"},
    "logo_url": {"value": "", "description": "Logo 图片 URL"},
    "primary_color": {"value": "#6366f1", "description": "主题色（十六进制色值）"},
    "cors_origins": {
        "value": "http://localhost:8080,http://localhost:5173",
        "description": "CORS 白名单（逗号分隔）",
    },
    "webhook_rate_limit": {"value": "30", "description": "Webhook 限流（次/分钟）"},
    # 常用基础项
    "system.default_language": {"value": "zh-CN", "description": "系统默认语言"},
    "system.default_timezone": {"value": "Asia/Shanghai", "description": "默认时区"},
    "system.datetime_format": {"value": "YYYY-MM-DD HH:mm:ss", "description": "日期时间格式"},
    "system.max_upload_size_mb": {"value": "50", "description": "文件上传大小限制（MB）"},
    "system.home_page": {"value": "/dashboard", "description": "登录后默认首页"},
    "model.health_check_interval": {
        "value": "300",
        "description": "模型健康检查间隔（秒，范围 60-3600，修改后下次循环生效）",
    },
    # 日志中心：保留策略（全局 + 分类）
    "log.retention_days": {
        "value": "30",
        "description": "日志保留天数（超过自动清理，范围 7-365）",
    },
    "log.max_storage_mb": {
        "value": "500",
        "description": "日志最大存储量（MB，超过时按时间倒序清理最旧日志）",
    },
    # 分类保留策略：不同日志类型独立保留天数
    "log.audit_retention_days": {
        "value": "90",
        "description": "操作审计日志保留天数（范围 7-365）",
    },
    "log.executions_retention_days": {
        "value": "30",
        "description": "执行记录保留天数（范围 7-365）",
    },
    "log.execution_logs_retention_days": {
        "value": "30",
        "description": "执行日志保留天数（范围 7-365）",
    },
    "log.model_calls_retention_days": {
        "value": "7",
        "description": "模型调用日志保留天数（范围 7-365）",
    },
    "yunfang.embed_url": {
        "value": "https://xingtu.yunaq.com/#/Attack/",
        "description": "盾立方W 嵌入地址",
    },
    "yunfang.username": {"value": "", "description": "盾立方W 免登账号"},
    "yunfang.password": {"value": "", "description": "盾立方W 免登密码（明文，后端登录换票）"},
    "bigscreen.base_url": {
        "value": "http://10.132.109.75",
        "description": "盾立方指挥大屏 平台基址",
    },
    "bigscreen.path": {
        "value": "/city/#/bigscreen",
        "description": "盾立方指挥大屏 跳转路径",
    },
    "bigscreen.code": {
        "value": "08498bb43396419aae5052a90b568b5d",
        "description": "盾立方指挥大屏 code",
    },
    "bigscreen.appid": {
        "value": "2c958082961d687a019632cf1d120005",
        "description": "盾立方指挥大屏 appid",
    },
    "bigscreen.username": {"value": "", "description": "盾立方指挥大屏 免登账号"},
    "bigscreen.password": {"value": "", "description": "盾立方指挥大屏 免登密码（明文，后端加密后换票）"},
    "bigscreen.usergroupid": {"value": "0", "description": "盾立方指挥大屏 登录方式：0账号登录 1市认证登录"},
    # 解析入库：模板成功率告警阈值（持续 24 小时低于该值生成告警+通知中心提醒）
    "parse.success_rate_threshold": {
        "value": "80",
        "description": "解析模板成功率告警阈值（百分比，持续 24 小时低于该值生成告警）",
    },
}


@router.get("", response_model=list[SystemConfigOut])
def list_configs(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("system_config", "view")),
) -> list[SystemConfig]:
    """列出所有系统配置项（自动补齐缺失的预置项）。"""
    configs = db.query(SystemConfig).order_by(SystemConfig.key).all()
    existing_keys = {c.key for c in configs}

    # 补齐缺失的预置配置项
    for key, meta in DEFAULT_CONFIGS.items():
        if key not in existing_keys:
            cfg = SystemConfig(
                key=key, value=meta["value"], description=meta["description"]
            )
            db.add(cfg)
            configs.append(cfg)

    if len(configs) > len(existing_keys):
        db.commit()

    return configs


def _validate_config_value(key: str, value: str) -> str:
    """按配置键校验取值（当前仅登录 IP 白名单需要 IP/CIDR 校验）。"""
    if key == "security.login_ip_whitelist":
        from app.core.ip_validation import validate_ip_expression

        try:
            return validate_ip_expression(value, "登录 IP 白名单")
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
    return value


@router.put("")
def update_configs(
    body: SystemConfigUpdate,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("system_config", "edit")),
) -> dict:
    """批量更新系统配置。"""
    for key, value in body.configs.items():
        value = _validate_config_value(key, value)
        cfg = db.query(SystemConfig).filter(SystemConfig.key == key).first()
        if cfg:
            cfg.value = value
        else:
            desc = DEFAULT_CONFIGS.get(key, {}).get("description", "")
            db.add(SystemConfig(key=key, value=value, description=desc))
    db.commit()
    logger.info("系统配置批量更新: keys=%s", list(body.configs.keys()))
    return {"ok": True}


@router.get("/security")
def get_security_config(
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("system_config", "view")),
) -> dict:
    """获取等保安全策略配置。"""
    from app.core.security_policy import get_security_policy

    policy = get_security_policy(db)
    return {"policy": policy}


@router.put("/security")
def update_security_config(
    body: dict,
    db: Session = Depends(get_db),
    _: User = Depends(require_permission("system_config", "edit")),
) -> dict:
    """更新等保安全策略配置。

    body 为 ``{key: value}`` 字典，仅接受 ``security.*`` 前缀的键。
    """
    from app.core.security_policy import DEFAULT_SECURITY_POLICY

    updated = []
    for key, value in body.items():
        # 仅允许更新已知的安全策略键
        if key not in DEFAULT_SECURITY_POLICY:
            continue
        str_value = str(value) if not isinstance(value, bool) else ("true" if value else "false")
        str_value = _validate_config_value(key, str_value)
        cfg = db.query(SystemConfig).filter(SystemConfig.key == key).first()
        if cfg:
            cfg.value = str_value
        else:
            db.add(SystemConfig(key=key, value=str_value, description="等保安全策略"))
        updated.append(key)
    db.commit()
    logger.info("安全策略更新: keys=%s", updated)
    return {"ok": True, "updated": updated}


# ============ 测试连接 / 即时验证 ============

from pydantic import BaseModel as _BaseModel


class TestCorsRequest(_BaseModel):
    """CORS 跨域测试请求体。"""

    origin: str


@router.post("/test-cors")
def test_cors(body: TestCorsRequest) -> dict:
    """测试指定的 Origin 是否在当前 CORS 白名单中。

    用于即时验证：配置 CORS 白名单后无需保存即可检查某个源地址是否被允许跨域。
    注意：此处基于已保存配置校验；若用户在前端改了未保存，可先保存再测，或前端本地预校验。
    """
    from app.config import settings

    origin = (body.origin or "").strip().rstrip("/")
    if not origin:
        return {"ok": False, "message": "请输入要测试的 Origin（如 http://localhost:5173）"}
    allowed = settings.CORS_ORIGINS or []
    # 白名单匹配：去除尾部斜杠后比较
    normalized_allowed = [a.strip().rstrip("/") for a in allowed]
    matched = origin in normalized_allowed
    if matched:
        return {"ok": True, "message": f"✓ Origin「{origin}」已在 CORS 白名单中，跨域请求将被允许"}
    return {
        "ok": False,
        "message": f"✗ Origin「{origin}」不在白名单中。当前白名单：{', '.join(normalized_allowed) or '(空)'}",
        "current": normalized_allowed,
    }


class TestWebhookRequest(_BaseModel):
    """Webhook 限流测试请求体。"""

    rate_limit: str = ""


@router.post("/test-webhook")
def test_webhook(body: TestWebhookRequest) -> dict:
    """测试 Webhook 限流配置是否合法，并给出友好描述。

    校验限流值为正整数，并返回友好描述（如「每分钟最多 30 次调用」）。
    """
    raw = (body.rate_limit or "").strip()
    try:
        val = int(raw)
    except (ValueError, TypeError):
        return {"ok": False, "message": "✗ Webhook 限流必须是正整数"}
    if val <= 0:
        return {"ok": False, "message": "✗ Webhook 限流必须大于 0"}
    return {
        "ok": True,
        "message": f"✓ 配置有效：每分钟最多 {val} 次调用",
        "friendly": f"每分钟最多 {val} 次调用",
    }
