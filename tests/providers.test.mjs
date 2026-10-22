import { test } from 'node:test'
import assert from 'node:assert/strict'

import { HubError } from '../lib/core.js'
import { comfyui, dashscope, gemini, getProvider, labnana, openaiCompatible, seedream, xai, zhipu } from '../lib/providers.js'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stub(handler) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init })
    return handler(String(url), init ?? {})
  }
  fetchImpl.calls = calls
  return fetchImpl
}

function baseCtx(overrides = {}) {
  return {
    profile: { id: 'p1', provider: 'labnana', baseURL: '', apiKey: 'lh_test', model: 'gemini-3.1-flash-image' },
    prompt: 'a red cube',
    model: 'gemini-3.1-flash-image',
    aspectRatio: '16:9',
    imageSize: '2K',
    references: [],
    timeoutMs: 5000,
    ...overrides,
  }
}

test('labnana sends its own contract and decodes inlineData', async () => {
  const fetchImpl = stub(() => jsonResponse({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }],
    modelVersion: 'gemini-3.1-flash-image',
  }))
  const result = await labnana.generate(baseCtx({ baseURL: 'https://api.labnana.com', fetchImpl }))

  const call = fetchImpl.calls[0]
  assert.equal(call.url, 'https://api.labnana.com/openapi/v1/images/generation')
  assert.equal(call.init.headers.authorization, 'Bearer lh_test')
  const body = JSON.parse(call.init.body)
  assert.equal(body.provider, 'google')
  assert.deepEqual(body.imageConfig, { aspectRatio: '16:9', imageSize: '2K' })
  assert.equal(result.mediaType, 'image/png')
  assert.ok(result.data.length > 0)
  assert.equal(result.modelVersion, 'gemini-3.1-flash-image')
})

test('labnana maps gpt-image models to the openai channel', async () => {
  const fetchImpl = stub(() => jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }] }))
  await labnana.generate(baseCtx({ baseURL: 'https://api.labnana.com', model: 'gpt-image-2', fetchImpl }))
  assert.equal(JSON.parse(fetchImpl.calls[0].init.body).provider, 'openai')
})

test('labnana test reports the subscription credits', async () => {
  const fetchImpl = stub(() => jsonResponse({ code: 0, data: { totalAvailableCredits: 42, subscriptionPlan: { name: 'pro' } } }))
  const result = await labnana.test({ profile: { baseURL: 'https://api.labnana.com', apiKey: 'lh_test' }, fetchImpl })
  assert.match(result.detail, /pro/)
  assert.match(result.detail, /42/)
})

test('openai-compatible handles b64_json responses', async () => {
  const fetchImpl = stub(() => jsonResponse({ data: [{ b64_json: PNG }] }))
  const result = await openaiCompatible.generate(baseCtx({ profile: { baseURL: 'https://api.openai.com/v1', apiKey: 'sk', provider: 'openai-compatible' }, fetchImpl }))
  const call = fetchImpl.calls[0]
  assert.equal(call.url, 'https://api.openai.com/v1/images/generations')
  assert.equal(JSON.parse(call.init.body).size, '2560x1440')
  assert.equal(result.mediaType, 'image/png')
})

test('openai-compatible downloads url responses and filters model lists', async () => {
  const fetchImpl = stub((url) => {
    if (url.endsWith('/models')) return jsonResponse({ data: [{ id: 'gpt-image-1' }, { id: 'text-embedding-3' }] })
    if (url === 'https://img.example/a.png') return new Response(Buffer.from(PNG, 'base64'), { status: 200 })
    return jsonResponse({ data: [{ url: 'https://img.example/a.png' }] })
  })
  const profile = { baseURL: 'https://relay.example/v1', apiKey: 'sk', provider: 'openai-compatible' }
  const result = await openaiCompatible.generate(baseCtx({ profile, fetchImpl }))
  assert.equal(result.mediaType, 'image/png')

  const models = await openaiCompatible.listModels({ profile, fetchImpl })
  assert.deepEqual(models, ['gpt-image-1'])
})

test('gemini uses generateContent with inline_data parts', async () => {
  const fetchImpl = stub(() => jsonResponse({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: PNG } }] } }] }))
  const ctx = baseCtx({
    profile: { baseURL: 'https://generativelanguage.googleapis.com/v1beta', apiKey: 'gk', provider: 'gemini' },
    model: 'gemini-2.5-flash-image',
    references: [{ data: Buffer.from(PNG, 'base64'), mediaType: 'image/png' }],
    fetchImpl,
  })
  const result = await gemini.generate(ctx)
  const call = fetchImpl.calls[0]
  assert.match(call.url, /\/models\/gemini-2\.5-flash-image:generateContent\?key=gk$/)
  const body = JSON.parse(call.init.body)
  assert.equal(body.contents[0].parts.length, 2)
  assert.equal(body.contents[0].parts[1].inline_data.mime_type, 'image/png')
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '16:9')
  assert.equal(result.mediaType, 'image/jpeg')
})

test('dashscope posts a multimodal message and downloads the result url', async () => {
  const fetchImpl = stub((url) => {
    if (url.startsWith('https://img.example/')) return new Response(Buffer.from(PNG, 'base64'), { status: 200 })
    return jsonResponse({ output: { choices: [{ message: { content: [{ image: 'https://img.example/q.png' }] } }] } })
  })
  const result = await dashscope.generate(baseCtx({
    profile: { baseURL: 'https://dashscope.aliyuncs.com/api/v1', apiKey: 'dsk', provider: 'dashscope' },
    model: 'qwen-image-plus',
    fetchImpl,
  }))
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.parameters.size, '2560*1440')
  assert.equal(body.input.messages[0].content.at(-1).text, 'a red cube')
  assert.equal(result.mediaType, 'image/png')
})

test('seedream sends watermark:false and b64/url decoding works', async () => {
  const fetchImpl = stub(() => jsonResponse({ data: [{ url: 'https://img.example/s.png' }] }))
  const download = stub(() => new Response(Buffer.from(PNG, 'base64'), { status: 200 }))
  const realFetch = fetchImpl
  fetchImpl.calls.push = fetchImpl.calls.push.bind(fetchImpl.calls)
  // 先把生成与下载合并到一个 stub
  const combined = stub((url) => {
    if (url.startsWith('https://img.example/')) return download(url)
    return jsonResponse({ data: [{ url: 'https://img.example/s.png' }] })
  })
  const result = await seedream.generate(baseCtx({
    profile: { baseURL: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'ark', provider: 'seedream' },
    model: 'doubao-seedream-4-0-250828',
    fetchImpl: combined,
  }))
  const body = JSON.parse(combined.calls[0].init.body)
  assert.equal(body.watermark, false)
  assert.equal(body.response_format, 'url')
  assert.equal(result.mediaType, 'image/png')
})

test('comfyui requires a workflow before touching the network', async () => {
  const fetchImpl = stub(() => jsonResponse({}))
  await assert.rejects(
    () => comfyui.generate(baseCtx({ profile: { provider: 'comfyui', extra: {} }, fetchImpl })),
    /工作流/,
  )
  assert.equal(fetchImpl.calls.length, 0)
})

test('non-2xx responses become HubError with the upstream message', async () => {
  const fetchImpl = stub(() => jsonResponse({ error: { message: 'invalid api key' } }, 401))
  await assert.rejects(
    () => openaiCompatible.generate(baseCtx({ profile: { baseURL: 'https://api.openai.com/v1', apiKey: 'bad', provider: 'openai-compatible' }, fetchImpl })),
    (error) => error instanceof HubError && /invalid api key/.test(error.message) && error.status === 401,
  )
})

test('provider registry resolves every id', () => {
  for (const id of ['labnana', 'openai', 'openai-compatible', 'gemini', 'seedream', 'dashscope', 'xai', 'zhipu', 'comfyui']) {
    assert.equal(getProvider(id).id, id)
  }
})

test('xai sends aspect_ratio + resolution', async () => {
  const fetchImpl = stub(() => jsonResponse({ data: [{ b64_json: PNG }] }))
  const result = await xai.generate(baseCtx({
    profile: { baseURL: 'https://api.x.ai/v1', apiKey: 'xk', provider: 'xai' },
    model: 'grok-imagine-image',
    fetchImpl,
  }))
  const body = JSON.parse(fetchImpl.calls[0].init.body)
  assert.equal(body.aspect_ratio, '16:9')
  assert.equal(body.resolution, '2K')
  assert.equal(result.mediaType, 'image/png')
})

test('zhipu sends a pixel size string', async () => {
  const fetchImpl = stub(() => jsonResponse({ data: [{ url: 'https://img.example/z.png' }] }))
  const combined = stub((url) => {
    if (url.startsWith('https://img.example/')) return new Response(Buffer.from(PNG, 'base64'), { status: 200 })
    return jsonResponse({ data: [{ url: 'https://img.example/z.png' }] })
  })
  const result = await zhipu.generate(baseCtx({
    profile: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'zk', provider: 'zhipu' },
    model: 'glm-image',
    fetchImpl: combined,
  }))
  const body = JSON.parse(combined.calls[0].init.body)
  assert.equal(body.size, '2560x1440')
  assert.equal(result.mediaType, 'image/png')
})
