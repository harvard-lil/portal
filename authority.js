import net from 'node:net'

const CONNECT = 'CONNECT'
const forbiddenAuthorityCharacters = new Set('%@/?#\\')
const schemePattern = /^[a-z][a-z0-9+.-]*:$/i

function authorityError (label, detail) {
  return new Error(`${label} ${detail}`)
}

function hasForbiddenAuthorityCharacter (input) {
  for (const character of input) {
    const code = character.codePointAt(0)
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || /\s/u.test(character) || forbiddenAuthorityCharacters.has(character)) return true
  }
  return false
}

function hasForbiddenTargetCharacter (input) {
  for (const character of input) {
    const code = character.codePointAt(0)
    if (code <= 0x20 || (code >= 0x7f && code <= 0x9f) || /\s/u.test(character) || character === '\\' || character === '#') return true
  }
  return false
}

/**
 * Validate and canonicalize an HTTP authority before URL parsing can reinterpret
 * any of its bytes as credentials, a path, a query, or a fragment.
 */
export function parseAuthority (input, { protocol = 'http:', requirePort = false, label = 'Authority' } = {}) {
  if (typeof input !== 'string' || input.length === 0) throw authorityError(label, 'must not be empty')
  if (!schemePattern.test(protocol)) throw new TypeError('Authority protocol must be an absolute-URL scheme')
  if (hasForbiddenAuthorityCharacter(input)) throw authorityError(label, 'contains a forbidden character')

  let hostname
  let port
  let hasPort = false
  if (input.startsWith('[')) {
    const close = input.indexOf(']')
    if (close === -1 || input.indexOf('[', 1) !== -1 || input.indexOf(']', close + 1) !== -1) {
      throw authorityError(label, 'has invalid brackets')
    }
    hostname = input.slice(1, close)
    const remainder = input.slice(close + 1)
    if (remainder !== '') {
      if (!remainder.startsWith(':')) throw authorityError(label, 'has invalid brackets')
      hasPort = true
      port = remainder.slice(1)
    }
    if (net.isIP(hostname) !== 6) throw authorityError(label, 'has an invalid IPv6 address')
  } else {
    if (input.includes('[') || input.includes(']')) throw authorityError(label, 'has invalid brackets')
    const colon = input.indexOf(':')
    if (colon !== -1) {
      if (input.indexOf(':', colon + 1) !== -1) throw authorityError(label, 'has an unbracketed IPv6 address')
      hostname = input.slice(0, colon)
      port = input.slice(colon + 1)
      hasPort = true
    } else {
      hostname = input
    }
  }

  if (hostname.length === 0) throw authorityError(label, 'must include a host')
  if (requirePort && !hasPort) throw authorityError(label, 'must include a port')
  if (hasPort) {
    if (!/^\d+$/.test(port)) throw authorityError(label, 'has an invalid port')
    const number = BigInt(port)
    if (number < 1n || number > 65535n) throw authorityError(label, 'has a port outside 1-65535')
  }

  const url = new URL(`${protocol}//${input}/`)
  if (!url.hostname || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw authorityError(label, 'is invalid')
  }
  return {
    hostname: url.hostname,
    port: url.port,
    host: url.host,
    hasPort
  }
}

function hostField (request) {
  const fields = []
  const rawHeaders = request.rawHeaders || []
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (String(rawHeaders[index]).toLowerCase() === 'host') fields.push(rawHeaders[index + 1])
  }
  if (fields.length > 1) throw new Error('Multiple Host fields are ambiguous')
  return fields.length === 1 ? fields[0] : request.headers?.host
}

function absoluteTarget (target) {
  const match = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([\s\S]*)$/i.exec(target)
  if (!match) throw new Error('Request target must use origin-form, absolute-form, or authority-form')
  const [, protocol, rawAuthority] = match
  const authority = parseAuthority(rawAuthority, { protocol, label: 'Absolute-form authority' })
  const url = new URL(target)
  if (url.host !== authority.host) throw new Error('Absolute-form authority is ambiguous')
  return { url, authority }
}

/**
 * Return the authorization URL represented by a parsed request. The caller
 * supplies transport state because a CONNECT-created TLSSocket is private to
 * Portal. Request bytes continue to be forwarded from the raw socket.
 */
export function requestUrl (request, { secure = false, tunnelAuthority } = {}) {
  if (typeof request.url !== 'string' || request.url.length === 0) throw new Error('Request target must not be empty')
  if (hasForbiddenTargetCharacter(request.url)) throw new Error('Request target contains a forbidden character')
  const host = hostField(request)
  if (host !== undefined && typeof host !== 'string') throw new Error('Host authority must be a string')

  if (request.method === CONNECT) {
    const target = parseAuthority(request.url, {
      protocol: 'https:',
      requirePort: true,
      label: 'CONNECT authority'
    })
    if (host !== undefined) {
      const header = parseAuthority(host, { protocol: 'https:', label: 'Host authority' })
      if (header.host !== target.host) throw new Error('Conflicting CONNECT authority')
    }
    if (tunnelAuthority !== undefined) throw new Error('Nested CONNECT is unsupported')
    return `https://${target.host}/`
  }

  const protocol = secure ? 'https:' : 'http:'
  const originForm = request.url.startsWith('/') || request.url === '*'
  let target
  let authority
  let targetProtocol
  if (originForm) {
    if (host === undefined) throw new Error('Origin-form requests require a Host authority')
    authority = parseAuthority(host, { protocol, label: 'Host authority' })
    target = `${protocol}//${host}${request.url === '*' ? '/' : request.url}`
    targetProtocol = protocol
  } else {
    const absolute = absoluteTarget(request.url)
    target = request.url
    authority = absolute.authority
    targetProtocol = absolute.url.protocol
    if (host !== undefined) {
      const header = parseAuthority(host, { protocol: absolute.url.protocol, label: 'Host authority' })
      if (header.host !== authority.host) throw new Error('Host authority differs from absolute-form target')
    }
  }

  if (tunnelAuthority !== undefined) {
    const bound = parseAuthority(tunnelAuthority, { protocol: 'https:', label: 'CONNECT tunnel authority' })
    if (!secure || targetProtocol !== 'https:' || authority.host !== bound.host) {
      throw new Error('Request authority differs from CONNECT tunnel')
    }
  }
  return target
}
