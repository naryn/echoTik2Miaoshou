"""认证账号服务：auth token → AuthUser → 唯一客户端身份。

设计要点：
- auth_users 表由运维直接在服务端维护（token / display_name / role）。
- 同一 token 在任意浏览器解析为同一 client_id，实现跨浏览器数据共享。
- 账号首次认证时自动创建/绑定一个 CollectorClient，后续批次、快照、任务均归属该 client_id。
"""

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.models import AuthUser, CollectorClient
from app.models.orm import utcnow
from app.services import client_service
from app.services.errors import unauthorized


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


def resolve_identity(db: Session, token: str) -> tuple[AuthUser, CollectorClient]:
    """解析 Bearer token 为账号与客户端身份；token 无效时抛 401。"""
    user = get_active_user(db, token)
    if user is None:
        raise unauthorized("认证 Token 无效或已停用")
    client = ensure_account_client(db, user)
    return user, client
