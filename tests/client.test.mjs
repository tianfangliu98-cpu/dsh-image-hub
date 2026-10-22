import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function reactStub() {
  class Component {
    constructor(props) { this.props = props }
  }
  return {
    createElement: () => ({ type: 'div', props: {} }),
    Component,
    useEffect: () => {},
    useState: (value) => [value, () => {}],
    useMemo: (factory) => factory(),
  }
}

function loadEntry({ withDocument = false } = {}) {
  let entry
  const document = withDocument
    ? {
        getElementById: () => null,
        createElement: () => ({ id: '', textContent: '' }),
        head: { appendChild: () => {} },
      }
    : undefined
  const sandbox = { window: { __ModuleLoader__: { load: (config) => { entry = config } } }, console, document }
  vm.runInContext(SOURCE, vm.createContext(sandbox), { filename: 'client.js' })
  return entry
}

test('bundle loads and exports the plugin shape (no "module is not defined")', () => {
  const entry = loadEntry()
  assert.ok(entry)
  assert.equal(entry.id, 'dsh-image-hub')
  const exported = entry.factory(() => reactStub())
  assert.equal(exported.name, 'image-hub')
  assert.deepEqual([...exported.inject], ['slots'])
  assert.equal(typeof exported.apply, 'function')
})

test('apply registers the settings section', () => {
  const entry = loadEntry({ withDocument: true })
  const exported = entry.factory(() => reactStub())
  const registered = []
  const injected = []
  const ctx = {
    effect: (factory) => factory(),
    slots: {
      inject: (slot, factory) => { injected.push(slot); return factory() },
      register: (options, component) => { registered.push({ options, component }); return options },
    },
  }
  exported.apply(ctx)
  assert.deepEqual(injected, ['settings.section'])
  assert.equal(registered.length, 1)
  assert.equal(registered[0].options.id, 'image-hub')
})

test('a broken slots service cannot escape apply', () => {
  const entry = loadEntry({ withDocument: true })
  const exported = entry.factory(() => reactStub())
  const ctx = {
    effect: () => {},
    slots: { inject: () => { throw new Error('boom') }, register: () => { throw new Error('nope') } },
  }
  assert.doesNotThrow(() => exported.apply(ctx))
})

test('bundle is a no-op when the module loader is absent', () => {
  const sandbox = { window: {}, console }
  assert.doesNotThrow(() => vm.runInContext(SOURCE, vm.createContext(sandbox), { filename: 'client.js' }))
})
