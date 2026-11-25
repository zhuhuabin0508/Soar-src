"""天擎 ODP 内置只读动作定义的单元测试。

覆盖：
- 动作数量与唯一性
- body_template 为合法 GraphQL 请求体且包含 oid / asset_id 占位符
- 参数 schema 合法、动作统一为只读查询口径

运行：python -m pytest tests/test_tianqing_odp_actions.py -v
"""
import json
import os
import sys

sys.path.insert(0, "/app" if os.path.isdir("/app") else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.tianqing_odp_actions import (  # noqa: E402
    ODP_PROJECT,
    TIANQING_ODP_ACTIONS,
)


def test_actions_unique_and_readonly():
    assert len(TIANQING_ODP_ACTIONS) >= 20
    types = [a["action_type"] for a in TIANQING_ODP_ACTIONS]
    names = [a["name"] for a in TIANQING_ODP_ACTIONS]
    assert len(types) == len(set(types))
    assert len(names) == len(set(names))
    for action in TIANQING_ODP_ACTIONS:
        assert action["http_method"] == "POST"
        assert action["api_path"] == "/Gql/S"
        assert action["auth_type"] == "tianqing"
        assert action["category"] == "query"
        assert action["risk_level"] == "readonly"


def test_body_template_is_valid_graphql_payload():
    for action in TIANQING_ODP_ACTIONS:
        body = json.loads(action["body_template"])
        assert body["project"] == ODP_PROJECT
        assert body["variables"] == {}
        query = body["query"]
        # oid / asset_id 要么同时出现（执行器自动注入），要么都不需要
        assert ("{{oid}}" in query) == ("{{asset_id}}" in query)
        assert "{{" in query


def test_params_schema_valid():
    for action in TIANQING_ODP_ACTIONS:
        schema = json.loads(action["params_schema"])
        assert isinstance(schema, list)
        names = [p["name"] for p in schema]
        assert len(names) == len(set(names))
        for item in schema:
            assert item["label"] and item["type"]
            assert isinstance(item["required"], bool)
        # 请求体模板中的参数占位符必须在 schema 中声明，或为执行器自动注入字段
        auto = {"oid", "asset_id"}
        declared = set(names) | auto
        for token in _placeholders(action["body_template"]):
            assert token in declared, f"{action['action_type']} 缺少参数声明: {token}"


def _placeholders(text: str) -> set[str]:
    result = set()
    start = 0
    while True:
        left = text.find("{{", start)
        if left < 0:
            break
        right = text.find("}}", left)
        if right < 0:
            break
        result.add(text[left + 2:right])
        start = right + 2
    return result
