"""奇安信天擎 ODP 内置只读动作定义。

数据来源：《奇安信天擎终端安全管理系统 V10.0R7 ODP 对接文档 V1.8》。
ODP 仅提供查询类接口，本模块收录文档中的全部查询能力（版本、分组、终端、
病毒防护、补丁、基线、软件、移动存储、任务执行结果、安全评估），
不包含创建/修改/删除/隔离/扫描等写操作。

动作结构对应 DeviceAction 模型：
- ``auth_type`` 统一为 ``tianqing``，由动作执行器自动完成 HMAC-SHA256 签名；
- 请求体为 ODP GraphQL，``{{oid}}`` / ``{{asset_id}}`` 由执行器自动填充；
- 其余 ``{{param}}`` 由动作参数渲染，参数在 params_schema 中声明。

``ensure_tianqing_actions`` 幂等为所有 auth_type=tianqing 的设备补齐动作：
按 action_type 判重，不覆盖用户已修改的同名动作。
"""
from __future__ import annotations

import json
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.models.device import Device, DeviceAction

logger = logging.getLogger(__name__)

ODP_PROJECT = "skylar.business.odp"


def _p(
    name: str,
    label: str,
    ptype: str,
    required: bool = False,
    default: Any = None,
    desc: str = "",
) -> dict[str, Any]:
    item: dict[str, Any] = {
        "name": name,
        "label": label,
        "type": ptype,
        "required": required,
        "description": desc,
    }
    if default is not None:
        item["default"] = default
    return item


def _body(query: str) -> str:
    """GraphQL 请求体模板（JSON 字符串，保留 {{param}} 占位符）。"""
    return json.dumps(
        {"project": ODP_PROJECT, "query": query, "variables": {}},
        ensure_ascii=False,
    )


def _action(
    action_type: str,
    name: str,
    desc: str,
    query: str,
    params: list[dict[str, Any]] | None = None,
    response_fields: list[str] | None = None,
) -> dict[str, Any]:
    return {
        "action_type": action_type,
        "name": name,
        "description": desc,
        "http_method": "POST",
        "api_path": "/Gql/S",
        "params_schema": json.dumps(params or [], ensure_ascii=False),
        "headers": "{}",
        "body_template": _body(query),
        "auth_type": "tianqing",
        "category": "query",
        "risk_level": "readonly",
        "version": 1,
        "example_response": "\n".join(response_fields or []),
    }


# ============ 分组与终端 ============

Q_VERSION = (
    '{ product(key: { id: "skylar_console", asset_id: { oid: "{{oid}}", id: "{{asset_id}}" } }) '
    "{ ver { base_version } } }"
)

Q_TREE_ROOT = (
    '{ tree( key: { id: "" asset_id: { oid: "{{oid}}", id: "{{asset_id}}" } } ) { '
    "nodes(node_meta_filter: { is_root: true }, limit: 1, offset: 0) { "
    "relation_entitys { key { id tree_id { id asset_id { id oid } } } meta { name path } } "
    "} } }"
)

Q_TREE_CHILDREN = (
    '{ node( key: { id: "{{node_id}}" tree_id: { id: "{{tree_id}}" '
    'asset_id: { id: "{{asset_id}}", oid: "{{oid}}" } } } ) { '
    "children( extra_filter: { recursive: true types: { node_types: [0, 1, 2, 3, 4, 5] } } "
    "limit: {{limit}} offset: {{offset}} ) { count relation_entitys { key { id } "
    "meta { pid { id } name type path } } } } }"
)

Q_CLIENTS = (
    "{ free_clients( limit: {{limit}} offset: {{offset}} extra_filter: { "
    'order: [ { order_field: "client.client_meta.client_id", asc: true } ] '
    "ast_node: { and: { children: [ { leaf: { key: \"node_path\", "
    "operator: {{operator}}, string_value: \"{{node_path}}\" } } ] } } } ) { "
    "count relation_entitys { key { id asset_id { id oid } } meta { activation "
    "computer_working_group domain ip login_account mac name tos { arch dist "
    "version { kernel_version version } } client_type report_ip system_language } } } }"
)

Q_CLIENT_BASIC = (
    '{ client( key: { id: "{{client_id}}" asset_id: { oid: "{{oid}}", id: "{{asset_id}}" } } ) { '
    "meta { activation computer_working_group domain ip login_account mac name "
    "tos { arch dist version { kernel_version version } } client_type report_ip "
    "system_language } } }"
)

Q_CLIENT_HARDWARE = (
    '{ client( key: { id: "{{client_id}}" asset_id: { oid: "{{oid}}", id: "{{asset_id}}" } } ) { '
    "asset_audiocards { audiocard { model } } "
    "asset_computer { board_bios board_chipset board_model board_serial_number brand_model } "
    "asset_cpus { cpu { core_number main_frequency model serial_number type } } "
    "asset_displays { display { date model resolution scale size } } "
    "asset_displaycards { displaycard { date model memory version } } "
    "asset_networkcards { networkcard { ipv4 mac model subnet_mask } } "
    "asset_rams { ram { capacity model product_number serial_number } } "
    "asset_storages { storage { capacity interface_type model name type serial_number } } } }"
)

# ============ 业务数据 ============

Q_CLIENT_ANTIVIRUS = (
    '{ client( key: { id: "{{client_id}}" asset_id: { oid: "{{oid}}", id: "{{asset_id}}" } } ) { '
    'ext_fields(keys: [{ module: "antivirus" }]) { collects { key { name module } value { '
    "kind { ... on FloatNumberValue { floatMember: member } "
    "... on stringstringValue { stringMember: member } "
    "... on BooleanBoolValue { boolMember: member } "
    "... on int64int64Value { int64Member: member } } } } } "
    "asset_version { virus_version virus_bd_version } } }"
)

Q_PATCH_SUMMARY = (
    '{ client( key: { id: "{{client_id}}" asset_id: { oid: "{{oid}}", id: "{{asset_id}}" } } ) { '
    "client_patch_statistics { security_update_patch_count important_patch_count "
    "function_patch_count optional_patch_count install_count not_active_count "
    "ignored_count exclude_count scan_time version } } }"
)

Q_PATCH_LIST = (
    "query { kbid_by_clientid( limit: {{limit}} offset: {{offset}} clientid_option_filter: { "
    'client_id: { id: "{{client_id}}" asset_id: { oid: "{{oid}}" id: "{{asset_id}}" } } '
    "option: {{option}} } ) { collects { install_time kb_id { id } level patch_name "
    "patch_type publish_date } } }"
)

Q_KBID_CLIENTS = (
    "{ kbid_install_clientids( kbid_install_filter: { kbid: \"{{kbid}}\", "
    "isInstall: {{is_install}} } offset: {{offset}} limit: {{limit}} ) { count "
    "relation_entitys { meta { ip client_type computer_working_group core_number "
    "domain ie_version } } } }"
)

Q_PATCH_DETAIL = (
    "{ patch_kbids( limit: {{limit}} meta_filter: { ast_node: { or: { children: [ "
    '{ leaf: { key: "kbid" operator: 0 string_value: "{{kbid}}" } } '
    "] } } asset_id: { oid: \"{{oid}}\", id: \"{{asset_id}}\" } } ) { "
    "relation_entitys { key { id } meta { cloud_patch_status description level name "
    "os_type patch_type publish_date cnnid cveid } } } }"
)

Q_BASELINE = (
    '{ client( key: { id: "{{client_id}}" asset_id: { oid: "{{oid}}", id: "{{asset_id}}" } } ) { '
    "result { check_time fail_num level op pass_num result score task version } } }"
)

Q_CLIENT_SOFTWARE = (
    '{ softid_clientid(req_filter:{client_id:{id:"{{client_id}}", '
    'asset_id:{oid:"{{oid}}",id:"{{asset_id}}"}}, option:"1"}, '
    "limit:{{limit}}, offset:{{offset}}){ collects { corp install_time soft_name version "
    "soft_id{id} install_source is_update license newest_ver size } } }"
)

# ============ 移动存储 ============

Q_STORAGE_CATEGORIES = (
    "{ categories( category_meta_filter: { is_root:true "
    'assetId: { oid: "{{oid}}", id: "{{asset_id}}" } } ) { collects { id } } }'
)

Q_STORAGE_DEVICES = (
    '{ odp_category( key: { id: "{{category_id}}" asset_id: { oid: "{{oid}}", id: "{{asset_id}}" } } ) { '
    "devices(limit: {{limit}}, offset: {{offset}}, filter: {}) { count relation_entitys { "
    "key { id } device { base_info { capacity grant_status device_id device_type "
    "drive_letter name pid status vid } out_use_auth { auth valid_day } "
    "register_info { client_ip client_name intranet label_name label_id { id } real_name "
    "number reg_first_time reg_time roam server_id source type user_name user_number } } } } } }"
)

# ============ 任务执行结果 ============

Q_PLAN_CARRIERS = (
    '{ plan( key: { id: "{{plan_id}}" asset_id: { id: "{{asset_id}}", oid: "{{oid}}" } } ) { '
    "plan_carrier_list(limit: {{limit}}, offset: {{offset}}) { relation_entitys { "
    "key { id plan_id { id asset_id { oid id } } } } } } }"
)

Q_CARRIER_TASKS = (
    '{ plan_carrier( key: { id: "{{carrier_id}}" plan_id: { '
    'asset_id: { id: "{{asset_id}}" oid: "{{oid}}" } id: "{{plan_id}}" } } ) { '
    "client_tasks(offset: {{offset}}, limit: {{limit}}, client_task_filter: {}) { "
    "relation_entitys { meta { client_id { id asset_id { id oid } } error_code { code } "
    "status updated_at relation_entity { meta { mac name tos { dist } report_ip "
    "report_ipv6 } login_user { relation_entity { meta { real_name } } } normal_node { "
    "relation_entity { meta { is_root name path } } } } } } count } } }"
)

# ============ 安全评估 ============

Q_GROUP_SEC_ASSESS = (
    "query { free_clients( limit: {{limit}} offset: {{offset}} extra_filter: { "
    'order: [{ order_field: "client.client_meta.client_id", asc: true }] ast_node: { and: { '
    'children: [ { leaf: { key: "node_path" operator: 6 string_value: "{{node_path}}" } } ] } } } ) { '
    "count relation_entitys { key { id asset_id { id oid } } ext_fields( keys: [ "
    '{ module: "sec_assess", name: "score" } { module: "sec_assess", name: "authorizer_file_id" } '
    '{ module: "sec_assess", name: "level" } { module: "sec_assess", name: "pass_num" } '
    '{ module: "sec_assess", name: "fail_num" } { module: "sec_assess", name: "unassess_num" } '
    '{ module: "sec_assess", name: "created_at" } ] ) { collects { key { name module } value { '
    "kind { ... on FloatNumberValue { floatMember: member } "
    "... on stringstringValue { stringMember: member } "
    "... on BooleanBoolValue { boolMember: member } "
    "... on int64int64Value { int64Member: member } } } } } "
    "normal_node { relation_entity { meta { name node_name_path_list path } } } "
    "meta { report_ip_unified name tos { dist } client_type } } } }"
)

Q_CLIENT_SEC_ASSESS = (
    "query { client_assess_item_detail_list( limit: {{limit}} offset: {{offset}} filter: { "
    "and: { children: [ { and: { children: [ { leaf: { key: \"client_id\" operator: 0 "
    'string_value: "{{client_id}}" } } ] } } ] } } ) { count collects { id } '
    "relation_entitys { detail { assess_client { meta { name ip mac report_ip report_ipv6 } "
    "normal_node { relation_entity { meta { node_name_path_list } } } } "
    "relation_entity { meta { key check value value_type scope } } updated_at reject result "
    "score std evidence_file_id } } } }"
)

Q_ASSESS_ITEMS_ALL = (
    "query { assess_item_client_result_list( limit: {{limit}} offset: {{offset}} "
    "extra_filter_filter: {}) { count collects { assess_item_id { id } client_type "
    "fail_num pass_num unassess_num updated_at check } } }"
)

Q_ASSESS_ITEMS_GROUP = (
    "query { assess_item_client_result_list( limit: {{limit}} offset: {{offset}} "
    "extra_filter_filter: { ast_node: { and: { children: [ { leaf: { key: \"nodes_id\" "
    'operator: 0 string_value: "{{node_path}}" } } ] } } } ) { count collects { '
    "assess_item_id { id } client_type fail_num pass_num unassess_num updated_at check } } }"
)

Q_ASSESS_ITEM_CLIENTS = (
    "query { client_assess_item_detail_list( limit: {{limit}} offset: {{offset}} filter: { "
    "and: { children: [ { and: { children: [ { leaf: { key: \"nodes_id\" operator: 0 "
    'string_value: "{{node_path}}" } } { leaf: { key: "assess_item_id" operator: 0 '
    'string_value: "{{assess_item_id}}" } } { leaf: { key: "result" operator: 0 '
    'i64_value: "{{result}}" } } ] } } ] } } ) { count collects { id } relation_entitys { '
    "detail { assess_client { meta { name ip mac report_ip report_ipv6 } normal_node { "
    "relation_entity { meta { node_name_path_list } } } } relation_entity { meta { key check "
    "value value_type scope } } updated_at reject result score std evidence_file_id } } } }"
)

_PAGE_LIMIT = _p("limit", "每页条数", "integer", False, 100, "分页大小，ODP 建议不超过 1000")
_PAGE_OFFSET = _p("offset", "偏移量", "integer", False, 0, "从第几条开始，翻页时递增")
_CLIENT_ID = _p("client_id", "终端 ID", "string", True, None, "天擎终端 client_id（可从「资产发现 → 天擎终端」复制）")

TIANQING_ODP_ACTIONS: list[dict[str, Any]] = [
    _action(
        "tianqing_version", "查询管理中心版本",
        "查询天擎 ODP 管理中心基础版本（POST /Gql/S，只读）。",
        Q_VERSION, [], ["ver.base_version: 管理中心版本"],
    ),
    _action(
        "tianqing_tree_root", "查询根分组",
        "查询天擎终端分组树根节点（返回分组 id、tree_id、path，供后续分组查询使用）。",
        Q_TREE_ROOT, [], ["relation_entitys: 根分组（key.id / tree_id / meta.name / meta.path）"],
    ),
    _action(
        "tianqing_tree_children", "查询子分组",
        "按根分组递归查询全部子/孙分组（分组 id、名称、类型、路径）。",
        Q_TREE_CHILDREN,
        [
            _p("node_id", "分组 ID", "string", True, None, "根分组或父分组 id"),
            _p("tree_id", "分组树 ID", "string", True, None, "查询根分组返回的 tree_id.id"),
            _p("limit", "每页条数", "integer", False, 100),
            _p("offset", "偏移量", "integer", False, 0),
        ],
        ["relation_entitys: 子分组列表（key.id / meta.name / meta.type / meta.path）"],
    ),
    _action(
        "tianqing_clients", "查询分组终端列表",
        "按分组路径分页查询终端列表与基础信息（计算机名 / IP / MAC / 系统 / 在线等）。",
        Q_CLIENTS,
        [
            _p("node_path", "分组路径", "string", True, None, "如 ,2813613458799460396，可从「查询根分组」获取"),
            _p("operator", "匹配范围", "integer", False, 6, "6=包含子孙分组，0=仅当前分组"),
            _PAGE_LIMIT,
            _PAGE_OFFSET,
        ],
        ["relation_entitys: 终端列表（key.id 即 client_id，meta 为终端信息）"],
    ),
    _action(
        "tianqing_client_basic", "查询终端基本信息",
        "按终端 client_id 查询单台终端基础信息（名称 / IP / MAC / 系统 / 分组等）。",
        Q_CLIENT_BASIC, [_CLIENT_ID],
        ["meta: 终端基础信息"],
    ),
    _action(
        "tianqing_client_hardware", "查询终端硬件信息",
        "按终端 client_id 查询硬件资产（主板 / CPU / 内存 / 磁盘 / 网卡 / 显卡等）。",
        Q_CLIENT_HARDWARE, [_CLIENT_ID],
        ["asset_computer / asset_cpus / asset_rams / asset_storages 等"],
    ),
    _action(
        "tianqing_client_antivirus", "查询病毒防护状态",
        "按终端 client_id 查询病毒防护状态（查杀时间、病毒库、发现/未处理病毒数、引擎状态）。",
        Q_CLIENT_ANTIVIRUS, [_CLIENT_ID],
        ["ext_fields.collects: antivirus 各项指标", "asset_version: 病毒库版本"],
    ),
    _action(
        "tianqing_patch_summary", "查询补丁统计",
        "按终端 client_id 查询补丁安装统计（未安装安全更新/重要/功能/可选补丁数量）。",
        Q_PATCH_SUMMARY, [_CLIENT_ID],
        ["client_patch_statistics: 补丁数量与扫描时间"],
    ),
    _action(
        "tianqing_patch_list", "查询终端补丁列表",
        "按终端 client_id 查询补丁清单（KB 号 / 名称 / 级别 / 安装时间）。",
        Q_PATCH_LIST,
        [
            _CLIENT_ID,
            _p("option", "补丁类型", "integer", False, 5, "1安全更新 2重要 3功能 4可选 5已安装"),
            _PAGE_LIMIT,
            _PAGE_OFFSET,
        ],
        ["collects: 补丁列表（kb_id.id / patch_name / level / install_time）"],
    ),
    _action(
        "tianqing_kbid_clients", "按 KB 号查询终端",
        "按补丁 KB 号查询安装/未安装该补丁的终端列表。",
        Q_KBID_CLIENTS,
        [
            _p("kbid", "补丁 KB 号", "string", True, None, "如 3199986"),
            _p("is_install", "是否已安装", "string", False, "true", "true=已安装，false=未安装"),
            _PAGE_LIMIT,
            _PAGE_OFFSET,
        ],
        ["relation_entitys: 终端列表（meta.ip / client_type 等）"],
    ),
    _action(
        "tianqing_patch_detail", "查询补丁详情",
        "按补丁 KB 号查询补丁详细信息（描述 / 级别 / 类型 / CVE / 发布日期）。",
        Q_PATCH_DETAIL,
        [
            _p("kbid", "补丁 KB 号", "string", True, None, "如 982671"),
            _p("limit", "返回条数", "integer", False, 10),
        ],
        ["relation_entitys: 补丁详情（meta.name / meta.cveid / meta.level）"],
    ),
    _action(
        "tianqing_client_baseline", "查询基线核查结果",
        "按终端 client_id 查询基线核查结果（得分 / 通过数 / 失败数 / 检查时间）。",
        Q_BASELINE, [_CLIENT_ID],
        ["result: 基线核查结果"],
    ),
    _action(
        "tianqing_client_software", "查询终端软件清单",
        "按终端 client_id 查询已安装软件（名称 / 版本 / 厂商 / 安装时间 / 最新版本）。",
        Q_CLIENT_SOFTWARE,
        [_CLIENT_ID, _p("limit", "每页条数", "integer", False, 1000), _PAGE_OFFSET],
        ["collects: 软件清单（soft_name / version / corp / newest_ver）"],
    ),
    _action(
        "tianqing_storage_categories", "查询移动存储分类",
        "查询移动存储设备分类（返回分类 id，供查询设备使用）。",
        Q_STORAGE_CATEGORIES, [],
        ["collects: 分类 id 列表"],
    ),
    _action(
        "tianqing_storage_devices", "查询移动存储设备",
        "按分类 id 分页查询移动存储设备（U 盘 / 光驱 / 授权状态 / 责任人）。",
        Q_STORAGE_DEVICES,
        [
            _p("category_id", "分类 ID", "string", True, None, "从「查询移动存储分类」获取"),
            _PAGE_LIMIT,
            _PAGE_OFFSET,
        ],
        ["relation_entitys: 设备列表（base_info / register_info）"],
    ),
    _action(
        "tianqing_plan_carriers", "查询任务执行批次",
        "按任务 plan_id 查询任务执行批次（carrier_id），用于进一步查询终端执行结果。",
        Q_PLAN_CARRIERS,
        [
            _p("plan_id", "任务 ID", "string", True, None, "天擎控制台下发的任务 plan_id"),
            _PAGE_LIMIT,
            _PAGE_OFFSET,
        ],
        ["relation_entitys: carrier 列表（key.id / key.plan_id）"],
    ),
    _action(
        "tianqing_carrier_tasks", "查询任务终端执行结果",
        "按 carrier_id 查询任务在终端上的执行状态（成功 / 失败 / 进行中）。",
        Q_CARRIER_TASKS,
        [
            _p("plan_id", "任务 ID", "string", True),
            _p("carrier_id", "批次 ID", "string", True, None, "从「查询任务执行批次」获取"),
            _PAGE_LIMIT,
            _PAGE_OFFSET,
        ],
        ["relation_entitys: 终端执行结果（meta.status / error_code）"],
    ),
    _action(
        "tianqing_group_sec_assess", "查询分组安全评估",
        "按分组路径查询终端安全评估概况（得分 / 等级 / 通过 / 失败项数量）。",
        Q_GROUP_SEC_ASSESS,
        [
            _p("node_path", "分组路径", "string", True, None, "如 ,2848249048991793297"),
            _p("limit", "每页条数", "integer", False, 10),
            _PAGE_OFFSET,
        ],
        ["relation_entitys: 终端评估概况（ext_fields sec_assess）"],
    ),
    _action(
        "tianqing_client_sec_assess", "查询终端安全评估明细",
        "按终端 client_id 查询安全评估明细（评估项 / 结果 / 得分 / 标准）。",
        Q_CLIENT_SEC_ASSESS,
        [_CLIENT_ID, _p("limit", "每页条数", "integer", False, 10), _PAGE_OFFSET],
        ["relation_entitys: 评估项明细"],
    ),
    _action(
        "tianqing_assess_items_all", "查询全网评估项概况",
        "查询全网安全评估项通过/失败终端数量概况。",
        Q_ASSESS_ITEMS_ALL,
        [_p("limit", "每页条数", "integer", False, 10), _PAGE_OFFSET],
        ["collects: 评估项概况（assess_item_id / pass_num / fail_num）"],
    ),
    _action(
        "tianqing_assess_items_group", "查询分组评估项概况",
        "按分组路径查询安全评估项通过/失败终端数量概况。",
        Q_ASSESS_ITEMS_GROUP,
        [
            _p("node_path", "分组路径", "string", True),
            _p("limit", "每页条数", "integer", False, 10),
            _PAGE_OFFSET,
        ],
        ["collects: 评估项概况"],
    ),
    _action(
        "tianqing_assess_item_clients", "查询评估项终端明细",
        "按分组 + 评估项 + 结果查询具体终端明细。",
        Q_ASSESS_ITEM_CLIENTS,
        [
            _p("node_path", "分组路径", "string", True),
            _p("assess_item_id", "评估项 ID", "string", True, None, "如 2006"),
            _p("result", "评估结果", "integer", False, 1, "1=不通过 0=通过"),
            _p("limit", "每页条数", "integer", False, 10),
            _PAGE_OFFSET,
        ],
        ["relation_entitys: 终端评估明细"],
    ),
]


def ensure_tianqing_actions(db: Session, device_ids: list[int] | None = None) -> int:
    """幂等为天擎设备补齐 ODP 只读动作。

    按 ``action_type`` 判重，不覆盖用户已存在的同名动作；新增动作统一为
    ``auth_type=tianqing``、``category=query``、``risk_level=readonly``。

    Returns:
        新增动作条数。
    """
    query = db.query(Device).filter(Device.auth_type == "tianqing")
    if device_ids:
        query = query.filter(Device.id.in_(device_ids))
    devices = query.order_by(Device.id).all()
    if not devices:
        return 0

    added = 0
    for device in devices:
        existing = {
            row[0]
            for row in db.query(DeviceAction.action_type)
            .filter(DeviceAction.device_id == device.id)
            .all()
        }
        for spec in TIANQING_ODP_ACTIONS:
            if spec["action_type"] in existing:
                continue
            db.add(
                DeviceAction(
                    device_id=device.id,
                    name=spec["name"],
                    action_type=spec["action_type"],
                    http_method=spec["http_method"],
                    api_path=spec["api_path"],
                    params_schema=spec["params_schema"],
                    headers=spec["headers"],
                    body_template=spec["body_template"],
                    auth_type=spec["auth_type"],
                    enabled=True,
                    description=spec["description"],
                    category=spec["category"],
                    risk_level=spec["risk_level"],
                    version=spec["version"],
                    example_response=spec.get("example_response"),
                )
            )
            added += 1
    if added:
        db.commit()
        logger.info("天擎 ODP 内置动作已补齐 %s 条（设备 %s 台）", added, len(devices))
    return added
