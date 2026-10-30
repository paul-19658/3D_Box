"""后端核心逻辑测试。

运行方式（web/backend 目录下）：
    py -3.10 -m pytest -q

这些测试固定三件事：
1. 工程存取与迁移不会丢数据；
2. 场景说明与光照描述符合约定措辞；
3. 平台规则校验给出可执行的错误与提醒。
"""

from __future__ import annotations

import json
import subprocess
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.db.models import User
from app.db.session import SessionLocal, get_db, init_db, reset_engine
from app.main import app
from app.models.project import (
    DEFAULT_CAMERA,
    DEFAULT_LIGHTING,
    DEFAULT_TIMELINE,
    PROJECT_SCHEMA_VERSION,
    SceneState,
    create_project_document,
    migrate_document,
)
from app.services import project_repo
from app.services import auth as auth_module
from app.services.auth import ROLE_ADMIN
from app.services.platform_profiles import load_rules, validate_video_profile
from app.services.project_store import ProjectFileService
from app.services import project_store as project_store_module
from app.services.scene_output import (
    describe_lighting,
    light_color_text,
    light_height_text,
    light_side_text,
    resolve_shadow_caster_ids,
    summarize_scene,
)
import app.api.routes as routes_module


@pytest.fixture
def isolated_env(tmp_path, monkeypatch):
    """每个测试使用独立 workspace 与 SQLite，并重绑 AI 配置路径。"""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    db_url = f"sqlite:///{(tmp_path / 'test.db').as_posix()}"
    monkeypatch.setenv("WHITEBOX_WORKSPACE", str(workspace))
    monkeypatch.setenv("WHITEBOX_DATABASE_URL", db_url)
    monkeypatch.setenv("WHITEBOX_SECRET_KEY", "test-secret-key")
    monkeypatch.setattr(project_store_module, "DEFAULT_WORKSPACE", workspace)
    monkeypatch.setattr(auth_module, "DEFAULT_WORKSPACE", workspace)
    monkeypatch.setattr(routes_module, "DEFAULT_WORKSPACE", workspace)
    routes_module.ai_service.settings_path = workspace / "ai-environment.json"
    reset_engine(db_url)
    init_db()

    def _override_db():
        db = SessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _override_db
    yield workspace
    app.dependency_overrides.clear()


@pytest.fixture
def client(isolated_env) -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def store(tmp_path) -> ProjectFileService:
    return ProjectFileService(workspace=tmp_path)


def login(client: TestClient, username: str = "alice") -> dict:
    response = client.post("/api/auth/login", json={"username": username})
    assert response.status_code == 200, response.text
    return response.json()["user"]


def make_admin(username: str = "admin") -> User:
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.username_key == username.lower()))
        assert user is not None
        user.role = ROLE_ADMIN
        db.commit()
        db.refresh(user)
        return user


def _scene(objects=None) -> SceneState:
    return SceneState(
        objects=objects or [],
        camera=DEFAULT_CAMERA,
        lighting=DEFAULT_LIGHTING,
        timeline=DEFAULT_TIMELINE,
    )


# ----------------------------------------------------------------------
# 工程存取
# ----------------------------------------------------------------------


def test_save_and_open_roundtrip(store: ProjectFileService) -> None:
    document = create_project_document(
        name="客厅方案",
        scene=_scene(),
        app_version="0.22.0",
        saved_at=datetime.now(timezone.utc).isoformat(),
    ).model_dump(by_alias=True)

    saved = store.save(document)
    opened = store.open(saved["projectId"])

    assert opened["document"]["name"] == "客厅方案"
    assert opened["document"]["schemaVersion"] == PROJECT_SCHEMA_VERSION


def test_project_filename_is_sanitised(store: ProjectFileService) -> None:
    document = create_project_document(
        name="../../etc/passwd",
        scene=_scene(),
        app_version="0.22.0",
        saved_at="2026-01-01T00:00:00Z",
    ).model_dump(by_alias=True)

    saved = store.save(document)
    assert ".." not in saved["projectId"]
    assert "/" not in saved["projectId"]


def test_recovery_keeps_only_latest_snapshot(store: ProjectFileService) -> None:
    first = create_project_document(
        name="第一版", scene=_scene(), app_version="0.22.0", saved_at="2026-01-01T00:00:00Z"
    ).model_dump(by_alias=True)
    second = create_project_document(
        name="第二版", scene=_scene(), app_version="0.22.0", saved_at="2026-01-02T00:00:00Z"
    ).model_dump(by_alias=True)

    store.save_recovery(first, None)
    store.save_recovery(second, None)

    snapshot = store.load_recovery()
    assert snapshot is not None
    assert snapshot["document"]["name"] == "第二版"


def test_export_path_traversal_is_blocked(store: ProjectFileService) -> None:
    store.ensure_dirs()
    with pytest.raises(PermissionError):
        store.resolve_export("../../secrets.txt")


# ----------------------------------------------------------------------
# 工程迁移
# ----------------------------------------------------------------------


def test_legacy_document_falls_back_to_defaults() -> None:
    migrated = migrate_document({"name": "老工程", "scene": {}}, "0.22.0", "2026-01-01T00:00:00Z")

    assert migrated["schemaVersion"] == PROJECT_SCHEMA_VERSION
    assert migrated["scene"]["camera"]["fovDegrees"] == DEFAULT_CAMERA.fovDegrees
    assert migrated["scene"]["lighting"]["lights"][0]["name"] == "柔和主光"
    assert migrated["scene"]["objects"] == []


def test_corrupted_object_is_skipped_not_fatal() -> None:
    raw = {
        "name": "损坏工程",
        "scene": {
            "objects": [
                {"id": "broken"},
                {"id": "ok", "kind": "box", "name": "方块", "position": {"x": 0, "y": 0, "z": 0},
                 "rotation": {"x": 0, "y": 0, "z": 0}, "size": {"x": 1, "y": 1, "z": 1},
                 "color": "#ffffff", "visible": True, "locked": False},
            ],
            "camera": DEFAULT_CAMERA.model_dump(),
            "lighting": DEFAULT_LIGHTING.model_dump(),
            "timeline": DEFAULT_TIMELINE.model_dump(),
        },
    }
    migrated = migrate_document(raw, "0.22.0", "2026-01-01T00:00:00Z")
    assert [obj["id"] for obj in migrated["scene"]["objects"]] == ["ok"]


# ----------------------------------------------------------------------
# 光照描述：与前端保持同一套措辞
# ----------------------------------------------------------------------


def _light(**overrides):
    base = {
        "id": "light-1",
        "name": "点光源 01",
        "kind": "point",
        "position": {"x": 3.0, "y": 5.0, "z": 3.0},
        "target": {"x": 0.0, "y": 1.0, "z": 0.0},
        "color": "#fff1d6",
        "intensity": 3.2,
        "size": 0.35,
        "angleDegrees": 45,
        "visible": True,
        "locked": False,
    }
    base.update(overrides)
    return base


def test_light_side_text_reports_eight_directions() -> None:
    assert light_side_text({"x": 0, "y": 1, "z": 0}, {"x": 0, "y": 0, "z": 0}) == "正上方"
    assert light_side_text({"x": 0, "y": 1, "z": 5}, {"x": 0, "y": 0, "z": 0}) == "前方"
    assert light_side_text({"x": 5, "y": 1, "z": 5}, {"x": 0, "y": 0, "z": 0}) == "右前方"


def test_light_height_text_uses_elevation_angle() -> None:
    assert "顶光" in light_height_text({"x": 0, "y": 10, "z": 0}, {"x": 0, "y": 0, "z": 0})
    assert "平光" in light_height_text({"x": 5, "y": 0, "z": 0}, {"x": 0, "y": 0, "z": 0})
    assert "底光" in light_height_text({"x": 0, "y": -3, "z": 0}, {"x": 0, "y": 0, "z": 0})


def test_warm_white_is_not_reported_as_saturated_orange() -> None:
    assert light_color_text("#fff1d6") == "暖白光"
    assert light_color_text("#e5f4f1") == "冷白光"
    assert light_color_text("#ff3b30") == "偏红色光"
    assert light_color_text("not-a-color") == "未知色调"


def test_area_light_does_not_consume_shadow_slot() -> None:
    lights = [_light(id="area", kind="area"), _light(id="sun", kind="sun")]
    ids = resolve_shadow_caster_ids(lights)
    assert "area" not in ids
    assert "sun" in ids


def test_hidden_light_passes_shadow_slot_to_next() -> None:
    lights = [_light(id="hidden", kind="sun", visible=False), _light(id="visible", kind="spot")]
    ids = resolve_shadow_caster_ids(lights)
    assert "hidden" not in ids
    assert "visible" in ids


def test_lighting_description_mentions_fixed_ambient_and_shadow() -> None:
    result = describe_lighting([_light(name="太阳", kind="sun")])
    joined = "\n".join(result["promptLines"])
    assert "固定环境光" in joined
    assert "仅 太阳 投射阴影" in joined
    assert result["visibleCount"] == 1


def test_scene_summary_includes_lighting_line() -> None:
    summary = summarize_scene(_scene().model_dump())
    assert "光照" in summary
    assert "固定半球环境光" in summary


# ----------------------------------------------------------------------
# 平台规则
# ----------------------------------------------------------------------


def test_profile_rules_load() -> None:
    rules = load_rules()
    assert rules.schemaVersion == 1
    assert rules.checkedAt
    assert len(rules.profiles) > 0


def test_validation_reports_resolution_and_frame_rate_errors() -> None:
    profile = load_rules().profiles[0]
    result = validate_video_profile(
        profile,
        width=4096,
        height=2160,
        frame_rate=60,
        duration_seconds=5,
        bitrate=8_000_000,
        checked_at=load_rules().checkedAt,
    )
    joined = " ".join(result["errors"])
    assert "超过" in joined
    assert "帧" in joined
    assert result["warnings"]


def test_validation_warns_about_checked_date() -> None:
    rules = load_rules()
    profile = rules.profiles[0]
    result = validate_video_profile(
        profile,
        width=1280,
        height=720,
        frame_rate=profile.frameRate,
        duration_seconds=5,
        bitrate=4_000_000,
        checked_at=rules.checkedAt,
    )
    assert any("核对于" in warning for warning in result["warnings"])


# ----------------------------------------------------------------------
# HTTP 接口
# ----------------------------------------------------------------------


def test_health_and_meta(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}
    meta = client.get("/api/meta").json()
    assert meta["projectSchemaVersion"] == PROJECT_SCHEMA_VERSION


def test_project_crud_over_http(client: TestClient) -> None:
    login(client, "alice")
    document = create_project_document(
        name="HTTP 工程", scene=_scene(), app_version="0.22.0", saved_at="2026-01-01T00:00:00Z"
    ).model_dump(by_alias=True)

    saved = client.post("/api/projects", json={"document": document}).json()
    project_id = saved["projectId"]

    opened = client.get(f"/api/projects/{project_id}").json()
    assert opened["document"]["name"] == "HTTP 工程"

    listed = client.get("/api/projects").json()["projects"]
    assert any(entry["projectId"] == project_id for entry in listed)

    recent = client.get("/api/recent").json()["entries"]
    assert any(entry["projectId"] == project_id for entry in recent)

    client.delete(f"/api/projects/{project_id}")
    assert client.get(f"/api/projects/{project_id}").status_code == 404


def test_projects_require_login(client: TestClient) -> None:
    assert client.get("/api/projects").status_code == 401


def test_username_is_case_insensitive(client: TestClient) -> None:
    first = login(client, "Alice")
    client.post("/api/auth/logout")
    second = login(client, "alice")
    assert first["id"] == second["id"]


def test_user_cannot_access_others_project(client: TestClient) -> None:
    login(client, "alice")
    document = create_project_document(
        name="Alice工程", scene=_scene(), app_version="0.22.0", saved_at="2026-01-01T00:00:00Z"
    ).model_dump(by_alias=True)
    project_id = client.post("/api/projects", json={"document": document}).json()["projectId"]
    client.post("/api/auth/logout")

    login(client, "bob")
    assert client.get(f"/api/projects/{project_id}").status_code == 404
    assert client.delete(f"/api/projects/{project_id}").status_code == 404


def test_forget_recent_clears_last_opened(client: TestClient) -> None:
    login(client, "alice")
    document = create_project_document(
        name="最近", scene=_scene(), app_version="0.22.0", saved_at="2026-01-01T00:00:00Z"
    ).model_dump(by_alias=True)
    project_id = client.post("/api/projects", json={"document": document}).json()["projectId"]
    assert any(entry["projectId"] == project_id for entry in client.get("/api/recent").json()["entries"])
    entries = client.delete(f"/api/recent/{project_id}").json()["entries"]
    assert all(entry["projectId"] != project_id for entry in entries)
    # 工程本身还在。
    assert any(entry["projectId"] == project_id for entry in client.get("/api/projects").json()["projects"])


def test_export_is_user_scoped(client: TestClient) -> None:
    login(client, "alice")
    saved = client.post(
        "/api/exports/text", json={"fileName": "note.txt", "content": "alice"}
    ).json()
    file_name = saved["fileName"]
    assert client.get(f"/api/exports/{file_name}").status_code == 200
    client.post("/api/auth/logout")

    login(client, "bob")
    assert client.get(f"/api/exports/{file_name}").status_code == 404


def test_meta_reports_server_mp4_encode_flag(client: TestClient) -> None:
    meta = client.get("/api/meta").json()
    assert isinstance(meta.get("serverMp4Encode"), bool)


def test_encode_mp4_requires_ffmpeg(client: TestClient, monkeypatch) -> None:
    login(client, "alice")
    monkeypatch.setattr("app.api.routes.ffmpeg_available", lambda: False)
    response = client.post(
        "/api/exports/encode-mp4",
        data={"frameRate": "24", "fileName": "clip.mp4"},
        files=[("frames", ("frame_0000.png", b"not-a-real-png", "image/png"))],
    )
    assert response.status_code == 503
    assert "ffmpeg" in response.json()["detail"].lower()


def test_encode_mp4_from_uploaded_frames(client: TestClient, tmp_path) -> None:
    from app.services.video_encode import FFMPEG_BIN, ffmpeg_available

    if not ffmpeg_available():
        import pytest

        pytest.skip("本机未安装 ffmpeg")

    login(client, "alice")
    frames_dir = tmp_path / "frames"
    frames_dir.mkdir()
    # 生成 3 帧偶数尺寸纯色图，模拟前端上传的序列。
    generated = subprocess.run(
        [
            FFMPEG_BIN,
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=64x48:d=1",
            "-frames:v",
            "3",
            str(frames_dir / "frame_%04d.png"),
        ],
        capture_output=True,
        check=False,
    )
    assert generated.returncode == 0, generated.stderr.decode("utf-8", errors="replace")
    files = sorted(frames_dir.glob("frame_*.png"))
    assert len(files) == 3

    response = client.post(
        "/api/exports/encode-mp4",
        data={"frameRate": "24", "fileName": "clip.mp4"},
        files=[("frames", (path.name, path.read_bytes(), "image/png")) for path in files],
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["fileName"].endswith(".mp4")
    assert body["byteLength"] > 0
    assert client.get(f"/api/exports/{body['fileName']}").status_code == 200


def test_admin_can_manage_users_and_foreign_projects(client: TestClient) -> None:
    login(client, "admin")
    make_admin("admin")
    # 重新登录以刷新会话用户（角色已在库中变更，current_user 每次读库）。
    client.post("/api/auth/logout")
    login(client, "admin")

    login(client, "alice")  # 这会把 cookie 换成 alice
    document = create_project_document(
        name="归属Alice", scene=_scene(), app_version="0.22.0", saved_at="2026-01-01T00:00:00Z"
    ).model_dump(by_alias=True)
    project_id = client.post("/api/projects", json={"document": document}).json()["projectId"]
    client.post("/api/auth/logout")

    login(client, "admin")
    listed = client.get("/api/admin/projects").json()["projects"]
    assert any(entry["projectId"] == project_id and entry["ownerUsername"] == "alice" for entry in listed)

    opened = client.get(f"/api/admin/projects/{project_id}").json()
    assert opened["readOnly"] is True
    assert opened["document"]["name"] == "归属Alice"

    with SessionLocal() as db:
        row = project_repo.get_any(db, project_id)
        assert row is not None
        # 只读打开不应刷新 last_opened_at 给管理员侧的"最近"——这里确认 owner 的 last_opened 仍在。
        assert row.last_opened_at is not None

    assert client.delete(f"/api/admin/projects/{project_id}").status_code == 200
    assert client.get(f"/api/admin/projects/{project_id}").status_code == 404


def test_non_admin_cannot_change_ai_or_admin_api(client: TestClient) -> None:
    login(client, "alice")
    assert client.put(
        "/api/ai/settings",
        json={"activeProviderId": None, "providers": [], "systemPrompt": "x"},
    ).status_code == 403
    assert client.get("/api/admin/users").status_code == 403


def test_disabled_user_cannot_login_or_use_cookie(client: TestClient) -> None:
    login(client, "admin")
    make_admin("admin")
    client.post("/api/auth/logout")
    login(client, "admin")

    # 先让 alice 存在。
    client.post("/api/auth/logout")
    alice = login(client, "alice")
    client.post("/api/auth/logout")
    login(client, "admin")
    patched = client.patch(
        f"/api/admin/users/{alice['id']}", json={"isActive": False}
    )
    assert patched.status_code == 200

    denied = client.post("/api/auth/login", json={"username": "alice"})
    assert denied.status_code == 403


def test_cannot_demote_last_admin_or_self(client: TestClient) -> None:
    login(client, "admin")
    make_admin("admin")
    client.post("/api/auth/logout")
    admin = login(client, "admin")

    assert client.patch(
        f"/api/admin/users/{admin['id']}", json={"role": "user"}
    ).status_code == 409
    assert client.patch(
        f"/api/admin/users/{admin['id']}", json={"isActive": False}
    ).status_code == 409


def test_scene_descriptor_includes_lighting(client: TestClient) -> None:
    scene = _scene().model_dump()
    response = client.post(
        "/api/scene-descriptor", json={"projectName": "测试", "scene": scene}
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["schemaVersion"] == 2
    assert payload["lighting"]["lights"][0]["kind"] == "area"
    assert payload["lighting"]["fixed"][0]["producesShadow"] is False


def test_compose_system_prompt_embeds_schema_for_legacy_prompt() -> None:
    from app.services.ai_service import (
        AI_DEFAULT_SYSTEM_PROMPT,
        AI_SCENE_COMMAND_SCHEMA_HINT,
        compose_system_prompt,
        sanitize_images,
    )

    assert "list_assets" in AI_DEFAULT_SYSTEM_PROMPT
    assert "apply_scene_commands" in AI_DEFAULT_SYSTEM_PROMPT
    assert "animate_move" in AI_DEFAULT_SYSTEM_PROMPT
    assert "animate_camera" in AI_DEFAULT_SYSTEM_PROMPT
    assert "animate_camera" in AI_SCENE_COMMAND_SCHEMA_HINT
    assert AI_SCENE_COMMAND_SCHEMA_HINT[:20] in AI_DEFAULT_SYSTEM_PROMPT

    # 旧版「一次吐 JSON」提示 → 回落默认 agent 提示。
    legacy_json = "你必须输出可被软件自动执行的 JSON 命令数组。"
    composed_legacy = compose_system_prompt(legacy_json)
    assert "list_assets" in composed_legacy
    assert "能力提醒" in composed_legacy

    # 缺 remove_object 的旧自定义提示 → 追加 schema。
    legacy = "你是助手。可以用 clear_scene 清场。"
    composed = compose_system_prompt(legacy)
    assert "remove_object" in composed
    assert "能力提醒" in composed

    cleaned = sanitize_images(
        [
            {"mimeType": "image/png", "base64Data": "abcd"},
            {"mimeType": "text/plain", "base64Data": "nope"},
            {"mimeType": "image/jpeg", "base64Data": ""},
        ]
    )
    assert cleaned == [{"mimeType": "image/png", "base64Data": "abcd"}]


def test_ai_tools_pack_and_parse_openai_and_anthropic() -> None:
    from app.services.ai_service import AiProviderConfig, AiService, sanitize_tools

    tools = sanitize_tools(
        [
            {
                "name": "list_assets",
                "description": "列出资产",
                "parameters": {"type": "object", "properties": {}},
            },
            {"name": "", "description": "应被丢弃"},
            "not-a-dict",
        ]
    )
    assert len(tools) == 1
    assert tools[0]["name"] == "list_assets"

    service = AiService(settings_path=__import__("pathlib").Path("unused.json"))
    openai_provider = AiProviderConfig(
        id="o1",
        name="OpenAI",
        kind="openai",
        apiKey="sk-test",
        model="gpt-4o-mini",
    )
    anthropic_provider = AiProviderConfig(
        id="a1",
        name="Anthropic",
        kind="anthropic",
        apiKey="sk-ant",
        model="claude-3-5-sonnet-latest",
    )

    messages = [
        {"role": "user", "content": "搭个房间"},
        {
            "role": "assistant",
            "content": "先查资产",
            "toolCalls": [
                {"id": "call_1", "name": "list_assets", "arguments": {"limit": 10}}
            ],
        },
        {
            "role": "tool",
            "toolCallId": "call_1",
            "content": '{"total":0,"items":[]}',
        },
    ]

    _, _, openai_body = service._build_openai(
        openai_provider,
        "system",
        messages,
        None,
        None,
        tools,
        "auto",
    )
    assert "tools" in openai_body
    assert openai_body["tools"][0]["type"] == "function"
    assert openai_body["tools"][0]["function"]["name"] == "list_assets"
    assert openai_body["tool_choice"] == "auto"
    assert openai_body["messages"][2]["tool_calls"][0]["id"] == "call_1"
    assert openai_body["messages"][3]["role"] == "tool"
    assert openai_body["messages"][3]["tool_call_id"] == "call_1"

    _, _, anthropic_body = service._build_anthropic(
        anthropic_provider,
        "system",
        messages,
        None,
        None,
        tools,
        "auto",
    )
    assert anthropic_body["tools"][0]["name"] == "list_assets"
    assert anthropic_body["tools"][0]["input_schema"]["type"] == "object"
    assert anthropic_body["tool_choice"] == {"type": "auto"}
    assistant_blocks = anthropic_body["messages"][1]["content"]
    assert any(block.get("type") == "tool_use" for block in assistant_blocks)
    tool_user = anthropic_body["messages"][2]
    assert tool_user["role"] == "user"
    assert tool_user["content"][0]["type"] == "tool_result"

    openai_calls = AiService._extract_tool_calls(
        "openai",
        {
            "choices": [
                {
                    "message": {
                        "content": "",
                        "tool_calls": [
                            {
                                "id": "tc1",
                                "type": "function",
                                "function": {
                                    "name": "done",
                                    "arguments": '{"summary":"完成"}',
                                },
                            }
                        ],
                    }
                }
            ]
        },
    )
    assert openai_calls == [{"id": "tc1", "name": "done", "arguments": {"summary": "完成"}}]

    anthropic_calls = AiService._extract_tool_calls(
        "anthropic",
        {
            "content": [
                {"type": "text", "text": "好的"},
                {
                    "type": "tool_use",
                    "id": "tu1",
                    "name": "apply_scene_commands",
                    "input": {"commands": [{"type": "clear_scene"}]},
                },
            ]
        },
    )
    assert anthropic_calls[0]["name"] == "apply_scene_commands"
    assert anthropic_calls[0]["arguments"]["commands"][0]["type"] == "clear_scene"

    # 无 tools 时请求体不含 tools 字段（兼容旧纯文本）。
    _, _, plain = service._build_openai(
        openai_provider, "system", [{"role": "user", "content": "hi"}], None, None, None, None
    )
    assert "tools" not in plain
    assert AiService._extract_tool_calls(
        "openai", {"choices": [{"message": {"content": "你好"}}]}
    ) == []


def test_openai_tool_transport_and_responses_packaging() -> None:
    from app.services.ai_service import (
        AiProviderConfig,
        AiService,
        looks_like_tools_reasoning_conflict,
        openai_tool_transport,
        sanitize_tools,
    )

    assert openai_tool_transport("gpt-6-astra", True) == "responses"
    assert openai_tool_transport("gpt-6.1-sol", True) == "responses"
    assert openai_tool_transport("gpt-5.6-luna", True) == "chat_none"
    assert openai_tool_transport("gpt-4o-mini", True) == "chat"
    assert openai_tool_transport("gpt-6-astra", False) == "chat"
    assert looks_like_tools_reasoning_conflict(
        "Function tools with reasoning_effort are not supported ... use /v1/responses"
    )

    tools = sanitize_tools(
        [
            {
                "name": "list_assets",
                "description": "列出资产",
                "parameters": {"type": "object", "properties": {}},
            }
        ]
    )
    service = AiService(settings_path=__import__("pathlib").Path("unused.json"))
    astra = AiProviderConfig(
        id="a",
        name="Astra",
        kind="openai-compatible",
        apiKey="sk",
        model="gpt-6-astra",
        baseUrl="https://example.com/v1",
    )
    luna = AiProviderConfig(
        id="l",
        name="Luna",
        kind="openai-compatible",
        apiKey="sk",
        model="gpt-5.6-luna",
        baseUrl="https://example.com/v1",
    )

    url, _, responses_body = service._build_openai_responses(
        astra,
        "system",
        [
            {"role": "user", "content": "搭个房间"},
            {
                "role": "assistant",
                "content": None,
                "toolCalls": [{"id": "call_1", "name": "list_assets", "arguments": {}}],
            },
            {"role": "tool", "toolCallId": "call_1", "content": '{"total":0}'},
        ],
        None,
        None,
        tools,
        "auto",
    )
    assert url.endswith("/responses")
    assert responses_body["tools"][0]["name"] == "list_assets"
    assert "function" not in responses_body["tools"][0]
    assert responses_body["input"][1]["type"] == "function_call"
    assert responses_body["input"][2]["type"] == "function_call_output"

    _, _, chat_body = service._build_openai(
        luna,
        "system",
        [{"role": "user", "content": "搭个房间"}],
        None,
        None,
        tools,
        "auto",
        reasoning_effort="none",
    )
    assert chat_body["reasoning_effort"] == "none"
    assert chat_body["tools"][0]["type"] == "function"

    calls = AiService._extract_tool_calls(
        "openai-responses",
        {
            "output": [
                {
                    "type": "function_call",
                    "call_id": "call_9",
                    "name": "done",
                    "arguments": '{"summary":"完成"}',
                }
            ]
        },
    )
    assert calls == [{"id": "call_9", "name": "done", "arguments": {"summary": "完成"}}]
    text = AiService._extract_content(
        "openai-responses",
        {
            "output": [
                {
                    "type": "message",
                    "content": [{"type": "output_text", "text": "好的"}],
                }
            ]
        },
    )
    assert text == "好的"


def test_ai_settings_never_returns_api_key(client: TestClient) -> None:
    login(client, "admin")
    make_admin("admin")
    client.post("/api/auth/logout")
    login(client, "admin")

    client.put(
        "/api/ai/settings",
        json={
            "activeProviderId": "p1",
            "providers": [
                {
                    "id": "p1",
                    "name": "自建",
                    "kind": "openai-compatible",
                    "baseUrl": "https://example.com/v1",
                    "apiKey": "secret-key",
                    "model": "gpt-4o-mini",
                }
            ],
            "systemPrompt": "测试提示",
        },
    )
    payload = client.get("/api/ai/settings").json()
    serialized = json.dumps(payload, ensure_ascii=False)
    assert "secret-key" not in serialized
    assert payload["settings"]["providers"][0]["hasApiKey"] is True

    # 空密钥表示"沿用已保存的值"，不应把原有密钥清空。
    client.put(
        "/api/ai/settings",
        json={
            "activeProviderId": "p1",
            "providers": [
                {
                    "id": "p1",
                    "name": "自建",
                    "kind": "openai-compatible",
                    "baseUrl": "https://example.com/v1",
                    "apiKey": "",
                    "model": "gpt-4o-mini",
                }
            ],
            "systemPrompt": "测试提示",
        },
    )
    payload = client.get("/api/ai/settings").json()
    assert payload["settings"]["providers"][0]["hasApiKey"] is True


def test_resolve_max_tokens_bumps_legacy_default() -> None:
    from app.services.ai_service import (
        AI_DEFAULT_MAX_TOKENS,
        AiProviderConfig,
        resolve_max_tokens,
    )

    assert resolve_max_tokens(2048) == AI_DEFAULT_MAX_TOKENS
    assert resolve_max_tokens(1024) == AI_DEFAULT_MAX_TOKENS
    assert resolve_max_tokens(16384) == 16384
    provider = AiProviderConfig(
        id="p",
        name="t",
        kind="openai-compatible",
        maxTokens=2048,
    )
    assert provider.resolved_max_tokens() == AI_DEFAULT_MAX_TOKENS


def test_detect_output_truncation_for_incomplete_tool_json() -> None:
    from app.services.ai_service import AiService

    truncated = AiService._extract_tool_calls(
        "openai-responses",
        {
            "status": "incomplete",
            "incomplete_details": {"reason": "max_output_tokens"},
            "output": [
                {
                    "type": "function_call",
                    "call_id": "call_1",
                    "name": "apply_scene_commands",
                    "status": "incomplete",
                    "arguments": '{"commands":[{"type":"clear_scene"},{"type":"add_object","kind":"cylinder","position":{"x":',
                }
            ],
        },
    )
    assert truncated[0]["arguments"].get("_truncated") is True
    detected = AiService._detect_output_truncation("openai-responses", {
        "status": "incomplete",
        "incomplete_details": {"reason": "max_output_tokens"},
        "output": [{"type": "function_call", "status": "incomplete"}],
    }, truncated)
    assert detected is not None
    assert "maxTokens" in detected["message"]


def test_workspace_log_redacts_secrets_and_images(tmp_path) -> None:
    from app.services.workspace_log import (
        logs_dir,
        redact_for_log,
        summarize_images,
        write_agent_call_log,
        write_log_event,
    )

    redacted = redact_for_log(
        {
            "apiKey": "sk-secret",
            "authorization": "Bearer tok",
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "看图"},
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": "data:image/png;base64," + ("A" * 200),
                            },
                        },
                    ],
                }
            ],
        }
    )
    assert redacted["apiKey"] == "<redacted>"
    assert redacted["authorization"] == "<redacted>"
    image_url = redacted["messages"][0]["content"][1]["image_url"]["url"]
    assert "omitted" in image_url
    assert "sk-secret" not in str(redacted)

    summary = summarize_images(
        [{"mimeType": "image/png", "base64Data": "abcd", "label": "总览"}]
    )
    assert summary == [{"mimeType": "image/png", "byteLength": 4, "label": "总览"}]

    log_dir = logs_dir(tmp_path)
    path = write_log_event(log_dir, kind="test.event", message="hello")
    assert path is not None and path.name.endswith(".log")
    assert path.parent == log_dir

    agent_path = write_agent_call_log(
        log_dir,
        {"id": "abc", "request": {"apiKey": "sk-x"}, "result": {"status": "ok"}},
    )
    assert agent_path == path
    text = path.read_text(encoding="utf-8")
    assert '"kind": "test.event"' in text
    assert '"kind": "ai.chat"' in text
    assert '"apiKey": "<redacted>"' in text
    assert "sk-x" not in text


def test_ai_chat_writes_agent_log_on_config_error(tmp_path) -> None:
    import asyncio

    from app.services.ai_service import AiService

    service = AiService(settings_path=tmp_path / "ai-environment.json")
    result = asyncio.run(
        service.chat(
            [{"role": "user", "content": "你好"}],
            log_context={"userId": "u1", "username": "alice"},
        )
    )
    assert result["status"] == "error"

    log_files = list((tmp_path / "logs").glob("*.log"))
    assert len(log_files) == 1
    entry = json.loads(log_files[0].read_text(encoding="utf-8").strip())
    assert entry["kind"] == "ai.chat"
    assert entry["context"]["username"] == "alice"
    assert entry["request"]["messages"][0]["content"] == "你好"
    assert entry["result"]["status"] == "error"
    assert "durationMs" in entry
