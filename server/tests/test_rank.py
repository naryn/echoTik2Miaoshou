"""榜单快照与商品相关测试：幂等、去重、拒绝非法条目、筛选。"""

from tests.conftest import make_snapshot_with_entries, register_client


def test_snapshot_create_idempotent(client):
    """相同 request_id 重复创建返回同一快照。"""
    ctx = register_client(client)
    payload = {"request_id": "req-1", "region": "US", "ranking_type": "DAILY"}
    r1 = client.post("/v1/rank-snapshots", json=payload, headers=ctx["headers"])
    r2 = client.post("/v1/rank-snapshots", json=payload, headers=ctx["headers"])
    assert r1.status_code == 200 and r2.status_code == 200
    d1, d2 = r1.json()["data"], r2.json()["data"]
    assert d1["snapshot_id"] == d2["snapshot_id"]
    assert d1["created"] is True
    assert d2["created"] is False


def test_entries_upsert_dedupe(client):
    """同一商品两次上传只保留一条 products 记录，榜单明细按快照 upsert。"""
    ctx = register_client(client)
    snapshot_id = make_snapshot_with_entries(client, ctx["headers"], n=2)

    entry = {
        "external_product_id": "170000",
        "title": "测试商品0-更新",
        "rank_position": 1,
        "sales": 200,
    }
    resp = client.post(
        f"/v1/rank-snapshots/{snapshot_id}/entries:upsert",
        json={"entries": [entry]},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["accepted"] == 1

    products = client.get("/v1/products", headers=ctx["headers"]).json()["data"]
    assert products["total"] == 2
    titles = {item["title"] for item in products["items"]}
    assert "测试商品0-更新" in titles

    history = client.get(
        f"/v1/products/{products['items'][0]['id']}/rank-history", headers=ctx["headers"]
    )
    assert history.status_code == 200


def test_entries_reject_invalid_product_id(client):
    """商品 ID 缺失/非法的条目记入 rejected 且不落库。"""
    ctx = register_client(client)
    resp = client.post(
        "/v1/rank-snapshots",
        json={"request_id": "req-bad", "region": "US", "ranking_type": "DAILY"},
        headers=ctx["headers"],
    )
    snapshot_id = resp.json()["data"]["snapshot_id"]
    resp = client.post(
        f"/v1/rank-snapshots/{snapshot_id}/entries:upsert",
        json={
            "entries": [
                {"external_product_id": "", "rank_position": 1},
                {"external_product_id": None, "rank_position": 2},
                {"external_product_id": "ok-1", "rank_position": 3},
            ]
        },
        headers=ctx["headers"],
    )
    data = resp.json()["data"]
    assert data["accepted"] == 1
    assert len(data["rejected"]) == 2
    products = client.get("/v1/products", headers=ctx["headers"]).json()["data"]
    assert products["total"] == 1


def test_snapshot_finish_and_list(client):
    """快照完成标记与列表筛选。"""
    ctx = register_client(client)
    snapshot_id = make_snapshot_with_entries(client, ctx["headers"], n=3)

    resp = client.get("/v1/rank-snapshots", params={"status": "COMPLETED"}, headers=ctx["headers"])
    data = resp.json()["data"]
    assert data["total"] == 1
    assert data["items"][0]["snapshot_id"] == snapshot_id
    assert data["items"][0]["total_entries"] == 3

    resp = client.get("/v1/rank-snapshots", params={"status": "FAILED"}, headers=ctx["headers"])
    assert resp.json()["data"]["total"] == 0


def test_products_filters(client):
    """商品关键词/ERP 状态筛选。"""
    ctx = register_client(client)
    make_snapshot_with_entries(client, ctx["headers"], n=3)

    resp = client.get("/v1/products", params={"keyword": "商品1"}, headers=ctx["headers"])
    assert resp.json()["data"]["total"] == 1

    resp = client.get("/v1/products", params={"erp_status": "NEVER"}, headers=ctx["headers"])
    assert resp.json()["data"]["total"] == 3
