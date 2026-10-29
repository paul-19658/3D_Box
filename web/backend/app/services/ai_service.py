"""AI 接口代理（单轮，支持 tool-calling）。

对应原 Electron 版 `src/main/ai-service.ts`，并扩展为 Agent Loop 的 LLM 回合代理：
前端编排多步循环，本模块只负责把 messages + tools 转发给 OpenAI / Anthropic，
并把 tool_calls 解析成统一结构返回。

安全约定：
- 密钥只保存在服务端 `workspace/ai-environment.json`，永不下发到前端；
- 前端只能拿到"是否已配置"与错误原因；
- 只有用户主动点击发送时才会发起外部请求。
"""

from __future__ import annotations

import json
import re
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import httpx

from app.services.workspace_log import (
    logs_dir,
    summarize_images,
    write_agent_call_log,
)

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

# apply_scene_commands 的参数契约说明（仍作为 agent 提示的一部分）。
AI_SCENE_COMMAND_SCHEMA_HINT = """apply_scene_commands 的 commands 数组约定：
1. 用户说“生成/搭建/布置…场景”时，第一条命令必须是 {"type":"clear_scene"}。
2. 坐标单位是米，旋转单位是度。人台围坐用 presetId:"sit"。树/柱用 kind:"cylinder"，不要 invent tree/person 等 kind。
3. 避免穿模；跑步/走路必须用 animate_move 产生位移；跟拍用 cameraFollow；360° 环绕用 cameraFollow:{"mode":"orbit","orbitDegrees":360,"radius":8}。
4. 镜头推近/拉远/平移用 animate_camera（相机路径关键帧）；禁止 animate_move 的 name/id 写成 camera，禁止造隐形控制点带动镜头。cameraFollow 只用于跟拍真实物体。
5. 发现重复角色/多余物体（如「跳舞女孩」与「跳舞女孩_补齐」）时用 remove_object，不要再 add「补齐」分身。
6. JSON 必须严格合法：数字写 50（不要写成字符串）；双引号；无尾随逗号。

命令类型：
- {"type":"clear_scene"}
- {"type":"add_object","kind":"box|cylinder|sphere|wall|floor","name?","position?","rotation?","size?","color?","description?"}
- {"type":"add_mannequin","name?","position?","rotation?","heightMeters?","presetId":"stand|sit|raise-hand|walk|run","description?"}
- {"type":"update_object","id?","name?","position?","rotation?","size?","color?","description?"}
- {"type":"remove_object","id?","name?"}
- {"type":"set_mannequin_pose","id?","name?","presetId":"stand|sit|raise-hand|walk|run"}
- {"type":"set_camera","position?","target?","fovDegrees?"}
- {"type":"animate_move","name?","id?","path":[{"x":0,"z":0},{"x":8,"z":0}],"durationSeconds":4,"faceAlongPath":true,"cameraFollow":{"mode":"orbit","orbitDegrees":360,"radius":8}}
- {"type":"animate_camera","path":[{"position":{"x":2,"y":1.9,"z":23},"target":{"x":1,"y":4,"z":0},"fovDegrees":48},{"position":{"x":1.9,"y":2.2,"z":18},"target":{"x":1,"y":4,"z":0}}],"durationSeconds":5}
"""

AI_DEFAULT_SYSTEM_PROMPT = f"""你是“小白盒”场景搭建 Agent。小白盒用基础体（方块、圆柱、球体、墙体、地面）、人台和摄影机快速表达空间。
你通过工具观察与修改场景，不要假装已经改过场景却不调用工具。

工作方式：
1. 需要了解现有物体时，先 list_assets；需要坐标/颜色等细节时 get_object。
2. 搭建或大改前，用户说“生成/搭建/布置…场景”时，apply_scene_commands 的第一条必须是 clear_scene。
3. 改完后用截图工具自检：capture_target_camera（成片机位）、capture_overview_camera（总览）；动画中途问题用 capture_timeline_pair。
4. 截图要省着调用：每轮尽量少拍；发现问题再用 apply_scene_commands 修正（重复人台用 remove_object）。
5. 全部完成后调用 done，并用一两句中文说明结果；不要只闲聊。
6. 单次 apply_scene_commands 建议不超过约 20 条；复杂场景（多塔/树林/大量散件）必须分多轮搭建，避免输出被截断。

{AI_SCENE_COMMAND_SCHEMA_HINT}"""

AI_AGENT_CAPABILITY_HINT = """【能力提醒】
- 用 list_assets / get_object 查资产，不要臆造场景里不存在的物体。
- 改场景只能通过 apply_scene_commands；命令必须合法 JSON 字段。
- 单次 commands 宜短：复杂场景拆成多轮 apply，避免一次输出过长被截断。
- 跑步/走路禁止只用 run/walk 姿势原地摆拍，必须 animate_move；跟拍用 cameraFollow；环绕用 mode:"orbit"。
- 镜头推近/拉远/平移用 animate_camera（path 至少两点含 position；target/fov 可选）；禁止 name:"camera" 的 animate_move，禁止隐形控制点跟拍伪装运镜。
- 树林用多个 cylinder + floor 表达，人物用 add_mannequin（presetId 可用 raise-hand 表示伸展姿态）。
- 目标机拍空或被墙挡住时，结合 overview / timeline_pair 再修正。
- 重复分身（名称含补齐/副本）必须 remove_object，禁止再 add 一个补齐人台。
- 完成后调用 done。"""


def compose_system_prompt(settings_prompt: str) -> str:
    prompt = (settings_prompt or "").strip() or AI_DEFAULT_SYSTEM_PROMPT
    # 旧版「一次吐完整 JSON」提示与 agent 冲突时，回落到默认 agent 提示。
    if "必须输出可被软件自动执行的 JSON 命令" in prompt and "list_assets" not in prompt:
        prompt = AI_DEFAULT_SYSTEM_PROMPT
    parts = [prompt, AI_AGENT_CAPABILITY_HINT]
    # 旧自定义提示缺新命令时补全 schema（含 remove_object / animate_camera）。
    if "remove_object" not in prompt or "animate_camera" not in prompt:
        parts.append(AI_SCENE_COMMAND_SCHEMA_HINT)
    return "\n\n".join(parts)


AI_CHAT_MAX_IMAGES = 12
# 复杂白膜场景一次会吐很长的 apply_scene_commands；2048 极易截断工具参数。
AI_DEFAULT_MAX_TOKENS = 8192
AI_LEGACY_LOW_MAX_TOKENS = 2048
AI_MAX_TOKENS_CAP = 128_000


def sanitize_images(images: Optional[list[dict[str, str]]]) -> list[dict[str, str]]:
    if not images:
        return []
    cleaned: list[dict[str, str]] = []
    for image in images[:AI_CHAT_MAX_IMAGES]:
        if not isinstance(image, dict):
            continue
        mime = str(image.get("mimeType") or "").strip()
        data = str(image.get("base64Data") or "").replace(" ", "").replace("\n", "")
        if not mime.startswith("image/") or not data:
            continue
        cleaned.append({"mimeType": mime[:64], "base64Data": data[:8_000_000]})
    return cleaned


def sanitize_tools(tools: Optional[list[dict[str, Any]]]) -> list[dict[str, Any]]:
    if not tools:
        return []
    cleaned: list[dict[str, Any]] = []
    for tool in tools[:32]:
        if not isinstance(tool, dict):
            continue
        name = str(tool.get("name") or "").strip()
        if not name:
            continue
        description = str(tool.get("description") or "")[:2000]
        parameters = tool.get("parameters")
        if not isinstance(parameters, dict):
            parameters = {"type": "object", "properties": {}}
        cleaned.append(
            {
                "name": name[:120],
                "description": description,
                "parameters": parameters,
            }
        )
    return cleaned


def openai_tool_transport(model: str, has_tools: bool) -> str:
    """选择 OpenAI 兼容链路的工具调用通道。

    - ``responses``：GPT-6 Astra / GPT-6.1 Sol 等在 chat/completions 上不支持 tools
    - ``chat_none``：GPT-5.4+ 默认可带 reasoning；chat + tools 时需显式 ``reasoning_effort=none``
    - ``chat``：普通模型，沿用 chat/completions
    """
    if not has_tools:
        return "chat"
    name = (model or "").lower().replace("_", "-")
    if re.search(r"gpt-6", name) or "astra" in name:
        return "responses"
    if re.search(r"gpt-5\.(4|5|6)", name):
        return "chat_none"
    return "chat"


def looks_like_tools_reasoning_conflict(detail: str) -> bool:
    text = (detail or "").lower()
    return "reasoning_effort" in text and (
        "function tools" in text or "/v1/responses" in text or "responses" in text
    )


def resolve_max_tokens(configured: int | None) -> int:
    """解析实际上游 max_tokens。

    历史默认 2048 对 Agent 搭建不够，会把 tool arguments 截断成非法 JSON；
    仍写着 ≤2048 的配置自动抬到 AI_DEFAULT_MAX_TOKENS。
    """
    try:
        value = int(configured or AI_DEFAULT_MAX_TOKENS)
    except (TypeError, ValueError):
        value = AI_DEFAULT_MAX_TOKENS
    if value <= AI_LEGACY_LOW_MAX_TOKENS:
        value = AI_DEFAULT_MAX_TOKENS
    return max(1, min(value, AI_MAX_TOKENS_CAP))


@dataclass
class AiProviderConfig:
    id: str
    name: str
    kind: str
    baseUrl: str = ""
    apiKey: str = ""
    model: str = ""
    temperature: float = 0.4
    maxTokens: int = AI_DEFAULT_MAX_TOKENS

    def resolved_base_url(self) -> str:
        base = (self.baseUrl or "").strip() or AI_DEFAULT_BASE_URLS.get(self.kind, "")
        return base.rstrip("/")

    def resolved_model(self) -> str:
        return (self.model or "").strip() or AI_DEFAULT_MODELS.get(self.kind, "")

    def resolved_max_tokens(self) -> int:
        return resolve_max_tokens(self.maxTokens)


@dataclass
class AiSettings:
    version: int = 1
    activeProviderId: Optional[str] = None
    providers: list[AiProviderConfig] = field(default_factory=list)
    systemPrompt: str = AI_DEFAULT_SYSTEM_PROMPT

    def active_provider(self) -> Optional[AiProviderConfig]:
        matched = self.provider_by_id(self.activeProviderId) if self.activeProviderId else None
        return matched or (self.providers[0] if self.providers else None)

    def provider_by_id(self, provider_id: Optional[str]) -> Optional[AiProviderConfig]:
        if not provider_id:
            return None
        for provider in self.providers:
            if provider.id == provider_id:
                return provider
        return None


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

    @property
    def agent_log_dir(self) -> Path:
        """固定目录：`{workspace}/logs/`（与其它必要日志同一目录）。"""
        return logs_dir(self.settings_path.parent)

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
                maxTokens=int(entry.get("maxTokens") or AI_DEFAULT_MAX_TOKENS),
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
                    # 对外展示实际生效值（旧 2048 会显示为抬升后的默认）。
                    "maxTokens": provider.resolved_max_tokens(),
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
        tools: Optional[list[dict[str, Any]]] = None,
        tool_choice: Optional[Any] = None,
        provider_id: Optional[str] = None,
        log_context: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        """转发一次对话。返回 {status, content, toolCalls} 或 {status:'error', message}。

        `provider_id` 可选：指定本次请求使用的服务商（会话级切换）。
        未传时退回全局 activeProviderId。不会改写 ai-environment.json。

        每次调用会向 `{workspace}/logs/YYYY-MM-DD.log` 追加一条完整记录。
        """
        started = time.perf_counter()
        call_id = uuid.uuid4().hex[:12]
        entry: dict[str, Any] = {
            "id": call_id,
            "ts": datetime.now(timezone.utc).isoformat(),
            "context": dict(log_context or {}),
            "request": {
                "providerId": provider_id,
                "messageCount": len(messages or []),
                "messages": messages or [],
                "sceneSummary": scene_summary,
                "images": summarize_images(images),
                "tools": [
                    {"name": t.get("name"), "description": t.get("description")}
                    for t in (tools or [])
                    if isinstance(t, dict)
                ],
                "toolChoice": tool_choice,
            },
            "upstream": None,
            "result": None,
        }
        result: dict[str, Any] = {"status": "error", "message": "未知错误"}

        try:
            settings = self.load_settings()
            if provider_id:
                provider = settings.provider_by_id(provider_id)
                if provider is None:
                    result = {"status": "error", "message": "所选 AI 服务不存在或已被删除。"}
                    return result
            else:
                provider = settings.active_provider()
            problem = describe_provider_problem(provider)
            if problem or provider is None:
                result = {"status": "error", "message": problem or "AI 接口不可用。"}
                return result

            entry["provider"] = {
                "id": provider.id,
                "name": provider.name,
                "kind": provider.kind,
                "model": provider.resolved_model(),
                "baseUrl": provider.resolved_base_url(),
            }

            system_prompt = compose_system_prompt(settings.systemPrompt)
            cleaned_images = sanitize_images(images)
            cleaned_tools = sanitize_tools(tools)
            response_kind = provider.kind
            url = ""
            body: dict[str, Any] = {}
            headers: dict[str, str] = {}

            if provider.kind == "anthropic":
                url, headers, body = self._build_anthropic(
                    provider,
                    system_prompt,
                    messages,
                    scene_summary,
                    cleaned_images,
                    cleaned_tools,
                    tool_choice,
                )
            else:
                transport = openai_tool_transport(provider.resolved_model(), bool(cleaned_tools))
                if transport == "responses":
                    response_kind = "openai-responses"
                    url, headers, body = self._build_openai_responses(
                        provider,
                        system_prompt,
                        messages,
                        scene_summary,
                        cleaned_images,
                        cleaned_tools,
                        tool_choice,
                    )
                else:
                    url, headers, body = self._build_openai(
                        provider,
                        system_prompt,
                        messages,
                        scene_summary,
                        cleaned_images,
                        cleaned_tools,
                        tool_choice,
                        reasoning_effort="none" if transport == "chat_none" else None,
                    )

            entry["upstream"] = {
                "kind": response_kind,
                "url": url,
                "requestBody": body,
                "retriedAsResponses": False,
            }

            try:
                async with httpx.AsyncClient(timeout=120.0) as client:
                    response = await client.post(url, headers=headers, json=body)
                    # 部分网关/新模型在 chat+tools 上仍会因 reasoning 默认值报 400，自动改走 Responses。
                    if (
                        provider.kind != "anthropic"
                        and cleaned_tools
                        and response_kind != "openai-responses"
                        and response.status_code >= 400
                        and looks_like_tools_reasoning_conflict(response.text)
                    ):
                        response_kind = "openai-responses"
                        url, headers, body = self._build_openai_responses(
                            provider,
                            system_prompt,
                            messages,
                            scene_summary,
                            cleaned_images,
                            cleaned_tools,
                            tool_choice,
                        )
                        entry["upstream"] = {
                            "kind": response_kind,
                            "url": url,
                            "requestBody": body,
                            "retriedAsResponses": True,
                        }
                        response = await client.post(url, headers=headers, json=body)
            except httpx.TimeoutException:
                result = {"status": "error", "message": "AI 接口响应超时，请稍后重试。"}
                return result
            except httpx.HTTPError as error:
                result = {"status": "error", "message": f"无法连接 AI 接口：{error}"}
                return result

            upstream = entry.get("upstream") or {}
            upstream["httpStatus"] = response.status_code
            entry["upstream"] = upstream

            if response.status_code >= 400:
                detail = response.text[:400]
                upstream["errorBody"] = detail
                result = {
                    "status": "error",
                    "message": f"AI 接口返回 {response.status_code}：{detail}",
                }
                return result

            try:
                data = response.json()
            except Exception:
                upstream["rawText"] = response.text[:2000]
                result = {"status": "error", "message": "AI 接口返回了无法解析的内容。"}
                return result

            upstream["rawResponse"] = data
            content = self._extract_content(response_kind, data)
            tool_calls = self._extract_tool_calls(response_kind, data)
            truncation = self._detect_output_truncation(response_kind, data, tool_calls)
            if truncation:
                upstream["truncation"] = truncation
                result = {
                    "status": "error",
                    "message": truncation["message"],
                    "content": content or "",
                }
                return result
            if not content and not tool_calls:
                result = {"status": "error", "message": "AI 接口没有返回文本或工具调用。"}
                return result
            # 去掉内部标记，避免前端把 _truncated 当命令字段。
            for call in tool_calls:
                args = call.get("arguments")
                if isinstance(args, dict):
                    args.pop("_truncated", None)
            result = {"status": "ok", "content": content or "", "toolCalls": tool_calls}
            return result
        finally:
            entry["result"] = result
            entry["durationMs"] = int((time.perf_counter() - started) * 1000)
            write_agent_call_log(self.agent_log_dir, entry)

    @staticmethod
    def _prepare_messages(
        messages: list[dict[str, Any]], scene_summary: Optional[str]
    ) -> list[dict[str, Any]]:
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
        tools: Optional[list[dict[str, Any]]],
        tool_choice: Optional[Any],
        reasoning_effort: Optional[str] = None,
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        prepared: list[dict[str, Any]] = [{"role": "system", "content": system_prompt}]
        for message in self._prepare_messages(messages, scene_summary):
            prepared.append(self._to_openai_message(message))

        if images and prepared:
            last = prepared[-1]
            text = last.get("content", "")
            if isinstance(text, list):
                content: list[dict[str, Any]] = list(text)
            else:
                content = [{"type": "text", "text": str(text or "")}]
            for image in images:
                content.append(
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:{image['mimeType']};base64,{image['base64Data']}"
                        },
                    }
                )
            prepared[-1] = {**last, "content": content}

        body: dict[str, Any] = {
            "model": provider.resolved_model(),
            "messages": prepared,
            "temperature": provider.temperature,
            "max_tokens": provider.resolved_max_tokens(),
        }
        if reasoning_effort:
            body["reasoning_effort"] = reasoning_effort
        if tools:
            body["tools"] = [
                {
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool["description"],
                        "parameters": tool["parameters"],
                    },
                }
                for tool in tools
            ]
            if tool_choice is not None:
                body["tool_choice"] = tool_choice
        return (
            f"{provider.resolved_base_url()}/chat/completions",
            {
                "Authorization": f"Bearer {provider.apiKey}",
                "Content-Type": "application/json",
            },
            body,
        )

    def _build_openai_responses(
        self,
        provider: AiProviderConfig,
        system_prompt: str,
        messages: list[dict[str, Any]],
        scene_summary: Optional[str],
        images: Optional[list[dict[str, str]]],
        tools: Optional[list[dict[str, Any]]],
        tool_choice: Optional[Any],
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        """OpenAI Responses API：GPT-6 等模型在 chat/completions 上无法与 tools 并用。"""
        instructions = system_prompt
        if scene_summary and scene_summary.strip():
            instructions = f"{system_prompt}\n\n当前场景概况：\n{scene_summary.strip()}"

        input_items = self._to_responses_input(messages)
        if images and input_items:
            # 把本轮截图挂到最后一条 user 消息；没有则补一条。
            attached = False
            for index in range(len(input_items) - 1, -1, -1):
                item = input_items[index]
                if not isinstance(item, dict) or item.get("role") != "user":
                    continue
                blocks = item.get("content")
                if isinstance(blocks, str):
                    blocks = [{"type": "input_text", "text": blocks}]
                elif isinstance(blocks, list):
                    blocks = [
                        (
                            block
                            if isinstance(block, dict)
                            and block.get("type") in ("input_text", "input_image")
                            else {"type": "input_text", "text": str(block)}
                        )
                        for block in blocks
                    ]
                else:
                    blocks = [{"type": "input_text", "text": ""}]
                for image in images:
                    blocks.append(
                        {
                            "type": "input_image",
                            "image_url": f"data:{image['mimeType']};base64,{image['base64Data']}",
                        }
                    )
                input_items[index] = {"role": "user", "content": blocks}
                attached = True
                break
            if not attached:
                blocks = [{"type": "input_text", "text": "（系统）请查看附图。"}]
                for image in images:
                    blocks.append(
                        {
                            "type": "input_image",
                            "image_url": f"data:{image['mimeType']};base64,{image['base64Data']}",
                        }
                    )
                input_items.append({"role": "user", "content": blocks})

        body: dict[str, Any] = {
            "model": provider.resolved_model(),
            "instructions": instructions,
            "input": input_items,
            "temperature": provider.temperature,
            "max_output_tokens": provider.resolved_max_tokens(),
        }
        if tools:
            body["tools"] = [
                {
                    "type": "function",
                    "name": tool["name"],
                    "description": tool["description"],
                    "parameters": tool["parameters"],
                }
                for tool in tools
            ]
            if tool_choice is not None:
                body["tool_choice"] = tool_choice
        return (
            f"{provider.resolved_base_url()}/responses",
            {
                "Authorization": f"Bearer {provider.apiKey}",
                "Content-Type": "application/json",
            },
            body,
        )

    def _to_responses_input(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """把前端统一 messages 转成 Responses API 的 input 列表。"""
        items: list[dict[str, Any]] = []
        for message in messages:
            role = message.get("role") or "user"
            if role == "system":
                continue
            if role == "tool":
                content = message.get("content")
                if not isinstance(content, str):
                    content = json.dumps(content, ensure_ascii=False)
                items.append(
                    {
                        "type": "function_call_output",
                        "call_id": str(
                            message.get("toolCallId") or message.get("tool_call_id") or ""
                        ),
                        "output": content,
                    }
                )
                continue
            if role == "assistant" and message.get("toolCalls"):
                text = message.get("content")
                if isinstance(text, str) and text.strip():
                    items.append({"role": "assistant", "content": text})
                for call in message.get("toolCalls") or []:
                    arguments = call.get("arguments")
                    if not isinstance(arguments, str):
                        arguments = json.dumps(arguments or {}, ensure_ascii=False)
                    items.append(
                        {
                            "type": "function_call",
                            "call_id": str(call.get("id") or ""),
                            "name": str(call.get("name") or ""),
                            "arguments": arguments,
                        }
                    )
                continue
            items.append(
                {
                    "role": role if role in ("user", "assistant") else "user",
                    "content": message.get("content", ""),
                }
            )
        return items

    def _build_anthropic(
        self,
        provider: AiProviderConfig,
        system_prompt: str,
        messages: list[dict[str, Any]],
        scene_summary: Optional[str],
        images: Optional[list[dict[str, str]]],
        tools: Optional[list[dict[str, Any]]],
        tool_choice: Optional[Any],
    ) -> tuple[str, dict[str, str], dict[str, Any]]:
        if scene_summary and scene_summary.strip():
            system_prompt = f"{system_prompt}\n\n当前场景概况：\n{scene_summary.strip()}"

        anthropic_messages = self._to_anthropic_messages(messages)
        if images and anthropic_messages:
            last = anthropic_messages[-1]
            blocks = last.get("content")
            if isinstance(blocks, str):
                blocks = [{"type": "text", "text": blocks}]
            elif not isinstance(blocks, list):
                blocks = [{"type": "text", "text": ""}]
            else:
                blocks = list(blocks)
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
            anthropic_messages[-1] = {"role": last.get("role", "user"), "content": blocks}

        body: dict[str, Any] = {
            "model": provider.resolved_model(),
            "system": system_prompt,
            "messages": anthropic_messages,
            "temperature": provider.temperature,
            "max_tokens": provider.resolved_max_tokens(),
        }
        if tools:
            body["tools"] = [
                {
                    "name": tool["name"],
                    "description": tool["description"],
                    "input_schema": tool["parameters"],
                }
                for tool in tools
            ]
            if tool_choice is not None:
                body["tool_choice"] = self._anthropic_tool_choice(tool_choice)
        return (
            f"{provider.resolved_base_url()}/v1/messages",
            {
                "x-api-key": provider.apiKey,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
            body,
        )

    @staticmethod
    def _to_openai_message(message: dict[str, Any]) -> dict[str, Any]:
        role = message.get("role") or "user"
        if role == "tool":
            return {
                "role": "tool",
                "tool_call_id": str(message.get("toolCallId") or message.get("tool_call_id") or ""),
                "content": message.get("content")
                if isinstance(message.get("content"), str)
                else json.dumps(message.get("content"), ensure_ascii=False),
            }
        if role == "assistant" and message.get("toolCalls"):
            tool_calls = []
            for call in message.get("toolCalls") or []:
                arguments = call.get("arguments")
                if not isinstance(arguments, str):
                    arguments = json.dumps(arguments or {}, ensure_ascii=False)
                tool_calls.append(
                    {
                        "id": str(call.get("id") or ""),
                        "type": "function",
                        "function": {
                            "name": str(call.get("name") or ""),
                            "arguments": arguments,
                        },
                    }
                )
            result: dict[str, Any] = {
                "role": "assistant",
                "content": message.get("content") or None,
                "tool_calls": tool_calls,
            }
            return result
        return {"role": role, "content": message.get("content", "")}

    def _to_anthropic_messages(self, messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """把前端统一消息格式转成 Anthropic messages（合并连续 tool_result）。"""
        prepared: list[dict[str, Any]] = []
        pending_tool_results: list[dict[str, Any]] = []

        def flush_tool_results() -> None:
            nonlocal pending_tool_results
            if not pending_tool_results:
                return
            prepared.append({"role": "user", "content": pending_tool_results})
            pending_tool_results = []

        for message in messages:
            role = message.get("role") or "user"
            if role == "system":
                continue
            if role == "tool":
                content = message.get("content")
                if not isinstance(content, str):
                    content = json.dumps(content, ensure_ascii=False)
                pending_tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": str(
                            message.get("toolCallId") or message.get("tool_call_id") or ""
                        ),
                        "content": content,
                    }
                )
                continue

            flush_tool_results()
            if role == "assistant" and message.get("toolCalls"):
                blocks: list[dict[str, Any]] = []
                text = message.get("content")
                if isinstance(text, str) and text.strip():
                    blocks.append({"type": "text", "text": text})
                for call in message.get("toolCalls") or []:
                    arguments = call.get("arguments")
                    if isinstance(arguments, str):
                        try:
                            arguments = json.loads(arguments)
                        except Exception:
                            arguments = {"raw": arguments}
                    if not isinstance(arguments, dict):
                        arguments = {}
                    blocks.append(
                        {
                            "type": "tool_use",
                            "id": str(call.get("id") or ""),
                            "name": str(call.get("name") or ""),
                            "input": arguments,
                        }
                    )
                prepared.append({"role": "assistant", "content": blocks})
                continue

            prepared.append({"role": role if role in ("user", "assistant") else "user", "content": message.get("content", "")})

        flush_tool_results()
        return prepared

    @staticmethod
    def _anthropic_tool_choice(tool_choice: Any) -> Any:
        if tool_choice == "auto":
            return {"type": "auto"}
        if tool_choice == "none":
            return {"type": "none"}
        if tool_choice == "required":
            return {"type": "any"}
        if isinstance(tool_choice, dict):
            return tool_choice
        return {"type": "auto"}

    @staticmethod
    def _parse_tool_arguments(raw_args: Any) -> dict[str, Any]:
        """解析 tool arguments；非法 JSON（常见于输出截断）标 _truncated。"""
        if isinstance(raw_args, dict):
            return raw_args
        if not isinstance(raw_args, str):
            return {}
        text = raw_args.strip()
        if not text:
            return {}
        try:
            parsed = json.loads(text)
        except Exception:
            return {"raw": raw_args, "_truncated": True}
        if isinstance(parsed, dict):
            return parsed
        return {"value": parsed}

    @staticmethod
    def _detect_output_truncation(
        kind: str, data: dict[str, Any], tool_calls: list[dict[str, Any]]
    ) -> dict[str, str] | None:
        """识别 max_output_tokens / 不完整 function_call / 截断 JSON。"""
        reasons: list[str] = []
        if isinstance(data, dict):
            status = str(data.get("status") or "")
            details = data.get("incomplete_details")
            detail_reason = ""
            if isinstance(details, dict):
                detail_reason = str(details.get("reason") or "")
            if status == "incomplete" or detail_reason:
                reasons.append(detail_reason or status or "incomplete")
            if kind == "openai-responses" or isinstance(data.get("output"), list):
                for item in data.get("output") or []:
                    if (
                        isinstance(item, dict)
                        and item.get("type") == "function_call"
                        and str(item.get("status") or "") == "incomplete"
                    ):
                        reasons.append("incomplete_tool_call")
                        break
            choices = data.get("choices") or []
            if choices and isinstance(choices[0], dict):
                finish = str((choices[0] or {}).get("finish_reason") or "")
                if finish in {"length", "max_tokens"}:
                    reasons.append(finish)

        truncated_args = any(
            isinstance(call.get("arguments"), dict) and call["arguments"].get("_truncated")
            for call in tool_calls
        )
        if truncated_args:
            reasons.append("truncated_tool_arguments")

        if not reasons:
            return None
        # 仅有普通 incomplete 但工具参数完好时，仍允许继续（少见）。
        serious = any(
            reason in {
                "max_output_tokens",
                "length",
                "max_tokens",
                "incomplete_tool_call",
                "truncated_tool_arguments",
            }
            for reason in reasons
        )
        if not serious and not truncated_args:
            return None
        return {
            "reason": reasons[0],
            "message": (
                "AI 输出被截断（maxTokens 不足），场景命令不完整，已取消执行。"
                "请在 AI 设置中提高 maxTokens（建议 ≥ 8192），"
                "或让模型分多轮、每次少量命令搭建。"
            ),
        }

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
            if kind == "openai-responses":
                direct = data.get("output_text")
                if isinstance(direct, str) and direct.strip():
                    return direct.strip()
                parts: list[str] = []
                for item in data.get("output") or []:
                    if not isinstance(item, dict):
                        continue
                    if item.get("type") == "message":
                        for block in item.get("content") or []:
                            if isinstance(block, dict) and block.get("type") in (
                                "output_text",
                                "text",
                            ):
                                parts.append(str(block.get("text") or ""))
                    elif item.get("type") == "output_text":
                        parts.append(str(item.get("text") or ""))
                return "".join(parts).strip()
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

    @staticmethod
    def _extract_tool_calls(kind: str, data: dict[str, Any]) -> list[dict[str, Any]]:
        try:
            if kind == "anthropic":
                result = []
                for block in data.get("content") or []:
                    if not isinstance(block, dict) or block.get("type") != "tool_use":
                        continue
                    result.append(
                        {
                            "id": str(block.get("id") or ""),
                            "name": str(block.get("name") or ""),
                            "arguments": block.get("input")
                            if isinstance(block.get("input"), dict)
                            else {},
                        }
                    )
                return result

            if kind == "openai-responses" or (
                isinstance(data.get("output"), list) and "choices" not in data
            ):
                result = []
                for item in data.get("output") or []:
                    if not isinstance(item, dict) or item.get("type") != "function_call":
                        continue
                    arguments = AiService._parse_tool_arguments(item.get("arguments") or "{}")
                    result.append(
                        {
                            "id": str(item.get("call_id") or item.get("id") or ""),
                            "name": str(item.get("name") or ""),
                            "arguments": arguments,
                        }
                    )
                return result

            choices = data.get("choices") or []
            if not choices:
                return []
            message = choices[0].get("message") or {}
            result = []
            for call in message.get("tool_calls") or []:
                if not isinstance(call, dict):
                    continue
                function = call.get("function") or {}
                arguments = AiService._parse_tool_arguments(function.get("arguments") or "{}")
                result.append(
                    {
                        "id": str(call.get("id") or ""),
                        "name": str(function.get("name") or ""),
                        "arguments": arguments,
                    }
                )
            return result
        except Exception:
            return []
