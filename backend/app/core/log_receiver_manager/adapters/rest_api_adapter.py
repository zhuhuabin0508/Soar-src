"""REST API 拉取输入适配器（httpx 轮询 + 分页 + 游标水位）。

按配置周期轮询远端接口，records_path（点路径）提取记录列表，逐条
publish；cursor 分页模式的下一页游标持久化到 adapter_config（_cursor），
重启后从上次位置继续拉取（不重拉）。

状态机：connecting → running / failed；publish 失败不推进游标，下轮重拉
该批（拉取类采集不丢数据）。
"""
import logging
from typing import Any

from ..base_adapter import BaseAdapter
from ..registry import adapter_registry
from ._polling import CursorStore

logger = logging.getLogger(__name__)

# 分页安全上限：单轮最多翻多少页（防接口异常导致死循环）
_MAX_PAGES_PER_POLL = 1000


def _dig(obj: Any, path: str) -> Any:
    """按点路径取嵌套字段（records_path/cursor_path），任一级缺失返回 None。"""
    if not path:
        return obj
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def _record_to_text(rec: Any) -> str | None:
    """记录 → 事件文本：dict 转 JSON 字符串，标量转字符串。"""
    import json

    if rec is None:
        return None
    if isinstance(rec, str):
        return rec
    try:
        return json.dumps(rec, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        return str(rec)


@adapter_registry.register
class RestApiAdapter(BaseAdapter):
    """REST API 轮询拉取适配器。"""

    source_type = "rest_api"
    display_name = "REST API 拉取"
    default_ready_timeout_s = 8.0  # 首次请求需要网络往返
    required_config_keys = [("base_url", "接口基础地址")]

    def run(self) -> None:
        receiver = self.ctx.receiver or {}
        cfg = receiver.get("adapter_config") or {}
        base_url = (cfg.get("base_url") or "").strip()
        if not base_url:
            self.ctx.mark_start_failed("未配置接口基础地址（adapter_config.base_url）")
            self.ctx.signal_ready(False, "未配置接口基础地址")
            return

        try:
            import httpx  # noqa: F401
        except Exception as exc:  # noqa: BLE001
            msg = f"未安装 httpx 依赖: {exc}"
            self.ctx.mark_start_failed(msg)
            self.ctx.signal_ready(False, msg)
            return

        self._cursor = CursorStore(self.ctx)
        self.ctx.signal_ready(True)
        self.ctx.set_status("running", None)
        logger.info(
            "rest_api 拉取已启动: %s (receiver=%s gen=%s)",
            base_url, self.ctx.receiver_id, self.ctx.generation,
        )

        while not self.ctx.stop_event.is_set():
            try:
                self._poll_once(cfg)
            except Exception as exc:  # noqa: BLE001
                logger.exception("rest_api 轮询异常（忽略本轮）: %s", exc)
            interval = max(1.0, float(cfg.get("poll_interval_seconds") or 30))
            self.ctx.stop_event.wait(interval)

    # ------------------------------------------------------------------
    # 单轮拉取（含分页推进）
    # ------------------------------------------------------------------
    def _poll_once(self, cfg: dict) -> None:
        import httpx

        base_url = (cfg.get("base_url") or "").strip().rstrip("/")
        path = (cfg.get("path") or "").strip().lstrip("/")
        url = f"{base_url}/{path}" if path else base_url
        method = (cfg.get("method") or "GET").upper()
        headers = dict(cfg.get("headers") or {})
        params = dict(cfg.get("params") or {})
        records_path = cfg.get("records_path") or ""
        pagination = (cfg.get("pagination") or "none").lower()
        cursor_path = cfg.get("cursor_path") or ""
        timeout = float(cfg.get("timeout") or 15)
        verify_tls = bool(cfg.get("verify_tls", False))

        # auth 处理（none/api_key/basic/bearer）
        auth_cfg = cfg.get("auth") or {}
        auth = None
        auth_kind = (auth_cfg.get("type") or "none").lower()
        if auth_kind == "basic":
            auth = (auth_cfg.get("username") or "", auth_cfg.get("password") or "")
        elif auth_kind == "bearer":
            token = auth_cfg.get("token") or ""
            if token:
                headers.setdefault("Authorization", f"Bearer {token}")
        elif auth_kind == "api_key":
            key = auth_cfg.get("key") or "X-API-Key"
            val = auth_cfg.get("value") or ""
            if val:
                headers[key] = val

        body_template = cfg.get("body_template")
        cursor_value = self._cursor.load()

        page = 1
        pages = 0
        while pages < _MAX_PAGES_PER_POLL:
            pages += 1
            req_params = dict(params)
            if pagination == "page":
                req_params.setdefault("page", page)
                req_params.setdefault("page_size", 100)
            elif pagination == "cursor" and cursor_value:
                req_params.setdefault("cursor", cursor_value)

            body = None
            if method in ("POST", "PUT", "PATCH") and body_template:
                import json

                body = json.dumps(body_template, ensure_ascii=False, default=str)
                headers.setdefault("Content-Type", "application/json")

            # 设备/日志源对接走本机网络直连，忽略代理环境变量
            with httpx.Client(timeout=timeout, verify=verify_tls, trust_env=False) as client:
                resp = client.request(method, url, headers=headers, params=req_params, auth=auth, content=body)
            if resp.status_code >= 400:
                raise RuntimeError(f"接口返回 HTTP {resp.status_code}: {resp.text[:200]}")
            try:
                data = resp.json()
            except Exception as exc:  # noqa: BLE001
                raise RuntimeError(f"接口响应非 JSON: {exc}") from exc

            records = _dig(data, records_path)
            if records is None:
                records = []
            if not isinstance(records, list):
                records = [records]

            for rec in records:
                text = _record_to_text(rec)
                if not text:
                    continue
                ok = self.ctx.publish(text, source_ip=None, blocking=True, timeout=5.0)
                if not ok:
                    # 总线满：不推进游标，下轮从当前游标重拉本批
                    return

            # 分页推进
            if pagination == "page":
                if not records:
                    break  # 空页 = 拉完
                page += 1
            elif pagination == "cursor":
                next_cursor = _dig(data, cursor_path or "meta.next_cursor")
                if not next_cursor or next_cursor == cursor_value:
                    break  # 无更多数据 / 游标未推进
                cursor_value = next_cursor
                self._cursor.save(next_cursor)  # 节流回写 DB
            else:
                break

    def stop(self) -> None:
        """停止前把游标落库。"""
        self.ctx.stop_event.set()
        cursor = getattr(self, "_cursor", None)
        if cursor is not None:
            try:
                cursor.flush_now()
            except Exception:  # noqa: BLE001
                pass
