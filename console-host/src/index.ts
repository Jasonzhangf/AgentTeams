import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createOpencodeClient } from '@opencode-ai/sdk'
import { replyOpenCodePermission, sendOpenCodeMessage } from '@deepseek-ai/teams-opencode-adapter'
import { AgentMessage, buildAgentPairChannelId, validateAgentMessage } from '../../control-protocol/agent-message.ts'
import { RelationReport, validateRelationReport } from '../../control-protocol/relation-report.ts'

export interface ConsoleHostOptions {
  readonly agents: readonly ConsoleHostAgentConfig[]
  readonly port?: number
  readonly staticRoot: string
}

export interface ConsoleHostAgentConfig {
  readonly agentId: string
  readonly machineId: string
  readonly label: string
  readonly openCodeUrl: string
}

export function resolveConsoleHostAgents(options: ConsoleHostOptions): readonly ConsoleHostAgentConfig[] {
  if (options.agents.length === 0) throw new Error('console-host: at least one agent must be configured')
  const ids = new Set<string>()
  for (const agent of options.agents) {
    if (agent.agentId.length === 0 || agent.machineId.length === 0 || agent.label.length === 0) {
      throw new Error('console-host: agent identity fields are required')
    }
    if (ids.has(agent.agentId)) throw new Error(`console-host: duplicate agent ${agent.agentId}`)
    ids.add(agent.agentId)
  }
  return options.agents
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
  readonly relations: readonly ConsoleHostRelation[]
  readonly messages: readonly ConsoleHostAgentMessage[]
}

export interface ConsoleHostRelation {
  readonly relationId: string
  readonly consumerAgentId: string
  readonly providerAgentId: string
  readonly capabilityId: string
  readonly classification: 'master-slave' | 'peer'
  readonly consistency: 'consumer-only' | 'provider-only' | 'matched' | 'conflict'
  readonly consumerState?: string
  readonly providerState?: string
  readonly lastReportedAt: string
}

export interface ConsoleHostAgentMessage {
  readonly messageId: string
  readonly relationId: string
  readonly fromAgentId: string
  readonly toAgentId: string
  readonly kind: string
  readonly correlationId: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly sentAt: string
}

export type ConsoleHostAction =
  | { readonly kind: 'send-message'; readonly agentId: string; readonly sessionId: string; readonly text: string }
  | { readonly kind: 'reply-permission'; readonly agentId: string; readonly sessionId: string; readonly permissionId: string; readonly response: 'once' | 'always' | 'reject' }

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function readBody(request: IncomingMessage): Promise<ConsoleHostAction> {
  return await readJsonBody(request) as ConsoleHostAction
}

function openCodeClient(baseUrl: string) {
  return createOpencodeClient({ baseUrl })
}

export interface ConsoleHostResolvedOptions {
  readonly agents: readonly ConsoleHostAgentConfig[]
  readonly port?: number
  readonly staticRoot: string
}

export function resolveConsoleHostOptions(options: ConsoleHostOptions): ConsoleHostResolvedOptions {
  const agents = resolveConsoleHostAgents(options)
  return {
    agents,
    ...(options.port === undefined ? {} : { port: options.port }),
    staticRoot: options.staticRoot,
  }
}

function findAgent(agents: readonly ConsoleHostAgentConfig[], agentId: string): ConsoleHostAgentConfig {
  const agent = agents.find(candidate => candidate.agentId === agentId)
  if (agent === undefined) throw new Error(`console-host: agent ${agentId} not configured`)
  return agent
}

export async function dispatchConsoleHostAction(options: ConsoleHostOptions, action: ConsoleHostAction): Promise<void> {
  const resolved = resolveConsoleHostOptions(options)
  const agent = findAgent(resolved.agents, action.agentId)
  const client = openCodeClient(agent.openCodeUrl)
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

async function fetchSessions(agentId: string, baseUrl: string): Promise<readonly ConsoleHostSession[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/session`)
  if (!response.ok) throw new Error(`OpenCode session list failed: ${response.status}`)
  const sessions = await response.json() as readonly Record<string, unknown>[]
  return sessions.map(session => ({
    id: String(session.id),
    ...(typeof session.title === 'string' ? { title: session.title } : {}),
    ...(typeof session.directory === 'string' ? { directory: session.directory } : {}),
    running: false,
    agentId,
  }))
}

async function fetchPermissions(agentId: string, baseUrl: string): Promise<readonly ConsoleHostNotification[]> {
  const response = await fetch(`${baseUrl.replace(/\/$/u, '')}/permission`)
  if (!response.ok) throw new Error(`OpenCode permission list failed: ${response.status}`)
  const permissions = await response.json() as readonly Record<string, unknown>[]
  return permissions.map(permission => {
    const sessionId = String(permission.sessionID)
    const requestId = String(permission.id)
    return {
      id: `permission-request:${agentId}:${sessionId}:${requestId}`,
      agentId,
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
  const resolved = resolveConsoleHostOptions(options)
  const perAgent = await Promise.all(resolved.agents.map(async agent => {
    const [sessions, notifications] = await Promise.all([
      fetchSessions(agent.agentId, agent.openCodeUrl),
      fetchPermissions(agent.agentId, agent.openCodeUrl),
    ])
    return { agent, sessions, notifications }
  }))
  const sessions = perAgent.flatMap(entry => entry.sessions)
  const notifications = perAgent.flatMap(entry => entry.notifications)
  const agents = perAgent.map(({ agent, sessions: agentSessions }) => {
    const sessionIds = agentSessions.map(session => session.id)
    return {
      agentId: agent.agentId,
      machineId: agent.machineId,
      label: agent.label,
      sessionIds,
      ...(sessionIds[0] === undefined ? {} : { currentSessionId: sessionIds[0] }),
    }
  })
  return { sessions, agents, notifications, relations: [], messages: [] }
}

function relationState(relation: RelationReport): string {
  return relation.state
}

function projectRelationEdge(relationId: string, consumer?: RelationReport, provider?: RelationReport): ConsoleHostRelation {
  const source = consumer ?? provider
  if (source === undefined) throw new Error('console-host: cannot project empty relation')
  const consumerAgentId = consumer?.reporterAgentId ?? provider?.subjectAgentId ?? source.reporterAgentId
  const providerAgentId = provider?.reporterAgentId ?? consumer?.subjectAgentId ?? source.subjectAgentId
  return {
    relationId,
    consumerAgentId,
    providerAgentId,
    capabilityId: source.capabilityId,
    classification: 'master-slave',
    consistency: consumer === undefined ? 'provider-only' : provider === undefined ? 'consumer-only' : 'matched',
    ...(consumer === undefined ? {} : { consumerState: relationState(consumer) }),
    ...(provider === undefined ? {} : { providerState: relationState(provider) }),
    lastReportedAt: source.reportedAt,
  }
}

interface ConsoleHostRuntime {
  readonly relations: Map<string, { consumer?: RelationReport; provider?: RelationReport }>
  readonly messages: ConsoleHostAgentMessage[]
}

function createRuntime(): ConsoleHostRuntime {
  return { relations: new Map(), messages: [] }
}

function upsertRelation(runtime: ConsoleHostRuntime, report: RelationReport): void {
  const existing = runtime.relations.get(report.relationId) ?? {}
  const next = report.role === 'consumer'
    ? { ...existing, consumer: report }
    : { ...existing, provider: report }
  runtime.relations.set(report.relationId, next)
}

function listRelationEdges(runtime: ConsoleHostRuntime): readonly ConsoleHostRelation[] {
  return [...runtime.relations.entries()].map(([relationId, pair]) => projectRelationEdge(relationId, pair.consumer, pair.provider))
}

async function currentSessionId(options: ConsoleHostOptions, agentId: string): Promise<string> {
  const resolved = resolveConsoleHostOptions(options)
  const agent = findAgent(resolved.agents, agentId)
  const sessions = await fetchSessions(agent.agentId, agent.openCodeUrl)
  const current = sessions[0]
  if (current === undefined) throw new Error(`console-host: agent ${agentId} has no current session`)
  return current.id
}

function formatAgentMessageText(fromAgentId: string, toAgentId: string, message: AgentMessage): string {
  return `[Teams] ${fromAgentId} -> ${toAgentId} ${message.kind}: ${JSON.stringify(message.payload)}`
}

export async function relayConsoleHostAgentMessage(
  options: ConsoleHostOptions,
  runtime: ConsoleHostRuntime,
  input: { readonly messageId: string; readonly relationId: string; readonly fromAgentId: string; readonly toAgentId: string; readonly message: AgentMessage },
): Promise<ConsoleHostAgentMessage> {
  const message = validateAgentMessage(input.message)
  const resolved = resolveConsoleHostOptions(options)
  const fromAgent = findAgent(resolved.agents, input.fromAgentId)
  const toAgent = findAgent(resolved.agents, input.toAgentId)
  if (fromAgent.agentId === toAgent.agentId) throw new Error('console-host: self-target agent message is not allowed')
  if (!runtime.relations.has(input.relationId)) throw new Error(`console-host: relation ${input.relationId} does not exist`)
  const targetSessionId = await currentSessionId(options, toAgent.agentId)
  await dispatchConsoleHostAction(options, {
    kind: 'send-message',
    agentId: toAgent.agentId,
    sessionId: targetSessionId,
    text: formatAgentMessageText(input.fromAgentId, input.toAgentId, message),
  })
  const record: ConsoleHostAgentMessage = {
    messageId: input.messageId,
    relationId: input.relationId,
    fromAgentId: input.fromAgentId,
    toAgentId: input.toAgentId,
    kind: input.message.kind,
    correlationId: input.message.correlationId,
    payload: input.message.payload,
    sentAt: new Date().toISOString(),
  }
  runtime.messages.push(record)
  return record
}

export function createConsoleHost(options: ConsoleHostOptions) {
  const staticRoot = resolve(options.staticRoot)
  const runtime = createRuntime()
  return createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      if (request.url === '/api/projection') {
        const projection = await projectConsoleHost(options)
        json(response, 200, {
          ...projection,
          relations: listRelationEdges(runtime),
          messages: runtime.messages,
        })
        return
      }
      if (request.url === '/api/action' && request.method === 'POST') {
        await dispatchConsoleHostAction(options, await readBody(request))
        json(response, 200, { ok: true })
        return
      }
      if (request.url === '/api/relation' && request.method === 'POST') {
        const report = validateRelationReport(await readJsonBody(request))
        upsertRelation(runtime, report)
        const pair = runtime.relations.get(report.relationId)
        if (pair === undefined) throw new Error('console-host: relation update failed')
        json(response, 200, projectRelationEdge(report.relationId, pair.consumer, pair.provider))
        return
      }
      if (request.url === '/api/agent-message' && request.method === 'POST') {
        const body = await readJsonBody(request) as Record<string, unknown>
        const relayed = await relayConsoleHostAgentMessage(options, runtime, {
          messageId: String(body.messageId),
          relationId: String(body.relationId),
          fromAgentId: String(body.fromAgentId),
          toAgentId: String(body.toAgentId),
          message: body.message as AgentMessage,
        })
        json(response, 200, relayed)
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
