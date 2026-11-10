/**
 * 宿主侧端到端测试：用假 ctx 驱动真实的插件入口 apply()。
 *
 * 覆盖：工具注册、路由注册、配置读写、生成全链路（本地 mock 上游）、
 * 错误分支、代理接入。不联网、不需要 DSH。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

let upstream
let upstreamPort
let dshHome
let workDir
let plugin
let tools
let routes
let savedImages

before(async () => {
  upstream = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'GET' && url.endsWith('/openapi/v1/user/subscription')) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ code: 0, data: { totalAvailableCredits: 77, subscriptionPlan: { name: 'mock' } } }))
      return
    }
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({ data: [{ id: 'gpt-image-1' }, { id: 'text-embedding-3' }] }))
      return
    }
    if (req.method === 'POST' && (url.endsWith('/openapi/v1/images/generation') || url.endsWith('/images/generations'))) {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
        if (url.endsWith('/openapi/v1/images/generation')) {
          assert.equal(parsed.provider, 'google')
          res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: PNG } }] } }], modelVersion: parsed.model }))
        } else {
          res.end(JSON.stringify({ data: [{ b64_json: PNG }] }))
        }
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ error: 'not found', url }))
  })
  upstream.on('connection', (socket) => socket.unref())
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = upstream.address().port

  dshHome = await mkdtemp(path.join(tmpdir(), 'hub-home-'))
  workDir = await mkdtemp(path.join(tmpdir(), 'hub-work-'))
  process.env.DSH_HOME = dshHome
  await mkdir(path.join(dshHome, 'image-hub'), { recursive: true })
  await writeFile(path.join(dshHome, 'image-hub', 'config.json'), JSON.stringify({
    activeProfile: 'p-lab',
    saveToWorkspace: true,
    workspaceFolder: 'shots',
    timeoutMs: 20_000,
    profiles: [
      { id: 'p-lab', provider: 'labnana', name: 'Mock Labnana', baseURL: `http://127.0.0.1:${upstreamPort}`, apiKey: 'k1', model: 'gemini-3.1-flash-image', aspectRatio: '16:9', imageSize: '2K', extra: {} },
      { id: 'p-oai', provider: 'openai-compatible', name: 'Mock OpenAI', baseURL: `http://127.0.0.1:${upstreamPort}`, apiKey: 'k2', model: 'gpt-image-1', extra: {} },
      { id: 'p-dead', provider: 'labnana', name: 'Dead', baseURL: 'http://127.0.0.1:1', apiKey: 'k3', model: 'x', extra: {} },
    ],
  }, null, 2), 'utf8')

  plugin = await import('../lib/index.js')
  tools = []
  routes = []
  savedImages = []
  await plugin.apply({
    tools: { register: (tool) => { tools.push(tool) } },
    attachments: {
      async saveImage(image) {
        savedImages.push(image)
        return { attachmentId: 'att-1', mediaType: image.mediaType, bytes: image.data.length, width: 1, height: 1, name: image.name }
      },
      async readImage() { return { data: Buffer.from(PNG, 'base64'), ref: { mediaType: 'image/png' } } },
    },
    webServer: { register: (route) => { routes.push(route) } },
    logger: { info: () => {}, warn: () => {} },
  })
})

after(async () => {
  for (const socket of [] ) socket.destroy?.()
  upstream.closeAllConnections?.()
  await new Promise((resolve) => upstream.close(resolve))
  await rm(dshHome, { recursive: true, force: true })
  await rm(workDir, { recursive: true, force: true })
})

function tool(name) {
  const found = tools.find((item) => item.name === name)
  assert.ok(found, `tool ${name} missing`)
  return found
}

function exec(messages = []) {
  return { signal: undefined, agent: { session: { header: { cwd: workDir }, deriveMessages: () => messages } } }
}

async function call(handler, { method = 'GET', url = '/', body } = {}) {
  const res = {
    status: 0, headers: {}, body: '',
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers ?? {}) },
    end(chunk) { this.body = String(chunk ?? '') },
  }
  const req = {
    method, url, headers: {},
    on(event, listener) {
      if (event === 'data' && body !== undefined) listener(Buffer.from(JSON.stringify(body)))
      if (event === 'end') listener()
      return this
    },
  }
  await handler(req, res)
  return { status: res.status, body: res.body === '' ? null : JSON.parse(res.body) }
}

test('registers exactly the two image tools and one route prefix', () => {
  assert.deepEqual(tools.map((t) => t.name).sort(), ['image_edit', 'image_gallery', 'image_generate'])
  assert.equal(routes.length, 1)
  assert.equal(routes[0].path, '/api/image-hub')
})

test('generates through the active profile, attaches and saves', async () => {
  const value = await tool('image_generate').execute({ prompt: 'a cube' }, exec())
  assert.equal(value.attachment.attachmentId, 'att-1')
  assert.equal(value.provider, 'labnana')
  assert.equal(value.model, 'gemini-3.1-flash-image')
  assert.equal(value.aspectRatio, '16:9')
  assert.equal(value.imageSize, '2K')
  assert.ok(value.savedTo.startsWith(workDir))
  assert.ok((await readFile(value.savedTo)).length > 0)
})

test('an explicit profile name routes to that provider', async () => {
  const value = await tool('image_generate').execute({ prompt: 'a cube', profile: 'Mock OpenAI', aspect_ratio: '1:1', image_size: '1K' }, exec())
  assert.equal(value.provider, 'openai-compatible')
  assert.equal(value.model, 'gpt-image-1')
})

test('a dead upstream surfaces a readable error', async () => {
  await assert.rejects(
    () => tool('image_generate').execute({ prompt: 'x', profile: 'Dead' }, exec()),
    (error) => /请求失败|未返回/.test(String(error.message)),
  )
})

test('unknown profile is rejected', async () => {
  await assert.rejects(() => tool('image_generate').execute({ prompt: 'x', profile: 'nope' }, exec()), /没有配置任何图片 API|没有找到/)
})

test('edit without any image fails clearly', async () => {
  await assert.rejects(() => tool('image_edit').execute({ prompt: 'x' }, exec()), /改图需要一张参考图/)
})

test('settings API returns state and never leaks keys', async () => {
  const route = routes[0]
  const state = await call(route.handler, { url: '/api/image-hub/state' })
  assert.equal(state.status, 200)
  assert.equal(state.body.config.profiles.length, 3)
  assert.equal(state.body.providers.length, 12)
  assert.equal(JSON.stringify(state.body).includes('"k1"'), false)
  assert.equal(state.body.config.profiles[0].keyHint.length > 0, true)
})

test('settings API saves config and keeps existing keys', async () => {
  const route = routes[0]
  const state = await call(route.handler, { url: '/api/image-hub/state' })
  const profiles = state.body.config.profiles.map((p) => ({ ...p, apiKey: '' }))
  const saved = await call(route.handler, {
    method: 'POST',
    url: '/api/image-hub/config',
    body: { activeProfile: 'p-oai', saveToWorkspace: false, workspaceFolder: 'pics', profiles },
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.config.activeProfile, 'p-oai')
  const raw = JSON.parse(await readFile(path.join(dshHome, 'image-hub', 'config.json'), 'utf8'))
  assert.equal(raw.profiles.find((p) => p.id === 'p-lab').apiKey, 'k1', 'blank apiKey must keep the stored one')
  assert.equal(raw.saveToWorkspace, false)
})

test('settings API test + models hit the upstream', async () => {
  const route = routes[0]
  const tested = await call(route.handler, { method: 'POST', url: '/api/image-hub/test', body: { profileId: 'p-lab' } })
  assert.equal(tested.body.ok, true)
  assert.match(tested.body.detail, /mock/)
  const models = await call(route.handler, { method: 'POST', url: '/api/image-hub/models', body: { profileId: 'p-oai' } })
  assert.equal(models.body.ok, true)
  assert.deepEqual(models.body.models, ['gpt-image-1'])
})

test('saving one profile does not touch the others', async () => {
  const route = routes[0]
  const before = await call(route.handler, { url: '/api/image-hub/state' })
  const target = before.body.config.profiles.find((p) => p.id === 'p-oai')
  const saved = await call(route.handler, {
    method: 'POST',
    url: '/api/image-hub/profile',
    body: { profile: { ...target, name: 'Renamed OpenAI', apiKey: '' } },
  })
  assert.equal(saved.status, 200)
  const lab = saved.body.config.profiles.find((p) => p.id === 'p-lab')
  assert.equal(lab.name, 'Mock Labnana', 'other profiles stay untouched')
  assert.equal(saved.body.config.profiles.find((p) => p.id === 'p-oai').name, 'Renamed OpenAI')
  const raw = JSON.parse(await readFile(path.join(dshHome, 'image-hub', 'config.json'), 'utf8'))
  assert.equal(raw.profiles.find((p) => p.id === 'p-oai').apiKey, 'k2', 'blank key keeps the stored one')
})

test('disabling a profile blocks generation with a clear error', async () => {
  const route = routes[0]
  const toggled = await call(route.handler, {
    method: 'POST',
    url: '/api/image-hub/profile/toggle',
    body: { id: 'p-lab', enabled: false },
  })
  assert.equal(toggled.body.config.profiles.find((p) => p.id === 'p-lab').enabled, false)
  await assert.rejects(
    () => tool('image_generate').execute({ prompt: 'x', profile: 'Mock Labnana' }, exec()),
    /已停用/,
  )
  await call(route.handler, { method: 'POST', url: '/api/image-hub/profile/toggle', body: { id: 'p-lab', enabled: true } })
})

test('gallery lists what was generated in this conversation', async () => {
  await tool('image_generate').execute({ prompt: 'gallery item' }, exec())
  const value = await tool('image_gallery').execute({}, exec())
  assert.ok(value.count >= 1)
  assert.ok(Array.isArray(value.items))
  assert.equal(value.items[0].prompt, 'gallery item')
  assert.ok(value.items[0].attachment)
  const rendered = tool('image_gallery').output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered.some((block) => block.type === 'image'))
})

test('credits route reports remaining credits from the upstream', async () => {
  const route = routes[0]
  const result = await call(route.handler, { method: 'POST', url: '/api/image-hub/credits', body: { profileId: 'p-lab' } })
  assert.equal(result.body.ok, true)
  assert.equal(result.body.remaining, 77)
})

test('a provider without credits answers honestly', async () => {
  const route = routes[0]
  const result = await call(route.handler, { method: 'POST', url: '/api/image-hub/credits', body: { profileId: 'p-oai' } })
  assert.equal(result.body.ok, false)
  assert.match(result.body.error, /积分|计费/)
})

test('gallery records are persisted to disk', async () => {
  const file = path.join(dshHome, 'image-hub', 'gallery.jsonl')
  const text = await readFile(file, 'utf8')
  const lines = text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  assert.ok(lines.length >= 1)
  assert.ok(lines.every((line) => typeof line.sessionKey === 'string'))
  assert.ok(lines.some((line) => line.prompt === 'gallery item'))
})
