import { Writable } from 'node:stream'
import { maxHeaderSize as defaultMaxHeaderSize } from 'node:http'
import { headerEnd, messageFraming, validateHeaderLines, chunkSize } from './framing.js'

/** Forward the original bytes of one parsed response, including its 1xx prefix. */
export class ResponseGate extends Writable {
  constructor (request, send, maxHeaderSize = defaultMaxHeaderSize) {
    super()
    this.request = request
    this.send = send
    this.maxHeaderSize = maxHeaderSize
    this.messages = []
    this.pending = Buffer.alloc(0)
    this.state = 'headers'
    this.done = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject })
    this.done.catch(() => {})
  }

  addResponse (response, upgrade = false) {
    this.messages.push({ response, upgrade })
  }

  _write (data, encoding, callback) {
    this.consume(data).then(() => {
      callback()
      // Drain any writes queued while an asynchronous transformer was running
      // before releasing the next request. Keep the gate attached while idle.
      queueMicrotask(() => {
        if (!this.destroyed && !this.writableLength && ['complete', 'opaque'].includes(this.state)) this.resolve()
      })
    }, callback)
  }

  _final (callback) {
    if (this.state === 'close-body') this.state = 'complete'
    if (!['complete', 'opaque'].includes(this.state)) callback(new Error('Truncated upstream response'))
    else { this.resolve(); callback() }
  }

  _destroy (error, callback) {
    if (error) this.reject(error)
    callback(error)
  }

  async consume (data) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : data
    while (this.pending.length && !this.destroyed) {
      if (this.state === 'complete') throw new Error('Unsolicited bytes after upstream response')
      if (this.state === 'opaque' || this.state === 'close-body') {
        const bytes = this.pending
        this.pending = Buffer.alloc(0)
        await this.send(bytes)
      } else if (this.state === 'headers') {
        const end = headerEnd(this.pending, false, this.maxHeaderSize)
        if (end < 0) return
        // On a reused socket the mirror's data listener precedes Node's new
        // parser listener. Let that same data event finish before comparing.
        await Promise.resolve()
        if (this.destroyed) return
        const parsed = this.messages.shift()
        if (!parsed) throw new Error('Response framing disagrees with HTTP parser')
        const { response, upgrade } = parsed
        const headers = this.pending.subarray(0, end)
        validateHeaderLines(headers)
        const status = /^HTTP\/1\.[01] ([0-9]{3})(?: |\r)/.exec(headers.toString('latin1'))
        if (!status || Number(status[1]) !== response.statusCode) throw new Error('Response status disagrees with HTTP parser')
        const framing = messageFraming(response)
        const code = response.statusCode
        if ((code < 200 || code === 204) && (framing.chunked || framing.length !== null)) {
          throw new Error('Framing fields on a bodyless response')
        }
        if (code === 101) {
          if (!upgrade || !this.request.upgrade) throw new Error('Unsolicited protocol upgrade')
          this.state = 'opaque'
        } else if (code < 200) this.state = 'headers'
        else if (this.request.method === 'HEAD' || code === 204 || code === 304) this.state = 'complete'
        else if (framing.chunked) this.state = 'chunk-size'
        else if (framing.length !== null) {
          this.remaining = framing.length
          this.state = this.remaining ? 'body' : 'complete'
        } else {
          this.closeDelimited = true
          this.state = 'close-body'
        }
        this.pending = this.pending.subarray(end)
        await this.send(headers)
      } else if (this.state === 'body' || this.state === 'chunk-body') {
        const count = Number(this.remaining < BigInt(this.pending.length) ? this.remaining : BigInt(this.pending.length))
        const bytes = this.pending.subarray(0, count)
        this.pending = this.pending.subarray(count)
        this.remaining -= BigInt(count)
        await this.send(bytes)
        if (!this.remaining) this.state = this.state === 'body' ? 'complete' : 'chunk-end'
      } else if (this.state === 'chunk-size' || this.state === 'chunk-end') {
        const end = this.pending.indexOf(10)
        if (end < 0) {
          if (this.pending.length > (this.state === 'chunk-end' ? 1 : this.maxHeaderSize)) throw new Error('Invalid chunk framing')
          return
        }
        const line = this.pending.subarray(0, end + 1)
        if (this.state === 'chunk-size') {
          this.remaining = chunkSize(line, this.maxHeaderSize)
          this.state = this.remaining ? 'chunk-body' : 'trailers'
        } else {
          if (!line.equals(Buffer.from('\r\n'))) throw new Error('Invalid chunk terminator')
          this.state = 'chunk-size'
        }
        this.pending = this.pending.subarray(end + 1)
        await this.send(line)
      } else if (this.state === 'trailers') {
        const end = headerEnd(this.pending, true, this.maxHeaderSize)
        if (end < 0) return
        const trailers = this.pending.subarray(0, end)
        validateHeaderLines(trailers, true)
        this.pending = this.pending.subarray(end)
        this.state = 'complete'
        await this.send(trailers)
      }
    }
  }
}
