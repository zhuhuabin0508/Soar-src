"""内置设备库验证用例。

覆盖需求验证项：
1. 已存在的带动作设备可正常被识别入库；
2. 内置模板的基础信息与关联动作完整、准确、无缺失；
3. 复用模板创建新设备时，基础信息与全部动作可正确加载。
"""
import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.device_template_library as library
from app.core.qingteng_wanxiang_actions import QINGTENG_WANXIANG_ACTIONS
from app.database import Base
from app.models.device import Device, DeviceAction
from app.models.device_template import DeviceTemplate, DeviceTemplateAction
from app.models.system_config import SystemConfig

_META_FIELDS = (
    "name",
    "action_type",
    "http_method",
    "api_path",
    "params_schema",
    "headers",
    "body_template",
    "auth_type",
    "enabled",
    "description",
    "category",
    "risk_level",
    "version",
    "example_payload",
    "example_response",
)


@pytest.fixture()
def db(monkeypatch):
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(
        bind=engine,
        tables=[
            Device.__table__,
            DeviceAction.__table__,
            DeviceTemplate.__table__,
            DeviceTemplateAction.__table__,
            SystemConfig.__table__,
        ],
    )
    session = sessionmaker(bind=engine)()
    # 测试环境不依赖设备凭据加密密钥
    monkeypatch.setattr(library, "encrypt_device_secret", lambda v: f"enc::{v}" if v else "")
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _make_device_with_actions(db) -> Device:
    device = Device(
        name="青藤万相-生产环境",
        type="edr",
        vendor="青藤",
        version="v3.4.1.66",
        ip_address="10.0.0.10",
        api_url="https://10.0.0.10:8443/api",
        api_key="secret-key",
        username="admin",
        password="secret-pass",
        auth_type="qingteng",
        tags='["生产", "主机安全"]',
        description="已对接的青藤万相设备",
    )
    db.add(device)
    db.flush()
    db.add_all(
        [
            DeviceAction(
                device_id=device.id,
                name="查询主机资产",
                action_type="query_asset",
                http_method="POST",
                api_path="/v1/asset/search",
                params_schema=json.dumps(
                    [{"name": "keyword", "type": "string", "required": False}],
                    ensure_ascii=False,
                ),
                headers='{"X-Tenant": "default"}',
                body_template='{"keyword": "{{keyword}}"}',
                auth_type="qingteng",
                category="query",
                risk_level="readonly",
                example_payload='{"keyword": "10.0.0.1"}',
                example_response='[{"host": "10.0.0.1"}]',
            ),
            DeviceAction(
                device_id=device.id,
                name="查询入侵事件",
                action_type="query_alert",
                http_method="GET",
                api_path="/v1/alert/list",
                params_schema=json.dumps(
                    [{"name": "days", "type": "number", "required": True, "default": 7}],
                    ensure_ascii=False,
                ),
                headers="{}",
                body_template="",
                auth_type="qingteng",
                category="query",
                risk_level="readonly",
                enabled=False,
            ),
        ]
    )
    db.commit()
    return device


def test_existing_device_with_actions_can_be_imported(db):
    """已存在的带动作设备可被识别入库，且幂等不重复。"""
    device = _make_device_with_actions(db)

    assert library.seed_builtin_device_templates(db) is True
    db.commit()

    template = (
        db.query(DeviceTemplate)
        .filter(DeviceTemplate.code == library.QINGTENG_TEMPLATE_CODE)
        .first()
    )
    assert template is not None
    # 名称与元数据固定标准化
    assert template.name == "青藤万相主机安全管理"
    assert template.type == "edr"
    assert template.vendor == "青藤"
    assert template.version == "v3.4.1.66"
    assert template.auth_type == "qingteng"
    assert template.source == "builtin"
    assert template.source_device_id == device.id
    assert template.source_device_name == device.name

    template_actions = (
        db.query(DeviceTemplateAction)
        .filter(DeviceTemplateAction.template_id == template.id)
        .order_by(DeviceTemplateAction.sort_order.asc())
        .all()
    )
    source_actions = (
        db.query(DeviceAction)
        .filter(DeviceAction.device_id == device.id)
        .order_by(DeviceAction.id.asc())
        .all()
    )
    assert len(template_actions) == len(source_actions) == 2

    # 再次执行种子不会重复入库，也不会覆盖模板
    assert library.seed_builtin_device_templates(db) is False
    assert db.query(DeviceTemplate).count() == 1


def test_template_base_info_and_actions_are_complete(db):
    """模板基础信息与关联动作完整准确，模板修改不影响源设备。"""
    device = _make_device_with_actions(db)
    library.seed_builtin_device_templates(db)
    db.commit()

    template = db.query(DeviceTemplate).filter_by(code=library.QINGTENG_TEMPLATE_CODE).one()
    template_actions = (
        db.query(DeviceTemplateAction)
        .filter(DeviceTemplateAction.template_id == template.id)
        .order_by(DeviceTemplateAction.sort_order.asc())
        .all()
    )
    source_actions = (
        db.query(DeviceAction)
        .filter(DeviceAction.device_id == device.id)
        .order_by(DeviceAction.id.asc())
        .all()
    )

    for src, dst in zip(source_actions, template_actions):
        for field in _META_FIELDS:
            assert getattr(dst, field) == getattr(src, field), f"动作字段 {field} 未完整固化"
        assert dst.template_id == template.id

    # 凭据不进入模板
    assert not hasattr(template, "api_key")
    assert not hasattr(template, "password")

    # 修改模板动作仅影响模板
    db.query(DeviceAction).filter(DeviceAction.device_id == device.id).update(
        {"params_schema": "[]"}, synchronize_session=False
    )
    db.query(DeviceTemplateAction).filter(
        DeviceTemplateAction.template_id == template.id
    ).update(
        {"params_schema": '[{"name":"changed","type":"string"}]'},
        synchronize_session=False,
    )
    db.commit()

    src = db.query(DeviceAction).filter(DeviceAction.device_id == device.id).first()
    dst = (
        db.query(DeviceTemplateAction)
        .filter(DeviceTemplateAction.template_id == template.id)
        .first()
    )
    assert "changed" in dst.params_schema
    assert "changed" not in src.params_schema


def test_seed_falls_back_to_builtin_specs(db):
    """库中无青藤设备时，按内置动作定义创建固定模板。"""
    assert db.query(Device).count() == 0
    assert library.seed_builtin_device_templates(db) is True
    db.commit()

    template = db.query(DeviceTemplate).filter_by(code=library.QINGTENG_TEMPLATE_CODE).one()
    assert template.name == "青藤万相主机安全管理"
    assert template.source == "builtin"
    count = (
        db.query(DeviceTemplateAction)
        .filter(DeviceTemplateAction.template_id == template.id)
        .count()
    )
    assert count == len(QINGTENG_WANXIANG_ACTIONS)
    assert count > 0


def test_deleted_builtin_template_is_not_reseeded(db):
    """用户删除内置条目后，重启种子不会自动重建（尊重页面删除操作）。"""
    _make_device_with_actions(db)
    assert library.seed_builtin_device_templates(db) is True
    db.commit()

    template = db.query(DeviceTemplate).filter_by(code=library.QINGTENG_TEMPLATE_CODE).one()
    db.query(DeviceTemplateAction).filter(
        DeviceTemplateAction.template_id == template.id
    ).delete()
    db.delete(template)
    db.commit()

    assert library.seed_builtin_device_templates(db) is False
    db.commit()
    assert db.query(DeviceTemplate).count() == 0


def test_instantiate_template_copies_all_content(db):
    """复用模板创建新设备时，基础信息与全部动作完整加载。"""
    _make_device_with_actions(db)
    library.seed_builtin_device_templates(db)
    db.commit()

    template = db.query(DeviceTemplate).filter_by(code=library.QINGTENG_TEMPLATE_CODE).one()
    template_actions = (
        db.query(DeviceTemplateAction)
        .filter(DeviceTemplateAction.template_id == template.id)
        .order_by(DeviceTemplateAction.sort_order.asc())
        .all()
    )

    # 模拟用户对模板动作的调整，复用后应携带调整结果
    template_actions[0].params_schema = '[{"name":"custom","type":"string"}]'
    db.commit()

    device, action_count = library.instantiate_template(
        db,
        template,
        name="青藤万相-新建",
        api_url="https://10.0.0.20:8443/api",
        ip_address="10.0.0.20",
        username="new-user",
        password="new-pass",
        api_key="new-key",
        enabled=True,
    )
    db.commit()

    assert device.id is not None
    assert device.name == "青藤万相-新建"
    assert device.type == template.type
    assert device.vendor == template.vendor
    assert device.version == template.version
    assert device.auth_type == template.auth_type
    assert device.api_url == "https://10.0.0.20:8443/api"
    assert device.ip_address == "10.0.0.20"
    assert device.tags == template.tags
    assert device.status == "unconfigured"
    # 凭据按设备创建流程加密存储
    assert device.username == "enc::new-user"
    assert device.password == "enc::new-pass"
    assert device.api_key == "enc::new-key"

    new_actions = (
        db.query(DeviceAction)
        .filter(DeviceAction.device_id == device.id)
        .order_by(DeviceAction.id.asc())
        .all()
    )
    assert action_count == len(new_actions) == len(template_actions)
    for src, dst in zip(template_actions, new_actions):
        for field in _META_FIELDS:
            assert getattr(dst, field) == getattr(src, field), f"复用后动作字段 {field} 丢失"
        assert dst.device_id == device.id
        assert dst.call_count_24h == 0

    assert new_actions[0].params_schema == '[{"name":"custom","type":"string"}]'
