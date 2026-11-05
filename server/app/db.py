"""数据库引擎与会话管理（SQLite + SQLAlchemy 2.x 同步模式）。"""

import os

from sqlalchemy import create_engine, event
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


def init_db() -> None:
    """创建全部数据表（幂等，可重复调用）。"""
    from app.models import Base

    Base.metadata.create_all(bind=engine)
