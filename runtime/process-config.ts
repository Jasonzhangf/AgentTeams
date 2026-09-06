import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { assertEnvelopeKeys } from '../control-protocol/json-value.ts'
import { RelayProtocolError } from '../control-protocol/relay-codec.ts'
import type { AgentDeclaration } from '../control-protocol/agent-services.ts'
import type { RelayClientOptions } from '../network/relay-client.ts'

export function object(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RelayProtocolError('INVALID_INPUT', `${label} must be an object`)
  const record = value as Record<string, unknown>
  assertEnvelopeKeys(record, keys, label)
  return record
}
export function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new RelayProtocolError('INVALID_INPUT', `${label} is required`)
  return value
}
export function number(value: unknown, label: string, max = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new RelayProtocolError('INVALID_INPUT', `${label} is outside its positive integer range`)
  return value as number
}
export function credential(value: unknown, env: NodeJS.ProcessEnv): string {
  const reference = text(value, 'credential environment reference')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference)) throw new RelayProtocolError('INVALID_INPUT', 'invalid credential environment reference')
  return text(env[reference], 'configured credential environment')
}
/** Shared runtime bootstrap config owner; credentials never enter declarations. */
export async function loadRelayConfig(input: unknown, declaration: AgentDeclaration, configPath: string, env: NodeJS.ProcessEnv): Promise<RelayClientOptions> {
  const relay = object(input, ['endpoint', 'credentialEnv', 'caFile', 'connectTimeoutMs', 'admissionTimeoutMs', 'requestTimeoutMs',
    'maxMessageBytes', 'maxBufferedBytes', 'maxPendingFrames', 'maxPendingRequests', 'maxDataConnections'], 'relay')
  const auth = credential(relay.credentialEnv, env)
  return { declaration, transport: { endpoint: text(relay.endpoint, 'relay.endpoint'), credential: auth,
    ...(relay.caFile === undefined ? {} : { ca: await readFile(resolve(dirname(configPath), text(relay.caFile, 'relay.caFile'))) }),
    connectTimeoutMs: number(relay.connectTimeoutMs, 'connectTimeoutMs'), maxMessageBytes: number(relay.maxMessageBytes, 'maxMessageBytes'),
    maxBufferedBytes: number(relay.maxBufferedBytes, 'maxBufferedBytes'), maxPendingFrames: number(relay.maxPendingFrames, 'maxPendingFrames') },
    admissionTimeoutMs: number(relay.admissionTimeoutMs, 'admissionTimeoutMs'), requestTimeoutMs: number(relay.requestTimeoutMs, 'requestTimeoutMs'),
    maxPendingRequests: number(relay.maxPendingRequests, 'maxPendingRequests'), maxDataConnections: number(relay.maxDataConnections, 'maxDataConnections') }
}
