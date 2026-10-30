/**
 * 后端 API 客户端。
 *
 * 所有网络请求集中在这里，组件不直接调用 fetch。
 * 这样做的原因：
 * 1. 错误处理与提示语只需维护一处；
 * 2. 鉴权 Cookie 由浏览器自动携带；401 时统一跳转登录；
 * 3. 便于在测试中整体替换。
 */

const BASE = '/api'

let onUnauthorized = null

/** 注册 401 回调（通常在 router 里跳转到 /login）。 */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = typeof handler === 'function' ? handler : null
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  })
  if (response.status === 401) {
    if (onUnauthorized) onUnauthorized()
    throw new ApiError('未登录。', 401)
  }
  if (!response.ok) {
    let detail = response.status === 403 ? '无权限。' : `请求失败（${response.status}）`
    try {
      const payload = await response.json()
      if (payload && payload.detail) detail = String(payload.detail)
    } catch {
      // 后端可能返回非 JSON（例如反向代理错误页），保留通用文案。
    }
    throw new ApiError(detail, response.status)
  }
  const contentType = response.headers.get('content-type') || ''
  return contentType.includes('application/json') ? response.json() : response.text()
}

/** multipart 上传（不要手动设 Content-Type，浏览器会带 boundary）。 */
async function postMultipart(path, form, failureLabel) {
  const response = await fetch(`${BASE}${path}`, {
    method: 'POST',
    body: form,
    credentials: 'same-origin'
  })
  if (response.status === 401) {
    if (onUnauthorized) onUnauthorized()
    throw new ApiError('未登录。', 401)
  }
  if (!response.ok) {
    let detail = response.status === 403 ? '无权限。' : `${failureLabel}（${response.status}）`
    try {
      const payload = await response.json()
      if (payload && payload.detail) detail = String(payload.detail)
    } catch {
      // ignore
    }
    throw new ApiError(detail, response.status)
  }
  return response.json()
}

export const api = {
  meta: () => request('/meta'),
  health: () => request('/health'),

  auth: {
    login: (username) => request('/auth/login', { method: 'POST', body: JSON.stringify({ username }) }),
    logout: () => request('/auth/logout', { method: 'POST', body: '{}' }),
    me: () => request('/auth/me')
  },

  admin: {
    users: () => request('/admin/users'),
    updateUser: (userId, payload) =>
      request(`/admin/users/${encodeURIComponent(userId)}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      }),
    projects: (ownerId) =>
      request(ownerId ? `/admin/projects?ownerId=${encodeURIComponent(ownerId)}` : '/admin/projects'),
    openProject: (projectId) => request(`/admin/projects/${encodeURIComponent(projectId)}`),
    removeProject: (projectId) =>
      request(`/admin/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' })
  },

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
      return postMultipart('/exports/upload', form, '上传失败')
    },
    /**
     * 本机 WebCodecs 不可用时：上传 JPEG/PNG 帧序列，由后端 ffmpeg 合成 MP4。
     * `frameBlobs` 必须按时间顺序。
     */
    encodeMp4: async (fileName, frameRate, frameBlobs) => {
      const form = new FormData()
      form.append('fileName', fileName)
      form.append('frameRate', String(frameRate))
      for (let index = 0; index < frameBlobs.length; index += 1) {
        const blob = frameBlobs[index]
        const ext = blob.type === 'image/png' ? 'png' : 'jpg'
        form.append('frames', blob, `frame_${String(index).padStart(4, '0')}.${ext}`)
      }
      return postMultipart('/exports/encode-mp4', form, '服务器编码失败')
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
