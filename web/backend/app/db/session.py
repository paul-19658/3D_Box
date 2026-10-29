"""数据库引擎与会话工厂。

连接串取自 WHITEBOX_DATABASE_URL，默认 SQLite：
    sqlite:///workspace/app.db

切到 Postgres 时改为例如：
    postgresql+psycopg://user:pass@host/dbname
然后 alembic upgrade head 即可，应用代码不用改。
"""

from __future__ import annotations

import os
from collections.abc import Generator
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from app.services.project_store import DEFAULT_WORKSPACE

DEFAULT_DATABASE_URL = f"sqlite:///{(DEFAULT_WORKSPACE / 'app.db').as_posix()}"


def get_database_url() -> str:
    return os.environ.get("WHITEBOX_DATABASE_URL", DEFAULT_DATABASE_URL)


def _make_engine(url: str) -> Engine:
    connect_args = {}
    if url.startswith("sqlite"):
        # FastAPI / TestClient 可能跨线程使用同一连接。
        connect_args["check_same_thread"] = False
        # 相对路径 sqlite:///workspace/app.db 要确保父目录存在。
        if url.startswith("sqlite:///"):
            db_path = Path(url[len("sqlite:///") :])
            if not db_path.is_absolute():
                db_path = Path.cwd() / db_path
            db_path.parent.mkdir(parents=True, exist_ok=True)

    engine = create_engine(url, connect_args=connect_args, future=True)

    if url.startswith("sqlite"):

        @event.listens_for(engine, "connect")
        def _set_sqlite_pragma(dbapi_connection, _connection_record) -> None:  # type: ignore[no-untyped-def]
            cursor = dbapi_connection.cursor()
            cursor.execute("PRAGMA foreign_keys=ON")
            cursor.close()

    return engine


engine = _make_engine(get_database_url())
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def reset_engine(url: str | None = None) -> Engine:
    """测试用：换成临时库并刷新 SessionLocal。"""
    global engine, SessionLocal
    engine.dispose()
    engine = _make_engine(url or get_database_url())
    SessionLocal.configure(bind=engine)
    return engine


def init_db() -> None:
    """应用启动时自动执行 alembic upgrade head。"""
    backend_root = Path(__file__).resolve().parents[2]
    config = Config(str(backend_root / "alembic.ini"))
    # 让迁移脚本读到与运行时相同的 URL。
    config.set_main_option("sqlalchemy.url", get_database_url())
    command.upgrade(config, "head")
