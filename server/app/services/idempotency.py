"""幂等性辅助：request_id / idempotency_key / event_id / attempt_id 去重。"""

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import CollectionBatch, RankSnapshot, TaskEvent


def find_snapshot_by_request_id(db: Session, request_id: str) -> RankSnapshot | None:
    """按 request_id 查询已存在的榜单快照（快照创建幂等）。"""
    return db.execute(
        select(RankSnapshot).where(RankSnapshot.request_id == request_id)
    ).scalar_one_or_none()


def find_batch_by_idempotency_key(db: Session, key: str) -> CollectionBatch | None:
    """按 idempotency_key 查询已存在的批次（批次创建幂等）。"""
    return db.execute(
        select(CollectionBatch).where(CollectionBatch.idempotency_key == key)
    ).scalar_one_or_none()


def find_event(db: Session, event_id: str) -> TaskEvent | None:
    """按 event_id 查询已记录事件（事件上报幂等去重）。"""
    return db.get(TaskEvent, event_id)


def find_claim_event(db: Session, request_id: str) -> TaskEvent | None:
    """按 request_id 查询任务领取事件（claim 幂等，原响应存于 payload_json）。"""
    return db.execute(
        select(TaskEvent).where(
            TaskEvent.event_id == request_id,
            TaskEvent.event_type == "TASK_CLAIMED",
        )
    ).scalar_one_or_none()
