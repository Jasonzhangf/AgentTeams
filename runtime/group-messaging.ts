import type { AgentDeclaration, JsonValue } from '../control-protocol/agent-services.ts'
import type { GroupWireRequest } from '../control-protocol/group-wire.ts'
import { createGroupChannel, type GroupChannel } from '../network/group-channel.ts'
import type { RegistrationClient, RegistrationStatus } from '../network/registration-client.ts'
import {
  createAgentMessaging,
  localSocketPathFor,
  type AgentMessaging,
  type AgentMessagingVikunjaOptions,
} from './agent-messaging.ts'

/**
 * The one composition that puts group messaging on the registration connection.
 *
 * A daemon builds the channel before it starts registration, so the registration
 * owner can report every online/reconnecting transition to the same channel. The
 * channel never opens a socket; the registration client sends and receives the
 * group frames on the connection it already owns.
 */

export interface GroupMessagingChannelOptions {
  readonly requestTimeoutMs: number
  readonly maxPendingRequests: number
  readonly onError?: (error: { readonly code: string; readonly message: string }) => void
}

export function createRegistrationGroupChannel(
  registration: RegistrationClient,
  options: GroupMessagingChannelOptions,
): GroupChannel {
  return createGroupChannel({
    transport: {
      send: text => {
        const frame = JSON.parse(text) as GroupWireRequest
        return registration.sendGroup(frame.requestId, frame)
      },
      onMessage: handler => registration.onGroup(message => {
        if (message.kind === 'relay.error') {
          handler(JSON.stringify({
            kind: 'relay.error',
            ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
            error: message.error,
          }))
          return
        }
        handler(JSON.stringify(message.frame))
      }),
    },
    timeoutMs: options.requestTimeoutMs,
    maxPendingRequests: options.maxPendingRequests,
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  })
}

/**
 * Feeds one registration status transition to the channel. The registration
 * owner calls this from its own `onStatus`, so the channel follows the shared
 * connection instead of owning a lifecycle of its own.
 */
export function forwardRegistrationStatus(channel: GroupChannel | undefined, status: RegistrationStatus): void {
  if (channel === undefined) return
  if (status.state === 'online') {
    void channel.reconnected().catch(() => undefined)
    return
  }
  if (status.state === 'reconnecting' || status.state === 'failed' || status.state === 'stopped') {
    channel.disconnect({
      code: status.lastError?.code ?? 'UNAVAILABLE',
      message: status.lastError?.message ?? 'registration connection lost',
    })
  }
}

export interface GroupAgentMessagingOptions {
  readonly registration: RegistrationClient
  readonly channel: GroupChannel
  readonly declaration: AgentDeclaration
  readonly dataDirectory: string
  readonly vikunja?: AgentMessagingVikunjaOptions
  readonly externalOpTimeoutMs?: number
}

/** Starts the CLI-facing local socket on top of the shared group channel. */
export async function startGroupAgentMessaging(options: GroupAgentMessagingOptions): Promise<AgentMessaging> {
  const messaging = await createAgentMessaging({
    channel: {
      request: frame => options.channel.request(frame),
      // A receipt is not a request: it carries no requestId and is never
      // validated as one. It writes one group frame on the same connection.
      // The receipt is JSON-safe; ServiceError's optional members only miss
      // the JsonValue index signature, so the wire cast is structural.
      send: async frame => { await options.registration.sendGroup(`op:${frame.opId}`, frame as unknown as JsonValue) },
      subscribe: listener => options.channel.subscribe(push => {
        if (push.kind !== 'op.execute') return
        if (typeof push.params !== 'object' || push.params === null || Array.isArray(push.params)) return
        listener({ kind: 'op.execute', opId: push.opId, opKind: push.opKind, params: push.params as Record<string, unknown> })
      }),
    },
    declaration: options.declaration,
    socketPath: localSocketPathFor(options.dataDirectory),
    ...(options.vikunja === undefined ? {} : { vikunja: options.vikunja }),
    ...(options.externalOpTimeoutMs === undefined ? {} : { externalOpTimeoutMs: options.externalOpTimeoutMs }),
  })
  await messaging.start()
  return messaging
}
