"""开放 API 网关路由（供第三方系统调用）。

- ``GET /api/v1/open``：该 Key 有权访问的资源目录（自助发现能拿什么数据）。
- ``GET /api/v1/open/{resource_code}``：统一数据端点（API Key 鉴权 + scope 授权）。

鉴权走 ``app.core.open_api_auth.authenticate_request``（Header: X-API-Key），
所有调用（含拒绝）由 ``open_api_call_middleware`` 记录到调用日志。
"""
import json
import logging

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app.core.open_api_auth import authenticate_request
from app.core.open_api_registry import (
    DEFAULT_PAGE_SIZE,
    _parse_pagination,
    get_resource,
    resource_catalog,
)
from app.database import get_db
from app.models.open_api import OpenApiScope

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/open", tags=["open-api"])


@router.get("")
def list_authorized_resources(
    request: Request,
    x_api_key: str = Header(None, alias="X-API-Key"),
    db: Session = Depends(get_db),
):
    """返回当前 Key 有权访问的资源目录（code/名称/描述/支持过滤参数）。"""
    app = authenticate_request(request, x_api_key, db, resource_code="")
    codes = [
        row[0]
        for row in db.query(OpenApiScope.resource_code)
        .filter(OpenApiScope.app_id == app.id)
        .all()
    ]
    return {
        "code": 0,
        "message": "ok",
        "data": {
            "app_name": app.app_name,
            "resources": resource_catalog(codes),
        },
    }


@router.get("/{resource_code}")
def get_resource_data(
    resource_code: str,
    request: Request,
    x_api_key: str = Header(None, alias="X-API-Key"),
    db: Session = Depends(get_db),
):
    """统一数据端点：按授权资源返回只读数据。

    - 鉴权优先（未认证一律 401，不暴露资源是否存在），资源不存在 → 404
    - 已认证但未授权（含不存在的资源，scope 不可能有）→ 403（由鉴权核心抛出）
    - 停用/过期/限流 → 403/429（由鉴权核心抛出）
    - 通用分页参数：page / page_size（上限 100）
    """
    # 先鉴权再查资源：避免未认证调用者凭 404(不存在) vs 401(存在) 差异枚举有效资源编码。
    # 资源不在目录中时其 scope 必不存在，authenticate_request 已按未授权 403 拒绝，
    # 此处 404 仅作为目录与 scope 不一致（防御）时的兜底。
    authenticate_request(request, x_api_key, db, resource_code)

    meta = get_resource(resource_code)
    if meta is None:
        raise HTTPException(
            status_code=404,
            detail=f"资源不存在: {resource_code}，可用资源见 GET /api/v1/open",
        )

    params = dict(request.query_params)
    items, total = meta["handler"](db, params)

    # 聚合类资源（dashboard_stats / ticket_monitor）不做分页包装。
    # ticket_monitor 全景：handler 直接返回内部路由 TTL 缓存中的预渲染 JSON 文本
    # （约 2MB），此处拼接外层包装回发，跳过逐次 dumps；light / dashboard_stats
    # 响应小，dict 现场渲染（数据均为纯 JSON 类型，可安全直出）
    if resource_code in ("dashboard_stats", "ticket_monitor"):
        resource = json.dumps({"code": resource_code, "name": meta["name"]}, ensure_ascii=False)
        if isinstance(items, str):
            content = '{"code":0,"message":"ok","resource":' + resource + ',"data":' + items + '}'
        else:
            content = json.dumps(
                {
                    "code": 0,
                    "message": "ok",
                    "resource": {"code": resource_code, "name": meta["name"]},
                    "data": items,
                },
                ensure_ascii=False,
            )
        return Response(content=content, media_type="application/json")

    page, page_size = _parse_pagination(params)
    return {
        "code": 0,
        "message": "ok",
        "resource": {"code": resource_code, "name": meta["name"], "filters": meta["filters"]},
        "data": {
            "items": items,
            "total": total,
            "page": page,
            "page_size": page_size or DEFAULT_PAGE_SIZE,
        },
    }
