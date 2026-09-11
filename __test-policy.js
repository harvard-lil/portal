import assert from 'node:assert/strict'
import { isIP } from 'node:net'

// Synthetic loopback policy for transport tests only. No DNS or production
// blocklist implementation: Scoop keeps its own policy integration tests.
export class TestPolicy {
  constructor (rules = [], onDenied = () => {}, { lookup } = {}) {
    this.rules = rules
    this.onDenied = onDenied
    this.lookup = lookup
    this.controller = new AbortController()
  }

  close () { this.controller.abort() }

  check (value) {
    const rule = this.rules.find(rule => rule === '127.0.0.0/8'
      ? value.startsWith('127.')
      : rule.startsWith('/')
        ? new RegExp(rule.slice(1, -1)).test(value)
        : value === rule)
    if (rule) {
      this.onDenied(value, rule)
      throw Object.assign(new Error('Fixture destination denied'), { code: 'ERR_NETWORK_POLICY' })
    }
  }

  async resolve (input, { signal } = {}) {
    signal?.throwIfAborted()
    this.controller.signal.throwIfAborted()
    const url = new URL(input)
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    this.check(url.href)
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await this.lookup(hostname)
    signal?.throwIfAborted()
    this.controller.signal.throwIfAborted()
    const { address, family } = addresses[0]
    assert.ok(['127.0.0.1', '127.0.0.2', '::1'].includes(address), 'Fixtures must stay on loopback')
    this.check(address)
    return {
      url,
      hostname,
      address,
      family,
      signal: this.controller.signal,
      lookup: (_hostname, options, callback) => queueMicrotask(() => {
        if (this.controller.signal.aborted) callback(this.controller.signal.reason)
        else if (options?.all) callback(null, [{ address, family }])
        else callback(null, address, family)
      })
    }
  }

  verifyPeer (socket, destination) {
    this.controller.signal.throwIfAborted()
    assert.equal(socket.remoteAddress.replace(/^::ffff:/, ''), destination.address)
  }
}
