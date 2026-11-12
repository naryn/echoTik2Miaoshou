"""API 依赖与统一响应包装：认证身份、request_id 上下文、响应信封。"""

import contextvars
import uuid
from dataclasses import dataclass

from fastapi import Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import AuthUser, CollectorClient
from app.services import auth_service
from app.services.errors import admin_forbidden, unauthorized

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


@dataclass
class Identity:
    """请求认证身份：客户端实体 + 可选认证账号 + 角色 + 设备会话。"""

    client: CollectorClient
    user: AuthUser | None
    role: str
    session_id: str | None = None


def _bearer_token(request: Request) -> str | None:
    """从 Authorization: Bearer 或 X-Auth-Token 头提取 auth token。"""
    header = request.headers.get("Authorization", "")
    if header.lower().startswith("bearer "):
        token = header[7:].strip()
        if token:
            return token
    return request.headers.get("X-Auth-Token") or None


def bearer_token(request: Request) -> str | None:
    """公开的 token 提取函数（登录/登出路由复用）。"""
    return _bearer_token(request)


def _legacy_client_identity(request: Request, db: Session) -> Identity:
    """兼容旧版 X-Client-Id / X-Client-Token 头（角色视为普通用户）。"""
    client_id = request.headers.get("X-Client-Id")
    client_token = request.headers.get("X-Client-Token")
    if not client_id or not client_token:
        raise unauthorized("缺少认证 Token（请在插件设置中填写 auth token）")
    client = db.execute(
        select(CollectorClient).where(CollectorClient.client_id == client_id)
    ).scalar_one_or_none()
    if client is None or client.client_token != client_token:
        raise unauthorized()
    if client.status != "ACTIVE":
        raise unauthorized(f"客户端状态为 {client.status}")
    return Identity(client=client, user=None, role="USER")


def require_identity(
    request: Request, db: Session = Depends(get_db)
) -> Identity:
    """解析请求认证身份。

    优先使用插件填写的 auth token（Bearer）；为兼容旧版本/自动化测试，
    仍接受 X-Client-Id + X-Client-Token 头，此时角色视为普通用户。
    """
    token = _bearer_token(request)
    if token:
        session_id = request.headers.get("X-Session-Id")
        user, client = auth_service.resolve_identity(
            db, token, request.headers.get("X-Device-Id"), session_id
        )
        if client.status != "ACTIVE":
            raise unauthorized(f"客户端状态为 {client.status}")
        return Identity(
            client=client,
            user=user,
            role=(user.role or "USER").upper(),
            session_id=session_id,
        )
    return _legacy_client_identity(request, db)


def require_client(
    identity: Identity = Depends(require_identity),
) -> CollectorClient:
    """写接口鉴权：返回当前认证身份的客户端实体。"""
    return identity.client


def require_identity_readonly(
    request: Request, db: Session = Depends(get_db)
) -> Identity:
    """只读查看页鉴权：只校验 auth token，不占用/不校验设备会话。

    仅用于服务端托管的图片预览页等只读场景，避免查看图片时挤掉插件登录。
    """
    token = _bearer_token(request)
    if not token:
        # 旧版客户端（X-Client-Id/Token）同样允许只读访问
        return _legacy_client_identity(request, db)
    user, client = auth_service.resolve_identity(db, token, enforce_session=False)
    if client.status != "ACTIVE":
        raise unauthorized(f"客户端状态为 {client.status}")
    return Identity(
        client=client,
        user=user,
        role=(user.role or "USER").upper(),
        session_id=None,
    )


def require_admin(
    identity: Identity = Depends(require_identity),
) -> Identity:
    """管理端鉴权：仅 auth_users 表中 role=ADMIN 的账号可访问。"""
    if identity.role != "ADMIN":
        raise admin_forbidden("需要管理员权限（auth_users.role=ADMIN）")
    return identity


def require_admin_or_client(
    identity: Identity = Depends(require_identity),
) -> Identity:
    """写接口管理员放行：ADMIN 账号可跨客户端操作，普通账号仅归属自身客户端。

    返回 Identity（含 role 字段），由路由层按 role 决定是否跳过 owner 校验。
    """
    return identity
