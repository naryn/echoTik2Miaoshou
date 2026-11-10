"""认证账号服务：auth token → AuthUser → 唯一客户端身份。

设计要点：
- auth_users 表由运维直接在服务端维护（token / display_name / role）。
- 同一 token 在任意浏览器解析为同一 client_id，实现跨浏览器数据共享。
- 账号首次认证时自动创建/绑定一个 CollectorClient，后续批次、快照、任务均归属该 client_id。
- 单设备登录：账号首次登录会绑定设备与会话，其他设备登录会顶替旧会话，
  旧设备的后续请求返回 SESSION_REPLACED。
"""

import secrets

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import AuthUser, CollectorClient
from app.models.orm import utcnow
from app.services import client_service
from app.services.errors import session_replaced, unauthorized

# 设备会话凭证长度（token_urlsafe 字节数）
SESSION_TOKEN_BYTES = 32


def get_active_user(db: Session, token: str) -> AuthUser | None:
    """按 token 查询启用状态的认证账号；不存在返回 None。"""
    return db.execute(
        select(AuthUser).where(AuthUser.token == token, AuthUser.status == "ACTIVE")
    ).scalar_one_or_none()


def ensure_account_client(db: Session, user: AuthUser) -> CollectorClient:
    """确保认证账号已绑定客户端身份，返回该客户端。

    账号首次使用时以 `auth-<账号ID>` 作为 install_id 创建客户端；
    并发首次认证时依赖 install_id 唯一约束做兜底重查。
    """
    if user.client_id:
        client = db.get(CollectorClient, user.client_id)
        if client is not None:
            user.last_seen_at = utcnow()
            db.commit()
            return client

    install_id = f"auth-{user.id}"
    try:
        client = client_service.register_client(
            db, install_id, user.display_name or f"账号{user.id}", ""
        )
    except IntegrityError:
        # 并发首次认证：其他请求已创建该账号客户端，回查后绑定
        db.rollback()
        client = db.execute(
            select(CollectorClient).where(CollectorClient.install_id == install_id)
        ).scalar_one()
    user.client_id = client.client_id
    user.last_seen_at = utcnow()
    db.commit()
    return client


def login(
    db: Session, token: str, device_id: str
) -> tuple[AuthUser, CollectorClient, str]:
    """设备登录：绑定账号的唯一在线设备并返回会话凭证。

    同一设备重复登录复用原会话；不同设备登录会顶替旧会话（旧设备被踢下线）。
    """
    user = get_active_user(db, token)
    if user is None:
        raise unauthorized("认证 Token 无效或已停用")
    device_id = (device_id or "").strip()
    if not device_id:
        raise unauthorized("缺少设备标识（X-Device-Id）")

    now = utcnow()
    if user.active_device_id == device_id and user.active_session_id:
        session_id = user.active_session_id
    else:
        session_id = secrets.token_urlsafe(SESSION_TOKEN_BYTES)
        user.active_device_id = device_id
        user.active_session_id = session_id
        user.session_started_at = now
    user.last_seen_at = now
    db.commit()

    client = ensure_account_client(db, user)
    return user, client, session_id


def logout(db: Session, token: str, device_id: str | None, session_id: str | None) -> bool:
    """退出当前设备会话；仅当设备与会话匹配时生效。

    session_started_at 保留，避免登出后账号回退到“免会话”模式。
    """
    user = get_active_user(db, token)
    if user is None:
        return False
    if not device_id or not session_id:
        return False
    if user.active_device_id != device_id or user.active_session_id != session_id:
        return False
    user.active_device_id = None
    user.active_session_id = None
    db.commit()
    return True


def resolve_identity(
    db: Session,
    token: str,
    device_id: str | None = None,
    session_id: str | None = None,
    enforce_session: bool = True,
) -> tuple[AuthUser, CollectorClient]:
    """解析 Bearer token 为账号与客户端身份；token/会话无效时抛 401。

    账号一旦启用设备会话（session_started_at 非空），所有请求必须携带与
    服务端记录一致的 X-Device-Id / X-Session-Id，否则视为已被其他设备顶替。
    enforce_session=False 仅用于只读查看页（如图片预览），不参与单设备占用。
    """
    user = get_active_user(db, token)
    if user is None:
        raise unauthorized("认证 Token 无效或已停用")
    if enforce_session and user.session_started_at is not None:
        if (
            not device_id
            or not session_id
            or device_id != user.active_device_id
            or session_id != user.active_session_id
        ):
            raise session_replaced()
    client = ensure_account_client(db, user)
    return user, client
