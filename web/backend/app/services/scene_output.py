"""场景说明与建议提示词的生成。

对应原 Electron 版 `src/renderer/src/scene-core/scene-descriptor.ts`
与 `scene-summary.ts`。放在后端是为了让导出能力脱离浏览器：
即使前端页面关闭，也能通过 API 生成说明文件。

注意：光照描述与前端 `core/lighting-description.js` 必须保持一致，
否则会出现"前端画面有阴影、导出的说明却没写"的错位。
"""

from __future__ import annotations

import math
from typing import Any, Optional

KIND_LABELS = {
    "box": "方块",
    "cylinder": "圆柱",
    "sphere": "球体",
    "wall": "墙体",
    "floor": "地面",
    "custom": "自定义形状",
    "imported": "导入模型",
    "mannequin": "人台",
}

LIGHT_KIND_LABELS = {
    "point": "点光源",
    "spot": "聚光灯",
    "area": "面光",
    "sun": "日光",
}

MAX_SHADOW_CASTING_LIGHTS = 2

FIXED_HEMISPHERE_LIGHT = {"skyColor": "#ffffff", "groundColor": "#a9b0b1", "intensity": 1.15}
FIXED_FILL_LIGHT = {
    "color": "#e5f4f1",
    "intensity": 0.42,
    "position": {"x": -5, "y": 4, "z": -3},
    "target": {"x": 0, "y": 0, "z": 0},
}


def _round(value: float, digits: int = 2) -> float:
    factor = 10**digits
    return round(value * factor) / factor


def _round_vector(value: dict[str, float]) -> dict[str, float]:
    return {axis: _round(value.get(axis, 0)) for axis in ("x", "y", "z")}


def resolve_shadow_caster_ids(lights: list[dict[str, Any]]) -> set[str]:
    """选出真正投射阴影的灯光 id。

    与前端 `resolveShadowCasterIds` 完全一致：只统计可见且支持阴影的灯光，
    按场景顺序取前 N 盏；面光在 three.js 中不支持阴影，因此不占名额。
    """
    ids: set[str] = set()
    for light in lights:
        if len(ids) >= MAX_SHADOW_CASTING_LIGHTS:
            break
        if not light.get("visible", True):
            continue
        if light.get("kind") == "area":
            continue
        ids.add(str(light.get("id")))
    return ids


def light_side_text(position: dict[str, float], target: dict[str, float]) -> str:
    """光源相对被照物体的水平方位，输出八方向。"""
    delta_x = position.get("x", 0) - target.get("x", 0)
    delta_z = position.get("z", 0) - target.get("z", 0)
    horizontal = math.hypot(delta_x, delta_z)
    if horizontal < 0.05:
        return "正上方"
    unit_x = delta_x / horizontal
    unit_z = delta_z / horizontal
    threshold = 0.383  # sin(22.5°)
    right = "右" if unit_x > threshold else "左" if unit_x < -threshold else ""
    front = "前" if unit_z > threshold else "后" if unit_z < -threshold else ""
    return f"{right}{front}方"


def light_height_text(position: dict[str, float], target: dict[str, float]) -> str:
    """光源相对被照物体的高度，按俯仰角判定。"""
    horizontal = math.hypot(
        position.get("x", 0) - target.get("x", 0), position.get("z", 0) - target.get("z", 0)
    )
    elevation = math.degrees(
        math.atan2(position.get("y", 0) - target.get("y", 0), max(horizontal, 0.001))
    )
    if elevation >= 65:
        return "接近正上方（顶光）"
    if elevation >= 35:
        return "较高（高位光）"
    if elevation >= 10:
        return "略高（中位光）"
    if elevation > -10:
        return "与物体同高（平光）"
    return "低于物体（底光）"


def _parse_hex(color: str) -> Optional[tuple[int, int, int]]:
    value = (color or "").strip()
    if len(value) != 7 or not value.startswith("#"):
        return None
    try:
        number = int(value[1:], 16)
    except ValueError:
        return None
    return (number >> 16) & 255, (number >> 8) & 255, number & 255


def light_color_text(color: str) -> str:
    """把十六进制颜色翻译成可读色调。

    先用色度占比判断中性白/淡色/浓色，再用色相区分冷暖。
    直接算 HSL 饱和度会把 #fff1d6 这类高明度暖白误判成高饱和橙色。
    """
    rgb = _parse_hex(color)
    if rgb is None:
        return "未知色调"
    red, green, blue = (channel / 255 for channel in rgb)
    maximum = max(red, green, blue)
    minimum = min(red, green, blue)
    delta = maximum - minimum
    if maximum == 0:
        return "中性白光"
    chroma = delta / maximum
    if chroma < 0.06:
        return "中性白光"
    hue = 0.0
    if delta > 0:
        if maximum == red:
            hue = 60 * (((green - blue) / delta) % 6)
        elif maximum == green:
            hue = 60 * ((blue - red) / delta + 2)
        else:
            hue = 60 * ((red - green) / delta + 4)
    if hue < 0:
        hue += 360
    warm = hue < 90 or hue >= 300
    cool = 90 <= hue < 270
    if chroma < 0.3:
        return "暖白光" if warm else "冷白光" if cool else "淡色光"
    if hue < 20 or hue >= 330:
        return "偏红色光"
    if hue < 45:
        return "暖橙色光"
    if hue < 70:
        return "暖黄色光"
    if hue < 160:
        return "偏绿色光"
    if hue < 200:
        return "冷青色光"
    if hue < 270:
        return "偏蓝色光"
    return "偏紫色光"


def light_intensity_text(intensity: float) -> str:
    if intensity <= 0.05:
        return "几乎关闭"
    if intensity < 1:
        return "较弱"
    if intensity < 3:
        return "适中"
    if intensity < 6:
        return "较强"
    return "很强"


def describe_light(light: dict[str, Any], cast_shadow: bool) -> dict[str, Any]:
    position = light.get("position", {})
    target = light.get("target", {})
    side = light_side_text(position, target)
    height = light_height_text(position, target)
    color_text = light_color_text(str(light.get("color", "")))
    intensity = float(light.get("intensity", 0))
    intensity_text = light_intensity_text(intensity)
    shadow_text = "，投射可见阴影" if cast_shadow else ""
    hidden_text = "" if light.get("visible", True) else "（当前已隐藏，不参与照明）"
    kind_label = LIGHT_KIND_LABELS.get(str(light.get("kind")), "灯光")
    summary = (
        f"{kind_label}「{light.get('name')}」：位于物体{side}、{height}，{color_text}，"
        f"强度 {_round(intensity)}（{intensity_text}）{shadow_text}{hidden_text}。"
    )
    return {
        "id": light.get("id"),
        "name": light.get("name"),
        "kind": light.get("kind"),
        "kindLabel": kind_label,
        "color": light.get("color"),
        "colorText": color_text,
        "intensity": _round(intensity),
        "intensityText": intensity_text,
        "position": _round_vector(position),
        "target": _round_vector(target),
        "visible": bool(light.get("visible", True)),
        "castShadow": cast_shadow,
        "sideText": side,
        "heightText": height,
        "summary": summary,
    }


def describe_lighting(lights: list[dict[str, Any]]) -> dict[str, Any]:
    shadow_ids = resolve_shadow_caster_ids(lights)
    described = [describe_light(light, str(light.get("id")) in shadow_ids) for light in lights]
    visible = [entry for entry in described if entry["visible"]]
    shadow_names = [entry["name"] for entry in described if entry["castShadow"]]

    fill_side = light_side_text(FIXED_FILL_LIGHT["position"], FIXED_FILL_LIGHT["target"])
    fill_height = light_height_text(FIXED_FILL_LIGHT["position"], FIXED_FILL_LIGHT["target"])
    ambient_text = (
        f"固定环境光：半球光（天空 {FIXED_HEMISPHERE_LIGHT['skyColor']} / "
        f"地面 {FIXED_HEMISPHERE_LIGHT['groundColor']}，强度 {FIXED_HEMISPHERE_LIGHT['intensity']}）"
        f"与方向补光（{FIXED_FILL_LIGHT['color']}，强度 {FIXED_FILL_LIGHT['intensity']}，"
        f"来自物体{fill_side}、{fill_height}），为整个场景提供基础照明，不会产生阴影。"
    )

    prompt_lines = ["光照："]
    prompt_lines.extend(f"- {entry['summary']}" for entry in described)
    prompt_lines.append(f"- {ambient_text}")
    if shadow_names:
        prompt_lines.append(
            f"- 阴影：仅 {'、'.join(shadow_names)} 投射阴影；阴影方向应与该光源位置一致。"
        )
    else:
        prompt_lines.append("- 阴影：当前没有灯光投射阴影，画面以均匀照明为主。")

    visible_shadow = len([entry for entry in described if entry["castShadow"]])
    if visible:
        summary_line = (
            f"光照：共 {len(lights)} 盏可编辑灯光（可见 {len(visible)} 盏，"
            f"其中 {visible_shadow} 盏投射阴影），另有固定半球环境光与方向补光。"
            f"主光为{visible[0]['summary']}"
        )
    else:
        summary_line = "光照：没有可编辑灯光，仅使用固定半球环境光与方向补光。"

    return {
        "lights": described,
        "visibleCount": len(visible),
        "shadowCasterNames": shadow_names,
        "promptLines": prompt_lines,
        "summaryLine": summary_line,
        "ambientText": ambient_text,
    }


def _aspect_ratio_label(width: float, height: float) -> str:
    ratio = width / height if height else 1
    for label, candidate in (
        ("16:9", 16 / 9),
        ("9:16", 9 / 16),
        ("1:1", 1),
        ("4:3", 4 / 3),
        ("3:4", 3 / 4),
    ):
        if abs(candidate - ratio) <= 0.015:
            return label
    return f"{_round(width)}:{_round(height)}"


def _camera_direction_text(camera: dict[str, Any]) -> str:
    position = camera.get("position", {})
    target = camera.get("target", {})
    delta_x = target.get("x", 0) - position.get("x", 0)
    delta_z = target.get("z", 0) - position.get("z", 0)
    if math.hypot(delta_x, delta_z) < 0.001:
        return "镜头近乎垂直向下俯视"
    degrees = math.degrees(math.atan2(delta_x, delta_z))
    return f"镜头朝向约 {_round(degrees)} 度（水平方向，0 度为 +Z，顺时针为正）"


def _has_description(obj: dict[str, Any]) -> bool:
    return bool(str(obj.get("description") or "").strip())


def assign_object_indices(objects: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """给"有描述且可见"的物体分配从 1 开始的索引，与画面叠加编号一致。"""
    entries: list[dict[str, Any]] = []
    for obj in objects:
        if not obj.get("visible", True) or not _has_description(obj):
            continue
        entries.append({"index": len(entries) + 1, "objectId": obj.get("id")})
    return entries


def build_scene_descriptor(project_name: str, scene: dict[str, Any]) -> dict[str, Any]:
    """生成完整场景说明。

    先构造不含提示词的主体，再补上提示词：`build_suggested_prompt` 需要
    读取主体里的物体与相机信息，若直接互相调用会无限递归。
    """
    descriptor = _build_descriptor_body(project_name, scene)
    descriptor["suggestedPrompt"] = build_suggested_prompt(project_name, scene)
    return descriptor


def _build_descriptor_body(project_name: str, scene: dict[str, Any]) -> dict[str, Any]:
    objects_raw = scene.get("objects") or []
    by_id = {obj.get("id"): obj for obj in objects_raw}
    entries = []
    for entry in assign_object_indices(objects_raw):
        obj = by_id.get(entry["objectId"])
        if not obj:
            continue
        preset = (obj.get("mannequin") or {}).get("presetId")
        entries.append(
            {
                "index": entry["index"],
                "id": obj.get("id"),
                "name": obj.get("name"),
                "kind": obj.get("kind"),
                "kindLabel": KIND_LABELS.get(str(obj.get("kind")), str(obj.get("kind"))),
                "description": str(obj.get("description") or "").strip(),
                "position": _round_vector(obj.get("position", {})),
                "rotation": _round_vector(obj.get("rotation", {})),
                "size": _round_vector(obj.get("size", {})),
                "color": obj.get("color"),
                "mannequinPreset": preset,
            }
        )

    camera = scene.get("camera") or {}
    timeline = scene.get("timeline") or {}
    lighting = describe_lighting((scene.get("lighting") or {}).get("lights") or [])

    return {
        "schemaVersion": 2,
        "projectName": project_name,
        "units": "meters",
        "indexMeaning": "objects[].index 对应画面上叠加的数字编号，1 表示第一个带描述的可见物体。",
        "camera": {
            **camera,
            "aspectRatio": _aspect_ratio_label(
                float(camera.get("aspectWidth") or 16), float(camera.get("aspectHeight") or 9)
            ),
        },
        "lighting": {
            "lights": lighting["lights"],
            "visibleCount": lighting["visibleCount"],
            "shadowCasterNames": lighting["shadowCasterNames"],
            "fixed": [
                {
                    "kind": "hemisphere",
                    "description": (
                        f"半球环境光：天空 {FIXED_HEMISPHERE_LIGHT['skyColor']}，"
                        f"地面反射 {FIXED_HEMISPHERE_LIGHT['groundColor']}"
                    ),
                    "producesShadow": False,
                    "color": FIXED_HEMISPHERE_LIGHT["skyColor"],
                    "intensity": FIXED_HEMISPHERE_LIGHT["intensity"],
                },
                {
                    "kind": "directional-fill",
                    "description": "方向补光，从物体左后方补充轮廓亮度",
                    "producesShadow": False,
                    "color": FIXED_FILL_LIGHT["color"],
                    "intensity": FIXED_FILL_LIGHT["intensity"],
                    "position": dict(FIXED_FILL_LIGHT["position"]),
                },
            ],
            "summary": lighting["summaryLine"],
        },
        "timeline": {
            "durationSeconds": _round(float(timeline.get("durationSeconds") or 0)),
            "cameraShotCount": len(timeline.get("cameraShots") or []),
            "objectKeyframeCount": len(timeline.get("objectKeyframes") or []),
        },
        "objects": entries,
    }


def build_suggested_prompt(project_name: str, scene: dict[str, Any]) -> str:
    """生成可直接复制到生成式平台使用的提示词，含光照段落。"""
    descriptor = _build_descriptor_body(project_name, scene)
    entries = descriptor["objects"]
    if not entries:
        return "当前场景还没有填写任何物体描述。请先在物体属性中填写“物体描述”，再生成提示词。"

    lines = ["画面中的物体："]
    for entry in entries:
        details = [entry["description"]]
        if entry["kind"] == "mannequin" and entry["mannequinPreset"]:
            details.append(f"人物动作：{entry['mannequinPreset']}")
        position = entry["position"]
        lines.append(
            f"{entry['index']}. {'；'.join(details)}"
            f"（位置 x={position['x']}, y={position['y']}, z={position['z']}）"
        )

    camera = descriptor["camera"]
    position = camera.get("position", {})
    lines.append("")
    lines.append(
        f"摄影机位置（{_round(position.get('x', 0))}, {_round(position.get('y', 0))}, "
        f"{_round(position.get('z', 0))}），视场角 {_round(camera.get('fovDegrees', 0))} 度，"
        f"画幅 {camera['aspectRatio']}。"
    )
    lines.append(_camera_direction_text(camera))
    if descriptor["timeline"]["durationSeconds"] > 0:
        lines.append(f"镜头时长约 {descriptor['timeline']['durationSeconds']} 秒。")

    lines.append("")
    lines.extend(describe_lighting((scene.get("lighting") or {}).get("lights") or [])["promptLines"])

    lines.append("")
    lines.append("要求：")
    lines.append("- 保持所有物体的材质、颜色和形状在整个镜头中前后一致。")
    lines.append("- 让物体的运动与参考视频保持一致，不要改变运动轨迹和节奏。")
    lines.append("- 保持上述光照方向、色调与阴影走向在整个镜头中稳定，不要自行添加新的光源。")
    lines.append("- 不要出现任何数字编号、文字标记或参考用的辅助图形。")
    return "\n".join(lines)


def summarize_scene(scene: dict[str, Any]) -> str:
    """把场景压成一段中文摘要，随用户消息发给 AI。"""
    objects = scene.get("objects") or []
    camera = scene.get("camera") or {}
    lighting = describe_lighting((scene.get("lighting") or {}).get("lights") or [])
    visible_count = len([obj for obj in objects if obj.get("visible", True)])

    lines = [
        f"物体共 {len(objects)} 个（可见 {visible_count} 个），"
        f"相机视场角 {_round(camera.get('fovDegrees', 0))} 度，"
        f"画幅 {camera.get('aspectWidth')}:{camera.get('aspectHeight')}。"
    ]
    position = camera.get("position", {})
    target = camera.get("target", {})
    lines.append(
        f"相机位置({position.get('x', 0)}, {position.get('y', 0)}, {position.get('z', 0)})，"
        f"看向({target.get('x', 0)}, {target.get('y', 0)}, {target.get('z', 0)})。"
    )
    lines.append(lighting["summaryLine"])
    if not objects:
        lines.append("当前场景没有任何物体。")
    else:
        for obj in objects[:40]:
            lines.append(
                f"- {KIND_LABELS.get(str(obj.get('kind')), obj.get('kind'))}「{obj.get('name')}」"
                f"id={obj.get('id')}"
            )
        if len(objects) > 40:
            lines.append(f"- 其余 {len(objects) - 40} 个物体未一一列出。")
    return "\n".join(lines)
