import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { replyOpenCodePermission, sendOpenCodeMessage } from '@deepseek-ai/teams-opencode-adapter'

export interface ConsoleHostOptions {
  readonly openCodeUrl: string
  readonly port?: number
  readonly staticRoot: string
}

export interface ConsoleHostSession {
  readonly id: string
  readonly title?: string
  readonly directory?: string
  readonly running: boolean
  readonly agentId: string
}

export interface ConsoleHostAgent {
  readonly agentId: string
  readonly machineId: string
  readonly label: string
  readonly sessionIds: readonly string[]
  readonly currentSessionId?: string
}

export interface ConsoleHostNotification {
  readonly id: string
  readonly agentId: string
  readonly sessionId: string
  readonly requestId: string
  readonly interactive: true
  readonly processed: false
  readonly priority: 'high'
  readonly createdAt: string
}

export interface ConsoleHostProjection {
  readonly sessions: readonly ConsoleHostSession[]
  readonly agents: readonly ConsoleHostAgent[]
  readonly notifications: readonly ConsoleHostNotification[]
}

export type ConsoleHostAction =
  | { readonly kind: 'send-message'; readonly sessionId: string; readonly text: string }
  | { readonly kind: 'reply-permission'; readonly sessionId: string; readonly permissionId: string; readonly response: 'once' | 'always' | 'reject' }

async function readBody(request: IncomingMessage): Promise<ConsoleHostAction> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as ConsoleHostAction
}

function openCodeClient(baseUrl: string) {
  return createOpencodeClient({ baseUrl })
}

async function dispatchAction(options: ConsoleHostOptions, action: ConsoleHostAction): Promise<void> {
  const client = openCodeClient(options.openCodeUrl)
  if (action.kind === 'send-message') {
    await sendOpenCodeMessage(client, action.sessionId, action.text)
    return
  }
  await replyOpenCodePermission(client, action.permissionId, action.sessionId, action.response)
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(body))
}

async function fetchSessions(baseUrl: string): Promise<readonly ConsoleHostSession[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/session`)
  if (!response.ok) throw new Error(`OpenCode session list failed: ${response.status}`)
  const sessions = await response.json() as readonly Record<string, unknown>[]
  return sessions.map(session => ({
    id: String(session.id),
    ...(typeof session.title === 'string' ? { title: session.title } : {}),
    ...(typeof session.directory === 'string' ? { directory: session.directory } : {}),
    running: false,
    agentId: 'opencode-local',
  }))
}

async function fetchPermissions(baseUrl: string): Promise<readonly ConsoleHostNotification[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/permission`)
  if (!response.ok) throw new Error(`OpenCode permission list failed: ${response.status}`)
  const permissions = await response.json() as readonly Record<string, unknown>[]
  return permissions.map(permission => {
    const sessionId = String(permission.sessionID)
    const requestId = String(permission.id)
    return {
      id: `permission-request:${sessionId}:${requestId}`,
      agentId: 'opencode-local',
      sessionId,
      requestId,
      interactive: true,
      processed: false,
      priority: 'high',
      createdAt: new Date().toISOString(),
    }
  })
}

export async function projectConsoleHost(options: ConsoleHostOptions): Promise<ConsoleHostProjection> {
  const [sessions, notifications] = await Promise.all([
    fetchSessions(options.openCodeUrl),
    fetchPermissions(options.openCodeUrl),
  ])
  const sessionIds = sessions.map(session => session.id)
  return {
    sessions,
    agents: [{
      agentId: 'opencode-local',
      machineId: 'local',
      label: 'OpenCode',
      sessionIds,
      ...(sessionIds[0] === undefined ? {} : { currentSessionId: sessionIds[0] }),
    }],
    notifications,
  }
}

export function createConsoleHost(options: ConsoleHostOptions) {
  const staticRoot = resolve(options.staticRoot)
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.url === '/api/projection') {
        json(response, 200, await projectConsoleHost(options))
        return
      }
      if (request.url === '/api/action' && request.method === 'POST') {
        await dispatchAction(options, await readBody(request))
        json(response, 200, { ok: true })
        return
      }
      if (request.url === '/health') {
        json(response, 200, { ok: true })
        return
      }
      const page = await readFile(resolve(staticRoot, 'index.html'))
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(page)
    } catch (error) {
      json(response, 500, { error: String(error) })
    }
  })
}

export async function startConsoleHost(options: ConsoleHostOptions): Promise<ReturnType<typeof createServer>> {
  const server = createConsoleHost(options)
  await new Promise<void>((resolveStart, reject) => {
    server.once('error', reject)
    server.listen(options.port ?? 0, '127.0.0.1', () => { resolveStart() })
  })
  return server
}
