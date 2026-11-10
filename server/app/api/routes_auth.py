"""认证相关路由：设备登录、身份查询与退出登录（单设备登录）。"""

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import Identity, bearer_token, ok, require_identity
from app.db import get_db
from app.services import auth_service
from app.services.errors import unauthorized

router = APIRouter(prefix="/v1/auth", tags=["auth"])


def _identity_out(identity: Identity, session_id: str | None) -> dict:
    """统一输出账号/角色/共享客户端与设备会话信息。"""
    client = identity.client
    user = identity.user
    return {
        "client_id": client.client_id,
        "display_name": (user.display_name if user else None) or client.display_name,
        "role": identity.role,
        "registered_at": schemas.dt(client.registered_at),
        "extension_version": client.extension_version,
        "last_seen_at": schemas.dt(client.last_seen_at),
        "session_id": session_id,
    }


@router.post("/login")
def login(
    body: schemas.AuthLoginRequest,
    request: Request,
    db: Session = Depends(get_db),
):
    """设备登录：绑定账号唯一在线设备，其他设备会话随即失效。"""
    token = bearer_token(request)
    if not token:
        raise unauthorized("缺少认证 Token（请在插件设置中填写 auth token）")
    user, client, session_id = auth_service.login(db, token, body.device_id)
    if client.status != "ACTIVE":
        raise unauthorized(f"客户端状态为 {client.status}")
    identity = Identity(
        client=client,
        user=user,
        role=(user.role or "USER").upper(),
        session_id=session_id,
    )
    return ok(_identity_out(identity, session_id))


@router.get("/me")
def me(identity: Identity = Depends(require_identity)):
    """返回当前 auth token 对应的账号/角色与共享客户端 ID。"""
    return ok(_identity_out(identity, identity.session_id))


@router.post("/logout")
def logout(request: Request, db: Session = Depends(get_db)):
    """退出当前设备会话；设备/会话不匹配时不做任何变更。"""
    token = bearer_token(request)
    if not token:
        return ok({"logged_out": False})
    logged_out = auth_service.logout(
        db,
        token,
        request.headers.get("X-Device-Id"),
        request.headers.get("X-Session-Id"),
    )
    return ok({"logged_out": logged_out})
