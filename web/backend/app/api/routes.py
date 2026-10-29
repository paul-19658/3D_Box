"""REST API 路由。

所有路由都以 `/api` 为前缀，由 `main.py` 统一挂载。
约定：
- 成功返回业务数据本身，不额外包一层 `{code, data}`；
- 失败统一抛 HTTPException，由 FastAPI 输出 `{detail}`；
- 路径参数一律使用字符串 id，不暴露服务端真实文件路径。
- 用户数据接口需要 Cookie 会话；公开接口：health / meta / platform-profiles / scene-descriptor。
"""

from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Response, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.db.models import User
from app.db.session import get_db
from app.services import project_repo
from app.services.ai_service import (
    AI_DEFAULT_MAX_TOKENS,
    AI_DEFAULT_SYSTEM_PROMPT,
    AiProviderConfig,
    AiService,
    AiSettings,
)
from app.services.auth import (
    clear_session_cookie,
    current_user,
    login_or_create,
    require_admin,
    set_session_cookie,
    user_public,
)
from app.services.platform_profiles import load_rules, validate_video_profile
from app.services.project_store import DEFAULT_WORKSPACE, ProjectFileService, user_workspace
from app.services.scene_output import build_scene_descriptor, build_suggested_prompt
from app.services.workspace_log import logs_dir, write_log_event

router = APIRouter(prefix="/api")

ai_service = AiService(settings_path=DEFAULT_WORKSPACE / "ai-environment.json")


def _store_for(user: User) -> ProjectFileService:
    return ProjectFileService(workspace=user_workspace(user.id))


# ----------------------------------------------------------------------
# 元信息 / 鉴权
# ----------------------------------------------------------------------


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/meta")
def meta() -> dict[str, Any]:
    return {
        "appName": "小白盒",
        "appVersion": "0.22.0",
        "projectExtension": "block3d",
        "projectSchemaVersion": 13,
    }


class LoginRequest(BaseModel):
    username: str
    # 预留字段：一期忽略，即使传入也不校验。
    password: Optional[str] = None


@router.post("/auth/login")
def auth_login(
    request: LoginRequest,
    response: Response,
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    user = login_or_create(db, request.username)
    set_session_cookie(response, user.id)
    write_log_event(
        logs_dir(DEFAULT_WORKSPACE),
        kind="auth.login",
        message=f"login {user.username}",
        payload={"userId": user.id, "username": user.username},
    )
    return {"user": user_public(user)}


@router.post("/auth/logout")
def auth_logout(response: Response) -> dict[str, str]:
    write_log_event(
        logs_dir(DEFAULT_WORKSPACE),
        kind="auth.logout",
        message="logout",
    )
    clear_session_cookie(response)
    return {"status": "ok"}


@router.get("/auth/me")
def auth_me(user: User = Depends(current_user)) -> dict[str, Any]:
    return {"user": user_public(user)}


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
def list_projects(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    rows = project_repo.list_owned(db, user.id)
    return {"projects": [project_repo.project_to_list_entry(row) for row in rows]}


@router.post("/projects")
def save_project(
    request: SaveProjectRequest,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    store = _store_for(user)
    if request.projectId:
        existing = project_repo.get_owned(db, user.id, request.projectId)
        if existing is None and store.path_for(request.projectId).exists():
            # 文件在别人目录里不会出现在这里；这里防止伪造他人 id 写入自己目录后串号。
            pass
        if existing is None and request.projectId:
            # 允许新建带指定 id，或覆盖自己已有工程；若库中无记录但 id 已被他人占用则 404。
            foreign = project_repo.get_any(db, request.projectId)
            if foreign is not None and foreign.owner_id != user.id:
                raise HTTPException(status_code=404, detail=f"找不到工程：{request.projectId}")
    try:
        result = store.save(request.document, request.projectId)
    except OSError as error:
        raise HTTPException(status_code=500, detail=f"保存失败：{error}") from error

    project_repo.upsert_after_save(
        db,
        project_id=result["projectId"],
        owner_id=user.id,
        name=str(result.get("name") or result["projectId"]),
        schema_version=int(result.get("schemaVersion") or 13),
        file_size_bytes=int(result.get("fileSizeBytes") or 0),
    )
    return result


@router.get("/projects/{project_id}")
def open_project(
    project_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    row = project_repo.get_owned(db, user.id, project_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"找不到工程：{project_id}")
    store = _store_for(user)
    try:
        result = store.open(project_id)
    except FileNotFoundError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=f"工程文件损坏：{error}") from error
    project_repo.mark_opened(db, user.id, project_id)
    return result


@router.delete("/projects/{project_id}")
def delete_project(
    project_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, str]:
    row = project_repo.get_owned(db, user.id, project_id)
    if row is None:
        raise HTTPException(status_code=404, detail=f"找不到工程：{project_id}")
    _store_for(user).delete(project_id)
    project_repo.delete_owned(db, user.id, project_id)
    return {"status": "deleted"}


# ----------------------------------------------------------------------
# 自动恢复与最近工程
# ----------------------------------------------------------------------


@router.post("/recovery")
def save_recovery(
    request: AutosaveRequest,
    user: User = Depends(current_user),
) -> dict[str, str]:
    _store_for(user).save_recovery(request.document, request.projectId)
    return {"status": "saved"}


@router.get("/recovery")
def load_recovery(user: User = Depends(current_user)) -> dict[str, Any]:
    snapshot = _store_for(user).load_recovery()
    if snapshot is None:
        return {"status": "empty"}
    return {"status": "found", "snapshot": snapshot}


@router.delete("/recovery")
def clear_recovery(user: User = Depends(current_user)) -> dict[str, str]:
    _store_for(user).clear_recovery()
    return {"status": "cleared"}


@router.get("/recent")
def list_recent(
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    rows = project_repo.list_recent(db, user.id)
    return {"entries": [project_repo.project_to_recent_entry(row) for row in rows]}


@router.delete("/recent/{project_id}")
def remove_recent(
    project_id: str,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict[str, Any]:
    rows = project_repo.forget_recent(db, user.id, project_id)
    return {"entries": [project_repo.project_to_recent_entry(row) for row in rows]}


# ----------------------------------------------------------------------
# 导出
# ----------------------------------------------------------------------


class ExportFileRequest(BaseModel):
    fileName: str
    base64Data: str


@router.post("/exports")
def save_export(
    request: ExportFileRequest,
    user: User = Depends(current_user),
) -> dict[str, Any]:
    import base64

    try:
        data = base64.b64decode(request.base64Data)
    except Exception as error:
        raise HTTPException(status_code=400, detail="导出数据不是有效的 base64。") from error
    return _store_for(user).write_export(request.fileName, data)


@router.post("/exports/upload")
async def upload_export(
    file: UploadFile = File(...),
    user: User = Depends(current_user),
) -> dict[str, Any]:
    """二进制直传（序列帧 / MP4 这类大文件走这里，避免 base64 膨胀 33%）。"""
    data = await file.read()
    return _store_for(user).write_export(file.filename or "export.bin", data)


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
def download_export(
    file_name: str,
    user: User = Depends(current_user),
) -> FileResponse:
    try:
        path = _store_for(user).resolve_export(f"exports/{file_name}")
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
def save_export_text(
    request: ExportTextRequest,
    user: User = Depends(current_user),
) -> dict[str, Any]:
    return _store_for(user).write_export(request.fileName, request.content.encode("utf-8"))


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
def ai_settings(user: User = Depends(current_user)) -> dict[str, Any]:
    _ = user
    return {"settings": ai_service.public_settings()}


class ProviderInput(BaseModel):
    id: str
    name: str
    kind: str
    baseUrl: str = ""
    apiKey: str = ""
    model: str = ""
    temperature: float = 0.4
    maxTokens: int = AI_DEFAULT_MAX_TOKENS


class SaveAiSettingsRequest(BaseModel):
    activeProviderId: Optional[str] = None
    providers: list[ProviderInput] = []
    systemPrompt: str = AI_DEFAULT_SYSTEM_PROMPT


@router.put("/ai/settings")
def save_ai_settings(
    request: SaveAiSettingsRequest,
    user: User = Depends(require_admin),
) -> dict[str, Any]:
    _ = user
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
    # 会话级选用的服务商；不写全局配置，普通用户也可切换。
    providerId: Optional[str] = None


@router.post("/ai/chat")
async def ai_chat(
    request: AiChatRequest,
    user: User = Depends(current_user),
) -> dict[str, Any]:
    return await ai_service.chat(
        request.messages,
        request.sceneSummary,
        request.images,
        request.tools,
        request.toolChoice,
        request.providerId,
        log_context={"userId": user.id, "username": user.username},
    )
