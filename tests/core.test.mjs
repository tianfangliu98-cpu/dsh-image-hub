import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_CONFIG,
  HubError,
  findReferenceImages,
  isInside,
  normalizeProfile,
  resolveProfile,
  saveImageToWorkspace,
  sniffMediaType,
  extensionFor,
  configPath,
} from '../lib/core.js'
import { getProvider, pixelsFor, sizeString, providerCatalog, RATIOS, SIZES } from '../lib/providers.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('pixel table covers every ratio and tier', () => {
  for (const ratio of RATIOS) {
    for (const size of SIZES) {
      const [w, h] = pixelsFor(ratio, size)
      assert.ok(w > 0 && h > 0, `${ratio}/${size}`)
      assert.equal(sizeString(ratio, size), `${w}x${h}`)
    }
  }
  assert.deepEqual(pixelsFor('1:1', '2K'), [2048, 2048])
  assert.deepEqual(pixelsFor('nope', 'nope'), [2048, 2048], 'unknown combos fall back to 1:1 / 2K')
})

test('profile normalization keeps only known fields and fills an id', () => {
  const profile = normalizeProfile({ provider: 'labnana', name: 'main', apiKey: ' k ', junk: 1 })
  assert.equal(profile.provider, 'labnana')
  assert.equal(profile.apiKey, 'k')
  assert.match(profile.id, /^p-/)
  assert.equal('junk' in profile, false)
  assert.deepEqual(profile.extra, {})
})

test('profile normalization keeps an optional proxy', () => {
  const profile = normalizeProfile({ provider: 'labnana', proxy: ' http://127.0.0.1:7890 ' })
  assert.equal(profile.proxy, 'http://127.0.0.1:7890')
  assert.equal(normalizeProfile({ provider: 'labnana' }).proxy, '')
})

test('resolveProfile prefers the requested id, then active, then first', () => {
  const config = {
    ...DEFAULT_CONFIG,
    activeProfile: 'b',
    profiles: [
      { id: 'a', provider: 'labnana', name: 'A' },
      { id: 'b', provider: 'gemini', name: 'B' },
    ],
  }
  assert.equal(resolveProfile(config, 'a').id, 'a')
  assert.equal(resolveProfile(config, 'B').id, 'b', 'name also works')
  assert.equal(resolveProfile(config).id, 'b')
  assert.equal(resolveProfile({ ...config, activeProfile: 'zzz' }).id, 'a')
  assert.equal(resolveProfile({ ...config, profiles: [] }), undefined)
})

test('providers expose the catalog the settings page needs', () => {
  const catalog = providerCatalog()
  const ids = catalog.map((p) => p.id)
  assert.deepEqual(ids.sort(), ['chatgpt-sub', 'comfyui', 'dashscope', 'gemini', 'google-sub', 'grok-sub', 'labnana', 'openai', 'openai-compatible', 'seedream', 'xai', 'zhipu'])
  const labnana = getProvider('labnana')
  assert.equal(labnana.supports.generate, true)
  assert.ok(labnana.models.includes('gemini-3.1-flash-image'))
  assert.throws(() => getProvider('nope'), HubError)
})

test('workspace saving rejects escapes and writes inside the root', async () => {
  const { mkdtemp, rm, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const path = await import('node:path')
  const root = await mkdtemp(path.join(tmpdir(), 'hub-'))
  try {
    const file = await saveImageToWorkspace({ workspaceRoot: root, folder: 'shots', model: 'gemini 3', mediaType: 'image/png', data: PNG })
    assert.ok(file.startsWith(root))
    assert.ok((await readFile(file)).length > 0)
    await assert.rejects(
      () => saveImageToWorkspace({ workspaceRoot: root, folder: '../escape', model: 'x', mediaType: 'image/png', data: PNG }),
      /逃出了工作区/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('media sniffing and extensions', () => {
  assert.equal(sniffMediaType(PNG), 'image/png')
  assert.equal(sniffMediaType(Buffer.from([0xff, 0xd8, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg')
  assert.equal(extensionFor('image/jpeg'), 'jpg')
  assert.equal(extensionFor('image/png'), 'png')
})

test('reference images: explicit ids first, else newest image-bearing message', () => {
  const messages = [
    { source: { kind: 'user' }, content: [{ type: 'image', attachment: { attachmentId: 'sha256:aaa' } }] },
    { source: { kind: 'assistant' }, content: [{ type: 'image', attachment: { attachmentId: 'sha256:bbb' } }] },
  ]
  assert.equal(findReferenceImages(messages, ['bbb'])[0].attachmentId, 'sha256:bbb')
  assert.equal(findReferenceImages(messages)[0].attachmentId, 'sha256:aaa', 'newest human message wins')
  assert.deepEqual(findReferenceImages([], []), [])
  assert.throws(() => findReferenceImages(messages, ['zzz']), /找不到附件/)
})

test('config path lives under DSH_HOME', async () => {
  const path = await import('node:path')
  const saved = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:/tmp/dsh-home'
  try {
    assert.equal(configPath(), path.join('C:/tmp/dsh-home', 'image-hub', 'config.json'))
  } finally {
    if (saved === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = saved
  }
})

test('isInside blocks traversal', () => {
  const root = 'C:/work/project'
  assert.equal(isInside(root, 'C:/work/project/a.png'), true)
  assert.equal(isInside(root, 'C:/work/project/../secret.png'), false)
})
