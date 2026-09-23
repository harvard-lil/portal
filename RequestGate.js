import { Writable } from 'node:stream'
import { once } from 'node:events'
import { maxHeaderSize as defaultMaxHeaderSize } from 'node:http'
import { headerEnd, messageFraming, validateHeaderLines, chunkSize } from './framing.js'

/**
 * Frame requests without reconstructing them. Node's HTTP parser supplies the
 * interpreted framing headers; this gate supplies the exact original byte ranges.
 * One response must finish before the next request is released upstream.
 */
export class RequestGate extends Writable {
  constructor (openRequest, maxHeaderSize = defaultMaxHeaderSize) {
    super()
    this.openRequest = openRequest
    this.maxHeaderSize = maxHeaderSize
    this.requests = []
    this.pending = Buffer.alloc(0)
    this.state = 'headers'
    this.remaining = 0n
    this.abortController = new AbortController()
  }

  addRequest (request) {
    this.requests.push(request)
  }

  _write (data, encoding, callback) {
    this.consume(data).then(() => callback(), callback)
  }

  _destroy (error, callback) {
    this.abortController.abort()
    this.active?.destroy()
    callback(error)
  }

  async send (data) {
    if (!data.length) return
    if (this.destroyed) throw new Error('Client connection closed')
    if (!this.active.writer.write(data)) await once(this.active.writer, 'drain', { signal: this.abortController.signal })
  }

  async finishMessage () {
    const active = this.active
    await active.finish()
    if (this.destroyed) throw new Error('Client connection closed')
    if (active.upgraded) {
      this.state = 'opaque'
    } else if (active.request.upgrade || active.close) {
      // Node detaches its downstream HTTP parser at an Upgrade request. A
      // declined upgrade cannot safely authorize more HTTP on that connection.
      this.state = 'closed'
      active.request.socket.end()
    } else {
      this.active = null
      this.state = 'headers'
    }
  }

  async consume (data) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data
    while (this.pending.length && !this.destroyed) {
      if (this.state === 'closed') { this.pending = Buffer.alloc(0); return }
      if (this.state === 'opaque') {
        const bytes = this.pending
        this.pending = Buffer.alloc(0)
        await this.send(bytes)
        return
      }
      if (this.state === 'headers') {
        const end = headerEnd(this.pending, false, this.maxHeaderSize)
        if (end < 0) {
          if (this.pending.length > this.maxHeaderSize) throw new Error('Request header exceeds parser limit')
          return
        }
        if (end > this.maxHeaderSize) throw new Error('Request header exceeds parser limit')
        const request = this.requests.shift()
        if (!request) throw new Error('Request framing disagrees with HTTP parser')
        this.currentRequest = request
        const headers = this.pending.subarray(0, end)
        this.pending = this.pending.subarray(end)
        validateHeaderLines(headers)
        const framing = messageFraming(request)
        if (request.method === 'CONNECT' && (framing.chunked || framing.length)) throw new Error('CONNECT cannot carry an HTTP body')
        this.active = await this.openRequest(request, this.abortController.signal)
        if (this.destroyed) { this.active.destroy(); return }
        if (this.active.tunnel) {
          this.state = 'opaque'
          continue
        }
        await this.send(headers)
        if (framing.chunked) {
          this.state = 'chunk-size'
        } else {
          this.remaining = framing.length || 0n
          if (this.remaining) this.state = 'body'
          else await this.finishMessage()
        }
      } else if (this.state === 'body' || this.state === 'chunk-body') {
        const count = Number(this.remaining < BigInt(this.pending.length) ? this.remaining : BigInt(this.pending.length))
        await this.send(this.pending.subarray(0, count))
        this.pending = this.pending.subarray(count)
        this.remaining -= BigInt(count)
        if (!this.remaining) {
          if (this.state === 'body') await this.finishMessage()
          else this.state = 'chunk-end'
        }
      } else if (this.state === 'chunk-size') {
        const end = this.pending.indexOf(10)
        if (end < 0) {
          if (this.pending.length > this.maxHeaderSize) throw new Error('Chunk line exceeds parser limit')
          return
        }
        const line = this.pending.subarray(0, end + 1)
        this.remaining = chunkSize(line, this.maxHeaderSize)
        await this.send(line)
        this.pending = this.pending.subarray(end + 1)
        this.state = this.remaining ? 'chunk-body' : 'trailers'
      } else if (this.state === 'chunk-end') {
        const end = this.pending.indexOf(10)
        if (end < 0) {
          if (this.pending.length > 1) throw new Error('Invalid chunk terminator')
          return
        }
        const line = this.pending.subarray(0, end + 1)
        if (!line.equals(Buffer.from('\r\n'))) throw new Error('Invalid chunk terminator')
        await this.send(line)
        this.pending = this.pending.subarray(end + 1)
        this.state = 'chunk-size'
      } else if (this.state === 'trailers') {
        const end = headerEnd(this.pending, true, this.maxHeaderSize)
        if (end < 0) {
          if (this.pending.length > this.maxHeaderSize) throw new Error('Trailers exceed parser limit')
          return
        }
        if (end > this.maxHeaderSize) throw new Error('Trailers exceed parser limit')
        validateHeaderLines(this.pending.subarray(0, end), true)
        await this.send(this.pending.subarray(0, end))
        this.pending = this.pending.subarray(end)
        await this.finishMessage()
      }
    }
  }
}
