"""任务执行路由：领取、租约心跳、事件、结果提交、尝试日志。"""

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import Identity, ok, require_admin_or_client, require_client, require_identity
from app.db import get_db
from app.models import CollectorClient
from app.services import batch_service, lease_service

router = APIRouter(prefix="/v1", tags=["tasks"])


@router.post("/tasks/claim")
def claim_task(
    body: schemas.ClaimRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """排他领取批次下一条 PENDING 任务；无可领任务时 data 为 null。"""
    result = lease_service.claim_task(db, client.client_id, body.batch_id, body.request_id)
    if result is None:
        return ok(None)
    task, attempt = result
    data = {
        "task_id": task.task_id,
        "attempt_id": attempt.attempt_id,
        "lease_token": task.lease_token,
        "lease_expires_at": schemas.dt(task.lease_expires_at),
        "batch_id": task.batch_id,
        "status": task.status,
        "product": schemas.product_out(task.product),
    }
    return ok(data)


@router.post("/tasks/{task_id}/heartbeat")
def task_heartbeat(
    task_id: str,
    body: schemas.TaskHeartbeatRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """校验 lease_token，延长租约并更新任务阶段。"""
    task = lease_service.heartbeat_task(
        db, client.client_id, task_id, body.lease_token, body.stage
    )
    return ok(schemas.task_out(task))


@router.post("/tasks/{task_id}/events")
def task_events(
    task_id: str,
    body: schemas.TaskEventRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """记录任务事件；event_id 幂等去重。"""
    event, created = lease_service.add_task_event(
        db,
        client_id=client.client_id,
        task_id=task_id,
        batch_id=body.batch_id,
        event_id=body.event_id,
        event_type=body.event_type,
        payload=body.payload,
        occurred_at=body.occurred_at,
    )
    data = schemas.event_out(event)
    data["created"] = created
    return ok(data)


@router.post("/tasks/{task_id}/result")
def submit_result(
    task_id: str,
    body: schemas.ResultSubmitRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """按 attempt_id 幂等提交任务最终结果。"""
    task = lease_service.submit_result(
        db,
        client_id=client.client_id,
        task_id=task_id,
        attempt_id=body.attempt_id,
        lease_token=body.lease_token,
        result=body.result,
        error_code=body.error_code,
        evidence=body.evidence,
        elapsed_ms=body.elapsed_ms,
    )
    return ok(schemas.task_out(task))


@router.post("/tasks/{task_id}/recollect")
def recollect_task(
    task_id: str,
    identity: Identity = Depends(require_admin_or_client),
    db: Session = Depends(get_db),
):
    """单条重新抓取：重置任务并跳过“已采集”去重。管理员可跨客户端操作。"""
    task = batch_service.recollect_task(
        db,
        client_id=identity.client.client_id,
        task_id=task_id,
        skip_owner_check=identity.role == "ADMIN",
    )
    return ok(schemas.task_out(task))


@router.get("/attempts")
def list_attempts(
    batch_id: str | None = None,
    task_id: str | None = None,
    result: str | None = None,
    error_code: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20),
    identity: Identity = Depends(require_identity),
    db: Session = Depends(get_db),
):
    """采集尝试日志筛选分页；普通账号仅可见自身批次记录，管理员可见全量。"""
    if per_page not in (20, 50, 100):
        per_page = 20
    scope_client_id = None if identity.role == "ADMIN" else identity.client.client_id
    items, total = lease_service.list_attempts(
        db,
        batch_id=batch_id,
        task_id=task_id,
        result=result,
        error_code=error_code,
        date_from=date_from,
        date_to=date_to,
        scope_client_id=scope_client_id,
        page=page,
        per_page=per_page,
    )
    return ok(
        {
            "items": [schemas.attempt_out(a) for a in items],
            "total": total,
            "page": page,
            "per_page": per_page,
        }
    )
