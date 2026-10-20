"""小白盒 Web 版 —— 工程数据模型。

本模块是 Python 侧对 `app/src/shared/project-document.ts` 的等价实现。
两端必须保持 schema 一致：前端序列化出的 JSON 要能被这里的校验函数接受，
反之亦然。修改任一端的字段都必须同步另一端，并在
`docs/AI_DEV_GUIDE.md` 的"跨端契约"一节登记。

关键约定：
- 长度单位统一为米，旋转单位统一为度。
- 颜色统一为 `#rrggbb` 小写十六进制字符串。
- schema 版本号 `PROJECT_SCHEMA_VERSION` 是迁移入口，只增不改。
"""

from __future__ import annotations

from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, ConfigDict, Field

# schema 13：新增 `kind: "path"` 的导航线对象（带 pathNodes）。
# 与前端 `PROJECT_SCHEMA_VERSION` 必须始终一致，冒烟脚本会断言这个数字。
PROJECT_SCHEMA_VERSION = 13
PROJECT_EXTENSION = "block3d"

PrimitiveKind = Literal[
    "box", "cylinder", "sphere", "wall", "floor", "custom", "imported", "mannequin", "path"
]
BasicPrimitiveKind = Literal["box", "cylinder", "sphere", "wall", "floor"]
ObjectDisplayMode = Literal["solid", "transparent", "wireframe"]
ImportedModelFormat = Literal["glb", "gltf", "obj"]
ImportedModelQuality = Literal["original", "lightweight"]
SceneLightKind = Literal["point", "spot", "area", "sun"]
CameraTransition = Literal["smooth", "cut"]
ObjectInterpolation = Literal["smooth", "linear"]

MANNEQUIN_JOINT_IDS = (
    "head",
    "spine",
    "leftShoulder",
    "rightShoulder",
    "leftElbow",
    "rightElbow",
    "leftHip",
    "rightHip",
    "leftKnee",
    "rightKnee",
)
MANNEQUIN_PRESET_IDS = ("stand", "sit", "raise-hand", "walk", "run")


class Vector2Value(BaseModel):
    x: float
    y: float


class Vector3Value(BaseModel):
    x: float
    y: float
    z: float


class CustomProfileData(BaseModel):
    points: list[Vector2Value] = Field(default_factory=list)
    topPoints: Optional[list[Vector2Value]] = None


class CustomMeshData(BaseModel):
    vertices: list[Vector3Value] = Field(default_factory=list)
    edges: list[tuple[int, int]] = Field(default_factory=list)
    faces: list[list[int]] = Field(default_factory=list)


class MeshCutData(BaseModel):
    normal: Vector3Value
    offset: float
    keep: Literal["positive", "negative"]


class StoredModelIssue(BaseModel):
    severity: Literal["info", "warning", "error"]
    message: str


class StoredModelReport(BaseModel):
    meshCount: int = 0
    triangleCount: int = 0
    materialCount: int = 0
    textureCount: int = 0
    cameraCount: int = 0
    lightCount: int = 0
    bounds: Vector3Value
    issues: list[StoredModelIssue] = Field(default_factory=list)


class ImportedModelResource(BaseModel):
    name: str
    dataBase64: str
    mimeType: Optional[str] = None


class ImportedModelAsset(BaseModel):
    format: ImportedModelFormat
    sourceName: str
    primaryData: str
    encoding: Literal["base64", "text"]
    resources: Optional[list[ImportedModelResource]] = None
    report: StoredModelReport


class MannequinData(BaseModel):
    heightMeters: float = Field(ge=1.2, le=2.2)
    pose: dict[str, Vector3Value]
    presetId: Optional[str] = None
    manualJoints: Optional[list[str]] = None


class PathNode(BaseModel):
    """导航线节点。相对路径对象自身位置的局部坐标（单位：米）。

    注意这里**不加范围限制**：路径可以延伸到场景任意远处，
    限制反而会让用户"画不出去"，而且数值本身没有安全风险。
    """

    x: float
    y: float = 0
    z: float


class PathBinding(BaseModel):
    """物体对导航线的绑定。

    - `followRotation`：朝向是否跟随路径前进方向；
    - `offsetSeconds`：在时间轴上相对路径起点的时间偏移（负数 = 提前出发）；
    - `heightOffset`：离地高度。绑定当时记下来，避免物体陷进地面。
    """

    pathId: str
    followRotation: bool = True
    offsetSeconds: float = 0
    heightOffset: float = 0


class SceneObjectData(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    id: str
    kind: PrimitiveKind
    name: str
    description: Optional[str] = None
    position: Vector3Value
    rotation: Vector3Value
    size: Vector3Value
    color: str
    colorOverride: Optional[str] = None
    faceColors: Optional[dict[str, str]] = None
    displayMode: Optional[ObjectDisplayMode] = None
    visible: bool = True
    locked: bool = False
    groupId: Optional[str] = None
    customMesh: Optional[CustomMeshData] = None
    customProfile: Optional[CustomProfileData] = None
    cuts: Optional[list[MeshCutData]] = None
    importedAsset: Optional[ImportedModelAsset] = None
    useImportedLights: Optional[bool] = None
    previewQuality: Optional[ImportedModelQuality] = None
    exportQuality: Optional[ImportedModelQuality] = None
    mannequin: Optional[MannequinData] = None
    # 导航线专用：节点列表（仅 kind == "path" 时有意义）。
    pathNodes: Optional[list[PathNode]] = None
    # 任意物体都可用：绑定到某条导航线上，由路径驱动位置与朝向。
    pathBinding: Optional[PathBinding] = None


class CameraState(BaseModel):
    position: Vector3Value
    target: Vector3Value
    fovDegrees: float
    aspectWidth: float
    aspectHeight: float


class SceneLightData(BaseModel):
    id: str
    name: str
    kind: SceneLightKind
    position: Vector3Value
    target: Vector3Value
    color: str
    intensity: float = Field(ge=0, le=20)
    size: float = Field(gt=0, le=100)
    angleDegrees: float = Field(ge=1, le=180)
    visible: bool = True
    locked: bool = False


class SceneLightingState(BaseModel):
    lights: list[SceneLightData] = Field(default_factory=list)


class CameraShotNode(BaseModel):
    id: str
    name: str
    timeSeconds: float = Field(ge=0, le=3600)
    transition: CameraTransition
    camera: CameraState


class MannequinPresetBlend(BaseModel):
    from_: Optional[str] = Field(default=None, alias="from")
    to: Optional[str] = None
    amount: float

    model_config = ConfigDict(populate_by_name=True)


class ObjectTransformState(BaseModel):
    position: Vector3Value
    rotation: Vector3Value
    size: Vector3Value
    mannequinPose: Optional[dict[str, Vector3Value]] = None
    mannequinPresetId: Optional[str] = None
    mannequinManualJoints: Optional[list[str]] = None
    mannequinPresetBlend: Optional[MannequinPresetBlend] = None


class ObjectKeyframeNode(BaseModel):
    id: str
    objectId: str
    timeSeconds: float
    interpolation: ObjectInterpolation
    transform: ObjectTransformState


class TimelineState(BaseModel):
    durationSeconds: float = 5
    cameraShots: list[CameraShotNode] = Field(default_factory=list)
    objectKeyframes: list[ObjectKeyframeNode] = Field(default_factory=list)


class SceneState(BaseModel):
    objects: list[SceneObjectData] = Field(default_factory=list)
    camera: CameraState
    lighting: SceneLightingState = Field(default_factory=SceneLightingState)
    timeline: TimelineState = Field(default_factory=TimelineState)


class ProjectDocument(BaseModel):
    schemaVersion: int
    appVersion: str
    savedAt: str
    name: str
    scene: SceneState


DEFAULT_CAMERA = CameraState(
    position=Vector3Value(x=7.5, y=5.5, z=8.5),
    target=Vector3Value(x=0, y=1, z=0),
    fovDegrees=42,
    aspectWidth=16,
    aspectHeight=9,
)

DEFAULT_LIGHTING = SceneLightingState(
    lights=[
        SceneLightData(
            id="light-main",
            name="柔和主光",
            kind="area",
            position=Vector3Value(x=6, y=10, z=5),
            target=Vector3Value(x=0, y=1, z=0),
            color="#fffaf1",
            intensity=2.8,
            size=4,
            angleDegrees=45,
            visible=True,
            locked=False,
        )
    ]
)

DEFAULT_TIMELINE = TimelineState(durationSeconds=5, cameraShots=[], objectKeyframes=[])


def create_project_document(name: str, scene: SceneState, app_version: str, saved_at: str) -> ProjectDocument:
    """按当前 schema 生成一份工程文档。"""
    return ProjectDocument(
        schemaVersion=PROJECT_SCHEMA_VERSION,
        appVersion=app_version,
        savedAt=saved_at,
        name=(name or "").strip() or "未命名场景",
        scene=scene,
    )


def is_valid_hex_color(value: Any) -> bool:
    if not isinstance(value, str) or len(value) != 7 or not value.startswith("#"):
        return False
    return all(character in "0123456789abcdefABCDEF" for character in value[1:])


def migrate_document(raw: dict[str, Any], app_version: str, saved_at: str) -> dict[str, Any]:
    """把任意历史版本工程迁移到当前 schema。

    与 TypeScript 侧 `parseProjectDocument` 的策略一致：
    缺少或非法字段时回退到默认值，而不是直接拒绝，避免用户工程打不开。
    """
    scene_raw = raw.get("scene") or {}
    camera_raw = scene_raw.get("camera")
    lighting_raw = scene_raw.get("lighting")
    timeline_raw = scene_raw.get("timeline")
    objects_raw = scene_raw.get("objects")

    try:
        camera = CameraState.model_validate(camera_raw) if camera_raw else DEFAULT_CAMERA.model_copy(deep=True)
    except Exception:
        camera = DEFAULT_CAMERA.model_copy(deep=True)

    try:
        lighting = (
            SceneLightingState.model_validate(lighting_raw)
            if lighting_raw
            else DEFAULT_LIGHTING.model_copy(deep=True)
        )
        if not lighting.lights:
            lighting = DEFAULT_LIGHTING.model_copy(deep=True)
    except Exception:
        lighting = DEFAULT_LIGHTING.model_copy(deep=True)

    try:
        timeline = (
            TimelineState.model_validate(timeline_raw)
            if timeline_raw
            else DEFAULT_TIMELINE.model_copy(deep=True)
        )
    except Exception:
        timeline = DEFAULT_TIMELINE.model_copy(deep=True)

    objects: list[SceneObjectData] = []
    if isinstance(objects_raw, list):
        for entry in objects_raw:
            try:
                objects.append(SceneObjectData.model_validate(entry))
            except Exception:
                # 单个物体损坏不应导致整份工程打不开。
                continue

    return create_project_document(
        name=str(raw.get("name") or ""),
        scene=SceneState(objects=objects, camera=camera, lighting=lighting, timeline=timeline),
        app_version=app_version,
        saved_at=saved_at,
    ).model_dump(by_alias=True)


ExportTarget = Union[str, None]
