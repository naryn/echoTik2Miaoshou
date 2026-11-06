"""认证与超级管理员接口测试：token 隔离、角色权限与跨客户端全量读取。"""

import pytest

from app.models import AuthUser
from tests.conftest import create_batch, list_product_ids, make_snapshot_with_entries


def add_auth_user(db, token: str, role: str = "USER", name: str = "测试账号") -> AuthUser:
    """在 auth_users 表插入认证账号（模拟运维在服务端表内填写 token）。"""
    user = AuthUser(token=token, display_name=name, role=role)
    db.add(user)
    db.commit()
    return user


@pytest.fixture()
def admin_headers(db_session):
    """管理员账号请求头（auth_users.role=ADMIN）。"""
    add_auth_user(db_session, "admin-token-001", role="ADMIN", name="超级管理员")
    return {"Authorization": "Bearer admin-token-001"}


@pytest.fixture()
def user_headers(db_session):
    """普通账号请求头（auth_users.role=USER）。"""
    add_auth_user(db_session, "user-token-001", role="USER", name="普通用户")
    return {"Authorization": "Bearer user-token-001"}


def test_auth_required(client):
    """未填写/填写无效 token 时不允许访问数据接口。"""
    resp = client.get("/v1/batches")
    assert resp.status_code == 401
    resp = client.get("/v1/batches", headers={"Authorization": "Bearer unknown-token"})
    assert resp.status_code == 401
    resp = client.get("/v1/auth/me", headers={"Authorization": "Bearer unknown-token"})
    assert resp.status_code == 401


def test_auth_me_returns_account_identity(client, user_headers):
    """auth token 解析为稳定的共享客户端身份。"""
    me = client.get("/v1/auth/me", headers=user_headers).json()["data"]
    assert me["role"] == "USER"
    assert me["display_name"] == "普通用户"
    assert me["client_id"]

    # 同一个 token 再次解析应得到相同 client_id（跨浏览器共享的基础）
    again = client.get("/v1/auth/me", headers=user_headers).json()["data"]
    assert again["client_id"] == me["client_id"]


def test_user_only_sees_own_data(client, db_session):
    """普通账号只能看到自身快照产生的数据，看不到其他账号的批次与商品。"""
    add_auth_user(db_session, "user-a", name="用户A")
    add_auth_user(db_session, "user-b", name="用户B")
    headers_a = {"Authorization": "Bearer user-a"}
    headers_b = {"Authorization": "Bearer user-b"}

    snapshot_a = make_snapshot_with_entries(
        client, headers_a, n=3, request_id="snap-a", external_prefix="A170"
    )
    make_snapshot_with_entries(
        client, headers_b, n=3, request_id="snap-b", external_prefix="B170"
    )

    products_a = client.get("/v1/products", headers=headers_a).json()["data"]
    products_b = client.get("/v1/products", headers=headers_b).json()["data"]
    assert products_a["total"] == 3
    assert products_b["total"] == 3
    assert {p["external_product_id"] for p in products_a["items"]} == {"A1700", "A1701", "A1702"}
    assert {p["external_product_id"] for p in products_b["items"]} == {"B1700", "B1701", "B1702"}

    ids_a = list_product_ids(client, headers_a)
    batch_a = create_batch(client, headers_a, "batch-a", snapshot_id=snapshot_a)
    assert client.get("/v1/batches", headers=headers_a).json()["data"]["total"] == 1
    assert client.get("/v1/batches", headers=headers_b).json()["data"]["total"] == 0

    # 用户 B 无法通过批次/快照 ID 越权读取 A 的批次或商品
    resp = client.get(f"/v1/batches/{batch_a['batch_id']}", headers=headers_b)
    assert resp.status_code == 403
    scoped = client.get(
        "/v1/products", params={"batch_id": batch_a["batch_id"]}, headers=headers_b
    ).json()["data"]
    assert scoped["total"] == 0
    history = client.get(f"/v1/products/{ids_a[0]}/rank-history", headers=headers_b)
    assert history.status_code == 200
    assert history.json()["data"]["items"] == []


def test_admin_reads_all_clients(client, db_session, admin_headers):
    """管理员可读取所有账号的批次/任务/商品，普通账号访问管理端返回 403。"""
    add_auth_user(db_session, "user-a", name="用户A")
    add_auth_user(db_session, "user-b", name="用户B")
    headers_a = {"Authorization": "Bearer user-a"}
    headers_b = {"Authorization": "Bearer user-b"}

    snapshot_a = make_snapshot_with_entries(
        client, headers_a, n=2, request_id="snap-a", external_prefix="A170"
    )
    make_snapshot_with_entries(
        client, headers_b, n=2, request_id="snap-b", external_prefix="B170"
    )
    ids_a = list_product_ids(client, headers_a)
    batch_a = create_batch(client, headers_a, "batch-a", snapshot_id=snapshot_a)
    batch_b = create_batch(client, headers_b, "batch-b", product_ids=ids_a)

    all_batches = client.get("/v1/admin/batches", headers=admin_headers).json()["data"]
    assert all_batches["total"] == 2
    assert {b["batch_id"] for b in all_batches["items"]} == {
        batch_a["batch_id"],
        batch_b["batch_id"],
    }

    clients = client.get("/v1/admin/clients", headers=admin_headers).json()["data"]
    assert len(clients["items"]) >= 2
    assert all("client_token" not in c for c in clients["items"])

    tasks = client.get(
        f"/v1/admin/batches/{batch_a['batch_id']}/tasks", headers=admin_headers
    ).json()["data"]
    assert tasks["total"] == 2

    all_products = client.get("/v1/admin/products", headers=admin_headers).json()["data"]
    assert all_products["total"] == 4

    # 普通账号不能访问管理端
    denied = client.get("/v1/admin/batches", headers=headers_a)
    assert denied.status_code == 403
    assert denied.json()["error"]["code"] == "ADMIN_FORBIDDEN"
