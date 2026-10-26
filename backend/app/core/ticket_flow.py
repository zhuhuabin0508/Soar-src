"""工单流程模板结构校验与字段值校验助手。

被 ``ticket_flows.py``（发布前校验）与 ``tickets.py``（发起/流转时校验）共用。

流程模板 ``nodes`` JSON 结构约定::

    {
      "start_groups": [1, 2],      # 可发起工单的分组 ID
      "nodes": [
        {
          "key": "n_report",        # 流程内唯一标识（发起后不可改名）
          "name": "监测预警",        # 显示名
          "type": "task",           # task=处理节点 / end=结束节点
          "group_id": 1,            # 处理分组 ID（end 节点可为空）
          "fields": [               # 本节点需填写的字段（可为空数组）
            {"key": "src_ip", "label": "源IP地址", "type": "ip",
             "required": true, "options": [], "placeholder": "",
             "default": "", "alert_field_mapping": "src_ip",
             "auto_enrich": true, "auto_agent": false,
             "rules": []}
            # auto_enrich：仅 ip 类型字段有效，控制发起时资产匹配 +
            # 威胁情报查询，默认 true（开启）
            # auto_agent：仅 ip 类型字段有效，控制发起时智能体研判
            #（IP 风险研判与封禁决策智能体），默认 false（关闭）
            # rules：匹配规则（仅 select/switch 字段可配），形如
            #   [{"value": "是", "fields": [
            #     {"key": "block_time", "label": "封堵时间", "type": "datetime", ...}]}]
            # 用户选择命中规则值时展开该规则下的扩展字段供填写并参与必填校验；
            # 扩展字段的值与普通字段平铺同层存储，未命中的扩展字段值不入库
            #
            # 引用联动（type=reference）：选项不固定配置，动态引用本工单内其他字段
            #（可为任意节点字段）已填写过的值；配置项：
            #   ref_fields: ["src_ip", "dst_ip"]  # 被引用字段 key（可多个）
            #   allow_custom: true/false          # 是否允许填写选项之外的值
            # 被引用字段有新值提交后，下次渲染/校验时选项自动更新
            #
            # 时长（type=duration）：值为人读字符串，「永久」或「数值+单位」
            #（单位：分钟/小时/天），如 "30天" / "12小时" / "永久"
          ],
          "routes": [              # 流转路由（按序匹配，when=null 为默认路由）
            {"to": "n_judge", "label": "流转研判", "when": null},
            {"to": "end", "label": "结束", "when": {"field": "x", "op": "eq", "value": "是"}}
          ],
          # 节点动作 · 封禁同步（可选）：提交时命中触发条件则把封禁信息
          # 同步到工作台已封禁 IP 列表（ban_records，来源=工单同步，仅记录不调用设备）
          # "ban_sync": {
          #   "switch_field": "is_blocked",      # 触发字段（本节点下拉/开关字段 key）
          #   "switch_value": "是",              # 命中该值时触发
          #   "ip_field": "ban_ip",              # 封禁 IP 字段 key（本节点平铺字段）
          #   "device_field": "ban_device",      # 封禁设备字段 key（可选）
          #   "duration_field": "ban_duration"   # 封禁时长字段 key（须为时长类型）
          # }
        },
        {"key": "end", "name": "结束", "type": "end", "fields": [], "routes": []}
      ]
    }

字段类型：text/textarea/number/datetime/select/switch/ip/url/file/reference/duration。
    条件操作符：eq / ne / gt / lt / in / contains（布尔值统一按 是/否 匹配；
    gt/lt 优先数值比较，非数值退化为字符串比较以支持日期时间；in 判断值按
    中英文逗号分隔多值任一命中；contains 字符串包含）。
    路由条件 when 支持两种等价结构：
    - 单条件 {"field": "x", "op": "eq", "value": "是"}
    - 多条件 {"logic": "and" | "or", "conds": [{"field": ..., "op": ..., "value": ...}]}
      （旧单条件结构视为 logic=and、conds=[该条件]）
    节点超时提醒（阶段2）：
    - ``timeout_minutes``：节点停留超时阈值（分钟），空 = 不提醒
    - ``remind_interval_minutes``：超时期间重复提醒间隔（分钟），空或 0 = 仅首次提醒
    """
import re
from typing import Any, Callable, Optional

# 合法字段类型
FIELD_TYPES = {"text", "textarea", "number", "datetime", "select", "switch", "ip", "url", "file", "reference", "duration"}

# 路由条件合法操作符
COND_OPS = {"eq", "ne", "gt", "lt", "in", "contains"}

# 时长字段合法值：「永久」或 数值+单位（分钟/小时/天），如 "30天"
_DURATION_RE = re.compile(r"^(\d+(?:\.\d+)?)(分钟|小时|天)$")

# 时长单位 → 秒
_DURATION_UNITS = {"分钟": 60, "小时": 3600, "天": 86400}


def parse_duration(raw: Any) -> tuple[bool, int]:
    """解析时长字段值为 (是否永久, 秒数)。

    - "永久" → (True, 0)
    - "30天" / "12小时" / "45分钟" → (False, 对应秒数)
    - 非法值 → (False, -1)
    """
    s = str(raw if raw is not None else "").strip()
    if s == "永久":
        return True, 0
    m = _DURATION_RE.match(s)
    if not m:
        return False, -1
    return False, int(float(m.group(1)) * _DURATION_UNITS[m.group(2)])

# IP 字段宽松校验（IPv4 / IPv6）
_IP_RE = re.compile(
    r"^(?:(?:\d{1,3}\.){3}\d{1,3})$"          # IPv4
    r"|(?:^[0-9a-fA-F:]{2,45}$)"              # IPv6（宽松）
)


def iter_nodes(nodes_json: Any) -> list[tuple[str, dict]]:
    """遍历 nodes JSON，返回 [(key, node)]；结构非法时返回空列表。"""
    if not isinstance(nodes_json, dict):
        return []
    nodes = nodes_json.get("nodes")
    if not isinstance(nodes, list):
        return []
    out: list[tuple[str, dict]] = []
    for n in nodes:
        if isinstance(n, dict) and n.get("key"):
            out.append((str(n["key"]), n))
    return out


def get_node(nodes_json: Any, key: str) -> Optional[dict]:
    """按键取节点定义。"""
    for k, n in iter_nodes(nodes_json):
        if k == key:
            return n
    return None


def get_start_node(nodes_json: Any) -> Optional[dict]:
    """取首个处理节点（非 end）作为发起节点。"""
    for _, n in iter_nodes(nodes_json):
        if n.get("type") != "end":
            return n
    return None


def is_end_node(node: Optional[dict]) -> bool:
    """是否为结束节点。"""
    return bool(node) and node.get("type") == "end"


def get_node_pending_groups(node: Optional[dict]) -> list[int]:
    """节点全部待处理分组：并行会签=sign_groups；普通节点=[group_id]。

    引擎到达节点时以此初始化工单的待处理分组集合（current_group_ids）。
    """
    if not isinstance(node, dict):
        return []
    if node.get("type") == "parallel":
        return [int(g) for g in node.get("sign_groups") or [] if isinstance(g, int) and not isinstance(g, bool)]
    gid = node.get("group_id")
    return [int(gid)] if isinstance(gid, int) and not isinstance(gid, bool) else []


def validate_flow_structure(
    nodes_json: Any,
    *,
    group_ok: Optional[Callable[[int], bool]] = None,
) -> list[str]:
    """发布前校验流程结构，返回错误列表（空=通过）。

    Args:
        nodes_json: 流程模板 nodes 字段（完整 JSON 对象）。
        group_ok: 分组存在性校验回调（存在且启用返回 True）。
    """
    errors: list[str] = []
    if not isinstance(nodes_json, dict):
        return ["流程结构必须为 JSON 对象"]
    nodes = nodes_json.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        return ["节点列表不能为空"]

    keys: set[str] = set()
    non_end = 0
    for idx, n in enumerate(nodes):
        pos = f"第 {idx + 1} 个节点"
        if not isinstance(n, dict):
            errors.append(f"{pos}：结构非法")
            continue
        key = n.get("key")
        if not key or not str(key).strip():
            errors.append(f"{pos}：缺少节点标识（key）")
        elif str(key) in keys:
            errors.append(f"{pos}：节点标识 {key} 重复")
        else:
            keys.add(str(key))

        if n.get("type") == "end":
            continue
        non_end += 1
        name = n.get("name") or key
        if not n.get("name"):
            errors.append(f"{pos}：缺少节点名称")

        # 节点类型：task=普通处理 / parallel=并行会签
        ntype = n.get("type") or "task"
        if ntype not in ("task", "parallel"):
            errors.append(f"{pos}（{name}）：节点类型 {n.get('type')} 不合法（task/parallel/end）")
        if non_end == 1 and ntype == "parallel":
            errors.append(f"{pos}（{name}）：首个处理节点（发起节点）不支持并行会签")

        # 处理分组：并行会签节点用 sign_groups（多分组），普通节点用 group_id
        if ntype == "parallel":
            sgs = n.get("sign_groups")
            if not isinstance(sgs, list) or not sgs:
                errors.append(f"{pos}（{name}）：并行会签节点需配置至少一个会签分组")
            else:
                seen_g: set[int] = set()
                for g in sgs:
                    if isinstance(g, bool) or not isinstance(g, int):
                        errors.append(f"{pos}（{name}）：会签分组 ID 必须为整数（ID={g}）")
                    elif g in seen_g:
                        errors.append(f"{pos}（{name}）：会签分组 ID={g} 重复")
                    else:
                        seen_g.add(g)
                        if group_ok is not None and not group_ok(g):
                            errors.append(f"{pos}（{name}）：会签分组不存在或已停用（ID={g}）")
            policy = n.get("finish_policy") or "all"
            if policy not in ("all", "any"):
                errors.append(f"{pos}（{name}）：会签完成策略 {policy} 不合法（all=全部会签 / any=任一即过）")
        else:
            gid = n.get("group_id")
            if gid in (None, ""):
                errors.append(f"{pos}（{name}）：未绑定处理分组")
            elif group_ok is not None and not group_ok(gid):
                errors.append(f"{pos}（{name}）：处理分组不存在或已停用（ID={gid}）")

        # 节点超时提醒配置：为空或正整数；重复间隔需 ≥0 且依赖超时阈值
        tm = n.get("timeout_minutes")
        tm_set = tm not in (None, "")
        if tm_set and (isinstance(tm, bool) or not isinstance(tm, (int, float)) or tm <= 0):
            errors.append(f"{pos}（{name}）：超时提醒分钟数必须为正整数")
        rim = n.get("remind_interval_minutes")
        rim_set = rim not in (None, "")
        if rim_set and (isinstance(rim, bool) or not isinstance(rim, (int, float)) or rim < 0):
            errors.append(f"{pos}（{name}）：重复提醒间隔必须为不小于 0 的整数（分钟）")
        if rim_set and not tm_set:
            errors.append(f"{pos}（{name}）：配置了重复提醒间隔但未配置超时提醒分钟数")

        # 字段
        fields = n.get("fields")
        fkeys: set[str] = set()
        ftypes: dict[str, str] = {}  # 平铺字段 key → 类型（路由 gt/lt 类型校验用）
        fdefs: dict[str, dict] = {}  # 平铺字段 key → 字段定义（封禁同步配置校验用）
        if fields in (None, []):
            fields = []
        if not isinstance(fields, list):
            errors.append(f"{pos}（{name}）：字段定义必须为数组")
        else:
            for f in fields:
                if not isinstance(f, dict):
                    errors.append(f"{pos}（{name}）：存在非法字段定义")
                    continue
                fkey = f.get("key")
                flabel = f.get("label") or fkey
                if not fkey or not str(fkey).strip():
                    errors.append(f"{pos}（{name}）：存在缺少标识（key）的字段")
                elif str(fkey) in fkeys:
                    errors.append(f"{pos}（{name}）：字段标识 {fkey} 重复")
                else:
                    fkeys.add(str(fkey))
                if not f.get("label"):
                    errors.append(f"{pos}（{name}）：字段 {fkey} 缺少显示名（label）")
                ftype = f.get("type") or "text"
                if fkey:
                    ftypes[str(fkey)] = ftype
                    fdefs[str(fkey)] = f
                if ftype not in FIELD_TYPES:
                    errors.append(f"{pos}（{name}）：字段 {flabel} 类型 {ftype} 不合法")
                if ftype == "select" and not f.get("options"):
                    errors.append(f"{pos}（{name}）：字段 {flabel} 为下拉选择但未配置选项")
                # 匹配规则校验（仅 select/switch）：规则值须命中选项且不重复，
                # 扩展字段结构合法、节点内 key 唯一、不支持嵌套规则
                rules = f.get("rules")
                if rules not in (None, [], ""):
                    if not isinstance(rules, list):
                        errors.append(f"{pos}（{name}）：字段 {flabel} 的匹配规则必须为数组")
                    elif ftype not in ("select", "switch"):
                        errors.append(f"{pos}（{name}）：字段 {flabel} 仅下拉选择/是否开关类型支持匹配规则")
                    else:
                        allowed = ["是", "否"] if ftype == "switch" else [str(o) for o in (f.get("options") or [])]
                        seen_vals: set[str] = set()
                        for ri, rule in enumerate(rules):
                            rpos = f"字段 {flabel} 的第 {ri + 1} 条匹配规则"
                            if not isinstance(rule, dict):
                                errors.append(f"{pos}（{name}）：{rpos}结构非法")
                                continue
                            rv = rule.get("value")
                            if rv is None or not str(rv).strip():
                                errors.append(f"{pos}（{name}）：{rpos}缺少匹配值")
                                continue
                            if str(rv) in seen_vals:
                                errors.append(f"{pos}（{name}）：{rpos}匹配值 {rv} 重复")
                            seen_vals.add(str(rv))
                            if str(rv) not in allowed:
                                errors.append(f"{pos}（{name}）：{rpos}匹配值 {rv} 必须是字段 {flabel} 的可选项之一")
                            rfields = rule.get("fields")
                            if rfields in (None, ""):
                                rfields = []
                            if not isinstance(rfields, list):
                                errors.append(f"{pos}（{name}）：{rpos}的扩展字段必须为数组")
                                continue
                            for rf in rfields:
                                if not isinstance(rf, dict):
                                    errors.append(f"{pos}（{name}）：{rpos}存在非法扩展字段")
                                    continue
                                rkey = rf.get("key")
                                rlabel = rf.get("label") or rkey
                                if not rkey or not str(rkey).strip():
                                    errors.append(f"{pos}（{name}）：{rpos}存在缺少标识（key）的扩展字段")
                                elif str(rkey) in fkeys:
                                    errors.append(f"{pos}（{name}）：{rpos}的扩展字段标识 {rkey} 与节点内其他字段重复")
                                else:
                                    fkeys.add(str(rkey))
                                if not rf.get("label"):
                                    errors.append(f"{pos}（{name}）：{rpos}的扩展字段 {rkey} 缺少显示名（label）")
                                rtype = rf.get("type") or "text"
                                if rkey:
                                    ftypes[str(rkey)] = rtype
                                    fdefs[str(rkey)] = rf
                                if rtype not in FIELD_TYPES:
                                    errors.append(f"{pos}（{name}）：{rpos}的扩展字段 {rlabel} 类型 {rtype} 不合法")
                                if rtype == "select" and not rf.get("options"):
                                    errors.append(f"{pos}（{name}）：{rpos}的扩展字段 {rlabel} 为下拉选择但未配置选项")
                                if rf.get("rules"):
                                    errors.append(f"{pos}（{name}）：{rpos}的扩展字段 {rlabel} 不支持再嵌套匹配规则")

        # 节点动作 · 封禁同步配置校验（触发字段/值、IP/设备/时长字段映射均须有效）
        ban_sync = n.get("ban_sync")
        if ban_sync not in (None, {}, ""):
            if not isinstance(ban_sync, dict):
                errors.append(f"{pos}（{name}）：封禁同步配置必须为对象")
            else:
                sw = ban_sync.get("switch_field")
                sw_def = fdefs.get(str(sw)) if sw else None
                if not sw or sw_def is None:
                    errors.append(f"{pos}（{name}）：封禁同步未配置触发字段，或触发字段不在本节点字段中")
                elif sw_def.get("type") not in ("select", "switch"):
                    errors.append(f"{pos}（{name}）：封禁同步触发字段 {sw} 需为下拉选择/是否开关类型")
                else:
                    allowed_sw = ["是", "否"] if sw_def.get("type") == "switch" else [str(o) for o in (sw_def.get("options") or [])]
                    swv = ban_sync.get("switch_value")
                    if swv in (None, ""):
                        swv = "是"
                    if str(swv) not in allowed_sw:
                        errors.append(f"{pos}（{name}）：封禁同步触发值 {swv} 必须是字段 {sw} 的可选项之一")
                ipf = ban_sync.get("ip_field")
                if not ipf or str(ipf) not in fdefs:
                    errors.append(f"{pos}（{name}）：封禁同步未配置封禁 IP 字段，或该字段不在本节点字段中")
                durf = ban_sync.get("duration_field")
                dur_def = fdefs.get(str(durf)) if durf else None
                if not durf or dur_def is None:
                    errors.append(f"{pos}（{name}）：封禁同步未配置封禁时长字段，或该字段不在本节点字段中")
                elif dur_def.get("type") != "duration":
                    errors.append(f"{pos}（{name}）：封禁同步时长字段 {durf} 需为时长类型")
                devf = ban_sync.get("device_field")
                if devf and str(devf) not in fdefs:
                    errors.append(f"{pos}（{name}）：封禁同步设备字段 {devf} 不在本节点字段中")

        # 路由
        routes = n.get("routes")
        if not isinstance(routes, list) or not routes:
            errors.append(f"{pos}（{name}）：至少需要一条流转路由")
        else:
            has_default = False
            for r in routes:
                if not isinstance(r, dict):
                    errors.append(f"{pos}（{name}）：存在非法路由定义")
                    continue
                to = r.get("to")
                if not to:
                    errors.append(f"{pos}（{name}）：路由缺少去向节点")
                when = r.get("when")
                if when is None:
                    if has_default:
                        errors.append(f"{pos}（{name}）：存在多条默认路由")
                    has_default = True
                else:
                    _, conds = _iter_conds(when)
                    if not conds:
                        errors.append(f"{pos}（{name}）：条件路由缺少判断条件")
                    for c in conds:
                        fkey = str(c.get("field") or "")
                        if not fkey:
                            errors.append(f"{pos}（{name}）：条件路由缺少判断字段")
                            continue
                        if fkey not in fkeys:
                            errors.append(f"{pos}（{name}）：条件路由的判断字段 {fkey} 不在节点字段中")
                            continue
                        op = c.get("op") or "eq"
                        if op not in COND_OPS:
                            errors.append(
                                f"{pos}（{name}）：条件字段 {fkey} 的操作符 {op} 不合法"
                                f"（仅支持 eq/ne/gt/lt/in/contains）"
                            )
                        elif op in ("gt", "lt") and ftypes.get(fkey) not in ("number", "datetime"):
                            errors.append(
                                f"{pos}（{name}）：判断字段 {fkey} 需为数字或日期时间类型才能使用大于/小于"
                            )

    if non_end == 0:
        errors.append("流程至少需要一个处理节点")

    # 引用联动字段校验（需全流程平铺字段 key 集合）：ref_fields 非空且指向存在的字段
    all_flat_keys: set[str] = set()
    ref_cfgs: list[tuple[str, dict]] = []  # (位置描述, 字段定义)
    for nkey, n in iter_nodes(nodes_json):
        if is_end_node(n):
            continue
        npos = f"节点 {n.get('name') or nkey}"
        for f in n.get("fields") or []:
            if not isinstance(f, dict):
                continue
            if f.get("key"):
                all_flat_keys.add(str(f["key"]))
            if (f.get("type") or "text") == "reference" and f.get("key"):
                ref_cfgs.append((npos, f))
            for rf in iter_rule_fields(f):
                if rf.get("key"):
                    all_flat_keys.add(str(rf["key"]))
                if (rf.get("type") or "text") == "reference" and rf.get("key"):
                    ref_cfgs.append((f"{npos} 的扩展字段", rf))
    for npos, f in ref_cfgs:
        label = f.get("label") or f.get("key")
        rfs = f.get("ref_fields")
        if not isinstance(rfs, list) or not rfs or not all(
            isinstance(x, str) and x.strip() for x in rfs
        ):
            errors.append(f"{npos}：引用联动字段 {label} 未配置被引用字段（ref_fields）")
            continue
        for rk in rfs:
            if rk == f.get("key"):
                errors.append(f"{npos}：引用联动字段 {label} 不能引用自身")
            elif rk not in all_flat_keys:
                errors.append(f"{npos}：引用联动字段 {label} 引用的字段 {rk} 不存在")

    # 第二轮：路由指向 / 回退白名单校验（需要全量 key 集合）
    for _, n in iter_nodes(nodes_json):
        if is_end_node(n):
            continue
        name = n.get("name") or n.get("key")
        for r in n.get("routes") or []:
            if isinstance(r, dict) and r.get("to") and r["to"] not in keys:
                errors.append(f"节点 {name} 的流转去向 {r['to']} 不存在")
        # 回退白名单：可选项（缺省=退回上一处理节点）；空数组=禁止回退
        rb = n.get("rollback_to")
        if rb is None:
            continue
        if not isinstance(rb, list):
            errors.append(f"节点 {name} 的回退白名单必须为数组")
            continue
        seen_rb: set[str] = set()
        for tk in rb:
            if not isinstance(tk, str) or not tk.strip():
                errors.append(f"节点 {name} 的回退白名单存在非法项（{tk}）")
            elif tk == n.get("key"):
                errors.append(f"节点 {name} 的回退白名单不能包含自身")
            elif tk in seen_rb:
                errors.append(f"节点 {name} 的回退白名单项 {tk} 重复")
            elif tk not in keys:
                errors.append(f"节点 {name} 的回退白名单项 {tk} 不存在")
            else:
                target = get_node(nodes_json, tk)
                if target is not None and is_end_node(target):
                    errors.append(f"节点 {name} 的回退白名单项 {tk} 是结束节点，不能回退")
                else:
                    seen_rb.add(tk)  # 仅合法项参与去重：无效项重复时报其真实问题而非"重复"

    # 发起分组
    start_groups = nodes_json.get("start_groups")
    if not isinstance(start_groups, list) or not start_groups:
        errors.append("未配置可发起工单的分组")
    else:
        if group_ok is not None:
            for gid in start_groups:
                if not group_ok(gid):
                    errors.append(f"发起分组 {gid} 不存在或已停用")

    # 抄送配置（模板级全局，可选）：[{type: user|group, id, name}]
    cc_targets = nodes_json.get("cc_targets")
    if cc_targets not in (None, []):
        if not isinstance(cc_targets, list):
            errors.append("抄送配置必须为数组")
        else:
            for t in cc_targets:
                if not isinstance(t, dict) or t.get("type") not in ("user", "group"):
                    errors.append("抄送配置存在非法对象（type 仅支持 user/group）")
                    break
                if isinstance(t.get("id"), bool) or not isinstance(t.get("id"), int):
                    errors.append(f"抄送对象 {t.get('name') or t.get('id')} 的 ID 必须为整数")
                    break

    return errors


def _is_empty(v: Any) -> bool:
    """字段值是否为空（None / 空串 / 空白串）。"""
    return v is None or (isinstance(v, str) and not v.strip())


def iter_rule_fields(field_def: dict) -> list[dict]:
    """遍历下拉/开关字段全部匹配规则下的扩展字段（不论是否命中）。"""
    rules = field_def.get("rules") if isinstance(field_def, dict) else None
    out: list[dict] = []
    for rule in rules or []:
        if isinstance(rule, dict):
            out.extend(f for f in rule.get("fields") or [] if isinstance(f, dict) and f.get("key"))
    return out


def matched_rule_fields(field_def: dict, value: Any) -> list[dict]:
    """返回字段当前值命中的匹配规则的扩展字段列表（未命中返回空）。

    与路由条件同口径：布尔值归一化为 是/否 后比较；
    字段值未填写（空值）时视为不命中。
    """
    rules = field_def.get("rules") if isinstance(field_def, dict) else None
    if not isinstance(rules, list):
        return []
    actual = _normalize_cond_value(value)
    if actual is None or (isinstance(actual, str) and not actual.strip()):
        return []
    for rule in rules:
        if not isinstance(rule, dict):
            continue
        expected = _normalize_cond_value(rule.get("value"))
        if expected is None or (isinstance(expected, str) and not expected.strip()):
            continue
        if str(actual) == str(expected):
            return [f for f in rule.get("fields") or [] if isinstance(f, dict) and f.get("key")]
    return []


def strip_hidden_field_values(field_defs: Any, values: dict) -> dict:
    """剔除未命中匹配规则的扩展字段值，避免隐藏内容入库/参与路由。

    扩展字段的值与普通字段平铺同层，故需按规则命中情况逐个剔除。
    """
    out = dict(values or {})
    for f in field_defs or []:
        if not (isinstance(f, dict) and f.get("key")):
            continue
        matched_keys = {rf["key"] for rf in matched_rule_fields(f, out.get(f["key"]))}
        for rf in iter_rule_fields(f):
            if rf["key"] not in matched_keys:
                out.pop(rf["key"], None)
    return out


def validate_field_values(
    field_defs: Any,
    values: Any,
    ref_options: Optional[dict] = None,
) -> list[str]:
    """按节点字段定义校验提交的字段值，返回错误列表（空=通过）。

    - 必填项不能为空（未命中匹配规则的扩展字段跳过必填与类型校验）
    - 拒绝未定义字段（防注入；命中规则的扩展字段视为已定义）
    - select 必须命中选项；number 必须可转数字；ip 做格式校验
    - reference（引用联动）：allow_custom=false 时值必须在动态选项内
      （选项由 ref_options 提供：{字段 key: [已填值]}，本工单内被引用字段已填过的值）
    - duration（时长）：必须为「永久」或 数值+单位（分钟/小时/天）
    """
    if not isinstance(values, dict):
        return ["字段值必须为对象"]
    defs: dict[str, dict] = {}
    check: list[dict] = []
    for f in field_defs or []:
        if not (isinstance(f, dict) and f.get("key")):
            continue
        defs[str(f["key"])] = f
        check.append(f)
        # 扩展字段：key 全部注册（允许提交），仅命中规则的参与必填/类型校验
        for rf in iter_rule_fields(f):
            defs[str(rf["key"])] = rf
        for rf in matched_rule_fields(f, values.get(f["key"])):
            check.append(rf)

    errors: list[str] = []
    for k in values:
        if k not in defs:
            errors.append(f"字段 {k} 未在当前节点定义，不允许提交")

    for f in check:
        key = str(f["key"])
        v = values.get(key)
        label = f.get("label") or key
        if _is_empty(v):
            if f.get("required"):
                errors.append(f"{label} 为必填项")
            continue
        ftype = f.get("type") or "text"
        if ftype == "select":
            opts = f.get("options") or []
            if str(v) not in [str(o) for o in opts]:
                errors.append(f"{label} 的值必须是可选项之一")
        elif ftype == "number":
            try:
                float(v)
            except (TypeError, ValueError):
                errors.append(f"{label} 必须为数字")
        elif ftype == "ip":
            if not _IP_RE.match(str(v)):
                errors.append(f"{label} 不是合法的 IP 地址")
        elif ftype == "reference":
            # 引用联动：未开启自定义填写时，值必须在动态选项内
            if f.get("allow_custom") is not True:
                opts = [str(o) for o in ((ref_options or {}).get(key) or [])]
                if not opts:
                    errors.append(f"{label} 当前无可选项（被引用字段尚未填写）")
                elif str(v) not in opts:
                    errors.append(f"{label} 的值必须是可选项之一")
        elif ftype == "duration":
            if parse_duration(v)[1] < 0:
                errors.append(f"{label} 的格式须为 数值+单位（分钟/小时/天）或「永久」")
    return errors


def collect_ref_options(nodes_json: Any, records: Any) -> dict[str, list[str]]:
    """收集引用联动字段的动态选项：本工单内被引用字段已填过的值（按填写顺序去重）。

    Args:
        nodes_json: 流程快照（遍历全部节点的平铺字段，找 type=reference 的定义）
        records: 处理记录列表（按时间正序），元素为带 ``field_values`` 的
            记录对象或 dict
    Returns:
        {引用字段 key: [已填值]}
    """
    ref_defs: list[dict] = []
    seen: set[str] = set()
    for _, n in iter_nodes(nodes_json):
        if is_end_node(n):
            continue
        for f in n.get("fields") or []:
            if not isinstance(f, dict):
                continue
            for d in [f, *iter_rule_fields(f)]:
                if (
                    (d.get("type") or "text") == "reference"
                    and d.get("key")
                    and str(d["key"]) not in seen
                ):
                    seen.add(str(d["key"]))
                    ref_defs.append(d)

    out: dict[str, list[str]] = {}
    for f in ref_defs:
        keys = [str(k) for k in (f.get("ref_fields") or []) if isinstance(k, str) and k.strip()]
        vals: list[str] = []
        vseen: set[str] = set()
        for r in records or []:
            fv = r.get("field_values") if isinstance(r, dict) else getattr(r, "field_values", None)
            if not isinstance(fv, dict):
                continue
            for k in keys:
                v = fv.get(k)
                if isinstance(v, bool):
                    v = "是" if v else "否"
                if v is None or (isinstance(v, str) and not v.strip()):
                    continue
                s = str(v).strip()
                if s and s not in vseen:
                    vseen.add(s)
                    vals.append(s)
        out[str(f["key"])] = vals
    return out


def _normalize_cond_value(v: Any) -> Any:
    """条件比较前归一化：布尔 → 是/否。"""
    if isinstance(v, bool):
        return "是" if v else "否"
    return v


def _iter_conds(when: Any) -> tuple[str, list[dict]]:
    """条件路由 when 归一化为 (logic, conds)。

    兼容两种结构：
    - 旧单条件 {"field": ..., "op": ..., "value": ...} → logic=and、conds=[该条件]
    - 多条件 {"logic": "and"|"or", "conds": [{field, op, value}, ...]}
    """
    if not isinstance(when, dict):
        return "and", []
    conds = when.get("conds")
    if isinstance(conds, list) and conds:
        logic = "or" if when.get("logic") == "or" else "and"
        return logic, [c for c in conds if isinstance(c, dict)]
    if when.get("field"):
        return "and", [when]
    return "and", []


def _eval_cond(cond: dict, values: dict) -> bool:
    """评估单个路由条件（字段未填/空值视为不命中）。"""
    actual = _normalize_cond_value(values.get(cond.get("field")))
    if actual is None or (isinstance(actual, str) and not actual.strip()):
        return False
    expected = _normalize_cond_value(cond.get("value"))
    op = cond.get("op") or "eq"
    s_actual = str(actual)
    s_expected = "" if expected is None else str(expected)
    if op == "eq":
        return s_actual == s_expected
    if op == "ne":
        return s_actual != s_expected
    if op == "contains":
        return bool(s_expected.strip()) and s_expected in s_actual
    if op == "in":
        items = [s.strip() for s in s_expected.replace("，", ",").split(",") if s.strip()]
        return s_actual in items
    if op in ("gt", "lt"):
        if not s_expected.strip():
            return False
        try:
            a, b = float(s_actual), float(s_expected)
        except (TypeError, ValueError):
            # 非数值（如日期时间字符串）退化为字符串比较
            return s_actual > s_expected if op == "gt" else s_actual < s_expected
        return a > b if op == "gt" else a < b
    return False


def suggest_route(routes: Any, field_values: dict) -> tuple[Optional[str], Optional[str]]:
    """按条件评估路由建议。

    when 条件按 _iter_conds 归一化后评估，多条件间按 logic（and/or）聚合；
    路由按序匹配，首条条件命中的路由即为建议去向。

    Returns:
        (条件命中建议的节点 key, 默认路由节点 key)
        - 建议 key：首条 when 条件命中的路由
        - 默认 key：首条 when=null 的路由（无则取首条路由）
    """
    suggested: Optional[str] = None
    default: Optional[str] = None
    first: Optional[str] = None
    for r in routes or []:
        if not isinstance(r, dict) or not r.get("to"):
            continue
        to = r["to"]
        if first is None:
            first = to
        when = r.get("when")
        if not when:
            if default is None:
                default = to
            continue
        logic, conds = _iter_conds(when)
        if not conds:
            continue
        results = (_eval_cond(c, field_values) for c in conds)
        matched = all(results) if logic == "and" else any(results)
        if matched and suggested is None:
            suggested = to
    return suggested, (default if default is not None else first)
