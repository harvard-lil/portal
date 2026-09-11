import test from 'node:test'
import assert from 'node:assert/strict'
import { finished } from 'node:stream/promises'

import { ResponseGate } from './ResponseGate.js'

const request = { method: 'GET', upgrade: false }

function response (statusCode, rawHeaders = []) {
  return { statusCode, rawHeaders }
}

function createGate (messages, send = async () => {}, requestOverrides = {}) {
  const gate = new ResponseGate({ ...request, ...requestOverrides }, send)
  for (const message of messages) gate.addResponse(message.response, message.upgrade)
  return gate
}

async function writeAll (gate, chunks) {
  const completed = finished(gate)
  for (const chunk of chunks.slice(0, -1)) {
    await new Promise((resolve, reject) => gate.write(chunk, error => error ? reject(error) : resolve()))
  }
  gate.end(chunks.at(-1))
  await completed
  await gate.done
}

test('preserves informational and chunked final responses at every split boundary', async () => {
  const raw = Buffer.from(
    'HTTP/1.1 103 Early Hints\r\n' +
    'Link: </style.css>; rel=preload\r\n' +
    '\r\n' +
    'HTTP/1.1 200 OK\r\n' +
    'Transfer-Encoding: chunked\r\n' +
    'Trailer: X-Trail\r\n' +
    '\r\n' +
    '03;foo=bar\r\n' +
    'abc\r\n' +
    '0;done=yes\r\n' +
    'X-Trail:   tail   \r\n' +
    '\r\n'
  )
  const messages = [
    { response: response(103, ['Link', '</style.css>; rel=preload']), upgrade: false },
    {
      response: response(200, [
        'Transfer-Encoding', 'chunked',
        'Trailer', 'X-Trail'
      ]),
      upgrade: false
    }
  ]

  for (let split = 0; split <= raw.length; split++) {
    const forwarded = []
    const gate = createGate(messages, async bytes => forwarded.push(Buffer.from(bytes)))
    await writeAll(gate, [raw.subarray(0, split), raw.subarray(split)])
    assert.ok(Buffer.concat(forwarded).equals(raw), `response changed at split offset ${split}`)
  }
})

test('queued surplus bytes reject done while send is asynchronous', async () => {
  const raw = Buffer.from('HTTP/1.1 204 No Content\r\nDate: now\r\n\r\n')
  const surplus = Buffer.from('HTTP/1.1 200 unsolicited\r\n\r\n')
  const forwarded = []
  let releaseSend
  let sendStarted
  const started = new Promise(resolve => { sendStarted = resolve })
  const blocked = new Promise(resolve => { releaseSend = resolve })
  const gate = createGate([
    { response: response(204, ['Date', 'now']), upgrade: false }
  ], async bytes => {
    forwarded.push(Buffer.from(bytes))
    sendStarted()
    await blocked
  })
  const completed = finished(gate)

  gate.write(raw)
  gate.end(surplus)
  await started
  releaseSend()

  await assert.rejects(gate.done, /Unsolicited bytes after upstream response/)
  await assert.rejects(completed, /Unsolicited bytes after upstream response/)
  assert.ok(Buffer.concat(forwarded).equals(raw))
})

test('rejects truncated fixed-length and chunked response bodies', async () => {
  const cases = [
    {
      raw: Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nab'),
      response: response(200, ['Content-Length', '3'])
    },
    {
      raw: Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nab'),
      response: response(200, ['Transfer-Encoding', 'chunked'])
    },
    {
      raw: Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Trail: incomplete'),
      response: response(200, ['Transfer-Encoding', 'chunked'])
    }
  ]

  for (const fixture of cases) {
    const gate = createGate([{ response: fixture.response, upgrade: false }])
    const completed = finished(gate)
    gate.end(fixture.raw)
    await assert.rejects(gate.done, /Truncated upstream response/)
    await assert.rejects(completed, /Truncated upstream response/)
  }
})

test('does not forward invalid chunk framing bytes', async () => {
  const header = Buffer.from('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n')
  const cases = [
    {
      raw: Buffer.concat([header, Buffer.from('Z\r\n')]),
      expected: header,
      error: /Invalid chunk framing/
    },
    {
      raw: Buffer.concat([header, Buffer.from('1\r\naX\r\n')]),
      expected: Buffer.concat([header, Buffer.from('1\r\na')]),
      error: /Invalid chunk terminator/
    },
    {
      raw: Buffer.concat([header, Buffer.from('0\r\nBad trailer\r\n\r\n')]),
      expected: Buffer.concat([header, Buffer.from('0\r\n')]),
      error: /Ambiguous header field syntax/
    }
  ]

  for (const fixture of cases) {
    const forwarded = []
    const gate = createGate([
      { response: response(200, ['Transfer-Encoding', 'chunked']), upgrade: false }
    ], async bytes => forwarded.push(Buffer.from(bytes)))
    const completed = finished(gate)
    gate.end(fixture.raw)
    await assert.rejects(gate.done, fixture.error)
    await assert.rejects(completed, fixture.error)
    assert.ok(Buffer.concat(forwarded).equals(fixture.expected))
  }
})

test('completes final bodyless responses without consuming following bytes', async () => {
  const fixtures = [
    {
      method: 'GET',
      raw: Buffer.from('HTTP/1.1 204 No Content\r\nDate: now\r\n\r\n'),
      response: response(204, ['Date', 'now'])
    },
    {
      method: 'HEAD',
      raw: Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n'),
      response: response(200, ['Content-Length', '12'])
    },
    {
      method: 'GET',
      raw: Buffer.from('HTTP/1.1 304 Not Modified\r\nContent-Length: 12\r\n\r\n'),
      response: response(304, ['Content-Length', '12'])
    }
  ]

  for (const fixture of fixtures) {
    const forwarded = []
    const gate = createGate([
      { response: fixture.response, upgrade: false }
    ], async bytes => forwarded.push(Buffer.from(bytes)), { method: fixture.method })
    await writeAll(gate, [fixture.raw])
    assert.ok(Buffer.concat(forwarded).equals(fixture.raw))
  }
})

test('close-delimited response completes only when the stream ends', async () => {
  const raw = Buffer.from('HTTP/1.1 200 OK\r\nDate: now\r\n\r\nclose-delimited body')
  const forwarded = []
  const gate = createGate([
    { response: response(200, ['Date', 'now']), upgrade: false }
  ], async bytes => forwarded.push(Buffer.from(bytes)))
  let settled = false
  gate.done.finally(() => { settled = true })

  await new Promise((resolve, reject) => gate.write(raw, error => error ? reject(error) : resolve()))
  await Promise.resolve()
  assert.equal(settled, false)

  const completed = finished(gate)
  gate.end()
  await completed
  await gate.done
  assert.equal(gate.closeDelimited, true)
  assert.ok(Buffer.concat(forwarded).equals(raw))
})
