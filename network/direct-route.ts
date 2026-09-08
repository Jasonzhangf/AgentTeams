import type { ServiceErrorCode } from '../control-protocol/agent-services.ts'
import { parseTargetControlFrame, type TargetControlFrame } from '../control-protocol/frames.ts'
import { RelayProtocolError } from '../control-protocol/relay-codec.ts'
import {
  activeDirectWssCandidate,
  beginRouteCandidate,
  failRouteCandidate,
  succeedRouteCandidate,
  type DirectWssRouteCandidate,
  type RoutePlan,
} from './route-plan.ts'
import {
  assertTargetGeneration,
  beginTargetTransport,
  closeTargetTransport,
  receiveHelloAck,
  type TargetTransportHello,
  type TargetTransportState,
} from './target-transport.ts'
import { connectWss, type WssConnection, type WssConnectionOptions } from './wss-connection.ts'

const serviceErrorCodes = new Set<ServiceErrorCode>([
  'INVALID_INPUT', 'UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'UNSUPPORTED_VERSION',
  'UNSUPPORTED_OPERATION', 'STALE_GENERATION', 'REVISION_CONFLICT', 'RESOURCE_EXHAUSTED',
  'CONFLICT', 'RESULT_UNKNOWN', 'UNAVAILABLE', 'UPSTREAM_ERROR',
])

export class DirectWssRouteError extends RelayProtocolError {
  constructor(code: ServiceErrorCode, message: string, readonly plan: RoutePlan) {
    super(code, message)
  }
}

export interface DirectWssTargetOptions {
  readonly transport: WssConnectionOptions
  readonly hello: TargetTransportHello
  readonly plan: RoutePlan
  readonly helloTimeoutMs: number
}

export interface DirectWssTarget {
  readonly connection: WssConnection
  readonly plan: RoutePlan
  readonly state: TargetTransportState
  readonly closed: Promise<Error>
  assertGeneration(generation: number): void
  close(reason?: string): Promise<void>
}

function codeFromTransport(code: string): ServiceErrorCode {
  return serviceErrorCodes.has(code as ServiceErrorCode) ? code as ServiceErrorCode : 'INVALID_INPUT'
}

function codeFromError(error: unknown, fallback: ServiceErrorCode): ServiceErrorCode {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    return codeFromTransport((error as { code: string }).code)
  }
  return fallback
}

function retiredPlan(active: RoutePlan, candidateId: string, reason: string): RoutePlan {
  try {
    return failRouteCandidate(active, candidateId, reason)
  } catch {
    return active
  }
}

export async function connectDirectWssTarget(input: DirectWssTargetOptions): Promise<DirectWssTarget> {
  if (!Number.isSafeInteger(input.helloTimeoutMs) || input.helloTimeoutMs < 1 || input.helloTimeoutMs > 2_147_483_647) {
    throw new RelayProtocolError('INVALID_INPUT', 'direct-route: hello timeout must be a valid positive timer duration')
  }
  const active = beginRouteCandidate(input.plan)
  let candidate: DirectWssRouteCandidate
  try {
    candidate = activeDirectWssCandidate(active)
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'direct-route: active candidate is not direct WSS'
    throw new DirectWssRouteError('INVALID_INPUT', reason, retiredPlan(active, active.candidateOrder[active.cursor], reason))
  }

  const hello: TargetControlFrame = parseTargetControlFrame({
    kind: 'transport.hello',
    targetGeneration: input.hello.targetGeneration,
    protocolVersion: input.hello.protocolVersion,
    hostId: input.hello.hostId,
    agentId: input.hello.agentId,
    capabilitiesRevision: input.hello.capabilitiesRevision,
  })

  let connection: WssConnection | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    connection = await connectWss(input.transport)
    const established = connection
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new RelayProtocolError('RESULT_UNKNOWN', 'direct-route: hello deadline elapsed; do not replay')), input.helloTimeoutMs)
    })
    const ready = await Promise.race([
      deadline,
      (async () => {
        await established.send({ bytes: Buffer.from(JSON.stringify(hello)), binary: false })
        const frame = await established.read()
        if (frame.binary) throw new RelayProtocolError('INVALID_INPUT', 'direct-route: hello response must be text')
        let parsed: TargetControlFrame
        try {
          parsed = parseTargetControlFrame(JSON.parse(frame.bytes.toString('utf8')))
        } catch {
          throw new RelayProtocolError('INVALID_INPUT', 'direct-route: hello response is not a valid target control frame')
        }
        if (parsed.kind === 'transport.error') {
          throw new RelayProtocolError(codeFromTransport(parsed.code), parsed.message)
        }
        if (parsed.kind !== 'transport.hello_ack') {
          throw new RelayProtocolError('INVALID_INPUT', 'direct-route: expected transport.hello_ack')
        }
        if (parsed.targetGeneration !== input.hello.targetGeneration) {
          throw new RelayProtocolError('STALE_GENERATION', 'direct-route: hello ack generation is stale')
        }
        return parsed
      })(),
    ])
    void ready
    const plan = succeedRouteCandidate(active, candidate.candidateId)
    let state: TargetTransportState = receiveHelloAck(beginTargetTransport(input.hello))
    const markClosed = (reason?: string) => {
      if (state.state === 'ready' || state.state === 'connecting') {
        state = closeTargetTransport(state, reason)
      }
    }
    const closed = established.closed.then(error => {
      markClosed(error.message)
      return error
    })
    return {
      connection: established,
      plan,
      state,
      closed,
      assertGeneration: generation => assertTargetGeneration(state, generation),
      close: async (reason = 'direct route closed') => {
        markClosed(reason)
        await established.close()
      },
    }
  } catch (error) {
    try { await connection?.close() } catch { /* socket cleanup is best-effort */ }
    const code = error instanceof RelayProtocolError ? error.code
      : error instanceof SyntaxError ? 'INVALID_INPUT'
      : codeFromError(error, 'UNAVAILABLE')
    const message = error instanceof Error ? error.message : 'direct-route: direct WSS target failed'
    throw new DirectWssRouteError(code, message, retiredPlan(active, candidate.candidateId, message))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
