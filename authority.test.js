import assert from 'node:assert/strict'
import test from 'node:test'
import { parseAuthority, requestUrl } from './authority.js'

function request (url, host, { method = 'GET' } = {}) {
  return {
    method,
    url,
    headers: host === undefined ? {} : { host },
    rawHeaders: host === undefined ? [] : ['Host', host]
  }
}

test('Host is validated as an authority before constructing an origin-form URL', () => {
  for (const host of [
    'fixture.invalid/safe',
    'user@fixture.invalid',
    'fixture.invalid?safe',
    'fixture.invalid#safe',
    'fixture.invalid\\safe',
    'fixture.invalid\t:80',
    'fixture.invalid\rignored',
    'fixture.invalid:',
    'fixture.invalid:0',
    'fixture.invalid:65536',
    'fixture.invalid:not-a-port',
    '[::1',
    '[127.0.0.1]:80'
  ]) {
    assert.throws(() => requestUrl(request('/blocked', host)), /Host authority/)
  }
})

test('absolute-form targets require canonical Host equality', () => {
  assert.throws(
    () => requestUrl(request('http://fixture.invalid/blocked', 'other.invalid')),
    /differs from absolute-form/
  )
  assert.throws(
    () => requestUrl(request('http://user@fixture.invalid/blocked', 'fixture.invalid')),
    /Absolute-form authority/
  )
  assert.throws(
    () => requestUrl(request('http://fixture.invalid\\@other.invalid/blocked', 'other.invalid')),
    /Request target/
  )
})

test('raw request targets reject bytes that URL parsing would remove or reinterpret', () => {
  for (const target of [
    '/safe\\blocked',
    '/safe#ignored',
    '/safe\tignored',
    'http://fixture.invalid/safe\\blocked',
    'http://fixture.invalid/safe#ignored'
  ]) {
    assert.throws(() => requestUrl(request(target, 'fixture.invalid')), /Request target/)
  }
  assert.equal(requestUrl(request('/safe?next=/blocked', 'fixture.invalid')), 'http://fixture.invalid/safe?next=/blocked')
})

test('CONNECT rejects ambiguous authorities and requires an explicit valid port', () => {
  for (const authority of [
    'fixture.invalid',
    'user@fixture.invalid:443',
    'fixture.invalid/safe:443',
    'fixture.invalid:0',
    'fixture.invalid:65536',
    'fixture.invalid:',
    'fixture.invalid:+443',
    '::1:443',
    '[::1:443',
    '[fixture.invalid]:443'
  ]) {
    assert.throws(() => requestUrl(request(authority, authority, { method: 'CONNECT' })), /authority|port|IPv6/i)
  }
  assert.throws(
    () => requestUrl(request('fixture.invalid:443', 'other.invalid:443', { method: 'CONNECT' })),
    /Conflicting CONNECT authority/
  )
})

test('valid authorities compare canonically across case, default ports, and IPv6 spellings', () => {
  const absolute = 'http://EXAMPLE.com:80/blocked'
  assert.equal(requestUrl(request(absolute, 'example.COM')), absolute)

  assert.equal(
    requestUrl(request('/path', '[0:0:0:0:0:0:0:1]:443'), {
      secure: true,
      tunnelAuthority: '[::1]'
    }),
    'https://[0:0:0:0:0:0:0:1]:443/path'
  )

  assert.equal(
    requestUrl(request('[0:0:0:0:0:0:0:1]:443', '[::1]', { method: 'CONNECT' })),
    'https://[::1]/'
  )
  assert.deepEqual(parseAuthority('EXAMPLE.com:00080'), {
    hostname: 'example.com',
    port: '',
    host: 'example.com',
    hasPort: true
  })
})

test('multiple Host fields and nested CONNECT are rejected', () => {
  const duplicate = request('/', 'fixture.invalid')
  duplicate.rawHeaders.push('host', 'fixture.invalid')
  assert.throws(() => requestUrl(duplicate), /Multiple Host/)
  assert.throws(
    () => requestUrl(request('fixture.invalid:443', 'fixture.invalid', { method: 'CONNECT' }), { tunnelAuthority: 'fixture.invalid' }),
    /Nested CONNECT/
  )
})

test('a tunnel permits only HTTPS targets even when HTTP default-port normalization produces the same host', () => {
  assert.throws(
    () => requestUrl(request('http://EXAMPLE.com:80/path', 'example.com'), {
      secure: true,
      tunnelAuthority: 'example.com:443'
    }),
    /differs from CONNECT tunnel/
  )
})
