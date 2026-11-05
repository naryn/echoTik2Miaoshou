"""客户端相关路由：注册、心跳、当前身份、恢复中的任务。"""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import ok, require_client
from app.db import get_db
from app.models import CollectorClient
from app.services import client_service, lease_service

router = APIRouter(prefix="/v1/clients", tags=["clients"])


@router.post("/register")
def register(body: schemas.RegisterRequest, db: Session = Depends(get_db)):
    """注册安装实例；同 install_id 幂等返回同一 client_id 并保持原 token。"""
    client = client_service.register_client(
        db, body.install_id, body.display_name, body.extension_version
    )
    return ok(schemas.client_out(client, include_token=True))


@router.post("/heartbeat")
def heartbeat(
    body: schemas.HeartbeatRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """上报客户端状态/进度心跳。"""
    hb = client_service.record_heartbeat(
        db,
        client,
        browser_state=body.browser_state,
        active_batch_id=body.active_batch_id,
        active_task_id=body.active_task_id,
        sync_pending_count=body.sync_pending_count,
    )
    return ok({"observed_at": schemas.dt(hb.observed_at)})


@router.get("/me")
def me(client: CollectorClient = Depends(require_client)):
    """查询当前客户端详情。"""
    return ok(schemas.client_out(client))


@router.get("/me/active-task")
def active_task(
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """返回该客户端当前租约中的任务（含商品信息），供 MV3 重启恢复。"""
    result = lease_service.get_active_task(db, client.client_id)
    if result is None:
        return ok(None)
    task, attempt = result
    data = schemas.task_out(task, product=task.product)
    if attempt is not None:
        data["attempt_id"] = attempt.attempt_id
    data["lease_token"] = task.lease_token
    return ok(data)
