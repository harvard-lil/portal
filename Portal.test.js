import test from 'node:test'
import assert from 'node:assert/strict'
import * as http from 'http'
import { Transform } from 'node:stream'

import { createServer } from './Portal.js'

const PROXY_PORT = 1337
const PROXY_HOST = '127.0.0.1'

const SERVER_PORT = 3000
const SERVER_HOST = '127.0.0.1'

const runInProxy = async (options, cb) => {
  const proxy = createServer(options)
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
    host: SERVER_HOST,
    echo: 'Hello world'
  }
}

await test('Portal', async (t) => {
  /*
   * SETUP
   */
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(req.headers.echo)
  }).listen(SERVER_PORT)

  /*
   * TESTS
   */
  t.test('createServer returns an instance of http.Server', async () => {
    assert.equal(createServer().constructor, http.Server)
  })

  await t.test('\'request\' event returns instance of http.IncomingMessage', async () => {
    await runInProxy({}, (resolve, proxy) => {
      proxy.on('request', (request) => {
        assert.equal(request.constructor, http.IncomingMessage)
        resolve()
      })
      http.get(requestOptions)
    })
  })

  await t.test('\'response\' event returns instances of http.IncomingMessage', async () => {
    await runInProxy({}, (resolve, proxy) => {
      proxy.on('response', (response, request) => {
        assert.equal(response.constructor, http.IncomingMessage)
        assert.equal(request.constructor, http.IncomingMessage)
        resolve()
      })
      http.get(requestOptions)
    })
  })

  await t.test('requestTransformer modifies the request', async () => {
    const echo = requestOptions.headers.echo
    const newEcho = 'hELLO WORLD'

    const options = {
      requestTransformer: () => new Transform({
        transform: (chunk, _encoding, callback) => {
          callback(null, Buffer.from(chunk.toString().replace(echo, newEcho)))
        }
      }),
    }

    await runInProxy(options, (resolve, proxy) => {
      proxy.on('response', (response, request) => {
        assert.equal(request.headers.echo, echo)
        response.on('data', data => {
          assert.equal(data.toString(), newEcho)
          resolve()
        })
      })
      http.get(requestOptions)
    })
  })

  await t.test('responseTransformer modifies the response', async () => {
    const echo = requestOptions.headers.echo
    const newEcho = 'hELLO WORLD'

    const options = {
      responseTransformer: () => new Transform({
        transform: (chunk, _encoding, callback) => {
          callback(null, Buffer.from(chunk.toString().replace(echo, newEcho)))
        }
      }),
    }

    await runInProxy(options, (resolve, proxy) => {
      proxy.on('response', (_response, request) => {
        assert.equal(request.headers.echo, echo)
      })

      http
        .get(requestOptions)
        .on('response', response => {
          response.on('data', data => {
            assert.equal(data.toString(), newEcho)
            resolve()
          })
        })
    })
  })

  /*
   * TEARDOWN
   */
  server.close()
})
