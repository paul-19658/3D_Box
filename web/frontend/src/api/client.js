/**
 * 后端 API 客户端。
 *
 * 所有网络请求集中在这里，组件不直接调用 fetch。
 * 这样做的原因：
 * 1. 错误处理与提示语只需维护一处；
 * 2. 将来加鉴权 / 请求重试时不必改组件；
 * 3. 便于在测试中整体替换。
 */

const BASE = '/api'

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  })
  if (!response.ok) {
    let detail = `请求失败（${response.status}）`
    try {
      const payload = await response.json()
      if (payload && payload.detail) detail = String(payload.detail)
    } catch {
      // 后端可能返回非 JSON（例如反向代理错误页），保留通用文案。
    }
    throw new Error(detail)
  }
  const contentType = response.headers.get('content-type') || ''
  return contentType.includes('application/json') ? response.json() : response.text()
}

export const api = {
  meta: () => request('/meta'),
  health: () => request('/health'),

  projects: {
    list: () => request('/projects'),
    save: (document, projectId) =>
      request('/projects', { method: 'POST', body: JSON.stringify({ document, projectId }) }),
    open: (projectId) => request(`/projects/${encodeURIComponent(projectId)}`),
    remove: (projectId) => request(`/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  },

  recovery: {
    save: (document, projectId) =>
      request('/recovery', { method: 'POST', body: JSON.stringify({ document, projectId }) }),
    load: () => request('/recovery'),
    clear: () => request('/recovery', { method: 'DELETE' })
  },

  recent: {
    list: () => request('/recent'),
    remove: (projectId) => request(`/recent/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  },

  exports: {
    /** 小文件（单张图片、模型、文本）走 base64 接口。 */
    save: (fileName, base64Data) =>
      request('/exports', { method: 'POST', body: JSON.stringify({ fileName, base64Data }) }),
    saveText: (fileName, content) =>
      request('/exports/text', { method: 'POST', body: JSON.stringify({ fileName, content }) }),
    /** 大文件（序列帧、MP4）走二进制直传，避免 base64 膨胀。 */
    upload: async (fileName, blob) => {
      const form = new FormData()
      form.append('file', blob, fileName)
      const response = await fetch(`${BASE}/exports/upload`, { method: 'POST', body: form })
      if (!response.ok) throw new Error(`上传失败（${response.status}）`)
      return response.json()
    },
    downloadUrl: (fileName) => `${BASE}/exports/${encodeURIComponent(fileName)}`
  },

  sceneDescriptor: (projectName, scene) =>
    request('/scene-descriptor', {
      method: 'POST',
      body: JSON.stringify({ projectName, scene })
    }),
  suggestedPrompt: (projectName, scene) =>
    request('/suggested-prompt', {
      method: 'POST',
      body: JSON.stringify({ projectName, scene })
    }),

  platformProfiles: {
    list: () => request('/platform-profiles'),
    validate: (payload) =>
      request('/platform-profiles/validate', { method: 'POST', body: JSON.stringify(payload) })
  },

  ai: {
    settings: () => request('/ai/settings'),
    saveSettings: (payload) => request('/ai/settings', { method: 'PUT', body: JSON.stringify(payload) }),
    chat: (payload) => request('/ai/chat', { method: 'POST', body: JSON.stringify(payload) })
  }
}
