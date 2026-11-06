"""榜单快照与商品路由。"""

from datetime import datetime

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import Identity, ok, require_client, require_identity
from app.db import get_db
from app.models import CollectorClient, RankingPreset
from app.services import rank_service
from app.services.errors import forbidden

router = APIRouter(prefix="/v1", tags=["rank"])


def _preset_out(preset: RankingPreset) -> dict:
    return {
        "preset_id": preset.preset_id,
        "name": preset.name,
        "source_platform": preset.source_platform,
        "query_json": preset.query_json,
        "created_at": schemas.dt(preset.created_at),
        "updated_at": schemas.dt(preset.updated_at),
    }


@router.get("/ranking-presets")
def list_ranking_presets(source_platform: str, client: CollectorClient = Depends(require_client), db: Session = Depends(get_db)):
    """只列出当前账号、当前采集渠道下的筛选预设。"""
    items = db.query(RankingPreset).filter(
        RankingPreset.client_id == client.client_id,
        RankingPreset.source_platform == source_platform,
    ).order_by(RankingPreset.updated_at.desc()).all()
    return ok({"items": [_preset_out(item) for item in items]})


@router.put("/ranking-presets")
def upsert_ranking_preset(
    body: schemas.RankingPresetUpsertRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """以名称为键创建或覆盖当前账号、当前渠道下的筛选预设。"""
    preset = db.query(RankingPreset).filter(
        RankingPreset.client_id == client.client_id,
        RankingPreset.source_platform == body.source_platform,
        RankingPreset.name == body.name,
    ).one_or_none()
    if preset is None:
        preset = RankingPreset(client_id=client.client_id, source_platform=body.source_platform, name=body.name, query_json=body.query_json)
        db.add(preset)
    else:
        preset.query_json = body.query_json
    db.commit()
    db.refresh(preset)
    return ok(_preset_out(preset))


@router.delete("/ranking-presets/{preset_id}")
def delete_ranking_preset(preset_id: str, client: CollectorClient = Depends(require_client), db: Session = Depends(get_db)):
    preset = db.get(RankingPreset, preset_id)
    if not preset or preset.client_id != client.client_id:
        raise forbidden("筛选预设不存在或不属于当前账号")
    db.delete(preset)
    db.commit()
    return ok({"deleted": True})


def _check_snapshot_owner(snapshot, client: CollectorClient) -> None:
    """校验快照归属当前客户端。"""
    if snapshot.client_id != client.client_id:
        raise forbidden("榜单快照不属于当前客户端")


@router.post("/rank-snapshots")
def create_snapshot(
    body: schemas.SnapshotCreateRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """创建榜单快照；request_id 幂等，重复返回同一快照。"""
    snapshot, created = rank_service.create_snapshot(
        db,
        client_id=client.client_id,
        request_id=body.request_id,
        region=body.region,
        ranking_type=body.ranking_type,
        source_platform=body.source_platform,
        ranking_variant=body.ranking_variant,
        category_id=body.category_id,
        period_start=body.period_start,
        period_end=body.period_end,
        filter_json=body.filter_json,
    )
    data = schemas.snapshot_out(snapshot)
    data["created"] = created
    return ok(data)


@router.post("/rank-snapshots/{snapshot_id}/entries:upsert")
def upsert_entries(
    snapshot_id: str,
    body: schemas.EntriesUpsertRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """批量 upsert 商品与榜单明细；非法条目进入 rejected 不落库。"""
    snapshot = rank_service.get_snapshot_or_404(db, snapshot_id)
    _check_snapshot_owner(snapshot, client)
    result = rank_service.upsert_entries(
        db, snapshot, [item.model_dump() for item in body.entries]
    )
    result["snapshot_id"] = snapshot.snapshot_id
    result["total_entries"] = snapshot.total_entries
    return ok(result)


@router.post("/rank-snapshots/{snapshot_id}/finish")
def finish_snapshot(
    snapshot_id: str,
    body: schemas.FinishSnapshotRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """标记快照完成：COMPLETED / PARTIAL / FAILED。"""
    snapshot = rank_service.get_snapshot_or_404(db, snapshot_id)
    _check_snapshot_owner(snapshot, client)
    snapshot = rank_service.finish_snapshot(db, snapshot, body.status)
    return ok(schemas.snapshot_out(snapshot))


@router.get("/rank-snapshots")
def list_snapshots(
    region: str | None = None,
    ranking_type: str | None = None,
    category_id: str | None = None,
    status: str | None = None,
    source_platform: schemas.SourcePlatform | None = Query(default=None),
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20),
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """历史快照查询与筛选（仅本客户端数据）。"""
    if per_page not in (20, 50, 100):
        per_page = 20
    items, total = rank_service.list_snapshots(
        db,
        client_id=client.client_id,
        region=region,
        ranking_type=ranking_type,
        category_id=category_id,
        status=status,
        source_platform=source_platform,
        date_from=date_from,
        date_to=date_to,
        page=page,
        per_page=per_page,
    )
    return ok(
        {
            "items": [schemas.snapshot_out(s) for s in items],
            "total": total,
            "page": page,
            "per_page": per_page,
        }
    )


@router.get("/products")
def list_products(
    keyword: str | None = None,
    region: str | None = None,
    category: str | None = None,
    ranking_type: str | None = None,
    ranking_variant: str | None = None,
    source_platform: schemas.SourcePlatform | None = Query(default=None),
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
    identity: Identity = Depends(require_identity),
    db: Session = Depends(get_db),
):
    """商品列表：关键词/站点/分类/榜单/快照/批次/排名/ERP 状态筛选 + 排序分页。

    普通账号仅能看到自己快照或自己批次任务涉及的商品；管理员可看全量。
    """
    if per_page not in (20, 50, 100):
        per_page = 20
    scope_client_id = None if identity.role == "ADMIN" else identity.client.client_id
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
        scope_client_id=scope_client_id,
        sort=sort,
        order=order,
        page=page,
        per_page=per_page,
    )
    return ok(
        {
            "items": [
                {**schemas.product_out(row["product"]), "erp_status": row["erp_status"]}
                for row in items
            ],
            "total": total,
            "page": page,
            "per_page": per_page,
        }
    )


@router.get("/products/{product_id}/rank-history")
def rank_history(
    product_id: str,
    identity: Identity = Depends(require_identity),
    db: Session = Depends(get_db),
):
    """商品榜单历史：普通账号仅返回自身快照，管理员返回全量。"""
    product = rank_service.get_product_or_404(db, product_id)
    scope_client_id = None if identity.role == "ADMIN" else identity.client.client_id
    rows = rank_service.product_rank_history(
        db, product.id, scope_client_id=scope_client_id
    )
    return ok(
        {
            "product": schemas.product_out(product),
            "items": [schemas.rank_entry_out(entry, snapshot) for entry, snapshot in rows],
        }
    )
