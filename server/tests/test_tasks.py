"""任务领取、租约、结果幂等、补采与批次聚合测试。"""

from datetime import timedelta

from app.models import CollectionTask
from app.models.orm import utcnow
from tests.conftest import (
    claim,
    create_batch,
    list_product_ids,
    make_snapshot_with_entries,
    register_client,
)


def _setup_running_batch(client, ctx, n=2, idem="run-1"):
    """创建 n 商品批次并 start，返回 batch 数据。"""
    make_snapshot_with_entries(client, ctx["headers"], n=n, request_id=f"snap-{idem}")
    product_ids = list_product_ids(client, ctx["headers"])[:n]
    batch = create_batch(client, ctx["headers"], idem, product_ids=product_ids)
    client.post(f"/v1/batches/{batch['batch_id']}/start", headers=ctx["headers"])
    return batch


def _submit(client, headers, claimed, result, error_code=None):
    """提交任务结果并返回响应。"""
    return client.post(
        f"/v1/tasks/{claimed['task_id']}/result",
        json={
            "attempt_id": claimed["attempt_id"],
            "lease_token": claimed["lease_token"],
            "result": result,
            "error_code": error_code,
        },
        headers=headers,
    )


def test_claim_exclusive_and_exhaustion(client):
    """同一批次连续两次 claim 返回不同任务，领完后返回 null。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=2)

    first = claim(client, ctx["headers"], batch["batch_id"], "c1")
    second = claim(client, ctx["headers"], batch["batch_id"], "c2")
    assert first["task_id"] != second["task_id"]
    assert first["product"]["detail_url"]
    assert first["lease_token"] != second["lease_token"]

    third = claim(client, ctx["headers"], batch["batch_id"], "c3")
    assert third is None


def test_claim_idempotent(client):
    """相同 request_id 重复 claim 返回同一任务与凭证。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=2)
    r1 = claim(client, ctx["headers"], batch["batch_id"], "same-req")
    r2 = claim(client, ctx["headers"], batch["batch_id"], "same-req")
    assert r1["task_id"] == r2["task_id"]
    assert r1["attempt_id"] == r2["attempt_id"]
    assert r1["lease_token"] == r2["lease_token"]


def test_claim_requires_running_batch(client):
    """批次非 RUNNING 时拒绝领取。"""
    ctx = register_client(client)
    make_snapshot_with_entries(client, ctx["headers"], n=1)
    product_ids = list_product_ids(client, ctx["headers"])
    batch = create_batch(client, ctx["headers"], "not-running", product_ids=product_ids)
    resp = client.post(
        "/v1/tasks/claim",
        json={"batch_id": batch["batch_id"], "request_id": "x1"},
        headers=ctx["headers"],
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "BATCH_NOT_RUNNING"


def test_lease_expired_reclaim(client, db_session):
    """租约过期后任务回到 PENDING 并可被再次领取（新 attempt）。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=1)
    first = claim(client, ctx["headers"], batch["batch_id"], "l1")

    task = db_session.get(CollectionTask, first["task_id"])
    task.lease_expires_at = utcnow() - timedelta(seconds=1)
    db_session.commit()

    second = claim(client, ctx["headers"], batch["batch_id"], "l2")
    assert second["task_id"] == first["task_id"]
    assert second["attempt_id"] != first["attempt_id"]

    events = client.get(
        "/v1/attempts", params={"batch_id": batch["batch_id"]}, headers=ctx["headers"]
    ).json()["data"]
    assert events["total"] == 2


def test_task_heartbeat_extends_lease(client):
    """租约心跳延长租约并更新阶段。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=1)
    got = claim(client, ctx["headers"], batch["batch_id"], "hb1")
    resp = client.post(
        f"/v1/tasks/{got['task_id']}/heartbeat",
        json={"lease_token": got["lease_token"], "stage": "NAVIGATING"},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "NAVIGATING"

    resp = client.post(
        f"/v1/tasks/{got['task_id']}/heartbeat",
        json={"lease_token": "bad-token"},
        headers=ctx["headers"],
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "LEASE_MISMATCH"


def test_result_idempotent(client):
    """同一 attempt_id 重复提交结果不覆盖，返回一致终态。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=1)
    got = claim(client, ctx["headers"], batch["batch_id"], "r1")

    r1 = _submit(client, ctx["headers"], got, "FAILED", error_code="PAGE_TIMEOUT")
    assert r1.status_code == 200
    r2 = _submit(client, ctx["headers"], got, "SUCCESS")
    assert r2.status_code == 200
    assert r1.json()["data"]["status"] == "FAILED"
    assert r2.json()["data"]["status"] == "FAILED"

    attempts = client.get(
        "/v1/attempts", params={"batch_id": batch["batch_id"]}, headers=ctx["headers"]
    ).json()["data"]
    assert attempts["total"] == 1
    assert attempts["items"][0]["error_code"] == "PAGE_TIMEOUT"


def test_old_attempt_cannot_overwrite(client, db_session):
    """旧 attempt 上报被拒绝（不能覆盖新尝试）。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=1)
    first = claim(client, ctx["headers"], batch["batch_id"], "o1")

    task = db_session.get(CollectionTask, first["task_id"])
    task.lease_expires_at = utcnow() - timedelta(seconds=1)
    db_session.commit()
    second = claim(client, ctx["headers"], batch["batch_id"], "o2")

    resp = _submit(client, ctx["headers"], first, "SUCCESS")
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "ATTEMPT_SUPERSEDED"

    ok_resp = _submit(client, ctx["headers"], second, "SUCCESS")
    assert ok_resp.status_code == 200


def test_result_accepted_after_lease_expired(client, db_session):
    """租约过期但该 attempt 仍为最新时，结果上报被接受。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=1)
    got = claim(client, ctx["headers"], batch["batch_id"], "e1")

    task = db_session.get(CollectionTask, got["task_id"])
    task.lease_expires_at = utcnow() - timedelta(seconds=1)
    db_session.commit()

    resp = _submit(client, ctx["headers"], got, "SUCCESS")
    assert resp.status_code == 200
    assert resp.json()["data"]["status"] == "SUCCESS"


def test_unknown_not_in_retry_failed(client):
    """UNKNOWN 不进入普通失败重抓批次；retry-failed 仅含 FAILED。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=2)
    t1 = claim(client, ctx["headers"], batch["batch_id"], "u1")
    _submit(client, ctx["headers"], t1, "UNKNOWN")
    t2 = claim(client, ctx["headers"], batch["batch_id"], "u2")
    _submit(client, ctx["headers"], t2, "FAILED", error_code="NAV_FAILED")

    resp = client.post(
        f"/v1/batches/{batch['batch_id']}/retry-failed",
        json={"idempotency_key": "retry-1"},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200
    retry = resp.json()["data"]
    assert retry["parent_batch_id"] == batch["batch_id"]
    assert retry["summary"]["total"] == 1

    tasks = client.get(
        f"/v1/batches/{retry['batch_id']}/tasks", headers=ctx["headers"]
    ).json()["data"]
    assert tasks["total"] == 1
    assert tasks["items"][0]["product_id"] == t2["product"]["id"]


def test_retry_failed_rejects_unknown_status(client):
    """显式请求补采 UNKNOWN 被拒绝。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=1)
    t1 = claim(client, ctx["headers"], batch["batch_id"], "v1")
    _submit(client, ctx["headers"], t1, "UNKNOWN")
    resp = client.post(
        f"/v1/batches/{batch['batch_id']}/retry-failed",
        json={"idempotency_key": "retry-x", "statuses": ["UNKNOWN"]},
        headers=ctx["headers"],
    )
    assert resp.status_code == 400


def test_batch_completion_aggregation(client):
    """全部任务终态后批次自动聚合为 COMPLETED / COMPLETED_WITH_ERRORS。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=2)
    t1 = claim(client, ctx["headers"], batch["batch_id"], "f1")
    _submit(client, ctx["headers"], t1, "SUCCESS")
    t2 = claim(client, ctx["headers"], batch["batch_id"], "f2")
    _submit(client, ctx["headers"], t2, "FAILED", error_code="MIAOSHOU_BUTTON_NOT_FOUND")

    detail = client.get(f"/v1/batches/{batch['batch_id']}", headers=ctx["headers"]).json()["data"]
    assert detail["status"] == "COMPLETED_WITH_ERRORS"
    assert detail["summary"]["by_status"]["SUCCESS"] == 1
    assert detail["summary"]["by_status"]["FAILED"] == 1
    assert detail["finished_at"] is not None

    # 全成功批次为 COMPLETED（使用新客户端，避免同一批商品被“已采集”去重跳过）
    ctx_full = register_client(client, install_id="install-test-002")
    ctx2_batch = _setup_running_batch(client, ctx_full, n=1, idem="f3")
    t3 = claim(client, ctx_full["headers"], ctx2_batch["batch_id"], "f4")
    _submit(client, ctx_full["headers"], t3, "SUCCESS")
    detail = client.get(f"/v1/batches/{ctx2_batch['batch_id']}", headers=ctx_full["headers"]).json()["data"]
    assert detail["status"] == "COMPLETED"


def test_duplicate_product_skipped_and_recollect(client):
    """已采集过的商品领取时直接跳过（不打开详情页），并支持单条重新抓取。"""
    ctx = register_client(client)
    headers = ctx["headers"]

    first = _setup_running_batch(client, ctx, n=1, idem="dup-1")
    t1 = claim(client, headers, first["batch_id"], "dup-c1")
    _submit(client, headers, t1, "SUCCESS")

    second = _setup_running_batch(client, ctx, n=1, idem="dup-2")
    assert claim(client, headers, second["batch_id"], "dup-c2") is None

    tasks = client.get(f"/v1/batches/{second['batch_id']}/tasks", headers=headers).json()["data"]["items"]
    assert len(tasks) == 1
    assert tasks[0]["status"] == "SKIPPED"
    assert tasks[0]["last_error_code"] == "DUPLICATE_ALREADY_COLLECTED"

    # 重新抓取后状态回到 PENDING，并优先被领取
    task_id = tasks[0]["task_id"]
    resp = client.post(f"/v1/tasks/{task_id}/recollect", headers=headers)
    assert resp.status_code == 200
    got = claim(client, headers, second["batch_id"], "dup-c3")
    assert got is not None
    assert got["task_id"] == task_id


def test_task_events_idempotent(client):
    """相同 event_id 重复上报去重。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=1)
    got = claim(client, ctx["headers"], batch["batch_id"], "ev1")
    payload = {
        "event_id": "evt-001",
        "batch_id": batch["batch_id"],
        "task_id": got["task_id"],
        "event_type": "STAGE_CHANGED",
        "payload": {"stage": "NAVIGATING"},
    }
    r1 = client.post(f"/v1/tasks/{got['task_id']}/events", json=payload, headers=ctx["headers"])
    r2 = client.post(f"/v1/tasks/{got['task_id']}/events", json=payload, headers=ctx["headers"])
    assert r1.json()["data"]["created"] is True
    assert r2.json()["data"]["created"] is False


def test_active_task_recovery(client):
    """active-task 返回当前租约任务供 MV3 重启恢复；终态后为空。"""
    ctx = register_client(client)
    batch = _setup_running_batch(client, ctx, n=1)
    got = claim(client, ctx["headers"], batch["batch_id"], "a1")

    resp = client.get("/v1/clients/me/active-task", headers=ctx["headers"])
    data = resp.json()["data"]
    assert data["task_id"] == got["task_id"]
    assert data["attempt_id"] == got["attempt_id"]
    assert data["product"]["detail_url"]

    _submit(client, ctx["headers"], got, "SUCCESS")
    resp = client.get("/v1/clients/me/active-task", headers=ctx["headers"])
    assert resp.json()["data"] is None
