import { maxHeaderSize } from 'node:http'

const framingFields = new Set(['content-length', 'transfer-encoding', 'host', 'connection', 'trailer'])

// Only accept framing with one interpretation at both ends of the raw stream.
export function messageFraming (message) {
  const fields = new Map()
  for (let i = 0; i < message.rawHeaders.length; i += 2) {
    const name = message.rawHeaders[i].toLowerCase()
    const values = fields.get(name) || []
    values.push(message.rawHeaders[i + 1])
    fields.set(name, values)
  }
  const lengths = fields.get('content-length') || []
  const encodings = fields.get('transfer-encoding') || []
  if (lengths.length > 1 || encodings.length > 1 || (lengths.length && encodings.length)) {
    throw new Error('Ambiguous message framing')
  }
  if (lengths.length && !/^(0|[1-9][0-9]*)$/.test(lengths[0])) throw new Error('Noncanonical Content-Length')
  if (encodings.length && !/^chunked$/i.test(encodings[0])) throw new Error('Unsupported transfer coding')
  for (const value of fields.get('connection') || []) {
    if (value.split(',').some(token => framingFields.has(token.trim().toLowerCase()))) {
      throw new Error('Connection nominates a framing field')
    }
  }
  return { chunked: !!encodings.length, length: lengths.length ? BigInt(lengths[0]) : null }
}

// Node's parsed events supply metadata; these checks delimit original bytes.
export function headerEnd (buffer, trailers = false, limit = maxHeaderSize) {
  let start = 0
  let started = trailers
  while (start < buffer.length) {
    const end = buffer.indexOf(10, start)
    if (end < 0) break
    if (end === start || buffer[end - 1] !== 13) throw new Error('HTTP framing requires CRLF')
    const empty = end === start + 1
    if (empty && started) {
      if (end + 1 > limit) throw new Error('Header block exceeds parser limit')
      return end + 1
    }
    if (!empty) started = true
    start = end + 1
  }
  if (buffer.length > limit) throw new Error('Header block exceeds parser limit')
  return -1
}

export function validateHeaderLines (bytes, trailers = false) {
  const lines = bytes.toString('latin1').split('\r\n')
  if (!trailers) {
    while (lines[0] === '') lines.shift()
    lines.shift() // Request/status line is validated by Node.
  }
  for (const line of lines) {
    if (!line) continue
    const field = /^([!#$%&'*+.^_`|~0-9a-z-]+):/i.exec(line)
    if (!field) throw new Error('Ambiguous header field syntax')
    if (trailers && framingFields.has(field[1].toLowerCase())) throw new Error('Framing field in trailers')
  }
}

export function chunkSize (line, limit = maxHeaderSize) {
  const size = /^([0-9a-f]+)(?:;[^\r\n]*)?\r\n$/i.exec(line.toString('latin1'))
  if (!size || line.length > limit) throw new Error('Invalid chunk framing')
  return BigInt('0x' + size[1])
}
