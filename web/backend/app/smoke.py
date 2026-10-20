"""端到端冒烟验证。

用途：在真实启动的 uvicorn 上跑一遍关键链路，
覆盖"保存 -> 列出 -> 打开 -> 描述 -> 恢复 -> 删除"。
与 `tests/test_core.py` 的区别：那里用 TestClient 打进进程内，
这里走真实 HTTP，能顺带验证静态资源托管与 SPA 回落。

运行：
    py -3.10 -m app.smoke http://127.0.0.1:8011
"""

from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request


def call(base: str, path: str, method: str = "GET", payload: dict | None = None) -> dict:
    data = None
    headers = {}
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        headers["Content-Type"] = "application/json"
    # projectId 可能包含中文（工程名直接作为文件名），必须按段编码，
    # 否则 http.client 会用 ascii 编码请求行并抛 UnicodeEncodeError。
    safe_path = "/".join(
        urllib.parse.quote(segment, safe="") if index > 0 else segment
        for index, segment in enumerate(path.split("/"))
    )
    request = urllib.request.Request(
        f"{base}{safe_path}", data=data, headers=headers, method=method
    )
    with urllib.request.urlopen(request, timeout=20) as response:
        body = response.read().decode("utf-8")
        return json.loads(body) if body else {}


def main() -> int:
    base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
    checks: list[tuple[str, bool, str]] = []

    def check(label: str, condition: bool, detail: str = "") -> None:
        checks.append((label, condition, detail))

    health = call(base, "/api/health")
    check("health 可用", health.get("status") == "ok", str(health))

    meta = call(base, "/api/meta")
    check("appName 中文未损坏", meta.get("appName") == "小白盒", repr(meta.get("appName")))
    check("schema 版本为 13", meta.get("projectSchemaVersion") == 13)

    profiles = call(base, "/api/platform-profiles")
    check("平台预设 5 条", len(profiles.get("profiles", [])) == 5)

    document = {
        "schemaVersion": 13,
        "appVersion": "0.22.0",
        "savedAt": "2026-10-19T00:00:00Z",
        "name": "冒烟场景",
        "scene": {
            "objects": [
                {
                    "id": "smoke-box",
                    "kind": "box",
                    "name": "方块 01",
                    "description": "一张低矮的白色长桌",
                    "position": {"x": 0, "y": 1.1, "z": 0},
                    "rotation": {"x": 0, "y": 0, "z": 0},
                    "size": {"x": 2.2, "y": 2.2, "z": 2.2},
                    "color": "#c9cdd0",
                    "visible": True,
                    "locked": False,
                }
            ],
            "camera": {
                "position": {"x": 7.5, "y": 5.5, "z": 8.5},
                "target": {"x": 0, "y": 1, "z": 0},
                "fovDegrees": 42,
                "aspectWidth": 16,
                "aspectHeight": 9,
            },
            "lighting": {
                "lights": [
                    {
                        "id": "light-main",
                        "name": "柔和主光",
                        "kind": "area",
                        "position": {"x": 6, "y": 10, "z": 5},
                        "target": {"x": 0, "y": 1, "z": 0},
                        "color": "#fffaf1",
                        "intensity": 2.8,
                        "size": 4,
                        "angleDegrees": 45,
                        "visible": True,
                        "locked": False,
                    }
                ]
            },
            "timeline": {"durationSeconds": 5, "cameraShots": [], "objectKeyframes": []},
        },
    }

    saved = call(base, "/api/projects", "POST", {"document": document, "projectId": None})
    project_id = saved.get("projectId")
    check("保存返回 projectId", bool(project_id), str(saved))

    listed = call(base, "/api/projects")
    check(
        "工程出现在列表里",
        any(item.get("projectId") == project_id for item in listed.get("projects", [])),
    )

    opened = call(base, f"/api/projects/{project_id}")
    check("打开后物体数量一致", len(opened.get("document", {}).get("scene", {}).get("objects", [])) == 1)

    descriptor = call(base, "/api/scene-descriptor", "POST", {"projectName": "冒烟场景", "scene": document["scene"]})
    check("场景说明 schemaVersion 为 2", descriptor.get("schemaVersion") == 2)
    check("场景说明含光照段", "lighting" in descriptor)

    prompt = call(base, "/api/suggested-prompt", "POST", {"projectName": "冒烟场景", "scene": document["scene"]})
    prompt_text = prompt.get("prompt", "")
    check("建议提示词带出物体描述", "白色长桌" in prompt_text)
    check("建议提示词包含光照段落", "光照：" in prompt_text)
    check("建议提示词锁定光照与阴影走向", "保持上述光照方向" in prompt_text)
    check("建议提示词禁止新增光源", "不要自行添加新的光源" in prompt_text)

    empty_prompt = call(
        base,
        "/api/suggested-prompt",
        "POST",
        {
            "projectName": "空场景",
            "scene": {
                **document["scene"],
                "objects": [
                    {**document["scene"]["objects"][0], "description": ""},
                ],
            },
        },
    )
    check("未填描述时给出引导文案", "物体描述" in empty_prompt.get("prompt", ""))

    call(base, "/api/recovery", "POST", {"document": document, "projectId": project_id})
    recovery = call(base, "/api/recovery")
    check("恢复快照可读回", recovery.get("status") == "found")

    recent = call(base, "/api/recent")
    check(
        "最近工程已记录",
        any(item.get("projectId") == project_id for item in recent.get("entries", [])),
    )

    validation = call(
        base,
        "/api/platform-profiles/validate",
        "POST",
        {
            "profileId": "generic-16x9",
            "width": 1280,
            "height": 720,
            "frameRate": 24,
            "durationSeconds": 5,
            "bitrate": 8000000,
        },
    )
    check("平台校验无错误", validation.get("errors") == [], str(validation.get("errors")))

    settings = call(base, "/api/ai/settings")
    check("AI 设置不回传密钥明文", "apiKey" not in json.dumps(settings.get("settings", {})))

    text_export = call(
        base, "/api/exports/text", "POST", {"fileName": "冒烟说明.md", "content": "# 冒烟\n"}
    )
    check("文本导出成功", text_export.get("byteLength", 0) > 0, str(text_export))

    call(base, "/api/recovery", "DELETE")
    check("恢复快照可清除", call(base, "/api/recovery").get("status") == "empty")

    call(base, f"/api/projects/{project_id}", "DELETE")
    check(
        "工程可删除",
        not any(
            item.get("projectId") == project_id
            for item in call(base, "/api/projects").get("projects", [])
        ),
    )

    failed = [item for item in checks if not item[1]]
    for label, ok, detail in checks:
        print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"   -> {detail}" if not ok and detail else ""))
    print(f"\n{len(checks) - len(failed)}/{len(checks)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
