"""数据库引擎与会话管理（SQLite + SQLAlchemy 2.x 同步模式）。"""

import os

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.exc import OperationalError
from sqlalchemy.orm import Session, sessionmaker

from app.config import DATABASE_URL


def _ensure_data_dir(url: str) -> None:
    """确保 SQLite 文件所在目录存在。"""
    if url.startswith("sqlite:///"):
        path = url[len("sqlite:///"):]
        directory = os.path.dirname(path)
        if directory:
            os.makedirs(directory, exist_ok=True)


_ensure_data_dir(DATABASE_URL)

# check_same_thread=False 供 FastAPI 多线程依赖使用；WAL + busy_timeout 降低写锁冲突
engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False, "timeout": 30},
)


@event.listens_for(engine, "connect")
def _set_sqlite_pragma(dbapi_conn, _record):
    """为每个 SQLite 连接启用外键约束与 WAL 模式。"""
    cursor = dbapi_conn.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=30000")
    cursor.close()


SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


def get_db():
    """FastAPI 依赖：提供请求级数据库会话并保证关闭。"""
    db: Session = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def _ensure_source_platform_column(table_name: str, index_name: str | None = None) -> None:
    """为已存在的旧表补充 source_platform 列（SQLite 无迁移框架，幂等执行）。

    通过 inspector 判断列是否已存在；若并发/重复 ALTER 触发
    duplicate column name 错误则忽略，保证 init_db 可反复调用。

    :param table_name: 目标表名（内部常量，非用户输入）
    :param index_name: 需要同步创建的索引名（可选）
    """
    inspector = inspect(engine)
    if table_name not in inspector.get_table_names():
        return
    existing = {col["name"] for col in inspector.get_columns(table_name)}
    if "source_platform" not in existing:
        try:
            with engine.begin() as conn:
                conn.execute(
                    text(
                        f"ALTER TABLE {table_name} ADD COLUMN "
                        "source_platform VARCHAR(16) NOT NULL DEFAULT 'ECHOTIK'"
                    )
                )
        except OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise
    if index_name:
        with engine.begin() as conn:
            conn.execute(
                text(f"CREATE INDEX IF NOT EXISTS {index_name} ON {table_name} (source_platform)")
            )


def init_db() -> None:
    """创建全部数据表并对旧库做兼容迁移（幂等，可重复调用）。"""
    from app.models import Base

    Base.metadata.create_all(bind=engine)
    # 历史库无 source_platform 列：ALTER 回填默认值 ECHOTIK
    _ensure_source_platform_column("rank_snapshots", "ix_rank_snapshots_source_platform")
    _ensure_source_platform_column("collection_batches")
