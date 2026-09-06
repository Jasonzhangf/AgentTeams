import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { ConsoleClientV1 } from '../../control-protocol/console-api.ts'

/** Credentials are supplied by runtime; daemon management policy remains independent. */
export function createConsoleAuthorization(options: {
  readonly username: string
  readonly password: string
  readonly origin: string
  readonly client: ConsoleClientV1
}): (request: IncomingMessage) => Promise<ConsoleClientV1 | undefined> {
  if (!options.username || options.username.includes(':') || !options.password || /[\r\n]/.test(options.username + options.password)) throw new Error('Invalid Console credentials')
  const url = new URL(options.origin)
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== options.origin) throw new Error('Console authentication requires an exact HTTP origin')
  const digest = (value: string) => createHash('sha256').update(value).digest()
  const expected = digest(`Basic ${Buffer.from(`${options.username}:${options.password}`).toString('base64')}`)
  const { origin, client } = options
  return async request => {
    const site = request.headers['sec-fetch-site']
    if (site !== undefined && site !== 'same-origin' && site !== 'none') return undefined
    if (request.headers.origin !== undefined && request.headers.origin !== origin) return undefined
    const authorization = request.headers.authorization
    if (typeof authorization !== 'string' || !timingSafeEqual(expected, digest(authorization))) return undefined
    return client
  }
}
