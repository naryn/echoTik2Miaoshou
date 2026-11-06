"""ORM 数据模型定义（对应规范第 6.1 节，SQLite 实现）。

时间字段统一 DateTime(timezone=True) 存 UTC；JSON 字段使用 SQLAlchemy JSON 类型。
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def utcnow() -> datetime:
    """返回当前 UTC 时间。

    SQLite 不回读时区信息，统一使用 naive UTC（datetime.utcnow 语义），
    保证写入与读取后的比较行为一致；API 序列化时按 UTC 输出。
    """
    return datetime.now(timezone.utc).replace(tzinfo=None)


def new_id(prefix: str) -> str:
    """生成带业务前缀的全局唯一 ID，如 c_xxx / p_xxx / batch_xxx。"""
    return f"{prefix}_{uuid.uuid4().hex}"


class Base(DeclarativeBase):
    """SQLAlchemy 声明式基类。"""


class CollectorClient(Base):
    """插件安装实例（客户端身份与凭证）。"""

    __tablename__ = "collector_clients"

    client_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("c"))
    display_name: Mapped[str] = mapped_column(String(128), default="")
    install_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    status: Mapped[str] = mapped_column(String(32), default="ACTIVE")
    registered_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    extension_version: Mapped[str] = mapped_column(String(32), default="")
    client_token: Mapped[str] = mapped_column(String(128), nullable=False)


class AuthUser(Base):
    """认证账号：插件填写的 auth token 与角色（服务端表内维护）。

    同一 token 在任意浏览器/设备上解析为同一个 client_id，从而实现数据共享；
    role=ADMIN 可读取全部客户端数据，role=USER 仅能读取自身数据。
    """

    __tablename__ = "auth_users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token: Mapped[str] = mapped_column(String(128), unique=True, nullable=False, index=True)
    display_name: Mapped[str] = mapped_column(String(128), default="")
    role: Mapped[str] = mapped_column(String(16), default="USER", nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="ACTIVE", nullable=False)
    client_id: Mapped[str | None] = mapped_column(
        ForeignKey("collector_clients.client_id"), nullable=True, unique=True
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class RankingPreset(Base):
    """账号及采集渠道双重隔离的榜单筛选预设。"""

    __tablename__ = "ranking_presets"
    __table_args__ = (UniqueConstraint("client_id", "source_platform", "name", name="uq_ranking_preset_client_source_name"),)

    preset_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("preset"))
    client_id: Mapped[str] = mapped_column(ForeignKey("collector_clients.client_id"), nullable=False, index=True)
    source_platform: Mapped[str] = mapped_column(String(16), nullable=False, default="ECHOTIK", index=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    query_json: Mapped[dict] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)


class Product(Base):
    """商品主数据，按 (platform, region, external_product_id) 全局去重。"""

    __tablename__ = "products"
    __table_args__ = (
        UniqueConstraint("platform", "region", "external_product_id", name="uq_product_natural_key"),
        Index("ix_products_region", "region"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("p"))
    platform: Mapped[str] = mapped_column(String(32), default="tiktok")
    region: Mapped[str] = mapped_column(String(16), nullable=False)
    external_product_id: Mapped[str] = mapped_column(Text, nullable=False)
    title: Mapped[str] = mapped_column(Text, default="")
    shop_id: Mapped[str] = mapped_column(String(128), default="")
    shop_name: Mapped[str] = mapped_column(String(256), default="")
    image_url: Mapped[str] = mapped_column(Text, default="")
    detail_url: Mapped[str] = mapped_column(Text, default="")
    first_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    raw_excerpt: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class Category(Base):
    """分类树/映射（按来源与站点区分）。"""

    __tablename__ = "categories"
    __table_args__ = (
        UniqueConstraint("source", "region", "external_category_id", name="uq_category_natural_key"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("cat"))
    source: Mapped[str] = mapped_column(String(32), default="echotik")
    region: Mapped[str] = mapped_column(String(16), nullable=False)
    external_category_id: Mapped[str] = mapped_column(String(128), nullable=False)
    parent_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    name: Mapped[str] = mapped_column(String(256), default="")
    level: Mapped[int] = mapped_column(Integer, default=1)
    name_slug: Mapped[str] = mapped_column(String(256), default="")


class RankSnapshot(Base):
    """一次榜单获取的快照（request_id 幂等）。"""

    __tablename__ = "rank_snapshots"

    snapshot_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("snap"))
    client_id: Mapped[str] = mapped_column(ForeignKey("collector_clients.client_id"), nullable=False, index=True)
    # 榜单数据来源平台：ECHOTIK / FASTMOSS（区别于 Product.platform 的电商平台）
    # 历史数据由 init_db 迁移回填 ECHOTIK
    source_platform: Mapped[str] = mapped_column(
        String(16), default="ECHOTIK", nullable=False, index=True
    )
    region: Mapped[str] = mapped_column(String(16), nullable=False)
    ranking_type: Mapped[str] = mapped_column(String(32), nullable=False)
    ranking_variant: Mapped[str | None] = mapped_column(String(32), nullable=True)
    category_id: Mapped[str | None] = mapped_column(String(128), nullable=True)
    period_start: Mapped[str | None] = mapped_column(String(32), nullable=True)
    period_end: Mapped[str | None] = mapped_column(String(32), nullable=True)
    capture_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    capture_finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="CAPTURING")
    filter_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    total_entries: Mapped[int] = mapped_column(Integer, default=0)
    request_id: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)

    entries: Mapped[list["RankEntry"]] = relationship(back_populates="snapshot")


class RankEntry(Base):
    """榜单明细：某商品在某快照中的排名与指标。"""

    __tablename__ = "rank_entries"
    __table_args__ = (
        UniqueConstraint("snapshot_id", "product_id", name="uq_rank_entry_snapshot_product"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("re"))
    snapshot_id: Mapped[str] = mapped_column(ForeignKey("rank_snapshots.snapshot_id"), nullable=False, index=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"), nullable=False, index=True)
    rank_position: Mapped[int] = mapped_column(Integer, nullable=False)
    sales: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    gmv: Mapped[float | None] = mapped_column(Float, nullable=True)
    metrics_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    raw_excerpt: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    snapshot: Mapped[RankSnapshot] = relationship(back_populates="entries")
    product: Mapped[Product] = relationship()


class CollectionBatch(Base):
    """ERP 采集批次（idempotency_key 幂等）。"""

    __tablename__ = "collection_batches"

    batch_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("batch"))
    client_id: Mapped[str] = mapped_column(ForeignKey("collector_clients.client_id"), nullable=False, index=True)
    # 榜单数据来源平台：优先继承来源快照，无快照时取请求值
    source_platform: Mapped[str] = mapped_column(String(16), default="ECHOTIK", nullable=False)
    source_snapshot_id: Mapped[str | None] = mapped_column(
        ForeignKey("rank_snapshots.snapshot_id"), nullable=True
    )
    parent_batch_id: Mapped[str | None] = mapped_column(
        ForeignKey("collection_batches.batch_id"), nullable=True
    )
    status: Mapped[str] = mapped_column(String(32), default="DRAFT", index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    config_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    summary_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    idempotency_key: Mapped[str] = mapped_column(String(64), unique=True, nullable=False)

    tasks: Mapped[list["CollectionTask"]] = relationship(back_populates="batch")


class CollectionTask(Base):
    """批次内单商品采集任务（含租约字段）。"""

    __tablename__ = "collection_tasks"
    __table_args__ = (
        UniqueConstraint("batch_id", "product_id", name="uq_task_batch_product"),
        Index("ix_tasks_batch_status", "batch_id", "status"),
    )

    task_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("task"))
    batch_id: Mapped[str] = mapped_column(ForeignKey("collection_batches.batch_id"), nullable=False)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="PENDING")
    attempt_count: Mapped[int] = mapped_column(Integer, default=0)
    claimed_by_client_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_token: Mapped[str | None] = mapped_column(String(128), nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error_code: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    batch: Mapped[CollectionBatch] = relationship(back_populates="tasks")
    product: Mapped[Product] = relationship()


class CollectionAttempt(Base):
    """一次采集尝试历史（按 attempt_id 幂等提交结果）。"""

    __tablename__ = "collection_attempts"

    attempt_id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("att"))
    task_id: Mapped[str] = mapped_column(ForeignKey("collection_tasks.task_id"), nullable=False, index=True)
    client_id: Mapped[str] = mapped_column(ForeignKey("collector_clients.client_id"), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    stage: Mapped[str | None] = mapped_column(String(32), nullable=True)
    result: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    evidence_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    error_code: Mapped[str | None] = mapped_column(String(64), nullable=True, index=True)
    elapsed_ms: Mapped[int | None] = mapped_column(Integer, nullable=True)


class TaskEvent(Base):
    """状态事件审计（event_id 幂等去重）。"""

    __tablename__ = "task_events"

    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    task_id: Mapped[str | None] = mapped_column(ForeignKey("collection_tasks.task_id"), nullable=True, index=True)
    batch_id: Mapped[str] = mapped_column(ForeignKey("collection_batches.batch_id"), nullable=False, index=True)
    client_id: Mapped[str] = mapped_column(ForeignKey("collector_clients.client_id"), nullable=False)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class ClientHeartbeat(Base):
    """客户端心跳记录（可按保留策略归档）。"""

    __tablename__ = "client_heartbeats"

    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: new_id("hb"))
    client_id: Mapped[str] = mapped_column(String(64), nullable=False, index=True)
    observed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    browser_state: Mapped[str | None] = mapped_column(String(64), nullable=True)
    active_batch_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    active_task_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    sync_pending_count: Mapped[int] = mapped_column(Integer, default=0)
