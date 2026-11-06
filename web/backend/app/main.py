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
#
# 这里就取真实路径（resolve）：下面的归属校验拿它当基准，
# 基准本身若是软链接或含 `..`，校验结论就不可信。
FRONTEND_DIST = (Path(__file__).resolve().parent.parent.parent / "frontend" / "dist").resolve()

logger = logging.getLogger("xiaobaihe")

# 这些路径访问很频繁，不写 access 日志，避免淹没真正有用的记录。
_QUIET_PATHS = frozenset({"/api/health", "/favicon.ico"})


def resolve_dist_file(dist_root: Path, full_path: str) -> Path | None:
    """把请求路径解析成 dist 内的真实文件；越界或不存在时返回 None。

    这是 `serve_spa` 的安全核心，单独抽出来是为了能被单元测试直接覆盖
    （测试环境通常没有 `dist/`，走 HTTP 端到端反而测不到）。

    `full_path` 完全由请求方控制，且 Starlette 会先把 `%2e%2e%2f` 这类
    百分号编码解码成 `../` 再传进来，所以**绝不能**直接把
    `dist_root / full_path` 丢给 `is_file()`：那等于开放任意文件读取。
    实测该写法可以读到 `workspace/ai-environment.json` 里的明文 API Key，
    以及 `/../../../../Windows/win.ini` 这样的系统文件。

    归属判定用 `is_relative_to` 而非字符串 `startswith`：后者会把
    `dist-backup/` 这类同前缀的兄弟目录误判成"在 dist 内"。
    """
    if not full_path:
        return None
    candidate = (dist_root / full_path).resolve()
    if not candidate.is_relative_to(dist_root.resolve()):
        return None
    if not candidate.is_file():
        return None
    return candidate


@asynccontextmanager
async def lifespan(_app: FastAPI):
    DEFAULT_WORKSPACE.mkdir(parents=True, exist_ok=True)
    log_dir = configure_workspace_logging(DEFAULT_WORKSPACE)
    init_db()
    write_log_event(log_dir, kind="app.ready", message="database ready")
    yield
    write_log_event(log_dir, kind="app.shutdown", message="shutting down")


app = FastAPI(
    title="3D导演台 测试版 API",
    version="0.22.0",
    description="3D导演台 测试版：白膜场景、镜头与动画草稿工具（Web 版后端）",
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
        """把 dist 里的真实文件直接返回，其余路径交给 vue-router。

        路径归属校验见 `resolve_dist_file`：它保证只有 dist 内的真实文件
        才会被返回，越界一律回落到 index.html。
        """
        candidate = resolve_dist_file(FRONTEND_DIST, full_path)
        if candidate is not None:
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
