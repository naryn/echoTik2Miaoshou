"""管理员只读路由：跨账号读取全量批次、任务与商品数据。

鉴权使用认证 Token（`Authorization: Bearer <token>`），服务端按 auth_users.role
判定是否为 ADMIN；所有接口均为只读，不提供批次控制等写操作。
"""

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import ok, require_admin
from app.api.routes_batches import _batch_payload
from app.db import get_db
from app.models import CollectorClient
from app.services import batch_service, rank_service

router = APIRouter(
    prefix="/v1/admin",
    tags=["admin"],
    dependencies=[Depends(require_admin)],
)


def _per_page(value: int) -> int:
    """分页大小归一化：仅允许 20/50/100，其余回落 20。"""
    return value if value in (20, 50, 100) else 20


@router.get("/clients")
def list_clients(db: Session = Depends(get_db)):
    """全量客户端列表（不含 client_token，供管理端筛选归属）。"""
    items = db.execute(
        select(CollectorClient).order_by(CollectorClient.registered_at.asc())
    ).scalars().all()
    return ok({"items": [schemas.client_out(c) for c in items]})


@router.get("/rank-snapshots")
def list_rank_snapshots(
    region: str | None = None,
    ranking_type: str | None = None,
    category_id: str | None = None,
    status: str | None = None,
    source_platform: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20),
    db: Session = Depends(get_db),
):
    """管理员跨客户端读取全部历史榜单快照（只读）。"""
    size = _per_page(per_page)
    items, total = rank_service.list_snapshots(
        db,
        region=region,
        ranking_type=ranking_type,
        category_id=category_id,
        status=status,
        source_platform=source_platform,
        date_from=date_from,
        date_to=date_to,
        page=page,
        per_page=size,
    )
    return ok(
        {
            "items": [schemas.snapshot_out(snapshot, db) for snapshot in items],
            "total": total,
            "page": page,
            "per_page": size,
        }
    )


@router.get("/batches")
def list_batches(
    client_id: str | None = None,
    status: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20),
    db: Session = Depends(get_db),
):
    """全量采集批次列表（可按客户端/状态/创建日期筛选），附聚合进度与来源快照。"""
    size = _per_page(per_page)
    items, total = batch_service.list_batches(
        db,
        client_id=client_id,
        status=status,
        date_from=date_from,
        date_to=date_to,
        page=page,
        per_page=size,
    )
    return ok(
        {
            "items": [
                _batch_payload(db, b, summary=batch_service.batch_summary(db, b.batch_id))
                for b in items
            ],
            "total": total,
            "page": page,
            "per_page": size,
        }
    )


@router.get("/batches/{batch_id}")
def get_batch(batch_id: str, db: Session = Depends(get_db)):
    """任意客户端批次详情（含聚合进度与来源榜单快照信息）。"""
    batch = batch_service.get_batch_or_404(db, batch_id)
    return ok(
        _batch_payload(db, batch, summary=batch_service.batch_summary(db, batch.batch_id))
    )


@router.get("/batches/{batch_id}/tasks")
def list_batch_tasks(
    batch_id: str,
    status: str | None = None,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20),
    db: Session = Depends(get_db),
):
    """任意客户端批次的任务明细（含商品信息）分页。"""
    size = _per_page(per_page)
    batch_service.get_batch_or_404(db, batch_id)
    items, total = batch_service.list_tasks(
        db, batch_id, status=status, page=page, per_page=size
    )
    return ok(
        {
            "items": [schemas.task_out(t, product=t.product) for t in items],
            "total": total,
            "page": page,
            "per_page": size,
        }
    )


@router.get("/products")
def list_products(
    keyword: str | None = None,
    region: str | None = None,
    category: str | None = None,
    ranking_type: str | None = None,
    ranking_variant: str | None = None,
    source_platform: str | None = None,
    snapshot_id: str | None = None,
    batch_id: str | None = None,
    snapshot_date_from: datetime | None = None,
    snapshot_date_to: datetime | None = None,
    rank_min: int | None = Query(default=None, ge=1),
    rank_max: int | None = Query(default=None, ge=1),
    erp_status: str | None = None,
    sort: str = "last_seen_at",
    order: str = Query(default="desc", pattern="^(asc|desc)$"),
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20),
    db: Session = Depends(get_db),
):
    """全量商品列表：支持关键词/站点/类目/榜单/快照/批次/排名/ERP 状态筛选。"""
    size = _per_page(per_page)
    items, total = rank_service.list_products(
        db,
        keyword=keyword,
        region=region,
        category=category,
        ranking_type=ranking_type,
        ranking_variant=ranking_variant,
        source_platform=source_platform,
        snapshot_id=snapshot_id,
        batch_id=batch_id,
        snapshot_date_from=snapshot_date_from,
        snapshot_date_to=snapshot_date_to,
        rank_min=rank_min,
        rank_max=rank_max,
        erp_status=erp_status,
        sort=sort,
        order=order,
        page=page,
        per_page=size,
    )
    return ok(
        {
            "items": [
                {**schemas.product_out(row["product"]), "erp_status": row["erp_status"]}
                for row in items
            ],
            "total": total,
            "page": page,
            "per_page": size,
        }
    )
