import type { AgentWork, ServiceError, WorkProposal, WorkReply, WorkRequest } from './agent-services.ts'
import { parseWorkEndpointReference } from './endpoint-ref.ts'
import { assertEnvelopeKeys, assertJsonValue } from './json-value.ts'
import { parseServiceError, RelayProtocolError } from './relay-codec.ts'

export type WorkWireRequest =
  | { readonly kind: 'work.propose'; readonly correlationId: string; readonly proposal: WorkProposal }
  | ({ readonly kind: 'work.request'; readonly correlationId: string } & WorkRequest)
  | { readonly kind: 'work.get'; readonly correlationId: string; readonly workId: string; readonly requestId: string }
  | { readonly kind: 'work.close'; readonly correlationId: string; readonly workId: string }
export type WorkWireReply =
  | { readonly kind: 'work.state'; readonly correlationId: string; readonly work: AgentWork }
  | ({ readonly kind: 'work.result'; readonly correlationId: string } & WorkReply)
  | { readonly kind: 'work.error'; readonly correlationId: string; readonly error: ServiceError }
export type WorkWireFrame = WorkWireRequest | WorkWireReply

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RelayProtocolError('INVALID_INPUT', 'Work control must be an object')
  return value as Record<string, unknown>
}
function string(value: unknown): void {
  if (typeof value !== 'string' || !value) throw new RelayProtocolError('INVALID_INPUT', 'Work control requires a non-empty string')
}
function positive(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new RelayProtocolError('INVALID_INPUT', 'Work control requires a positive safe integer')
}
function error(value: unknown): void {
  parseServiceError(value, 'Work error')
}
function proposal(value: unknown, state: boolean): void {
  const fields = object(value)
  assertEnvelopeKeys(fields, ['workId', 'consumerAgentId', 'providerAgentId', 'capabilityId', 'capabilityVersion', 'policyRevision', 'endpoint', ...(state ? ['state'] : [])], 'Work proposal')
  for (const key of ['workId', 'consumerAgentId', 'providerAgentId', 'capabilityId', 'capabilityVersion']) string(fields[key])
  positive(fields.policyRevision)
  if (fields.endpoint !== undefined) parseWorkEndpointReference(fields.endpoint)
  if (state && !['accepted', 'closing', 'closed', 'rejected'].includes(fields.state as string)) throw new Error('invalid Work state')
}
export function parseWorkWireFrame(text: string): WorkWireFrame {
  const frame = object(JSON.parse(text))
  assertJsonValue(frame, 'Work frame')
  string(frame.correlationId)
  switch (frame.kind) {
    case 'work.propose':
      assertEnvelopeKeys(frame, ['kind', 'correlationId', 'proposal'], 'Work proposal frame'); proposal(frame.proposal, false); break
    case 'work.state':
      assertEnvelopeKeys(frame, ['kind', 'correlationId', 'work'], 'Work state frame'); proposal(frame.work, true); break
    case 'work.get':
      assertEnvelopeKeys(frame, ['kind', 'correlationId', 'workId', 'requestId'], 'Work query'); string(frame.workId); string(frame.requestId); break
    case 'work.close':
      assertEnvelopeKeys(frame, ['kind', 'correlationId', 'workId'], 'Work close'); string(frame.workId); break
    case 'work.error':
      assertEnvelopeKeys(frame, ['kind', 'correlationId', 'error'], 'Work error'); error(frame.error); break
    case 'work.request': {
      assertEnvelopeKeys(frame, ['kind', 'correlationId', 'control', 'payload'], 'Work request')
      if (!Object.hasOwn(frame, 'payload')) throw new Error('Work request payload is required')
      const control = object(frame.control)
      assertEnvelopeKeys(control, ['workId', 'requestId', 'operation', 'targetGeneration', 'demands'], 'Work request control')
      string(control.workId); string(control.requestId); string(control.operation); positive(control.targetGeneration)
      if (!Array.isArray(control.demands)) throw new Error('Work demands must be an array')
      for (const item of control.demands) {
        const demand = object(item)
        assertEnvelopeKeys(demand, ['resourceId', 'amount'], 'Work demand'); string(demand.resourceId); positive(demand.amount)
      }
      break
    }
    case 'work.result': {
      assertEnvelopeKeys(frame, ['kind', 'correlationId', 'control', 'payload'], 'Work result')
      const control = object(frame.control)
      assertEnvelopeKeys(control, ['workId', 'requestId', 'state', 'error'], 'Work result control')
      string(control.workId); string(control.requestId)
      if (!['running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'unknown'].includes(control.state as string)) throw new Error('invalid Work request state')
      if (control.error !== undefined) error(control.error)
      break
    }
    default: throw new RelayProtocolError('INVALID_INPUT', 'unknown Work frame')
  }
  return frame as unknown as WorkWireFrame
}
