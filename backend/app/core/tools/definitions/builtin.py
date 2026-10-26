from typing import Any

HERMES_BUILTIN_TOOLS: list[dict[str, Any]] = [
    {
        "name": "check_whitelist",
        "description": "检查源 IP 是否命中内网白名单（10/172.16/192.168 网段视为可信内网，不触发处置）",
        "parameters_schema": [
            {"name": "ip", "type": "String", "required": True, "description": "待检查的 IPv4/IPv6 地址"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    ip = kwargs.get('ip') or ''\n"
            "    whitelist_nets = [\n"
            "        ipaddress.ip_network('10.0.0.0/8'),\n"
            "        ipaddress.ip_network('172.16.0.0/12'),\n"
            "        ipaddress.ip_network('192.168.0.0/16'),\n"
            "    ]\n"
            "    try:\n"
            "        addr = ipaddress.ip_address(ip)\n"
            "    except ValueError:\n"
            "        return {'ip': ip, 'in_whitelist': False, 'error': '无效的 IP 地址'}\n"
            "    result = any(addr in net for net in whitelist_nets)\n"
            "    return {'ip': ip, 'in_whitelist': result}\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
    {
        "name": "get_asset_info",
        "description": "查询 IP 对应资产归属信息（部门/负责人/是否关键资产）。优先查询智能体勾选的知识库，未命中时返回 found=false（可转用威胁情报工具）",
        "parameters_schema": [
            {"name": "ip", "type": "String", "required": True, "description": "待查询的 IP 地址"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    ip = kwargs.get('ip') or ''\n"
            "    # 优先查询智能体勾选的知识库（引擎注入 enabled_kbs / search_kb）\n"
            "    kb_ids = list(enabled_kbs or [])\n"
            "    if kb_ids:\n"
            "        # 查询知识库名称映射 + 分段数（供返回标注来源 + 跳过大库避免超时）\n"
            "        kb_names = {}\n"
            "        kb_seg_counts = {}\n"
            "        try:\n"
            "            db = SessionLocal()\n"
            "            try:\n"
            "                for kb in db.query(KnowledgeBase).all():\n"
            "                    kb_names[kb.id] = kb.name\n"
            "                from sqlalchemy import func as _func\n"
            "                rows = db.query(KnowledgeSegment.kb_id, _func.count()).filter(\n"
            "                    KnowledgeSegment.kb_id.in_(kb_ids)\n"
            "                ).group_by(KnowledgeSegment.kb_id).all()\n"
            "                kb_seg_counts = {r[0]: r[1] for r in rows}\n"
            "            finally:\n"
            "                db.close()\n"
            "        except Exception:\n"
            "            pass\n"
            "        # ===== 精确 IP 匹配（直接 LIKE 查询，毫秒级）=====\n"
            "        # BM25/向量检索对 IP 地址效果差且大库超时，精确匹配优先。\n"
            "        exact_matches = []\n"
            "        try:\n"
            "            db = SessionLocal()\n"
            "            try:\n"
            "                segs = db.query(KnowledgeSegment).filter(\n"
            "                    KnowledgeSegment.kb_id.in_(kb_ids),\n"
            "                    KnowledgeSegment.content.like('%' + ip + '%')\n"
            "                ).limit(20).all()\n"
            "                for seg in segs:\n"
            "                    exact_matches.append({\n"
            "                        'kb_id': seg.kb_id,\n"
            "                        'kb_name': kb_names.get(seg.kb_id, f'知识库-{seg.kb_id}'),\n"
            "                        'title': '',\n"
            "                        'content': seg.content,\n"
            "                        'score': 1.0,\n"
            "                        'exact_match': True,\n"
            "                    })\n"
            "            finally:\n"
            "                db.close()\n"
            "        except Exception:\n"
            "            pass\n"
            "        # 精确匹配命中 → 直接返回，跳过慢速 BM25（避免大库超时）\n"
            "        if exact_matches:\n"
            "            return {'ip': ip, 'found': True, 'source': 'knowledge_base', 'count': len(exact_matches), 'matches': exact_matches[:10]}\n"
            "        # ===== BM25 / 向量检索（仅在精确匹配未命中时执行）=====\n"
            "        # 跳过分段数 > 1000 的大库（jieba 分词 + BM25 计算耗时数秒，导致超时）\n"
            "        bm25_matches = []\n"
            "        for kb_id in kb_ids:\n"
            "            if kb_seg_counts.get(kb_id, 0) > 1000:\n"
            "                continue\n"
            "            try:\n"
            "                segs = await search_kb(kb_id, ip, top_k=5)\n"
            "            except Exception:\n"
            "                segs = []\n"
            "            for s in segs:\n"
            "                if (s.get('score') or 0) > 0.1:\n"
            "                    bm25_matches.append({\n"
            "                        'kb_id': kb_id,\n"
            "                        'kb_name': kb_names.get(kb_id, f'知识库-{kb_id}'),\n"
            "                        'title': s.get('title', ''),\n"
            "                        'content': s.get('content', ''),\n"
            "                        'score': round(s.get('score', 0), 3),\n"
            "                        'exact_match': False,\n"
            "                    })\n"
            "        # 合并 + 去重 + 排序\n"
            "        all_matches = exact_matches + bm25_matches\n"
            "        seen = set()\n"
            "        deduped = []\n"
            "        for m in all_matches:\n"
            "            key = (m.get('content', '') or '')[:100]\n"
            "            if key not in seen:\n"
            "                seen.add(key)\n"
            "                deduped.append(m)\n"
            "        deduped.sort(key=lambda x: x.get('score', 0), reverse=True)\n"
            "        if deduped:\n"
            "            return {'ip': ip, 'found': True, 'source': 'knowledge_base', 'count': len(deduped), 'matches': deduped[:10]}\n"
            "        return {'ip': ip, 'found': False, 'source': 'knowledge_base', 'message': '勾选的知识库中未找到该IP，建议使用威胁情报工具查询'}\n"
            "    # 无 agent 上下文（工具测试等）：回退全库查询\n"
            "    try:\n"
            "        return await get_asset_info(ip)\n"
            "    except Exception:\n"
            "        return {'ip': ip, 'found': False, 'message': '未找到该IP的资产信息'}\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
    {
        "name": "search_assets",
        "description": (
            "资产检索：按 IP/名称/标识/部门查询资产清单"
            "（主机资产、网段/IP 信息、出口地址等已配置类型）。"
            "传入单个 IP 会匹配包含该 IP 的 CIDR/范围资产，"
            "并同时在资产发现（云主机/裸金属/网络资源/弹性IP）中精确检索该 IP，"
            "命中以「资产发现」分组返回；按名称/部门等文本查询时仅检索资产清单。"
            "支持逗号/分号/空白分隔批量查询（如 '1.2.3.4,5.6.7.8'），"
            "一次调用返回每个 IP 各自的命中——批量研判多个 IP 时必须合并为一次调用，不要逐个查询。"
            "用于研判时对比告警 IP 是否属于已知资产。"
            "按智能体勾选的资产类型检索：未勾选则不可用；勾选部分则只查这些类型；"
            "全部勾选则不按类型过滤。同一 IP 若出现在主机/网段/出口等多类下会全部返回。"
        ),
        "parameters_schema": [
            {"name": "keyword", "type": "String", "required": False, "description": "IP/名称/标识/负责人；单个 IP 会做网段包含匹配并同步精确查询资产发现（云主机/裸金属/网络资源/弹性IP）；支持逗号/分号/空白分隔批量查询多个 IP"},
            {"name": "ip", "type": "String", "required": False, "description": "待查询 IP（与 keyword 二选一，优先 keyword）"},
            {"name": "department", "type": "String", "required": False, "description": "按使用单位/部门精确筛选"},
            {"name": "type_code", "type": "String", "required": False, "description": "忽略；范围由智能体勾选的资产类型决定，同一 IP 跨类型全部返回"},
            {"name": "limit", "type": "Number", "required": False, "description": "非 IP 查询条数上限；按 IP 查询会跨类型返回全部命中"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    keyword = (kwargs.get('keyword') or kwargs.get('ip') or '').strip()\n"
            "    department = (kwargs.get('department') or '').strip()\n"
            "    type_code = kwargs.get('type_code') or None\n"
            "    if type_code:\n"
            "        type_code = str(type_code).strip() or None\n"
            "    limit = int(kwargs.get('limit') or 20)\n"
            "    return await run_search_assets(\n"
            "        keyword=keyword, department=department,\n"
            "        type_code=type_code, limit=limit,\n"
            "        type_codes=list(enabled_asset_types or []),\n"
            "    )\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
    {
        "name": "search_discovered_assets",
        "description": (
            "查询资产发现数据（综合运管平台爬取的云主机、裸金属、网络资源、弹性IP）。"
            "不查询资产清单。约数十万行，IP 与 CMDB ID 走精确匹配；"
            "实例名、部门走模糊匹配，关键词至少 2 个字。"
            "支持逗号/分号/空白分隔批量查询，一次调用返回每个目标各自的命中。"
            "resource_type 可空；为空时四类都查。"
            "按 IP 查询已由 search_assets 覆盖（其会同时检索资产清单与资产发现），"
            "本工具主要用于按 CMDB ID、实例名、部门或指定资源类型检索资产发现数据。"
        ),
        "parameters_schema": [
            {"name": "keyword", "type": "String", "required": True, "description": "IP、CMDB ID、实例名或部门；支持逗号/分号/空白分隔批量查询"},
            {"name": "ip", "type": "String", "required": False, "description": "待查询 IP（与 keyword 二选一，优先 keyword）"},
            {"name": "resource_type", "type": "String", "required": False, "description": "cloud_host / bare_metal / e_government_network / elastic_ip；空表示四类都查"},
            {"name": "limit", "type": "Number", "required": False, "description": "每一类返回条数上限，默认 10，最大 20"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    keyword = (kwargs.get('keyword') or kwargs.get('ip') or '').strip()\n"
            "    resource_type = (kwargs.get('resource_type') or '').strip()\n"
            "    limit = int(kwargs.get('limit') or 10)\n"
            "    return await run_search_discovered_assets(\n"
            "        keyword=keyword,\n"
            "        resource_type=resource_type,\n"
            "        limit=limit,\n"
            "    )\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
    {
        "name": "get_threat_intel",
        "description": "查询 IP 威胁情报（恶意判定/威胁标签/威胁类型/严重程度/置信度/首次发现/最后发现/情报来源/威胁描述/地理位置/关联恶意软件/攻击模式）。内网白名单 IP 视为非恶意",
        "parameters_schema": [
            {"name": "ip", "type": "String", "required": True, "description": "待查询的 IP 地址"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    ip = kwargs.get('ip') or ''\n"
            "    # 沙箱命名空间已注入 context_tools.get_threat_intel：按 IP 确定性变化的\n"
            "    # mock 情报（种子随机，不同 IP 标签/置信度/恶意软件不同），与告警富化/\n"
            "    # 工单安全上下文同一口径；禁止在此硬编码情报数据，否则所有外网 IP\n"
            "    # 研判结果会雷同\n"
            "    return await get_threat_intel(ip)\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
    {
        "name": "check_subnet",
        "description": "查询 IP 所在子网信息（/24 网段 + 网关地址）",
        "parameters_schema": [
            {"name": "ip", "type": "String", "required": True, "description": "待查询的 IP 地址"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    ip = kwargs.get('ip') or ''\n"
            "    try:\n"
            "        network = ipaddress.ip_network(f'{ip}/24', strict=False)\n"
            "        network_segment = str(network)\n"
            "        gateway = str(network.network_address + 1)\n"
            "    except ValueError:\n"
            "        network_segment = 'unknown'\n"
            "        gateway = 'unknown'\n"
            "    return {\n"
            "        'ip': ip,\n"
            "        'network_segment': network_segment,\n"
            "        'gateway': gateway,\n"
            "    }\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
    {
        "name": "block_ip_on_firewall",
        "description": "在防火墙上下发 IP 封禁规则（幂等：重复封禁同一 IP 不会重复下发）",
        "parameters_schema": [
            {"name": "ip", "type": "String", "required": True, "description": "待封禁的 IP 地址"},
            {"name": "duration", "type": "String", "required": False, "description": "封禁时长（如 24h / 1h），默认 24h"},
            {"name": "reason", "type": "String", "required": False, "description": "封禁原因说明，默认 'auto block by SOAR'"},
        ],
        # 调用 tool_runner 注入的 block_ip_on_firewall（来自 app.devices.firewall）。
        # 沙箱无 __import__，不能在工具代码内 import；函数已注入命名空间，直接调用即可。
        "code": (
            "async def run(**kwargs):\n"
            "    ip = kwargs.get('ip', '')\n"
            "    duration = kwargs.get('duration', '24h')\n"
            "    reason = kwargs.get('reason', 'auto block by SOAR')\n"
            "    return await block_ip_on_firewall(ip, duration, reason)\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
    {
        "name": "read_document",
        "description": (
            "读取用户上传的文件内容（支持 Excel/xlsx、Word/docx、PDF、CSV、TXT、JSON、Markdown）。"
            "用户在对话中上传文件后，可调用此工具按文件名读取文件全部内容。"
            "传入 file_name 参数（用户上传时的原始文件名），返回文件文本或结构化数据。"
        ),
        "parameters_schema": [
            {"name": "file_name", "type": "String", "required": True, "description": "要读取的文件名（用户上传时的原始名，如 报表.xlsx）"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    file_name = kwargs.get('file_name') or ''\n"
            "    if not file_name:\n"
            "        return {'error': '请提供 file_name 参数（要读取的文件名）'}\n"
            "    return read_uploaded_file(file_name)\n"
        ),
        "tool_type": "code",
        "category": "file_operations",
        "enabled": True,
    },
    {
        "name": "read_xlsx",
        "description": (
            "读取用户上传的 Excel 文件（.xlsx/.xls），返回所有工作表的数据。"
            "传入 file_name 参数（用户上传时的原始文件名），返回 {sheets: {sheet_name: [[row], ...]}}。"
        ),
        "parameters_schema": [
            {"name": "file_name", "type": "String", "required": True, "description": "要读取的 Excel 文件名"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    file_name = kwargs.get('file_name') or ''\n"
            "    if not file_name:\n"
            "        return {'error': '请提供 file_name 参数'}\n"
            "    result = read_uploaded_file(file_name)\n"
            "    if 'error' in result:\n"
            "        return result\n"
            "    ft = result.get('file_type', '')\n"
            "    if ft not in ('xlsx', 'xls'):\n"
            "        return {'error': f'文件 {file_name} 不是 Excel 文件（类型: {ft}），请使用 read_docx 或 read_pdf'}\n"
            "    return {'file_name': result['file_name'], 'sheets': result.get('sheets', {})}\n"
        ),
        "tool_type": "code",
        "category": "file_operations",
        "enabled": True,
    },
    {
        "name": "read_docx",
        "description": (
            "读取用户上传的 Word 文档（.docx），返回所有段落文本。"
            "传入 file_name 参数（用户上传时的原始文件名），返回 {paragraphs: [...], content: '...'}。"
        ),
        "parameters_schema": [
            {"name": "file_name", "type": "String", "required": True, "description": "要读取的 Word 文件名"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    file_name = kwargs.get('file_name') or ''\n"
            "    if not file_name:\n"
            "        return {'error': '请提供 file_name 参数'}\n"
            "    result = read_uploaded_file(file_name)\n"
            "    if 'error' in result:\n"
            "        return result\n"
            "    ft = result.get('file_type', '')\n"
            "    if ft != 'docx':\n"
            "        return {'error': f'文件 {file_name} 不是 Word 文档（类型: {ft}）'}\n"
            "    return {'file_name': result['file_name'], 'paragraphs': result.get('paragraphs', []), 'content': result.get('content', '')}\n"
        ),
        "tool_type": "code",
        "category": "file_operations",
        "enabled": True,
    },
    {
        "name": "read_pdf",
        "description": (
            "读取用户上传的 PDF 文件，提取所有页面的文本内容。"
            "传入 file_name 参数（用户上传时的原始文件名），返回 {pages: [...], page_count: N, content: '...'}。"
        ),
        "parameters_schema": [
            {"name": "file_name", "type": "String", "required": True, "description": "要读取的 PDF 文件名"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    file_name = kwargs.get('file_name') or ''\n"
            "    if not file_name:\n"
            "        return {'error': '请提供 file_name 参数'}\n"
            "    result = read_uploaded_file(file_name)\n"
            "    if 'error' in result:\n"
            "        return result\n"
            "    ft = result.get('file_type', '')\n"
            "    if ft != 'pdf':\n"
            "        return {'error': f'文件 {file_name} 不是 PDF 文件（类型: {ft}）'}\n"
            "    return {'file_name': result['file_name'], 'pages': result.get('pages', []), 'page_count': result.get('page_count', 0), 'content': result.get('content', '')}\n"
        ),
        "tool_type": "code",
        "category": "file_operations",
        "enabled": True,
    },
    {
        "name": "save_memory",
        "description": (
            "将一条键值对信息保存到智能体长期记忆中，供后续对话或 recall_memory 工具检索。"
            "适用于记住用户偏好、任务上下文、中间结果等。"
        ),
        "parameters_schema": [
            {"name": "key", "type": "String", "required": True, "description": "记忆键名（如 user_preference_color）"},
            {"name": "value", "type": "String", "required": True, "description": "记忆值（要记住的内容）"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    key = kwargs.get('key') or ''\n"
            "    value = kwargs.get('value') or ''\n"
            "    if not key:\n"
            "        return {'error': '请提供 key 参数'}\n"
            "    return save_agent_memory(key, value)\n"
        ),
        "tool_type": "code",
        "category": "memory",
        "enabled": True,
    },
    {
        "name": "recall_memory",
        "description": (
            "从智能体长期记忆中检索之前保存的信息。传入 key 返回对应的值；"
            "不传 key 时列出所有已保存的记忆键。"
        ),
        "parameters_schema": [
            {"name": "key", "type": "String", "required": False, "description": "要检索的记忆键名（不传则列出所有键）"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    key = kwargs.get('key') or ''\n"
            "    return recall_agent_memory(key)\n"
        ),
        "tool_type": "code",
        "category": "memory",
        "enabled": True,
    },
    {
        "name": "query_banned_ip",
        "description": (
            "查询某个 IP 是否已被封禁，返回其封禁状态、等级、时长、过期时间、违规次数等。"
            "在封禁工作流中应先调用此工具判断是否已封禁，避免重复处置。"
            "数据来自 BannedIP 表（封禁工作台与工单封禁同步写入，前端「已封禁 IP」页面展示）。"
        ),
        "parameters_schema": [
            {"name": "ip", "type": "String", "required": True, "description": "待查询的 IP 地址"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    ip = kwargs.get('ip') or ''\n"
            "    if not ip:\n"
            "        return {'error': '请提供 ip 参数'}\n"
            "    db = SessionLocal()\n"
            "    try:\n"
            "        record = db.query(BannedIP).filter(BannedIP.ip == ip).first()\n"
            "        if record is None:\n"
            "            return {'ip': ip, 'banned': False, 'message': '该 IP 未被封禁'}\n"
            "        # 自动检查是否过期：active 且已过 expired_at 视为 expired\n"
            "        # 北京时间（UTC+8）：数据库内统一存北京时间，与前端显示一致\n"
            "        now = datetime.utcnow() + timedelta(hours=8)\n"
            "        is_active = record.status == 'active' and record.expired_at > now\n"
            "        if record.status == 'active' and record.expired_at <= now:\n"
            "            record.status = 'expired'\n"
            "            db.commit()\n"
            "        return {\n"
            "            'ip': ip,\n"
            "            'banned': is_active,\n"
            "            'ban_level': record.ban_level,\n"
            "            'ban_duration': record.ban_duration,\n"
            "            'expired_at': record.expired_at.isoformat() if record.expired_at else None,\n"
            "            'region': record.region,\n"
            "            'violation_count': record.violation_count,\n"
            "            'reason': record.reason,\n"
            "            'status': record.status,\n"
            "            'created_at': record.created_at.isoformat() if record.created_at else None,\n"
            "        }\n"
            "    finally:\n"
            "        db.close()\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
    {
        "name": "calculate_ban_duration",
        "description": (
            "依据地域（深圳/国内非深圳/境外）与违规次数，按规则矩阵计算封禁等级与时长。"
            "规则：深圳[首次3天/二次7天/三次30天]；国内非深圳[首次7天/二次30天/三次365天]；"
            "境外[首次30天/二次365天/三次永久]。确认为 C2服务器/勒索软件通信/APT攻击时直接永久封禁。"
            "返回等级、时长、是否永久、过期时间，供封禁处置决策使用。"
        ),
        "parameters_schema": [
            {"name": "region", "type": "String", "required": True, "description": "IP 归属地（含'深圳'/'中国'/'境外'等关键字，用于地域分类）"},
            {"name": "violation_count", "type": "Number", "required": True, "description": "历史违规次数（0=首次，1=二次，≥2=三次及以上，来自 query_banned_ip）"},
            {"name": "tags", "type": "Array", "required": False, "description": "威胁情报标签列表（含 C2/勒索/APT 时触发永久封禁）"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    region = (kwargs.get('region') or '').strip()\n"
            "    violation_count = int(kwargs.get('violation_count') or 0)\n"
            "    raw_tags = kwargs.get('tags') or []\n"
            "    tags = [str(t).lower() for t in raw_tags] if isinstance(raw_tags, list) else [str(raw_tags).lower()]\n"
            "    DAY = 86400\n"
            "    # 地域分类：深圳 / 国内（非深圳）/ 境外\n"
            "    if '深圳' in region or 'shenzhen' in region.lower():\n"
            "        area = 'shenzhen'\n"
            "    elif '境外' in region or '海外' in region or '国外' in region or 'foreign' in region.lower() or 'overseas' in region.lower():\n"
            "        area = 'overseas'\n"
            "    elif '中国' in region or '国内' in region or 'china' in region.lower() or '北京' in region or '上海' in region or '广东' in region:\n"
            "        area = 'domestic'\n"
            "    else:\n"
            "        area = 'overseas'  # 无法判断地域时按境外从严\n"
            "    # 违规次数分级：0=首次, 1=二次, >=2=三次及以上\n"
            "    if violation_count <= 0:\n"
            "        offense = 1\n"
            "    elif violation_count == 1:\n"
            "        offense = 2\n"
            "    else:\n"
            "        offense = 3\n"
            "    # 封禁时长矩阵（秒）：[首次, 二次, 三次及以上]\n"
            "    MATRIX = {\n"
            "        'shenzhen': [3 * DAY, 7 * DAY, 30 * DAY],\n"
            "        'domestic': [7 * DAY, 30 * DAY, 365 * DAY],\n"
            "        'overseas': [30 * DAY, 365 * DAY, 0],\n"
            "    }\n"
            "    duration = MATRIX[area][offense - 1]\n"
            "    # 高危标签：C2 / 勒索 / APT → 永久（无论地域）\n"
            "    is_high_risk = any(('c2' in t or 'ransom' in t or 'apt' in t or '勒索' in t) for t in tags)\n"
            "    is_permanent = False\n"
            "    if is_high_risk:\n"
            "        is_permanent = True\n"
            "    elif area == 'overseas' and offense >= 3:\n"
            "        is_permanent = True\n"
            "    if is_permanent:\n"
            "        duration = 0\n"
            "        level = 'serious'\n"
            "        desc = '永久'\n"
            "        expired_at = '9999-12-31T23:59:59'\n"
            "    else:\n"
            "        expired_at = (datetime.utcnow() + timedelta(hours=8, seconds=duration)).isoformat()\n"
            "        if duration <= DAY:\n"
            "            level = 'low'\n"
            "        elif duration <= 7 * DAY:\n"
            "            level = 'medium'\n"
            "        elif duration <= 30 * DAY:\n"
            "            level = 'high'\n"
            "        else:\n"
            "            level = 'serious'\n"
            "        def _humanize(sec):\n"
            "            if sec >= DAY:\n"
            "                return f'{sec // DAY} 天'\n"
            "            if sec >= 3600:\n"
            "                return f'{sec // 3600} 小时'\n"
            "            return f'{sec // 60} 分钟'\n"
            "        desc = _humanize(duration)\n"
            "    return {\n"
            "        'ban_level': level,\n"
            "        'ban_duration': duration,\n"
            "        'is_permanent': is_permanent,\n"
            "        'ban_duration_desc': desc,\n"
            "        'expired_at': expired_at,\n"
            "        'area': area,\n"
            "        'offense': offense,\n"
            "        'violation_count': violation_count,\n"
            "    }\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
    # ===== 资产管理智能体专用工具（category='asset'） =====
    # 依赖沙箱注入：current_agent_id / Asset / SessionLocal / KnowledgeBase / KnowledgeSegment / enabled_kbs
    # 注意：沙箱禁止 import / setattr / getattr，故用直接属性赋值 + SQLAlchemy | 运算符构造 OR 条件
    {
        "name": "discover_new_kbs",
        "description": (
            "发现当前资产智能体已勾选但尚未梳理到资产表的知识库。"
            "用于智能体主动检查是否有新增知识库需要录入资产。"
            "返回 discovered 列表（每个元素含 kb_id/kb_name），count 为新发现的数量。"
        ),
        "parameters_schema": [],
        "code": (
            "async def run(**kwargs):\n"
            "    agent_id = current_agent_id\n"
            "    if not agent_id:\n"
            "        return {'error': '未找到当前智能体上下文（current_agent_id 为空），无法确定资产作用域'}\n"
            "    kb_ids = list(enabled_kbs or [])\n"
            "    if not kb_ids:\n"
            "        return {'discovered': [], 'count': 0, 'message': '当前智能体未勾选任何知识库，请先在智能体配置中勾选知识库'}\n"
            "    db = SessionLocal()\n"
            "    try:\n"
            "        ingested_rows = db.query(Asset.kb_id).filter(\n"
            "            Asset.agent_id == agent_id,\n"
            "            Asset.kb_id.in_(kb_ids),\n"
            "        ).distinct().all()\n"
            "        ingested_kb_ids = set(r[0] for r in ingested_rows)\n"
            "        kbs = db.query(KnowledgeBase).filter(KnowledgeBase.id.in_(kb_ids)).all()\n"
            "        kb_name_map = {kb.id: kb.name for kb in kbs}\n"
            "        new_kbs = []\n"
            "        for kb_id in kb_ids:\n"
            "            if kb_id not in ingested_kb_ids:\n"
            "                new_kbs.append({\n"
            "                    'kb_id': kb_id,\n"
            "                    'kb_name': kb_name_map.get(kb_id, '知识库-' + str(kb_id)),\n"
            "                })\n"
            "        return {\n"
            "            'agent_id': agent_id,\n"
            "            'enabled_kbs': kb_ids,\n"
            "            'ingested_kbs': sorted(ingested_kb_ids),\n"
            "            'discovered': new_kbs,\n"
            "            'count': len(new_kbs),\n"
            "            'message': '发现 ' + str(len(new_kbs)) + ' 个尚未梳理的知识库' if new_kbs else '所有勾选的知识库均已梳理到资产表',\n"
            "        }\n"
            "    except Exception as exc:\n"
            "        return {'error': '发现新知识库失败: ' + str(exc)}\n"
            "    finally:\n"
            "        db.close()\n"
        ),
        "tool_type": "code",
        "category": "asset",
        "enabled": True,
    },
    {
        "name": "fetch_kb_content",
        "description": (
            "拉取指定知识库的分段文本内容，供智能体梳理资产信息。"
            "返回 segments 列表（每个元素含 id/seq/content）。"
            "支持分页：用 limit 控制每批拉取数量（建议 30），用 offset 控制起始位置（从 0 开始）。"
            "当 truncated=true 时表示还有更多分段，需增大 offset 继续拉取。"
            "建议梳理流程：先 discover_new_kbs 发现新知识库，再用本工具分批拉取内容（limit=30），"
            "每批提取资产信息调用 add_asset 录入，然后增大 offset 拉取下一批。"
        ),
        "parameters_schema": [
            {"name": "kb_id", "type": "Number", "required": True, "description": "知识库 ID"},
            {"name": "limit", "type": "Number", "required": False, "description": "每批最多拉取的分段数，建议 30，默认 30，最大 500"},
            {"name": "offset", "type": "Number", "required": False, "description": "分页偏移量（从第几条开始），默认 0。拉取下一批时设为 offset+limit"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    kb_id = kwargs.get('kb_id')\n"
            "    if not kb_id:\n"
            "        return {'error': '请提供 kb_id 参数指定要拉取的知识库'}\n"
            "    kb_id = int(kb_id)\n"
            "    limit = int(kwargs.get('limit') or 30)\n"
            "    if limit < 1:\n"
            "        limit = 1\n"
            "    if limit > 500:\n"
            "        limit = 500\n"
            "    offset = int(kwargs.get('offset') or 0)\n"
            "    if offset < 0:\n"
            "        offset = 0\n"
            "    db = SessionLocal()\n"
            "    try:\n"
            "        kb = db.query(KnowledgeBase).filter(KnowledgeBase.id == kb_id).first()\n"
            "        if not kb:\n"
            "            return {'error': '知识库不存在: ' + str(kb_id)}\n"
            "        query = db.query(KnowledgeSegment).filter(\n"
            "            KnowledgeSegment.kb_id == kb_id\n"
            "        ).order_by(KnowledgeSegment.id)\n"
            "        # 先查总数，供智能体判断是否需要继续翻页\n"
            "        total = query.count()\n"
            "        segs = query.offset(offset).limit(limit).all()\n"
            "        segments = []\n"
            "        for s in segs:\n"
            "            segments.append({\n"
            "                'id': s.id,\n"
            "                'seq': s.seq,\n"
            "                'content': s.content or '',\n"
            "            })\n"
            "        return {\n"
            "            'kb_id': kb_id,\n"
            "            'kb_name': kb.name,\n"
            "            'total_segments': total,\n"
            "            'segment_count': len(segments),\n"
            "            'offset': offset,\n"
            "            'limit': limit,\n"
            "            'has_more': (offset + len(segments)) < total,\n"
            "            'next_offset': offset + len(segments) if (offset + len(segs)) < total else None,\n"
            "            'segments': segments,\n"
            "        }\n"
            "    except Exception as exc:\n"
            "        return {'error': '拉取知识库内容失败: ' + str(exc)}\n"
            "    finally:\n"
            "        db.close()\n"
        ),
        "tool_type": "code",
        "category": "asset",
        "enabled": True,
    },
    {
        "name": "query_asset",
        "description": (
            "查询当前资产智能体资产表中是否已存在某资产。"
            "支持按 identifier（唯一标识）/ ip / name / keyword（模糊匹配 identifier+name+ip+owner）查询。"
            "返回 found/count/assets 列表。用于对话录入资产前判断是新增还是更新。"
        ),
        "parameters_schema": [
            {"name": "identifier", "type": "String", "required": False, "description": "资产唯一标识（精确匹配，如 IP/主机名/工号）"},
            {"name": "ip", "type": "String", "required": False, "description": "按 IP 地址精确匹配"},
            {"name": "name", "type": "String", "required": False, "description": "按资产名称模糊匹配"},
            {"name": "keyword", "type": "String", "required": False, "description": "关键词模糊匹配 identifier/name/ip/owner"},
            {"name": "limit", "type": "Number", "required": False, "description": "返回上限，默认 20，最大 100"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    agent_id = current_agent_id\n"
            "    if not agent_id:\n"
            "        return {'error': '未找到当前智能体上下文'}\n"
            "    identifier = (kwargs.get('identifier') or '').strip()\n"
            "    ip = (kwargs.get('ip') or '').strip()\n"
            "    name = (kwargs.get('name') or '').strip()\n"
            "    keyword = (kwargs.get('keyword') or '').strip()\n"
            "    limit = int(kwargs.get('limit') or 20)\n"
            "    if limit < 1:\n"
            "        limit = 1\n"
            "    if limit > 100:\n"
            "        limit = 100\n"
            "    db = SessionLocal()\n"
            "    try:\n"
            "        q = db.query(Asset).filter(Asset.agent_id == agent_id)\n"
            "        if identifier:\n"
            "            q = q.filter(Asset.identifier == identifier)\n"
            "        elif ip:\n"
            "            q = q.filter(Asset.ip == ip)\n"
            "        elif name:\n"
            "            q = q.filter(Asset.name.like('%' + name + '%'))\n"
            "        elif keyword:\n"
            "            q = q.filter(\n"
            "                Asset.identifier.like('%' + keyword + '%') |\n"
            "                Asset.name.like('%' + keyword + '%') |\n"
            "                Asset.ip.like('%' + keyword + '%') |\n"
            "                Asset.owner.like('%' + keyword + '%')\n"
            "            )\n"
            "        else:\n"
            "            return {'error': '请提供 identifier / ip / name / keyword 之一作为查询条件'}\n"
            "        rows = q.limit(limit).all()\n"
            "        assets = []\n"
            "        for a in rows:\n"
            "            assets.append({\n"
            "                'id': a.id, 'kb_id': a.kb_id, 'kb_name': a.kb_name,\n"
            "                'identifier': a.identifier, 'identifier_type': a.identifier_type,\n"
            "                'name': a.name, 'asset_type': a.asset_type, 'department': a.department,\n"
            "                'owner': a.owner, 'location': a.location, 'ip': a.ip,\n"
            "                'criticality': a.criticality, 'extra_fields': a.extra_fields or {},\n"
            "                'source': a.source, 'raw_content': a.raw_content or '',\n"
            "                'created_at': str(a.created_at) if a.created_at else '',\n"
            "                'updated_at': str(a.updated_at) if a.updated_at else '',\n"
            "            })\n"
            "        return {\n"
            "            'agent_id': agent_id,\n"
            "            'found': len(assets) > 0,\n"
            "            'count': len(assets),\n"
            "            'assets': assets,\n"
            "        }\n"
            "    except Exception as exc:\n"
            "        return {'error': '查询资产失败: ' + str(exc)}\n"
            "    finally:\n"
            "        db.close()\n"
        ),
        "tool_type": "code",
        "category": "asset",
        "enabled": True,
    },
    {
        "name": "add_asset",
        "description": (
            "向当前资产智能体的资产表新增一条资产记录。"
            "若 identifier 已存在则拒绝新增（返回 action=exists），提示改用 update_asset。"
            "extra_fields 接收 JSON 对象，存储知识库中特有但标准字段未覆盖的属性（灵活字段）。"
            "录入来源：对话录入用 source=agent_add，KB 梳理用 source=kb_ingest。"
        ),
        "parameters_schema": [
            {"name": "identifier", "type": "String", "required": True, "description": "资产唯一标识（IP/主机名/工号/资产编号等，由智能体判断）"},
            {"name": "identifier_type", "type": "String", "required": False, "description": "标识类型：ip/hostname/asset_name/employee_id/mac/custom，默认 custom"},
            {"name": "name", "type": "String", "required": False, "description": "资产名称（展示用）"},
            {"name": "asset_type", "type": "String", "required": False, "description": "资产类型：服务器/工作站/网络设备/应用/账号等"},
            {"name": "department", "type": "String", "required": False, "description": "归属部门"},
            {"name": "owner", "type": "String", "required": False, "description": "负责人"},
            {"name": "location", "type": "String", "required": False, "description": "物理位置"},
            {"name": "ip", "type": "String", "required": False, "description": "IP 地址"},
            {"name": "criticality", "type": "String", "required": False, "description": "重要性：low/medium/high/critical，默认 medium"},
            {"name": "kb_id", "type": "Number", "required": False, "description": "来源知识库 ID（对话录入可不传）"},
            {"name": "kb_name", "type": "String", "required": False, "description": "来源知识库名称"},
            {"name": "source", "type": "String", "required": False, "description": "来源：agent_add（对话录入）/ kb_ingest（KB 梳理）/ manual（手动），默认 agent_add"},
            {"name": "raw_content", "type": "String", "required": False, "description": "LLM 提取时的原始 KB 片段（溯源审计）"},
            {"name": "extra_fields", "type": "Object", "required": False, "description": "灵活字段（JSON 对象），存储标准字段未覆盖的属性"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    agent_id = current_agent_id\n"
            "    if not agent_id:\n"
            "        return {'error': '未找到当前智能体上下文'}\n"
            "    identifier = (kwargs.get('identifier') or '').strip()\n"
            "    if not identifier:\n"
            "        return {'error': '请提供 identifier 参数（资产唯一标识，如 IP/主机名/工号/资产编号）'}\n"
            "    identifier_type = (kwargs.get('identifier_type') or 'custom').strip()\n"
            "    extra = kwargs.get('extra_fields')\n"
            "    if not isinstance(extra, dict):\n"
            "        extra = {}\n"
            "    db = SessionLocal()\n"
            "    try:\n"
            "        existing = db.query(Asset).filter(\n"
            "            Asset.agent_id == agent_id,\n"
            "            Asset.identifier == identifier,\n"
            "        ).first()\n"
            "        if existing:\n"
            "            return {\n"
            "                'ok': False,\n"
            "                'action': 'exists',\n"
            "                'message': '资产已存在（identifier=' + identifier + '，id=' + str(existing.id) + '），如需修改请改用 update_asset 工具',\n"
            "                'existing_id': existing.id,\n"
            "            }\n"
            "        record = Asset(\n"
            "            agent_id=agent_id,\n"
            "            identifier=identifier,\n"
            "            identifier_type=identifier_type,\n"
            "            kb_id=int(kwargs.get('kb_id') or 0),\n"
            "            kb_name=(kwargs.get('kb_name') or '').strip(),\n"
            "            name=(kwargs.get('name') or '').strip(),\n"
            "            asset_type=(kwargs.get('asset_type') or '').strip(),\n"
            "            department=(kwargs.get('department') or '').strip(),\n"
            "            owner=(kwargs.get('owner') or '').strip(),\n"
            "            location=(kwargs.get('location') or '').strip(),\n"
            "            ip=(kwargs.get('ip') or '').strip(),\n"
            "            criticality=(kwargs.get('criticality') or 'medium').strip(),\n"
            "            source=(kwargs.get('source') or 'agent_add').strip(),\n"
            "            raw_content=kwargs.get('raw_content') or '',\n"
            "            extra_fields=extra,\n"
            "        )\n"
            "        db.add(record)\n"
            "        db.commit()\n"
            "        db.refresh(record)\n"
            "        return {\n"
            "            'ok': True,\n"
            "            'action': 'created',\n"
            "            'asset_id': record.id,\n"
            "            'identifier': identifier,\n"
            "            'message': '资产已新增: ' + identifier,\n"
            "        }\n"
            "    except Exception as exc:\n"
            "        db.rollback()\n"
            "        return {'error': '新增资产失败: ' + str(exc)}\n"
            "    finally:\n"
            "        db.close()\n"
        ),
        "tool_type": "code",
        "category": "asset",
        "enabled": True,
    },
    {
        "name": "update_asset",
        "description": (
            "更新当前资产智能体资产表中已存在的资产记录（按 identifier 定位）。"
            "若 identifier 不存在则返回 action=not_found，提示改用 add_asset。"
            "extra_fields 传入的键值会与已有 extra_fields 合并（不覆盖整个对象）。"
            "仅更新传入的非空字段，未传字段保持不变。"
        ),
        "parameters_schema": [
            {"name": "identifier", "type": "String", "required": True, "description": "要更新的资产唯一标识（定位记录）"},
            {"name": "name", "type": "String", "required": False, "description": "资产名称"},
            {"name": "asset_type", "type": "String", "required": False, "description": "资产类型"},
            {"name": "department", "type": "String", "required": False, "description": "归属部门"},
            {"name": "owner", "type": "String", "required": False, "description": "负责人"},
            {"name": "location", "type": "String", "required": False, "description": "物理位置"},
            {"name": "ip", "type": "String", "required": False, "description": "IP 地址"},
            {"name": "criticality", "type": "String", "required": False, "description": "重要性：low/medium/high/critical"},
            {"name": "identifier_type", "type": "String", "required": False, "description": "标识类型"},
            {"name": "kb_id", "type": "Number", "required": False, "description": "来源知识库 ID"},
            {"name": "kb_name", "type": "String", "required": False, "description": "来源知识库名称"},
            {"name": "raw_content", "type": "String", "required": False, "description": "原始 KB 片段"},
            {"name": "extra_fields", "type": "Object", "required": False, "description": "灵活字段（JSON 对象），与已有 extra_fields 合并"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    agent_id = current_agent_id\n"
            "    if not agent_id:\n"
            "        return {'error': '未找到当前智能体上下文'}\n"
            "    identifier = (kwargs.get('identifier') or '').strip()\n"
            "    if not identifier:\n"
            "        return {'error': '请提供 identifier 参数定位要更新的资产'}\n"
            "    db = SessionLocal()\n"
            "    try:\n"
            "        record = db.query(Asset).filter(\n"
            "            Asset.agent_id == agent_id,\n"
            "            Asset.identifier == identifier,\n"
            "        ).first()\n"
            "        if not record:\n"
            "            return {\n"
            "                'ok': False,\n"
            "                'action': 'not_found',\n"
            "                'message': '未找到资产（identifier=' + identifier + '），如需新建请改用 add_asset 工具',\n"
            "            }\n"
            "        changed = []\n"
            "        v = kwargs.get('name')\n"
            "        if v is not None and str(v).strip():\n"
            "            record.name = v; changed.append('name')\n"
            "        v = kwargs.get('asset_type')\n"
            "        if v is not None and str(v).strip():\n"
            "            record.asset_type = v; changed.append('asset_type')\n"
            "        v = kwargs.get('department')\n"
            "        if v is not None and str(v).strip():\n"
            "            record.department = v; changed.append('department')\n"
            "        v = kwargs.get('owner')\n"
            "        if v is not None and str(v).strip():\n"
            "            record.owner = v; changed.append('owner')\n"
            "        v = kwargs.get('location')\n"
            "        if v is not None and str(v).strip():\n"
            "            record.location = v; changed.append('location')\n"
            "        v = kwargs.get('ip')\n"
            "        if v is not None and str(v).strip():\n"
            "            record.ip = v; changed.append('ip')\n"
            "        v = kwargs.get('criticality')\n"
            "        if v is not None and str(v).strip():\n"
            "            record.criticality = v; changed.append('criticality')\n"
            "        v = kwargs.get('identifier_type')\n"
            "        if v is not None and str(v).strip():\n"
            "            record.identifier_type = v; changed.append('identifier_type')\n"
            "        v = kwargs.get('kb_name')\n"
            "        if v is not None and str(v).strip():\n"
            "            record.kb_name = v; changed.append('kb_name')\n"
            "        v = kwargs.get('kb_id')\n"
            "        if v is not None and v:\n"
            "            record.kb_id = int(v); changed.append('kb_id')\n"
            "        v = kwargs.get('raw_content')\n"
            "        if v is not None and str(v).strip():\n"
            "            record.raw_content = v; changed.append('raw_content')\n"
            "        extra = kwargs.get('extra_fields')\n"
            "        if extra and isinstance(extra, dict):\n"
            "            cur = dict(record.extra_fields or {})\n"
            "            cur.update(extra)\n"
            "            record.extra_fields = cur\n"
            "            changed.append('extra_fields')\n"
            "        db.commit()\n"
            "        db.refresh(record)\n"
            "        msg = '资产已更新: ' + identifier\n"
            "        if changed:\n"
            "            msg = msg + '（变更字段: ' + ', '.join(changed) + '）'\n"
            "        return {\n"
            "            'ok': True,\n"
            "            'action': 'updated',\n"
            "            'asset_id': record.id,\n"
            "            'identifier': identifier,\n"
            "            'changed_fields': changed,\n"
            "            'message': msg,\n"
            "        }\n"
            "    except Exception as exc:\n"
            "        db.rollback()\n"
            "        return {'error': '更新资产失败: ' + str(exc)}\n"
            "    finally:\n"
            "        db.close()\n"
        ),
        "tool_type": "code",
        "category": "asset",
        "enabled": True,
    },
    {
        "name": "list_assets",
        "description": (
            "列出当前资产智能体的全部资产（分页+筛选）。"
            "支持按 kb_id / asset_type / department / criticality 精确筛选，"
            "以及 keyword 模糊匹配 identifier/name/ip/owner。"
            "返回 total/count/assets 列表，按 id 倒序排列。"
        ),
        "parameters_schema": [
            {"name": "keyword", "type": "String", "required": False, "description": "模糊匹配关键词（identifier/name/ip/owner）"},
            {"name": "kb_id", "type": "Number", "required": False, "description": "按来源知识库筛选"},
            {"name": "asset_type", "type": "String", "required": False, "description": "按资产类型筛选"},
            {"name": "department", "type": "String", "required": False, "description": "按部门筛选"},
            {"name": "criticality", "type": "String", "required": False, "description": "按重要性筛选：low/medium/high/critical"},
            {"name": "page", "type": "Number", "required": False, "description": "页码，默认 1"},
            {"name": "page_size", "type": "Number", "required": False, "description": "每页条数，默认 20，最大 100"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    agent_id = current_agent_id\n"
            "    if not agent_id:\n"
            "        return {'error': '未找到当前智能体上下文'}\n"
            "    keyword = (kwargs.get('keyword') or '').strip()\n"
            "    kb_id = kwargs.get('kb_id')\n"
            "    asset_type = (kwargs.get('asset_type') or '').strip()\n"
            "    department = (kwargs.get('department') or '').strip()\n"
            "    criticality = (kwargs.get('criticality') or '').strip()\n"
            "    page = int(kwargs.get('page') or 1)\n"
            "    if page < 1:\n"
            "        page = 1\n"
            "    page_size = int(kwargs.get('page_size') or 20)\n"
            "    if page_size < 1:\n"
            "        page_size = 1\n"
            "    if page_size > 100:\n"
            "        page_size = 100\n"
            "    db = SessionLocal()\n"
            "    try:\n"
            "        q = db.query(Asset).filter(Asset.agent_id == agent_id)\n"
            "        if kb_id:\n"
            "            q = q.filter(Asset.kb_id == int(kb_id))\n"
            "        if asset_type:\n"
            "            q = q.filter(Asset.asset_type == asset_type)\n"
            "        if department:\n"
            "            q = q.filter(Asset.department == department)\n"
            "        if criticality:\n"
            "            q = q.filter(Asset.criticality == criticality)\n"
            "        if keyword:\n"
            "            like = '%' + keyword + '%'\n"
            "            q = q.filter(\n"
            "                Asset.identifier.like(like) |\n"
            "                Asset.name.like(like) |\n"
            "                Asset.ip.like(like) |\n"
            "                Asset.owner.like(like)\n"
            "            )\n"
            "        total = q.count()\n"
            "        rows = q.order_by(Asset.id.desc()).offset((page - 1) * page_size).limit(page_size).all()\n"
            "        assets = []\n"
            "        for a in rows:\n"
            "            assets.append({\n"
            "                'id': a.id, 'kb_id': a.kb_id, 'kb_name': a.kb_name,\n"
            "                'identifier': a.identifier, 'identifier_type': a.identifier_type,\n"
            "                'name': a.name, 'asset_type': a.asset_type, 'department': a.department,\n"
            "                'owner': a.owner, 'location': a.location, 'ip': a.ip,\n"
            "                'criticality': a.criticality, 'extra_fields': a.extra_fields or {},\n"
            "                'source': a.source, 'raw_content': a.raw_content or '',\n"
            "                'created_at': str(a.created_at) if a.created_at else '',\n"
            "                'updated_at': str(a.updated_at) if a.updated_at else '',\n"
            "            })\n"
            "        return {\n"
            "            'agent_id': agent_id,\n"
            "            'page': page,\n"
            "            'page_size': page_size,\n"
            "            'total': total,\n"
            "            'count': len(assets),\n"
            "            'assets': assets,\n"
            "        }\n"
            "    except Exception as exc:\n"
            "        return {'error': '列出资产失败: ' + str(exc)}\n"
            "    finally:\n"
            "        db.close()\n"
        ),
        "tool_type": "code",
        "category": "asset",
        "enabled": True,
    },
    {
        "name": "expand_risk_detail",
        "description": (
            "模板驱动地解析主机风险 Excel（青藤/盾立方导出）中「风险详情」列的 JSON 内容，"
            "输出表的列定义取自模板 Excel 首个 Sheet 第 1 行的表头；未传模板时回退到技能标准 22 列白名单"
            "（业务组名/IP/内网IP/外网IP/主机名/弱密码应用(仅linux)/弱密码类型/用户名/密码/账号状态/"
            "应用版本号(仅linux)/应用路径(仅linux)/ssh账号登录方式(仅linux,ssh)/密码状态(仅linux,ssh)/"
            "第一次发现该弱密码的时间(仅linux)/绑定ip(仅linux)/绑定端口(仅linux)/进程id(仅linux)/"
            "是否root权限运行/是否对外访问/shell登录性/mysql帐号允许访问的主机(仅linux mysql)）。"
            "映射规则：模板列名为 IP 时取源表该行「IP」列的值；其他列名作为键，从该行"
            "「风险详情」JSON 解析出的 dict 中取同名键的值（JSON 缺键或值 null→空字符串；"
            "JSON 解析失败的行其 JSON 来源列留空但 IP 列仍填充；「风险详情」与「IP」均为空的行跳过）。"
            "文件需先上传到智能体文件库，本工具按文件名读取（不接收文件内容/绝对路径）。"
            "源文件按文件头 8 字节识别真实格式：真 OLE2 旧版 .xls（xlrd 自动读取，无需转换）；"
            ".xls 后缀但 OOXML 内容→从字节流正常加载。模板无效（不存在/打不开/表头为空）→“模板无效：xxx”，不启动解析。"
            "输出样式：全边框、表头加粗居中、行高表头20/数据15、列宽自适应（中文按 2 宽计算，最小 8），Sheet 名 sheet1。"
            "纯本地处理，无任何网络请求。返回 {output_file, rows, columns, template_columns}。"
            "可选参数 save_template：传入文件名时把输出列定义持久化为 JSON 文件（上传库）。"
        ),
        "parameters_schema": [
            {"name": "source_file_path", "type": "String", "required": True, "description": "源 Excel 文件名（已上传到智能体文件库，可用 read_document 列出可用文件）"},
            {"name": "template_file_path", "type": "String", "required": False, "description": "可选：标准模板 Excel 文件名（已上传到智能体文件库），读取其首个 Sheet 第 1 行作为输出列定义；省略时使用技能标准 22 列白名单（业务组名/IP/内网IP/外网IP/主机名/弱密码应用(仅linux)/弱密码类型/用户名/密码/账号状态/应用版本号(仅linux)/应用路径(仅linux)/ssh账号登录方式(仅linux,ssh)/密码状态(仅linux,ssh)/第一次发现该弱密码的时间(仅linux)/绑定ip(仅linux)/绑定端口(仅linux)/进程id(仅linux)/是否root权限运行/是否对外访问/shell登录性/mysql帐号允许访问的主机(仅linux mysql)）"},
            {"name": "output_file_path", "type": "String", "required": False, "description": "输出文件名，省略时默认 <源文件名>_展开.xlsx（自动去重避免覆盖）"},
            {"name": "save_template", "type": "String", "required": False, "description": "可选：传入一个文件名时，把模板的输出列定义持久化为 JSON 文件保存到上传库（供 compare 校验参考）；不传则不保存"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    source = (kwargs.get('source_file_path') or kwargs.get('source_file_name') or '').strip()\n"
            "    template = (kwargs.get('template_file_path') or kwargs.get('template_file_name') or '').strip()\n"
            "    out = (kwargs.get('output_file_path') or kwargs.get('output_file_name') or '').strip()\n"
            "    save_tpl = (kwargs.get('save_template') or '').strip()\n"
            "    if not source:\n"
            "        return {'error': '请提供 source_file_path（上传文件库中源 Excel 的文件名）'}\n"
            "    # 1) 确定输出列定义：传模板则取模板首个 Sheet 第 1 行；未传则用标准 22 列白名单\n"
            "    header = None\n"
            "    if template:\n"
            "        tpl = load_excel_workbook(template)\n"
            "        if not tpl.get('ok'):\n"
            "            return {'error': f\"模板无效：{tpl.get('error')}\"}\n"
            "        tpl_ws = tpl['wb'].worksheets[0]\n"
            "        for row in tpl_ws.iter_rows(values_only=True):\n"
            "            header = [str(c).strip() if c is not None else '' for c in row]\n"
            "            header = [h for h in header if h]\n"
            "            break\n"
            "        if not header:\n"
            "            return {'error': '模板无效：表头为空'}\n"
            "    else:\n"
            "        header = list(DEFAULT_RISK_COLUMNS)\n"
            "    # 2) 加载源文件并定位「风险详情」与「IP」列\n"
            "    loaded = load_excel_workbook(source)\n"
            "    if not loaded.get('ok'):\n"
            "        return loaded\n"
            "    wb = loaded['wb']\n"
            "    target_ws = None\n"
            "    src_ip_col = src_risk_col = -1\n"
            "    for ws in wb.worksheets:\n"
            "        hdr = None\n"
            "        for row in ws.iter_rows(values_only=True):\n"
            "            if any(c is not None for c in row):\n"
            "                hdr = [str(c).strip() if c is not None else '' for c in row]\n"
            "                break\n"
            "        if hdr is None:\n"
            "            continue\n"
            "        ip_i = find_col(hdr, 'IP')\n"
            "        risk_i = find_col(hdr, '风险详情')\n"
            "        if ip_i >= 0 and risk_i >= 0:\n"
            "            target_ws = ws\n"
            "            src_ip_col = ip_i\n"
            "            src_risk_col = risk_i\n"
            "            break\n"
            "    if target_ws is None:\n"
            "        return {'error': '表头不匹配：源文件未找到「风险详情」或「IP」列'}\n"
            "    # 3) 逐行映射：IP 列取源 IP 值；其余列名作为键从风险详情 JSON dict 取值\n"
            "    out_rows = []\n"
            "    first = True\n"
            "    for row in target_ws.iter_rows(values_only=True):\n"
            "        if first:\n"
            "            first = False\n"
            "            continue\n"
            "        ip_val = str(row[src_ip_col]).strip() if src_ip_col < len(row) and row[src_ip_col] is not None else ''\n"
            "        raw = row[src_risk_col] if src_risk_col < len(row) else None\n"
            "        if not ip_val and (raw is None or str(raw).strip() == ''):\n"
            "            continue\n"
            "        detail = {}\n"
            "        if raw:\n"
            "            try:\n"
            "                parsed = json.loads(raw) if isinstance(raw, str) else raw\n"
            "            except Exception:\n"
            "                parsed = None\n"
            "            if isinstance(parsed, list):\n"
            "                detail = parsed[0] if parsed and isinstance(parsed[0], dict) else {}\n"
            "            elif isinstance(parsed, dict):\n"
            "                detail = parsed\n"
            "        row_out = []\n"
            "        for col_name in header:\n"
            "            if col_name == 'IP':\n"
            "                row_out.append(ip_val)\n"
            "            else:\n"
            "                v = detail.get(col_name)\n"
            "                row_out.append('' if v is None else str(v))\n"
            "        out_rows.append(row_out)\n"
            "    # 4) 生成输出：全边框、表头加粗居中、行高 20/15、自适应列宽（中文按 2 宽）\n"
            "    nwb = openpyxl.Workbook()\n"
            "    ws = nwb.active\n"
            "    ws.title = 'sheet1'\n"
            "    ws.append(header)\n"
            "    for r in out_rows:\n"
            "        ws.append(r)\n"
            "    thin = openpyxl.styles.Side(style='thin', color='000000')\n"
            "    border = openpyxl.styles.Border(left=thin, right=thin, top=thin, bottom=thin)\n"
            "    center = openpyxl.styles.Alignment(horizontal='center', vertical='center')\n"
            "    for row in ws.iter_rows(min_row=1, max_row=ws.max_row, min_col=1, max_col=len(header)):\n"
            "        for cell in row:\n"
            "            cell.border = border\n"
            "            if cell.row == 1:\n"
            "                cell.font = openpyxl.styles.Font(bold=True)\n"
            "                cell.alignment = center\n"
            "    ws.row_dimensions[1].height = 20\n"
            "    for r in range(2, ws.max_row + 1):\n"
            "        ws.row_dimensions[r].height = 15\n"
            "    for col_cells in ws.columns:\n"
            "        width = 8\n"
            "        for c in col_cells:\n"
            "            if c.value is None:\n"
            "                continue\n"
            "            s = str(c.value)\n"
            "            w = sum(2 if ord(ch) > 0x2E7F else 1 for ch in s)\n"
            "            if w + 2 > width:\n"
            "                width = w + 2\n"
            "        letter = openpyxl.utils.get_column_letter(col_cells[0].column)\n"
            "        ws.column_dimensions[letter].width = width\n"
            "    if not out:\n"
            "        base = source.rsplit('.', 1)[0] if '.' in source else source\n"
            "        out = base + '_展开.xlsx'\n"
            "    saved = save_workbook_as_agent_file(nwb, out)\n"
            "    if not saved.get('ok'):\n"
            "        return saved\n"
            "    result = {\n"
            "        'output_file': saved['file_name'],\n"
            "        'rows': len(out_rows),\n"
            "        'columns': len(header),\n"
            "        'template_columns': header,\n"
            "    }\n"
            "    if save_tpl:\n"
            "        tfile = save_json_as_agent_file({'template_columns': header}, save_tpl)\n"
            "        if tfile.get('ok'):\n"
            "            result['template_file'] = tfile['file_name']\n"
            "        else:\n"
            "            result['template_save_error'] = tfile.get('error')\n"
            "    return result\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
    {
        "name": "compare_risk_exports",
        "description": (
            "对比两个由 expand_risk_detail 产出的展开表（需先在智能体文件库上传）。"
            "前置校验：两文件表头列集合必须一致（顺序可不同），不一致→“两文件表头不一致，无法对比：新增列 X / 缺少列 Y”，不执行对比。"
            "记录身份 (IP, 用户名, 绑定端口) 按表头名称定位：IP 精确匹配；用户名精确匹配；"
            "绑定端口(仅linux) 模糊匹配（容忍「绑定端口」等变体列名）。任一缺失→“记录身份字段缺失：xxx”。"
            "按记录身份去重后计算新增/减少/保留，rec_id 中 None/空统一归一为空字符串，输出明细以 IP 为第一段。"
            "源表列序变化、模板字段增减不影响对比正确性。返回 {new_count, gone_count, common_count, details}。"
        ),
        "parameters_schema": [
            {"name": "old_file_path", "type": "String", "required": True, "description": "旧批次展开表文件名（expand_risk_detail 的输出文件）"},
            {"name": "new_file_path", "type": "String", "required": True, "description": "新批次展开表文件名（expand_risk_detail 的输出文件）"},
        ],
        "code": (
            "async def run(**kwargs):\n"
            "    old = (kwargs.get('old_file_path') or kwargs.get('old_file_name') or '').strip()\n"
            "    new = (kwargs.get('new_file_path') or kwargs.get('new_file_name') or '').strip()\n"
            "    if not old or not new:\n"
            "        return {'error': '请提供 old_file_path 与 new_file_path（均为 expand_risk_detail 的输出文件）'}\n"
            "    old_loaded = load_excel_workbook(old)\n"
            "    if not old_loaded.get('ok'):\n"
            "        return old_loaded\n"
            "    new_loaded = load_excel_workbook(new)\n"
            "    if not new_loaded.get('ok'):\n"
            "        return new_loaded\n"
            "\n"
            "    def read_header(wb):\n"
            "        ws = wb.worksheets[0] if wb.worksheets else None\n"
            "        if ws is None:\n"
            "            return []\n"
            "        for row in ws.iter_rows(values_only=True):\n"
            "            if any(c is not None for c in row):\n"
            "                return [str(c).strip() if c is not None else '' for c in row]\n"
            "        return []\n"
            "\n"
            "    old_header = read_header(old_loaded['wb'])\n"
            "    new_header = read_header(new_loaded['wb'])\n"
            "    # 1) 表头一致性校验：列集合必须一致（顺序可不同）\n"
            "    old_set = {h for h in old_header if h}\n"
            "    new_set = {h for h in new_header if h}\n"
            "    if old_set != new_set:\n"
            "        added_cols = sorted(new_set - old_set)\n"
            "        missing_cols = sorted(old_set - new_set)\n"
            "        parts = []\n"
            "        if added_cols:\n"
            "            parts.append('新增列 ' + '、'.join(added_cols))\n"
            "        if missing_cols:\n"
            "            parts.append('缺少列 ' + '、'.join(missing_cols))\n"
            "        return {'error': '两文件表头不一致，无法对比：' + '；'.join(parts)}\n"
            "    # 2) 按表头名称定位记录身份字段（以旧文件表头校验；每个文件在 collect 内按自身表头定位）\n"
            "    ip_i = find_col(old_header, 'IP')\n"
            "    user_i = find_col(old_header, '用户名')\n"
            "    port_i = find_col(old_header, '绑定端口(仅linux)')\n"
            "    if port_i < 0:\n"
            "        port_i = find_col(old_header, '绑定端口', fuzzy=True)\n"
            "    missing = []\n"
            "    if ip_i < 0:\n"
            "        missing.append('IP')\n"
            "    if user_i < 0:\n"
            "        missing.append('用户名')\n"
            "    if port_i < 0:\n"
            "        missing.append('绑定端口')\n"
            "    if missing:\n"
            "        return {'error': '记录身份字段缺失：' + '、'.join(missing)}\n"
            "\n"
            "    def rec_id(row, ip_i, user_i, port_i):\n"
            "        # None/空统一归一为空字符串\n"
            "        def norm(v):\n"
            "            return '' if v is None else str(v).strip()\n"
            "        parts = []\n"
            "        for idx in (ip_i, user_i, port_i):\n"
            "            parts.append(norm(row[idx] if idx < len(row) else None))\n"
            "        return '|'.join(parts)\n"
            "\n"
            "    def collect(wb):\n"
            "        # 每个文件按自身表头定位列（列序可不同，索引不得跨文件复用）\n"
            "        ws = wb.worksheets[0] if wb.worksheets else None\n"
            "        if ws is None:\n"
            "            return set()\n"
            "        s = set()\n"
            "        first = True\n"
            "        ip_i = user_i = port_i = -1\n"
            "        for row in ws.iter_rows(values_only=True):\n"
            "            if first:\n"
            "                first = False\n"
            "                if any(c is not None for c in row):\n"
            "                    hdr = [str(c).strip() if c is not None else '' for c in row]\n"
            "                    ip_i = find_col(hdr, 'IP')\n"
            "                    user_i = find_col(hdr, '用户名')\n"
            "                    port_i = find_col(hdr, '绑定端口(仅linux)')\n"
            "                    if port_i < 0:\n"
            "                        port_i = find_col(hdr, '绑定端口', fuzzy=True)\n"
            "                continue\n"
            "            if all(c is None or str(c).strip() == '' for c in row):\n"
            "                continue\n"
            "            s.add(rec_id(list(row), ip_i, user_i, port_i))\n"
            "        return s\n"
            "\n"
            "    old_set_ids = collect(old_loaded['wb'])\n"
            "    new_set_ids = collect(new_loaded['wb'])\n"
            "    common = old_set_ids & new_set_ids\n"
            "    gone = old_set_ids - new_set_ids\n"
            "    added = new_set_ids - old_set_ids\n"
            "    return {\n"
            "        'new_count': len(added),\n"
            "        'gone_count': len(gone),\n"
            "        'common_count': len(common),\n"
            "        'details': {\n"
            "            'added': sorted(list(added)),\n"
            "            'gone': sorted(list(gone)),\n"
            "            'common': sorted(list(common)),\n"
            "        },\n"
            "    }\n"
        ),
        "tool_type": "code",
        "category": "security",
        "enabled": True,
    },
]
