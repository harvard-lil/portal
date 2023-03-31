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

- `clientOptions(request)` - a function which accepts the request [`http.IncomingMessage`](https://nodejs.org/api/http.html#class-httpincomingmessage) and returns an options object (or `Promise`) to be passed to [`new tls.TLSSocket`](https://nodejs.org/api/tls.html#new-tlstlssocketsocket-options) when the client socket is upgraded after an HTTP `CONNECT` request. Most useful for dynamically generating a `key` / `cert` pair for the requested server name.
- `serverOptions(request)` - a function which accepts the request [`http.IncomingMessage`](https://nodejs.org/api/http.html#class-httpincomingmessage) and returns an options object (or `Promise`) to be passed to [`http(s).request`](https://nodejs.org/api/http.html#httprequestoptions-callback) which will then be used to make requests to the destination. Most useful for setting SSL flags.
- `requestTransformer(request)` - a function which accepts the request [`http.IncomingMessage`](https://nodejs.org/api/http.html#class-httpincomingmessage) and returns a [`stream.Transform`](https://nodejs.org/api/stream.html#class-streamtransform) instance (or `Promise`) through which the incoming request data will be passed before being forwarded to its destination.
- `responseTransformer(response, request)` - a function which accepts the response and request [`http.IncomingMessages`](https://nodejs.org/api/http.html#class-httpincomingmessage) and returns a [`stream.Transform`](https://nodejs.org/api/stream.html#class-streamtransform) instance (or `Promise`) through which the incoming response data will be passed before being forwarded to its destination.

## Events

The proxy server returned by `createServer` emits:

- All of the events available on [`http.Server`](https://nodejs.org/api/http.html#class-httpserver). Ex: `proxy.on('request', (request) => {})`
- All of the events from [`http.ClientRequest`](https://nodejs.org/api/http.html#class-httpclientrequest). Ex: `proxy.on('response', (response, request) => {})`  
  NOTE: The `upgrade` event is emitted as `upgrade-client` in order to avoid a collision with the `http.Server` event of the same name.
- A `connected` event when a connection is made in response to an HTTP `CONNECT` request
- `error` events from both `http.Server` and `http.ClientRequest`

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
