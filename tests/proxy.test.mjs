import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'

import { createProxiedFetch } from '../lib/proxy.js'

let target
let targetPort
let proxy
let proxyPort
let rejectProxy
let rejectProxyPort
const sockets = new Set()

function track(server) {
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
}

before(async () => {
  target = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' })
      res.end(JSON.stringify({
        ok: true,
        url: req.url,
        method: req.method,
        type: req.headers['content-type'] ?? '',
        bytes: body.length,
      }))
    })
  })
  track(target)
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve))
  targetPort = target.address().port

  proxy = http.createServer((req, res) => {
    res.writeHead(405, { connection: 'close' })
    res.end('only CONNECT')
  })
  track(proxy)
  proxy.on('connect', (req, clientSocket, head) => {
    sockets.add(clientSocket)
    clientSocket.on('close', () => sockets.delete(clientSocket))
    const [host, port] = req.url.split(':')
    const upstream = net.connect(Number(port), host, () => {
      sockets.add(upstream)
      upstream.on('close', () => sockets.delete(upstream))
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  proxyPort = proxy.address().port

  rejectProxy = http.createServer()
  track(rejectProxy)
  rejectProxy.on('connect', (_req, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  await new Promise((resolve) => rejectProxy.listen(0, '127.0.0.1', resolve))
  rejectProxyPort = rejectProxy.address().port
})

after(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await Promise.all([
    new Promise((resolve) => target.close(resolve)),
    new Promise((resolve) => proxy.close(resolve)),
    new Promise((resolve) => rejectProxy.close(resolve)),
  ])
})

test('proxied fetch tunnels through CONNECT', { timeout: 8000 }, async () => {
  const proxied = createProxiedFetch(`http://127.0.0.1:${proxyPort}`)
  const response = await proxied(`http://127.0.0.1:${targetPort}/hello?x=1`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.ok, true)
  assert.equal(body.url, '/hello?x=1')
})

test('proxied fetch sends JSON bodies and headers', { timeout: 8000 }, async () => {
  const proxied = createProxiedFetch(`http://127.0.0.1:${proxyPort}`)
  const payload = JSON.stringify({ prompt: 'hi' })
  const response = await proxied(`http://127.0.0.1:${targetPort}/gen`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer x' },
    body: payload,
  })
  const body = await response.json()
  assert.equal(body.method, 'POST')
  assert.equal(body.bytes, Buffer.byteLength(payload))
  assert.equal(body.type, 'application/json')
})

test('proxied fetch encodes FormData like fetch would', { timeout: 8000 }, async () => {
  const proxied = createProxiedFetch(`http://127.0.0.1:${proxyPort}`)
  const form = new FormData()
  form.append('prompt', 'hi')
  form.append('image', new Blob([Buffer.from([1, 2, 3])], { type: 'image/png' }), 'a.png')
  const response = await proxied(`http://127.0.0.1:${targetPort}/edit`, { method: 'POST', body: form })
  const body = await response.json()
  assert.equal(body.method, 'POST')
  assert.match(body.type, /^multipart\/form-data; boundary=/)
  assert.ok(body.bytes > 100)
})

test('proxy rejection surfaces a readable error', { timeout: 8000 }, async () => {
  const proxied = createProxiedFetch(`http://127.0.0.1:${rejectProxyPort}`)
  await assert.rejects(() => proxied(`http://127.0.0.1:${targetPort}/x`), /代理拒绝建立隧道/)
})

test('invalid proxy urls are rejected up front', () => {
  assert.throws(() => createProxiedFetch('not a url'), /代理地址不合法/)
  assert.throws(() => createProxiedFetch('socks5://127.0.0.1:1080'), /只支持 http\/https 代理/)
})
