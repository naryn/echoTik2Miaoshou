"""采集批次路由：创建、查询、状态机控制、失败补采、任务明细。

权限口径（role=ADMIN 与 USER 一致生效）：
  - 读（GET 详情/任务明细/列表）：读本接口仅返回自己 client_id 的数据；
    管理员跨客户端全量列表走独立的 /v1/admin/batches（列表+筛选完整）。
  - 写（POST 创建/状态机/补采）：只能操作自己 client_id 下的批次；
    创建的新批次归属 current caller 自身 client_id，不会被覆盖。
"""

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import Identity, ok, require_admin_or_client, require_client
from app.db import get_db
from app.models import CollectionBatch, CollectorClient, RankSnapshot
from app.services import batch_service
from app.services.errors import forbidden

router = APIRouter(prefix="/v1/batches", tags=["batches"])


def _check_batch_owner(batch: CollectionBatch, identity: Identity) -> None:
    """校验批次归属当前客户端（读接口 admin 放行，写接口强制校验）。"""
    if batch.client_id != identity.client.client_id:
        raise forbidden("批次不属于当前客户端")


def _batch_payload(db: Session, batch: CollectionBatch, summary: dict | None = None) -> dict:
    """批次响应：附带来源榜单快照信息，便于前端展示榜单条件。"""
    snapshot = db.get(RankSnapshot, batch.source_snapshot_id) if batch.source_snapshot_id else None
    return schemas.batch_out(batch, summary=summary, snapshot=snapshot, db=db)


@router.post("")
def create_batch(
    body: schemas.BatchCreateRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """从快照或显式商品 ID 创建批次；幂等 + 单客户端单活跃批次约束。

    新批次始终归属当前调用者自身客户端。
    """
    config = dict(body.config or {})
    if body.interval_seconds:
        config["interval_seconds"] = body.interval_seconds
    batch, created, skipped = batch_service.create_batch(
        db,
        client_id=client.client_id,
        idempotency_key=body.idempotency_key,
        snapshot_id=body.snapshot_id,
        source_platform=body.source_platform,
        product_ids=body.product_ids,
        exclude_already_successful=body.exclude_already_successful,
        config=config,
        force=body.force,
        recollect=body.recollect,
    )
    summary = batch_service.batch_summary(db, batch.batch_id)
    data = _batch_payload(db, batch, summary=summary)
    data["created"] = created
    data["skipped_already_successful"] = skipped
    return ok(data)


@router.get("")
def list_batches(
    status: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20),
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """批次列表（仅本客户端），附聚合进度；管理员跨客户端列表走 /admin/batches。"""
    if per_page not in (20, 50, 100):
        per_page = 20
    items, total = batch_service.list_batches(
        db,
        client_id=client.client_id,
        status=status,
        date_from=date_from,
        date_to=date_to,
        page=page,
        per_page=per_page,
    )
    return ok(
        {
            "items": [
                _batch_payload(db, b, summary=batch_service.batch_summary(db, b.batch_id))
                for b in items
            ],
            "total": total,
            "page": page,
            "per_page": per_page,
        }
    )


@router.get("/{batch_id}")
def get_batch(
    batch_id: str,
    identity: Identity = Depends(require_admin_or_client),
    db: Session = Depends(get_db),
):
    """批次详情（含各状态任务计数聚合进度）。管理员可跨客户端只读。"""
    batch = batch_service.get_batch_or_404(db, batch_id)
    if identity.role != "ADMIN":
        _check_batch_owner(batch, identity)
    return ok(
        _batch_payload(db, batch, summary=batch_service.batch_summary(db, batch.batch_id))
    )


@router.post("/{batch_id}/retry-failed")
def retry_failed(
    batch_id: str,
    body: schemas.RetryFailedRequest,
    identity: Identity = Depends(require_admin_or_client),
    db: Session = Depends(get_db),
):
    """创建补采批次：仅 FAILED 任务商品，归属 current caller 自身客户端。"""
    source = batch_service.get_batch_or_404(db, batch_id)
    # 写接口严格 owner 校验：admin 补采别人的批次也会被拦
    if identity.role != "ADMIN" or source.client_id != identity.client.client_id:
        _check_batch_owner(source, identity)
    batch, created, skipped = batch_service.retry_failed(
        db,
        client_id=identity.client.client_id,
        source_batch=source,
        idempotency_key=body.idempotency_key,
        statuses=body.statuses,
        force=body.force,
    )
    summary = batch_service.batch_summary(db, batch.batch_id)
    data = _batch_payload(db, batch, summary=summary)
    data["created"] = created
    return ok(data)


@router.post("/{batch_id}/{action}")
def control_batch(
    batch_id: str,
    action: str,
    identity: Identity = Depends(require_admin_or_client),
    db: Session = Depends(get_db),
):
    """批次控制 start/pause/resume/cancel。严格 owner 校验（admin 也不能跨客户端控制）。"""
    if action not in ("start", "pause", "resume", "cancel"):
        from app.services.errors import not_found

        raise not_found("接口")
    batch = batch_service.get_batch_or_404(db, batch_id)
    if identity.role != "ADMIN" or batch.client_id != identity.client.client_id:
        _check_batch_owner(batch, identity)
    batch = batch_service.control_batch(db, batch, action)
    return ok(
        _batch_payload(db, batch, summary=batch_service.batch_summary(db, batch.batch_id))
    )


@router.get("/{batch_id}/tasks")
def list_tasks(
    batch_id: str,
    status: str | None = None,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20),
    identity: Identity = Depends(require_admin_or_client),
    db: Session = Depends(get_db),
):
    """批次任务明细按状态筛选分页。管理员可跨客户端只读。"""
    if per_page not in (20, 50, 100):
        per_page = 20
    batch = batch_service.get_batch_or_404(db, batch_id)
    if identity.role != "ADMIN":
        _check_batch_owner(batch, identity)
    items, total = batch_service.list_tasks(
        db, batch_id, status=status, page=page, per_page=per_page
    )
    return ok(
        {
            "items": [schemas.task_out(t, product=t.product) for t in items],
            "total": total,
            "page": page,
            "per_page": per_page,
        }
    )
