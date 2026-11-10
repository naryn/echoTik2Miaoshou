"""插件图片收集路由：把页面上展示的商品图片上传到服务端归档。"""

import base64
import binascii
import hashlib
import os

from fastapi import APIRouter, Depends, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from app.api import schemas
from app.api.deps import Identity, ok, require_client, require_identity_readonly
from app.config import COLLECTED_IMAGES_DIR, MAX_IMAGE_BYTES
from app.db import get_db
from app.models import CollectedImage, CollectorClient, Product
from app.services.errors import ApiError, not_found

router = APIRouter(prefix="/v1", tags=["images"])

# 允许的图片格式（按文件头嗅探）与落盘扩展名
_IMAGE_EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
}


def _sniff_image_mime(data: bytes) -> str | None:
    """按文件头识别图片格式，非白名单格式返回 None。"""
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


@router.post("/collected-images")
def create_collected_image(
    body: schemas.CollectedImageCreateRequest,
    client: CollectorClient = Depends(require_client),
    db: Session = Depends(get_db),
):
    """接收插件上传的图片字节，落盘并写入 collected_images。

    同一客户端重复上传相同文件（SHA256 一致）时直接返回已有记录，避免重复落盘。
    """
    try:
        raw = base64.b64decode(body.content_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ApiError("INVALID_IMAGE", "content_base64 不是合法的 base64 数据", 422) from exc
    if not raw:
        raise ApiError("INVALID_IMAGE", "图片内容为空", 422)
    if len(raw) > MAX_IMAGE_BYTES:
        raise ApiError(
            "IMAGE_TOO_LARGE",
            f"图片超过 {MAX_IMAGE_BYTES // (1024 * 1024)}MB 上限",
            413,
        )

    mime_type = _sniff_image_mime(raw)
    if mime_type is None:
        raise ApiError("INVALID_IMAGE", "仅支持 JPEG/PNG/WebP/GIF 图片", 422)

    sha256 = hashlib.sha256(raw).hexdigest()
    existing = (
        db.query(CollectedImage)
        .filter(
            CollectedImage.client_id == client.client_id,
            CollectedImage.sha256 == sha256,
        )
        .one_or_none()
    )
    if existing is not None:
        return ok(
            {
                **schemas.collected_image_out(existing, client.display_name),
                "deduped": True,
            }
        )

    product = db.get(Product, body.product_id) if body.product_id else None
    storage_path = f"{client.client_id}/{sha256}{_IMAGE_EXTENSIONS[mime_type]}"
    absolute_path = os.path.join(COLLECTED_IMAGES_DIR, storage_path)
    os.makedirs(os.path.dirname(absolute_path), exist_ok=True)
    with open(absolute_path, "wb") as fh:
        fh.write(raw)

    image = CollectedImage(
        client_id=client.client_id,
        product_id=product.id if product else None,
        source_url=body.source_url,
        storage_path=storage_path,
        mime_type=mime_type,
        file_size=len(raw),
        sha256=sha256,
        title=body.title or (product.title if product else ""),
        region=body.region or (product.region if product else ""),
        source_platform=body.source_platform,
    )
    db.add(image)
    db.commit()
    db.refresh(image)
    return ok(
        {**schemas.collected_image_out(image, client.display_name), "deduped": False}
    )


@router.get("/collected-images")
def list_collected_images(
    page: int = Query(default=1, ge=1),
    per_page: int = Query(default=20),
    identity: Identity = Depends(require_identity_readonly),
    db: Session = Depends(get_db),
):
    """分页列出已收集图片：普通用户仅自己的，管理员可查看全部。"""
    size = per_page if per_page in (20, 50, 100) else 20
    query = db.query(CollectedImage)
    if identity.role != "ADMIN":
        query = query.filter(CollectedImage.client_id == identity.client.client_id)
    total = query.count()
    items = (
        query.order_by(CollectedImage.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
        .all()
    )
    client_ids = {item.client_id for item in items}
    names = (
        dict(
            db.query(CollectorClient.client_id, CollectorClient.display_name)
            .filter(CollectorClient.client_id.in_(client_ids))
            .all()
        )
        if client_ids
        else {}
    )
    return ok(
        {
            "items": [
                schemas.collected_image_out(item, names.get(item.client_id, ""))
                for item in items
            ],
            "total": total,
            "page": page,
            "per_page": size,
        }
    )


@router.get("/collected-images/{image_id}/file")
def get_collected_image_file(
    image_id: str,
    identity: Identity = Depends(require_identity_readonly),
    db: Session = Depends(get_db),
):
    """读取图片文件本身；非管理员只能读取自己上传的图片。"""
    image = db.get(CollectedImage, image_id)
    if image is None or (
        identity.role != "ADMIN" and image.client_id != identity.client.client_id
    ):
        raise not_found("图片")
    absolute_path = os.path.join(COLLECTED_IMAGES_DIR, image.storage_path)
    if not os.path.isfile(absolute_path):
        raise not_found("图片文件")
    return FileResponse(absolute_path, media_type=image.mime_type or "application/octet-stream")
