import base64
import logging
import os
import subprocess
import sys
from unittest.mock import MagicMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.config import settings
from app.core.security import (
    _ENV_ENC_PREFIX,
    _xor_device_bytes,
    decrypt_device_secret,
    encrypt_device_secret,
)
from app.core.session import is_token_blacklisted
from app.main import _seed_admin_user, ws_execution_progress


def test_new_device_secret_roundtrip():
    plain = "Firewall#2024"
    token = encrypt_device_secret(plain)
    assert token.startswith("fernet:")
    assert decrypt_device_secret(token) == plain
    assert encrypt_device_secret(token) == token


def test_legacy_xor_device_secret_still_decrypts():
    plain = "old-device-pass"
    legacy = _ENV_ENC_PREFIX + base64.b64encode(_xor_device_bytes(plain.encode())).decode()
    assert decrypt_device_secret(legacy) == plain
    assert encrypt_device_secret(legacy) == legacy


@pytest.mark.parametrize("value", ["", None])
def test_device_secret_empty(value):
    assert encrypt_device_secret(value) == ""
    assert decrypt_device_secret(value) == ""


def test_legacy_plaintext_without_prefix_is_returned():
    assert decrypt_device_secret("plain-text") == "plain-text"


def test_blacklist_fails_closed_when_redis_down(monkeypatch):
    def _boom():
        raise ConnectionError("redis down")

    monkeypatch.setattr("app.core.session.get_redis", _boom)
    assert is_token_blacklisted("jti-1") is True


def test_blacklist_empty_jti_is_not_blacklisted():
    assert is_token_blacklisted("") is False


def test_blacklist_reads_redis(monkeypatch):
    class _Redis:
        def get(self, key):
            return b"1" if key.endswith("hit") else None

    monkeypatch.setattr("app.core.session.get_redis", lambda: _Redis())
    assert is_token_blacklisted("hit") is True
    assert is_token_blacklisted("miss") is False


def test_seed_log_omits_password(monkeypatch, caplog):
    monkeypatch.setattr("app.main._seed_default_roles", lambda db: None)
    monkeypatch.setattr(settings, "SEED_ADMIN_PASSWORD", "SentinelPass#8841", raising=False)
    db = MagicMock()
    db.query.return_value.count.return_value = 0
    with caplog.at_level(logging.WARNING):
        _seed_admin_user(db)
    assert "SentinelPass#8841" not in caplog.text
    assert settings.SEED_ADMIN_USERNAME in caplog.text


def _execution_client():
    app = FastAPI()
    app.add_api_websocket_route("/ws/executions/{execution_id}", ws_execution_progress)
    return TestClient(app)


def _expect_close_4401(session):
    msg = session.receive()
    assert msg["type"] == "websocket.close"
    assert msg.get("code") == 4401


def test_execution_ws_without_token_closes_4401():
    with _execution_client().websocket_connect("/ws/executions/1") as session:
        _expect_close_4401(session)


def test_dev_mounts_internal_mock():
    from app.api.v1 import api_router

    paths = [getattr(route, "path", "") for route in api_router.routes]
    assert any(path.startswith("/internal/") for path in paths)


def test_production_does_not_mount_internal_mock():
    env = os.environ.copy()
    env["APP_ENV"] = "production"
    env["JWT_SECRET"] = "x" * 48
    env["SEED_ADMIN_PASSWORD"] = "NotTheDefault#1"
    script = (
        "from app.api.v1 import api_router\n"
        "paths = [getattr(route, 'path', '') for route in api_router.routes]\n"
        "assert not any(path.startswith('/internal/') for path in paths), paths\n"
    )
    subprocess.check_call([sys.executable, "-c", script], env=env)
