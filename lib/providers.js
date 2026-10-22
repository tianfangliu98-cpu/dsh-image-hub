/**
 * Provider 适配层。
 *
 * 每个 provider 只做一件事：把「一次生图请求」翻译成自己的 HTTP 协议，
 * 再把响应统一成 { data, mediaType, modelVersion? }。
 *
 * 统一入参（ctx）：
 *   profile      { baseURL, apiKey, model, extra }
 *   prompt / model / aspectRatio / imageSize
 *   references   [{ data, mediaType }]  参考图（可能为空）
 *   signal / timeoutMs / fetchImpl
 */

import { HubError, fetchImageBytes, requestJson, sniffMediaType } from './core.js'

// ---------------------------------------------------------------------------
// 公共工具
// ---------------------------------------------------------------------------

const SIZE_TABLE = {
  '1:1': { '1K': [1024, 1024], '2K': [2048, 2048], '4K': [3840, 3840] },
  '3:2': { '1K': [1536, 1024], '2K': [3072, 2048], '4K': [4608, 3072] },
  '2:3': { '1K': [1024, 1536], '2K': [2048, 3072], '4K': [3072, 4608] },
  '4:3': { '1K': [1024, 768], '2K': [2048, 1536], '4K': [4096, 3072] },
  '3:4': { '1K': [768, 1024], '2K': [1536, 2048], '4K': [3072, 4096] },
  '4:5': { '1K': [1024, 1280], '2K': [2048, 2560], '4K': [3072, 3840] },
  '5:4': { '1K': [1280, 1024], '2K': [2560, 2048], '4K': [3840, 3072] },
  '16:9': { '1K': [1280, 720], '2K': [2560, 1440], '4K': [3840, 2160] },
  '9:16': { '1K': [720, 1280], '2K': [1440, 2560], '4K': [2160, 3840] },
  '21:9': { '1K': [1400, 600], '2K': [2800, 1200], '4K': [5040, 2160] },
}

export const RATIOS = Object.keys(SIZE_TABLE)

/** 给界面看的中文说明。 */
export const RATIO_LABELS = {
  '1:1': '方形',
  '2:3': '照片',
  '3:2': '横版照片',
  '3:4': '竖版海报',
  '4:3': '传统横版',
  '4:5': '大画幅',
  '5:4': '横版大画幅',
  '9:16': '竖版',
  '16:9': '横版',
  '21:9': '超宽屏',
}
export const SIZES = ['1K', '2K', '4K']

/** 比例 + 档位 → 像素。未知组合退回 1:1 / 2K。 */
export function pixelsFor(aspectRatio, imageSize) {
  const ratio = SIZE_TABLE[aspectRatio] ?? SIZE_TABLE['1:1']
  return ratio[imageSize] ?? ratio['2K'] ?? ratio['1K']
}

export function sizeString(aspectRatio, imageSize) {
  const [width, height] = pixelsFor(aspectRatio, imageSize)
  return `${width}x${height}`
}

function dataUrl(reference) {
  return `data:${reference.mediaType};base64,${Buffer.from(reference.data).toString('base64')}`
}

function b64ToBytes(value) {
  return Buffer.from(value, 'base64')
}

/** 统一从「候选 part 列表」里挑第一张图。 */
function firstInlineImage(parts) {
  for (const part of Array.isArray(parts) ? parts : []) {
    const inline = part?.inlineData ?? part?.inline_data
    if (typeof inline?.data === 'string' && inline.data !== '') {
      return { data: b64ToBytes(inline.data), mediaType: inline.mimeType ?? inline.mime_type ?? 'image/png' }
    }
  }
  return undefined
}

/** 统一从 OpenAI 风格 data[] 里取第一张（b64 或 url）。 */
async function firstOpenAIImage(payload, ctx) {
  const item = Array.isArray(payload?.data) ? payload.data[0] : undefined
  if (item === undefined) throw new HubError('上游没有返回图片数据')
  if (typeof item.b64_json === 'string' && item.b64_json !== '') {
    const data = b64ToBytes(item.b64_json)
    return { data, mediaType: sniffMediaType(data) ?? 'image/png' }
  }
  if (typeof item.url === 'string' && item.url !== '') {
    return fetchImageBytes(item.url, { signal: ctx.signal, fetchImpl: ctx.fetchImpl })
  }
  throw new HubError('上游返回的图片既没有 b64_json 也没有 url')
}

function baseOf(ctx) {
  const value = ctx.baseURL || ctx.profile?.baseURL || ''
  if (typeof value !== 'string' || value === '') throw new HubError('这套配置没有填接口地址')
  return value.replace(/\/+$/, '')
}

function bearerAuth(ctx) {
  return { authorization: `Bearer ${ctx.profile.apiKey}` }
}

// ---------------------------------------------------------------------------
// Labnana 原生
// ---------------------------------------------------------------------------

const LABNANA_MODELS = [
  'gemini-3.1-flash-image',
  'gemini-3-pro-image',
  'gpt-image-2',
  'gpt-image-2.5-flare',
  'gpt-image-2.5-sunburst',
  'wan2.7-image',
  'wan2.7-image-pro',
  'seedream-5-0-pro',
]

function labnanaChannel(model) {
  if (model.startsWith('gemini')) return 'google'
  if (model.startsWith('gpt-image')) return 'openai'
  if (model.startsWith('wan')) return 'alibaba'
  if (model.startsWith('seedream')) return 'bytedance'
  return 'google'
}

export const labnana = {
  id: 'labnana',
  label: 'Labnana（火星电波）',
  defaultBaseURL: 'https://api.labnana.com',
  needsKey: true,
  supports: { generate: true, edit: true, references: true, listModels: true, test: true },
  models: LABNANA_MODELS,

  async generate(ctx) {
    const body = {
      provider: labnanaChannel(ctx.model),
      model: ctx.model,
      prompt: ctx.prompt,
      ...(ctx.references.length > 0
        ? { referenceImages: ctx.references.map((r) => ({ inlineData: { mimeType: r.mediaType, data: Buffer.from(r.data).toString('base64') } })) }
        : {}),
      imageConfig: { aspectRatio: ctx.aspectRatio, imageSize: ctx.imageSize },
    }
    const payload = await requestJson(`${baseOf(ctx)}/openapi/v1/images/generation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearerAuth(ctx) },
      body,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    })
    const image = firstInlineImage(payload?.candidates?.[0]?.content?.parts)
    if (image === undefined) throw new HubError('Labnana 返回里没有图片数据', { body: JSON.stringify(payload).slice(0, 800) })
    return { ...image, modelVersion: payload?.modelVersion }
  },

  async listModels() {
    return LABNANA_MODELS
  },

  async test(ctx) {
    const payload = await requestJson(`${baseOf(ctx)}/openapi/v1/user/subscription`, {
      headers: bearerAuth(ctx),
      signal: ctx.signal,
      timeoutMs: 20_000,
      fetchImpl: ctx.fetchImpl,
    })
    const data = payload?.data ?? {}
    return {
      detail: `订阅 ${data?.subscriptionPlan?.name ?? '无'}，剩余 ${data?.totalAvailableCredits ?? 0} 积分`,
    }
  },

  /** 生成前预估本次消耗（官方估算接口，不扣费）。 */
  async estimate(ctx) {
    const payload = await requestJson(`${baseOf(ctx)}/openapi/v1/images/generation/estimate-credits`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearerAuth(ctx) },
      body: {
        provider: labnanaChannel(ctx.model),
        model: ctx.model,
        prompt: ctx.prompt,
        imageConfig: { aspectRatio: ctx.aspectRatio, imageSize: ctx.imageSize },
      },
      signal: ctx.signal,
      timeoutMs: 20_000,
      fetchImpl: ctx.fetchImpl,
    })
    const credits = payload?.data?.credits
    return typeof credits === 'number' ? credits : undefined
  },

  /** 生成后查余额（返回账户剩余积分）。 */
  async usage(ctx) {
    const payload = await requestJson(`${baseOf(ctx)}/openapi/v1/user/subscription`, {
      headers: bearerAuth(ctx),
      signal: ctx.signal,
      timeoutMs: 20_000,
      fetchImpl: ctx.fetchImpl,
    })
    const data = payload?.data ?? {}
    return {
      remaining: typeof data.totalAvailableCredits === 'number' ? data.totalAvailableCredits : undefined,
      plan: data?.subscriptionPlan?.name ?? '',
      monthly: data?.usageAvailableMonthlyCredits,
      permanent: data?.usageAvailablePermanentCredits,
    }
  },
}

// ---------------------------------------------------------------------------
// OpenAI 兼容（官方 / 中转站 / xAI / 智谱 等）
// ---------------------------------------------------------------------------

export const openaiCompatible = {
  id: 'openai-compatible',
  label: 'OpenAI 兼容（官方/中转站）',
  defaultBaseURL: 'https://api.openai.com/v1',
  needsKey: true,
  supports: { generate: true, edit: true, references: true, listModels: true, test: true },
  models: ['gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'],

  async generate(ctx) {
    const payload = await requestJson(`${baseOf(ctx)}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearerAuth(ctx) },
      body: { model: ctx.model, prompt: ctx.prompt, size: sizeString(ctx.aspectRatio, ctx.imageSize), n: 1 },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    })
    return firstOpenAIImage(payload, ctx)
  },

  async edit(ctx) {
    const form = new FormData()
    const multiple = ctx.references.length > 1
    ctx.references.forEach((reference, index) => {
      const blob = new Blob([reference.data], { type: reference.mediaType })
      form.append(multiple ? 'image[]' : 'image', blob, `reference-${index + 1}.png`)
    })
    form.append('model', ctx.model)
    form.append('prompt', ctx.prompt)
    form.append('size', sizeString(ctx.aspectRatio, ctx.imageSize))
    const payload = await requestJson(`${baseOf(ctx)}/images/edits`, {
      method: 'POST',
      headers: bearerAuth(ctx),
      body: form,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    })
    return firstOpenAIImage(payload, ctx)
  },

  async listModels(ctx) {
    const payload = await requestJson(`${baseOf(ctx)}/models`, {
      headers: bearerAuth(ctx),
      signal: ctx.signal,
      timeoutMs: 20_000,
      fetchImpl: ctx.fetchImpl,
    })
    const ids = Array.isArray(payload?.data) ? payload.data.map((item) => item?.id).filter((id) => typeof id === 'string') : []
    const images = ids.filter((id) => /image|imagen|dall-e|flux|seedream|sd|qwen|wan|kolors/i.test(id))
    return images.length > 0 ? images : ids
  },

  async test(ctx) {
    const models = await openaiCompatible.listModels(ctx)
    return { detail: `可用模型 ${models.length} 个` }
  },
}

// ---------------------------------------------------------------------------
// Gemini 原生 generateContent
// ---------------------------------------------------------------------------

export const gemini = {
  id: 'gemini',
  label: 'Google Gemini（原生）',
  defaultBaseURL: 'https://generativelanguage.googleapis.com/v1beta',
  needsKey: true,
  supports: { generate: true, edit: true, references: true, listModels: true, test: true },
  models: ['gemini-2.5-flash-image', 'gemini-3-pro-image-preview', 'gemini-3.1-flash-image'],

  async generate(ctx) {
    const url = `${baseOf(ctx)}/models/${encodeURIComponent(ctx.model)}:generateContent?key=${encodeURIComponent(ctx.profile.apiKey)}`
    const parts = [{ text: ctx.prompt }]
    for (const reference of ctx.references) {
      parts.push({ inline_data: { mime_type: reference.mediaType, data: Buffer.from(reference.data).toString('base64') } })
    }
    const payload = await requestJson(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: {
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          imageConfig: { aspectRatio: ctx.aspectRatio, imageSize: ctx.imageSize },
        },
      },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    })
    const image = firstInlineImage(payload?.candidates?.[0]?.content?.parts)
    if (image === undefined) {
      const blocked = payload?.promptFeedback?.blockReason ?? payload?.candidates?.[0]?.finishReason
      throw new HubError(`Gemini 没有返回图片${blocked === undefined ? '' : `（${blocked}）`}`)
    }
    return { ...image, modelVersion: payload?.modelVersion }
  },

  async listModels(ctx) {
    const payload = await requestJson(`${baseOf(ctx)}/models?key=${encodeURIComponent(ctx.profile.apiKey)}`, {
      signal: ctx.signal,
      timeoutMs: 20_000,
      fetchImpl: ctx.fetchImpl,
    })
    const ids = Array.isArray(payload?.models)
      ? payload.models.map((item) => String(item?.name ?? '').replace(/^models\//, '')).filter((id) => /image|imagen/i.test(id))
      : []
    return ids
  },

  async test(ctx) {
    const models = await gemini.listModels(ctx)
    return { detail: `可用图片模型 ${models.length} 个` }
  },
}

// ---------------------------------------------------------------------------
// Seedream / 火山方舟
// ---------------------------------------------------------------------------

export const seedream = {
  id: 'seedream',
  label: 'Seedream（火山方舟）',
  defaultBaseURL: 'https://ark.cn-beijing.volces.com/api/v3',
  needsKey: true,
  supports: { generate: true, edit: true, references: true, listModels: false, test: true },
  models: ['doubao-seedream-4-0-250828', 'doubao-seedream-3-0-t2i-250415'],

  async generate(ctx) {
    const payload = await requestJson(`${baseOf(ctx)}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearerAuth(ctx) },
      body: {
        model: ctx.model,
        prompt: ctx.prompt,
        size: sizeString(ctx.aspectRatio, ctx.imageSize),
        response_format: 'url',
        watermark: false,
      },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    })
    return firstOpenAIImage(payload, ctx)
  },

  async edit(ctx) {
    const form = new FormData()
    ctx.references.forEach((reference, index) => {
      const blob = new Blob([reference.data], { type: reference.mediaType })
      form.append('image', blob, `reference-${index + 1}.png`)
    })
    form.append('model', ctx.model)
    form.append('prompt', ctx.prompt)
    form.append('response_format', 'url')
    form.append('watermark', 'false')
    const payload = await requestJson(`${baseOf(ctx)}/images/edits`, {
      method: 'POST',
      headers: bearerAuth(ctx),
      body: form,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    })
    return firstOpenAIImage(payload, ctx)
  },

  async test(ctx) {
    // Ark 没有统一的图片模型列表；用一个极小的生成请求探活代价太高，改成校验 Key 结构
    if (ctx.profile.apiKey === '') throw new HubError('没有配置 API Key')
    return { detail: '已配置 Key（Ark 无模型列表接口，直接生成即可验证）' }
  },
}

// ---------------------------------------------------------------------------
// DashScope（通义万相 / Qwen-Image）
// ---------------------------------------------------------------------------

export const dashscope = {
  id: 'dashscope',
  label: 'DashScope（通义万相）',
  defaultBaseURL: 'https://dashscope.aliyuncs.com/api/v1',
  needsKey: true,
  supports: { generate: true, edit: true, references: true, listModels: false, test: true },
  models: ['qwen-image-plus', 'qwen-image', 'wanx2.1-t2i-turbo'],

  async generate(ctx) {
    const [width, height] = pixelsFor(ctx.aspectRatio, ctx.imageSize)
    const content = []
    for (const reference of ctx.references) content.push({ image: dataUrl(reference) })
    content.push({ text: ctx.prompt })
    const payload = await requestJson(`${baseOf(ctx)}/services/aigc/multimodal-generation/generation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearerAuth(ctx) },
      body: {
        model: ctx.model,
        input: { messages: [{ role: 'user', content }] },
        parameters: { size: `${width}*${height}`, n: 1, prompt_extend: true, watermark: false },
      },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    })
    const items = payload?.output?.choices?.[0]?.message?.content
    const url = Array.isArray(items) ? items.map((item) => item?.image).find((value) => typeof value === 'string' && value !== '') : undefined
    if (url === undefined) throw new HubError('DashScope 返回里没有图片地址', { body: JSON.stringify(payload).slice(0, 800) })
    return fetchImageBytes(url, { signal: ctx.signal, fetchImpl: ctx.fetchImpl })
  },

  async test(ctx) {
    if (ctx.profile.apiKey === '') throw new HubError('没有配置 API Key')
    return { detail: '已配置 Key（DashScope 无公开模型列表，直接生成即可验证）' }
  },
}

// ---------------------------------------------------------------------------
// 本地 ComfyUI
// ---------------------------------------------------------------------------

export const comfyui = {
  id: 'comfyui',
  label: '本地 ComfyUI',
  defaultBaseURL: 'http://127.0.0.1:8188',
  needsKey: false,
  supports: { generate: true, edit: false, references: false, listModels: false, test: true },
  models: [],
  needsWorkflow: true,

  async generate(ctx) {
    const workflowText = typeof ctx.profile.extra?.workflow === 'string' ? ctx.profile.extra.workflow : ''
    if (workflowText.trim() === '') throw new HubError('ComfyUI 需要在设置里导入 API 格式的工作流 JSON')
    let workflow
    try {
      workflow = JSON.parse(workflowText)
    } catch {
      throw new HubError('工作流不是合法 JSON')
    }
    const [width, height] = pixelsFor(ctx.aspectRatio, ctx.imageSize)
    const seed = Number(ctx.profile.extra?.seed ?? Math.floor(Math.random() * 1e9))
    const filled = JSON.parse(
      JSON.stringify(workflow)
        .replaceAll('{{prompt}}', JSON.stringify(ctx.prompt).slice(1, -1))
        .replaceAll('{{negative}}', JSON.stringify(String(ctx.profile.extra?.negative ?? '')).slice(1, -1))
        .replaceAll('{{width}}', String(width))
        .replaceAll('{{height}}', String(height))
        .replaceAll('{{seed}}', String(seed)),
    )

    const queued = await requestJson(`${baseOf(ctx)}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { prompt: filled, client_id: `dsh-image-hub-${process.pid}` },
      signal: ctx.signal,
      timeoutMs: 30_000,
      fetchImpl: ctx.fetchImpl,
    })
    const promptId = queued?.prompt_id
    if (typeof promptId !== 'string') throw new HubError('ComfyUI 没有返回 prompt_id')

    const deadline = Date.now() + ctx.timeoutMs
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const history = await requestJson(`${baseOf(ctx)}/history/${promptId}`, { signal: ctx.signal, fetchImpl: ctx.fetchImpl })
      const entry = history?.[promptId]
      if (entry === undefined) continue
      const outputs = entry?.outputs ?? {}
      for (const node of Object.values(outputs)) {
        const image = Array.isArray(node?.images) ? node.images[0] : undefined
        if (image?.filename !== undefined) {
          const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' })
          return fetchImageBytes(`${baseOf(ctx)}/view?${query.toString()}`, { signal: ctx.signal, fetchImpl: ctx.fetchImpl })
        }
      }
      if (entry?.status?.completed === false) continue
    }
    throw new HubError('ComfyUI 生成超时')
  },

  async test(ctx) {
    const stats = await requestJson(`${baseOf(ctx)}/system_stats`, { signal: ctx.signal, timeoutMs: 8000, fetchImpl: ctx.fetchImpl })
    return { detail: `ComfyUI 在线（${stats?.system?.comfyui_version ?? 'unknown'}）` }
  },
}

// ---------------------------------------------------------------------------
// OpenAI 官方（与「兼容」同一套协议，只是默认地址与模型不同）
// ---------------------------------------------------------------------------

export const openaiOfficial = {
  ...openaiCompatible,
  id: 'openai',
  label: 'OpenAI（官方）',
  defaultBaseURL: 'https://api.openai.com/v1',
  models: ['gpt-image-2', 'gpt-image-1', 'gpt-image-1-mini', 'dall-e-3'],
}

// ---------------------------------------------------------------------------
// xAI Grok Imagine（OpenAI 形状，比例/清晰度走自己的字段）
// ---------------------------------------------------------------------------

export const xai = {
  id: 'xai',
  label: 'xAI Grok Imagine',
  defaultBaseURL: 'https://api.x.ai/v1',
  needsKey: true,
  supports: { generate: true, edit: false, references: false, listModels: true, test: true },
  models: ['grok-imagine-image', 'grok-imagine-image-2.0'],

  async generate(ctx) {
    const payload = await requestJson(`${baseOf(ctx)}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearerAuth(ctx) },
      body: {
        model: ctx.model,
        prompt: ctx.prompt,
        aspect_ratio: ctx.aspectRatio,
        resolution: ctx.imageSize,
      },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    })
    return firstOpenAIImage(payload, ctx)
  },

  async listModels(ctx) {
    const payload = await requestJson(`${baseOf(ctx)}/models`, {
      headers: bearerAuth(ctx),
      signal: ctx.signal,
      timeoutMs: 20_000,
      fetchImpl: ctx.fetchImpl,
    })
    const ids = Array.isArray(payload?.data) ? payload.data.map((item) => item?.id).filter((id) => typeof id === 'string') : []
    const images = ids.filter((id) => /image|grok/i.test(id))
    return images.length > 0 ? images : ids
  },

  async test(ctx) {
    const models = await xai.listModels(ctx)
    return { detail: `可用模型 ${models.length} 个` }
  },
}

// ---------------------------------------------------------------------------
// 智谱 GLM-Image
// ---------------------------------------------------------------------------

export const zhipu = {
  id: 'zhipu',
  label: '智谱 GLM-Image',
  defaultBaseURL: 'https://open.bigmodel.cn/api/paas/v4',
  needsKey: true,
  supports: { generate: true, edit: false, references: false, listModels: false, test: true },
  models: ['glm-image', 'cogview-4', 'cogview-3-flash'],

  async generate(ctx) {
    const payload = await requestJson(`${baseOf(ctx)}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearerAuth(ctx) },
      body: { model: ctx.model, prompt: ctx.prompt, size: sizeString(ctx.aspectRatio, ctx.imageSize) },
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      fetchImpl: ctx.fetchImpl,
    })
    return firstOpenAIImage(payload, ctx)
  },

  async test(ctx) {
    if (ctx.profile.apiKey === '') throw new HubError('没有配置 API Key')
    return { detail: '已配置 Key（智谱无公开图片模型列表，直接生成即可验证）' }
  },
}

// ---------------------------------------------------------------------------
// 订阅通道（占位：能选、能存，但还没有登录流程）
// ---------------------------------------------------------------------------

function subscriptionStub(id, label) {
  return {
    id,
    label,
    defaultBaseURL: '',
    needsKey: false,
    subscription: true,
    supports: { generate: false, edit: false, references: false, listModels: false, test: false },
    models: [],

    async generate() {
      throw new HubError(`${label} 走的是账号登录，不是 API Key；当前版本还没接入登录流程。请先用 API Key 类型的接口（Labnana / OpenAI / Gemini 等）。`)
    },

    async test() {
      return { detail: '订阅通道需要账号登录，当前版本暂未接入' }
    },
  }
}

export const chatgptSubscription = subscriptionStub('chatgpt-sub', 'ChatGPT 订阅（占位）')
export const grokSubscription = subscriptionStub('grok-sub', 'Grok 订阅（占位）')
export const googleSubscription = subscriptionStub('google-sub', 'Google 订阅（占位）')

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

export const PROVIDERS = {
  [labnana.id]: labnana,
  [openaiOfficial.id]: openaiOfficial,
  [openaiCompatible.id]: openaiCompatible,
  [gemini.id]: gemini,
  [seedream.id]: seedream,
  [dashscope.id]: dashscope,
  [xai.id]: xai,
  [zhipu.id]: zhipu,
  [comfyui.id]: comfyui,
  [chatgptSubscription.id]: chatgptSubscription,
  [grokSubscription.id]: grokSubscription,
  [googleSubscription.id]: googleSubscription,
}

export function getProvider(id) {
  const provider = PROVIDERS[id]
  if (provider === undefined) throw new HubError(`未知的 provider：${id}`)
  return provider
}

export function providerList() {
  return Object.values(PROVIDERS)
}

/** 设置页要展示的元信息（不含函数）。 */
export function providerCatalog() {
  return providerList().map((provider) => ({
    id: provider.id,
    label: provider.label,
    defaultBaseURL: provider.defaultBaseURL,
    needsKey: provider.needsKey,
    needsWorkflow: provider.needsWorkflow === true,
    subscription: provider.subscription === true,
    credits: typeof provider.usage === 'function',
    supports: provider.supports,
    models: provider.models,
  }))
}
