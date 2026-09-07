import type { ConsoleClientV1, ConsoleCommandResultV1, ConsoleCommandV1, ConsoleProjectionV1, JsonValue } from './protocol.ts'
import { isServiceError } from './protocol.ts'

export interface ConsoleHttpClientOptions {
  readonly baseUrl?: string
  readonly fetchImpl?: typeof fetch
  readonly projectionPath?: string
  readonly commandPath?: string
  readonly sessionMessagePath?: string
}

export class ConsoleTransportError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'ConsoleTransportError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys)
  return Object.keys(value).every(key => allowed.has(key))
}

function isProjection(value: unknown): value is ConsoleProjectionV1 {
  return isRecord(value)
    && hasOnlyKeys(value, ['version', 'agents', 'sessions', 'notifications', 'configs', 'sessionEvents'])
    && value.version === 1
    && Array.isArray(value.agents)
    && Array.isArray(value.sessions)
    && Array.isArray(value.notifications)
    && Array.isArray(value.configs)
    && (value.sessionEvents === undefined || Array.isArray(value.sessionEvents))
}

function isCommandResult(value: unknown): value is ConsoleCommandResultV1 {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false
  return value.ok || isServiceError(value.error)
}

function resolveUrl(path: string, baseUrl: string | undefined): string {
  if (baseUrl === undefined) return path
  return new URL(path, baseUrl).toString()
}

function withTarget(path: string, target: { readonly agentId: string; readonly sessionId: string }): string {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}agentId=${encodeURIComponent(target.agentId)}&sessionId=${encodeURIComponent(target.sessionId)}`
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) throw new ConsoleTransportError('Host returned an empty response', response.status)
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new ConsoleTransportError('Host returned invalid JSON', response.status)
  }
}

export function createConsoleHttpClient(options: ConsoleHttpClientOptions = {}): ConsoleClientV1 {
  const fetchImpl = options.fetchImpl ?? fetch
  const projectionPath = options.projectionPath ?? '/api/v1/projection'
  const commandPath = options.commandPath ?? '/api/v1/command'
  const sessionMessagePath = options.sessionMessagePath ?? '/api/v1/session-message'

  async function request(path: string, init: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await fetchImpl(resolveUrl(path, options.baseUrl), init)
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Network request failed'
      throw new ConsoleTransportError(`Host request failed: ${message}`)
    }
    if (!response.ok) {
      let detail = `HTTP ${response.status}`
      try {
        const body = await readJson(response)
        if (isRecord(body) && typeof body.message === 'string') detail = `${detail}: ${body.message}`
      } catch {
        // Keep the status as the stable transport evidence when the error body is not JSON.
      }
      throw new ConsoleTransportError(detail, response.status)
    }
    return readJson(response)
  }

  return {
    async readProjection(): Promise<ConsoleProjectionV1> {
      const value = await request(projectionPath, { method: 'GET', headers: { Accept: 'application/json' } })
      if (!isProjection(value)) throw new ConsoleTransportError('Host returned an invalid v1 projection')
      return value
    },
    async command(command: ConsoleCommandV1): Promise<ConsoleCommandResultV1> {
      const value = await request(commandPath, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(command),
      })
      if (!isCommandResult(value)) throw new ConsoleTransportError('Host returned an invalid v1 command result')
      return value
    },
    async sendSession(target, payload: JsonValue): Promise<ConsoleCommandResultV1> {
      const value = await request(withTarget(sessionMessagePath, target), {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!isCommandResult(value)) throw new ConsoleTransportError('Host returned an invalid v1 Session result')
      return value
    },
  }
}
