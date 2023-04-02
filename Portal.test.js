import test from 'node:test'
import assert from 'node:assert/strict'
import { Transform } from 'node:stream'
import * as http from 'http'

import { createServer } from './Portal.js'

const PROXY_PORT = 1337
const PROXY_HOST = '127.0.0.1'

const SERVER_PORT = 3000
const SERVER_HOST = '127.0.0.1'

const runInProxy = async (options, cb) => {
  const proxy = createServer(options)
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(req.headers.echo)
  })

  await new Promise(resolve => proxy.listen(PROXY_PORT, PROXY_HOST, resolve))
  await new Promise(resolve => server.listen(SERVER_PORT, SERVER_HOST, resolve))

  await new Promise(resolve => cb(resolve, proxy))

  await new Promise(resolve => proxy.close(resolve))
  await new Promise(resolve => server.close(resolve))
}

const requestOptions = {
  port: PROXY_PORT,
  host: PROXY_HOST,
  path: `http://${SERVER_HOST}:${SERVER_PORT}`,
  headers: {
    host: SERVER_HOST,
    connection: 'close',
    echo: 'Hello world'
  }
}

test('createServer returns an instance of http.Server', async () => {
  assert.equal(createServer().constructor, http.Server)
})

await test('\'request\' event returns instance of http.IncomingMessage', async () => {
  await runInProxy({}, (resolve, proxy) => {
    proxy.on('request', (request) => {
      assert.equal(request.constructor, http.IncomingMessage)
    })
    http
      .get(requestOptions)
      .on('close', resolve)
  })
})

await test('\'response\' event returns instances of http.IncomingMessage', async () => {
  console.log('test start')
  await runInProxy({}, (resolve, proxy) => {
    proxy.on('response', (response, request) => {
      assert.equal(response.constructor, http.IncomingMessage)
      assert.equal(request.constructor, http.IncomingMessage)
    })
    http
      .get(requestOptions)
      .on('close', () => {
        console.log('close')
        resolve()
      })
      .on('error', (e) => {
        console.log('error')
      })
  })
})

await test('requestTransformer modifies the request', async () => {
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
      })
    })
    http
      .get(requestOptions)
      .on('close', resolve)
  })
})

await test('responseTransformer modifies the response', async () => {
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
      .on('close', resolve)
      .on('response', response => {
        response.on('data', data => {
          assert.equal(data.toString(), newEcho)
        })
      })
  })
})
