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
  findProvider(input: { readonly capabilityId: string; readonly capabilityVersion: string; readonly operation: string }): Promise<AgentWorkTarget>
  open(target: AgentWorkTarget): Promise<AgentWorkChannel>
  dispose(): Promise<void>
}

function capability(peer: RelayPeer, capabilityId: string): CapabilityDeclaration | undefined {
  return peer.declaration.capabilities.find(candidate => candidate.capabilityId === capabilityId)
}

function asError(reply: Extract<WorkWireReply, { kind: 'work.error' }>): RelayProtocolError {
  return new RelayProtocolError(reply.error.code, reply.error.message)
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
  const findProvider = async ({ capabilityId, capabilityVersion, operation }: {
    readonly capabilityId: string
    readonly capabilityVersion: string
    readonly operation: string
  }): Promise<AgentWorkTarget> => {
    const peers = await relay.directory(false)
    const capabilityPeers = peers.filter(peer => capability(peer, capabilityId) !== undefined)
    if (capabilityPeers.length === 0) throw new RelayProtocolError('NOT_FOUND', `Capability ${capabilityId} was not found`)
    const versionPeers = capabilityPeers.filter(peer => capability(peer, capabilityId)!.version === capabilityVersion)
    if (versionPeers.length === 0) throw new RelayProtocolError('UNSUPPORTED_VERSION', `Capability ${capabilityId} version ${capabilityVersion} is unsupported`)
    const operationPeers = versionPeers.filter(peer => capability(peer, capabilityId)!.operations.some(item => item.operation === operation))
    if (operationPeers.length === 0) throw new RelayProtocolError('UNSUPPORTED_OPERATION', `Capability ${capabilityId} does not support ${operation}`)
    const peer = operationPeers.find(candidate => candidate.presence === 'online' &&
      candidate.declaration.identity.agentId !== consumerIdentity.agentId)
    if (peer === undefined) throw new RelayProtocolError('UNAVAILABLE', `Capability ${capabilityId} is offline`)
    return { providerAgentId: peer.declaration.identity.agentId, generation: peer.generation, capabilityId, capabilityVersion, operation }
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
        return state(await wire.request({ kind: 'work.propose', proposal: {
          ...proposal,
          consumerAgentId: consumerIdentity.agentId,
          providerAgentId: target.providerAgentId,
        } }))
      },
      request: async request => result(await wire.request({ kind: 'work.request', control: {
        workId: request.workId,
        requestId: request.requestId,
        operation: request.operation,
        targetGeneration: target.generation,
        demands: request.demands,
      }, payload: request.payload })),
      get: async (workId, requestId) => result(await wire.request({ kind: 'work.get', workId, requestId })),
      close: async workId => state(await wire.request({ kind: 'work.close', workId })),
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
