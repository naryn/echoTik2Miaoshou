"""客户端注册、心跳与身份查询服务。"""

import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import CLIENT_TOKEN_BYTES
from app.models import ClientHeartbeat, CollectorClient
from app.models.orm import utcnow
from app.services.errors import not_found


def register_client(db: Session, install_id: str, display_name: str, extension_version: str) -> CollectorClient:
    """注册插件安装实例。

    幂等策略：同一 install_id 重复注册返回同一 client_id，并保持原有 client_token
    （不轮换），避免把其他已在线扩展的凭证顶掉；调用方每次都能拿到有效 token。
    """
    existing = db.execute(
        select(CollectorClient).where(CollectorClient.install_id == install_id)
    ).scalar_one_or_none()
    if existing is not None:
        if display_name:
            existing.display_name = display_name
        if extension_version:
            existing.extension_version = extension_version
        existing.last_seen_at = utcnow()
        db.commit()
        return existing

    client = CollectorClient(
        install_id=install_id,
        display_name=display_name or "",
        extension_version=extension_version or "",
        client_token=secrets.token_urlsafe(CLIENT_TOKEN_BYTES),
        status="ACTIVE",
        registered_at=utcnow(),
        last_seen_at=utcnow(),
    )
    db.add(client)
    db.commit()
    return client


def get_client_or_404(db: Session, client_id: str) -> CollectorClient:
    """按 client_id 查询客户端，不存在则抛 404。"""
    client = db.get(CollectorClient, client_id)
    if client is None:
        raise not_found("客户端")
    return client


def record_heartbeat(
    db: Session,
    client: CollectorClient,
    browser_state: str | None,
    active_batch_id: str | None,
    active_task_id: str | None,
    sync_pending_count: int,
) -> ClientHeartbeat:
    """写入一条客户端心跳并刷新客户端 last_seen_at。"""
    now = utcnow()
    heartbeat = ClientHeartbeat(
        client_id=client.client_id,
        observed_at=now,
        browser_state=browser_state,
        active_batch_id=active_batch_id,
        active_task_id=active_task_id,
        sync_pending_count=sync_pending_count,
    )
    db.add(heartbeat)
    client.last_seen_at = now
    db.commit()
    return heartbeat
