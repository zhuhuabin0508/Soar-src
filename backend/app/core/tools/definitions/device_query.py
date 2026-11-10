"""设备对接模块工具定义：把"设备信息及动作查询 / 动作执行"能力封装为智能体工具。

- ``query_device_actions`` 对应 REST 接口 GET /api/v1/devices/{device_id}/detail，
  在沙箱内直接查询 Device / DeviceAction 表实现等价逻辑（无需走 HTTP）。
- ``execute_device_action`` 通过注入的 ``execute_device_action_by_id`` 委托
  app.devices.action_executor 执行引擎，实际调用设备 API。

设计意图：设备（如青藤万相）下挂载大量动作，智能体在执行具体设备动作前，
应先调用查询工具发现"某设备支持哪些动作、参数长什么样"，再据此引导后续调用，
避免凭空猜测动作标识或参数名；无法确定目标设备/动作时先用 clarify 向用户澄清。

命名遵循工具规范：读操作使用 query_ 前缀（并行安全）；执行类使用 execute_ 前缀。
"""
from typing import Any

from app.core.tools.types import TOOL_SOURCE_DEVICE

# 工具代码：运行于沙箱命名空间（禁止 import），依赖注入的
# SessionLocal / Device / DeviceAction / json。
# 逻辑与 API /api/v1/devices/{device_id}/detail 保持一致：
# - 不传 device_id：返回全部设备摘要（含可用动作数），引导两步发现
# - 传 device_id：返回设备基础信息（不含凭据）+ 动作清单
#   - full=false（默认）：动作摘要 + 必填参数名（轻量，适合浏览）
#   - full=true：动作完整参数定义 + 标准 JSON Schema + 返回字段说明
# - keyword：按动作标识(action_type)/名称/描述模糊过滤
_DEVICE_QUERY_CODE = """
async def run(**kwargs):
    device_id = kwargs.get('device_id')
    keyword = (kwargs.get('keyword') or '').strip()
    full = bool(kwargs.get('full') or False)
    enabled_only = kwargs.get('enabled_only')
    if enabled_only is None:
        enabled_only = True
    else:
        enabled_only = bool(enabled_only)
    db = SessionLocal()
    try:
        # ---------- 情况 1：未传 device_id，返回设备摘要列表 ----------
        if device_id is None:
            devices = db.query(Device).order_by(Device.id).all()
            items = []
            for d in devices:
                q = db.query(DeviceAction).filter(DeviceAction.device_id == d.id)
                if enabled_only:
                    q = q.filter(DeviceAction.enabled.is_(True))
                items.append({
                    'id': d.id,
                    'name': d.name,
                    'type': d.type,
                    'vendor': d.vendor,
                    'version': d.version,
                    'enabled': bool(d.enabled),
                    'status': d.status,
                    'auth_type': d.auth_type,
                    'action_count': q.count(),
                })
            return {
                'devices': items,
                'total': len(items),
                'hint': '传入 device_id 查看该设备全部可用动作；可配合 keyword 过滤、full=true 获取完整参数定义',
            }

        # ---------- 情况 2：传 device_id，返回设备信息 + 动作清单 ----------
        try:
            device_id = int(device_id)
        except (TypeError, ValueError):
            return {'error': 'device_id 必须是数字（设备 ID）'}
        device = db.query(Device).filter(Device.id == device_id).first()
        if device is None:
            available = [
                {'id': d.id, 'name': d.name}
                for d in db.query(Device).order_by(Device.id).all()
            ]
            return {
                'error': '设备不存在: id=%s' % device_id,
                'available_devices': available,
            }

        q = db.query(DeviceAction).filter(DeviceAction.device_id == device.id)
        if enabled_only:
            q = q.filter(DeviceAction.enabled.is_(True))
        if keyword:
            like = '%' + keyword + '%'
            q = q.filter(
                DeviceAction.action_type.like(like)
                | DeviceAction.name.like(like)
                | DeviceAction.description.like(like)
            )
        rows = q.order_by(DeviceAction.id).all()

        actions = []
        for a in rows:
            # 解析动作参数定义（JSON 数组: name/type/required/description）
            try:
                params = json.loads(a.params_schema or '[]')
            except Exception:
                params = []
            if not isinstance(params, list):
                params = []
            item = {
                'action_id': a.id,
                'action_type': a.action_type,
                'name': a.name,
                'description': a.description,
                'http_method': a.http_method,
                'api_path': a.api_path,
                'category': a.category,
                'risk_level': a.risk_level,
                'enabled': bool(a.enabled),
            }
            if full:
                # 完整模式：全部参数定义 + 标准 JSON Schema + 返回字段说明
                properties = {}
                required = []
                for p in params:
                    if not isinstance(p, dict) or not p.get('name'):
                        continue
                    properties[p['name']] = {
                        'type': (p.get('type') or 'String'),
                        'description': (p.get('description') or ''),
                    }
                    if p.get('required'):
                        required.append(p['name'])
                item['params'] = params
                item['params_json_schema'] = {
                    'type': 'object',
                    'properties': properties,
                    'required': required,
                }
                resp_fields = []
                try:
                    resp = json.loads(a.example_response or '')
                    if isinstance(resp, dict) and isinstance(resp.get('fields'), list):
                        resp_fields = resp['fields']
                    elif isinstance(resp, list):
                        resp_fields = resp
                except Exception:
                    resp_fields = []
                item['response_fields'] = resp_fields
            else:
                # 摘要模式：只带必填参数名，轻量返回
                item['required_params'] = [
                    p.get('name')
                    for p in params
                    if isinstance(p, dict) and p.get('required')
                ]
            actions.append(item)

        try:
            tags = json.loads(device.tags or '[]')
        except Exception:
            tags = []
        device_info = {
            'id': device.id,
            'name': device.name,
            'type': device.type,
            'vendor': device.vendor,
            'version': device.version,
            'ip_address': device.ip_address,
            'api_url': device.api_url,
            'enabled': bool(device.enabled),
            'status': device.status,
            'auth_type': device.auth_type,
            'description': device.description,
            'tags': tags,
        }
        return {
            'device': device_info,
            'actions': actions,
            'total': len(actions),
            'full': full,
            'hint': 'full=false 仅返回摘要与必填参数名；需要完整参数定义、JSON Schema 与返回字段说明时用 full=true 再次调用',
        }
    except Exception as exc:
        return {'error': '查询设备动作失败: ' + str(exc)}
    finally:
        db.close()
"""

DEVICE_QUERY_TOOLS: list[dict[str, Any]] = [
    {
        "name": "query_device_actions",
        "description": (
            "设备信息及动作查询：查询设备对接模块中的设备列表，以及每个设备下挂载的全部可用动作。"
            "不传 device_id 时返回全部设备摘要（含每台设备的可用动作数）；"
            "传 device_id 时返回该设备基础信息（不含凭据）及其动作清单，"
            "每个动作含动作标识(action_type)、名称、功能描述、请求方式与路径(Method + URL)。"
            "full=false（默认）返回动作摘要与必填参数名；full=true 返回完整参数定义、"
            "参数 JSON Schema 及返回结果字段说明。keyword 可按动作标识/名称/描述模糊过滤。"
            "用途：在执行具体设备动作前，先用本工具确认该设备支持哪些动作及其参数要求，"
            "避免使用不存在的动作或猜测参数。"
        ),
        "parameters_schema": [
            {
                "name": "device_id",
                "type": "Number",
                "required": False,
                "description": "设备 ID（数字）。不传则返回全部设备摘要列表，便于先发现可用设备",
            },
            {
                "name": "keyword",
                "type": "String",
                "required": False,
                "description": "按动作标识(action_type)/动作名称/动作描述模糊过滤；仅与 device_id 同用时生效",
            },
            {
                "name": "full",
                "type": "Boolean",
                "required": False,
                "description": "是否返回动作完整定义（全部参数 + 参数 JSON Schema + 返回字段说明）；默认 false 仅返回摘要与必填参数名。设备动作较多（如青藤万相 144 个）时建议先 false 浏览，再按需查看",
            },
            {
                "name": "enabled_only",
                "type": "Boolean",
                "required": False,
                "description": "是否仅返回已启用（可用）的动作，默认 true",
            },
        ],
        "code": _DEVICE_QUERY_CODE,
        "tool_type": "code",
        "category": "device",
        "enabled": True,
        "is_preset": True,
        "tool_source": TOOL_SOURCE_DEVICE,
    },
]

# 工具代码：运行于沙箱命名空间（禁止 import），依赖注入的
# execute_device_action_by_id（tool_runner 已按当前智能体/用户绑定审计作用域）。
# 仅做入参透传与基本校验，实际执行/审计/日志全部在执行引擎内完成。
_EXECUTE_ACTION_CODE = """
async def run(**kwargs):
    action_id = kwargs.get('action_id')
    if action_id is None:
        return {'error': '必须提供 action_id（先用 query_device_actions 获取动作的 action_id）'}
    params = kwargs.get('params')
    if params is not None and not isinstance(params, dict):
        return {'error': 'params 必须是对象（动作参数 key-value）'}
    return await execute_device_action_by_id(
        action_id=action_id,
        params=params or {},
        device_id=kwargs.get('device_id'),
    )
"""

DEVICE_QUERY_TOOLS.extend([
    {
        "name": "execute_device_action",
        "description": (
            "执行设备对接模块中的具体设备动作（实际调用设备 API）。"
            "使用前必须先用 query_device_actions 获取目标动作的 action_id 及参数要求，"
            "严禁凭记忆猜测 action_id 或参数名。"
            "执行纪律：查询类动作（只读查询、risk_level=low）确认参数齐全后可直接执行；"
            "处置类或中高风险动作（risk_level 为 medium/high，如封禁 IP、隔离主机、"
            "删除数据、变更配置等写操作）必须先调用 clarify 工具向用户说明将执行的动作、"
            "目标与影响，得到用户明确确认后才能执行。"
            "返回 success / status_code / response_body（设备原始响应）及 device / action 上下文；"
            "列表型结果超过上下文上限时，response_body.rows 只保留完整行，并返回 "
            "pagination（page / page_size / offset / returned / rows_dropped / total / "
            "has_more / next_page / restart_page / restart_size）。"
            "出现 next_page 时按它翻页；出现 rows_dropped>0 或 restart_page 时说明原页被裁剪、"
            "继续翻页会漏行，必须按 restart_page / restart_size（≤40）从头重新取数。"
            "建议一开始就用 size=40 小页取数。"
            "同一 action_id 与相同 params 不要重复调用（结果已足够时直接使用）。"
            "注意：只需要「完整明细 Excel」时不要用本工具逐页取数，"
            "改用 export_device_action_to_excel 一步导出。"
            "失败时含 error 及原因（如设备凭据未配置、网络不通）。"
        ),
        "parameters_schema": [
            {
                "name": "action_id",
                "type": "Number",
                "required": True,
                "description": "设备动作 ID（query_device_actions 返回的 action_id）",
            },
            {
                "name": "params",
                "type": "Object",
                "required": False,
                "description": (
                    "动作参数键值对。参数名与必填性以 query_device_actions 的"
                    "required_params / params 定义为准（full=true 可看完整定义）"
                ),
            },
            {
                "name": "device_id",
                "type": "Number",
                "required": False,
                "description": "动作所属设备 ID，传入后校验动作归属，防止误用其他设备的动作",
            },
        ],
        "code": _EXECUTE_ACTION_CODE,
        "tool_type": "code",
        "category": "device",
        "enabled": True,
        "is_preset": True,
        "tool_source": TOOL_SOURCE_DEVICE,
    },
])

# 工具代码：运行于沙箱命名空间（禁止 import），依赖注入的
# export_device_action_to_excel（tool_runner 已按当前智能体/用户绑定审计作用域）。
# 服务端分页拉全量 + 直写 xlsx，LLM 不经手行数据。
_EXPORT_EXCEL_CODE = """
async def run(**kwargs):
    action_id = kwargs.get('action_id')
    if action_id is None:
        return {'error': '必须提供 action_id（先用 query_device_actions 获取动作的 action_id）'}
    params = kwargs.get('params')
    if params is not None and not isinstance(params, dict):
        return {'error': 'params 必须是对象（动作参数 key-value，如过滤条件）'}
    file_name = kwargs.get('file_name') or '设备数据导出.xlsx'
    columns = kwargs.get('columns')
    if columns is not None and not isinstance(columns, list):
        return {'error': 'columns 必须是字符串数组（要导出的字段名列表）'}
    return await export_device_action_to_excel(
        action_id=action_id,
        params=params or {},
        file_name=str(file_name),
        columns=columns,
        sheet_name=kwargs.get('sheet_name'),
    )
"""

DEVICE_QUERY_TOOLS.extend([
    {
        "name": "export_device_action_to_excel",
        "description": (
            "把设备动作的列表型查询结果一键导出为 Excel 文件（服务端自动分页拉全量数据并直写文件）。"
            "适用场景：用户需要「完整明细 / 全部数据 / 导出清单」的 Excel 时，"
            "不要用 execute_device_action 逐页取数再 generate_document/append_document 拼文档——"
            "那样每页、每批都要等大模型重读上下文，耗时分钟级；"
            "本工具在服务端一次完成取数与写文件，速度快且不会漏行。"
            "用法：先用 query_device_actions 找到目标查询动作的 action_id，"
            "再把过滤条件（如 name=mysql）放进 params 传给本工具（page/size 无需传，服务端控制）。"
            "columns 可选，用于只导出部分字段（默认导出全部字段）。"
            "仅支持返回 rows 列表的查询类动作；非列表结果请用 execute_device_action。"
            "返回 {ok, file_id, file_name, rows, columns, total, pages, download_url}，"
            "用户可直接下载；生成后只需在最终回复中给结论与文件链接即可。"
        ),
        "parameters_schema": [
            {
                "name": "action_id",
                "type": "Number",
                "required": True,
                "description": "设备动作 ID（query_device_actions 返回的查询类动作 action_id）",
            },
            {
                "name": "params",
                "type": "Object",
                "required": False,
                "description": "动作过滤参数键值对（如 {\"name\": \"mysql\"}）；page/size 由服务端控制，无需传",
            },
            {
                "name": "file_name",
                "type": "String",
                "required": False,
                "description": "输出文件名（如 '青藤MySQL主机完整明细.xlsx'，可不含扩展名）",
            },
            {
                "name": "columns",
                "type": "Array",
                "required": False,
                "description": "要导出的字段名列表（可选；默认导出数据行的全部字段）",
            },
            {
                "name": "sheet_name",
                "type": "String",
                "required": False,
                "description": "工作表名（可选，默认'数据'）",
            },
        ],
        "code": _EXPORT_EXCEL_CODE,
        "tool_type": "code",
        "category": "device",
        "enabled": True,
        "is_preset": True,
        "tool_source": TOOL_SOURCE_DEVICE,
    },
])
