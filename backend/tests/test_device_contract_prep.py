from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from app.core.security import validate_outbound_url, validate_public_fetch_url
from app.devices.action_executor import _build_request, execute_device_action
from app.devices.as_tool import policy_for_action_id


def _device(**kwargs):
    base = dict(api_url="https://10.1.1.8", api_key="", username="u", password="p", id=1)
    base.update(kwargs)
    return SimpleNamespace(**base)


def _action(**kwargs):
    base = dict(
        id=2, api_path="v1/assets/{agentId}", http_method="GET",
        headers="{}", auth_type="none", body_template=None, name="q",
    )
    base.update(kwargs)
    return SimpleNamespace(**base)


def test_path_placeholder_removed_from_params():
    params = {"agentId": "host 1", "page": 0}
    method, url, _headers, _auth, _body = _build_request(_device(), _action(), params)
    assert method == "GET"
    assert url == "https://10.1.1.8/v1/assets/host%201"
    assert "agentId" not in params
    assert params["page"] == 0


def test_metadata_and_bad_scheme_rejected():
    with pytest.raises(ValueError):
        validate_outbound_url("http://169.254.169.254/latest/meta-data", field="设备 api_url")
    with pytest.raises(ValueError):
        validate_outbound_url("file:///etc/passwd", field="设备 api_url")
    validate_outbound_url("https://10.1.1.8/v1/hosts", field="设备 api_url")


def test_public_fetch_rejects_loopback_and_private():
    with pytest.raises(ValueError):
        validate_public_fetch_url("http://127.0.0.1/spec.json", field="OpenAPI URL")
    with pytest.raises(ValueError):
        validate_public_fetch_url("http://10.1.1.8/spec.json", field="OpenAPI URL")
    validate_public_fetch_url("https://1.1.1.1/spec.json", field="OpenAPI URL")


def test_qingteng_login_failure_has_request_summary():
    device = _device(timeout=3, verify_tls=False, max_retries=0, auth_type="qingteng")
    action = _action(api_path="v1/hosts", auth_type="qingteng")
    with patch("app.devices.action_executor._qingteng_login", side_effect=RuntimeError("down")), \
         patch("app.devices.action_executor.record_device_call") as record:
        out = execute_device_action(device, action, {}, db=object(), source="agent")
    assert "down" in out["error"]
    assert record.call_args.kwargs["request_summary"]


def test_policy_follows_stored_action():
    read = SimpleNamespace(risk_level="readonly", category="query")
    write = SimpleNamespace(risk_level="high_risk", category="block")
    db = MagicMock()
    db.query.return_value.filter.return_value.first.side_effect = [read, write, None]
    assert policy_for_action_id(db, "4") == ("low", ("device", "view"))
    assert policy_for_action_id(db, 9) == ("high", ("device", "edit"))
    assert policy_for_action_id(db, 9) is None
    assert policy_for_action_id(db, "x") is None
