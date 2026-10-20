"""AI 接口代理。

对应原 Electron 版 `src/main/ai-service.ts`。浏览器不允许跨域读取第三方
接口的密钥，也不应该把密钥暴露在前端，因此由后端代为请求。

安全约定：
- 密钥只保存在服务端 `workspace/ai-environment.json`，永不下发到前端；
- 前端只能拿到"是否已配置"与错误原因；
- 只有用户主动点击发送时才会发起外部请求。
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import httpx

AI_ENVIRONMENT_FILE_NAME = "ai-environment.json"

AI_DEFAULT_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "openai-compatible": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
    "custom": "",
}

AI_DEFAULT_MODELS = {
    "openai": "gpt-4o-mini",
    "openai-compatible": "gpt-4o-mini",
    "anthropic": "claude-3-5-sonnet-latest",
    "custom": "",
}

AI_SCENE_COMMAND_SCHEMA_HINT = """输出格式（必须遵守）：
1. 先用一两句简体中文说明将要搭建什么。
2. 然后输出一个 JSON 代码块（```json ... ```），内容是命令数组。
3. JSON 必须是严格合法 JSON：数字写 50 不要写 fifty；布尔写 true/false；字符串与键名一律双引号；不要尾随逗号；不要注释。
4. 用户说“生成/搭建/布置…场景”时，第一条命令必须是 {"type":"clear_scene"}。
5. 坐标单位是米，旋转单位是度。人台围坐用 presetId:"sit"，沿圆布置并朝向中心。
6. 避免穿模：人台勿插入地面/墙/桌，物体之间留空隙；坐姿与桌面分开。
7. 跑步/走路/移动：仅 presetId "run"/"walk" 只是原地姿势，必须再用 animate_move 写路径位移；跟拍用 cameraFollow。
8. cameraFollow 可为 true（侧面），或 {"mode":"orbit","orbitDegrees":360,"radius":5}（360 环绕跟随）、{"mode":"chase"}（背后）、{"mode":"front"}（迎面）。
9. 只允许下列命令类型，不要输出其他字段或伪代码。

命令类型：
- {"type":"clear_scene"}
- {"type":"add_object","kind":"box|cylinder|sphere|wall|floor","name?","position?","rotation?","size?","color?","description?"}
- {"type":"add_mannequin","name?","position?","rotation?","heightMeters?","presetId":"stand|sit|raise-hand|walk|run","description?"}
- {"type":"update_object","id?","name?","position?","rotation?","size?","color?","description?"}
- {"type":"set_mannequin_pose","id?","name?","presetId":"stand|sit|raise-hand|walk|run"}
- {"type":"set_camera","position?","target?","fovDegrees?"}
- {"type":"animate_move","name?","id?","path":[{"x":0,"z":0},{"x":8,"z":0}],"durationSeconds":4,"faceAlongPath":true,"cameraFollow":true}
"""

AI_DEFAULT_SYSTEM_PROMPT = """你是“小白盒”可执行场景搭建助手。小白盒用基础体（方块、圆柱、球体、墙体、地面）、人台和摄影机快速表达空间。
用户用自然语言描述画面后，你必须输出可被软件自动执行的 JSON 命令；软件会直接改场景，用户可用撤销回退。
用户也可能附带参考图：请结合文字与图片理解构图、站位与镜头，再输出搭建命令。
软件会在首次搭建后截取摄影机画面再请你复核一次：若合格只回复 ok；若需修正再输出 JSON 命令。

回答要求：
1. 用简体中文先写一两句说明将要搭建什么。
2. 紧接着输出严格合法的 JSON 代码块（数字用阿拉伯数字，如 50 不要 fifty；双引号；无尾随逗号）；不要只给文字步骤却不给 JSON。
3. 用户说“生成/搭建/布置…场景”时，第一条命令必须是 clear_scene，避免叠在旧物体上。
4. 坐标单位是米，旋转单位是度。人台围坐用 presetId "sit"，沿圆布置并朝向中心；可用矮 box 当桌子。
5. 避免穿模：人台不要插进地面/墙/桌；物体之间留空隙；坐姿人台与桌面保持合理间距。
6. 跑步/走路必须用 animate_move 产生位移；仅 run/walk 姿势是原地摆拍。跟拍：cameraFollow:true 或 {"mode":"orbit","orbitDegrees":360} 等。
7. 复核阶段优先检查穿模；合格只回复 ok；需修正则给 JSON，不要再 clear_scene 除非必须重建。
8. 不要闲聊，不要声称已经操作却不给 JSON（复核通过的 ok 除外）。
"""


@dataclass
class AiProviderConfig:
    id: str
    name: str
    kind: str
    baseUrl: str = ""
    apiKey: str = ""
    model: str = ""
    temperature: float = 0.4
    maxTokens: int = 2048

    def resolved_base_url(self) -> str:
        base = (self.baseUrl or "").strip() or AI_DEFAULT_BASE_URLS.get(self.kind, "")
        return base.rstrip("/")

    def resolved_model(self) -> str:
        return (self.model or "").strip() or AI_DEFAULT_MODELS.get(self.kind, "")


@dataclass
class AiSettings:
    version: int = 1
    activeProviderId: Optional[str] = None
    providers: list[AiProviderConfig] = field(default_factory=list)
    systemPrompt: str = AI_DEFAULT_SYSTEM_PROMPT

    def active_provider(self) -> Optional[AiProviderConfig]:
        for provider in self.providers:
            if provider.id == self.activeProviderId:
                return provider
        return self.providers[0] if self.providers else None


def describe_provider_problem(provider: Optional[AiProviderConfig]) -> Optional[str]:
    """返回配置不可用的原因；可用时返回 None。供前端显示提示。"""
    if provider is None:
        return "还没有可用的 AI 接口，请先在设置中添加。"
    if not provider.resolved_base_url():
        return "接口地址为空，请在设置中填写。"
    if provider.kind != "custom" and not provider.apiKey.strip():
        return "还没有填写接口密钥，请在设置中补充。"
    return None


@dataclass
class AiService:
    settings_path: Path

    def load_settings(self) -> AiSettings:
        if not self.settings_path.exists():
            return AiSettings()
        try:
            raw = json.loads(self.settings_path.read_text(encoding="utf-8"))
        except Exception:
            return AiSettings()
        settings_raw = raw.get("settings", raw)
        providers = [
            AiProviderConfig(
                id=str(entry.get("id") or ""),
                name=str(entry.get("name") or ""),
                kind=str(entry.get("kind") or "openai"),
                baseUrl=str(entry.get("baseUrl") or ""),
                apiKey=str(entry.get("apiKey") or ""),
                model=str(entry.get("model") or ""),
                temperature=float(entry.get("temperature") or 0.4),
                maxTokens=int(entry.get("maxTokens") or 2048),
            )
            for entry in settings_raw.get("providers", [])
            if isinstance(entry, dict)
        ]
        return AiSettings(
            version=int(settings_raw.get("version") or 1),
            activeProviderId=settings_raw.get("activeProviderId"),
            providers=providers,
            systemPrompt=str(settings_raw.get("systemPrompt") or AI_DEFAULT_SYSTEM_PROMPT),
        )

    def save_settings(self, settings: AiSettings) -> None:
        self.settings_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schemaVersion": 1,
            "settings": {
                "version": settings.version,
                "activeProviderId": settings.activeProviderId,
                "providers": [provider.__dict__ for provider in settings.providers],
                "systemPrompt": settings.systemPrompt,
            },
        }
        self.settings_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
        )

    def public_settings(self) -> dict[str, Any]:
        """返回给前端的配置。密钥只以 hasApiKey 布尔值呈现。"""
        settings = self.load_settings()
        return {
            "version": settings.version,
            "activeProviderId": settings.activeProviderId,
            "systemPrompt": settings.systemPrompt,
            "providers": [
                {
                    "id": provider.id,
                    "name": provider.name,
                    "kind": provider.kind,
                    "baseUrl": provider.baseUrl,
                    "model": provider.model,
                    "temperature": provider.temperature,
                    "maxTokens": provider.maxTokens,
                    "hasApiKey": bool(provider.apiKey.strip()),
                }
                for provider in settings.providers
            ],
        }

    async def chat(
        self,
        messages: list[dict[str, Any]],
        scene_summary: Optional[str] = None,
        images: Optional[list[dict[str, str]]] = None,
    ) -> dict[str, Any]:
        """转发一次对话请求。返回 {status, content} 或 {status:'error', message}。"""
        settings = self.load_settings()
        provider = settings.active_provider()
        problem = describe_provider_problem(provider)
        if problem or provider is None:
            return {"status": "error", "message": problem or "AI 接口不可用。"}

        system_prompt = settings.systemPrompt or AI_DEFAULT_SYSTEM_PROMPT
        if "animate_move" not in system_prompt:
            system_prompt = f"{system_prompt}\n\n{AI_SCENE_COMMAND_SCHEMA_HINT}"

        if provider.kind == "anthropic":
            url, headers, body = self._build_anthropic(provider, system_prompt, messages, scene_summary, images)
        else:
            url, headers, body = self._build_openai(provider, system_prompt, messages, scene_summary, images)

        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                response = await client.post(url, headers=headers, json=body)
        except httpx.TimeoutException:
            return {"status": "error", "message": "AI 接口响应超时，请稍后重试。"}
        except httpx.HTTPError as error:
            return {"status": "error", "message": f"无法连接 AI 接口：{error}"}

        if response.status_code >= 400:
            detail = response.text[:400]
            return {"status": "error", "message": f"AI 接口返回 {response.status_code}：{detail}"}

        try:
            data = response.json()
        except Exception:
            return {"status": "error", "message": "AI 接口返回了无法解析的内容。"}

        content = self._extract_content(provider.kind, data)
        if not content:
            return {"status": "error", "message": "AI 接口没有返回文本内容。"}
        return {"status": "ok", "content": content}

    @staticmethod
    def _user_text(messages: list[dict[str, Any]], scene_summary: Optional[str]) -> list[dict[str, str]]:
        result = [dict(message) for message in messages]
        if scene_summary and scene_summary.strip():
            result.insert(0, {"role": "system", "content": f"当前场景概况：\n{scene_summary.strip()}"})
        return result

    def _build_openai(
        self,
        provider: AiProviderConfig,
        system_prompt: str,
        messages: list[dict[str, Any]],
        scene_summary: Optional[str],
        images: Optional[list[dict[str, str]]],
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        prepared: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
        prepared.extend(self._user_text(messages, scene_summary))
        if images:
            last = prepared[-1]
            content: list[dict[str, Any]] = [{"type": "text", "text": last.get("content", "")}]
            for image in images:
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{image['mimeType']};base64,{image['base64Data']}"},
                    }
                )
            prepared[-1] = {"role": last.get("role", "user"), "content": content}
        return (
            f"{provider.resolved_base_url()}/chat/completions",
            {
                "Authorization": f"Bearer {provider.apiKey}",
                "Content-Type": "application/json",
            },
            {
                "model": provider.resolved_model(),
                "messages": prepared,
                "temperature": provider.temperature,
                "max_tokens": provider.maxTokens,
            },
        )

    def _build_anthropic(
        self,
        provider: AiProviderConfig,
        system_prompt: str,
        messages: list[dict[str, Any]],
        scene_summary: Optional[str],
        images: Optional[list[dict[str, str]]],
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        prepared: list[dict[str, Any]] = [
            {**message, "role": message.get("role", "user")}
            for message in self._user_text(messages, scene_summary)
            if message.get("role") != "system"
        ]
        if scene_summary and scene_summary.strip():
            system_prompt = f"{system_prompt}\n\n当前场景概况：\n{scene_summary.strip()}"
        if images:
            last = prepared[-1]
            blocks: list[dict[str, Any]] = [{"type": "text", "text": last.get("content", "")}]
            for image in images:
                blocks.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": image["mimeType"],
                            "data": image["base64Data"],
                        },
                    }
                )
            prepared[-1] = {"role": last.get("role", "user"), "content": blocks}
        return (
            f"{provider.resolved_base_url()}/v1/messages",
            {
                "x-api-key": provider.apiKey,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            {
                "model": provider.resolved_model(),
                "system": system_prompt,
                "messages": prepared,
                "temperature": provider.temperature,
                "max_tokens": provider.maxTokens,
            },
        )

    @staticmethod
    def _extract_content(kind: str, data: dict[str, Any]) -> str:
        try:
            if kind == "anthropic":
                blocks = data.get("content") or []
                return "".join(
                    block.get("text", "")
                    for block in blocks
                    if isinstance(block, dict) and block.get("type") == "text"
                ).strip()
            choices = data.get("choices") or []
            if not choices:
                return ""
            message = choices[0].get("message") or {}
            content = message.get("content")
            if isinstance(content, list):
                return "".join(
                    part.get("text", "") for part in content if isinstance(part, dict)
                ).strip()
            return str(content or "").strip()
        except Exception:
            return ""
