"""任务租约服务：排他领取、租约心跳、事件记录、幂等结果提交。"""

import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, select, update
from sqlalchemy.orm import Session

from app.config import LEASE_TTL_SECONDS
from app.models import CollectionAttempt, CollectionBatch, CollectionTask, TaskEvent
from app.models.orm import new_id, utcnow
from app.services import batch_service, idempotency
from app.services.errors import ApiError, conflict, not_found

# 租约过期后允许被重新领取的任务状态
RECLAIMABLE_STATUSES = {"LEASED", "NAVIGATING", "PAGE_READY", "SUBMITTING"}

# 合法的任务最终结果
FINAL_RESULTS = {"SUCCESS", "FAILED", "UNKNOWN", "SKIPPED"}


def release_expired_leases(db: Session, batch_id: str | None = None) -> int:
    """把租约已过期且仍处于进行中阶段的任务重置回 PENDING，返回重置数量。"""
    now = utcnow()
    stmt = (
        update(CollectionTask)
        .where(
            CollectionTask.status.in_(RECLAIMABLE_STATUSES),
            CollectionTask.lease_expires_at.is_not(None),
            CollectionTask.lease_expires_at < now,
        )
        .values(
            status="PENDING",
            claimed_by_client_id=None,
            lease_token=None,
            lease_expires_at=None,
            updated_at=now,
        )
    )
    if batch_id:
        stmt = stmt.where(CollectionTask.batch_id == batch_id)
    result = db.execute(stmt)
    return result.rowcount


def claim_task(
    db: Session, client_id: str, batch_id: str, request_id: str
) -> tuple[CollectionTask, CollectionAttempt] | None:
    """排他领取批次下一条 PENDING 任务。

    - request_id 幂等：重复领取返回首次领取的任务与新凭证内容（来自事件存档）。
    - 批次非 RUNNING 拒绝；领取前先把过期租约任务重置回 PENDING。
    - 条件更新（WHERE status='PENDING'）保证并发下只有一个领取成功。
    - 无可领任务时返回 None（data 为 null，属正常流程）。
    """
    replay = idempotency.find_claim_event(db, request_id)
    if replay is not None:
        task = db.get(CollectionTask, replay.task_id)
        attempt_id = (replay.payload_json or {}).get("attempt_id")
        attempt = db.get(CollectionAttempt, attempt_id) if attempt_id else None
        if task is not None and attempt is not None:
            return task, attempt

    batch = batch_service.get_batch_or_404(db, batch_id)
    if batch.client_id != client_id:
        from app.services.errors import forbidden

        raise forbidden("批次不属于当前客户端")
    if batch.status != "RUNNING":
        raise conflict("BATCH_NOT_RUNNING", f"批次状态 {batch.status} 不允许领取任务")

    try:
        release_expired_leases(db, batch_id)

        # 已成功采集过的商品直接跳过，避免重复打开 TikTok 详情页
        successful_products = batch_service._successful_product_ids(db, client_id)

        claimed: CollectionTask | None = None
        exhausted = False
        while claimed is None and not exhausted:
            candidate_ids = db.execute(
                select(CollectionTask.task_id)
                .where(
                    CollectionTask.batch_id == batch_id,
                    CollectionTask.status == "PENDING",
                )
                # 手动“重新抓取”的任务优先领取
                .order_by(
                    case((CollectionTask.last_error_code == "FORCE_RECOLLECT", 0), else_=1),
                    CollectionTask.created_at.asc(),
                )
                .limit(10)
            ).scalars().all()
            if not candidate_ids:
                exhausted = True
                break

            for task_id in candidate_ids:
                candidate = db.get(CollectionTask, task_id)
                if candidate is None:
                    continue
                # FORCE_RECOLLECT：用户明确要求重新抓取，跳过去重
                if (
                    candidate.last_error_code != "FORCE_RECOLLECT"
                    and candidate.product_id in successful_products
                ):
                    candidate.status = "SKIPPED"
                    candidate.last_error_code = "DUPLICATE_ALREADY_COLLECTED"
                    candidate.updated_at = utcnow()
                    continue
                now = utcnow()
                lease_token = secrets.token_urlsafe(24)
                lease_expires = now + timedelta(seconds=LEASE_TTL_SECONDS)
                res = db.execute(
                    update(CollectionTask)
                    .where(
                        CollectionTask.task_id == task_id,
                        CollectionTask.status == "PENDING",
                    )
                    .values(
                        status="LEASED",
                        claimed_by_client_id=client_id,
                        lease_token=lease_token,
                        lease_expires_at=lease_expires,
                        updated_at=now,
                    )
                )
                if res.rowcount == 1:
                    claimed = db.get(CollectionTask, task_id)
                    break

            # 会话未开启 autoflush，显式落盘跳过状态，避免下一轮重复查询同一批任务
            if claimed is None:
                db.flush()

        if claimed is None:
            # 全部任务被去重跳过时，批次应正常收敛到终态
            batch = db.get(CollectionBatch, batch_id)
            if batch is not None:
                batch_service.maybe_finalize_batch(db, batch)
            db.commit()
            return None

        attempt = CollectionAttempt(
            task_id=claimed.task_id,
            client_id=client_id,
            started_at=utcnow(),
            stage="LEASED",
        )
        db.add(attempt)
        db.flush()
        claimed.attempt_count += 1

        # 领取事件存档用于 request_id 幂等重放
        db.add(
            TaskEvent(
                event_id=request_id,
                task_id=claimed.task_id,
                batch_id=batch_id,
                client_id=client_id,
                event_type="TASK_CLAIMED",
                payload_json={
                    "attempt_id": attempt.attempt_id,
                    "lease_token": claimed.lease_token,
                    "lease_expires_at": claimed.lease_expires_at.isoformat(),
                },
                occurred_at=utcnow(),
                received_at=utcnow(),
            )
        )
        db.commit()
        return claimed, attempt
    except Exception:
        db.rollback()
        raise


def heartbeat_task(
    db: Session,
    client_id: str,
    task_id: str,
    lease_token: str,
    stage: str | None = None,
) -> CollectionTask:
    """校验租约并延长租约、更新任务阶段。"""
    task = db.get(CollectionTask, task_id)
    if task is None:
        raise not_found("任务")
    batch = batch_service.get_batch_or_404(db, task.batch_id)
    if batch.client_id != client_id:
        from app.services.errors import forbidden

        raise forbidden("任务不属于当前客户端")
    if task.lease_token != lease_token:
        raise conflict("LEASE_MISMATCH", "lease_token 不匹配")
    if task.lease_expires_at is not None and task.lease_expires_at < utcnow():
        raise conflict("LEASE_EXPIRED", "租约已过期，请重新领取任务", retryable=True)

    if stage:
        if stage not in RECLAIMABLE_STATUSES | {"SUBMITTED", "WAITING_VERIFICATION"}:
            raise ApiError("VALIDATION_ERROR", f"非法任务阶段 {stage}", retryable=False)
        task.status = stage
    task.lease_expires_at = utcnow() + timedelta(seconds=LEASE_TTL_SECONDS)
    db.commit()
    return task


def add_task_event(
    db: Session,
    client_id: str,
    task_id: str | None,
    batch_id: str,
    event_id: str,
    event_type: str,
    payload: dict | None,
    occurred_at: datetime | None,
) -> tuple[TaskEvent, bool]:
    """写入任务事件；event_id 幂等去重（重复上报返回原事件）。"""
    existing = idempotency.find_event(db, event_id)
    if existing is not None:
        return existing, False

    batch = batch_service.get_batch_or_404(db, batch_id)
    if batch.client_id != client_id:
        from app.services.errors import forbidden

        raise forbidden("批次不属于当前客户端")
    if task_id is not None and db.get(CollectionTask, task_id) is None:
        raise not_found("任务")

    event = TaskEvent(
        event_id=event_id,
        task_id=task_id,
        batch_id=batch_id,
        client_id=client_id,
        event_type=event_type,
        payload_json=payload or {},
        occurred_at=occurred_at or utcnow(),
        received_at=utcnow(),
    )
    db.add(event)
    db.commit()
    return event, True


def _latest_attempt(db: Session, task_id: str) -> CollectionAttempt | None:
    """查询任务最近一次尝试。"""
    return db.execute(
        select(CollectionAttempt)
        .where(CollectionAttempt.task_id == task_id)
        .order_by(CollectionAttempt.started_at.desc(), CollectionAttempt.attempt_id.desc())
        .limit(1)
    ).scalar_one_or_none()


def submit_result(
    db: Session,
    client_id: str,
    task_id: str,
    attempt_id: str,
    lease_token: str | None,
    result: str,
    error_code: str | None = None,
    evidence: dict | None = None,
    elapsed_ms: int | None = None,
) -> CollectionTask:
    """按 attempt_id 幂等提交任务最终结果。

    规则：
    - attempt 已有结果 → 幂等返回当前任务状态（不覆盖）。
    - 仅接受"当前最新 attempt"的上报，旧 attempt 不能覆盖新结果。
    - lease_token 匹配，或租约已过期但该 attempt 仍为最新 attempt 时接受上报。
    - 提交后任务进入终态、清除租约；批次全部终态后自动聚合完成。
    """
    if result not in FINAL_RESULTS:
        raise ApiError(
            "VALIDATION_ERROR", f"非法结果 {result}，允许 {sorted(FINAL_RESULTS)}", retryable=False
        )

    task = db.get(CollectionTask, task_id)
    if task is None:
        raise not_found("任务")
    batch = batch_service.get_batch_or_404(db, task.batch_id)
    if batch.client_id != client_id:
        from app.services.errors import forbidden

        raise forbidden("任务不属于当前客户端")

    attempt = db.get(CollectionAttempt, attempt_id)
    if attempt is None or attempt.task_id != task_id:
        raise not_found("采集尝试")

    if attempt.result is not None:
        # 幂等重放：同一 attempt 重复提交直接返回现状
        return task

    latest = _latest_attempt(db, task_id)
    if latest is None or latest.attempt_id != attempt_id:
        raise conflict("ATTEMPT_SUPERSEDED", "存在更新的采集尝试，旧 attempt 不允许覆盖结果")

    lease_ok = lease_token is not None and task.lease_token == lease_token
    lease_expired = task.lease_expires_at is None or task.lease_expires_at < utcnow()
    if not lease_ok and not lease_expired:
        raise conflict("LEASE_MISMATCH", "lease_token 不匹配且租约未过期")

    now = utcnow()
    attempt.result = result
    attempt.finished_at = now
    attempt.evidence_json = evidence or {}
    attempt.error_code = error_code
    attempt.elapsed_ms = elapsed_ms

    task.status = result
    task.last_error_code = error_code
    task.claimed_by_client_id = None
    task.lease_token = None
    task.lease_expires_at = None
    task.updated_at = now
    db.flush()

    batch_service.maybe_finalize_batch(db, batch)
    db.commit()
    return task


def get_active_task(db: Session, client_id: str) -> tuple[CollectionTask, CollectionAttempt | None] | None:
    """查询客户端当前租约中的任务（MV3 重启恢复入口）。"""
    now = utcnow()
    task = db.execute(
        select(CollectionTask)
        .join(CollectionBatch, CollectionBatch.batch_id == CollectionTask.batch_id)
        .where(
            CollectionBatch.client_id == client_id,
            CollectionTask.claimed_by_client_id == client_id,
            CollectionTask.status.in_(RECLAIMABLE_STATUSES | {"SUBMITTED", "WAITING_VERIFICATION"}),
            CollectionTask.lease_expires_at.is_not(None),
            CollectionTask.lease_expires_at >= now,
        )
        .order_by(CollectionTask.updated_at.desc())
        .limit(1)
    ).scalar_one_or_none()
    if task is None:
        return None
    return task, _latest_attempt(db, task.task_id)


def list_attempts(
    db: Session,
    batch_id: str | None = None,
    task_id: str | None = None,
    result: str | None = None,
    error_code: str | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    scope_client_id: str | None = None,
    page: int = 1,
    per_page: int = 20,
) -> tuple[list[CollectionAttempt], int]:
    """采集尝试日志按时间/批次/任务/结果/错误码筛选分页。

    scope_client_id 非空时仅返回该客户端批次下的尝试记录。
    """
    from sqlalchemy import func

    stmt = select(CollectionAttempt)
    count_stmt = select(func.count(CollectionAttempt.attempt_id))
    if scope_client_id:
        own_batches = select(CollectionBatch.batch_id).where(
            CollectionBatch.client_id == scope_client_id
        )
        scoped_task_ids = select(CollectionTask.task_id).where(
            CollectionTask.batch_id.in_(own_batches)
        )
        stmt = stmt.where(CollectionAttempt.task_id.in_(scoped_task_ids))
        count_stmt = count_stmt.where(CollectionAttempt.task_id.in_(scoped_task_ids))
    if task_id:
        stmt = stmt.where(CollectionAttempt.task_id == task_id)
        count_stmt = count_stmt.where(CollectionAttempt.task_id == task_id)
    if batch_id:
        task_ids = select(CollectionTask.task_id).where(CollectionTask.batch_id == batch_id)
        stmt = stmt.where(CollectionAttempt.task_id.in_(task_ids))
        count_stmt = count_stmt.where(CollectionAttempt.task_id.in_(task_ids))
    if result:
        stmt = stmt.where(CollectionAttempt.result == result)
        count_stmt = count_stmt.where(CollectionAttempt.result == result)
    if error_code:
        stmt = stmt.where(CollectionAttempt.error_code == error_code)
        count_stmt = count_stmt.where(CollectionAttempt.error_code == error_code)
    if date_from:
        stmt = stmt.where(CollectionAttempt.started_at >= date_from)
        count_stmt = count_stmt.where(CollectionAttempt.started_at >= date_from)
    if date_to:
        stmt = stmt.where(CollectionAttempt.started_at <= date_to)
        count_stmt = count_stmt.where(CollectionAttempt.started_at <= date_to)
    total = db.execute(count_stmt).scalar_one()
    items = db.execute(
        stmt.order_by(CollectionAttempt.started_at.desc())
        .offset((page - 1) * per_page)
        .limit(per_page)
    ).scalars().all()
    return list(items), total
