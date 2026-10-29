import asyncio

from sqlalchemy.dialects import postgresql

from app.agent.discovery_search import (
    classify_keyword,
    clamp_limit,
    execute_search_discovered_assets,
    resolve_resource_types,
    split_keywords,
)
from app.models.govcloud_asset import RESOURCE_MODELS


def test_classify_keyword_keeps_ip_exact():
    assert classify_keyword("10.1.2.3") == "ip"
    assert classify_keyword("10.0.0.0/24") == "cidr"
    assert classify_keyword("6899c279368a6c00016717f8") == "id"
    assert classify_keyword("财务部") == "text"
    assert classify_keyword("云") == "text"


def test_split_keywords_caps_batch():
    raw = ",".join(f"10.0.0.{i % 255}" for i in range(40))
    assert len(split_keywords(raw)) == 30
    assert split_keywords(" 10.0.0.1，10.0.0.2;10.0.0.3 ") == ["10.0.0.1", "10.0.0.2", "10.0.0.3"]


def test_clamp_limit():
    assert clamp_limit(0) == 1
    assert clamp_limit(100) == 20
    assert clamp_limit("bad") == 10


def test_resolve_resource_types():
    codes, error = resolve_resource_types("")
    assert error is None
    # 青藤主机（API 同步）接入后同为资产发现可检索类型
    assert codes == ["cloud_host", "bare_metal", "e_government_network", "elastic_ip", "qingteng_host"]
    codes, error = resolve_resource_types("cloud_host")
    assert error is None and codes == ["cloud_host"]
    codes, error = resolve_resource_types("qingteng_host")
    assert error is None and codes == ["qingteng_host"]
    codes, error = resolve_resource_types("unknown")
    assert codes == []
    assert error["count"] == 0


def test_ip_filter_matches_excel_ip_field():
    model = RESOURCE_MODELS["cloud_host"]
    clause = model.extra_excel["IP"].astext == "10.224.168.57"
    sql = str(clause.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))
    assert "extra_excel" in sql
    assert "10.224.168.57" in sql
    assert "LIKE" not in sql.upper()


def test_empty_keyword_does_not_query():
    result = asyncio.run(execute_search_discovered_assets(keyword="   "))
    assert result["count"] == 0
    assert result["assets"] == []
    assert "请提供" in result["error"]


def test_qingteng_host_column_mappings_ready():
    """青藤主机接入资产发现检索：IP/ID/文本/输出字段均可在模型上解析。

    回归背景：青藤模型 JSONB 列叫 extra（非 extra_excel），修复前
    _extra_text 在该模型上直接 AttributeError，导致整个资产发现检索瘫痪。
    """
    from app.agent.discovery_search import (
        _ID_COLUMNS, _IP_COLUMNS, _TEXT_COLUMNS, _columns, _extra_text,
    )

    model = RESOURCE_MODELS["qingteng_host"]
    ip_cols = _columns(model, _IP_COLUMNS["qingteng_host"])
    assert len(ip_cols) == len(_IP_COLUMNS["qingteng_host"])
    # extra 列名兜底不再抛异常（青藤 extra / Excel extra_excel）
    assert _extra_text(model, "IP") is not None
    assert _columns(model, _ID_COLUMNS)
    assert len(_columns(model, _TEXT_COLUMNS["qingteng_host"])) >= 4
    # 全字段返回：模型全部列（含 CPU/内存/磁盘等专有列）均可选取
    assert len(model.__table__.columns) > 10


def test_qingteng_host_compact_aligns_display_fields():
    from app.agent.discovery_search import _compact

    data = _compact("qingteng_host", {
        "id": 1,
        "source_id": "3:agent-1",
        "agent_id": "agent-1",
        "hostname": "web-01",
        "display_ip": "10.137.254.230",
        "os_type": "linux",
        "platform": "CentOS",
        "agent_status_label": "在线",
        "qingteng_device_name": "青藤万相",
        "extra": {"futureField": "x"},
    })
    assert data["resource_type"] == "qingteng_host"
    assert data["resource_label"]
    # 通用展示字段对齐：与 Excel 资产统一按 ip_address / instance_name 理解
    assert data["ip_address"] == "10.137.254.230"
    assert data["instance_name"] == "web-01"
    assert data["agent_status_label"] == "在线"
    assert data["qingteng_device_name"] == "青藤万相"


def test_compact_passes_through_type_specific_fields():
    """全字段透出：不同资源类型字段不同，按记录实际字段返回。

    - Excel 资产：模型专有列（vcpu/memory 等）+ extra_excel 扩展键都进结果
    - 青藤主机：专有列（cpu_core/memory_size 等）+ extra 扩展键都进结果
    - 内部簿记字段（id/batch_id/时间戳/原始 JSON 列名）不透出
    """
    from app.agent.discovery_search import _compact

    data = _compact("cloud_host", {
        "id": 7,
        "batch_id": 3,
        "source_id": "src-1",
        "instance_name": "ecs-demo-0001",
        "ip_address": "10.68.60.193",
        "vcpu": "8",
        "memory": "16",
        "system_disk": "100GB",
        "biz_region_name": "深圳市政务云生产业务区",
        "extra_excel": {
            "system_name": "示例业务系统",
            "environment": "生产",
            "hosting_start_time": "2024-01-01",
            "created_at": "2024-01-01 00:00:00",
        },
    })
    # 模型专有列透出
    assert data["vcpu"] == "8"
    assert data["memory"] == "16"
    assert data["system_disk"] == "100GB"
    # extra_excel 扩展键透出
    assert data["environment"] == "生产"
    assert data["hosting_start_time"] == "2024-01-01"
    # 归一字段仍生效
    assert data["business_system"] == "示例业务系统"
    # 内部簿记不透出
    assert "batch_id" not in data
    assert "extra_excel" not in data
    assert "created_at" not in data

    qt = _compact("qingteng_host", {
        "id": 9,
        "source_id": "3:agent-1",
        "hostname": "web-01",
        "display_ip": "10.137.254.230",
        "cpu_core": 8,
        "memory_size": 16,
        "disk_size": 200,
        "host_tag_list": ["web", "prod"],
        "extra": {"uuid": "u-1", "memories": "16G"},
    })
    assert qt["cpu_core"] == 8
    assert qt["memory_size"] == 16
    assert qt["disk_size"] == 200
    assert qt["host_tag_list"] == ["web", "prod"]
    assert qt["uuid"] == "u-1"
    assert "extra" not in qt
