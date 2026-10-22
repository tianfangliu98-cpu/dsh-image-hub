/**
 * dsh-image-hub 核心工具：配置、HTTP、图片、参考图。
 *
 * 只依赖 node: 内置模块，方便单元测试；不 import 任何 DSH 服务。
 */

import { chmod, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export const DEFAULT_FOLDER = 'dsh-image-hub'

export const DEFAULT_CONFIG = {
  /** 默认 profile 的 id；空表示用第一个 */
  activeProfile: '',
  /** 多套 API 配置 */
  profiles: [],
  /** 生成结果是否另存到工作区 */
  saveToWorkspace: true,
  /** 工作区子目录 */
  workspaceFolder: DEFAULT_FOLDER,
}

/** DSH_HOME：与其它插件保持一致（环境变量优先，否则 ~/.dsh）。 */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : path.join(homedir(), '.dsh')
}

export function configPath() {
  return path.join(dshHome(), 'image-hub', 'config.json')
}

/** 读配置：坏文件不能让插件整体失效，逐字段回退。 */
export async function loadConfig() {
  const config = { ...DEFAULT_CONFIG, profiles: [] }
  let raw
  try {
    raw = await readFile(configPath(), 'utf8')
  } catch {
    return config
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return config
  }
  if (parsed === null || typeof parsed !== 'object') return config
  if (typeof parsed.activeProfile === 'string') config.activeProfile = parsed.activeProfile
  if (Array.isArray(parsed.profiles)) config.profiles = parsed.profiles.filter(isUsableProfile).map(normalizeProfile)
  if (typeof parsed.saveToWorkspace === 'boolean') config.saveToWorkspace = parsed.saveToWorkspace
  if (typeof parsed.workspaceFolder === 'string' && parsed.workspaceFolder.trim() !== '') {
    config.workspaceFolder = parsed.workspaceFolder.trim()
  }
  return config
}

/** 原子写配置；密钥文件在 POSIX 上收成 0600。 */
export async function saveConfig(config) {
  const file = configPath()
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
  try {
    await chmod(file, 0o600)
  } catch {
    // Windows 上忽略
  }
}

export function isUsableProfile(value) {
  return value !== null && typeof value === 'object' && typeof value.provider === 'string' && value.provider !== ''
}

/** 只保留认识的字段，避免旧版本残留字段把 schema 撑坏。 */
export function normalizeProfile(value) {
  const id = typeof value.id === 'string' && value.id !== '' ? value.id : `p-${Math.random().toString(36).slice(2, 8)}`
  return {
    id,
    provider: value.provider,
    name: typeof value.name === 'string' && value.name !== '' ? value.name : value.provider,
    baseURL: typeof value.baseURL === 'string' ? value.baseURL.trim() : '',
    apiKey: typeof value.apiKey === 'string' ? value.apiKey.trim() : '',
    model: typeof value.model === 'string' ? value.model.trim() : '',
    models: Array.isArray(value.models) ? value.models.filter((m) => typeof m === 'string' && m !== '') : [],
    aspectRatio: typeof value.aspectRatio === 'string' ? value.aspectRatio : '',
    imageSize: typeof value.imageSize === 'string' ? value.imageSize : '',
    /** 可选：这套配置专用的 HTTP 代理（形如 http://127.0.0.1:7890） */
    proxy: typeof value.proxy === 'string' ? value.proxy.trim() : '',
    extra: value.extra !== null && typeof value.extra === 'object' && !Array.isArray(value.extra) ? value.extra : {},
  }
}

/** 当前生效的 profile：activeProfile 指定，否则第一个。 */
export function resolveProfile(config, requestedId) {
  const profiles = Array.isArray(config.profiles) ? config.profiles : []
  if (requestedId !== undefined && requestedId !== '') {
    return profiles.find((p) => p.id === requestedId || p.name === requestedId)
  }
  if (config.activeProfile !== '') {
    const active = profiles.find((p) => p.id === config.activeProfile)
    if (active !== undefined) return active
  }
  return profiles[0]
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 180_000

export class HubError extends Error {
  constructor(message, { status = 0, code, body, hint } = {}) {
    super(message)
    this.name = 'HubError'
    this.status = status
    this.code = code
    this.body = body
    this.hint = hint
  }
}

function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** 发请求并解析 JSON；非 2xx 统一抛 HubError（带上游原文片段）。 */
export async function requestJson(url, { method = 'GET', headers = {}, body, signal, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: withTimeout(signal, timeoutMs),
    })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError'
    throw new HubError(timedOut ? `上游 ${Math.round(timeoutMs / 1000)} 秒未返回` : `请求失败：${String(error?.message ?? error)}`)
  }

  const text = await response.text()
  let payload
  try {
    payload = text.trim() === '' ? {} : JSON.parse(text)
  } catch {
    payload = { raw: text.slice(0, 2000) }
  }
  if (!response.ok) {
    const message = typeof payload?.error?.message === 'string'
      ? payload.error.message
      : typeof payload?.message === 'string' ? payload.message : `HTTP ${response.status}`
    throw new HubError(`${message}`, { status: response.status, code: payload?.code, body: text.slice(0, 2000) })
  }
  return payload
}

/** 从魔数判断图片类型。 */
export function sniffMediaType(data) {
  if (!(data instanceof Uint8Array) || data.length < 12) return undefined
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp'
  return undefined
}

/** 下载图片（或解码 data: URL）。 */
export async function fetchImageBytes(url, { headers = {}, signal, maxBytes = 24 * 1024 * 1024, fetchImpl = fetch } = {}) {
  if (typeof url !== 'string' || url === '') throw new HubError('上游没有返回图片地址')
  if (url.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(url)
    if (match === null) throw new HubError('无法解析 data URL')
    const data = Buffer.from(match[2], 'base64')
    return { data, mediaType: match[1] }
  }
  let response
  try {
    response = await fetchImpl(url, { method: 'GET', headers, signal, redirect: 'follow' })
  } catch (error) {
    throw new HubError(`下载图片失败：${String(error?.message ?? error)}`)
  }
  if (!response.ok) throw new HubError(`下载图片失败：HTTP ${response.status}`, { status: response.status })
  const buffer = new Uint8Array(await response.arrayBuffer())
  if (buffer.byteLength > maxBytes) throw new HubError(`图片过大：${buffer.byteLength} 字节`)
  return { data: buffer, mediaType: sniffMediaType(buffer) ?? 'image/png' }
}

export function extensionFor(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg'
  if (mediaType === 'image/webp') return 'webp'
  if (mediaType === 'image/gif') return 'gif'
  if (mediaType === 'image/bmp') return 'bmp'
  return 'png'
}

export function isInside(root, candidate) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** 把结果另存到工作区，返回文件绝对路径。 */
export async function saveImageToWorkspace({ workspaceRoot, folder, model, mediaType, data }) {
  const root = path.resolve(workspaceRoot)
  const target = folder === undefined || folder === '' ? root : path.resolve(root, folder)
  if (!isInside(root, target)) throw new HubError('保存目录逃出了工作区')
  await mkdir(target, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
  const safeModel = String(model ?? 'image').replace(/[^a-z0-9.-]/gi, '-')
  const file = path.join(target, `${safeModel}-${stamp}.${extensionFor(mediaType)}`)
  await writeFile(file, data)
  return file
}

/** 从会话消息里收集图片附件。 */
export function collectImages(content) {
  const refs = []
  for (const block of Array.isArray(content) ? content : []) {
    if (block !== null && typeof block === 'object' && block.type === 'image' && block.attachment !== undefined) {
      refs.push(block.attachment)
    }
  }
  return refs
}

export function sameAttachmentId(left, right) {
  const normalize = (value) => String(value ?? '').replace(/^sha256:/i, '').toLowerCase()
  return normalize(left) === normalize(right)
}

/** 显式 id 优先；否则取最新一条带图消息。 */
export function findReferenceImages(messages, ids) {
  if (Array.isArray(ids) && ids.length > 0) {
    return ids.map((id) => {
      for (const message of messages) {
        for (const ref of collectImages(message?.content)) {
          if (sameAttachmentId(ref?.attachmentId, id)) return ref
        }
      }
      throw new HubError(`当前会话里找不到附件 ${id} 的图片`)
    })
  }
  const newestHuman = [...messages].reverse().find((message) => message?.source?.kind === 'user')
  if (newestHuman !== undefined) {
    const refs = collectImages(newestHuman.content)
    if (refs.length > 0) return refs
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const refs = collectImages(messages[index]?.content)
    if (refs.length > 0) return refs
  }
  return []
}

/** 读工作区里的图片，做词法与真实路径双重越界检查。 */
export async function readWorkspaceImage(sourcePath, workspaceRoot, { maxBytes = 24 * 1024 * 1024, signal } = {}) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot === '') throw new HubError('没有活动会话的工作目录')
  const requested = String(sourcePath ?? '').trim()
  if (requested === '') throw new HubError('图片路径为空')
  const root = path.resolve(workspaceRoot)
  const candidate = path.isAbsolute(requested) ? path.resolve(requested) : path.resolve(root, requested)
  if (!isInside(root, candidate)) throw new HubError(`只能读取当前工作区内的图片：${requested}`)

  let realRoot
  let realCandidate
  try {
    ;[realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)])
  } catch (error) {
    if (error?.code === 'ENOENT') throw new HubError(`找不到图片：${requested}`)
    throw error
  }
  if (!isInside(realRoot, realCandidate)) throw new HubError(`路径经符号链接跳出了工作区：${requested}`)

  const info = await stat(realCandidate)
  if (!info.isFile()) throw new HubError(`不是文件：${requested}`)
  if (info.size > maxBytes) throw new HubError(`图片过大：${info.size} 字节`)
  const data = await readFile(realCandidate, { signal })
  const mediaType = sniffMediaType(data)
  if (mediaType === undefined) throw new HubError(`不是支持的图片格式：${requested}`)
  return { data, mediaType }
}
