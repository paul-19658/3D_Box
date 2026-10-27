"""REST API 路由。

所有路由都以 `/api` 为前缀，由 `main.py` 统一挂载。
约定：
- 成功返回业务数据本身，不额外包一层 `{code, data}`；
- 失败统一抛 HTTPException，由 FastAPI 输出 `{detail}`；
- 路径参数一律使用字符串 id，不暴露服务端真实文件路径。
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.services.ai_service import (
    AiProviderConfig,
    AiService,
    AiSettings,
    AI_DEFAULT_SYSTEM_PROMPT,
)
from app.services.platform_profiles import load_rules, validate_video_profile
from app.services.project_store import ProjectFileService, DEFAULT_WORKSPACE
from app.services.scene_output import build_scene_descriptor, build_suggested_prompt

router = APIRouter(prefix="/api")

store = ProjectFileService()
ai_service = AiService(settings_path=DEFAULT_WORKSPACE / "ai-environment.json")


# ----------------------------------------------------------------------
# 元信息
# ----------------------------------------------------------------------


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/meta")
def meta() -> dict[str, Any]:
    return {
        "appName": "小白盒",
        "appVersion": store.app_version,
        "projectExtension": "block3d",
        "projectSchemaVersion": 13,
    }


# ----------------------------------------------------------------------
# 工程
# ----------------------------------------------------------------------


class SaveProjectRequest(BaseModel):
    document: dict[str, Any]
    projectId: Optional[str] = None


class AutosaveRequest(BaseModel):
    document: dict[str, Any]
    projectId: Optional[str] = None


@router.get("/projects")
def list_projects() -> dict[str, Any]:
    return {"projects": store.list_projects()}


@router.post("/projects")
def save_project(request: SaveProjectRequest) -> dict[str, Any]:
    try:
        return store.save(request.document, request.projectId)
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"保存失败：{error}") from error


@router.get("/projects/{project_id}")
def open_project(project_id: str) -> dict[str, Any]:
    try:
        return store.open(project_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=f"工程文件损坏：{error}") from error


@router.delete("/projects/{project_id}")
def delete_project(project_id: str) -> dict[str, str]:
    store.delete(project_id)
    return {"status": "deleted"}


# ----------------------------------------------------------------------
# 自动恢复与最近工程
# ----------------------------------------------------------------------


@router.post("/recovery")
def save_recovery(request: AutosaveRequest) -> dict[str, str]:
    store.save_recovery(request.document, request.projectId)
    return {"status": "saved"}


@router.get("/recovery")
def load_recovery() -> dict[str, Any]:
    snapshot = store.load_recovery()
    if snapshot is None:
        return {"status": "empty"}
    return {"status": "found", "snapshot": snapshot}


@router.delete("/recovery")
def clear_recovery() -> dict[str, str]:
    store.clear_recovery()
    return {"status": "cleared"}


@router.get("/recent")
def list_recent() -> dict[str, Any]:
    return {"entries": store.list_recent()}


@router.delete("/recent/{project_id}")
def remove_recent(project_id: str) -> dict[str, Any]:
    store.remove_recent(project_id)
    return {"entries": store.list_recent()}


# ----------------------------------------------------------------------
# 导出
# ----------------------------------------------------------------------


class ExportFileRequest(BaseModel):
    fileName: str
    base64Data: str


@router.post("/exports")
def save_export(request: ExportFileRequest) -> dict[str, Any]:
    import base64

    try:
        data = base64.b64decode(request.base64Data)
    except Exception as error:
        raise HTTPException(status_code=400, detail="导出数据不是有效的 base64。") from error
    return store.write_export(request.fileName, data)


@router.post("/exports/upload")
async def upload_export(file: UploadFile = File(...)) -> dict[str, Any]:
    """二进制直传（序列帧 / MP4 这类大文件走这里，避免 base64 膨胀 33%）。"""
    data = await file.read()
    return store.write_export(file.filename or "export.bin", data)


# 下载时显式声明 MIME。
# 不写的话 Starlette 会按扩展名猜，`.mp4` 通常能猜对，但 `.block3d` 这类
# 自定义扩展会退化成 application/octet-stream，浏览器行为不可预期；
# 而视频尤其需要正确的 video/mp4 —— 否则部分浏览器不会内联播放，
# 用户点"下载"只能得到一串乱码。
EXPORT_MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".obj": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json",
}


@router.get("/exports/{file_name}")
def download_export(file_name: str) -> FileResponse:
    try:
        path = store.resolve_export(f"exports/{file_name}")
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except PermissionError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    return FileResponse(
        path,
        filename=path.name,
        media_type=EXPORT_MEDIA_TYPES.get(path.suffix.lower()),
    )


class ExportTextRequest(BaseModel):
    fileName: str
    content: str


@router.post("/exports/text")
def save_export_text(request: ExportTextRequest) -> dict[str, Any]:
    return store.write_export(request.fileName, request.content.encode("utf-8"))


# ----------------------------------------------------------------------
# 场景说明与提示词
# ----------------------------------------------------------------------


class SceneDescriptorRequest(BaseModel):
    projectName: str = "未命名场景"
    scene: dict[str, Any]


@router.post("/scene-descriptor")
def scene_descriptor(request: SceneDescriptorRequest) -> dict[str, Any]:
    return build_scene_descriptor(request.projectName, request.scene)


@router.post("/suggested-prompt")
def suggested_prompt(request: SceneDescriptorRequest) -> dict[str, Any]:
    return {"prompt": build_suggested_prompt(request.projectName, request.scene)}


# ----------------------------------------------------------------------
# 平台规则
# ----------------------------------------------------------------------


@router.get("/platform-profiles")
def platform_profiles() -> dict[str, Any]:
    rules = load_rules()
    return {
        "schemaVersion": rules.schemaVersion,
        "rulesVersion": rules.rulesVersion,
        "checkedAt": rules.checkedAt,
        "profiles": [profile.__dict__ for profile in rules.profiles],
    }


class ValidateVideoRequest(BaseModel):
    profileId: str
    width: int
    height: int
    frameRate: int
    durationSeconds: float
    bitrate: int


@router.post("/platform-profiles/validate")
def validate_video(request: ValidateVideoRequest) -> dict[str, Any]:
    rules = load_rules()
    profile = next((item for item in rules.profiles if item.id == request.profileId), None)
    if profile is None:
        raise HTTPException(status_code=404, detail="找不到该平台预设。")
    return validate_video_profile(
        profile,
        width=request.width,
        height=request.height,
        frame_rate=request.frameRate,
        duration_seconds=request.durationSeconds,
        bitrate=request.bitrate,
        checked_at=rules.checkedAt,
    )


# ----------------------------------------------------------------------
# AI
# ----------------------------------------------------------------------


@router.get("/ai/settings")
def ai_settings() -> dict[str, Any]:
    return {"settings": ai_service.public_settings()}


class ProviderInput(BaseModel):
    id: str
    name: str
    kind: str
    baseUrl: str = ""
    apiKey: str = ""
    model: str = ""
    temperature: float = 0.4
    maxTokens: int = 2048


class SaveAiSettingsRequest(BaseModel):
    activeProviderId: Optional[str] = None
    providers: list[ProviderInput] = []
    systemPrompt: str = AI_DEFAULT_SYSTEM_PROMPT


@router.put("/ai/settings")
def save_ai_settings(request: SaveAiSettingsRequest) -> dict[str, Any]:
    existing = ai_service.load_settings()
    existing_by_id = {provider.id: provider for provider in existing.providers}
    providers = []
    for entry in request.providers:
        # 前端不回传密钥明文，因此空密钥表示"沿用已保存的值"。
        api_key = entry.apiKey or existing_by_id.get(entry.id, AiProviderConfig("", "", "")).apiKey
        providers.append(
            AiProviderConfig(
                id=entry.id,
                name=entry.name,
                kind=entry.kind,
                baseUrl=entry.baseUrl,
                apiKey=api_key,
                model=entry.model,
                temperature=entry.temperature,
                maxTokens=entry.maxTokens,
            )
        )
    ai_service.save_settings(
        AiSettings(
            activeProviderId=request.activeProviderId,
            providers=providers,
            systemPrompt=request.systemPrompt,
        )
    )
    return {"settings": ai_service.public_settings()}


class AiChatRequest(BaseModel):
    messages: list[dict[str, Any]]
    sceneSummary: Optional[str] = None
    images: Optional[list[dict[str, str]]] = None
    tools: Optional[list[dict[str, Any]]] = None
    toolChoice: Optional[Any] = None


@router.post("/ai/chat")
async def ai_chat(request: AiChatRequest) -> dict[str, Any]:
    return await ai_service.chat(
        request.messages,
        request.sceneSummary,
        request.images,
        request.tools,
        request.toolChoice,
    )
