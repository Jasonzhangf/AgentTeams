import type {
  AgentWork,
  AuthenticatedAgent,
  CapabilityDeclaration,
  JsonValue,
  RelayGrant,
  RelayPeer,
  ResourceDemand,
  WorkProposal,
  WorkReply,
} from '../control-protocol/agent-services.ts'
import type { WorkEndpointReference } from '../control-protocol/endpoint-ref.ts'
import type { WorkWireReply } from '../control-protocol/work-wire.ts'
import { RelayProtocolError } from '../control-protocol/relay-codec.ts'
import type { RelayClient } from '../network/relay-client.ts'
import { createWorkChannel, type WorkChannel } from '../network/work-channel.ts'

export interface AgentWorkClientOptions {
  readonly timeoutMs: number
  readonly maxPending: number
}

export interface AgentWorkTarget {
  readonly providerAgentId: string
  readonly generation: number
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
  readonly serviceSelection: 'endpoint' | 'capability'
  readonly endpoint?: Omit<WorkEndpointReference, 'workId'>
}

export type AgentWorkServiceSelection =
  | { readonly mode: 'endpoint' }
  | {
      readonly mode: 'capability'
      readonly providerAgentId: string
      /** Original Work generation; it is never replaced by the current link generation. */
      readonly targetGeneration: number
      /** Exact pins the original generation; current resolves the current authorized generation. */
      readonly generationPolicy: 'exact' | 'current'
      /** Query-only current authorized generation. Omit to resolve the current generation. */
      readonly linkGeneration?: number
    }

export interface FindProviderInput {
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
  /** Legacy endpoint callers may omit this; persistent callers must pass capability explicitly. */
  readonly serviceSelection?: AgentWorkServiceSelection
  readonly providerAgentId?: string
}

/** A local transport failure after dispatch; the provider may or may not have observed the command. */
export class AgentWorkTransportError extends RelayProtocolError {
  readonly deliveryState = 'unconfirmed' as const
}

export interface AgentWorkChannel {
  propose(proposal: Omit<WorkProposal, 'consumerAgentId' | 'providerAgentId'>): Promise<AgentWork>
  request(input: {
    readonly workId: string
    readonly requestId: string
    readonly operation: string
    readonly demands: readonly ResourceDemand[]
    readonly payload: JsonValue
  }): Promise<WorkReply>
  get(workId: string, requestId: string): Promise<WorkReply>
  close(workId: string): Promise<AgentWork>
  dispose(): Promise<void>
  readonly closed: Promise<Error>
}

export interface AgentWorkClient {
  findProvider(input: FindProviderInput): Promise<AgentWorkTarget>
  open(target: AgentWorkTarget): Promise<AgentWorkChannel>
  dispose(): Promise<void>
}

function capability(peer: RelayPeer, capabilityId: string): CapabilityDeclaration | undefined {
  return peer.declaration.capabilities.find(candidate => candidate.capabilityId === capabilityId)
}

function endpointTarget(peer: RelayPeer, capabilityId: string, capabilityVersion: string, operation: string): AgentWorkTarget['endpoint'] | undefined {
  for (const endpoint of peer.endpoints ?? []) {
    const capability = endpoint.capabilities.find(candidate => candidate.capabilityId === capabilityId && candidate.version === capabilityVersion)
    if (capability?.operations.includes(operation)) {
      return { providerAgentId: endpoint.ownerAgentId, endpointId: endpoint.endpointId, revision: endpoint.revision,
        capabilityId, capabilityVersion, operation }
    }
  }
  return undefined
}

function asError(reply: Extract<WorkWireReply, { kind: 'work.error' }>): RelayProtocolError {
  return new RelayProtocolError(reply.error.code, reply.error.message)
}

async function transportRequest<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof AgentWorkTransportError) throw error
    if (error instanceof RelayProtocolError) {
      if (error.code === 'INVALID_INPUT' || error.code === 'RESOURCE_EXHAUSTED') throw error
      throw new AgentWorkTransportError(error.code, error.message)
    }
    throw new AgentWorkTransportError('UNAVAILABLE', error instanceof Error ? error.message : 'Work transport failed')
  }
}

function state(reply: WorkWireReply): AgentWork {
  if (reply.kind === 'work.error') throw asError(reply)
  if (reply.kind !== 'work.state') throw new RelayProtocolError('INVALID_INPUT', 'Work proposal expected a state reply')
  if (reply.work.state === 'rejected') throw new RelayProtocolError('FORBIDDEN', 'Work proposal was rejected')
  return reply.work
}

function result(reply: WorkWireReply): WorkReply {
  if (reply.kind === 'work.error') throw asError(reply)
  if (reply.kind !== 'work.result') throw new RelayProtocolError('INVALID_INPUT', 'Work request expected a result reply')
  return { control: reply.control, ...(reply.payload === undefined ? {} : { payload: reply.payload }) }
}

function sameEndpointReference(left: WorkEndpointReference, right: WorkEndpointReference): boolean {
  const fields = ['workId', 'providerAgentId', 'endpointId', 'revision', 'capabilityId', 'capabilityVersion', 'operation'] as const
  return Object.keys(left).length === fields.length && Object.keys(right).length === fields.length &&
    fields.every(field => left[field] === right[field])
}

export function createAgentWorkClient(
  relay: RelayClient,
  consumerIdentity: AuthenticatedAgent,
  input: AgentWorkClientOptions,
): AgentWorkClient {
  if (!consumerIdentity.accountId || !consumerIdentity.scopeId || !consumerIdentity.agentId) {
    throw new RelayProtocolError('INVALID_INPUT', 'Consumer identity is incomplete')
  }
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 2_147_483_647 ||
    !Number.isSafeInteger(input.maxPending) || input.maxPending < 1) {
    throw new RelayProtocolError('INVALID_INPUT', 'Invalid Agent Work limits')
  }
  const channels = new Set<AgentWorkChannel>()
  const findProvider = async (input: FindProviderInput): Promise<AgentWorkTarget> => {
    const { capabilityId, capabilityVersion, operation } = input
    const peers = await relay.directory(false)
    const selection = input.serviceSelection ?? { mode: 'endpoint' as const }

    if (selection.mode === 'capability') {
      const providerAgentId = selection.providerAgentId
      const providerPeers = peers.filter(peer => peer.declaration.identity.agentId === providerAgentId)
      if (providerPeers.length === 0) {
        throw new RelayProtocolError('NOT_FOUND', `Provider ${providerAgentId} was not found`)
      }
      const online = providerPeers.filter(peer => peer.presence === 'online')
      if (online.length === 0) {
        throw new RelayProtocolError('UNAVAILABLE', `Provider ${providerAgentId} is offline`)
      }
      const expectedGeneration = selection.generationPolicy === 'exact'
        ? selection.targetGeneration
        : selection.linkGeneration ?? online[0].generation
      const peer = online.find(candidate => candidate.generation === expectedGeneration)
      if (peer === undefined) {
        throw new RelayProtocolError('STALE_GENERATION', `Provider ${providerAgentId} generation ${expectedGeneration} is not current`)
      }
      const declarations = peer.declaration.capabilities.filter(candidate => candidate.capabilityId === capabilityId)
      if (declarations.length === 0) {
        throw new RelayProtocolError('NOT_FOUND', `Provider ${providerAgentId} does not declare ${capabilityId}`)
      }
      const versioned = declarations.filter(candidate => candidate.version === capabilityVersion)
      if (versioned.length === 0) {
        throw new RelayProtocolError('UNSUPPORTED_VERSION', `Capability ${capabilityId} version ${capabilityVersion} is unsupported`)
      }
      if (!versioned.some(candidate => candidate.operations.some(item => item.operation === operation))) {
        throw new RelayProtocolError('UNSUPPORTED_OPERATION', `Capability ${capabilityId} does not support ${operation}`)
      }
      return {
        providerAgentId,
        generation: expectedGeneration,
        capabilityId,
        capabilityVersion,
        operation,
        serviceSelection: 'capability',
      }
    }

    const providerAgentId = input.providerAgentId
    const scopedPeers = peers.filter(peer => providerAgentId === undefined || peer.declaration.identity.agentId === providerAgentId)
    const capabilityPeers = scopedPeers.filter(peer => capability(peer, capabilityId) !== undefined || (peer.endpoints ?? []).some(endpoint =>
      endpoint.capabilities.some(candidate => candidate.capabilityId === capabilityId)))
    if (capabilityPeers.length === 0) throw new RelayProtocolError('NOT_FOUND', `Capability ${capabilityId} was not found`)
    const versionPeers = capabilityPeers.filter(peer => capability(peer, capabilityId)?.version === capabilityVersion || (peer.endpoints ?? []).some(endpoint =>
      endpoint.capabilities.some(candidate => candidate.capabilityId === capabilityId && candidate.version === capabilityVersion)))
    if (versionPeers.length === 0) throw new RelayProtocolError('UNSUPPORTED_VERSION', `Capability ${capabilityId} version ${capabilityVersion} is unsupported`)
    const operationPeers = versionPeers.filter(peer => {
      const declaration = capability(peer, capabilityId)
      return (declaration?.version === capabilityVersion && declaration.operations.some(item => item.operation === operation)) || (peer.endpoints ?? []).some(endpoint =>
        endpoint.capabilities.some(candidate => candidate.capabilityId === capabilityId && candidate.version === capabilityVersion && candidate.operations.includes(operation)))
    })
    if (operationPeers.length === 0) throw new RelayProtocolError('UNSUPPORTED_OPERATION', `Capability ${capabilityId} does not support ${operation}`)
    const peer = operationPeers.find(candidate => candidate.presence === 'online' &&
      candidate.declaration.identity.agentId !== consumerIdentity.agentId &&
      (providerAgentId === undefined || candidate.declaration.identity.agentId === providerAgentId))
    if (peer === undefined) throw new RelayProtocolError('UNAVAILABLE', `Capability ${capabilityId} is offline`)
    const endpoint = endpointTarget(peer, capabilityId, capabilityVersion, operation)
    return { providerAgentId: peer.declaration.identity.agentId, generation: peer.generation, capabilityId, capabilityVersion, operation, serviceSelection: 'endpoint',
      ...(endpoint === undefined ? {} : { endpoint }) }
  }

  const open = async (target: AgentWorkTarget): Promise<AgentWorkChannel> => {
    const grant: RelayGrant = await relay.connect(target.providerAgentId, target.generation)
    const socket = await relay.openData(grant)
    const wire = createWorkChannel(socket, { timeoutMs: input.timeoutMs, maxPending: input.maxPending, maxIncoming: 1 })
    let disposed = false
    const channel: AgentWorkChannel = {
      closed: wire.closed,
      propose: async proposal => {
        if (proposal.capabilityId !== target.capabilityId || proposal.capabilityVersion !== target.capabilityVersion) {
          throw new RelayProtocolError('INVALID_INPUT', 'Work proposal does not match the selected capability target')
        }
        const endpoint = target.endpoint === undefined ? undefined : {
          workId: proposal.workId,
          ...target.endpoint,
        }
        if (proposal.endpoint !== undefined && (endpoint === undefined || !sameEndpointReference(proposal.endpoint, endpoint))) {
          throw new RelayProtocolError('CONFLICT', 'Work proposal Endpoint does not match the selected target')
        }
        const reply = await transportRequest(() => wire.request({ kind: 'work.propose', proposal: {
          ...proposal,
          ...(endpoint === undefined ? {} : { endpoint }),
          consumerAgentId: consumerIdentity.agentId,
          providerAgentId: target.providerAgentId,
        } }))
        return state(reply)
      },
      request: async request => {
        const reply = await transportRequest(() => wire.request({ kind: 'work.request', control: {
        workId: request.workId,
        requestId: request.requestId,
        operation: request.operation,
        targetGeneration: target.generation,
        demands: request.demands,
        }, payload: request.payload }))
        return result(reply)
      },
      get: async (workId, requestId) => result(await transportRequest(() => wire.request({ kind: 'work.get', workId, requestId }))),
      close: async workId => state(await transportRequest(() => wire.request({ kind: 'work.close', workId }))),
      dispose: async () => {
        if (disposed) return
        disposed = true
        channels.delete(channel)
        await wire.close()
      },
    }
    channels.add(channel)
    void wire.closed.finally(() => channels.delete(channel))
    return channel
  }

  return {
    findProvider,
    open,
    dispose: async () => {
      await Promise.all([...channels].map(channel => channel.dispose()))
    },
  }
}
