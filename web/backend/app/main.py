"""FastAPI 应用入口。

启动方式（在 web/backend 目录下）：
    py -3.10 -m uvicorn app.main:app --reload --port 8000

生产环境建议关闭 --reload，并放在反向代理之后。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router as api_router
from app.services.project_store import DEFAULT_WORKSPACE

# 前端构建产物目录。开发阶段前端由 webpack-dev-server 提供，
# 生产阶段由 FastAPI 直接托管，避免再部署一个静态服务器。
FRONTEND_DIST = Path(__file__).resolve().parent.parent.parent / "frontend" / "dist"

app = FastAPI(
    title="小白盒 Web API",
    version="0.22.0",
    description="面向零基础创作者的白膜场景、镜头与动画草稿工具（Web 版后端）",
)

# 开发期前端跑在 8080，需要跨域。生产环境同源部署时这条不影响。
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

app.include_router(api_router)

DEFAULT_WORKSPACE.mkdir(parents=True, exist_ok=True)


if FRONTEND_DIST.exists():
    # 静态资源走 /assets，其余路径回落到 index.html，交给 vue-router 处理。
    app.mount("/assets", StaticFiles(directory=FRONTEND_DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def serve_spa(full_path: str) -> FileResponse:
        candidate = FRONTEND_DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(FRONTEND_DIST / "index.html")
