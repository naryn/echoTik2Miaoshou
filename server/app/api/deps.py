"""API 依赖与统一响应包装：客户端鉴权、request_id 上下文、响应信封。"""

import contextvars
import uuid

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import CollectorClient
from app.services.errors import unauthorized

# 请求级 request_id，由中间件写入，响应包装统一读取
_request_id_ctx: contextvars.ContextVar[str] = contextvars.ContextVar(
    "request_id", default=""
)


def set_request_id(request_id: str) -> None:
    """写入当前请求的 request_id（中间件调用）。"""
    _request_id_ctx.set(request_id)


def current_request_id() -> str:
    """读取当前请求 request_id，缺失时生成一个。"""
    rid = _request_id_ctx.get()
    return rid or f"req_{uuid.uuid4().hex}"


def ok(data) -> dict:
    """成功响应统一包装：{ data, error, request_id }。"""
    return {"data": data, "error": None, "request_id": current_request_id()}


def error_body(code: str, message: str, retryable: bool) -> dict:
    """错误响应统一包装：error 含稳定 code/message/retryable。"""
    return {
        "data": None,
        "error": {"code": code, "message": message, "retryable": retryable},
        "request_id": current_request_id(),
    }


def require_client(request: Request, db: Session = Depends(get_db)) -> CollectorClient:
    """写接口鉴权：校验 X-Client-Id + X-Client-Token 头并返回客户端实体。"""
    client_id = request.headers.get("X-Client-Id")
    token = request.headers.get("X-Client-Token")
    if not client_id or not token:
        raise unauthorized("缺少 X-Client-Id / X-Client-Token 请求头")
    client = db.execute(
        select(CollectorClient).where(CollectorClient.client_id == client_id)
    ).scalar_one_or_none()
    if client is None or client.client_token != token:
        raise unauthorized()
    if client.status != "ACTIVE":
        raise unauthorized(f"客户端状态为 {client.status}")
    return client
