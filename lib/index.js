/**
 * dsh-image-hub —— 宿主半。
 *
 * 两个工具 + 一个设置接口：
 *   image_generate / image_edit     对话里生图、改图
 *   /api/image-hub/*                设置页读写配置、测试连接、拉模型
 *
 * 设计要点：
 *   - provider 适配层与插件本体解耦（lib/providers.js），加新厂商不改这里；
 *   - 配置是「多套 profile」，每套 = provider + baseURL + key + 模型；
 *   - 不依赖任何 @deepseek-ai/* 包，只用 node: 内置模块。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { dshHome, loadConfig, resolveProfile, saveConfig, normalizeProfile, isUsableProfile, saveImageToWorkspace, findReferenceImages, readWorkspaceImage } from './core.js'
import { HubError } from './core.js'
import { PROVIDERS, RATIOS, SIZES, getProvider, providerCatalog, pixelsFor, sizeString } from './providers.js'
import { createProxiedFetch } from './proxy.js'

export const name = 'image-hub'
export const inject = ['tools', 'attachments', 'webServer']

const API_PREFIX = '/api/image-hub'
const MAX_REFERENCE_IMAGES = 14

// ---------------------------------------------------------------------------
// 参数收敛
// ---------------------------------------------------------------------------

function normalizeRequest({ profile, aspectRatio, imageSize, referenceCount }) {
  const provider = getProvider(profile.provider)
  const warnings = []

  let ratio = typeof aspectRatio === 'string' && aspectRatio !== '' ? aspectRatio : (profile.aspectRatio || '1:1')
  if (!RATIOS.includes(ratio)) {
    warnings.push(`不支持比例 ${ratio}，已改用 1:1`)
    ratio = '1:1'
  }

  let size = typeof imageSize === 'string' && imageSize !== '' ? imageSize.toUpperCase() : (profile.imageSize || '2K')
  if (!SIZES.includes(size)) {
    warnings.push(`不支持清晰度 ${size}，已改用 2K`)
    size = '2K'
  }

  if (referenceCount > MAX_REFERENCE_IMAGES) {
    warnings.push(`最多 ${MAX_REFERENCE_IMAGES} 张参考图，多出的已忽略`)
  }
  if (referenceCount > 0 && provider.supports.edit !== true && provider.supports.references !== true) {
    throw new HubError(`${provider.label} 不支持参考图`)
  }

  return { provider, model: profile.model, ratio, size, warnings }
}

function fetchFor(profile) {
  if (typeof profile.proxy === 'string' && profile.proxy.trim() !== '') return createProxiedFetch(profile.proxy.trim())
  return undefined
}

function requireKey(profile) {
  const provider = getProvider(profile.provider)
  if (provider.needsKey === true && (profile.apiKey === undefined || profile.apiKey.trim() === '')) {
    throw new HubError(`${provider.label} 还没有配置 API Key（设置 → 插件 → 图像中枢）`)
  }
}

// ---------------------------------------------------------------------------
// 执行体
// ---------------------------------------------------------------------------

function createRunner(ctx, getConfig) {
  return async function run({ args, exec, mode, references }) {
    const config = getConfig()
    const profile = resolveProfile(config, args.profile)
    if (profile === undefined) {
      throw new HubError('还没有配置任何图片 API：到 设置 → 插件 → 图像中枢 里添加一套')
    }
    if (profile.enabled === false) throw new HubError(`这套配置已停用：${profile.name}（在「生图配置」里重新启用）`)
    requireKey(profile)
    const normalized = normalizeRequest({
      profile,
      aspectRatio: args.aspect_ratio,
      imageSize: args.image_size,
      referenceCount: references.length,
    })
    const provider = normalized.provider
    if (mode === 'edit' && provider.supports.edit !== true && provider.supports.references !== true) {
      throw new HubError(`${provider.label} 不支持改图`)
    }

    const model = typeof args.model === 'string' && args.model.trim() !== '' ? args.model.trim() : profile.model
    if (typeof model !== 'string' || model === '') throw new HubError('没有指定模型，且这套配置里也没填默认模型')

    const effectiveBaseURL = profile.baseURL || provider.defaultBaseURL
    const fetchImpl = fetchFor(profile)
    const providerCtx = {
      baseURL: effectiveBaseURL,
      ...(fetchImpl === undefined ? {} : { fetchImpl }),
      profile: { ...profile, baseURL: effectiveBaseURL },
      prompt: args.prompt,
      model,
      aspectRatio: normalized.ratio,
      imageSize: normalized.size,
      references: references.slice(0, MAX_REFERENCE_IMAGES),
      timeoutMs: Number(config.timeoutMs ?? 180_000),
      signal: exec?.signal,
    }

    const generated = mode === 'edit' && typeof provider.edit === 'function'
      ? await provider.edit(providerCtx)
      : await provider.generate(providerCtx)

    // 积分：生成前预估（Labnana 官方估算接口），生成后查余额；失败不影响出图
    const credits = {}
    if (typeof provider.estimate === 'function') {
      try {
        const estimate = await provider.estimate(providerCtx)
        if (typeof estimate === 'number') credits.estimated = estimate
      } catch (error) {
        ctx.logger?.warn?.(`dsh-image-hub: 积分预估失败：${String(error?.message ?? error)}`)
      }
    }
    if (typeof provider.usage === 'function') {
      try {
        const usage = await provider.usage(providerCtx)
        if (typeof usage?.remaining === 'number') credits.remaining = usage.remaining
        if (typeof usage?.plan === 'string' && usage.plan !== '') credits.plan = usage.plan
      } catch (error) {
        ctx.logger?.warn?.(`dsh-image-hub: 余额查询失败：${String(error?.message ?? error)}`)
      }
    }

    const attachment = await ctx.attachments.saveImage({
      data: generated.data,
      mediaType: generated.mediaType,
      name: mode === 'edit' ? 'image-hub-edit' : 'image-hub',
    })

    const value = {
      attachment,
      profile: profile.name,
      provider: profile.provider,
      model,
      aspectRatio: normalized.ratio,
      imageSize: normalized.size,
      mode,
      ...(Object.keys(credits).length === 0 ? {} : { credits }),
      ...(generated.modelVersion === undefined ? {} : { modelVersion: generated.modelVersion }),
      ...(normalized.warnings.length === 0 ? {} : { warnings: normalized.warnings }),
    }

    if (config.saveToWorkspace !== false) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      if (typeof workspaceRoot === 'string' && workspaceRoot !== '') {
        try {
          value.savedTo = await saveImageToWorkspace({
            workspaceRoot,
            folder: config.workspaceFolder,
            model,
            mediaType: generated.mediaType,
            data: generated.data,
          })
        } catch (error) {
          ctx.logger?.warn?.(`dsh-image-hub: 保存到工作区失败：${String(error?.message ?? error)}`)
          value.saveError = String(error?.message ?? error)
        }
      }
    }

    remember(ctx, exec, {
      attachment,
      prompt: args.prompt,
      profile: profile.name,
      provider: profile.provider,
      model,
      aspectRatio: normalized.ratio,
      imageSize: normalized.size,
      mode,
      credits,
      savedTo: value.savedTo,
    })
    return value
  }
}

// ---------------------------------------------------------------------------
// 会话内的生成记录（画廊）
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 200
const historyBySession = new Map()

/** 会话标识：优先 header.id，退而用工作目录兜底。 */
function sessionKey(exec) {
  const session = exec?.agent?.session
  const id = session?.header?.id ?? session?.id
  if (typeof id === 'string' && id !== '') return id
  const cwd = session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? `cwd:${cwd}` : 'unknown'
}

function galleryPath() {
  return path.join(dshHome(), 'image-hub', 'gallery.jsonl')
}

/** 启动时把磁盘上的记录读回内存（按会话分组）。 */
export async function loadGallery() {
  let text
  try {
    text = await readFile(galleryPath(), 'utf8')
  } catch {
    return
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      if (typeof record.sessionKey !== 'string') continue
      const list = historyBySession.get(record.sessionKey) ?? []
      list.push(record)
      while (list.length > HISTORY_LIMIT) list.shift()
      historyBySession.set(record.sessionKey, list)
    } catch {
      // 坏行跳过
    }
  }
}

async function persistRecord(record) {
  try {
    await mkdir(path.dirname(galleryPath()), { recursive: true })
    await appendFile(galleryPath(), `${JSON.stringify(record)}\n`, 'utf8')
  } catch {
    // 落盘失败不影响出图
  }
}

function remember(ctx, exec, record) {
  try {
    const key = sessionKey(exec)
    const entry = { ...record, sessionKey: key, at: Date.now() }
    const list = historyBySession.get(key) ?? []
    list.push(entry)
    while (list.length > HISTORY_LIMIT) list.shift()
    historyBySession.set(key, list)
    // 不 await：写盘失败不该拖住生图
    persistRecord(entry)
  } catch (error) {
    ctx.logger?.warn?.(`dsh-image-hub: 记录生成历史失败：${String(error?.message ?? error)}`)
  }
}

function historyOf(exec) {
  return historyBySession.get(sessionKey(exec)) ?? []
}

/** 一句话描述一张图的积分情况。 */
export function creditsLine(credits) {
  if (credits === undefined || credits === null) return ''
  const parts = []
  if (typeof credits.estimated === 'number') parts.push(`本次 ${credits.estimated} 积分`)
  if (typeof credits.remaining === 'number') parts.push(`剩余 ${credits.remaining} 积分`)
  return parts.length === 0 ? '' : `（${parts.join('，')}）`
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function outputSchema(verb) {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        attachment: { type: 'object' },
        profile: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        aspectRatio: { type: 'string' },
        imageSize: { type: 'string' },
        mode: { type: 'string' },
        savedTo: { type: 'string' },
        credits: { type: 'object' },
      },
    },
    render(_args, value) {
      const saved = typeof value.savedTo === 'string'
        ? ` 已保存到 ${value.savedTo}。`
        : typeof value.saveError === 'string' ? ` 保存失败：${value.saveError}。` : ''
      const notes = Array.isArray(value.warnings) && value.warnings.length > 0 ? ` 注意：${value.warnings.join('；')}。` : ''
      return [
        {
          type: 'text',
          text: `${verb}一张图：${value.profile}（${value.provider}）/ ${value.model}，${value.aspectRatio} · ${value.imageSize}`
            + `${creditsLine(value.credits)}。`
            + `图片已作为附件 ${value.attachment.attachmentId} 附在本条消息里，直接回复用户，不要再去读文件。${saved}${notes}`,
        },
        { type: 'image', attachment: value.attachment },
      ]
    },
    presentationMeta(args, value) {
      return {
        kind: 'dsh-image-hub',
        attachmentId: value.attachment?.attachmentId,
        provider: value.provider,
        model: value.model,
        prompt: args.prompt,
        savedTo: value.savedTo,
      }
    },
  }
}

function imagePresentation(result) {
  const meta = result?.meta
  if (meta === null || typeof meta !== 'object') return undefined
  if (meta.attachment === null || typeof meta.attachment !== 'object') return undefined
  return {
    card: 'generic',
    title: `Image Hub · ${meta.model ?? ''}`.trim(),
    content: [{ type: 'image', attachment: meta.attachment }],
  }
}

function registerTools(ctx, getConfig) {
  const run = createRunner(ctx, getConfig)

  const resolveReferences = async (args, exec, { fallback }) => {
    const ids = Array.isArray(args.source_attachment_ids)
      ? args.source_attachment_ids
      : typeof args.source_attachment_id === 'string' && args.source_attachment_id !== ''
        ? [args.source_attachment_id]
        : undefined
    const paths = Array.isArray(args.source_paths)
      ? args.source_paths
      : typeof args.source_path === 'string' && args.source_path !== ''
        ? [args.source_path]
        : undefined
    if (ids !== undefined && paths !== undefined) throw new HubError('source_attachment_ids 与 source_paths 只能给一组')
    if (paths !== undefined) {
      const workspaceRoot = exec?.agent?.session?.header?.cwd
      return Promise.all(paths.map((sourcePath) => readWorkspaceImage(sourcePath, workspaceRoot, { signal: exec?.signal })))
    }
    if (ids === undefined && fallback === false) return []
    const session = exec?.agent?.session
    const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
    const refs = findReferenceImages(messages, ids)
    if (refs.length === 0) {
      if (ids === undefined) return []
      throw new HubError('当前会话里没有找到可用的图片附件')
    }
    return Promise.all(refs.map(async (ref) => {
      const stored = await ctx.attachments.readImage(ref, exec?.signal)
      return { data: stored.data, mediaType: stored.ref?.mediaType ?? 'image/png' }
    }))
  }

  const commonProps = {
    prompt: { type: 'string', description: '完整描述。' },
    profile: { type: 'string', description: '可选：用哪套 API 配置（填名称或 id），默认用当前激活的那套。' },
    model: { type: 'string', description: '可选：本次覆盖模型名。' },
    aspect_ratio: { type: 'string', enum: RATIOS, description: '可选：画面比例。' },
    image_size: { type: 'string', enum: SIZES, description: '可选：清晰度档位。' },
    source_attachment_ids: { type: 'array', items: { type: 'string' }, description: '可选：会话里的参考图附件 id。' },
    source_paths: { type: 'array', items: { type: 'string' }, description: '可选：工作区内的参考图路径。' },
  }

  const addTool = (tool) => {
    try {
      ctx.tools.register(tool)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-image-hub: 工具 ${tool.name} 注册失败：${String(error?.message ?? error)}`)
      console.warn(`[dsh-image-hub] 工具 ${tool.name} 注册失败：${String(error?.message ?? error)}`)
    }
  }

  addTool({
    name: 'image_generate',
    description: 'Generate an image through the configured image API (Labnana / OpenAI-compatible / Gemini / Seedream / DashScope / ComfyUI) and attach it to the conversation.',
    parameters: { type: 'object', additionalProperties: false, properties: commonProps, required: ['prompt'] },
    output: outputSchema('Generated'),
    presentResult: (_args, result) => imagePresentation(result),
    async execute(args, exec) {
      const references = await resolveReferences(args, exec, { fallback: false })
      return run({ args, exec, mode: references.length > 0 ? 'edit' : 'generate', references })
    },
  })

  addTool({
    name: 'image_edit',
    description: 'Edit an image from the conversation (or a workspace file) through the configured image API; defaults to the newest image in the conversation.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...commonProps,
        source_attachment_id: { type: 'string', description: '可选：单张参考图附件 id。' },
        source_path: { type: 'string', description: '可选：工作区内单张图片路径。' },
      },
      required: ['prompt'],
    },
    output: outputSchema('Edited'),
    presentResult: (_args, result) => imagePresentation(result),
    async execute(args, exec) {
      const references = await resolveReferences(args, exec, { fallback: true })
      if (references.length === 0) throw new HubError('改图需要一张参考图：先上传一张，或先用 image_generate 生成一张')
      return run({ args, exec, mode: 'edit', references })
    },
  })

  addTool({
    name: 'image_gallery',
    description: 'Show every image generated in this conversation, newest first, with its prompt, model and credit usage. Use when the user asks to see the gallery / all generated images.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 30, description: '最多列几张（默认 12）。' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          count: { type: 'integer' },
          items: { type: 'array' },
        },
      },
      render(_args, value) {
        const items = Array.isArray(value.items) ? value.items : []
        if (items.length === 0) {
          return [{ type: 'text', text: '这次对话里还没有生成过图片。用 image_generate 画一张后，画廊就会有记录。' }]
        }
        const lines = items.map((item, index) => {
          const when = new Date(item.at ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false })
          const credits = creditsLine(item.credits)
          return `${index + 1}. ${when} · ${item.profile} / ${item.model} · ${item.aspectRatio} ${item.imageSize}${credits}`
            + `\n   prompt：${String(item.prompt ?? '').slice(0, 160)}`
        })
        const content = [{ type: 'text', text: `这次对话共生成 ${items.length} 张图（新的在前）：\n${lines.join('\n')}` }]
        for (const item of items) {
          if (item.attachment !== undefined) content.push({ type: 'image', attachment: item.attachment })
        }
        return content
      },
    },
    async execute(args, exec) {
      const limit = Math.min(Math.max(Number(args.limit ?? 12) || 12, 1), 30)
      const all = historyOf(exec)
      const items = all.slice(-limit).reverse()
      return { count: all.length, items }
    },
  })
}

// ---------------------------------------------------------------------------
// 同源 HTTP API（设置页）
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  res.end(text)
}

function readBody(req, limitBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        req.destroy()
        reject(new Error('请求体过大'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function maskKey(key) {
  if (typeof key !== 'string' || key === '') return ''
  if (key.length <= 10) return '****'
  return `${key.slice(0, 4)}…${key.slice(-4)}`
}

function publicConfig(config) {
  return {
    activeProfile: config.activeProfile ?? '',
    saveToWorkspace: config.saveToWorkspace !== false,
    workspaceFolder: config.workspaceFolder ?? '',
    timeoutMs: config.timeoutMs ?? 180_000,
    profiles: (config.profiles ?? []).map((profile) => ({
      id: profile.id,
      provider: profile.provider,
      name: profile.name,
      baseURL: profile.baseURL,
      model: profile.model,
      models: profile.models ?? [],
      aspectRatio: profile.aspectRatio ?? '',
      imageSize: profile.imageSize ?? '',
      proxy: profile.proxy ?? '',
      enabled: profile.enabled !== false,
      keyHint: maskKey(profile.apiKey),
      hasKey: typeof profile.apiKey === 'string' && profile.apiKey !== '',
      extra: profile.extra ?? {},
    })),
  }
}

function registerRoutes(ctx, getConfig, save) {
  ctx.webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const route = (req.url ?? '').split('?')[0].slice(API_PREFIX.length) || '/'
      try {
        if (route === '/state' && req.method === 'GET') {
          return sendJson(res, 200, { config: publicConfig(getConfig()), providers: providerCatalog() })
        }

        if (route === '/config' && req.method === 'POST') {
          const body = await readBody(req)
          const current = getConfig()
          const next = {
            activeProfile: typeof body.activeProfile === 'string' ? body.activeProfile : current.activeProfile,
            saveToWorkspace: typeof body.saveToWorkspace === 'boolean' ? body.saveToWorkspace : current.saveToWorkspace,
            workspaceFolder: typeof body.workspaceFolder === 'string' && body.workspaceFolder.trim() !== ''
              ? body.workspaceFolder.trim()
              : current.workspaceFolder,
            timeoutMs: Number(body.timeoutMs ?? current.timeoutMs ?? 180_000),
            profiles: [],
          }
          const incoming = Array.isArray(body.profiles) ? body.profiles : []
          for (const raw of incoming) {
            if (!isUsableProfile(raw)) continue
            const existing = current.profiles.find((p) => p.id === raw.id)
            const profile = normalizeProfile(raw)
            // 空 apiKey 表示「不改」，沿用已存的
            if ((profile.apiKey === '' || profile.apiKey === undefined) && existing !== undefined) profile.apiKey = existing.apiKey
            next.profiles.push(profile)
          }
          await save(next)
          return sendJson(res, 200, { ok: true, config: publicConfig(next), providers: providerCatalog() })
        }

        // 只保存/删除一套配置（卡片上的「保存」「删除」）
        if (route === '/profile' && req.method === 'POST') {
          const body = await readBody(req)
          const current = getConfig()
          const incoming = body.profile
          if (!isUsableProfile(incoming)) return sendJson(res, 400, { error: '配置格式不对' })
          const existing = current.profiles.find((p) => p.id === incoming.id)
          const profile = normalizeProfile(incoming)
          // 空 apiKey 表示「不改」，沿用已存的
          if (profile.apiKey === '' && existing !== undefined) profile.apiKey = existing.apiKey
          let profiles
          if (body.remove === true) {
            profiles = current.profiles.filter((p) => p.id !== profile.id)
          } else if (existing !== undefined) {
            profiles = current.profiles.map((p) => (p.id === profile.id ? profile : p))
          } else {
            profiles = current.profiles.concat([profile])
          }
          const next = { ...current, profiles }
          if ((next.activeProfile === '' || next.activeProfile === profile.id) && profiles.length > 0) {
            next.activeProfile = profiles[0].id
          }
          await save(next)
          return sendJson(res, 200, { ok: true, config: publicConfig(next), providers: providerCatalog() })
        }

        // 启用/停用一套配置
        if (route === '/profile/toggle' && req.method === 'POST') {
          const body = await readBody(req)
          const current = getConfig()
          const id = typeof body.id === 'string' ? body.id : ''
          if (id === '') return sendJson(res, 400, { error: '缺少配置 id' })
          const next = {
            ...current,
            profiles: current.profiles.map((p) => (p.id === id ? { ...p, enabled: body.enabled !== false } : p)),
          }
          await save(next)
          return sendJson(res, 200, { ok: true, config: publicConfig(next), providers: providerCatalog() })
        }

        if (route === '/credits' && req.method === 'POST') {
          const body = await readBody(req)
          const config = getConfig()
          const profile = resolveProfile(config, body.profileId)
          if (profile === undefined) return sendJson(res, 200, { ok: false, error: '没有找到这套配置' })
          const provider = PROVIDERS[profile.provider]
          if (typeof provider?.usage !== 'function') {
            return sendJson(res, 200, { ok: false, error: `${provider?.label ?? '该接口'} 没有积分概念` })
          }
          try {
            const usage = await provider.usage({
              profile: { ...profile, baseURL: profile.baseURL || provider.defaultBaseURL },
              ...(fetchFor(profile) === undefined ? {} : { fetchImpl: fetchFor(profile) }),
              signal: AbortSignal.timeout(20_000),
            })
            return sendJson(res, 200, { ok: true, ...usage })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
          }
        }

        if (route === '/test' && req.method === 'POST') {
          const body = await readBody(req)
          const config = getConfig()
          const profile = resolveProfile(config, body.profileId)
          if (profile === undefined) return sendJson(res, 200, { ok: false, error: '没有找到这套配置' })
          const provider = PROVIDERS[profile.provider]
          if (provider === undefined) return sendJson(res, 200, { ok: false, error: `未知 provider：${profile.provider}` })
          try {
            if (provider.needsKey === true && (profile.apiKey ?? '') === '') {
              return sendJson(res, 200, { ok: false, error: '这套配置还没有填 API Key' })
            }
            const result = await provider.test({
              profile: { ...profile, baseURL: profile.baseURL || provider.defaultBaseURL },
              ...(fetchFor(profile) === undefined ? {} : { fetchImpl: fetchFor(profile) }),
              signal: AbortSignal.timeout(30_000),
            })
            return sendJson(res, 200, { ok: true, detail: result?.detail ?? '连接正常' })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
          }
        }

        if (route === '/models' && req.method === 'POST') {
          const body = await readBody(req)
          const config = getConfig()
          const profile = resolveProfile(config, body.profileId)
          if (profile === undefined) return sendJson(res, 200, { ok: false, error: '没有找到这套配置' })
          const provider = PROVIDERS[profile.provider]
          if (provider?.supports?.listModels !== true) {
            return sendJson(res, 200, { ok: false, error: `${provider?.label ?? '该 provider'} 不支持拉取模型列表` })
          }
          try {
            const models = await provider.listModels({
              profile: { ...profile, baseURL: profile.baseURL || provider.defaultBaseURL },
              ...(fetchFor(profile) === undefined ? {} : { fetchImpl: fetchFor(profile) }),
              signal: AbortSignal.timeout(30_000),
            })
            return sendJson(res, 200, { ok: true, models })
          } catch (error) {
            return sendJson(res, 200, { ok: false, error: String(error?.message ?? error) })
          }
        }

        return sendJson(res, 404, { error: `未知接口：${route}` })
      } catch (error) {
        const status = typeof error?.status === 'number' && error.status >= 400 ? error.status : 500
        return sendJson(res, status, { error: String(error?.message ?? error) })
      }
    },
  })
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

export async function apply(ctx) {
  await loadGallery()
  let config = await loadConfig()
  if (config.timeoutMs === undefined) config.timeoutMs = 180_000
  const getConfig = () => config
  const save = async (next) => {
    config = next
    await saveConfig(next)
  }

  registerTools(ctx, getConfig)

  if (ctx.webServer !== undefined) {
    try {
      registerRoutes(ctx, getConfig, save)
    } catch (error) {
      ctx.logger?.warn?.(`dsh-image-hub: 设置接口注册失败：${String(error?.message ?? error)}`)
    }
  }

  ctx.logger?.info?.(`dsh-image-hub 已加载：${config.profiles.length} 套配置`)
}

/** 仅供测试。 */
export const __internal = { sizeString, pixelsFor, normalizeRequest }
