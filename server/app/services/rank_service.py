"""榜单快照与商品主数据服务：快照创建、批量明细 upsert、查询筛选。"""

from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import MAX_ENTRIES_BATCH
from app.models import Category, CollectionTask, Product, RankEntry, RankSnapshot
from app.models.orm import new_id, utcnow
from app.services import idempotency
from app.services.errors import ApiError, not_found

SNAPSHOT_FINAL_STATUSES = {"COMPLETED", "PARTIAL", "FAILED"}


def create_snapshot(
    db: Session,
    client_id: str,
    request_id: str,
    region: str,
    ranking_type: str,
    ranking_variant: str | None = None,
    category_id: str | None = None,
    period_start: str | None = None,
    period_end: str | None = None,
    filter_json: dict | None = None,
) -> tuple[RankSnapshot, bool]:
    """创建榜单快照；request_id 幂等，重复请求返回同一快照。

    :return: (快照, 是否新建)
    """
    existing = idempotency.find_snapshot_by_request_id(db, request_id)
    if existing is not None:
        return existing, False

    snapshot = RankSnapshot(
        client_id=client_id,
        request_id=request_id,
        region=region,
        ranking_type=ranking_type,
        ranking_variant=ranking_variant,
        category_id=category_id,
        period_start=period_start,
        period_end=period_end,
        filter_json=filter_json or {},
        status="CAPTURING",
        capture_started_at=utcnow(),
    )
    db.add(snapshot)
    db.commit()
    return snapshot, True


def get_snapshot_or_404(db: Session, snapshot_id: str) -> RankSnapshot:
    """查询快照，不存在抛 404。"""
    snapshot = db.get(RankSnapshot, snapshot_id)
    if snapshot is None:
        raise not_found("榜单快照")
    return snapshot


def _is_valid_external_id(external_id) -> bool:
    """校验外部商品 ID 合法性：非空字符串且长度合理。"""
    return isinstance(external_id, str) and 0 < len(external_id.strip()) <= 128


def upsert_entries(db: Session, snapshot: RankSnapshot, entries: list[dict]) -> dict:
    """批量 upsert 商品与榜单明细（单批 ≤200 条）。

    商品按 (platform, region, external_product_id) 去重：已存在则更新
    last_seen_at/title/shop/image/detail_url；rank_entries 按
    (snapshot_id, product_id) upsert。商品 ID 缺失/非法的条目进入
    rejected 列表不落库。

    :return: {"accepted": n, "rejected": [{index, reason, external_product_id}]}
    """
    if len(entries) > MAX_ENTRIES_BATCH:
        raise ApiError(
            "BATCH_TOO_LARGE",
            f"单批最多 {MAX_ENTRIES_BATCH} 条，收到 {len(entries)} 条",
            retryable=False,
        )

    accepted = 0
    rejected: list[dict] = []
    now = utcnow()

    for index, item in enumerate(entries):
        external_id = item.get("external_product_id")
        if not _is_valid_external_id(external_id):
            rejected.append(
                {
                    "index": index,
                    "reason": "INVALID_EXTERNAL_PRODUCT_ID",
                    "external_product_id": external_id,
                }
            )
            continue

        platform = item.get("platform") or "tiktok"
        region = item.get("region") or snapshot.region

        product = db.execute(
            select(Product).where(
                Product.platform == platform,
                Product.region == region,
                Product.external_product_id == external_id.strip(),
            )
        ).scalar_one_or_none()

        if product is None:
            product = Product(
                platform=platform,
                region=region,
                external_product_id=external_id.strip(),
                first_seen_at=now,
            )
            db.add(product)

        # 已存在商品允许名称/店铺/图片等字段随时间更新
        product.title = item.get("title") or product.title
        product.shop_id = item.get("shop_id") or product.shop_id
        product.shop_name = item.get("shop_name") or product.shop_name
        product.image_url = item.get("image_url") or product.image_url
        product.detail_url = item.get("detail_url") or product.detail_url
        product.last_seen_at = now
        if item.get("raw_excerpt") is not None:
            product.raw_excerpt = item["raw_excerpt"]
        db.flush()

        rank_position = item.get("rank_position")
        if not isinstance(rank_position, int) or rank_position <= 0:
            rejected.append(
                {
                    "index": index,
                    "reason": "INVALID_RANK_POSITION",
                    "external_product_id": external_id,
                }
            )
            db.flush()
            continue

        entry = db.execute(
            select(RankEntry).where(
                RankEntry.snapshot_id == snapshot.snapshot_id,
                RankEntry.product_id == product.id,
            )
        ).scalar_one_or_none()
        if entry is None:
            entry = RankEntry(snapshot_id=snapshot.snapshot_id, product_id=product.id)
            db.add(entry)
        entry.rank_position = rank_position
        entry.sales = item.get("sales")
        entry.gmv = item.get("gmv")
        entry.metrics_json = item.get("metrics_json")
        entry.raw_excerpt = item.get("raw_excerpt")
        entry.observed_at = now
        accepted += 1

    db.flush()
    snapshot.total_entries = db.execute(
        select(func.count(RankEntry.id)).where(RankEntry.snapshot_id == snapshot.snapshot_id)
    ).scalar_one()
    db.commit()
    return {"accepted": accepted, "rejected": rejected}


def finish_snapshot(db: Session, snapshot: RankSnapshot, status: str) -> RankSnapshot:
    """标记快照完成状态：COMPLETED / PARTIAL / FAILED。"""
    if status not in SNAPSHOT_FINAL_STATUSES:
        raise ApiError(
            "INVALID_SNAPSHOT_STATUS",
            f"快照终态必须为 {sorted(SNAPSHOT_FINAL_STATUSES)}",
            retryable=False,
        )
    snapshot.status = status
    snapshot.capture_finished_at = utcnow()
    db.commit()
    return snapshot


def list_snapshots(
    db: Session,
    client_id: str | None = None,
    region: str | None = None,
    ranking_type: str | None = None,
    category_id: str | None = None,
    status: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[RankSnapshot], int]:
    """按站点/榜单类型/分类/状态/日期范围筛选快照并分页。"""
    stmt = select(RankSnapshot)
    count_stmt = select(func.count(RankSnapshot.snapshot_id))
    filters = []
    if client_id:
        filters.append(RankSnapshot.client_id == client_id)
    if region:
        filters.append(RankSnapshot.region == region)
    if ranking_type:
        filters.append(RankSnapshot.ranking_type == ranking_type)
    if category_id:
        filters.append(RankSnapshot.category_id == category_id)
    if status:
        filters.append(RankSnapshot.status == status)
    if date_from:
        filters.append(RankSnapshot.capture_started_at >= date_from)
    if date_to:
        filters.append(RankSnapshot.capture_started_at <= date_to)
    for f in filters:
        stmt = stmt.where(f)
        count_stmt = count_stmt.where(f)
    total = db.execute(count_stmt).scalar_one()
    items = db.execute(
        stmt.order_by(RankSnapshot.capture_started_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
    ).scalars().all()
    return list(items), total


def _latest_task_status_subquery(db: Session):
    """构造子查询：每个商品最近一次任务的状态（用于 erp_status 推导）。"""
    latest_updated = (
        select(CollectionTask.product_id, func.max(CollectionTask.updated_at).label("max_updated"))
        .group_by(CollectionTask.product_id)
        .subquery()
    )
    latest_status = (
        select(CollectionTask.product_id, CollectionTask.status)
        .join(
            latest_updated,
            (CollectionTask.product_id == latest_updated.c.product_id)
            & (CollectionTask.updated_at == latest_updated.c.max_updated),
        )
        .subquery()
    )
    return latest_status


def list_products(
    db: Session,
    keyword: str | None = None,
    region: str | None = None,
    category: str | None = None,
    ranking_type: str | None = None,
    snapshot_date_from: datetime | None = None,
    snapshot_date_to: datetime | None = None,
    rank_min: int | None = None,
    rank_max: int | None = None,
    erp_status: str | None = None,
    sort: str = "last_seen_at",
    order: str = "desc",
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[dict], int]:
    """商品服务端筛选/排序/分页。

    erp_status 依据该商品最新任务状态推导，无任务时为 NEVER。
    分类筛选按分类名称匹配（categories.name 模糊匹配后映射快照 category_id）。
    """
    latest_status = _latest_task_status_subquery(db)

    stmt = select(Product, latest_status.c.status.label("erp_status")).outerjoin(
        latest_status, latest_status.c.product_id == Product.id
    )
    count_stmt = select(func.count(Product.id)).outerjoin(
        latest_status, latest_status.c.product_id == Product.id
    )

    if keyword:
        like = f"%{keyword}%"
        cond = (
            Product.title.like(like)
            | Product.external_product_id.like(like)
            | Product.shop_name.like(like)
        )
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)
    if region:
        stmt = stmt.where(Product.region == region)
        count_stmt = count_stmt.where(Product.region == region)

    # 需要关联榜单明细/快照的筛选条件
    need_entry_join = any(
        [category, ranking_type, snapshot_date_from, snapshot_date_to, rank_min, rank_max]
    ) or sort == "rank_position"
    if need_entry_join:
        stmt = stmt.join(RankEntry, RankEntry.product_id == Product.id).join(
            RankSnapshot, RankSnapshot.snapshot_id == RankEntry.snapshot_id
        )
        count_stmt = (
            select(func.count(func.distinct(Product.id)))
            .select_from(Product)
            .outerjoin(latest_status, latest_status.c.product_id == Product.id)
            .join(RankEntry, RankEntry.product_id == Product.id)
            .join(RankSnapshot, RankSnapshot.snapshot_id == RankEntry.snapshot_id)
        )
        if keyword:
            like = f"%{keyword}%"
            count_stmt = count_stmt.where(
                Product.title.like(like)
                | Product.external_product_id.like(like)
                | Product.shop_name.like(like)
            )
        if region:
            count_stmt = count_stmt.where(Product.region == region)

        if category:
            cat_ids = select(Category.external_category_id).where(Category.name.like(f"%{category}%"))
            stmt = stmt.where(RankSnapshot.category_id.in_(cat_ids))
            count_stmt = count_stmt.where(RankSnapshot.category_id.in_(cat_ids))
        if ranking_type:
            stmt = stmt.where(RankSnapshot.ranking_type == ranking_type)
            count_stmt = count_stmt.where(RankSnapshot.ranking_type == ranking_type)
        if snapshot_date_from:
            stmt = stmt.where(RankSnapshot.capture_started_at >= snapshot_date_from)
            count_stmt = count_stmt.where(RankSnapshot.capture_started_at >= snapshot_date_from)
        if snapshot_date_to:
            stmt = stmt.where(RankSnapshot.capture_started_at <= snapshot_date_to)
            count_stmt = count_stmt.where(RankSnapshot.capture_started_at <= snapshot_date_to)
        if rank_min is not None:
            stmt = stmt.where(RankEntry.rank_position >= rank_min)
            count_stmt = count_stmt.where(RankEntry.rank_position >= rank_min)
        if rank_max is not None:
            stmt = stmt.where(RankEntry.rank_position <= rank_max)
            count_stmt = count_stmt.where(RankEntry.rank_position <= rank_max)
        stmt = stmt.group_by(Product.id, latest_status.c.status)

    if erp_status:
        if erp_status == "NEVER":
            stmt = stmt.where(latest_status.c.status.is_(None))
            count_stmt = count_stmt.where(latest_status.c.status.is_(None))
        else:
            stmt = stmt.where(latest_status.c.status == erp_status)
            count_stmt = count_stmt.where(latest_status.c.status == erp_status)

    sortable = {
        "last_seen_at": Product.last_seen_at,
        "first_seen_at": Product.first_seen_at,
        "title": Product.title,
    }
    if sort == "rank_position":
        rank_col = func.min(RankEntry.rank_position)
        stmt = stmt.order_by(rank_col.asc() if order == "asc" else rank_col.desc())
    else:
        col = sortable.get(sort, Product.last_seen_at)
        stmt = stmt.order_by(col.asc() if order == "asc" else col.desc())

    total = db.execute(count_stmt).scalar_one()
    rows = db.execute(stmt.offset((page - 1) * per_page).limit(per_page)).all()

    items = []
    for product, status in rows:
        items.append({"product": product, "erp_status": status or "NEVER"})
    return items, total


def get_product_or_404(db: Session, product_id: str) -> Product:
    """查询商品，不存在抛 404。"""
    product = db.get(Product, product_id)
    if product is None:
        raise not_found("商品")
    return product


def product_rank_history(db: Session, product_id: str) -> list[tuple[RankEntry, RankSnapshot]]:
    """查询商品全部榜单历史（rank_entries 关联快照信息，按时间倒序）。"""
    rows = db.execute(
        select(RankEntry, RankSnapshot)
        .join(RankSnapshot, RankSnapshot.snapshot_id == RankEntry.snapshot_id)
        .where(RankEntry.product_id == product_id)
        .order_by(RankEntry.observed_at.desc())
    ).all()
    return [(entry, snapshot) for entry, snapshot in rows]
