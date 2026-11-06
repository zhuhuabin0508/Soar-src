"""节点执行器集合。

为工作流图中的每种节点类型实现异步执行器，签名统一为::

    async def execute_xxx(node_data, input_data, ctx, log) -> dict

其中 ``log`` 为 ``Callable[[str, str, str], None]``，参数依次为
``(node_id, level, message)``。执行器从 ``node_data`` 读取节点配置，
从 ``input_data`` / ``ctx`` 读取输入，返回输出字典。
"""
import logging
from typing import Any, Callable

from app.devices.firewall import block_ip_on_firewall

logger = logging.getLogger(__name__)

# 日志级别常量
_INFO = "info"
_WARN = "warning"
_ERROR = "error"

# 时长单位 -> 缩写映射（用于 block_ip duration 拼装）
_UNIT_ABBR = {
    "seconds": "s", "second": "s", "sec": "s", "s": "s",
    "minutes": "m", "minute": "m", "min": "m", "m": "m",
    "hours": "h", "hour": "h", "h": "h",
    "days": "d", "day": "d", "d": "d",
}


def _node_id(node_data: dict) -> str:
    """从 node_data 安全取节点 id（由 runner 注入）。"""
    return str(node_data.get("id", "") or node_data.get("node_id", "") or "unknown")


def _run_sync_call(func, *args, **kwargs):
    """在事件循环的默认执行器里运行同步函数，返回其结果。

    供异步节点执行器调用同步 IO 密集逻辑（如设备动作 HTTP 调用），
    避免阻塞事件循环。
    """
    import asyncio

    loop = asyncio.get_event_loop()
    return loop.run_in_executor(None, lambda: func(*args, **kwargs))



def _resolve_variable(ctx: dict, path: str) -> Any:
    """按点号路径从 ctx 取值，如 ``agent_decision.target_ip``。

    支持字典与对象属性。任一段缺失返回 ``None``。
    """
    if not path:
        return None
    current: Any = ctx
    for segment in str(path).split("."):
        if current is None:
            return None
        if isinstance(current, dict):
            current = current.get(segment)
        else:
            current = getattr(current, segment, None)
    return current


def _safe_ctx(ctx: dict) -> dict:
    """返回 ctx 的可序列化浅拷贝（过滤内部字段，转 JSON 安全类型）。"""
    import json

    if not isinstance(ctx, dict):
        return {}
    safe = {k: v for k, v in ctx.items() if not k.startswith("_")}
    try:
        # 用 json.dumps + loads 规范化（剔除不可序列化对象）
        return json.loads(json.dumps(safe, default=str, ensure_ascii=False))
    except Exception:  # noqa: BLE001
        return {k: str(v) for k, v in safe.items()}


def _compare(actual: Any, operator: str, expected: Any) -> bool:
    """按操作符比较 actual 与 expected，返回布尔结果。

    支持 ==,!=,>,<,>=,<=,contains,not_contains,starts_with,ends_with,
    is_empty,is_not_empty。
    """
    if operator == "==":
        return str(actual) == str(expected)
    if operator == "!=":
        return str(actual) != str(expected)
    if operator in (">", "<", ">=", "<="):
        try:
            a = float(actual)
            b = float(expected)
        except (TypeError, ValueError):
            return False
        if operator == ">":
            return a > b
        if operator == "<":
            return a < b
        if operator == ">=":
            return a >= b
        if operator == "<=":
            return a <= b
    if operator == "contains":
        return str(expected) in str(actual) if actual is not None else False
    if operator == "not_contains":
        return str(expected) not in str(actual) if actual is not None else True
    if operator == "starts_with":
        return str(actual).startswith(str(expected)) if actual is not None else False
    if operator == "ends_with":
        return str(actual).endswith(str(expected)) if actual is not None else False
    if operator == "is_empty":
        return actual in (None, "", [], {}, ())
    if operator == "is_not_empty":
        return actual not in (None, "", [], {}, ())
    logger.warning("未知操作符，按 False 处理: %s", operator)
    return False


async def execute_webhook_trigger(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """webhook_trigger：记录收到数据并返回 payload。"""
    nid = _node_id(node_data)
    log(nid, _INFO, f"webhook_trigger 收到数据: {input_data}")
    return {"payload": input_data}


async def execute_http_request(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """http_request：用 httpx 真实发起 HTTP 请求，支持超时与重试。

    node_data 字段：method/url/headers/query/body/auth/timeout/retry。
    """
    nid = _node_id(node_data)
    try:
        import httpx
    except ImportError as exc:  # noqa: BLE001
        log(nid, _ERROR, "httpx 未安装，无法发起 HTTP 请求")
        return {"error": "httpx not installed", "status": None}

    method = (node_data.get("method") or "GET").upper()
    url = node_data.get("url") or ""
    headers = node_data.get("headers") or {}
    query = node_data.get("query") or None
    body = node_data.get("body")
    auth_cfg = node_data.get("auth")
    timeout = node_data.get("timeout") or 10
    retry = int(node_data.get("retry") or 0)

    log(nid, _INFO, f"HTTP {method} -> {url}")

    # 组装 auth
    auth = None
    if auth_cfg and isinstance(auth_cfg, dict):
        if auth_cfg.get("type") == "basic":
            auth = (auth_cfg.get("username", ""), auth_cfg.get("password", ""))
        elif auth_cfg.get("type") == "bearer":
            headers = {**headers, "Authorization": f"Bearer {auth_cfg.get('token', '')}"}

    last_error: str = ""
    for attempt in range(retry + 1):
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                resp = await client.request(
                    method, url, headers=headers, params=query, json=body if body is not None else None, auth=auth
                )
            log(nid, _INFO, f"HTTP 响应 status={resp.status_code}")
            try:
                resp_body = resp.json()
            except Exception:  # noqa: BLE001
                resp_body = resp.text
            return {
                "status": resp.status_code,
                "headers": dict(resp.headers),
                "body": resp_body,
            }
        except Exception as exc:  # noqa: BLE001
            last_error = str(exc)
            log(nid, _WARN, f"HTTP 请求失败(第{attempt + 1}次): {exc}")
            if attempt >= retry:
                break
    log(nid, _ERROR, f"HTTP 请求最终失败: {last_error}")
    return {"error": last_error, "status": None}


async def execute_ai_agent(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """ai_agent：调用**已创建的智能体**进行推理，返回响应。

    工作流的 AI 智能体节点不再在节点内重新配置模型/提示词/工具，而是引用
    「智能体管理」中已创建的 Agent（``agent_id``），复用其完整配置（模型、
    系统提示词、工具、知识库、技能等）。节点仅需配置：
    - ``agent_id``：要调用的智能体 ID
    - ``user_prompt``：输入提示词，支持 ``${node_id.field}`` 引用上游节点输出

    执行流程：
    1. 解析 user_prompt 中的 ``${node.field}`` 变量引用。
    2. 从 DB 加载 Agent。
    3. 经 ``invoke_agent_for_workflow`` 执行（统一 Hermes runtime）。
    4. 返回决策/回复并合并到 ctx。

    无 ``agent_id`` 时使用 ``WORKFLOW_SOC_AGENT_ID``；均未配置则 ``need_human_approval``。
    """
    import json
    import re

    nid = _node_id(node_data)
    agent_id = node_data.get("agent_id")
    user_prompt_template = node_data.get("user_prompt") or ""

    # 变量解析：${node.field} → ctx 中的值
    var_pattern = re.compile(r"\$\{([\w.]+)\}")

    def _render(text: str) -> str:
        if not text:
            return ""
        return var_pattern.sub(
            lambda m: str(_resolve_variable(ctx, m.group(1)) or ""), text
        )

    user_message = _render(user_prompt_template)
    if not user_message:
        if isinstance(input_data, str):
            user_message = input_data
        elif isinstance(input_data, dict):
            user_message = json.dumps(input_data, ensure_ascii=False, default=str)
        else:
            user_message = str(input_data or "")

    from app.config import settings
    from types import SimpleNamespace

    if not agent_id:
        fallback = int(getattr(settings, "WORKFLOW_SOC_AGENT_ID", 0) or 0)
        if fallback > 0:
            agent_id = fallback
            log(
                nid,
                _WARN,
                f"ai_agent 未配置 agent_id，使用 WORKFLOW_SOC_AGENT_ID={fallback}",
            )
        else:
            log(nid, _ERROR, "ai_agent 缺少 agent_id 且未配置 WORKFLOW_SOC_AGENT_ID")
            src_ip = (
                input_data.get("src_ip", "unknown")
                if isinstance(input_data, dict)
                else "unknown"
            )
            return {
                "decision": "need_human_approval",
                "target_ip": src_ip,
                "reason": "未配置 agent_id 或 WORKFLOW_SOC_AGENT_ID",
                "duration": "24h",
                "response": "",
                "messages": [],
            }

    from app.database import LinkageSessionLocal
    from app.models.agent import Agent
    from app.platform.agent_runtime import invoke_agent_for_workflow

    db = LinkageSessionLocal()
    try:
        agent = db.query(Agent).filter(Agent.id == int(agent_id)).first()
        if agent is None:
            log(nid, _ERROR, f"智能体不存在: agent_id={agent_id}")
            return {"response": "", "error": f"Agent {agent_id} not found"}

        log(
            nid,
            _INFO,
            f"调用智能体(runtime): id={agent.id}, name={agent.name}, engine={agent.engine}, msg_len={len(user_message)}",
        )
        wf_input = input_data if isinstance(input_data, dict) else {"input": user_message}
        override = None
        if any(
            node_data.get(k) is not None
            for k in ("system_prompt", "temperature", "max_tokens", "max_iterations", "model")
        ):
            override = SimpleNamespace(
                system_prompt=node_data.get("system_prompt"),
                temperature=node_data.get("temperature"),
                max_tokens=node_data.get("max_tokens"),
                max_iterations=node_data.get("max_iterations"),
                model_name=node_data.get("model"),
            )
        try:
            result = await invoke_agent_for_workflow(
                db,
                agent,
                user_message,
                wf_input,
                channel="workflow_ai_agent",
                session_key=f"wf_node_{nid}_{agent.id}",
                override=override,
            )
        except Exception as exc:  # noqa: BLE001
            log(nid, _ERROR, f"invoke_agent 失败: {exc}")
            return {"response": "", "error": str(exc)}

        ctx["agent_response"] = result.get("response")
        ctx["agent_decision"] = result
        ctx["decision"] = result.get("decision") or result.get("response")
        ctx["agent_messages"] = result.get("messages", [])
        return result
    finally:
        db.close()


async def execute_condition_branch(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """condition_branch：if_else / switch 两种模式，输出 ``_route``。

    _route 值与前端 Handle ID 对齐：
    - switch 模式：命中第 i 个 case → ``br_{i}``；未命中 → ``default``
    - if_else 模式：满足 → ``true``；不满足 → ``false``
    这样 edge.sourceHandle 与 _route 能正确匹配。
    """
    nid = _node_id(node_data)
    mode = node_data.get("mode") or "if_else"

    if mode == "switch":
        cases = node_data.get("cases") or []
        for idx, case in enumerate(cases):
            variable = case.get("variable", "")
            operator = case.get("operator", "==")
            value = case.get("value")
            actual = _resolve_variable(ctx, variable)
            if _compare(actual, operator, value):
                label = case.get("label", f"分支{idx + 1}")
                route = f"br_{idx}"
                log(nid, _INFO, f"switch 命中分支: {label} → {route}")
                ctx["_route"] = route
                return {"_route": route, "_matched_label": label}
        log(nid, _INFO, "switch 未命中任何 case，走 default")
        ctx["_route"] = "default"
        return {"_route": "default"}

    # if_else 模式
    conditions = node_data.get("conditions") or []
    logic = (node_data.get("logic") or "AND").upper()
    results = []
    for cond in conditions:
        variable = cond.get("variable", "")
        operator = cond.get("operator", "==")
        value = cond.get("value")
        actual = _resolve_variable(ctx, variable)
        results.append(_compare(actual, operator, value))
    if logic == "OR":
        satisfied = any(results)
    else:
        satisfied = all(results) if results else False
    route = "true" if satisfied else "false"
    log(nid, _INFO, f"if_else 评估结果={satisfied}, route={route}")
    ctx["_route"] = route
    return {"_route": route, "_satisfied": satisfied}


async def execute_block_ip(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """block_ip：调用防火墙封禁/解封。

    node_data 字段：target_ip/value/unit/reason/action(block|unblock)。
    target_ip 缺省时从 ctx.agent_decision 或 input_data.src_ip 取。
    """
    nid = _node_id(node_data)
    agent_decision = ctx.get("agent_decision") or {}
    target_ip = (
        node_data.get("target_ip")
        or agent_decision.get("target_ip")
        or (input_data or {}).get("src_ip")
        or "unknown"
    )
    reason = node_data.get("reason") or agent_decision.get("reason") or "auto block by SOAR"
    value = node_data.get("value")
    unit = node_data.get("unit") or "h"
    duration = f"{value}{_UNIT_ABBR.get(unit, 'h')}" if value is not None else agent_decision.get("duration", "24h")
    action = (node_data.get("action") or "block").lower()

    if action == "unblock":
        # 当前防火墙 mock 未提供解封能力，记录日志即可
        log(nid, _WARN, f"解封 IP {target_ip}：当前设备未实现解封接口，仅记录")
        return {"status": "logged", "action": "unblock", "ip": target_ip, "reason": reason}

    log(nid, _INFO, f"封禁 IP: {target_ip}, duration={duration}, reason={reason}")
    result = await block_ip_on_firewall(target_ip, duration, reason)
    log(nid, _INFO, f"封禁结果: {result.get('status')}, rule_id={result.get('rule_id')}")
    ctx["block_result"] = result
    return result


async def execute_send_notification(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """send_notification：按 channel 发送通知。

    支持渠道：
    - **email**：通过 SMTP 真实发送邮件。需配置 smtp_host/port/use_ssl/username/
      password（QQ 邮箱填授权码）/from_email/recipients/cc/subject/body。
      subject/body 中的 ``{{变量路径}}`` 会从 ctx 解析后替换。
    - **webhook**：用 httpx POST 到指定 URL（含 auth headers）。
    - **im** / **sms**：记录日志，预留对接企业微信/钉钉/短信网关。

    node_data 字段（email）：smtp_host/smtp_port/use_ssl/smtp_username/smtp_password/
    from_email/recipients/cc/subject/body/charset。
    """
    nid = _node_id(node_data)
    channel = node_data.get("channel") or "email"
    severity = node_data.get("severity") or "info"

    # 变量解析辅助：把 {{a.b.c}} 替换为 ctx 中的值
    def _render(text: str) -> str:
        if not text or not isinstance(text, str):
            return text or ""
        import re
        pattern = re.compile(r"\{\{\s*([\w.]+)\s*\}\}")

        def repl(m):
            return str(_resolve_variable(ctx, m.group(1)) or "")

        return pattern.sub(repl, text)

    subject = _render(node_data.get("subject") or "")
    body = _render(node_data.get("body") or "")

    if channel == "email":
        smtp_host = node_data.get("smtp_host") or ""
        smtp_port = int(node_data.get("smtp_port") or 465)
        use_ssl = node_data.get("use_ssl")
        # use_ssl 可能是 bool 或字符串；兼容前端传 "true"/"false"
        if isinstance(use_ssl, str):
            use_ssl = use_ssl.lower() in ("true", "1", "yes", "on")
        use_ssl = bool(use_ssl) if use_ssl is not None else (smtp_port == 465)
        smtp_username = node_data.get("smtp_username") or ""
        smtp_password = node_data.get("smtp_password") or ""
        from_email = node_data.get("from_email") or smtp_username
        recipients_raw = node_data.get("recipients") or ""
        cc_raw = node_data.get("cc") or ""
        charset = node_data.get("charset") or "utf-8"

        recipients = [r.strip() for r in str(recipients_raw).split(",") if r.strip()]
        cc = [r.strip() for r in str(cc_raw).split(",") if r.strip()]

        if not smtp_host:
            log(nid, _ERROR, "邮件发送失败：未配置 SMTP 服务器")
            return {"sent": False, "error": "SMTP host not configured", "channel": channel}
        if not recipients:
            log(nid, _ERROR, "邮件发送失败：未配置收件人")
            return {"sent": False, "error": "no recipients", "channel": channel}
        if not smtp_username or not smtp_password:
            log(nid, _ERROR, "邮件发送失败：未配置 SMTP 用户名/密码（QQ 邮箱需填授权码）")
            return {"sent": False, "error": "SMTP credentials not configured", "channel": channel}

        log(
            nid,
            _INFO,
            f"发送邮件: host={smtp_host}:{smtp_port}, ssl={use_ssl}, "
            f"from={from_email}, to={recipients}, cc={cc}, subject={subject}",
        )

        try:
            import smtplib
            import ssl
            import socket
            from email.mime.multipart import MIMEMultipart
            from email.mime.text import MIMEText
        except ImportError as exc:  # noqa: BLE001
            log(nid, _ERROR, f"邮件依赖未安装: {exc}")
            return {"sent": False, "error": "smtplib not installed", "channel": channel}

        # 构造 MIME 邮件
        msg = MIMEMultipart("alternative")
        msg["Subject"] = subject
        msg["From"] = from_email
        msg["To"] = ", ".join(recipients)
        if cc:
            msg["Cc"] = ", ".join(cc)
        msg.attach(MIMEText(body, "plain", charset))

        # 同步发送邮件的内部函数（在 thread pool 中执行，避免阻塞事件循环）
        # 改用标准库 smtplib 替代 aiosmtplib，解决 Docker 容器中 TLS 握手
        # 不稳定 / Connection lost 问题（QQ 邮箱 465 端口需 SMTP_SSL 直连）
        # 每一步都记录日志，便于定位「Connection unexpectedly closed」的失败阶段
        def _send_smtp_sync():
            smtp_timeout = 30
            # 注意：不使用 socket.setdefaulttimeout()（全局副作用），仅用连接级 timeout
            context = ssl.create_default_context()
            server = None
            try:
                # 步骤 1：建立连接
                if use_ssl:
                    server = smtplib.SMTP_SSL(
                        smtp_host, smtp_port, timeout=smtp_timeout, context=context
                    )
                else:
                    server = smtplib.SMTP(smtp_host, smtp_port, timeout=smtp_timeout)
                log(nid, _INFO, "SMTP 步骤1: 连接建立成功")

                # 步骤 2：EHLO
                code, _resp = server.ehlo()
                log(nid, _INFO, f"SMTP 步骤2: EHLO 返回码={code}")
                if code != 250:
                    raise RuntimeError(f"EHLO 失败, 返回码={code}")

                # 非 SSL 需升级 STARTTLS
                if not use_ssl:
                    server.starttls(context=context)
                    server.ehlo()
                    log(nid, _INFO, "SMTP 步骤2b: STARTTLS 升级完成")

                # 步骤 3：登录（QQ 邮箱此处最易失败：授权码错误 / SMTP 未开启）
                try:
                    server.login(smtp_username, smtp_password)
                except smtplib.SMTPAuthenticationError as auth_exc:
                    log(nid, _ERROR, f"SMTP 步骤3: 认证失败 {auth_exc}")
                    raise RuntimeError(
                        f"SMTP 认证失败（请检查：1)QQ邮箱设置→账户→开启SMTP服务；"
                        f"2)密码栏填16位授权码而非QQ密码；3)发件人地址与登录账号一致）"
                    ) from auth_exc
                except smtplib.SMTPServerDisconnected as disc_exc:
                    log(nid, _ERROR, f"SMTP 步骤3: 登录时连接被关闭 {disc_exc}")
                    raise RuntimeError(
                        f"SMTP 登录时服务器关闭连接（常见原因：授权码错误、SMTP服务未开启、"
                        f"或账号被临时锁定。请到QQ邮箱→设置→账户→POP3/SMTP服务 确认已开启并使用最新授权码）"
                    ) from disc_exc
                log(nid, _INFO, "SMTP 步骤3: 登录成功")

                # 步骤 4：发送邮件
                server.sendmail(from_email, recipients + cc, msg.as_string())
                log(nid, _INFO, "SMTP 步骤4: 邮件投递成功")
            finally:
                if server:
                    try:
                        server.quit()
                    except Exception:  # noqa: BLE001
                        pass

        try:
            import asyncio
            # 在默认线程池中执行同步 SMTP 调用，避免阻塞 async 工作流执行
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _send_smtp_sync)
            log(nid, _INFO, f"邮件发送成功: {len(recipients)} 收件人")
            return {
                "sent": True,
                "channel": "email",
                "subject": subject,
                "recipients": recipients,
                "cc": cc,
                "severity": severity,
            }
        except Exception as exc:  # noqa: BLE001
            import traceback
            log(nid, _ERROR, f"邮件发送失败: {type(exc).__name__}: {exc}")
            log(nid, _ERROR, f"SMTP 详情: host={smtp_host}:{smtp_port}, tls={use_ssl}, user={smtp_username}")
            log(nid, _ERROR, traceback.format_exc(limit=3))
            return {"sent": False, "error": str(exc), "error_type": type(exc).__name__, "channel": "email"}

    if channel == "webhook":
        url = node_data.get("webhook_url") or ""
        if not url:
            log(nid, _ERROR, "webhook 发送失败：未配置 URL")
            return {"sent": False, "error": "no webhook url", "channel": channel}
        try:
            import httpx
        except ImportError as exc:  # noqa: BLE001
            log(nid, _ERROR, f"httpx 未安装: {exc}")
            return {"sent": False, "error": "httpx not installed", "channel": channel}
        payload = {
            "subject": subject,
            "body": body,
            "severity": severity,
            "context": _safe_ctx(ctx),
        }
        log(nid, _INFO, f"发送 webhook: url={url}, severity={severity}")
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(url, json=payload)
            log(nid, _INFO, f"webhook 响应 status={resp.status_code}")
            return {
                "sent": resp.status_code < 400,
                "channel": "webhook",
                "status": resp.status_code,
                "url": url,
            }
        except Exception as exc:  # noqa: BLE001
            log(nid, _ERROR, f"webhook 发送失败: {exc}")
            return {"sent": False, "error": str(exc), "channel": "webhook"}

    # im / sms 渠道：记录日志，预留对接
    log(nid, _WARN, f"{channel} 渠道尚未对接真实发送，仅记录")
    return {
        "sent": True,
        "channel": channel,
        "subject": subject,
        "body": body,
        "severity": severity,
        "note": f"{channel} 渠道为模拟发送，需对接企业微信/钉钉/短信网关",
    }


async def execute_tool_node(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """tool：执行 DB 工具节点。

    node_data 字段：``tool_name`` (str) 与 ``parameters`` (dict)。
    ``parameters`` 中的值若为 ``"{{path}}"`` 形式则从 ``ctx`` 按点号路径解析变量，
    否则原样传递。查 DB 找到启用工具后调 ``run_tool`` 执行。

    返回 ``{"result": <工具返回>, "error": <错误或 None>, "tool_name": <名>}``。
    """
    # 延迟导入避免循环依赖
    from app.core.tool_runner import run_tool
    from app.database import LinkageSessionLocal
    from app.models.tool import Tool

    nid = _node_id(node_data)
    tool_name = node_data.get("tool_name") or ""
    parameters = dict(node_data.get("parameters") or {})

    # 变量解析：值若为 "{{path}}" 形式则从 ctx 解析
    resolved: dict[str, Any] = {}
    for k, v in parameters.items():
        if isinstance(v, str) and v.startswith("{{") and v.endswith("}}"):
            path = v[2:-2].strip()
            resolved[k] = _resolve_variable(ctx, path)
        else:
            resolved[k] = v

    log(nid, _INFO, f"执行工具节点: tool={tool_name}, params={resolved}")

    db = LinkageSessionLocal()
    try:
        tool = db.query(Tool).filter(Tool.name == tool_name, Tool.enabled.is_(True)).first()
    finally:
        db.close()

    if tool is None:
        log(nid, _ERROR, f"工具未找到或未启用: {tool_name}")
        return {"error": f"工具未找到或未启用: {tool_name}", "tool_name": tool_name}

    result = await run_tool(tool, resolved)
    if "error" in result:
        log(nid, _ERROR, f"工具执行失败: {result['error']}")
        return {"error": result["error"], "tool_name": tool_name}
    log(nid, _INFO, f"工具执行完成: {result.get('result')}")
    return {"result": result.get("result"), "tool_name": tool_name}


async def execute_human_review_node(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """human_review：人工介入节点。

    创建审批工单（Execution 记录，status=waiting_for_approval）到数据库，
    使其出现在工作台的待审批列表中。工作人员可在工作台点击「同意」或「拒绝」。

    同步测试模式下不阻塞等待，仅创建工单并返回工单信息。
    线上 Celery 执行时会通过 Redis brpop 阻塞等待审批结果。

    node_data 字段：``title`` / ``instructions`` / ``description``。
    """
    nid = _node_id(node_data)
    title = node_data.get("title") or node_data.get("label") or "人工审批工单"
    instructions = node_data.get("instructions") or ""

    log(nid, _INFO, f"人工介入节点: title={title}")

    # 创建审批工单到数据库（使工作台可见）
    from datetime import datetime
    from app.core.timezone import beijing_now
    from app.database import LinkageSessionLocal
    from app.models import Execution

    workflow_id = ctx.get("workflow_id")
    execution_id = None
    try:
        db = LinkageSessionLocal()
        execution = Execution(
            workflow_id=workflow_id,
            status="waiting_for_approval",
            result={
                "alert_data": input_data,
                "review_meta": {
                    "title": title,
                    "instructions": instructions,
                    "node_id": nid,
                },
                "context": {k: v for k, v in ctx.items() if k != "_loop_config"} if ctx else None,
            },
            created_at=beijing_now(),
        )
        db.add(execution)
        db.commit()
        db.refresh(execution)
        execution_id = execution.id
        db.close()
        log(nid, _INFO, f"已创建审批工单: execution_id={execution_id}")

        # 产生待审批任务时走通知规则路由派发通知
        try:
            from app.core.notification_dispatch import dispatch_notification

            db2 = LinkageSessionLocal()
            try:
                dispatch_notification(
                    db2,
                    event_type="approval_pending",
                    title=f"待审批：{title}",
                    content=(
                        f"产生新的待审批任务。\n"
                        f"标题：{title}\n"
                        f"执行 ID：{execution_id}\n"
                        f"说明：{instructions or '无'}\n"
                        f"时间：{beijing_now().strftime('%Y-%m-%d %H:%M:%S')}"
                    ),
                    related_type="execution",
                    related_id=execution_id,
                    created_by="system",
                )
                log(nid, _INFO, "approval_pending 通知已派发")
            finally:
                db2.close()
        except Exception as exc:  # noqa: BLE001
            log(nid, _ERROR, f"派发 approval_pending 通知失败: {exc}")
    except Exception as exc:  # noqa: BLE001
        log(nid, _ERROR, f"创建审批工单失败: {exc}")

    return {
        "status": "waiting_for_approval",
        "message": "人工审批节点，等待工作人员处理",
        "title": title,
        "instructions": instructions,
        "execution_id": execution_id,
    }


async def execute_device_action(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """device_action：调用安全设备执行动作。

    根据节点配置的 device_id 和 action_id，查找设备和动作配置，
    实际调用设备 API 执行封禁/解封/隔离等操作。
    """
    nid = _node_id(node_data)
    device_id = node_data.get("device_id")
    action_id = node_data.get("action_id")
    params = node_data.get("params") or {}

    if not device_id or not action_id:
        log(nid, _ERROR, "设备动作节点：未配置设备或动作")
        return {"error": "未配置设备或动作", "output": None}

    from app.database import LinkageSessionLocal
    from app.models.device import Device, DeviceAction
    from app.devices.action_executor import execute_device_action

    db = LinkageSessionLocal()
    try:
        device = db.query(Device).filter(Device.id == device_id).first()
        action = db.query(DeviceAction).filter(DeviceAction.id == action_id, DeviceAction.device_id == device_id).first()

        if not device:
            return {"error": f"设备不存在: id={device_id}", "output": None}
        if not action:
            return {"error": f"动作不存在: id={action_id}", "output": None}

        # 解析变量引用 (${node_id.field} 格式)
        import json
        resolved_params = {}
        for k, v in params.items():
            if isinstance(v, str) and v.startswith("${") and v.endswith("}"):
                # 从 ctx 或 input_data 解析变量
                ref = v[2:-1]  # 去掉 ${ }
                parts = ref.split(".", 1)
                node_ref = parts[0]
                field_path = parts[1] if len(parts) > 1 else "output"
                # 从 ctx 中查找
                if node_ref in ctx:
                    val = ctx[node_ref]
                    for p in field_path.split("."):
                        if isinstance(val, dict):
                            val = val.get(p)
                        elif hasattr(val, p):
                            val = getattr(val, p)
                    resolved_params[k] = val
                else:
                    resolved_params[k] = v  # 保持原值
            else:
                resolved_params[k] = v

        log(nid, _INFO, f"设备动作: device={device.name}, action={action.name}, url={device.api_url}/{action.api_path}, method={action.http_method}")

        # 统一执行引擎（复用 devices/action_executor，含超时/TLS/重试配置与调用日志）
        result = await _run_sync_call(
            execute_device_action,
            device,
            action,
            resolved_params,
            db=db,
            source="workflow",
        )
        try:
            resp_body = result.get("response_body")
        except Exception:
            resp_body = None

        if result.get("success"):
            log(nid, _INFO, f"设备动作成功: status={result.get('status_code')}")
            return {"output": resp_body, "status_code": result.get("status_code"), "success": True}
        else:
            err = result.get("error")
            log(nid, _ERROR, f"设备动作失败: {err}, body={str(resp_body)[:200]}")
            return {"error": err, "output": resp_body,
                    "status_code": result.get("status_code"), "success": False}

    except Exception as exc:  # noqa: BLE001
        import traceback
        log(nid, _ERROR, f"设备动作执行异常: {type(exc).__name__}: {exc}")
        log(nid, _ERROR, traceback.format_exc(limit=3))
        return {"error": str(exc), "output": None, "success": False}
    finally:
        db.close()


async def execute_end_node(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """end：工作流结束节点。

    标记工作流正常结束。``end_type`` 可选 success / failed / cancelled。
    """
    nid = _node_id(node_data)
    end_type = node_data.get("end_type") or "success"
    log(nid, _INFO, f"工作流结束节点: end_type={end_type}")
    return {"status": "ended", "end_type": end_type}


async def execute_code_execute(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """code_execute：执行用户自定义 Python3 代码（进程隔离沙箱）。

    三层防御（渗透测试整改 漏洞2：Python 沙箱逃逸）：
    1. 进程隔离（必须）：用户代码在独立子进程 ``sys.executable -I wrapper`` 中执行，
       子进程 ``env={}``（切断 JWT/数据库/Redis 等凭据泄露路径）、``cwd`` 专用临时目录、
       ``preexec_fn`` 设置 RLIMIT 资源上限并 setuid/setgid 降权到 nobody。
    2. AST 预检（第二层）：执行前 ``ast.parse`` 用户代码，拒绝 dunder 属性访问
       （``__class__.__mro__.__subclasses__`` 逃逸链）与危险内置名引用。
    3. 攻击面收敛：``test_node`` / ``test_run_workflow`` 端点增加权限门槛。

    代码中可用变量：input_data（上游输入）、ctx（工作流上下文）、result（输出变量）。
    """
    nid = _node_id(node_data)
    code = node_data.get("code") or ""
    if not code.strip():
        log(nid, _ERROR, "代码执行节点：未配置代码")
        return {"error": "no code", "output": None}

    log(nid, _INFO, f"代码执行节点启动, 代码长度={len(code)}")

    # ===== 第二层：AST 预检（拒绝危险代码，不执行） =====
    reason = _check_code_forbidden(code)
    if reason:
        log(nid, _ERROR, f"代码被安全策略拒绝: {reason}")
        return {"error": f"代码被安全策略拒绝: {reason}", "output": None}

    import asyncio
    import json
    import os
    import subprocess
    import sys
    import tempfile

    # 序列化输入；ctx 含不可序列化对象时降级为只传 input_data
    payload = {"code": code, "input_data": input_data, "ctx": ctx}
    try:
        json.dumps(payload)
    except (TypeError, ValueError):
        payload = {"code": code, "input_data": input_data, "ctx": {}}
        log(nid, _WARN, "ctx 含不可序列化对象，子进程内仅传入 input_data（ctx 不可用）")

    runner = os.path.join(os.path.dirname(__file__), "safe_code_runner.py")
    timeout = int(node_data.get("timeout") or 30)

    def _preexec() -> None:
        """子进程降权与资源限制（Linux 容器以 root 运行，可降权到 nobody=65534）。"""
        import resource

        def _setrlimit(res, lim):
            try:
                resource.setrlimit(res, lim)
            except (ValueError, OSError):
                pass

        _setrlimit(resource.RLIMIT_CPU, (timeout, timeout))
        _setrlimit(resource.RLIMIT_AS, (512 * 1024 * 1024, 512 * 1024 * 1024))  # 512MB
        _setrlimit(resource.RLIMIT_NPROC, (64, 64))
        _setrlimit(resource.RLIMIT_FSIZE, (0, 0))
        try:
            os.setgid(65534)
            os.setuid(65534)
        except OSError:
            # 父进程非 root 时降权失败不阻断（已是低权运行）
            pass

    def _run() -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-I", runner, inp, out],
            env={},  # 空环境变量：切断宿主机凭据泄露路径
            cwd=tmpdir,  # 专用临时目录作为工作目录
            timeout=timeout,
            capture_output=True,
            # preexec_fn 在多线程父进程下略有不安全，但为满足降权/资源限制要求而使用；
            # subprocess.run 已 fork 子进程后再执行，目标平台为 Linux 容器。
            preexec_fn=_preexec if os.name != "nt" else None,
        )

    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.get_event_loop()

    with tempfile.TemporaryDirectory(prefix="soar-code-") as tmpdir:
        inp = os.path.join(tmpdir, "input.json")
        out = os.path.join(tmpdir, "output.json")
        with open(inp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)

        try:
            proc = await loop.run_in_executor(None, _run)
        except subprocess.TimeoutExpired:
            log(nid, _ERROR, "代码执行超时，已强制终止")
            return {"error": "代码执行超时，已强制终止", "output": None}
        except Exception as exc:  # noqa: BLE001
            log(nid, _ERROR, f"代码执行进程启动失败: {type(exc).__name__}: {exc}")
            return {"error": f"代码执行进程启动失败: {exc}", "output": None}

        # 读取子进程回传的 JSON 结果
        if os.path.exists(out):
            try:
                with open(out, "r", encoding="utf-8") as f:
                    res = json.load(f)
            except (ValueError, json.JSONDecodeError):
                res = {"error": "子进程输出无法解析"}
        else:
            stderr = (proc.stderr or b"").decode("utf-8", "replace")[:500]
            res = {"error": stderr or "代码执行失败（无输出）"}

    if "error" in res:
        log(nid, _ERROR, f"代码执行失败: {res['error']}")
        return {"error": res["error"], "output": None}
    log(nid, _INFO, f"代码执行完成, output={str(res.get('result'))[:200]}")
    return {"output": res.get("result")}


def _check_code_forbidden(code: str):
    """AST 预检用户自定义代码；通过返回 None，拒绝返回原因字符串。

    第二层防御（第一层为子进程隔离）：
    - 拒绝 ``Attribute`` 节点访问 dunder 属性（``__globals__``/``__subclasses__``/
      ``__mro__``/``__class__``/``__builtins__``/``__init__``/``__import__``/``__dict__`` 等，
      即渗透报告中的 ``().__class__.__mro__[1].__subclasses__()`` 逃逸链）；
    - 拒绝 ``Name`` 节点引用 eval/exec/compile/open/getattr/setattr/globals/locals/vars/dir。
    """
    import ast

    forbidden_attrs = {
        "__globals__", "__subclasses__", "__mro__", "__class__", "__builtins__",
        "__init__", "__import__", "__dict__", "__bases__", "__self__", "__closure__",
        "__code__", "__func__", "__getattribute__", "__getattr__", "__setattr__",
        "__delattr__", "__new__", "__reduce__", "__loader__", "__spec__",
    }
    forbidden_names = {
        "eval", "exec", "compile", "open", "getattr", "setattr",
        "globals", "locals", "vars", "dir", "__import__",
    }

    try:
        tree = ast.parse(code, mode="exec")
    except SyntaxError as exc:
        return f"代码语法错误: {exc}"

    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            if node.attr in forbidden_attrs:
                return f"代码包含被禁止的 dunder 属性访问: {node.attr}"
        elif isinstance(node, ast.Name):
            if node.id in forbidden_names:
                return f"代码引用了被禁止的内置名: {node.id}"
    return None


async def execute_loop(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """loop：循环节点。支持两种模式：count（固定次数）和 while（条件循环）。

    循环体不在本节点内执行，而是由 workflow_runner 识别 loop 节点后，
    对其子图重复执行。本节点仅设置循环参数到 ctx 供 runner 使用。
    """
    nid = _node_id(node_data)
    mode = node_data.get("loop_mode") or "count"
    if mode == "count":
        count = int(node_data.get("count") or 1)
        log(nid, _INFO, f"循环节点: count 模式, 次数={count}")
        ctx["_loop_config"] = {"mode": "count", "count": count, "node_id": nid}
        return {"loop_mode": "count", "count": count}
    else:
        # while 模式：条件表达式存储，由 runner 每轮评估
        condition = node_data.get("loop_condition") or ""
        max_iter = int(node_data.get("max_iterations") or 100)
        log(nid, _INFO, f"循环节点: while 模式, condition={condition}, max={max_iter}")
        ctx["_loop_config"] = {"mode": "while", "condition": condition,
                               "max_iterations": max_iter, "node_id": nid}
        return {"loop_mode": "while", "condition": condition, "max_iterations": max_iter}


async def execute_iteration(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """iteration：迭代节点。遍历一个数组/列表，对每个元素执行子流程。

    数据源可以是：上游节点输出、ctx 中的变量、或直接配置的 JSON 数组。
    """
    nid = _node_id(node_data)
    # 解析数据源
    data_source = node_data.get("data_source") or "input"
    if data_source == "input":
        items = input_data if isinstance(input_data, list) else [input_data]
    elif data_source == "ctx":
        var_name = node_data.get("ctx_var") or ""
        items = _resolve_variable(ctx, var_name) or []
    else:  # custom
        import json
        try:
            items = json.loads(node_data.get("custom_data") or "[]")
        except Exception:  # noqa: BLE001
            items = []

    if not isinstance(items, list):
        items = [items]

    log(nid, _INFO, f"迭代节点: 数据源={data_source}, 元素数={len(items)}")
    ctx["_iteration_config"] = {"items": items, "node_id": nid, "index": 0}
    return {"iteration_count": len(items), "items": items}


async def execute_llm(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    """llm：纯大模型文本生成节点（对标 Dify LLM 节点）。

    与 ``ai_agent`` 的区别：不携带工具调用循环，仅做一次模型推理，
    适用于文本摘要 / 翻译 / 分类 / 信息抽取等场景。

    node_data 字段：
    - model_config_id：关联 LLMConfig.id（优先级最高）
    - model：模型名（model_config_id 为空时配合默认配置使用）
    - system_prompt：系统提示词（支持 ${node.field} 变量引用）
    - user_prompt：用户提示词（支持 ${node.field} 变量引用）
    - temperature / max_tokens
    """
    import re

    nid = _node_id(node_data)
    model_config_id = node_data.get("model_config_id")
    system_prompt = node_data.get("system_prompt") or ""
    user_prompt = node_data.get("user_prompt") or ""
    temperature = node_data.get("temperature")
    max_tokens = node_data.get("max_tokens") or 1024

    # 变量解析：把 ${node.field} 替换为 ctx 中的值
    var_pattern = re.compile(r"\$\{([\w.]+)\}")

    def _render(text: str) -> str:
        if not text:
            return ""
        return var_pattern.sub(
            lambda m: str(_resolve_variable(ctx, m.group(1)) or ""), text
        )

    system_prompt = _render(system_prompt)
    user_prompt = _render(user_prompt)

    if not user_prompt:
        log(nid, _WARN, "LLM 节点：user_prompt 为空，跳过执行")
        return {"text": "", "error": "user_prompt is empty"}

    # 加载 LLM 配置
    from app.database import LinkageSessionLocal
    from app.models.llm_config import LLMConfig

    db = LinkageSessionLocal()
    try:
        cfg = None
        if model_config_id:
            cfg = db.query(LLMConfig).filter(LLMConfig.id == int(model_config_id)).first()
        if cfg is None:
            # 回退到默认配置
            cfg = db.query(LLMConfig).filter(LLMConfig.is_default.is_(True)).first()
        if cfg is None:
            log(nid, _ERROR, "LLM 节点：未找到可用的模型配置")
            return {"text": "", "error": "no LLM config available"}
    finally:
        db.close()

    api_key = (cfg.api_key or "").strip()
    if not api_key:
        log(nid, _ERROR, "LLM 节点：API Key 为空")
        return {"text": "", "error": "API key is empty"}

    provider = (cfg.provider or "openai").lower()
    model_name = node_data.get("model") or cfg.model_name or "gpt-3.5-turbo"
    log(nid, _INFO, f"LLM 节点：调用 {provider}/{model_name}")

    try:
        if provider == "anthropic":
            # Anthropic 原生 API
            from langchain_anthropic import ChatAnthropic
            from langchain_core.messages import HumanMessage, SystemMessage

            llm_kwargs = {
                "model": model_name,
                "api_key": api_key,
                "max_tokens": int(max_tokens),
            }
            if temperature is not None:
                llm_kwargs["temperature"] = float(temperature)
            if cfg.base_url:
                llm_kwargs["anthropic_api_url"] = cfg.base_url
            llm = ChatAnthropic(**llm_kwargs)
            msgs = []
            if system_prompt:
                msgs.append(SystemMessage(content=system_prompt))
            msgs.append(HumanMessage(content=user_prompt))
            resp = llm.invoke(msgs)
            text = str(resp.content)
        else:
            # OpenAI 兼容接口
            import httpx

            base = (cfg.base_url or "https://api.openai.com/v1").strip()
            if base.endswith("/chat/completions"):
                url = base
            elif re.search(r"/v\d+$", base):
                url = f"{base}/chat/completions"
            else:
                url = f"{base}/v1/chat/completions"

            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": user_prompt})

            payload = {
                "model": model_name,
                "messages": messages,
                "max_tokens": int(max_tokens),
            }
            if temperature is not None:
                payload["temperature"] = float(temperature)

            headers = {
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            }
            with httpx.Client(timeout=60) as client:
                r = client.post(url, json=payload, headers=headers)
            if r.status_code != 200:
                log(nid, _ERROR, f"LLM 节点：HTTP {r.status_code}: {r.text[:300]}")
                return {"text": "", "error": f"HTTP {r.status_code}: {r.text[:400]}"}
            data = r.json()
            text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    except Exception as exc:  # noqa: BLE001
        log(nid, _ERROR, f"LLM 节点调用失败: {exc}")
        return {"text": "", "error": str(exc)[:500]}

    log(nid, _INFO, f"LLM 节点：生成完成，长度={len(text)}")
    return {"text": text}


_WAIT_MAX_SECONDS = 10


def _text_from_input(input_data: Any) -> str:
    import json

    if isinstance(input_data, str):
        return input_data
    if isinstance(input_data, dict):
        for key in ("text", "user_message", "message", "payload"):
            val = input_data.get(key)
            if isinstance(val, str) and val.strip():
                return val
        return json.dumps(input_data, ensure_ascii=False, default=str)
    return str(input_data or "")


async def execute_manual_trigger(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    nid = _node_id(node_data)
    payload = ctx.get("payload") if isinstance(ctx.get("payload"), dict) else {}
    merged = {**payload, **(input_data if isinstance(input_data, dict) else {"input": input_data})}
    log(nid, _INFO, "manual_trigger 已启动")
    ctx["payload"] = merged
    return {"payload": merged, "trigger": "manual"}


async def execute_schedule_trigger(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    nid = _node_id(node_data)
    cron = node_data.get("cron") or "0 * * * *"
    tz = node_data.get("timezone") or "Asia/Shanghai"
    log(nid, _INFO, f"schedule_trigger 配置 cron={cron}, timezone={tz}（测试运行仅记录，实际调度由平台触发）")
    return {"trigger": "schedule", "cron": cron, "timezone": tz, "payload": ctx.get("payload") or {}}


async def execute_event_trigger(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    nid = _node_id(node_data)
    source = node_data.get("event_source") or "alert"
    event_type = node_data.get("event_type") or "*"
    log(nid, _INFO, f"event_trigger source={source}, type={event_type}")
    return {
        "trigger": "event",
        "event_source": source,
        "event_type": event_type,
        "payload": ctx.get("payload") or input_data,
    }


async def execute_wait(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    import asyncio
    from datetime import datetime

    nid = _node_id(node_data)
    mode = node_data.get("wait_mode") or "duration"
    slept = 0.0
    if mode == "until":
        until_raw = node_data.get("until_time") or ""
        try:
            target = datetime.fromisoformat(str(until_raw).replace("Z", "+00:00"))
            delta = (target - datetime.now(target.tzinfo)).total_seconds()
            slept = float(max(0.0, min(delta, _WAIT_MAX_SECONDS)))
        except (TypeError, ValueError):
            log(nid, _WARN, f"wait until 时间无效: {until_raw!r}，跳过等待")
            slept = 0.0
    else:
        try:
            duration = float(node_data.get("duration") or 0)
        except (TypeError, ValueError):
            duration = 0.0
        slept = min(max(duration, 0.0), float(_WAIT_MAX_SECONDS))
    if slept > 0:
        log(nid, _INFO, f"wait 暂停 {slept:.1f}s（测试运行上限 {_WAIT_MAX_SECONDS}s）")
        await asyncio.sleep(slept)
    return {"wait_mode": mode, "slept_seconds": slept}


async def execute_parallel(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    nid = _node_id(node_data)
    branches = int(node_data.get("branches") or 2)
    wait_all = bool(node_data.get("wait_all", True))
    log(
        nid,
        _INFO,
        f"parallel 节点: branches={branches}, wait_all={wait_all}（线性执行器将依次遍历所有出边）",
    )
    return {"branches": branches, "wait_all": wait_all, "input": input_data}


async def execute_sub_workflow(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    import json

    from app.core.workflow_runner import run_workflow
    from app.database import LinkageSessionLocal
    from app.models.workflow import Workflow

    nid = _node_id(node_data)
    sub_id = node_data.get("sub_workflow_id")
    if not sub_id:
        log(nid, _WARN, "sub_workflow 未配置 sub_workflow_id")
        return {"error": "sub_workflow_id is required"}

    depth = int(ctx.get("_sub_workflow_depth") or 0)
    if depth >= 3:
        log(nid, _ERROR, "子流程嵌套超过 3 层，中止")
        return {"error": "sub_workflow nesting limit exceeded"}

    mapping = node_data.get("input_mapping") or {}
    sub_payload: dict[str, Any] = {}
    if isinstance(mapping, dict):
        for key, expr in mapping.items():
            if isinstance(expr, str) and expr.strip():
                sub_payload[key] = _resolve_variable(ctx, expr.strip()) or expr
            else:
                sub_payload[key] = expr
    else:
        sub_payload = dict(input_data) if isinstance(input_data, dict) else {"input": input_data}

    db = LinkageSessionLocal()
    try:
        wf = db.query(Workflow).filter(Workflow.id == int(sub_id)).first()
        if wf is None:
            log(nid, _ERROR, f"子流程不存在: id={sub_id}")
            return {"error": f"workflow {sub_id} not found"}
        graph_config = wf.graph_config
        if isinstance(graph_config, str):
            graph_config = json.loads(graph_config)
    finally:
        db.close()

    if not isinstance(graph_config, dict):
        log(nid, _ERROR, "子流程 graph_config 无效")
        return {"error": "invalid sub workflow graph_config"}

    log(nid, _INFO, f"sub_workflow 开始执行 workflow_id={sub_id}")
    result = await run_workflow(
        graph_config,
        sub_payload,
        trigger_type="sub_workflow",
        workflow_id=sub_id,
        execution_id=ctx.get("execution_id"),
        sub_workflow_depth=depth + 1,
    )
    status = result.get("status")
    log(nid, _INFO, f"sub_workflow 结束 status={status}")
    return {
        "sub_workflow_id": sub_id,
        "status": status,
        "ctx": result.get("ctx"),
        "traces": result.get("traces"),
    }


async def execute_intent_recognition(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    nid = _node_id(node_data)
    intents = node_data.get("intents") or []
    fallback = str(node_data.get("fallback_intent") or "unknown")
    text = _text_from_input(input_data)
    if not text.strip() and isinstance(ctx.get("payload"), dict):
        text = _text_from_input(ctx["payload"])

    matched = fallback
    lowered = text.lower()
    for item in intents:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        desc = str(item.get("description") or "").strip()
        if name and name.lower() in lowered:
            matched = name
            break
        if desc and desc.lower() in lowered:
            matched = name or desc
            break

    log(nid, _INFO, f"intent_recognition 命中意图: {matched}")
    ctx["_route"] = matched
    return {"intent": matched, "text": text, "_route": matched}


async def execute_json_parse(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    import json

    nid = _node_id(node_data)
    raw = node_data.get("source") or ""
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped.startswith("${") and stripped.endswith("}"):
            raw = _resolve_variable(ctx, stripped[2:-1])
        elif stripped:
            from_ctx = _resolve_variable(ctx, stripped)
            if from_ctx is not None:
                raw = from_ctx
    if raw is None or raw == "":
        if isinstance(input_data, dict):
            raw = input_data.get("body") or input_data.get("text") or input_data
        else:
            raw = input_data

    if isinstance(raw, (dict, list)):
        parsed = raw
    else:
        try:
            parsed = json.loads(str(raw))
        except (TypeError, json.JSONDecodeError) as exc:
            log(nid, _ERROR, f"json_parse 失败: {exc}")
            return {"error": str(exc)}

    extracted: dict[str, Any] = {}
    for field in node_data.get("extract_fields") or []:
        if not isinstance(field, dict):
            continue
        path = str(field.get("path") or "").strip()
        alias = str(field.get("alias") or path or "value").strip()
        if not path:
            continue
        cur: Any = parsed
        for seg in path.split("."):
            if isinstance(cur, dict):
                cur = cur.get(seg)
            elif isinstance(cur, list) and seg.isdigit():
                idx = int(seg)
                cur = cur[idx] if 0 <= idx < len(cur) else None
            else:
                cur = None
                break
        extracted[alias] = cur

    log(nid, _INFO, f"json_parse 完成，提取 {len(extracted)} 个字段")
    return {"parsed": parsed, "extracted": extracted, **extracted}


async def execute_variable_assign(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    nid = _node_id(node_data)
    variables = ctx.get("variables")
    if not isinstance(variables, dict):
        variables = {}
        ctx["variables"] = variables

    applied: dict[str, Any] = {}
    for item in node_data.get("assignments") or []:
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        value = item.get("value")
        if isinstance(value, str) and value.strip().startswith("${") and value.strip().endswith("}"):
            path = value.strip()[2:-1]
            value = _resolve_variable(ctx, path)
        variables[name] = value
        applied[name] = value

    log(nid, _INFO, f"variable_assign 写入 {len(applied)} 个变量")
    return {"assignments": applied, "variables": dict(variables)}


async def execute_ticket_create(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    import uuid

    nid = _node_id(node_data)
    title = node_data.get("title") or node_data.get("label") or "工单"
    ticket_id = str(uuid.uuid4())
    log(nid, _INFO, f"ticket_create 已创建占位工单 ticket_id={ticket_id}")
    return {
        "ticket_id": ticket_id,
        "title": title,
        "priority": node_data.get("priority") or "normal",
        "assignee": node_data.get("assignee") or "",
        "description": node_data.get("description_content") or "",
        "status": "open",
    }


async def execute_annotation(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    return {"skipped": True, "node_kind": "annotation"}


async def execute_group(
    node_data: dict, input_data: dict, ctx: dict, log: Callable[[str, str, str], None]
) -> dict:
    return {"skipped": True, "node_kind": "group"}


# 节点类型 -> 执行器映射表，供 workflow_runner 查找
NODE_EXECUTORS: dict[str, Callable] = {
    "webhook_trigger": execute_webhook_trigger,
    "manual_trigger": execute_manual_trigger,
    "schedule_trigger": execute_schedule_trigger,
    "event_trigger": execute_event_trigger,
    "wait": execute_wait,
    "parallel": execute_parallel,
    "sub_workflow": execute_sub_workflow,
    "intent_recognition": execute_intent_recognition,
    "json_parse": execute_json_parse,
    "variable_assign": execute_variable_assign,
    "ticket_create": execute_ticket_create,
    "annotation": execute_annotation,
    "group": execute_group,
    "http_request": execute_http_request,
    "ai_agent": execute_ai_agent,
    "llm": execute_llm,
    "condition_branch": execute_condition_branch,
    "block_ip": execute_block_ip,
    "send_notification": execute_send_notification,
    "tool": execute_tool_node,
    "human_review": execute_human_review_node,
    "device_action": execute_device_action,
    "end": execute_end_node,
    "code_execute": execute_code_execute,
    "loop": execute_loop,
    "iteration": execute_iteration,
}


async def execute_node(
    node_type: str,
    node_data: dict,
    input_data: dict,
    ctx: dict,
    log: Callable[[str, str, str], None],
) -> dict:
    """根据节点类型分发到对应执行器；未知类型透传返回。"""
    executor = NODE_EXECUTORS.get(node_type)
    if executor is None:
        nid = _node_id(node_data)
        log(nid, _INFO, f"未知节点类型 {node_type}，透传执行")
        return {"executed": True, "node_type": node_type}
    return await executor(node_data, input_data, ctx, log)
