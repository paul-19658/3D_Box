"""平台导出规则。

对应原 Electron 版 `src/shared/platform-profiles.json` 与 `platform-profiles.ts`。
规则独立于代码，便于随各 AI 平台变化持续更新。

重要：`verification` 字段表达规则可信度，`checkedAt` 记录核对日期。
导出前必须把核对日期显示给用户，不能宣称"一种格式适配所有平台"。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal, Optional

ProfileVerification = Literal["generic", "partial", "official-format", "official"]

PROFILES_PATH = Path(__file__).resolve().parent.parent / "data" / "platform-profiles.json"

VERIFICATION_LABELS = {
    "generic": "通用建议",
    "partial": "部分核实",
    "official-format": "官方格式说明",
    "official": "官方规则",
}


@dataclass
class VideoPlatformProfile:
    id: str
    name: str
    description: str
    verification: ProfileVerification
    frameRate: int
    maxDimension: int
    bitrate: int
    minDurationSeconds: float
    maxDurationSeconds: float
    maxFileSizeMb: float
    aspectRatios: list[str]
    sourceUrl: str


@dataclass
class PlatformProfileRules:
    schemaVersion: int
    rulesVersion: str
    checkedAt: str
    profiles: list[VideoPlatformProfile]


def load_rules(path: Path = PROFILES_PATH) -> PlatformProfileRules:
    raw = json.loads(path.read_text(encoding="utf-8"))
    profiles = [
        VideoPlatformProfile(
            id=str(entry["id"]),
            name=str(entry["name"]),
            description=str(entry["description"]),
            verification=entry["verification"],
            frameRate=int(entry["frameRate"]),
            maxDimension=int(entry["maxDimension"]),
            bitrate=int(entry["bitrate"]),
            minDurationSeconds=float(entry["minDurationSeconds"]),
            maxDurationSeconds=float(entry["maxDurationSeconds"]),
            maxFileSizeMb=float(entry["maxFileSizeMb"]),
            aspectRatios=[str(value) for value in entry["aspectRatios"]],
            sourceUrl=str(entry["sourceUrl"]),
        )
        for entry in raw["profiles"]
    ]
    return PlatformProfileRules(
        schemaVersion=int(raw["schemaVersion"]),
        rulesVersion=str(raw["rulesVersion"]),
        checkedAt=str(raw["checkedAt"]),
        profiles=profiles,
    )


def validate_video_profile(
    profile: VideoPlatformProfile,
    *,
    width: int,
    height: int,
    frame_rate: int,
    duration_seconds: float,
    bitrate: int,
    checked_at: Optional[str] = None,
) -> dict[str, Any]:
    """校验一次视频导出是否符合平台规则。

    返回 errors（必须修正）与 warnings（建议确认）以及预计文件大小。
    刻意不自动修改用户参数——导出流程不静默改动用户内容。
    """
    errors: list[str] = []
    warnings: list[str] = []

    if width > profile.maxDimension or height > profile.maxDimension:
        errors.append(
            f"画面尺寸 {width}×{height} 超过 {profile.name} 建议的最大边长 {profile.maxDimension}。"
        )
    if frame_rate != profile.frameRate:
        errors.append(f"{profile.name} 使用 {profile.frameRate} 帧，当前是 {frame_rate} 帧。")
    if duration_seconds < profile.minDurationSeconds:
        errors.append(f"{profile.name} 最短需要 {profile.minDurationSeconds} 秒。")
    if duration_seconds > profile.maxDurationSeconds:
        errors.append(f"{profile.name} 最长支持 {profile.maxDurationSeconds} 秒。")

    aspect = f"{round(width / height, 4)}"
    allowed = {ratio: ratio for ratio in profile.aspectRatios}
    if aspect not in allowed:
        matched = any(
            abs(width / height - _ratio_value(ratio)) <= 0.015 for ratio in profile.aspectRatios
        )
        if not matched:
            warnings.append(
                f"画幅 {aspect} 不在 {profile.name} 已记录的 {', '.join(profile.aspectRatios)} 中，请上传前确认。"
            )

    estimated_mb = bitrate * duration_seconds / 8 / 1024 / 1024
    if estimated_mb > profile.maxFileSizeMb:
        errors.append(
            f"预计文件约 {estimated_mb:.1f} MB，超过 {profile.name} 的 {profile.maxFileSizeMb} MB 上限。"
        )
    elif estimated_mb > profile.maxFileSizeMb * 0.85:
        warnings.append(f"预计文件约 {estimated_mb:.1f} MB，接近 {profile.name} 的大小上限。")

    if checked_at:
        warnings.append(
            f"{profile.name} 规则核对于 {checked_at}，上传前请以平台当日说明为准。"
        )
    return {
        "errors": errors,
        "warnings": warnings,
        "estimatedFileSizeMb": round(estimated_mb, 2),
        "verificationLabel": VERIFICATION_LABELS.get(profile.verification, profile.verification),
    }


def _ratio_value(ratio: str) -> float:
    try:
        left, right = ratio.split(":")
        return float(left) / float(right)
    except Exception:
        return 0.0
