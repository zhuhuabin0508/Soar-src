"""工单安全上下文威胁情报统一走 get_threat_互联网 工具（回归用例）。

背景：安全上下文原直接 import mock 的 ``context_tools.get_threat_intel``，
数据为种子随机假情报。改造后统一经平台工具执行口径（load_tool_function →
run_http_tool）调用已注册 HTTP 工具 ``get_threat_互联网``，响应归一化为
原 threat 结构（前端展示/交互/渲染零改动）。

本用例不发起真实外部 HTTP 调用：工具加载仅验证注册与缓存构建，
归一化/降级/单点失败隔离用 stub 覆盖。
"""
import pytest

from app.core import ticket_enrichment as te


def _norm(ip, resp):
    return te._normalize_tool_threat(ip, resp)


def test_normalize_common_envelope():
    """常见 {code,message,data:{...}} 包装结构正确映射。"""
    r = _norm("8.8.8.8", {
        "code": 200, "message": "ok",
        "data": {
            "is_malicious": True, "tags": ["Botnet"], "confidence": "92%",
            "severity": "critical", "threat_types": ["僵尸网络"],
            "geo": {"country": "美国", "city": "Ashburn", "isp": "Google"},
            "related_malware": ["Mirai"], "attack_patterns": ["暴力破解"],
            "first_seen": "2024-01-01", "last_seen": "2026-11-01",
            "source": "样例情报源", "description": "样例描述",
        },
    })
    assert r["is_malicious"] is True
    assert r["confidence"] == 0.92
    assert r["severity"] == "high"
    assert r["threat_types"] == ["僵尸网络"]
    assert r["geo_info"]["country"] == "美国"
    assert r["related_malware"] == ["Mirai"]
    assert r["source"] == "样例情报源"
    assert r["raw"].startswith("{")


def test_normalize_flat_and_tag_inference():
    """平铺结构 + 中文分隔符标签；无显式判定时从标签推断恶意。"""
    r = _norm("1.2.3.4", {"judgment": "恶意", "labels": "扫描器、C2", "risk_level": "高"})
    assert r["is_malicious"] is True
    assert r["tags"] == ["扫描器", "C2"]
    assert r["severity"] == "high"


def test_normalize_benign_and_defaults():
    """良性 IP：非恶意、低危、置信度 0。"""
    r = _norm("5.6.7.8", {"is_malicious": False, "confidence": 0})
    assert r["is_malicious"] is False
    assert r["severity"] == "low"
    assert r["confidence"] == 0.0
    assert "raw" in r  # 原始响应保留供智能体研判兜底


def test_normalize_runner_error_raises():
    """HTTP runner 失败包装（含 error 键）必须抛错（调用方按单 IP 失败处理）。"""
    with pytest.raises(ValueError):
        _norm("9.9.9.9", {"error": "HTTP 502", "status_code": 502})
    with pytest.raises(ValueError):
        _norm("9.9.9.9", "not-a-dict")


def test_batch_tool_unavailable_degrades():
    """工具缺失/禁用：所有 IP 返回 error dict → entry.threat=None（UI 显示情报失败）。"""
    original = te._load_ti_tool_run
    te._load_ti_tool_run = lambda: (None, None)
    try:
        out = te._query_threat_intel_batch(["1.1.1.1", "2.2.2.2"])
    finally:
        te._load_ti_tool_run = original
    assert len(out) == 2
    assert all(o.get("error") for o in out)
    assert te.TI_TOOL_NAME in out[0]["error"]


def test_batch_single_ip_failure_isolated(monkeypatch):
    """单 IP 调用/归一化失败不影响其余 IP。"""
    async def fake_run(ip=None, **kw):
        if ip == "3.3.3.3":
            raise RuntimeError("boom")
        return {"is_malicious": True, "tags": ["恶意"]}

    monkeypatch.setattr(te, "_load_ti_tool_run", lambda: (fake_run, "fake_ti_tool"))
    out = te._query_threat_intel_batch(["3.3.3.3", "4.4.4.4"])
    assert out[0].get("error")
    assert out[1]["is_malicious"] is True


def test_normalize_yunaq_real_benign_shape():
    """yunaq ip_analysis 实测结构（真实入库样例 19.45.1.23）：地理/活跃时间不再丢失。"""
    r = _norm("19.45.1.23", {
        "status": "success",
        "data": {
            "ip": "19.45.1.23", "tags": [],
            "basic": {"asn": "", "addr": ["美国", "", ""],
                      "location": {"lat": "", "lon": ""}, "country_code": "US", "isp": ""},
            "attack_tool": {"attack_type": [], "recon": [], "c2_control": [], "ddos_attack": []},
            "exploit": "",
            "history_perform": {"active_date": "", "attack_hosts_cnt": 0, "attack_total": 0},
            "key_period": [], "device_info": {"device_type": "", "os": "", "host_name": "", "ports": {}},
            "whois": {"netname": "FINET", "organization": {"org_name": "Ford Motor Company"}},
        },
    })
    assert r["is_malicious"] is False
    assert r["geo_info"]["country"] == "美国"          # IP 所属地区必须映射成功
    assert r["org_info"]["org_name"] == "Ford Motor Company"
    assert r["org_info"]["netname"] == "FINET"
    assert r["attack_stats"] == {"total": 0, "hosts_cnt": 0}
    assert r["source"] == "get_threat_互联网"
    assert "未命中威胁标签" in r["description"]


def test_normalize_yunaq_malicious_shape():
    """yunaq 结构恶意样例：威胁类型/攻击链/首末时间/攻击统计/设备特征全链路映射。"""
    r = _norm("1.2.3.4", {"status": "success", "data": {
        "ip": "1.2.3.4", "tags": ["暴力破解"],
        "basic": {"addr": ["中国", "浙江", "杭州"], "isp": "某ISP",
                  "location": {"lat": "30.27", "lon": "120.15"}},
        "attack_tool": {"attack_type": ["Web攻击"], "recon": ["端口扫描"],
                        "c2_control": [{"name": "CobaltStrike"}], "ddos_attack": []},
        "exploit": "CVE-2021-44228",
        "history_perform": {"active_date": "2026-11-01", "attack_hosts_cnt": 5, "attack_total": 42},
        "key_period": ["2026-08-01", "2026-10-20"],
        "device_info": {"device_type": "服务器", "os": "Linux", "host_name": "vps1", "ports": {"22": 3, "80": 9}},
        "whois": {"netname": "CN-UNET", "organization": {"org_name": "某云"}},
    }})
    assert r["is_malicious"] is True
    assert r["severity"] == "high"
    assert r["geo_info"] == {"country": "中国", "region": "浙江", "city": "杭州",
                              "isp": "某ISP", "latitude": "30.27", "longitude": "120.15"}
    assert r["threat_types"] == ["Web攻击"]
    assert "侦察探测：端口扫描" in r["attack_patterns"]
    assert "C2 控制：CobaltStrike" in r["attack_patterns"]
    assert "漏洞利用：CVE-2021-44228" in r["attack_patterns"]
    assert r["first_seen"] == "2026-08-01"
    assert r["last_seen"] == "2026-11-01"
    assert r["attack_stats"] == {"total": 42, "hosts_cnt": 5}
    assert r["device_info"]["ports"] == ["22", "80"]
    assert "历史攻击 42 次" in r["description"]


def test_ti_tool_registered_and_enabled():
    """威胁情报工具必须在平台注册且启用（防止被误删/禁用后安全上下文静默降级）。

    查找语义与生产一致：候选名精确匹配 → get_threat 前缀的 enabled http
    工具兜底——工具在管理页重命名后集成不中断。
    """
    from app.database import SessionLocal
    from app.models.tool import Tool

    db = SessionLocal()
    try:
        tool = db.query(Tool).filter(
            Tool.name.in_(te._TI_TOOL_CANDIDATES), Tool.enabled.is_(True)
        ).first()
        if tool is None:
            tool = db.query(Tool).filter(
                Tool.name.like("get_threat%"),
                Tool.tool_type == "http",
                Tool.enabled.is_(True),
            ).order_by(Tool.id).first()
        assert tool is not None, "威胁情报工具未注册或已禁用（候选/get_threat 前缀均未命中）"
        assert tool.tool_type == "http"
        run, name = te._load_ti_tool_run()
        assert callable(run)
        assert name == tool.name
    finally:
        db.close()
