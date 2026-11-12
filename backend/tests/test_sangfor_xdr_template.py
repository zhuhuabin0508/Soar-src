# -*- coding: utf-8 -*-
"""深信服 XDR 内置模板验证用例。

覆盖：
1. 安全告警 / 安全事件全部接口动作固化到内置模板；
2. 参数映射结构合法、请求体模板与动作定义一致；
3. 用户已手动创建深信服 XDR 模板时复用而非重复创建；
4. XDR AK/SK 签名与 GET Query / POST Body 请求构造正确。
"""
import json
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.core.device_template_library as library
import app.devices.action_executor as executor
from app.core.sangfor_xdr_actions import SANGFOR_XDR_ACTIONS
from app.database import Base
from app.models.device import Device, DeviceAction
from app.models.device_template import DeviceTemplate, DeviceTemplateAction
from app.models.system_config import SystemConfig


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
    monkeypatch.setattr(library, "encrypt_device_secret", lambda v: f"enc::{v}" if v else "")
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def test_seed_sangfor_xdr_template_creates_all_actions(db):
    """首次初始化应创建深信服 XDR 模板并固化全部告警/事件动作。"""
    assert library.seed_sangfor_xdr_template(db) is True
    db.commit()

    template = db.query(DeviceTemplate).filter_by(code="sangfor_xdr").one()
    assert template.name == library.SANGFOR_XDR_TEMPLATE_NAME
    assert template.vendor == "深信服"
    assert template.auth_type == "sangfor_xdr"
    assert template.version == library.SANGFOR_XDR_TEMPLATE_VERSION
    assert template.source == "builtin"

    actions = (
        db.query(DeviceTemplateAction)
        .filter_by(template_id=template.id)
        .order_by(DeviceTemplateAction.sort_order.asc())
        .all()
    )
    assert len(actions) == len(SANGFOR_XDR_ACTIONS) == 63

    paths = {a.api_path for a in actions}
    assert "/api/xdr/v1/alerts/list" in paths
    assert "/api/xdr/v1/incidents/list" in paths
    assert "/api/xdr/v1/alerts/aggregation" in paths
    assert "/api/xdr/v1/incidents/trends" in paths
    # 资产 / 资产组查询动作已固化
    assert "/api/xdr/v1/bigscreen/branchlist" in paths
    assert "/api/xdr/v1/assets/list" in paths
    assert "/api/xdr/v1/assets/total" in paths
    assert "/api/xdr/v1/riskassets/list" in paths

    for action in actions:
        assert action.auth_type == "sangfor_xdr"
        assert action.http_method in ("GET", "POST")
        assert isinstance(json.loads(action.params_schema), list)

    alert_list = next(a for a in actions if a.api_path == "/api/xdr/v1/alerts/list")
    params = json.loads(alert_list.params_schema)
    assert {p["name"] for p in params} >= {"startTimestamp", "endTimestamp", "page", "pageSize"}

    # 请求体为数组的批量处置状态查询需要原始数组下发
    bulk = next(a for a in actions if a.api_path == "/api/xdr/v1/alerts/dealstatus/list")
    assert json.loads(bulk.params_schema)[0]["name"] == "uuIds"
    assert bulk.body_template == "{{uuIds}}"

    # 二次初始化幂等
    assert library.seed_sangfor_xdr_template(db) is False
    assert db.query(DeviceTemplateAction).filter_by(template_id=template.id).count() == 63


def test_seed_adopts_manual_xdr_template(db):
    """用户已手动创建深信服 XDR 模板时应复用并补齐动作，不产生重复条目。"""
    manual = DeviceTemplate(
        name="深信服XDR",
        type="custom",
        vendor="深信服",
        version="v1.0",
        auth_type="api_key",
        source="manual",
        tags="[]",
        code=None,
    )
    db.add(manual)
    db.commit()

    assert library.seed_sangfor_xdr_template(db) is True
    db.commit()

    templates = db.query(DeviceTemplate).all()
    assert len(templates) == 1
    adopted = templates[0]
    assert adopted.id == manual.id
    assert adopted.code == "sangfor_xdr"
    assert adopted.auth_type == "sangfor_xdr"
    assert adopted.version == library.SANGFOR_XDR_TEMPLATE_VERSION
    assert db.query(DeviceTemplateAction).filter_by(template_id=adopted.id).count() == 63


def test_seed_adopts_template_with_existing_actions_no_duplicates(db):
    """被复用模板已带同 api_path 动作时：按 api_path 去重，只追加缺失动作。"""
    manual = DeviceTemplate(
        name="深信服XDR（从设备固化）",
        type="custom",
        vendor="深信服",
        version="v1.0",
        auth_type="sangfor_xdr",
        source="device",
        tags="[]",
        code=None,
    )
    db.add(manual)
    db.flush()
    # 模板已带 2 个与内置清单同路径的动作 + 1 个用户自定义动作
    for idx, spec in enumerate(SANGFOR_XDR_ACTIONS[:2]):
        db.add(
            DeviceTemplateAction(
                template_id=manual.id,
                name=spec["name"],
                action_type=spec["action_type"],
                http_method=spec["http_method"],
                api_path=spec["api_path"],
                params_schema="[]",
                auth_type=spec["auth_type"],
                enabled=True,
                category=spec["category"],
                risk_level=spec["risk_level"],
                sort_order=10 + idx,
                version=1,
            )
        )
    db.add(
        DeviceTemplateAction(
            template_id=manual.id,
            name="用户自定义动作",
            action_type="custom",
            http_method="GET",
            api_path="/api/custom/health",
            params_schema="[]",
            auth_type="inherit",
            enabled=True,
            category="query",
            risk_level="readonly",
            sort_order=20,
            version=1,
        )
    )
    db.commit()

    assert library.seed_sangfor_xdr_template(db) is True
    db.commit()

    actions = db.query(DeviceTemplateAction).filter_by(template_id=manual.id).all()
    # 63 内置动作（2 个已存在不重复追加）+ 1 个用户自定义 = 64
    assert len(actions) == 64
    by_path = [a.api_path for a in actions]
    assert len(by_path) == len(set(by_path)), "不允许出现重复 api_path"
    assert "/api/custom/health" in by_path, "用户自定义动作保留"
    # 新动作的 sort_order 接在已有动作之后，不与已有 sort_order 冲突
    orders = [a.sort_order for a in actions]
    assert len(orders) == len(set(orders))


def test_seed_complements_new_actions_for_existing_install(db):
    """已初始化环境：内置清单新增动作后，模板与存量设备按 api_path 补齐。"""
    # 首次初始化（全量 63 动作）
    assert library.seed_sangfor_xdr_template(db) is True
    db.commit()

    # 模拟历史版本：模板与设备只保留告警/事件动作（移除资产/资产组类动作）
    template = db.query(DeviceTemplate).filter_by(code="sangfor_xdr").one()
    db.query(DeviceTemplateAction).filter(
        DeviceTemplateAction.template_id == template.id,
        DeviceTemplateAction.api_path.like("/api/xdr/v1/assets%"),
    ).delete(synchronize_session=False)
    db.query(DeviceTemplateAction).filter(
        DeviceTemplateAction.template_id == template.id,
        DeviceTemplateAction.api_path.like("/api/xdr/v1/riskassets%"),
    ).delete(synchronize_session=False)
    db.query(DeviceTemplateAction).filter(
        DeviceTemplateAction.template_id == template.id,
        DeviceTemplateAction.api_path.like("/api/xdr/v1/bigscreen%"),
    ).delete(synchronize_session=False)
    db.commit()

    device = Device(
        name="深信服XDR",
        type="custom",
        vendor="深信服",
        api_url="https://xdr.example.com",
        auth_type="sangfor_xdr",
        enabled=True,
    )
    db.add(device)
    db.flush()
    legacy_paths = (
        "/api/xdr/v1/assets",
        "/api/xdr/v1/riskassets",
        "/api/xdr/v1/bigscreen",
    )
    for spec in SANGFOR_XDR_ACTIONS:
        if not spec["api_path"].startswith(legacy_paths):
            db.add(
                DeviceAction(
                    device_id=device.id,
                    name=spec["name"],
                    action_type=spec["action_type"],
                    http_method=spec["http_method"],
                    api_path=spec["api_path"],
                    params_schema=json.dumps(spec["params_schema"], ensure_ascii=False),
                    auth_type=spec["auth_type"],
                    enabled=True,
                    description=spec["description"],
                    category=spec["category"],
                    risk_level=spec["risk_level"],
                )
            )
    db.commit()

    # 已初始化标记已写入（flag=1），seed 仍应补齐缺失动作
    assert library.seed_sangfor_xdr_template(db) is False
    db.commit()

    template_paths = {
        row[0]
        for row in db.query(DeviceTemplateAction.api_path).filter(
            DeviceTemplateAction.template_id == template.id
        )
    }
    assert "/api/xdr/v1/assets/list" in template_paths
    assert "/api/xdr/v1/bigscreen/branchlist" in template_paths

    device_actions = db.query(DeviceAction).filter_by(device_id=device.id).all()
    device_paths = {a.api_path for a in device_actions}
    assert {s["api_path"] for s in SANGFOR_XDR_ACTIONS} <= device_paths
    assert len(device_actions) == len(SANGFOR_XDR_ACTIONS)

    # 用户对既有动作的修改不被覆盖（改一个动作名后重跑补齐，名称保持）
    kept = next(
        a for a in device_actions if a.api_path == "/api/xdr/v1/alerts/list"
    )
    kept.name = "用户自定义名称"
    db.commit()
    library.seed_sangfor_xdr_template(db)
    db.commit()
    refreshed = (
        db.query(DeviceAction)
        .filter_by(device_id=device.id, api_path="/api/xdr/v1/alerts/list")
        .one()
    )
    assert refreshed.name == "用户自定义名称"


def test_seed_syncs_upgraded_action_definitions(db):
    """内置动作定义升级（version 提高）后，version 落后的模板/设备动作被同步刷新。"""
    assert library.seed_sangfor_xdr_template(db) is True
    db.commit()

    # 模拟升级前的存量环境：设备上挂着 v1 旧定义的四个告警动作
    upgraded_paths = {
        "/api/xdr/v1/alerts/trends",
        "/api/xdr/v1/alerts/aggregation",
        "/api/xdr/v1/alerts/countFusion",
        "/api/xdr/v1/alerts/list",
    }
    device = Device(
        name="深信服XDR",
        type="custom",
        vendor="深信服",
        api_url="https://xdr.example.com",
        auth_type="sangfor_xdr",
        enabled=True,
    )
    db.add(device)
    db.flush()
    for spec in SANGFOR_XDR_ACTIONS:
        if spec["api_path"] in upgraded_paths:
            db.add(
                DeviceAction(
                    device_id=device.id,
                    name=spec["name"],
                    action_type=spec["action_type"],
                    http_method=spec["http_method"],
                    api_path=spec["api_path"],
                    params_schema="[]",
                    auth_type=spec["auth_type"],
                    enabled=True,
                    description="旧版描述",
                    category=spec["category"],
                    risk_level=spec["risk_level"],
                    version=1,
                )
            )
    # 模板动作也降级为 v1 旧定义
    template = db.query(DeviceTemplate).filter_by(code="sangfor_xdr").one()
    tpl_trends = (
        db.query(DeviceTemplateAction)
        .filter_by(template_id=template.id, api_path="/api/xdr/v1/alerts/trends")
        .one()
    )
    tpl_trends.version = 1
    tpl_trends.description = "旧版描述"
    tpl_trends.params_schema = "[]"
    # 另一个动作被用户改过且已是 v2：不应被覆盖
    tpl_list = (
        db.query(DeviceTemplateAction)
        .filter_by(template_id=template.id, api_path="/api/xdr/v1/alerts/list")
        .one()
    )
    tpl_list.version = 2
    tpl_list.description = "用户自定义描述"
    db.commit()

    assert library.seed_sangfor_xdr_template(db) is False
    db.commit()

    # v1 旧定义被同步为内置 v2：版本、口径说明、参数 schema 均刷新
    assert tpl_trends.version == 2
    assert "统计口径注意" in tpl_trends.description
    assert json.loads(tpl_trends.params_schema)
    device_trends = (
        db.query(DeviceAction)
        .filter_by(device_id=device.id, api_path="/api/xdr/v1/alerts/trends")
        .one()
    )
    assert device_trends.version == 2
    assert "统计口径注意" in device_trends.description
    device_aggregation = (
        db.query(DeviceAction)
        .filter_by(device_id=device.id, api_path="/api/xdr/v1/alerts/aggregation")
        .one()
    )
    assert device_aggregation.version == 2
    assert device_aggregation.description != "旧版描述"

    # 用户自改且 version 不落后的动作不受影响
    assert tpl_list.description == "用户自定义描述"


def test_sangfor_xdr_signing_get_query_and_post_body(monkeypatch):
    """XDR 签名头、GET Query 参数与 POST 请求体构造正确。"""
    monkeypatch.setattr(executor, "decrypt_device_secret", lambda v: v)
    device = SimpleNamespace(
        api_key="A" * 64,
        password="B" * 64,
    )
    action = SimpleNamespace(
        id=1,
        params_schema=json.dumps([
            {"name": "page", "type": "integer", "required": False, "default": 1},
        ]),
    )

    headers, body, url = executor._sangfor_xdr_sign(
        device,
        action,
        "GET",
        "https://10.0.0.1/api/xdr/v1/incidents/threatclass",
        {"Content-Type": "application/json"},
        {},
        None,
    )
    assert url == "https://10.0.0.1/api/xdr/v1/incidents/threatclass?page=1"
    assert body is None
    assert "algorithm=HMAC-SHA256, Access=" + "A" * 64 in headers["Authorization"]
    assert "SignedHeaders=sdk-content-type;sdk-host;sign-date" in headers["Authorization"]
    assert headers["sdk-host"] == "10.0.0.1"
    assert headers["Content-Type"] == "application/json"

    headers, body, url = executor._sangfor_xdr_sign(
        device,
        action,
        "POST",
        "https://10.0.0.1/api/xdr/v1/alerts/list",
        {"Content-Type": "application/json"},
        {"pageSize": 5},
        {"pageSize": 5, "name": "告警"},
    )
    assert url == "https://10.0.0.1/api/xdr/v1/alerts/list"
    assert json.loads(body) == {"pageSize": 5, "name": "告警"}
    assert "Authorization" in headers
