"""客户端注册/心跳/身份相关测试。"""

from tests.conftest import register_client


def test_register_idempotent(client):
    """同一 install_id 重复注册返回同一 client_id 并保持原 token。"""
    first = register_client(client)
    second = register_client(client)
    assert first["client_id"] == second["client_id"]
    assert first["token"] == second["token"]


def test_register_distinct_install_id(client):
    """不同 install_id 注册为不同客户端。"""
    a = register_client(client, "install-a")
    b = register_client(client, "install-b")
    assert a["client_id"] != b["client_id"]


def test_me_requires_auth(client):
    """未携带凭证访问返回 401 且含稳定错误码。"""
    resp = client.get("/v1/clients/me")
    assert resp.status_code == 401
    body = resp.json()
    assert body["error"]["code"] == "UNAUTHORIZED"
    assert body["error"]["retryable"] is False
    assert body["request_id"]


def test_me_and_heartbeat(client):
    """me 返回客户端详情；心跳写入成功。"""
    ctx = register_client(client)
    resp = client.get("/v1/clients/me", headers=ctx["headers"])
    assert resp.status_code == 200
    assert resp.json()["data"]["client_id"] == ctx["client_id"]
    assert "client_token" not in resp.json()["data"]

    resp = client.post(
        "/v1/clients/heartbeat",
        json={"browser_state": "OK", "sync_pending_count": 0},
        headers=ctx["headers"],
    )
    assert resp.status_code == 200


def test_wrong_token_rejected(client):
    """错误 token 被拒绝。"""
    ctx = register_client(client)
    resp = client.get(
        "/v1/clients/me",
        headers={"X-Client-Id": ctx["client_id"], "X-Client-Token": "wrong"},
    )
    assert resp.status_code == 401
