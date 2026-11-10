"""图片收集接口测试：上传落库、去重、格式校验与客户端隔离。"""

import base64

import pytest

from app.api import routes_images
from app.models import CollectedImage
from tests.conftest import register_client

# 1x1 透明 PNG
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


@pytest.fixture()
def images_dir(tmp_path, monkeypatch):
    """把图片落盘目录改到临时目录，避免污染 server/data。"""
    monkeypatch.setattr(routes_images, "COLLECTED_IMAGES_DIR", str(tmp_path))
    return tmp_path


def upload(client, headers, content: bytes = PNG_1PX, **extra):
    """调用图片收集接口。"""
    return client.post(
        "/v1/collected-images",
        json={
            "content_base64": base64.b64encode(content).decode(),
            "source_url": "https://cdn.echotik.live/demo.png",
            "title": "测试图片",
            "region": "US",
            **extra,
        },
        headers=headers,
    )


def test_upload_image(client, db_session, images_dir):
    """上传后写入 collected_images 并把字节落盘。"""
    reg = register_client(client)
    resp = upload(client, reg["headers"])
    assert resp.status_code == 200, resp.text
    data = resp.json()["data"]
    assert data["image_id"].startswith("img_")
    assert data["mime_type"] == "image/png"
    assert data["file_size"] == len(PNG_1PX)
    assert data["deduped"] is False
    assert data["client_id"] == reg["client_id"]

    record = db_session.query(CollectedImage).one()
    assert record.storage_path == f"{reg['client_id']}/{record.sha256}.png"
    assert (images_dir / record.storage_path).read_bytes() == PNG_1PX


def test_duplicate_upload_is_deduped(client, db_session, images_dir):
    """同一客户端重复上传相同文件只保留一条记录。"""
    reg = register_client(client)
    first = upload(client, reg["headers"]).json()["data"]
    second = upload(client, reg["headers"]).json()["data"]

    assert second["deduped"] is True
    assert second["image_id"] == first["image_id"]
    assert db_session.query(CollectedImage).count() == 1


def test_same_image_isolated_per_client(client, db_session, images_dir):
    """不同客户端上传同一张图，各自保留一条记录。"""
    a = register_client(client, install_id="install-a")
    b = register_client(client, install_id="install-b")
    image_a = upload(client, a["headers"]).json()["data"]
    image_b = upload(client, b["headers"]).json()["data"]

    assert image_a["image_id"] != image_b["image_id"]
    assert db_session.query(CollectedImage).count() == 2


def test_invalid_image_payload_rejected(client, images_dir):
    """非 base64 / 非图片内容返回稳定的 422 错误码。"""
    reg = register_client(client)
    resp = client.post(
        "/v1/collected-images",
        json={"content_base64": "not-base64!!", "source_url": "https://x/y.png"},
        headers=reg["headers"],
    )
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "INVALID_IMAGE"

    resp = upload(client, reg["headers"], content=b"plain text, not an image")
    assert resp.status_code == 422
    assert resp.json()["error"]["code"] == "INVALID_IMAGE"
    assert not list(images_dir.iterdir())


def test_upload_requires_auth(client, images_dir):
    """未认证请求不允许上传。"""
    resp = upload(client, {})
    assert resp.status_code == 401


def test_preview_list_scoped_and_file_accessible(client, db_session, images_dir):
    """列表按客户端隔离，图片文件仅本人可读。"""
    a = register_client(client, install_id="preview-a")
    b = register_client(client, install_id="preview-b")
    image_a = upload(client, a["headers"]).json()["data"]
    upload(client, b["headers"])

    resp = client.get("/v1/collected-images", headers=a["headers"])
    assert resp.status_code == 200
    data = resp.json()["data"]
    assert data["total"] == 1
    assert data["items"][0]["image_id"] == image_a["image_id"]
    assert data["items"][0]["client_display_name"] == "测试客户端"

    resp = client.get(f"/v1/collected-images/{image_a['image_id']}/file", headers=a["headers"])
    assert resp.status_code == 200
    assert resp.content == PNG_1PX

    # 其他客户端不能读取
    resp = client.get(f"/v1/collected-images/{image_a['image_id']}/file", headers=b["headers"])
    assert resp.status_code == 404


def test_preview_admin_sees_all(client, db_session, images_dir):
    """管理员 token 可查看全部客户端的图片。"""
    from app.models import AuthUser

    a = register_client(client, install_id="preview-admin-a")
    b = register_client(client, install_id="preview-admin-b")
    image_a = upload(client, a["headers"]).json()["data"]
    upload(client, b["headers"])
    db_session.add(AuthUser(token="preview-admin-token", display_name="管理员", role="ADMIN"))
    db_session.commit()
    admin_headers = {"Authorization": "Bearer preview-admin-token"}

    resp = client.get("/v1/collected-images", headers=admin_headers)
    assert resp.status_code == 200
    assert resp.json()["data"]["total"] == 2
    resp = client.get(f"/v1/collected-images/{image_a['image_id']}/file", headers=admin_headers)
    assert resp.status_code == 200


def test_preview_page_served(client):
    """预览页由服务端直接托管。"""
    resp = client.get("/collected-images")
    assert resp.status_code == 200
    assert "图片收集预览" in resp.text

