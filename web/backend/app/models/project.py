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

from pydantic import BaseModel, ConfigDict, Field, field_validator

# schema 19：场景新增 `poseLibrary`（姿势库：命名保存的完整人台关节表）。
# schema 18：导入模型新增 `importedAsset.files`（文件引用，重新打开工程时按引用恢复几何体）。
# schema 17：修正人台比例（`size` 三分量统一为身高；骨架包围盒基准归一）。
# schema 16：场景新增 `background`（全景图背景）。
# schema 15：相机新增 `lookAtEnabled`（看向绑定是否启用）。
# schema 14：相机新增可空的 `targetObjectId`（绑定并跟随某个物体）。
# schema 13：新增 `kind: "path"` 的导航线对象（带 pathNodes）。
# 与前端 `PROJECT_SCHEMA_VERSION` 必须始终一致，冒烟脚本会断言这个数字。
PROJECT_SCHEMA_VERSION = 19
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


class ImportedAssetFile(BaseModel):
    """导入模型的单个文件引用（schema 18）。

    - `name`：模型**内部引用的原始名**（`.gltf` 的 `buffer.uri` / 纹理 `uri`、
      `.obj` 的 `mtllib` 行）。重新解析时按这个名字交回依赖。
    - `fileName`：上传到 `exports` 目录后的文件名。服务端会去重重命名
      （同名加 `-1` / `-2`），所以两者可能不同——取文件必须以 `fileName` 为准。

    刻意不加 `min_length` 之类的强校验：单个坏引用只该让"这个文件用不了"，
    不该让整份工程打不开（`migrate_document` 里物体校验失败是整条跳过）。
    """

    name: str
    fileName: str


class ImportedAssetFiles(BaseModel):
    """导入模型的主文件 + 全部依赖资源（schema 18）。

    只存引用不存内容：模型动辄几十 MB，塞进工程 JSON 会让每次保存都重传一遍，
    撤销栈里也各留一份。文件本身走 `POST /api/exports/upload` 落到用户目录，
    取回地址是 `/api/exports/<fileName>`。
    """

    main: ImportedAssetFile
    resources: list[ImportedAssetFile] = Field(default_factory=list)


class ImportedModelAsset(BaseModel):
    """导入模型在工程里的记录。

    `primaryData` / `encoding` / `resources` 是 Electron 版"把模型内嵌进工程"
    时的老字段（schema 17 及更早）。Web 版只存文件引用（`files`），
    所以这些字段必须允许缺省——它们曾经是必填，导致 Web 版保存的工程
    **重新打开时整条物体被校验拒绝、模型直接消失**。
    """

    format: ImportedModelFormat
    sourceName: str
    primaryData: Optional[str] = None
    encoding: Optional[Literal["base64", "text"]] = None
    resources: Optional[list[ImportedModelResource]] = None
    # schema 18：Web 版的持久化方式——只记文件名，几何体靠重新下载再解析恢复。
    files: Optional[ImportedAssetFiles] = None
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


def _axis_value(value: Any, axis: str) -> float:
    """从（可能已经转成 Vector3Value 的）关节值里取一个轴的浮点数。

    取不到或不是数字时返回 0——与前端"缺关节按中立角度"的约定一致。
    """
    raw = value.get(axis) if isinstance(value, dict) else getattr(value, axis, None)
    try:
        return float(raw)
    except (TypeError, ValueError):
        return 0.0


class PoseLibraryEntry(BaseModel):
    """姿势库里的一条自定义姿势（schema 19）。

    - `pose`：**完整**关节表（10 个关节 × 3 轴）。应用姿势时前端会把
      `presetId` 置 null、全部关节都由这份 pose 驱动，所以缺一个关节就会让
      那个部位掉回中立角度——校验时按 `MANNEQUIN_JOINT_IDS` 补齐而不是拒绝。
    - `createdAt`：ISO 时间字符串，仅用于展示排序，不做格式校验（时间格式的
      强校验只会让手改过的工程整条打不开，收益为零）。
    """

    id: str
    name: str = ""
    pose: dict[str, Vector3Value] = Field(default_factory=dict)
    createdAt: str = ""

    @field_validator("pose")
    @classmethod
    def _fill_missing_joints(cls, value: dict[str, Vector3Value]) -> dict[str, Vector3Value]:
        """补齐缺失关节、丢掉未知关节，数值一律转 float。

        与前端 `normalizePoseRecord()` 行为一致：`pose` 里的未知键（例如以后
        删掉的关节）会让渲染层拿到不认识的名字，留着没有意义。
        """
        source = value or {}
        return {
            joint_id: Vector3Value(
                x=_axis_value(source.get(joint_id), "x"),
                y=_axis_value(source.get(joint_id), "y"),
                z=_axis_value(source.get(joint_id), "z"),
            )
            for joint_id in MANNEQUIN_JOINT_IDS
        }


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
    # schema 14：把"看向点"绑定到场景里的某个物体，相机会锁定并跟随它移动。
    # None 表示看向点就是上面的静态 target 坐标。
    targetObjectId: Optional[str] = None
    # schema 15：看向绑定是否启用。关掉后相机改用静态 target，但绑定关系保留。
    # 缺省 True —— v14 及更早的工程没有这个字段，那时绑定就是"一绑就生效"。
    lookAtEnabled: bool = True

    @field_validator("targetObjectId")
    @classmethod
    def _normalize_target_object_id(cls, value: Optional[str]) -> Optional[str]:
        """空字符串既不是"未绑定"也不是合法 id，统一归一成 None。

        与前端 `normalizeCamera()` 规则保持一致：只允许"已绑定"和"未绑定"
        两种状态，否则两端对同一个工程的判断会分叉。
        """
        if value is None:
            return None
        text = str(value).strip()
        return text or None


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


class BackgroundState(BaseModel):
    """全景图背景（schema 16）。

    只存**文件名引用**，图片本身走 `POST /api/exports/upload` 落到用户目录；
    取图地址是 `/api/exports/<panoramaFileName>`。
    把几 MB 的图塞进工程 JSON 会让每次保存都重传一遍，撤销栈里也各留一份。
    """

    panoramaFileName: str = ""
    panoramaSourceName: str = ""
    rotateDegrees: float = 0
    intensity: float = 1
    affectsLighting: bool = False

    @field_validator("rotateDegrees")
    @classmethod
    def _normalize_rotate(cls, value: float) -> float:
        """归一到 [0, 360)：-720 与 0 是同一个朝向，不该存成两种写法。"""
        return float(value) % 360

    @field_validator("intensity")
    @classmethod
    def _clamp_intensity(cls, value: float) -> float:
        """限制在 0~4：再高只会把背景烧成白块。"""
        if value < 0:
            return 0.0
        if value > 4:
            return 4.0
        return float(value)


class SceneState(BaseModel):
    objects: list[SceneObjectData] = Field(default_factory=list)
    camera: CameraState
    lighting: SceneLightingState = Field(default_factory=SceneLightingState)
    timeline: TimelineState = Field(default_factory=TimelineState)
    background: BackgroundState = Field(default_factory=BackgroundState)
    # schema 19：姿势库（命名保存的完整关节表）。缺省为空，v18 及更早的工程行为不变。
    poseLibrary: list[PoseLibraryEntry] = Field(default_factory=list)


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
    # v13 及更早的工程没有这个字段；显式写 None 让"字段集合"在两端完全一致。
    targetObjectId=None,
    lookAtEnabled=True,
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

    background_raw = scene_raw.get("background")
    try:
        background = (
            BackgroundState.model_validate(background_raw)
            if background_raw
            else BackgroundState()
        )
    except Exception:
        # 背景坏了不该让整份工程打不开：退回"没有背景"。
        background = BackgroundState()

    objects: list[SceneObjectData] = []
    if isinstance(objects_raw, list):
        for entry in objects_raw:
            try:
                objects.append(SceneObjectData.model_validate(entry))
            except Exception:
                # 单个物体损坏不应导致整份工程打不开。
                continue

    # 姿势库（schema 19）：同样"坏条目单独丢掉"。缺 id 的条目没法被应用/删除，
    # 留着只是列表里的死行，所以直接跳过；重复 id 只保留第一条。
    pose_library: list[PoseLibraryEntry] = []
    pose_library_raw = scene_raw.get("poseLibrary")
    if isinstance(pose_library_raw, list):
        seen_ids: set[str] = set()
        for entry in pose_library_raw:
            try:
                parsed = PoseLibraryEntry.model_validate(entry)
            except Exception:
                continue
            if not parsed.id or parsed.id in seen_ids:
                continue
            seen_ids.add(parsed.id)
            pose_library.append(parsed)

    return create_project_document(
        name=str(raw.get("name") or ""),
        scene=SceneState(
            objects=objects,
            camera=camera,
            lighting=lighting,
            timeline=timeline,
            background=background,
            poseLibrary=pose_library,
        ),
        app_version=app_version,
        saved_at=saved_at,
    ).model_dump(by_alias=True)


ExportTarget = Union[str, None]
