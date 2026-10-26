"""RawPreprocessor：原始报文 → 解析管道可消费 payload 的插件链。

``parse_qingteng_syslog`` / ``_coerce_payload`` 函数体自原
log_receiver_manager.py **原样迁入**（行为逐字节等价），并包装为注册表
驱动的预处理器插件：默认链 json → qingteng_syslog → plain_message，
与原 ``_coerce_payload`` 的优先级完全一致；新增厂商预处理只需注册新
插件并在渠道 adapter_config.pipeline.preprocessors 中启用，无需改代码。
"""
import hashlib
import json
import logging
import re
from typing import Any, Optional

from app.core.timezone import beijing_now

from ..registry import preprocessor_registry

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# syslog 文本 key="value" → dict 预处理器
# （青藤万相 Syslog 手册报文为「空格分隔的 key="value"」文本，非 JSON）
# ----------------------------------------------------------------------
def _unescape_qt_value(value: str) -> str:
    """还原 syslog 属性值转义：\\" → "、\\\\ → \\、\\b、\\n、\\t、\\f、\\r。"""
    if "\\" not in value:
        return value
    out = []
    i = 0
    n = len(value)
    while i < n:
        c = value[i]
        if c == "\\" and i + 1 < n:
            nxt = value[i + 1]
            mapping = {
                '"': '"', "\\": "\\", "b": "\b", "n": "\n", "t": "\t", "f": "\f", "r": "\r",
            }
            if nxt in mapping:
                out.append(mapping[nxt])
                i += 2
                continue
        out.append(c)
        i += 1
    return "".join(out)


def parse_qingteng_syslog(text: str) -> Optional[dict]:
    """把青藤万相 syslog 文本（``<HEADER><TAG>key1="v1" key2="v2"...``）解析为 dict。

    仅当内容体含 ``datatype=`` 键且为非空值，且包含 ``datatime=`` 才判定为
    青藤日志并解析（结构判定，不依赖 datatype 值枚举；避免误匹配其他厂牌 syslog）。解析结果：
    - 顶层 ``key="value"`` 平坦化为 dict；
    - ``detail.xxx`` 前缀字段平坦化为 ``detail_xxx``（便于策略 field_mappings 直接取用）；
    - 数组值（``x\\,y``）还原为 JSON 数组字符串（``["x","y"]``）；
    - 派生 ``event_uuid``（sha256(agent_id|datatype|datatime) 前 40 位）与
      ``__source="qingteng_syslog"``（供策略路由）、``datatime_raw`` 原始时间。

    Args:
        text: 完整 syslog 报文字符串。

    Returns:
        结构化 dict；若不能识别为青藤日志返回 None。
    """
    text = (text or "").strip()
    if not text:
        return None

    # 定位内容体：找到第一个 datatype= 键值对（content 之外的 HEADER/TAG 不含该键）
    marker = "datatype="
    idx = text.find(marker)
    if idx < 0:
        return None
    content = text[idx:]

    # 解析 key="value" 序列（值可能含空格，用引号闭合边界切分）
    pairs = re.findall(r'([A-Za-z0-9_\.\-]+)="((?:[^"\\]|\\.)*)"', content)
    if not pairs:
        return None
    fields: dict[str, Any] = {}
    for key, raw_val in pairs:
        # 数组值（\, 分隔）还原为 JSON 数组字符串：先按转义分隔符切分再逐项还原，
        # 避免分隔符的转义反斜杠残留在数组项里（10.0.0.1\ → 10.0.0.1）
        if "\\," in raw_val:
            items = [
                _unescape_qt_value(x.strip())
                for x in raw_val.split("\\,")
                if x.strip()
            ]
            fields[key] = json.dumps(items, ensure_ascii=False)
        else:
            fields[key] = _unescape_qt_value(raw_val)

    # 结构判定：含 datatype= 与 datatime=（青藤所有告警/功能类共用的外层标记），
    # 不依赖 datatype 值枚举，青藤新增日志类型亦自动支持。
    if not fields.get("datatype", "").strip():
        return None
    # 事件时间缺失则无有效数据，跳过
    if not fields.get("datatime"):
        return None

    # detail.* → detail_xxx（平坦化，便于策略字段映射）
    detail: dict[str, Any] = fields.pop("detail", None) if isinstance(fields.get("detail"), dict) else {}
    flat: dict[str, Any] = {}
    for k, v in fields.items():
        if k.startswith("detail."):
            flat["detail_" + k[len("detail."):]] = v
        else:
            flat[k] = v
    flat.update(detail)

    # 青藤 severity（0信息/1低危/2中危/3高危/4危急）翻译为系统 risk_level 编号
    # （系统口径 0严重/1高危/2中危/3低危/4信息），避免"信息"被当成"严重"计入高危及以上。
    _QT_SEV_TO_RISK = {"0": 4, "1": 3, "2": 2, "3": 1, "4": 0}
    sev = flat.get("severity")
    if sev is None or str(sev).strip() == "":
        # 部分日志类型（如 web_command）不带 severity，仅有文本 event_level
        # （info/low/medium/high/critical，青藤口径 0信息/1低危/2中危/3高危/4危急）
        # → 先推导为 severity 再统一翻译；未知文本保持缺失（策略侧回退"未知"等级）
        _QT_LEVEL_TEXT_TO_SEV = {"info": "0", "low": "1", "medium": "2", "high": "3", "critical": "4"}
        sev = _QT_LEVEL_TEXT_TO_SEV.get(str(flat.get("event_level") or "").strip().lower())
    if sev is not None:
        try:
            flat["severity"] = _QT_SEV_TO_RISK.get(str(int(float(str(sev)))), str(sev))
        except (ValueError, TypeError):
            pass

    # 派生去重 uuid 与来源标记
    uid = hashlib.sha256(
        f"{flat.get('agent_id', '')}|{flat.get('datatype', '')}|{flat.get('datatime', '')}"
        .encode("utf-8", errors="replace")
    ).hexdigest()[:40]
    flat["event_uuid"] = uid
    flat["datatime_raw"] = flat.get("datatime", "")
    flat["__source"] = "qingteng_syslog"
    flat["__qt_recv_at"] = beijing_now().strftime("%Y-%m-%d %H:%M:%S")
    return flat


def _coerce_payload(raw: str):
    """把原始报文规整为解析管道可消费的 payload（list 或 dict）。

    优先级：JSON（list/dict）→ 青藤 syslog 文本 → 纯文本兜底包装。
    """
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, (list, dict)):
            return parsed
    except (ValueError, TypeError):
        pass
    qt = parse_qingteng_syslog(raw)
    if qt:
        return qt
    return {"message": raw, "raw": raw}


# ----------------------------------------------------------------------
# 预处理器插件（注册表驱动；默认链 = _coerce_payload 的优先级）
# ----------------------------------------------------------------------
def _preprocess_json(raw: str):
    """JSON 预处理器：成功解析为 list/dict 时返回，否则返回 None 交给下一个。"""
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, (list, dict)):
            return parsed
    except (ValueError, TypeError):
        pass
    return None


_preprocess_json.name = "json"


def _preprocess_plain_message(raw: str) -> dict:
    """纯文本兜底：包装为 {"message", "raw"} 交由策略匹配。"""
    return {"message": raw, "raw": raw}


_preprocess_plain_message.name = "plain_message"


# 青藤预处理器（复用上面的解析函数）
parse_qingteng_syslog.name = "qingteng_syslog"


def run_preprocessor_chain(chain: list[str], raw: str):
    """按注册表顺序执行预处理器链，首个非 None 结果生效。

    默认链 ["json", "qingteng_syslog", "plain_message"] 与原
    ``_coerce_payload`` 行为逐字节等价。
    """
    payload = None
    for name in chain or []:
        func = preprocessor_registry.get_callable(name)
        if func is None:
            logger.warning("预处理器未注册，已跳过: %s", name)
            continue
        try:
            payload = func(raw)
        except Exception:  # noqa: BLE001
            logger.exception("预处理器 %s 执行异常（跳过）", name)
            payload = None
        if payload is not None:
            break
    return payload


# 注册内置预处理器
preprocessor_registry.register(_preprocess_json)
preprocessor_registry.register(parse_qingteng_syslog)
preprocessor_registry.register(_preprocess_plain_message)

# 默认预处理器链（与 _coerce_payload 优先级一致）
DEFAULT_PREPROCESSOR_CHAIN = ["json", "qingteng_syslog", "plain_message"]
