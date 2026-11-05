"""采集批次服务：创建（幂等/排除已成功）、状态机控制、补采、聚合进度。"""

from datetime import datetime

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from app.models import CollectionBatch, CollectionTask, Product, RankEntry
from app.models.orm import utcnow
from app.services import idempotency
from app.services.errors import ApiError, conflict, not_found

# 批次终态与"占用中"状态（同一客户端同时只允许一个占用中批次）
BATCH_ACTIVE_STATUSES = {"RUNNING", "PAUSED", "WAITING_VERIFICATION", "RECOVERING"}
BATCH_TERMINAL_STATUSES = {"COMPLETED", "COMPLETED_WITH_ERRORS", "CANCELLED"}

# 任务终态：批次完成判定依据
TASK_TERMINAL_STATUSES = {"SUCCESS", "SKIPPED", "FAILED", "UNKNOWN"}


def _successful_product_ids(db: Session, client_id: str) -> set[str]:
    """查询该客户端下已存在 SUCCESS 任务的商品 ID 集合。"""
    rows = db.execute(
        select(CollectionTask.product_id)
        .join(CollectionBatch, CollectionBatch.batch_id == CollectionTask.batch_id)
        .where(
            CollectionBatch.client_id == client_id,
            CollectionTask.status == "SUCCESS",
        )
    ).all()
    return {row[0] for row in rows}


def create_batch(
    db: Session,
    client_id: str,
    idempotency_key: str,
    snapshot_id: str | None = None,
    product_ids: list[str] | None = None,
    exclude_already_successful: bool = False,
    config: dict | None = None,
    force: bool = False,
    parent_batch_id: str | None = None,
    recollect: bool = False,
) -> tuple[CollectionBatch, bool, int | None]:
    """创建采集批次。

    - idempotency_key 幂等：重复提交返回原批次（created=False）。
    - 同一客户端存在占用中批次（RUNNING/PAUSED/WAITING_VERIFICATION/RECOVERING）
      时拒绝新建，除非 force=True。
    - exclude_already_successful=True 时排除该客户端已 SUCCESS 的商品。
    - recollect=True 时新任务带 FORCE_RECOLLECT 标记，领取阶段跳过去重（单商品测试用）。

    :return: (批次, 是否新建, 被排除的商品数；幂等重放时为 None)
    """
    existing = idempotency.find_batch_by_idempotency_key(db, idempotency_key)
    if existing is not None:
        return existing, False, None

    if not force:
        active = db.execute(
            select(CollectionBatch).where(
                CollectionBatch.client_id == client_id,
                CollectionBatch.status.in_(BATCH_ACTIVE_STATUSES),
            )
        ).scalars().first()
        if active is not None:
            raise conflict(
                "BATCH_ALREADY_ACTIVE",
                f"客户端已存在进行中的批次 {active.batch_id}，请先完成/取消或使用 force",
            )

    # 汇总候选商品：优先显式 product_ids，否则取快照全部明细（按排名升序）
    candidates: list[str] = []
    if product_ids:
        candidates = list(dict.fromkeys(product_ids))
    elif snapshot_id:
        rows = db.execute(
            select(RankEntry.product_id)
            .where(RankEntry.snapshot_id == snapshot_id)
            .order_by(RankEntry.rank_position.asc())
        ).all()
        candidates = [row[0] for row in rows]
    else:
        raise ApiError("VALIDATION_ERROR", "必须提供 snapshot_id 或 product_ids", retryable=False)

    if not candidates:
        raise ApiError("EMPTY_BATCH", "批次不包含任何商品", retryable=False)

    # 校验商品存在性
    existing_ids = set(
        db.execute(select(Product.id).where(Product.id.in_(candidates))).scalars().all()
    )
    missing = [pid for pid in candidates if pid not in existing_ids]
    if missing:
        raise not_found(f"商品 {missing[:3]} 等 {len(missing)} 个")

    skipped = 0
    if exclude_already_successful:
        done = _successful_product_ids(db, client_id)
        before = len(candidates)
        candidates = [pid for pid in candidates if pid not in done]
        skipped = before - len(candidates)

    if not candidates:
        raise ApiError("EMPTY_BATCH", "排除已成功商品后批次为空", retryable=False)

    batch = CollectionBatch(
        client_id=client_id,
        source_snapshot_id=snapshot_id,
        parent_batch_id=parent_batch_id,
        status="READY",
        config_json=config or {},
        idempotency_key=idempotency_key,
        created_at=utcnow(),
    )
    db.add(batch)
    db.flush()

    now = utcnow()
    for pid in candidates:
        db.add(
            CollectionTask(
                batch_id=batch.batch_id,
                product_id=pid,
                status="PENDING",
                # 强制重抓标记：领取阶段据此跳过去重
                last_error_code="FORCE_RECOLLECT" if recollect else None,
                created_at=now,
                updated_at=now,
            )
        )
    db.commit()
    return batch, True, skipped


def batch_summary(db: Session, batch_id: str) -> dict:
    """聚合批次各状态任务计数，供批次详情/列表展示进度。"""
    rows = db.execute(
        select(CollectionTask.status, func.count())
        .where(CollectionTask.batch_id == batch_id)
        .group_by(CollectionTask.status)
    ).all()
    counts = {status: n for status, n in rows}
    total = sum(counts.values())
    return {
        "total": total,
        "by_status": counts,
        "terminal": sum(n for s, n in counts.items() if s in TASK_TERMINAL_STATUSES),
    }


def maybe_finalize_batch(db: Session, batch: CollectionBatch) -> None:
    """批次所有任务进入终态后自动更新批次为 COMPLETED / COMPLETED_WITH_ERRORS。"""
    if batch.status in BATCH_TERMINAL_STATUSES:
        return
    summary = batch_summary(db, batch.batch_id)
    if summary["total"] == 0 or summary["terminal"] < summary["total"]:
        return
    counts = summary["by_status"]
    has_error = counts.get("FAILED", 0) > 0 or counts.get("UNKNOWN", 0) > 0
    batch.status = "COMPLETED_WITH_ERRORS" if has_error else "COMPLETED"
    batch.finished_at = utcnow()
    batch.summary_json = summary
    db.commit()


def get_batch_or_404(db: Session, batch_id: str) -> CollectionBatch:
    """查询批次，不存在抛 404。"""
    batch = db.get(CollectionBatch, batch_id)
    if batch is None:
        raise not_found("批次")
    return batch


def list_batches(
    db: Session,
    client_id: str | None = None,
    status: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[CollectionBatch], int]:
    """批次列表筛选分页。"""
    stmt = select(CollectionBatch)
    count_stmt = select(func.count(CollectionBatch.batch_id))
    filters = []
    if client_id:
        filters.append(CollectionBatch.client_id == client_id)
    if status:
        filters.append(CollectionBatch.status == status)
    if date_from:
        filters.append(CollectionBatch.created_at >= date_from)
    if date_to:
        filters.append(CollectionBatch.created_at <= date_to)
    for f in filters:
        stmt = stmt.where(f)
        count_stmt = count_stmt.where(f)
    total = db.execute(count_stmt).scalar_one()
    items = db.execute(
        stmt.order_by(CollectionBatch.created_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
    ).scalars().all()
    return list(items), total


def control_batch(db: Session, batch: CollectionBatch, action: str) -> CollectionBatch:
    """批次状态机：start / pause / resume / cancel。

    - start：READY/PAUSED → RUNNING；CANCELLED 批次重新开始（未完成任务重置为 PENDING）
    - pause：RUNNING → PAUSED（停止领取新任务；进行中租约保持到结果或过期）
    - resume：PAUSED → RUNNING
    - cancel：非终态 → CANCELLED（终止后续领取，不抹历史）
    """
    now = utcnow()
    if action == "start":
        if batch.status == "RUNNING":
            return batch
        if batch.status == "CANCELLED":
            # 重新开始已停止批次：重置未完成任务后继续，避免另建批次丢失上下文
            active = db.execute(
                select(CollectionBatch).where(
                    CollectionBatch.client_id == batch.client_id,
                    CollectionBatch.status.in_(BATCH_ACTIVE_STATUSES),
                    CollectionBatch.batch_id != batch.batch_id,
                )
            ).scalars().first()
            if active is not None:
                raise conflict("BATCH_ALREADY_ACTIVE", "已有进行中的批次，请先停止后再重新开始")
            restartable = {
                "PENDING", "LEASED", "NAVIGATING", "PAGE_READY", "SUBMITTING",
                "SUBMITTED", "WAITING_VERIFICATION", "FAILED",
            }
            count = db.execute(
                select(func.count())
                .select_from(CollectionTask)
                .where(
                    CollectionTask.batch_id == batch.batch_id,
                    CollectionTask.status.in_(restartable),
                )
            ).scalar_one()
            if count == 0:
                raise conflict("INVALID_STATE", "批次已无可重新开始的任务")
            # 保持 SUCCESS/SKIPPED/UNKNOWN 终态，其余回到待领取
            db.execute(
                update(CollectionTask)
                .where(
                    CollectionTask.batch_id == batch.batch_id,
                    CollectionTask.status.in_(restartable),
                )
                .values(
                    status="PENDING",
                    lease_token=None,
                    lease_expires_at=None,
                    claimed_by_client_id=None,
                    updated_at=now,
                )
            )
            batch.status = "RUNNING"
            batch.finished_at = None
            batch.summary_json = None
            if batch.started_at is None:
                batch.started_at = now
            db.commit()
            return batch
        if batch.status not in {"READY", "PAUSED"}:
            raise conflict("INVALID_STATE", f"批次状态 {batch.status} 不允许 start")
        batch.status = "RUNNING"
        if batch.started_at is None:
            batch.started_at = now
    elif action == "pause":
        if batch.status == "PAUSED":
            return batch
        if batch.status != "RUNNING":
            raise conflict("INVALID_STATE", f"批次状态 {batch.status} 不允许 pause")
        batch.status = "PAUSED"
    elif action == "resume":
        if batch.status == "RUNNING":
            return batch
        if batch.status != "PAUSED":
            raise conflict("INVALID_STATE", f"批次状态 {batch.status} 不允许 resume")
        batch.status = "RUNNING"
    elif action == "cancel":
        if batch.status in BATCH_TERMINAL_STATUSES:
            raise conflict("INVALID_STATE", f"批次已处于终态 {batch.status}")
        batch.status = "CANCELLED"
        batch.finished_at = now
    else:
        raise ApiError("VALIDATION_ERROR", f"未知批次操作 {action}", retryable=False)
    db.commit()
    return batch


def retry_failed(
    db: Session,
    client_id: str,
    source_batch: CollectionBatch,
    idempotency_key: str,
    statuses: list[str] | None = None,
    force: bool = False,
) -> tuple[CollectionBatch, bool, int | None]:
    """创建补采批次：默认仅含原批次 FAILED 任务的商品，parent_batch_id 关联原批次。

    UNKNOWN 不纳入普通失败重试（须先核对 ERP 侧结果）。
    """
    allowed = {"FAILED"}
    statuses = statuses or ["FAILED"]
    invalid = set(statuses) - allowed
    if invalid:
        raise ApiError(
            "VALIDATION_ERROR",
            f"补采仅支持 FAILED 状态任务，不支持 {sorted(invalid)}（UNKNOWN 需人工核实后强制重抓）",
            retryable=False,
        )
    rows = db.execute(
        select(CollectionTask.product_id).where(
            CollectionTask.batch_id == source_batch.batch_id,
            CollectionTask.status.in_(statuses),
        )
    ).all()
    product_ids = [row[0] for row in rows]
    if not product_ids:
        raise ApiError("EMPTY_BATCH", "原批次没有符合补采条件的失败任务", retryable=False)
    return create_batch(
        db,
        client_id=client_id,
        idempotency_key=idempotency_key,
        product_ids=product_ids,
        exclude_already_successful=False,
        config={"retry_of": source_batch.batch_id},
        force=force,
        parent_batch_id=source_batch.batch_id,
    )


def recollect_task(db: Session, client_id: str, task_id: str) -> CollectionTask:
    """单条“重新抓取”：把已跳过/失败/不确定的任务重置为 PENDING 并强制跳过去重。

    若所属批次已结束，会重新置为 RUNNING，便于客户端立即领取该任务。
    """
    task = db.get(CollectionTask, task_id)
    if task is None:
        raise not_found("任务")
    batch = db.get(CollectionBatch, task.batch_id)
    if batch is None:
        raise not_found("批次")
    if batch.client_id != client_id:
        from app.services.errors import forbidden

        raise forbidden("任务不属于当前客户端")
    if task.status not in {"SKIPPED", "FAILED", "UNKNOWN"}:
        raise conflict("INVALID_STATE", f"任务状态 {task.status} 不允许重新抓取")
    if batch.status in BATCH_TERMINAL_STATUSES or batch.status == "PAUSED":
        active = db.execute(
            select(CollectionBatch).where(
                CollectionBatch.client_id == client_id,
                CollectionBatch.status.in_(BATCH_ACTIVE_STATUSES),
                CollectionBatch.batch_id != batch.batch_id,
            )
        ).scalars().first()
        if active is not None:
            raise conflict("BATCH_ALREADY_ACTIVE", "已有进行中的批次，请先停止后再重新抓取")
        batch.status = "RUNNING"
        batch.finished_at = None
        batch.summary_json = None
    task.status = "PENDING"
    # 该错误码同时作为“强制重抓”标记，领取时跳过去重
    task.last_error_code = "FORCE_RECOLLECT"
    task.claimed_by_client_id = None
    task.lease_token = None
    task.lease_expires_at = None
    task.updated_at = utcnow()
    db.commit()
    return task


def list_tasks(
    db: Session,
    batch_id: str,
    status: str | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[CollectionTask], int]:
    """批次任务明细按状态筛选分页。"""
    stmt = select(CollectionTask).where(CollectionTask.batch_id == batch_id)
    count_stmt = select(func.count(CollectionTask.task_id)).where(
        CollectionTask.batch_id == batch_id
    )
    if status:
        stmt = stmt.where(CollectionTask.status == status)
        count_stmt = count_stmt.where(CollectionTask.status == status)
    total = db.execute(count_stmt).scalar_one()
    items = db.execute(
        stmt.order_by(CollectionTask.created_at.asc())
        .offset((page - 1) * per_page)
        .limit(per_page)
    ).scalars().all()
    return list(items), total
