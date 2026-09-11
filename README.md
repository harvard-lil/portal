# Portal

[![npm version](https://badge.fury.io/js/@harvard-lil%2Fportal.svg)](https://badge.fury.io/js/@harvard-lil%2Fportal) [![JavaScript Style Guide](https://img.shields.io/badge/code_style-standard-brightgreen.svg)](https://standardjs.com) [![Linting](https://github.com/harvard-lil/portal/actions/workflows/lint.yml/badge.svg?branch=main)](https://github.com/harvard-lil/portal/actions/workflows/lint.yml) [![Test suite](https://github.com/harvard-lil/portal/actions/workflows/test.yml/badge.svg?branch=main)](https://github.com/harvard-lil/portal/actions/workflows/test.yml)

> 🚧 Work-in-progress 

HTTP proxy implementation using Node.js' [http.createServer](https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener) to accept connections and [http(s).request](https://nodejs.org/api/http.html#httprequestoptions-callback) to relay them to their destinations. Currently in use on [@harvard-lil/scoop](https://github.com/harvard-lil/scoop).

## Philosophy

Portal uses standard Node.js networking components in order to provide a simple proxy with the following goals:

- No dependencies
- Interfaces that match existing Node.js conventions
- The ability to intercept raw traffic

Portal achieves this by using "mirror" streams that buffer the data from each socket, allowing Node.js' standard parsing mechanism to parse the data while making that same raw data available for modification before being passed forward in the proxy.

## Configuration

The entrypoint for Portal is the `createServer` function which, in addition to the options available to [`http.createServer`](https://nodejs.org/api/http.html#httpcreateserveroptions-requestlistener), also accepts the following:

- `authorizeRequest(request, signal)` - authorize the destination and return an approved destination object (or `Promise`), as described below. Runs before connecting or reusing a socket for each request, including CONNECT and decrypted requests inside its tunnel. Throw or reject to deny, and respect the abort signal during asynchronous work.
- `verifyPeer(socket, destination)` - verify the connected peer against the approved destination. Runs on new and reused sockets and is awaited before forwarding HTTP bytes. Throw or reject to deny; returning `false` does not deny.
- `clientOptions(request)` - a function which accepts the request [`http.IncomingMessage`](https://nodejs.org/api/http.html#class-httpincomingmessage) and returns an options object (or `Promise`) to be passed to [`new tls.TLSSocket`](https://nodejs.org/api/tls.html#new-tlstlssocketsocket-options) when the client socket is upgraded after an HTTP `CONNECT` request. Most useful for dynamically generating a `key` / `cert` pair for the requested server name.
- `serverOptions(request)` - a function which accepts the request [`http.IncomingMessage`](https://nodejs.org/api/http.html#class-httpincomingmessage) and returns an options object (or `Promise`) to be passed to [`http(s).request`](https://nodejs.org/api/http.html#httprequestoptions-callback) which will then be used to make requests to the destination. Most useful for setting SSL flags.
- `requestTransformer(request)` - a function which accepts the request [`http.IncomingMessage`](https://nodejs.org/api/http.html#class-httpincomingmessage) and returns a [`stream.Transform`](https://nodejs.org/api/stream.html#class-streamtransform) instance (or `Promise`) through which the incoming request data will be passed before being forwarded to its destination.
- `responseTransformer(response, request)` - a function which accepts the response and request [`http.IncomingMessages`](https://nodejs.org/api/http.html#class-httpincomingmessage) and returns a [`stream.Transform`](https://nodejs.org/api/stream.html#class-streamtransform) instance (or `Promise`) through which the incoming response data will be passed before being forwarded to its destination.

### Destination authorization

`createServer()` permits all valid HTTP(S) destinations by default. Its default authorization resolves each hostname once per request and pins the selected address; its default peer verification checks that the connected address matches.

Either callback may be supplied independently to customize policy. To restrict destinations, supply an `authorizeRequest` callback. Portal awaits custom callbacks and stops forwarding when they throw or reject. The exported `requestUrl(request)` function returns a validated HTTP(S) URL string with consistent request-target, Host and CONNECT authorities.

`authorizeRequest` returns:

| Field | Description |
| --- | --- |
| `url` | Validated HTTP(S) `URL` for this request; use `new URL(requestUrl(request))`. |
| `hostname` | Destination hostname without IPv6 brackets. |
| `address` | Approved IP address; also partitions pooled connections. |
| `family` | Address family, `4` or `6`. |
| `lookup` | Node-compatible lookup callback pinned to the approved address. Support `options.all` and invoke the callback asynchronously. |
| `signal` | Optional policy lifetime `AbortSignal`; checked before dialing and forwarding. |

For hostname destinations, resolve and approve an address during authorization, return a pinned lookup without resolving again, and verify the actual peer. Assigning `address` alone does not pin DNS. Portal uses these fields to control routing and pooling; `serverOptions` supplies other upstream options, including TLS verification settings.

The options and transformer callbacks are trusted application code. Request and response transformers default to `PassThrough` and receive raw bytes after transport checks. Any changes to authority or framing must remain consistent with the approved destination and message boundaries. The bundled interception certificate/key are public fixtures; use `clientOptions` to supply an appropriate certificate and key for the deployment.

## Events

The proxy server returned by `createServer` emits:

- All of the events available on [`http.Server`](https://nodejs.org/api/http.html#class-httpserver). Ex: `proxy.on('request', (request) => {})`
- A `response(response, request)` event for an upstream response. Ex: `proxy.on('response', (response, request) => {})`
  NOTE: The `upgrade` event is emitted as `upgrade-client` in order to avoid a collision with the `http.Server` event of the same name.
- A `connected(socket, request)` event after peer verification, including connection reuse
- `error(error, upstream, request)` events for transport failures; the latter arguments may be absent. Attach an error listener. An error response must not be inserted after a response has begun.

Call `proxy.destroyConnections()` to terminate owned connections and pending request work, then `proxy.close()` to stop listening. The server's `close` event also cleans up its connections and agents. Each proxy owns its connection pools.

## Forwarding behavior

Portal pairs raw request and response boundaries with Node's parsed metadata. With pass-through transforms, allowed messages retain their original request targets, header spelling/spacing/duplicates, bodies, chunk extensions, trailers, HTTP versions and response reason phrases.

- Request-target, Host and CONNECT authorities must agree. Malformed authorities and destination port zero are rejected. Inner CONNECT requests must retain the tunnel authority; an approved TLS preflight precedes their authorization.
- Framing requires CRLF and an unambiguous Content-Length or `chunked` Transfer-Encoding. Header-byte limits apply to incomplete headers, chunk-size lines and trailers; the header-count cutoff is disabled so parsed fields are not silently omitted.
- Pipelined requests are authorized and forwarded sequentially, with connection reuse after both parsed and raw response completion. Servers that wait for a later pipelined request before answering an earlier one can stall.
- Informational responses precede the final response. Bodyless and close-delimited responses follow their HTTP semantics. Surplus final-response bytes close the upstream connection.
- Upgrade handshakes are checked; opaque client bytes wait for an upstream 101. URL policy does not inspect messages within an upgraded protocol. Declined or unsolicited upgrades close the downstream connection.

Applications supply their own capture limits and process isolation; these checks do not guarantee resistance to resource exhaustion.

## Example

```js
import * as http from 'http'
import * as crypto from 'node:crypto'
import { TLSSocket } from 'tls'
import { Transform } from 'node:stream'
import { createServer } from './Portal.js'

const PORT = 1337
const HOST = '127.0.0.1'

const proxy = createServer({
  requestTransformer: (request) => new Transform({
    transform: (chunk, _encoding, callback) => {
      console.log('Raw data to be passed in the request', chunk.toString())
      callback(null, chunk)
    }
  }),
  responseTransformer: (response, request) => new Transform({
    transform: (chunk, _encoding, callback) => {
      console.log('Raw data to be passed in the response', chunk.toString())
      callback(null, chunk)
    }
  }),
  clientOptions: async (request) => {
    return {} // a custom key and cert could be returned here
  },
  serverOptions: async (request) => {
    return {
      // This flag allows legacy insecure renegotiation between OpenSSL and unpatched servers
      // @see {@link https://stackoverflow.com/questions/74324019/allow-legacy-renegotiation-for-nodejs}
      secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT
    }
  }
})

proxy.on('request', (request) => {
  console.log('Parsed request to observe', request.headers)
})

proxy.on('response', (response, request) => {
  console.log('Parsed response to observe', response.headers)
})

proxy.on('error', (err) => {
  console.log('Handle error', err)
})

proxy.listen(PORT, HOST)

/*
 * Make an example request
 */
proxy.on('listening', () => {
  const options = {
    port: PORT,
    host: HOST,
    method: 'CONNECT',
    path: 'example.com:443'
  }

  const req = http.request(options)
  req.end()

  req.on('connect', (res, socket, head) => {
    const upgradedSocket = new TLSSocket(socket, {
      rejectUnauthorized: false,
      requestCert: false,
      isServer: false
    })

    upgradedSocket.write('GET / HTTP/1.1\r\n' +
      'Host: example.com:443\r\n' +
      'Connection: close\r\n' +
      '\r\n')
  })
})

```

## Development

Run `npm ci`, `npm run lint` and `npm test`.
