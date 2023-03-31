import * as http from 'http'
import * as https from 'https'
import { TLSSocket } from 'tls'
import { URL } from 'url'
import { PassThrough } from 'node:stream'

const CONNECT = 'CONNECT'
const UNKNOWN_PROTOCOL = 'unknown:'
const RELEASE_SOCKET = 'release-socket'
const CRLF = '\r\n'

const httpAgent = new http.Agent({ keepAlive: true })
const httpsAgent = new https.Agent({ keepAlive: true })

const proxyDefaults = {
  requestTransformer: (_request) => new PassThrough(),
  responseTransformer: (_response, _request) => new PassThrough(),
  clientOptions: (_request) => { return {} },
  serverOptions: (_request) => { return {} },
  keepAlive: true
}

const clientDefaults = {
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
    // This is necessary either when the socket has gone back into the agent pool
    // or in these cases; unclear which
    // @see {@link https://github.com/nodejs/node/blob/38b6ecc12e9d3458205da8c4c698cf127590c8b6/lib/_http_client.js#L721-L722}
    // @see {@link https://github.com/nodejs/node/blob/6311de332223e855e7f1ce03b7c920f51f308e95/lib/_http_client.js#L861-L862}
    socket.on('error', err => {
      if (socket.listenerCount('error') === 1) {
        proxy.emit('error', err, socket)
      }
    })
  } else {
    // Sockets are reused for subsequent requests, so previous pipes must be cleared.
    // Failure to do so will cause the wrong request object to be passed to the transformers
    socket.mirror.unpipe()
    socket.mirror.transformer?.unpipe()

    /**
     * Ensure the socket remains flowing.
     * The 'upgrade' event will remove http.Server's event listeners and, in the process,
     * assume that there are no other listeners and set socket.readableFlowing === null even
     * though the pipe to mirror is still attached
     * @see {@link https://nodejs.org/api/stream.html#three-states}
     * @see {@link https://nodejs.org/api/http.html#event-upgrade_1}
     */
    socket.resume()
  }
}

function getServerDefaults (request) {
  const url = new URL(
    request.method === CONNECT || request.url.startsWith('/')
      ? `${UNKNOWN_PROTOCOL}//${request.headers.host || request.url}`
      : request.url
  )
  const protocol = url.protocol === UNKNOWN_PROTOCOL && (request.method === CONNECT || request.socket instanceof TLSSocket)
    ? 'https:'
    : 'http:'
  return {
    host: url.hostname,
    servername: url.hostname,
    port: parseInt(url.port) || (protocol === 'https:' ? 443 : 80),
    agent: protocol === 'https:' ? httpsAgent : httpAgent
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
      : createConnection(...args)
    req.agent.createSocket(null, { socket, servername: 'bypass' }, () => {})
  } finally {
    req.agent.createConnection = createConnection
  }
}

async function getServerRequest (clientRequest, serverOptions) {
  const customOptions = await serverOptions(clientRequest)
  const options = { ...getServerDefaults(clientRequest), ...customOptions }

  const httpModule = options.agent === httpsAgent ? https : http
  return httpModule.request(options)
}

function getResponseHandler (event, proxy, clientRequest, responseTransformer) {
  return async (serverResponse, _, head) => {
    // Early exit if this is a fabricated response to get Node to release the socket
    if (serverResponse.headers.upgrade === RELEASE_SOCKET) return

    const { socket: serverSocket } = serverResponse
    prepSocket(serverSocket, proxy)

    // Emit a response event on the http.Server instance to allow a similar interface as server.on('request')
    proxy.emit(event, serverResponse, clientRequest)

    /**
     * req.emit('finish') be called to release the socket back into the agent pool.
     * Needed since we never call `req.end()` and instead just pipe data through the socket.
     * Node's `res.on('end')` handler will set `req._ended = true` which the
     * `req.on('finish')` handler uses to determine whether to send the socket back to the pool.
     * @see {@link https://github.com/nodejs/node/blob/c5881458106487f80d31513096b4d0baa88828b8/lib/_http_client.js#L748}
     * @see {@link https://github.com/nodejs/node/blob/c5881458106487f80d31513096b4d0baa88828b8/lib/_http_client.js#L786}
     *
     * NOTE: req will be undefined for 'upgrade' requests which is fine
     * since the socket shouldn't be returned to the pool in that event, anyway
     */
    serverResponse.on('end', () => serverResponse.req?.emit('finish'))

    // On response, forward the original server response on to the client.
    // TODO: figure out why clientSocket doesn't play well with backpressure hence the need for on('data') instead of pipe
    serverSocket.mirror.transformer = responseTransformer(serverResponse, clientRequest)
    serverSocket.mirror.pipe(serverSocket.mirror.transformer).on('data', data => clientRequest.socket.write(data))

    // response must be fully consumed else response.socket listeners won't get all of the chunks.
    // @see {@link https://nodejs.org/api/http.html#class-httpclientrequest}
    serverResponse.resume()
  }
}

function getRequestHandler (proxy, clientOptions, serverOptions, requestTransformer, responseTransformer) {
  return async (clientRequest, _, head) => {
    const { socket: clientSocket } = clientRequest
    prepSocket(clientSocket, proxy)

    const serverRequest = await getServerRequest(clientRequest, serverOptions)

    serverRequest
      .on('error', err => proxy.emit('error', err, serverRequest, clientRequest))
      .on('socket', async serverSocket => {
        prepSocket(serverSocket, proxy)

        const onSocketConnect = async () => {
          proxy.emit('connected', serverSocket, clientRequest)
          if (serverSocket.destroyed) return // serverSocket may be destroyed via a 'connected' event listener
          if (clientRequest.method === CONNECT) {
            // Replace old net.Socket with new tls.Socket and attach parser and event listeners
            // @see {@link https://nodejs.org/api/http.html#event-connection}
            const options = await clientOptions(clientRequest)
            proxy.emit('connection', new TLSSocket(clientSocket, { ...clientDefaults, ...options, isServer: true }))

            // Let the client know we've made the connection @see {@link https://reqbin.com/Article/HttpConnect}
            clientSocket.write(['HTTP/1.1 200 Connection Established', CRLF].join(CRLF))
            serverSocket.write(head)
            releaseSocket(serverRequest)
          } else {
            clientSocket.mirror.transformer = requestTransformer(clientRequest)
            clientSocket.mirror.pipe(clientSocket.mirror.transformer).pipe(serverSocket, { end: false })
          }
        }

        if (serverRequest.reusedSocket) await onSocketConnect()
        else serverSocket.on('connect', onSocketConnect)
      })
      .on('upgrade',     getResponseHandler('upgrade-client', proxy, clientRequest, responseTransformer))
      .on('connect',     getResponseHandler('connect',        proxy, clientRequest, responseTransformer))
      .on('continue',    getResponseHandler('continue',       proxy, clientRequest, responseTransformer))
      .on('information', getResponseHandler('information',    proxy, clientRequest, responseTransformer))
      .on('response',    getResponseHandler('response',       proxy, clientRequest, responseTransformer))
    // Ensure the entire request can be consumed. This isn't documented but is here
    // on the suspicion that it functions similarly to response, as documented above.
    clientRequest.resume()
  }
}

function getConnectionHandler (proxy) {
  return (socket) => prepSocket(socket, proxy)
}

/**
 * Removes any remaining sockets still open due to keep-alive
 */
function closeHandler () {
  httpAgent.destroy()
  httpsAgent.destroy()
}

/**
 * Creates a new proxy using the provided options.
 * Returns an instance of http.Server which can be started
 * using the standard listen() method.
 *
 * @param {?object} options
 * @param {?(request:http.IncomingMessage) => stream.Duplex} options.requestTransformer - A function which receives the parsed request headers and returns a duplex stream through which the request chunks will be piped before being passed along to the receiving server. Most likely you'll want to return a custom stream.Transform instance. stream.PassThrough is used by default.
 * @param {?(response:http.IncomingMessage, request:http.IncomingMessage) => stream.Duplex} options.responseTransformer - A function which receives the parsed response and request headers and returns a duplex stream through which the response chunks will be piped before being passed along to the client. Most likely you'll want to return a custom stream.Transform instance. stream.PassThrough is used by default.
 * @param {?(request:http.IncomingMessage) => Promise<object>|object} clientOptions - A function which receives the parsed request headers and returns options to be fed into the creation of a new client tls.TLSSocket. Primarily useful to generate a key and cert. Optionally can return a Promise. @see {@link https://nodejs.org/api/tls.html#class-tlstlssocket}
  * @param {?(request:http.IncomingMessage) => Promise<object>|object} serverOptions - A function which receives the parsed request headers and returns options to be fed into the request to the destination server. Primarily useful for setting SSL flags. Optionally can return a Promise. @see {@link https://nodejs.org/api/https.html#httpsrequestoptions-callback}
 * @returns {http.Server}
 */
export function createServer (options) {
  // Filter options and backfill with defaults.
  const {
    requestTransformer,
    responseTransformer,
    clientOptions,
    serverOptions,
    ...passalongOptions
  } = { ...proxyDefaults, ...options }

  const proxy = http.createServer(passalongOptions)
  const connectionHandler = getConnectionHandler(proxy)
  const requestHandler = getRequestHandler(proxy, clientOptions, serverOptions, requestTransformer, responseTransformer)

  proxy
    .on('connection',       connectionHandler)
    .on('close',            closeHandler)
    .on('connect',          requestHandler)
    .on('upgrade',          requestHandler)
    .on('checkContinue',    requestHandler)
    .on('checkExpectation', requestHandler)
    .on('request',          requestHandler)

  return proxy
}
