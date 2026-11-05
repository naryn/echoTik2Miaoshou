"""批次创建、幂等、排除已成功、单活跃批次约束测试。"""

from tests.conftest import (
    claim,
    create_batch,
    list_product_ids,
    make_snapshot_with_entries,
    register_client,
)


def _setup_products(client, ctx, n=3):
    """创建快照与 n 个商品，返回 (snapshot_id, product_ids)。"""
    snapshot_id = make_snapshot_with_entries(client, ctx["headers"], n=n)
    return snapshot_id, list_product_ids(client, ctx["headers"])


def test_batch_create_idempotent(client):
    """相同 idempotency_key 重复创建返回同一批次。"""
    ctx = register_client(client)
    snapshot_id, _ = _setup_products(client, ctx)
    b1 = create_batch(client, ctx["headers"], "idem-1", snapshot_id=snapshot_id)
    b2 = create_batch(client, ctx["headers"], "idem-1", snapshot_id=snapshot_id)
    assert b1["batch_id"] == b2["batch_id"]
    assert b1["created"] is True
    assert b2["created"] is False
    assert b1["summary"]["total"] == 3


def test_batch_single_active_constraint(client):
    """存在进行中批次时拒绝新建，force 可绕过。"""
    ctx = register_client(client)
    snapshot_id, _ = _setup_products(client, ctx)
    create_batch(client, ctx["headers"], "idem-a", snapshot_id=snapshot_id)
    client.post(
        f"/v1/batches/{_list_first_batch_id(client, ctx)}/start", headers=ctx["headers"]
    )

    resp = client.post(
        "/v1/batches",
        json={"idempotency_key": "idem-b", "snapshot_id": snapshot_id},
        headers=ctx["headers"],
    )
    assert resp.status_code == 409
    assert resp.json()["error"]["code"] == "BATCH_ALREADY_ACTIVE"

    forced = create_batch(client, ctx["headers"], "idem-c", snapshot_id=snapshot_id, force=True)
    assert forced["created"] is True


def _list_first_batch_id(client, ctx) -> str:
    """查询第一个批次 ID。"""
    resp = client.get("/v1/batches", headers=ctx["headers"])
    return resp.json()["data"]["items"][0]["batch_id"]


def test_exclude_already_successful(client):
    """exclude_already_successful 排除已有 SUCCESS 任务的商品并返回 skipped 计数。"""
    ctx = register_client(client)
    _, product_ids = _setup_products(client, ctx, n=3)

    batch1 = create_batch(client, ctx["headers"], "b1", product_ids=product_ids)
    client.post(f"/v1/batches/{batch1['batch_id']}/start", headers=ctx["headers"])
    got = claim(client, ctx["headers"], batch1["batch_id"], "claim-1")
    client.post(
        f"/v1/tasks/{got['task_id']}/result",
        json={"attempt_id": got["attempt_id"], "lease_token": got["lease_token"], "result": "SUCCESS"},
        headers=ctx["headers"],
    )
    client.post(f"/v1/batches/{batch1['batch_id']}/cancel", headers=ctx["headers"])

    batch2 = create_batch(
        client, ctx["headers"], "b2", product_ids=product_ids, exclude_already_successful=True
    )
    assert batch2["skipped_already_successful"] == 1
    assert batch2["summary"]["total"] == 2


def test_batch_state_machine(client):
    """start/pause/resume/cancel 状态机校验。"""
    ctx = register_client(client)
    _, product_ids = _setup_products(client, ctx, n=2)
    batch = create_batch(client, ctx["headers"], "sm-1", product_ids=product_ids)
    bid = batch["batch_id"]

    # READY 不允许 pause
    resp = client.post(f"/v1/batches/{bid}/pause", headers=ctx["headers"])
    assert resp.status_code == 409

    assert client.post(f"/v1/batches/{bid}/start", headers=ctx["headers"]).json()["data"]["status"] == "RUNNING"
    assert client.post(f"/v1/batches/{bid}/pause", headers=ctx["headers"]).json()["data"]["status"] == "PAUSED"
    assert client.post(f"/v1/batches/{bid}/resume", headers=ctx["headers"]).json()["data"]["status"] == "RUNNING"
    assert client.post(f"/v1/batches/{bid}/cancel", headers=ctx["headers"]).json()["data"]["status"] == "CANCELLED"

    # 停止后允许重新开始，未完成任务重置为 PENDING
    assert client.post(f"/v1/batches/{bid}/start", headers=ctx["headers"]).json()["data"]["status"] == "RUNNING"


def test_batch_ownership(client):
    """其他客户端不能操作本批次。"""
    ctx_a = register_client(client, "owner-a")
    ctx_b = register_client(client, "owner-b")
    _, product_ids = _setup_products(client, ctx_a, n=1)
    batch = create_batch(client, ctx_a["headers"], "own-1", product_ids=product_ids)
    resp = client.post(f"/v1/batches/{batch['batch_id']}/start", headers=ctx_b["headers"])
    assert resp.status_code == 403
