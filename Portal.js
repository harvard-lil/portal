// Raw HTTP transport with destination authorization; see README.md.
import * as http from 'node:http'
import * as https from 'node:https'
import { TLSSocket } from 'node:tls'
import { BlockList, isIP } from 'node:net'
import dns from 'node:dns/promises'
import { Duplex, PassThrough } from 'node:stream'
import { once } from 'node:events'
import { RequestGate } from './RequestGate.js'
import { ResponseGate } from './ResponseGate.js'
import { requestUrl as authorityUrl } from './authority.js'

const CONNECT = 'CONNECT'
const RELEASE_SOCKET = 'release-socket'
const CRLF = '\r\n'
const tunnelAuthority = Symbol('CONNECT authority')
const guardedSocket = Symbol('guarded socket')

function guardSocket (socket, proxy) {
  if (socket[guardedSocket]) return
  socket[guardedSocket] = true
  socket.on('error', error => {
    if (socket.listenerCount('error') === 1) proxy?.emit('error', error, socket)
  })
}

export const clientDefaults = {
  rejectUnauthorized: false,
  requestCert: false,
  key: '-----BEGIN PRIVATE KEY-----\n' +
    'MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgFy3kvv0iHTVaeqcv\n' +
    'DIzScropX09AFbieQAy8Dyh8kCihRANCAAQ+UBhyBUy/izj5jozMz+aLpzj7/lPS\n' +
    'jAQbWM+8aSDYmu7Ermo6+qz9PatGixPE1c3cq0E9BSqOEVYMXiVcizeQ\n' +
    '-----END PRIVATE KEY-----',
  cert: '-----BEGIN CERTIFICATE-----\n' +
    'MIIBlTCCATygAwIBAgIUcUDMIG9bw3nWnUS5vwGPIgX3zIcwCgYIKoZIzj0EAwIw\n' +
    'FDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTIwMDEyMjIzMjIwN1oXDTIxMDEyMTIz\n' +
    'MjIwN1owFDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0D\n' +
    'AQcDQgAEPlAYcgVMv4s4+Y6MzM/mi6c4+/5T0owEG1jPvGkg2JruxK5qOvqs/T2r\n' +
    'RosTxNXN3KtBPQUqjhFWDF4lXIs3kKNsMGowaAYDVR0RBGEwX4IJbG9jYWxob3N0\n' +
    'ggsqLmxvY2FsaG9zdIIVbG9jYWxob3N0LmxvY2FsZG9tYWluhwR/AAABhwQAAAAA\n' +
    'hxAAAAAAAAAAAAAAAAAAAAABhxAAAAAAAAAAAAAAAAAAAAAAMAoGCCqGSM49BAMC\n' +
    'A0cAMEQCIH/3IPGNTbCQnr1F1x0r28BtwkhMZPLRSlm7p0uXDv9pAiBi4JQKEwlY\n' +
    '6sWzsJyD3vMMAyP9UZm0WJhtcOb6F0wRpg==\n' +
    '-----END CERTIFICATE-----'
}

function prepSocket (socket, proxy) {
  if (!socket.mirror) {
    socket.mirror = new PassThrough()
    socket.pipe(socket.mirror)
    guardSocket(socket, proxy)
  } else {
    socket.mirror.unpipe()
    socket.responseGate?.destroy()
    socket.mirror.transformer?.unpipe()
    socket.resume()
  }
}

function releaseSocket (req) {
  const { socket } = req
  prepSocket(socket) // prevents us from piping our fake response back to the proxy

  /**
   * A listener must be present or the socket will be closed
   * @see {@link https://nodejs.org/api/http.html#event-upgrade}
   * @see {@link https://github.com/nodejs/node/blob/c5881458106487f80d31513096b4d0baa88828b8/lib/_http_client.js#L564}
   */
  req.on('upgrade', () => {})

  /**
   * emit a fake switching response to trigger the
   * release of the socket and parser from the request
   * NOTE: the `Upgrade` and `Connection` headers are required for the parser to flip the `upgrade` flag
   * @see {@link https://github.com/nodejs/node/blob/c5881458106487f80d31513096b4d0baa88828b8/lib/_http_client.js#L545}
   */
  socket.emit('data', Buffer.from([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: ' + RELEASE_SOCKET,
    'Connection: Upgrade',
    CRLF
  ].join(CRLF)))

  /**
   * The upgrade logic also removes the socket from the agent pool
   * with the idea that you'll have a long-running websocket attached
   * so we must add it back to the pool by temporarily patching createConnection.
   * Despite the name, `createSocket` does not create the socket, it defers to `createConnection` for that.
   * Instead, it attaches listeners and inserts the socket into the pool so we're forcing
   * `createConnection` to just return the socket we already have.
   * @see {@link https://github.com/nodejs/node/blob/c5881458106487f80d31513096b4d0baa88828b8/lib/_http_client.js#L568}
   * @see {@link https://github.com/nodejs/node/blob/c5881458106487f80d31513096b4d0baa88828b8/lib/_http_agent.js#L311}
   * @see {@link https://github.com/nodejs/node/blob/c5881458106487f80d31513096b4d0baa88828b8/lib/_http_agent.js#L334}
   */
  const createConnection = req.agent.createConnection
  try {
    req.agent.createConnection = (...args) => args[0]?.socket
      ? args[0].socket
      : createConnection.call(req.agent, ...args)
    req.agent.createSocket(req, { socket, servername: 'bypass' }, () => {})
  } finally {
    req.agent.createConnection = createConnection
  }
}

/** Return the HTTP URL represented by a parsed request without changing its bytes. */
export function requestUrl (request) {
  const target = authorityUrl(request, {
    secure: request.socket instanceof TLSSocket,
    tunnelAuthority: request.socket[tunnelAuthority]
  })
  if (!['http:', 'https:'].includes(new URL(target).protocol)) throw new Error('Only HTTP(S) destinations are permitted')
  return target
}

// Default routing permits every valid HTTP(S) destination, with one resolved
// address per request and no second DNS lookup when opening the connection.
async function authorizeDestination (request, signal) {
  signal.throwIfAborted()
  const url = new URL(requestUrl(request))
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const literalFamily = isIP(hostname)
  const { address, family } = literalFamily
    ? { address: hostname, family: literalFamily }
    : await dns.lookup(hostname)
  signal.throwIfAborted()
  return {
    url,
    hostname,
    address,
    family,
    lookup: (_hostname, options, callback) => queueMicrotask(() => {
      if (signal.aborted) callback(signal.reason)
      else if (options?.all) callback(null, [{ address, family }])
      else callback(null, address, family)
    })
  }
}

function verifyDestination (socket, destination) {
  const addresses = new BlockList()
  addresses.addAddress(destination.address, isIP(destination.address) === 6 ? 'ipv6' : 'ipv4')
  const family = isIP(socket.remoteAddress || '')
  if (!family || !addresses.check(socket.remoteAddress, family === 6 ? 'ipv6' : 'ipv4')) {
    throw new Error('Connected peer differs from approved destination')
  }
}

/**
 * Retain Portal's parsed-event/raw-byte interface. authorizeRequest is awaited
 * before http.request can create or reuse an upstream socket. Each connection's
 * RequestGate releases only the exact byte range of that approved message.
 */
export function createServer (options = {}) {
  const {
    authorizeRequest = authorizeDestination,
    verifyPeer = verifyDestination,
    requestTransformer = () => new PassThrough(),
    responseTransformer = () => new PassThrough(),
    clientOptions = () => ({}),
    serverOptions = () => ({}),
    ...serverSettings
  } = options
  if (typeof authorizeRequest !== 'function' || typeof verifyPeer !== 'function') {
    throw new TypeError('authorizeRequest and verifyPeer must be functions')
  }
  const agents = { 'http:': new http.Agent({ keepAlive: true }), 'https:': new https.Agent({ keepAlive: true }) }
  // DNS changes must not reuse a socket authorized for another address. Agent
  // names retain the original hostname (and HTTPS settings) as well as the pin.
  for (const agent of Object.values(agents)) {
    const createConnection = agent.createConnection
    agent.createConnection = function (...args) {
      const socket = createConnection.apply(this, args)
      // Pinned lookup can fail before ClientRequest emits its socket event.
      // Keep an error listener throughout creation, pooling and teardown.
      guardSocket(socket, proxy)
      return socket
    }
    const getName = agent.getName
    agent.getName = function (settings) {
      return `${getName.call(this, settings)}:${settings.approvedAddress || ''}`
    }
  }
  const sockets = new Set()
  const proxy = http.createServer(serverSettings)
  // One byte limit governs downstream parsing, upstream parsing and the raw
  // framing gates, so no stage accepts a header block another rejects.
  const maxHeaderSize = serverSettings.maxHeaderSize ?? http.maxHeaderSize
  // Framing metadata must include headers near the end of a permitted header
  // block. Retain Node's byte-size limit, but do not silently omit field pairs.
  proxy.maxHeadersCount = 0
  const track = socket => {
    if (sockets.has(socket)) return
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  }
  const fail = (error, request, serverRequest) => {
    serverRequest?.destroy()
    const socket = request?.socket
    socket?.requestGate?.destroy()
    proxy.emit('error', error, serverRequest, request)
    // The caller may emit an error response, but must never continue forwarding.
    if (socket && !socket.destroyed) socket.end()
  }

  async function openRequest (request, signal) {
    requestUrl(request) // Authority checks apply even when a custom policy does not parse the URL.
    const destination = await authorizeRequest(request, signal)
    signal.throwIfAborted()
    const customOptions = await serverOptions(request)
    signal.throwIfAborted()
    if (request.socket.destroyed) throw new Error('Client connection closed')
    destination.signal?.throwIfAborted()
    const protocol = destination.url.protocol
    const module = protocol === 'https:' ? https : http
    const port = destination.url.port === '' ? (protocol === 'https:' ? 443 : 80) : Number(destination.url.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid destination port')
    const upstream = module.request({
      ...customOptions,
      method: request.method === CONNECT ? 'GET' : request.method,
      host: destination.hostname,
      port,
      servername: customOptions.servername ?? (isIP(destination.hostname) ? '' : destination.hostname),
      agent: agents[protocol],
      lookup: destination.lookup,
      family: destination.family,
      approvedAddress: destination.address,
      maxHeaderSize
    })
    let finishResponse
    let rejectResponse
    const responseDone = new Promise((resolve, reject) => { finishResponse = resolve; rejectResponse = reject })
    // A response can fail before the gate finishes sending a request body.
    responseDone.catch(() => {})
    upstream.maxHeadersCount = 0
    let pipeReady
    let responseGate
    let active
    let openReject
    let responseStarted = false
    let stopped = false
    const stop = error => {
      if (stopped) return
      stopped = true
      upstream.socket?.destroy()
      // Once raw response bytes have begun, a synthetic error response would
      // become part of that response body or an unrequested second message.
      if (responseStarted) request.socket.destroy()
      responseGate?.destroy()
      rejectResponse(error)
      openReject?.(error)
      fail(error, request, upstream)
    }
    const aborted = () => upstream.destroy(new Error('Client connection closed'))
    signal.addEventListener('abort', aborted, { once: true })
    destination.signal?.addEventListener('abort', aborted, { once: true })
    upstream.on('close', () => {
      signal.removeEventListener('abort', aborted)
      destination.signal?.removeEventListener('abort', aborted)
    })
    upstream.on('error', stop)

    const startResponse = (response, upgrade = false) => {
      if (!active) throw new Error('Response before peer verification and request setup')
      responseGate.addResponse(response, upgrade)
      if (!pipeReady) {
        pipeReady = Promise.resolve(responseTransformer(response, request)).then(transformer => {
          upstream.socket.mirror.transformer = transformer
          transformer.on('error', stop)
          transformer.pipe(request.socket, { end: false })
          return transformer
        })
        pipeReady.catch(stop)
      }
    }
    upstream.on('information', response => {
      try { startResponse(response); proxy.emit('information', response, request) } catch (error) { stop(error) }
    })
    upstream.on('continue', () => proxy.emit('continue', request))
    upstream.on('response', response => {
      try { startResponse(response) } catch (error) { stop(error); return }
      proxy.emit('response', response, request)
      response.on('error', stop)
      response.on('end', () => {
        responseGate.done.then(async () => {
          if (signal.aborted) return
          const transformer = await pipeReady
          const flushed = once(transformer, 'end', { signal })
          transformer.end()
          await flushed
          active.close = responseGate.closeDelimited || /(?:^|,)\s*close\s*(?:,|$)/i.test(response.headers.connection || '')
          // Do not return the socket to Node's pool until the raw byte boundary
          // agrees with its parsed end, including any already queued bytes.
          const freed = upstream.shouldKeepAlive ? once(upstream.socket, 'free', { signal }) : null
          response.req?.emit('finish')
          if (freed) await freed
          finishResponse()
        }).catch(stop)
      })
      response.resume()
    })
    upstream.on('upgrade', (response, socket, head) => {
      if (response.headers.upgrade === RELEASE_SOCKET) return
      try { startResponse(response, true) } catch (error) { stop(error); return }
      if (!request.upgrade) { stop(new Error('Unsolicited protocol upgrade')); return }
      active.upgraded = true
      proxy.emit('upgrade-client', response, request)
      socket.resume()
      responseGate.done.then(finishResponse, stop)
    })

    return await new Promise((resolve, reject) => {
      openReject = reject
      upstream.on('socket', socket => {
        track(socket)
        prepSocket(socket, proxy)
        if (request.method !== CONNECT) {
          responseGate = new ResponseGate(request, async bytes => {
            const transformer = await pipeReady
            if (!transformer || signal.aborted) throw new Error('Response stream is unavailable')
            responseStarted = true
            await new Promise((resolve, reject) => transformer.write(bytes, error => error ? reject(error) : resolve()))
          }, maxHeaderSize)
          socket.responseGate = responseGate
          responseGate.on('error', stop)
          socket.mirror.pipe(responseGate)
        }
        const connected = async () => {
          signal.throwIfAborted()
          await verifyPeer(socket, destination)
          signal.throwIfAborted()
          destination.signal?.throwIfAborted()
          proxy.emit('connected', socket, request)
          if (socket.destroyed) throw new Error('Upstream connection closed')
          if (request.method === CONNECT) {
            const tlsOptions = await clientOptions(request)
            signal.throwIfAborted()
            // The outer gate supplies all post-CONNECT bytes to this transport,
            // including a ClientHello arriving in the same TCP read as CONNECT.
            const transport = new Duplex({
              read () {},
              write (data, encoding, callback) { request.socket.write(data, encoding, callback) },
              final (callback) { request.socket.end(callback) },
              destroy (error, callback) { request.socket.destroy(); callback(error) }
            })
            const local = new TLSSocket(transport, { ...clientDefaults, ...tlsOptions, isServer: true })
            local[tunnelAuthority] = destination.url.host
            local.on('error', error => fail(error, request, upstream))
            request.socket.once('close', () => local.destroy())
            proxy.emit('connection', local)
            request.socket.write(['HTTP/1.1 200 Connection Established', CRLF].join(CRLF))
            releaseSocket(upstream)
            active = {
              request,
              tunnel: true,
              writer: new PassThrough(),
              destroy () { local.destroy(); socket.destroy() }
            }
            active.writer.on('data', data => transport.push(data))
          } else {
            const writer = await requestTransformer(request)
            signal.throwIfAborted()
            writer.on('error', stop)
            writer.pipe(socket, { end: false })
            active = {
              request,
              writer,
              upgraded: false,
              destroy () { writer.destroy(); socket.destroy() },
              async finish () {
                if (!request.upgrade) {
                  const finished = once(writer, 'finish', { signal })
                  writer.end()
                  await finished
                }
                await responseDone
                if (request.upgrade && !this.upgraded) writer.end()
              }
            }
          }
          resolve(active)
        }
        if (upstream.reusedSocket) connected().catch(stop)
        else socket.once('connect', () => connected().catch(stop))
      })
    })
  }

  proxy.on('connection', socket => {
    track(socket)
    prepSocket(socket, proxy)
    const gate = new RequestGate(openRequest, maxHeaderSize)
    socket.requestGate = gate
    socket.mirror.pipe(gate)
    gate.on('error', error => fail(error, gate.currentRequest || gate.requests[0]))
    socket.once('close', () => gate.destroy())
  })
  const enqueue = request => {
    request.socket.requestGate.addRequest(request)
    // Upgrade/CONNECT parsing detaches Node's parser and clears flowing state.
    request.socket.resume()
    request.resume()
  }
  proxy.on('request', enqueue)
  proxy.on('connect', enqueue)
  proxy.on('upgrade', enqueue)
  proxy.on('checkContinue', enqueue)
  proxy.on('checkExpectation', enqueue)
  proxy.on('clientError', (error, socket) => {
    socket.requestGate?.destroy()
    proxy.emit('error', error, null, { socket })
    socket.end()
  })
  proxy.destroyConnections = () => {
    for (const socket of sockets) socket.destroy()
    for (const agent of Object.values(agents)) agent.destroy()
  }
  proxy.on('close', proxy.destroyConnections)
  return proxy
}
