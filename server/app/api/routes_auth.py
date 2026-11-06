"""认证相关路由：插件填写 auth token 后查询当前身份与角色。"""

from fastapi import APIRouter, Depends

from app.api import schemas
from app.api.deps import Identity, ok, require_identity

router = APIRouter(prefix="/v1/auth", tags=["auth"])


@router.get("/me")
def me(identity: Identity = Depends(require_identity)):
    """返回当前 auth token 对应的账号/角色与共享客户端 ID。"""
    client = identity.client
    user = identity.user
    return ok(
        {
            "client_id": client.client_id,
            "display_name": (user.display_name if user else None) or client.display_name,
            "role": identity.role,
            "registered_at": schemas.dt(client.registered_at),
            "extension_version": client.extension_version,
            "last_seen_at": schemas.dt(client.last_seen_at),
        }
    )
