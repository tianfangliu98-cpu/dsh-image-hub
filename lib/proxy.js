/**
 * 走 HTTP 代理的 fetch 替代品。
 *
 * 为什么需要它：Node 的 fetch（undici）**不读 Windows 系统代理**，也不看
 * HTTPS_PROXY（除非进程带 --use-env-proxy）。而国内访问 Labnana / OpenAI
 * 这类接口基本都要走本地代理，所以插件自己实现一层：
 *
 *   浏览器/系统代理走 HTTP CONNECT 隧道 → 插件也用 CONNECT，
 *   只在每套 API 配置里填一个 proxy 地址即可，不依赖系统设置。
 *
 * 只支持 HTTP(S) 代理（http://host:port，可带 user:pass），
 * 不支持 SOCKS——那种情况请把代理开成 TUN/全局模式。
 */

import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { Readable } from 'node:stream'

function proxyAuthHeader(proxy) {
  const username = decodeURIComponent(proxy.username || '')
  const password = decodeURIComponent(proxy.password || '')
  if (username === '' && password === '') return undefined
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`
}

/** 向代理发 CONNECT，拿到一条通往目标 host:port 的裸连接。 */
function openTunnel(proxy, host, port, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port || 80) })
    let buffer = ''
    let settled = false

    const fail = (error) => {
      if (settled) return
      settled = true
      socket.destroy()
      reject(error)
    }

    const onAbort = () => fail(new Error('请求已取消'))
    signal?.addEventListener('abort', onAbort, { once: true })

    socket.setTimeout(20_000, () => fail(new Error('连接代理超时')))

    socket.on('error', fail)
    socket.on('connect', () => {
      const auth = proxyAuthHeader(proxy)
      socket.write(
        `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n`
        + (auth === undefined ? '' : `Proxy-Authorization: ${auth}\r\n`)
        + '\r\n',
      )
    })

    socket.on('data', function onData(chunk) {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.removeListener('data', onData)
      const statusLine = buffer.slice(0, buffer.indexOf('\r\n'))
      const status = Number(statusLine.split(' ')[1])
      if (!(status >= 200 && status < 300)) {
        fail(new Error(`代理拒绝建立隧道（${statusLine.trim()}）`))
        return
      }
      if (settled) return
      settled = true
      socket.setTimeout(0)
      signal?.removeEventListener('abort', onAbort)
      resolve(socket)
    })
  })
}

/**
 * 造一个 fetch 兼容函数。
 * @param {string} proxyUrl 例如 http://127.0.0.1:7890 或 http://user:pass@host:port
 */
export function createProxiedFetch(proxyUrl) {
  let proxy
  try {
    proxy = new URL(proxyUrl)
  } catch {
    throw new Error(`代理地址不合法：${proxyUrl}（形如 http://127.0.0.1:7890）`)
  }
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:') {
    throw new Error(`只支持 http/https 代理，收到 ${proxy.protocol}//`)
  }

  return async function proxiedFetch(target, init = {}) {
    const url = new URL(typeof target === 'string' ? target : String(target?.url ?? target))
    const isHttps = url.protocol === 'https:'
    const host = url.hostname
    const port = Number(url.port || (isHttps ? 443 : 80))

    const raw = await openTunnel(proxy, host, port, init.signal)
    const socket = isHttps ? tls.connect({ socket: raw, servername: host }) : raw
    if (isHttps) {
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve)
        socket.once('error', reject)
      })
    }

    const headers = {}
    for (const [key, value] of Object.entries(init.headers ?? {})) headers[key.toLowerCase()] = String(value)

    let body = init.body
    if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof Uint8Array) && !Buffer.isBuffer(body)) {
      // FormData / URLSearchParams 等：先编码成字节，沿用它们自己生成的 content-type
      const encoded = new Response(body)
      const type = encoded.headers.get('content-type')
      if (type !== null) headers['content-type'] = type
      body = Buffer.from(await encoded.arrayBuffer())
    }
    if (body !== undefined && body !== null && !Buffer.isBuffer(body) && !(body instanceof Uint8Array)) {
      body = Buffer.from(String(body))
    }

    return new Promise((resolve, reject) => {
      // 注意：agent:false + createConnection 会被 http.request 忽略（实测 socket hang up）。
      // 正确姿势是一次性 Agent 覆写 createConnection。
      const agent = new http.Agent({ keepAlive: false })
      agent.createConnection = () => socket
      const request = http.request({
        method: init.method ?? 'GET',
        host,
        port,
        path: `${url.pathname}${url.search}`,
        headers,
        agent,
      })

      const onAbort = () => request.destroy(new Error('请求已取消'))
      init.signal?.addEventListener('abort', onAbort, { once: true })

      request.on('error', (error) => {
        init.signal?.removeEventListener('abort', onAbort)
        reject(error)
      })
      request.on('response', (response) => {
        init.signal?.removeEventListener('abort', onAbort)
        resolve(new Response(Readable.toWeb(response), {
          status: response.statusCode ?? 0,
          statusText: response.statusMessage ?? '',
          headers: response.headers,
        }))
      })

      if (body !== undefined && body !== null) request.write(body)
      request.end()
    })
  }
}
