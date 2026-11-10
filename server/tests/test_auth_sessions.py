"""单设备登录测试：设备会话绑定、后登录顶替旧设备与登出失效。"""

import pytest

from app.models import AuthUser

TOKEN = "device-token-001"


def add_auth_user(db) -> AuthUser:
    """插入认证账号（模拟运维在服务端表内维护 token）。"""
    user = AuthUser(token=TOKEN, display_name="单设备账号", role="USER")
    db.add(user)
    db.commit()
    return user


def headers(device_id: str | None = None, session_id: str | None = None) -> dict:
    """构造 Bearer + 设备会话请求头。"""
    h = {"Authorization": f"Bearer {TOKEN}"}
    if device_id:
        h["X-Device-Id"] = device_id
    if session_id:
        h["X-Session-Id"] = session_id
    return h


def login(client, device_id: str) -> dict:
    """设备登录并断言成功，返回响应 data。"""
    resp = client.post(
        "/v1/auth/login",
        json={"device_id": device_id},
        headers={"Authorization": f"Bearer {TOKEN}"},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()["data"]


@pytest.fixture()
def account(db_session):
    """已存在的认证账号。"""
    return add_auth_user(db_session)


def test_login_binds_device_and_reuses_session(client, account):
    """同一设备重复登录复用会话；账号共享 client_id 保持不变。"""
    first = login(client, "device-a")
    assert first["session_id"]
    assert first["client_id"]

    me = client.get(
        "/v1/auth/me",
        headers=headers("device-a", first["session_id"]),
    )
    assert me.status_code == 200
    assert me.json()["data"]["client_id"] == first["client_id"]

    again = login(client, "device-a")
    assert again["session_id"] == first["session_id"]
    assert again["client_id"] == first["client_id"]

    # 只读查看页（图片预览）不携带设备会话也能访问，避免查看图片挤掉插件登录
    readonly = client.get("/v1/collected-images", headers={"Authorization": f"Bearer {TOKEN}"})
    assert readonly.status_code == 200


def test_second_device_kicks_first(client, account):
    """新设备登录后旧设备请求被拒绝（SESSION_REPLACED），新设备正常。"""
    first = login(client, "device-a")
    second = login(client, "device-b")
    assert second["session_id"] != first["session_id"]
    assert second["client_id"] == first["client_id"]

    old = client.get("/v1/auth/me", headers=headers("device-a", first["session_id"]))
    assert old.status_code == 401
    assert old.json()["error"]["code"] == "SESSION_REPLACED"

    new = client.get("/v1/auth/me", headers=headers("device-b", second["session_id"]))
    assert new.status_code == 200


def test_missing_or_mismatched_session_rejected_after_login(client, account):
    """账号启用设备会话后，缺失/伪造会话均视为被顶替。"""
    login(client, "device-a")

    missing = client.get("/v1/auth/me", headers=headers())
    assert missing.status_code == 401
    assert missing.json()["error"]["code"] == "SESSION_REPLACED"

    forged = client.get("/v1/auth/me", headers=headers("device-a", "fake-session"))
    assert forged.status_code == 401
    assert forged.json()["error"]["code"] == "SESSION_REPLACED"


def test_logout_invalidates_session_until_next_login(client, account):
    """登出后旧会话失效，且不能回退到免会话访问；重新登录恢复。"""
    first = login(client, "device-a")
    resp = client.post(
        "/v1/auth/logout",
        headers=headers("device-a", first["session_id"]),
    )
    assert resp.status_code == 200
    assert resp.json()["data"]["logged_out"] is True

    denied = client.get("/v1/auth/me", headers=headers("device-a", first["session_id"]))
    assert denied.status_code == 401
    assert denied.json()["error"]["code"] == "SESSION_REPLACED"
    # 不带会话头同样拒绝，避免登出后绕过单设备限制
    assert client.get("/v1/auth/me", headers=headers()).status_code == 401

    relogin = login(client, "device-a")
    assert relogin["session_id"] != first["session_id"]
    assert (
        client.get("/v1/auth/me", headers=headers("device-a", relogin["session_id"])).status_code
        == 200
    )


def test_login_requires_valid_token(client, account):
    """错误 token 无法登录。"""
    resp = client.post(
        "/v1/auth/login",
        json={"device_id": "device-x"},
        headers={"Authorization": "Bearer wrong-token"},
    )
    assert resp.status_code == 401
    assert resp.json()["error"]["code"] == "UNAUTHORIZED"
