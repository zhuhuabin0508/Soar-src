"""文件接收核心校验单测（不依赖数据库）。"""
import hashlib
from types import SimpleNamespace

import pytest

from app.core.file_receive.errors import FileReceiveError
from app.core.file_receive.validators import (
    build_fingerprint,
    inspect_file,
    normalize_filename,
    validate_create_payload,
)


def _source(**kwargs):
    values = {
        "source_code": "TEST_SOURCE",
        "allowed_exts": ["pdf"],
        "max_file_size_mb": 200,
    }
    values.update(kwargs)
    return SimpleNamespace(**values)


def _minimal_payload():
    return {
        "source_system": "TEST_SOURCE",
        "file_name": "test.pdf",
        "content_type": "application/pdf",
    }


def test_normalize_filename_rejects_traversal():
    with pytest.raises(FileReceiveError) as exc:
        normalize_filename("../evil.pdf")
    assert exc.value.code == "FR-VAL-005"


def test_validate_missing_required_field():
    payload = _minimal_payload()
    payload.pop("content_type")
    with pytest.raises(FileReceiveError) as exc:
        validate_create_payload(payload, _source())
    assert exc.value.code == "FR-VAL-001"
    assert any(item["field"] == "content_type" for item in exc.value.details)


def test_minimal_payload_only_three_fields():
    result = validate_create_payload(_minimal_payload(), _source())
    assert result["file_size"] == 0
    assert result["file_sha256"] == ""
    assert result["total_parts"] == 0
    assert result["biz_type"] == "report"
    assert result["biz_no"] is None
    assert result["biz_fields"] == {}
    assert result["push_time"] is not None
    # request_id 由 service 生成，校验层不产出
    assert "request_id" not in result


def test_client_supplied_generated_fields_are_ignored():
    payload = _minimal_payload()
    payload.update({
        "request_id": "CLIENT-REQUEST-1",
        "biz_type": "log_package",
        "biz_no": "CLIENT-NO-1",
        "file_size": 123,
        "file_sha256": "a" * 64,
        "push_time": "2020-01-01T00:00:00+08:00",
        "biz_fields": {"department": "客户端"},
    })
    result = validate_create_payload(payload, _source())
    assert "request_id" not in result
    assert result["biz_type"] == "report"
    assert result["biz_no"] is None
    assert result["file_size"] == 0
    assert result["file_sha256"] == ""
    assert result["biz_fields"] == {}


def test_validate_success_and_fingerprint_ignores_push_time():
    payload = _minimal_payload()
    result = validate_create_payload(payload, _source())
    assert result["file_ext"] == "pdf"
    assert result["total_parts"] == 0
    assert result["chunk_size"] > 0

    other_time = dict(payload)
    other_time["push_time"] = "2026-11-23T10:00:00+08:00"
    assert build_fingerprint("TEST_SOURCE", payload) == build_fingerprint("TEST_SOURCE", other_time)


def test_reject_executable_magic(tmp_path):
    path = tmp_path / "fake.pdf"
    path.write_bytes(b"MZ" + b"\x00" * 128)
    with pytest.raises(FileReceiveError) as exc:
        inspect_file(path, "pdf")
    assert exc.value.code == "FR-TYPE-003"


def test_accept_valid_pdf(tmp_path):
    path = tmp_path / "ok.pdf"
    path.write_bytes(b"%PDF-1.4\n" + b"x" * 128)
    mime, archive_check = inspect_file(path, "pdf")
    assert mime == "application/pdf"
    assert archive_check == "not_applicable"


def test_forbidden_extension_priority():
    payload = _minimal_payload()
    payload["file_name"] = "evil.exe"
    with pytest.raises(FileReceiveError) as exc:
        validate_create_payload(payload, _source(allowed_exts=["pdf", "exe"]))
    assert exc.value.code == "FR-TYPE-003"


def test_content_type_must_match_extension():
    payload = _minimal_payload()
    payload["content_type"] = "text/plain"
    with pytest.raises(FileReceiveError) as exc:
        validate_create_payload(payload, _source())
    assert exc.value.code == "FR-TYPE-004"
