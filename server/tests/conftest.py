"""pytest 公共夹具：独立临时 SQLite 数据库 + TestClient + 已注册客户端。"""

import os
import tempfile

# 必须在导入 app 之前设置数据库地址，指向临时文件
_DB_FD, _DB_PATH = tempfile.mkstemp(suffix=".db", prefix="echotik_test_")
os.close(_DB_FD)
os.environ["DATABASE_URL"] = f"sqlite:///{_DB_PATH}"

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal, engine
from app.main import app
from app.models import Base


@pytest.fixture(autouse=True)
def clean_db():
    """每个测试用例前重建全部表，保证用例间隔离。"""
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    yield


@pytest.fixture()
def client():
    """提供 TestClient（触发应用 startup）。

    统一带上插件版本头，避免被强制更新中间件拦截；版本相关用例单独覆盖。
    """
    with TestClient(app, headers={"X-Client-Version": "0.1.5"}) as c:
        yield c


@pytest.fixture()
def db_session():
    """提供直接操作数据库的会话（用于构造租约过期等场景）。"""
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


def register_client(client: TestClient, install_id: str = "install-test-001") -> dict:
    """注册测试客户端并返回 {client_id, token, headers}。"""
    resp = client.post(
        "/v1/clients/register",
        json={"install_id": install_id, "display_name": "测试客户端", "extension_version": "0.1.0"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    headers = {"X-Client-Id": data["client_id"], "X-Client-Token": data["client_token"]}
    return {"client_id": data["client_id"], "token": data["client_token"], "headers": headers}


def make_snapshot_with_entries(
    client: TestClient,
    headers: dict,
    n: int = 3,
    request_id: str = "req-snap-1",
    external_prefix: str = "17000",
) -> str:
    """创建含 n 条明细的榜单快照并返回 snapshot_id。"""
    resp = client.post(
        "/v1/rank-snapshots",
        json={
            "request_id": request_id,
            "region": "US",
            "ranking_type": "DAILY",
            "period_start": "2026-11-03",
            "period_end": "2026-11-03",
        },
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    snapshot_id = resp.json()["data"]["snapshot_id"]
    entries = [
        {
            "external_product_id": f"{external_prefix}{i}",
            "title": f"测试商品{i}",
            "shop_name": "测试店铺",
            "detail_url": f"https://www.tiktok.com/shop/pdp/{external_prefix}{i}",
            "rank_position": i + 1,
            "sales": 100 - i,
        }
        for i in range(n)
    ]
    resp = client.post(
        f"/v1/rank-snapshots/{snapshot_id}/entries:upsert",
        json={"entries": entries},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    client.post(f"/v1/rank-snapshots/{snapshot_id}/finish", json={"status": "COMPLETED"}, headers=headers)
    return snapshot_id


def list_product_ids(client: TestClient, headers: dict) -> list[str]:
    """查询全部商品 ID（按首次发现排序）。"""
    resp = client.get("/v1/products", params={"sort": "first_seen_at", "order": "asc"}, headers=headers)
    assert resp.status_code == 200, resp.text
    return [item["id"] for item in resp.json()["data"]["items"]]


def create_batch(client: TestClient, headers: dict, idem_key: str, **kwargs) -> dict:
    """创建批次并断言成功，返回批次数据。"""
    resp = client.post("/v1/batches", json={"idempotency_key": idem_key, **kwargs}, headers=headers)
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


def claim(client: TestClient, headers: dict, batch_id: str, request_id: str) -> dict | None:
    """领取任务并断言成功，返回 data（可能为 None）。"""
    resp = client.post(
        "/v1/tasks/claim",
        json={"batch_id": batch_id, "request_id": request_id},
        headers=headers,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]
