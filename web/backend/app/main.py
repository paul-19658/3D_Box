"""FastAPI 应用入口。

启动方式（在 web/backend 目录下）：
    py -3.10 -m uvicorn app.main:app --reload --port 8000

生产环境建议关闭 --reload，并放在反向代理之后。
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.admin_routes import router as admin_router
from app.api.routes import router as api_router
from app.db.session import init_db
from app.services.project_store import DEFAULT_WORKSPACE
from app.services.workspace_log import configure_workspace_logging, logs_dir, write_log_event

# 前端构建产物目录。开发阶段前端由 webpack-dev-server 提供，
# 生产阶段由 FastAPI 直接托管，避免再部署一个静态服务器。
FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

logger = logging.getLogger("xiaobaihe")

# 这些路径访问很频繁，不写 access 日志，避免淹没真正有用的记录。
_QUIET_PATHS = frozenset({"/api/health", "/favicon.ico"})


@asynccontextmanager
async def lifespan(_app: FastAPI):
    DEFAULT_WORKSPACE.mkdir(parents=True, exist_ok=True)
    log_dir = configure_workspace_logging(DEFAULT_WORKSPACE)
    init_db()
    write_log_event(log_dir, kind="app.ready", message="database ready")
    yield
    write_log_event(log_dir, kind="app.shutdown", message="shutting down")


app = FastAPI(
    title="小白盒 Web API",
    version="0.22.0",
    description="面向零基础创作者的白膜场景、镜头与动画草稿工具（Web 版后端）",
    lifespan=lifespan,
)

# 开发期前端跑在 8080，需要跨域。生产环境同源部署时这条不影响。
# allow_credentials=True：Cookie 会话需要带凭证跨域。
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8080",
        "http://127.0.0.1:8080",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_http_requests(request: Request, call_next):
    """必要的 HTTP access / 异常日志，写入 workspace/logs。"""
    started = time.perf_counter()
    path = request.url.path
    log_dir = logs_dir(DEFAULT_WORKSPACE)
    try:
        response = await call_next(request)
    except Exception as error:
        write_log_event(
            log_dir,
            kind="http.error",
            level="ERROR",
            logger_name="http",
            message=f"{request.method} {path} failed",
            payload={
                "method": request.method,
                "path": path,
                "error": str(error),
                "durationMs": int((time.perf_counter() - started) * 1000),
            },
        )
        raise

    duration_ms = int((time.perf_counter() - started) * 1000)
    if path not in _QUIET_PATHS:
        level = "WARNING" if response.status_code >= 400 else "INFO"
        write_log_event(
            log_dir,
            kind="http.access",
            level=level,
            logger_name="http",
            message=f"{request.method} {path} -> {response.status_code}",
            payload={
                "method": request.method,
                "path": path,
                "status": response.status_code,
                "durationMs": duration_ms,
            },
        )
    return response


app.include_router(api_router)
app.include_router(admin_router)

DEFAULT_WORKSPACE.mkdir(parents=True, exist_ok=True)
configure_workspace_logging(DEFAULT_WORKSPACE)


if FRONTEND_DIST.exists():
    # 静态资源走 /assets，其余路径回落到 index.html，交给 vue-router 处理。
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str) -> FileResponse:
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
