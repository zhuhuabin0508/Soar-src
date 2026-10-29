"""安博通阻断器设备播种脚本：幂等同步黑名单（Blacklist）相关动作。

用法（在 backend 目录下，需已安装 backend 依赖 + 可连数据库）:
    python -m scripts.seed_anbotong_device

数据来源：`安博通阻断应急拦截网关restful_API接口说明-V1.3`「黑名单」章节
（文档目录 7.1，修订记录 7.13.3/7.13.4 补充了策略分组、生效字段与连续 IP/网段支持）。

逻辑:
  1. 按设备名称定位已有设备「安博通阻断器」，不改动其连接凭据 / api_url。
     设备 api_url 已包含 `/api/v3`，因此动作 api_path 从 `/Objects/Blacklist` 开始。
  2. 以 device_id + 动作名称为幂等键，同步 5 个黑名单动作：
     查询列表 / 查询单条 / 新建（封禁）/ 修改 / 删除（解封）。
  3. 重复执行安全：已存在同名动作只更新字段，不重复创建。
"""
import json
import logging

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models.device import Device, DeviceAction

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
logger = logging.getLogger("seed_anbotong")

_DEVICE_NAME = "安博通阻断器"

# 黑名单生命周期说明（文档：restful 接口支持 -1~2592000 秒，-1 表示永久）
_AGE_DESC = (
    "黑名单生命周期（秒）：-1 表示永久，有效范围 -1~2592000；"
    "安博通不接受 0，平台传 0（永久）时执行器会按 map_values 自动转换为 -1"
)
# 平台封禁流程用 duration=0 表示永久，安博通要求 -1，用取值映射对齐语义
_AGE_MAP = {"0": "-1"}
_REASON_OPTIONS = (
    "手动添加、端口扫描防护、IP扫描防护、IPS、防暴力破解、CC攻击防护、"
    "DNS隧道、威胁情报、导入、API添加、安全分析、自定义添加"
)


def _body_template(blist_key: str, age_key: str) -> str:
    """请求体模板：接口要求 {"blist_entry":[{...}]}，字段名与文档一致。

    参数占位符按动作参数名替换：封禁动作对外沿用平台惯例的 ip/duration，
    执行时映射到接口的 blist/age；修改动作直接使用 blist/age。
    """
    return json.dumps(
        {
            "blist_entry": [
                {
                    "blist": f"{{{{{blist_key}}}}}",
                    "age": f"{{{{{age_key}}}}}",
                    "reason": "{{reason}}",
                    "policy_group_name": "{{policy_group_name}}",
                    "enable": "{{enable}}",
                }
            ]
        },
        ensure_ascii=False,
    )


_BODY_TEMPLATE_BLOCK = _body_template("ip", "duration")
_BODY_TEMPLATE_MODIFY = _body_template("blist", "age")


def _params(*items: dict) -> str:
    """把参数定义序列化为 params_schema 字符串。"""
    return json.dumps(list(items), ensure_ascii=False)


# 动作定义：name / action_type / method / path / schema / body / desc / 示例
_ACTIONS: list[dict] = [
    {
        "name": "查询黑名单列表",
        "action_type": "custom",
        "category": "query",
        "risk_level": "readonly",
        "http_method": "GET",
        "api_path": "/Objects/Blacklist",
        "params_schema": "[]",
        "body_template": "",
        "description": "查询设备当前全部黑名单条目（含剩余时长、命中次数、策略组与生效状态）",
        "example_payload": "",
        "example_response": json.dumps(
            {
                "code": 1,
                "msg": None,
                "data": [
                    {
                        "blist": "2.2.2.15",
                        "age": "-1",
                        "leftTime": "18446744073709551615",
                        "effectTime": "2024-06-11 15:58:34",
                        "reason": "API添加",
                        "policy_group_name": "-",
                        "state": "1",
                        "enable": "1",
                        "hit_num": "0",
                        "node_id": "0",
                    }
                ],
            },
            ensure_ascii=False,
        ),
    },
    {
        "name": "查询指定黑名单",
        "action_type": "custom",
        "category": "query",
        "risk_level": "readonly",
        "http_method": "GET",
        "api_path": "/Objects/Blacklist/blist/{blist}",
        "params_schema": _params(
            {"name": "blist", "type": "string", "required": True, "default": "",
             "description": "要查询的 IP、域名、连续 IP 段或网段（路径参数）"},
        ),
        "body_template": "",
        "description": "按 IP/域名查询单条黑名单（GET /api/v3/Objects/Blacklist/blist/{blist}）",
        "example_payload": "",
        "example_response": json.dumps(
            {
                "code": 1,
                "msg": None,
                "data": {
                    "blist": "2.2.2.89",
                    "age": "-1",
                    "enable": "1",
                    "reason": "API添加",
                    "effectTime": "2024-06-11 15:58:34",
                    "policy_group_name": "-",
                },
            },
            ensure_ascii=False,
        ),
    },
    {
        "name": "封禁 IP（加入黑名单）",
        "action_type": "block_ip",
        "category": "block",
        "risk_level": "high_risk",
        "http_method": "POST",
        "api_path": "/Objects/Blacklist",
        "params_schema": _params(
            {"name": "ip", "type": "string", "required": True, "default": "",
             "description": "封禁对象：单个 IP、连续 IP 段（1.2.3.4-1.2.3.10）、网段（1.2.3.0/24）或域名"},
            {"name": "duration", "type": "string", "required": False, "default": "-1",
             "map_values": _AGE_MAP, "description": _AGE_DESC},
            {"name": "reason", "type": "string", "required": False, "default": "API添加",
             "description": f"添加原因，取值范围：{_REASON_OPTIONS}"},
            {"name": "policy_group_name", "type": "string", "required": False, "default": "-",
             "description": "黑名单所属策略组名，\"-\" 表示默认策略组"},
            {"name": "enable", "type": "enum", "required": False, "default": "1",
             "options": ["1", "0"], "description": "1 启用，0 不启用"},
        ),
        "body_template": _BODY_TEMPLATE_BLOCK,
        "description": "新建黑名单条目封禁 IP/域名/网段，设备侧立即生效（POST /api/v3/Objects/Blacklist）",
        "example_payload": json.dumps(
            {
                "blist_entry": [
                    {
                        "blist": "2.2.2.6",
                        "age": "-1",
                        "reason": "API添加",
                        "policy_group_name": "策略组1",
                        "enable": "1",
                    }
                ]
            },
            ensure_ascii=False,
        ),
        "example_response": json.dumps({"code": 1, "msg": None, "data": "与输入值相同"}, ensure_ascii=False),
    },
    {
        "name": "修改黑名单",
        "action_type": "custom",
        "category": "dispose",
        "risk_level": "high_risk",
        "http_method": "PUT",
        "api_path": "/Objects/Blacklist/blist/{old_blist}",
        "params_schema": _params(
            {"name": "old_blist", "type": "string", "required": True, "default": "",
             "description": "修改前的 IP/域名（路径参数）"},
            {"name": "blist", "type": "string", "required": True, "default": "",
             "description": "修改后的 IP/域名（请求体）"},
            {"name": "age", "type": "string", "required": False, "default": "-1",
             "map_values": _AGE_MAP, "description": _AGE_DESC},
            {"name": "reason", "type": "string", "required": False, "default": "API添加",
             "description": f"添加原因，取值范围：{_REASON_OPTIONS}"},
            {"name": "policy_group_name", "type": "string", "required": False, "default": "-",
             "description": "黑名单所属策略组名，\"-\" 表示默认策略组"},
            {"name": "enable", "type": "enum", "required": False, "default": "1",
             "options": ["1", "0"], "description": "1 启用，0 不启用"},
        ),
        "body_template": _BODY_TEMPLATE_MODIFY,
        "description": "修改指定黑名单条目（PUT /api/v3/Objects/Blacklist/blist/{blist}）",
        "example_payload": json.dumps(
            {
                "blist_entry": [
                    {
                        "blist": "4.4.4.4",
                        "age": "-1",
                        "reason": "NMS",
                        "policy_group_name": "策略组1",
                        "enable": "1",
                    }
                ]
            },
            ensure_ascii=False,
        ),
        "example_response": json.dumps({"code": 1, "msg": None, "data": "与输入值相同"}, ensure_ascii=False),
    },
    {
        "name": "解封 IP（删除黑名单）",
        "action_type": "unblock_ip",
        "category": "dispose",
        "risk_level": "high_risk",
        "http_method": "DELETE",
        "api_path": "/Objects/Blacklist/blist/{blist}",
        "params_schema": _params(
            {"name": "blist", "type": "string", "required": True, "default": "",
             "description": "要解封的 IP、域名、连续 IP 段或网段（路径参数）"},
        ),
        "body_template": "",
        "description": "从设备黑名单删除条目以解除阻断（DELETE /api/v3/Objects/Blacklist/blist/{blist}）",
        "example_payload": "",
        "example_response": json.dumps({"code": 1, "msg": None, "data": None}, ensure_ascii=False),
    },
]


def _upsert_actions(db: Session, device: Device) -> tuple[int, int]:
    """按 device_id + name 幂等同步动作定义。

    Returns:
        (created, updated) 新建/更新的动作数量。
    """
    existing = {
        a.name: a
        for a in db.query(DeviceAction).filter(DeviceAction.device_id == device.id).all()
    }
    created = updated = 0
    for spec in _ACTIONS:
        action = existing.get(spec["name"])
        if action is None:
            action = DeviceAction(device_id=device.id, version=1)
            db.add(action)
            created += 1
        else:
            updated += 1
        action.name = spec["name"]
        action.action_type = spec["action_type"]
        action.http_method = spec["http_method"]
        action.api_path = spec["api_path"]
        action.params_schema = spec["params_schema"]
        action.headers = "{}"
        action.body_template = spec["body_template"]
        action.auth_type = "inherit"  # 继承设备 Basic Auth
        action.enabled = True
        action.description = spec["description"]
        action.category = spec["category"]
        action.risk_level = spec["risk_level"]
        action.example_payload = spec["example_payload"] or None
        action.example_response = spec["example_response"]
    return created, updated


def main() -> None:
    db: Session = SessionLocal()
    try:
        device = db.query(Device).filter(Device.name == _DEVICE_NAME).first()
        if device is None:
            raise RuntimeError(f"未找到设备「{_DEVICE_NAME}」，请先在设备管理中创建")
        created, updated = _upsert_actions(db, device)
        db.commit()
        logger.info(
            "播种完成: device_id=%s, 动作新增 %d 个 / 更新 %d 个（共 %d 个黑名单动作）",
            device.id, created, updated, len(_ACTIONS),
        )
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        logger.exception("播种失败: %s", exc)
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()
