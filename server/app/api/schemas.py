"""API 请求/响应模型（Pydantic v2）与 ORM 序列化辅助。"""

from datetime import datetime, timezone
from typing import Annotated

from pydantic import AfterValidator, BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import ALLOWED_SOURCE_PLATFORMS, DEFAULT_SOURCE_PLATFORM
from app.models import (
    Category,
    CollectedImage,
    CollectionAttempt,
    CollectionBatch,
    CollectionTask,
    CollectorClient,
    Product,
    RankEntry,
    RankingPreset,
    RankSnapshot,
    TaskEvent,
)


def dt(value: datetime | None) -> str | None:
    """序列化 UTC 时间为带时区标记的 ISO8601 字符串。

    数据库统一存 naive UTC，这里补上 +00:00，避免浏览器把 UTC 时间
    当成本地时间解析，导致管理台时间少 8 小时。
    """
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _validate_source_platform(value: str) -> str:
    """校验榜单数据来源平台白名单（ECHOTIK / FASTMOSS），非法值返回 422。"""
    normalized = value.strip().upper()
    if normalized not in ALLOWED_SOURCE_PLATFORMS:
        raise ValueError(
            f"source_platform 仅支持 {sorted(ALLOWED_SOURCE_PLATFORMS)}，收到 {value!r}"
        )
    return normalized


# 榜单数据来源平台类型（区别于 Product.platform 的电商平台字段）
SourcePlatform = Annotated[str, AfterValidator(_validate_source_platform)]


# ---------- 请求模型 ----------


class RegisterRequest(BaseModel):
    """客户端注册请求。"""

    install_id: str = Field(min_length=1, max_length=64)
    display_name: str = Field(default="", max_length=128)
    extension_version: str = Field(default="", max_length=32)


class HeartbeatRequest(BaseModel):
    """客户端心跳请求。"""

    browser_state: str | None = None
    active_batch_id: str | None = None
    active_task_id: str | None = None
    sync_pending_count: int = 0


class AuthLoginRequest(BaseModel):
    """设备登录请求：device_id 为浏览器扩展安装实例标识（单设备登录校验）。"""

    device_id: str = Field(min_length=1, max_length=64)


class SnapshotCreateRequest(BaseModel):
    """榜单快照创建请求（request_id 幂等）。"""

    request_id: str = Field(min_length=1, max_length=64)
    source_platform: SourcePlatform = Field(default=DEFAULT_SOURCE_PLATFORM, max_length=16)
    region: str = Field(min_length=1, max_length=16)
    ranking_type: str = Field(min_length=1, max_length=32)
    ranking_variant: str | None = None
    category_id: str | None = None
    period_start: str | None = None
    period_end: str | None = None
    filter_json: dict | None = None


class RankingPresetUpsertRequest(BaseModel):
    """创建或按名称覆盖账号及渠道隔离的榜单筛选预设。"""

    name: str = Field(min_length=1, max_length=128)
    source_platform: SourcePlatform = Field(default=DEFAULT_SOURCE_PLATFORM, max_length=16)
    query_json: dict


class EntryItem(BaseModel):
    """榜单明细条目。"""

    external_product_id: str | None = None
    platform: str | None = None
    region: str | None = None
    title: str | None = None
    shop_id: str | None = None
    shop_name: str | None = None
    image_url: str | None = None
    detail_url: str | None = None
    rank_position: int | None = None
    sales: int | None = None
    gmv: float | None = None
    metrics_json: dict | None = None
    raw_excerpt: dict | None = None


class EntriesUpsertRequest(BaseModel):
    """榜单明细批量上传（每批 ≤200 条）。"""

    entries: list[EntryItem] = Field(max_length=200)


class FinishSnapshotRequest(BaseModel):
    """快照完成标记：COMPLETED / PARTIAL / FAILED。"""

    status: str


class BatchCreateRequest(BaseModel):
    """采集批次创建请求（idempotency_key 幂等）。"""

    idempotency_key: str = Field(min_length=1, max_length=64)
    # 无快照时使用；带 snapshot_id 时以快照的 source_platform 为准
    source_platform: SourcePlatform = Field(default=DEFAULT_SOURCE_PLATFORM, max_length=16)
    snapshot_id: str | None = None
    product_ids: list[str] | None = None
    exclude_already_successful: bool = False
    interval_seconds: dict | None = None
    config: dict | None = None
    force: bool = False
    # 强制重抓：批次任务跳过「已采集去重」（用于单商品手动测试 ERP 采集）
    recollect: bool = False


class RetryFailedRequest(BaseModel):
    """失败补采批次创建请求。"""

    idempotency_key: str = Field(min_length=1, max_length=64)
    statuses: list[str] | None = None
    force: bool = False


class ClaimRequest(BaseModel):
    """任务领取请求（request_id 幂等）。"""

    batch_id: str
    request_id: str = Field(min_length=1, max_length=64)
    client_id: str | None = None


class TaskHeartbeatRequest(BaseModel):
    """任务租约心跳请求。"""

    lease_token: str
    stage: str | None = None


class TaskEventRequest(BaseModel):
    """任务事件上报（event_id 幂等）。"""

    event_id: str = Field(min_length=1, max_length=64)
    batch_id: str
    task_id: str | None = None
    event_type: str = Field(min_length=1, max_length=64)
    payload: dict | None = None
    occurred_at: datetime | None = None


class ResultSubmitRequest(BaseModel):
    """任务最终结果提交（attempt_id 幂等）。"""

    attempt_id: str
    lease_token: str | None = None
    result: str
    error_code: str | None = None
    evidence: dict | None = None
    elapsed_ms: int | None = None


class CrossBorderPricingRequest(BaseModel):
    """MX POP 跨境直邮正向定价参数。百分比字段均使用 0–100 的输入口径。"""

    product_cost_rmb: float = Field(ge=0, description="单件商品成本，人民币")
    domestic_extra_cost_rmb: float = Field(default=2, ge=0, description="单件境内附加成本，人民币")
    mxn_per_rmb: float = Field(default=2.78, gt=0, description="汇率：1 RMB 对应多少 MXN")
    quantity: int = Field(default=1, ge=1, le=100, description="每单商品件数")
    unit_chargeable_weight_kg: float = Field(gt=0, le=30, description="单件计费重量，kg")
    target_net_margin_pct: float = Field(default=20, ge=0, lt=90, description="目标净利率，百分比")
    merchant_discount_pct: float = Field(default=50, ge=0, lt=90, description="商家折扣率，百分比")
    new_customer_discount_pct: float = Field(default=0, ge=0, lt=90, description="新客折扣率，百分比")
    affiliate_commission_pct: float = Field(default=0, ge=0, lt=90, description="达人佣金率，百分比")
    advertising_pct: float = Field(default=0, ge=0, lt=90, description="预计广告投入率，百分比")
    buyer_shipping_paid_per_item_mxn: float = Field(default=50, ge=0, description="买家预计多付运费，用于上新原价参考")
    gift_weight_kg: float = Field(default=0, ge=0, le=30, description="赠品总重量，kg；0 表示无赠品，仅计入物流重量")
    gift_cost_rmb: float = Field(default=0, ge=0, description="赠品采购成本合计（RMB，整单），仅计入固定成本")


class ReverseCostRequest(BaseModel):
    """已知折后售价时，反推可承受商品成本。"""

    sale_price_mxn: float = Field(gt=0)
    quantity: int = Field(default=1, ge=1, le=100)
    unit_chargeable_weight_kg: float = Field(gt=0, le=30)
    target_net_margin_pct: float = Field(default=10, ge=0, lt=90)
    merchant_discount_pct: float = Field(default=50, ge=0, lt=90)
    new_customer_discount_pct: float = Field(default=0, ge=0, lt=90)
    affiliate_commission_pct: float = Field(default=10, ge=0, lt=90)
    advertising_pct: float = Field(default=0, ge=0, lt=90)
    mxn_per_rmb: float = Field(default=2.78, gt=0)


class ChargeableWeightRequest(BaseModel):
    length_cm: float = Field(ge=0)
    width_cm: float = Field(ge=0)
    height_cm: float = Field(ge=0)
    actual_weight_kg: float = Field(gt=0)


class CollectedImageCreateRequest(BaseModel):
    """插件图片收集请求：图片字节以 base64 上传（不含 data URI 前缀）。"""

    content_base64: str = Field(min_length=1)
    source_url: str = Field(default="", max_length=4096)
    product_id: str | None = Field(default=None, max_length=64)
    title: str = Field(default="", max_length=512)
    region: str = Field(default="", max_length=16)
    source_platform: SourcePlatform = Field(default=DEFAULT_SOURCE_PLATFORM, max_length=16)


# ---------- 序列化 ----------


def client_out(c: CollectorClient, include_token: bool = False) -> dict:
    """序列化客户端信息；token 仅在注册响应中下发。"""
    data = {
        "client_id": c.client_id,
        "display_name": c.display_name,
        "install_id": c.install_id,
        "status": c.status,
        "registered_at": dt(c.registered_at),
        "last_seen_at": dt(c.last_seen_at),
        "extension_version": c.extension_version,
    }
    if include_token:
        data["client_token"] = c.client_token
    return data


def product_out(p: Product) -> dict:
    """序列化商品主数据。"""
    return {
        "id": p.id,
        "platform": p.platform,
        "region": p.region,
        "external_product_id": p.external_product_id,
        "title": p.title,
        "shop_id": p.shop_id,
        "shop_name": p.shop_name,
        "image_url": p.image_url,
        "detail_url": p.detail_url,
        "first_seen_at": dt(p.first_seen_at),
        "last_seen_at": dt(p.last_seen_at),
        "raw_excerpt": p.raw_excerpt,
    }


def _resolve_top_category_name(db: Session, source: str, region: str, external_id: str | None) -> str | None:
    """递归向上找一级分类名（level=1 或 parent_id 为空）。找不到返回 None。"""
    if not external_id:
        return None
    current_external = external_id
    while True:
        node = db.execute(
            select(Category).where(
                Category.source == source.lower(),
                Category.region == region,
                Category.external_category_id == current_external,
            )
        ).scalar_one_or_none()
        if node is None:
            return None
        if not node.parent_id or node.level == 1:
            return node.name or node.external_category_id
        current_external = node.parent_id


def _category_name_from_filters(s: RankSnapshot) -> str | None:
    """读取插件创建快照时写入 filter_json 的一级分类名称（旧版快照没有该字段）。"""
    filters = s.filter_json or {}
    label = filters.get("categoryLabel") or filters.get("category_label")
    return label.strip() if isinstance(label, str) and label.strip() else None


def _category_name_from_entries(db: Session, s: RankSnapshot) -> str | None:
    """兜底：从快照内任一明细的 raw_excerpt.category 取一级分类名称。

    榜单接口（热销/热推/新品）返回的 category 就是一级类目名，可直接展示；
    商品库接口返回的是末级类目名，混进“一级分类”列会造成误导，故跳过。
    """
    if s.ranking_variant == "products":
        return None
    row = db.execute(
        select(RankEntry.raw_excerpt)
        .where(RankEntry.snapshot_id == s.snapshot_id, RankEntry.raw_excerpt.is_not(None))
        .limit(1)
    ).first()
    if not row or not isinstance(row[0], dict):
        return None
    name = row[0].get("category")
    if not isinstance(name, str) or not name.strip():
        return None
    # FastMoss 的 category 是“一级 / 二级 / 三级”全路径，EchoTik 直接给一级类目名
    return name.split("/")[0].strip() or None


def snapshot_out(s: RankSnapshot, db: Session | None = None) -> dict:
    """序列化榜单快照；传 db 时顺便把 category_name（一级分类名）一并解析出来。"""
    data = {
        "snapshot_id": s.snapshot_id,
        "client_id": s.client_id,
        "source_platform": s.source_platform,
        "region": s.region,
        "ranking_type": s.ranking_type,
        "ranking_variant": s.ranking_variant,
        "category_id": s.category_id,
        "period_start": s.period_start,
        "period_end": s.period_end,
        "capture_started_at": dt(s.capture_started_at),
        "capture_finished_at": dt(s.capture_finished_at),
        "status": s.status,
        "filter_json": s.filter_json,
        "total_entries": s.total_entries,
        "request_id": s.request_id,
    }
    if db is not None:
        # 依次尝试：分类表 → 插件写入的筛选标签 → 快照明细里的一级类目名。
        # categories 表当前不一定有数据（没有同步入口），后两级是实际生效的来源。
        data["category_name"] = (
            _resolve_top_category_name(db, s.source_platform, s.region, s.category_id)
            or _category_name_from_filters(s)
            or _category_name_from_entries(db, s)
        )
    return data


def rank_entry_out(e: RankEntry, snapshot: RankSnapshot | None = None, db: Session | None = None) -> dict:
    """序列化榜单明细（可选携带快照信息；传 db 时快照里会带 category_name）。"""
    data = {
        "id": e.id,
        "snapshot_id": e.snapshot_id,
        "product_id": e.product_id,
        "rank_position": e.rank_position,
        "sales": e.sales,
        "gmv": e.gmv,
        "metrics_json": e.metrics_json,
        "observed_at": dt(e.observed_at),
    }
    if snapshot is not None:
        data["snapshot"] = snapshot_out(snapshot, db)
    return data


def batch_out(
    b: CollectionBatch,
    summary: dict | None = None,
    snapshot: "RankSnapshot | None" = None,
    db: Session | None = None,
) -> dict:
    """序列化采集批次（可选携带聚合进度与来源榜单快照信息；传 db 时快照里会带 category_name）。"""
    data = {
        "batch_id": b.batch_id,
        "client_id": b.client_id,
        "source_platform": b.source_platform,
        "source_snapshot_id": b.source_snapshot_id,
        "parent_batch_id": b.parent_batch_id,
        "status": b.status,
        "created_at": dt(b.created_at),
        "started_at": dt(b.started_at),
        "finished_at": dt(b.finished_at),
        "config_json": b.config_json,
        "summary_json": b.summary_json,
        "idempotency_key": b.idempotency_key,
    }
    if summary is not None:
        data["summary"] = summary
    if snapshot is not None:
        data["snapshot"] = snapshot_out(snapshot, db)
    return data


def task_out(t: CollectionTask, product: Product | None = None) -> dict:
    """序列化采集任务（可选携带商品信息）。"""
    data = {
        "task_id": t.task_id,
        "batch_id": t.batch_id,
        "product_id": t.product_id,
        "status": t.status,
        "attempt_count": t.attempt_count,
        "claimed_by_client_id": t.claimed_by_client_id,
        "lease_expires_at": dt(t.lease_expires_at),
        "last_error_code": t.last_error_code,
        "created_at": dt(t.created_at),
        "updated_at": dt(t.updated_at),
    }
    if product is not None:
        data["product"] = product_out(product)
    return data


def attempt_out(a: CollectionAttempt) -> dict:
    """序列化采集尝试记录。"""
    return {
        "attempt_id": a.attempt_id,
        "task_id": a.task_id,
        "client_id": a.client_id,
        "started_at": dt(a.started_at),
        "finished_at": dt(a.finished_at),
        "stage": a.stage,
        "result": a.result,
        "evidence_json": a.evidence_json,
        "error_code": a.error_code,
        "elapsed_ms": a.elapsed_ms,
    }


def event_out(e: TaskEvent) -> dict:
    """序列化任务事件。"""
    return {
        "event_id": e.event_id,
        "task_id": e.task_id,
        "batch_id": e.batch_id,
        "client_id": e.client_id,
        "event_type": e.event_type,
        "payload_json": e.payload_json,
        "occurred_at": dt(e.occurred_at),
        "received_at": dt(e.received_at),
    }


def collected_image_out(image: CollectedImage, client_display_name: str = "") -> dict:
    """序列化已收集图片元数据（storage_path 为服务端内部路径，不对外暴露）。"""
    return {
        "image_id": image.image_id,
        "client_id": image.client_id,
        "client_display_name": client_display_name,
        "product_id": image.product_id,
        "source_url": image.source_url,
        "mime_type": image.mime_type,
        "file_size": image.file_size,
        "sha256": image.sha256,
        "title": image.title,
        "region": image.region,
        "source_platform": image.source_platform,
        "status": image.status,
        "created_at": dt(image.created_at),
    }
