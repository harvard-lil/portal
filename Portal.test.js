import test from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'

import { createServer } from './Portal.js'

const PROXY_PORT = 1337
const PROXY_HOST = '127.0.0.1'

const SERVER_PORT = 3000
const SERVER_HOST = '127.0.0.1'

const runInProxy = async (cb) => {
  const proxy = createServer()
  await new Promise(resolve => proxy.listen(PROXY_PORT, PROXY_HOST, resolve))
  await new Promise(resolve => cb(resolve, proxy))
  proxy.on('error', () => {}) // silence any socket closed errors before closeAllConnections()
  proxy.closeAllConnections()
  await new Promise(resolve => proxy.close(resolve))
}

const requestOptions = {
  port: PROXY_PORT,
  host: PROXY_HOST,
  path: `http://${SERVER_HOST}:${SERVER_PORT}`,
  headers: {
    Host: SERVER_HOST
  }
}

await test('Portal', async (t) => {
  /*
   * SETUP
   */
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('Hello world')
  }).listen(SERVER_PORT)

  /*
   * TESTS
   */
  t.test('createServer returns an instance of http.Server', async () => {
    assert.equal(createServer().constructor, http.Server)
  })

  await t.test('\'request\' event returns instance of http.IncomingMessage', async () => {
    await runInProxy((resolve, proxy) => {
      http.get(requestOptions)
      proxy.on('request', (request) => {
        assert(request.constructor, http.IncomingRequest)
        resolve()
      })
    })
  })

  await t.test('\'response\' event returns instances of http.IncomingMessage', async () => {
    await runInProxy((resolve, proxy) => {
      http.get(requestOptions)
      proxy.on('response', (response, request) => {
        assert(response.constructor, http.IncomingRequest)
        assert(request.constructor, http.IncomingRequest)
        resolve()
      })
    })
  })

  /*
   * TEARDOWN
   */
  server.close()
})
