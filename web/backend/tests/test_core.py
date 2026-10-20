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
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient

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
from app.services.platform_profiles import load_rules, validate_video_profile
from app.services.project_store import ProjectFileService
from app.services.scene_output import (
    describe_lighting,
    light_color_text,
    light_height_text,
    light_side_text,
    resolve_shadow_caster_ids,
    summarize_scene,
)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def store(tmp_path) -> ProjectFileService:
    return ProjectFileService(workspace=tmp_path)


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


def test_recent_projects_are_deduplicated_and_capped(store: ProjectFileService) -> None:
    for index in range(25):
        store.record_recent(f"project-{index}", f"工程 {index}")
    store.record_recent("project-0", "工程 0")

    entries = store.list_recent()
    assert entries[0]["projectId"] == "project-0"
    assert len(entries) == 20


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
    document = create_project_document(
        name="HTTP 工程", scene=_scene(), app_version="0.22.0", saved_at="2026-01-01T00:00:00Z"
    ).model_dump(by_alias=True)

    saved = client.post("/api/projects", json={"document": document}).json()
    project_id = saved["projectId"]

    opened = client.get(f"/api/projects/{project_id}").json()
    assert opened["document"]["name"] == "HTTP 工程"

    listed = client.get("/api/projects").json()["projects"]
    assert any(entry["projectId"] == project_id for entry in listed)

    client.delete(f"/api/projects/{project_id}")
    assert client.get(f"/api/projects/{project_id}").status_code == 404


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


def test_ai_settings_never_returns_api_key(client: TestClient) -> None:
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
