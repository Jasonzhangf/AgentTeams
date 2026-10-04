// Typed stdio port between the Node host and the Rust DAGpipe runner.
//
// The runner emits `host.call` frames on stdout and consumes exactly one
// `host.result`/`host.error` frame per call on stdin. Control correlation and
// business values are separate fields at every boundary; nothing here schedules
// graph nodes or holds provider resource state.

import type { AgentWork, JsonValue, ResourceDemand } from '../../control-protocol/agent-services.ts'
import type { AgentWorkServiceSelection, AgentWorkTarget } from '../agent-work-client.ts'

export class HostProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export interface RunnerIdentity {
  readonly project_id: string
  readonly graph_id: string
  readonly graph_version: string
  readonly execution_id: string
  readonly attempt_id: string
}

export interface HostCallControlBase {
  readonly request_id: string
  readonly operator: string
  readonly node_id: string
  readonly identity: RunnerIdentity
}

export interface FindProviderArgs {
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly operation: string
  readonly providerAgentId?: string
  readonly serviceSelection?: AgentWorkServiceSelection
}

export interface OpenWorkArgs {
  readonly target: AgentWorkTarget
}

export interface ProposeWorkArgs {
  readonly channelRef: string
  readonly workId: string
  readonly capabilityId: string
  readonly capabilityVersion: string
  readonly policyRevision: number
}

export interface RequestWorkArgs {
  readonly channelRef: string
  readonly workId: string
  readonly requestId: string
  readonly operation: string
  readonly demands: readonly ResourceDemand[]
}

export interface GetWorkArgs {
  readonly channelRef: string
  readonly workId: string
  readonly requestId: string
}

export interface CloseWorkArgs {
  readonly channelRef: string
  readonly workId: string
}

export interface DisposeWorkArgs {
  readonly channelRef: string
}

export type HostCallControl =
  | (HostCallControlBase & { readonly operation: 'agentWork.findProvider'; readonly args: FindProviderArgs })
  | (HostCallControlBase & { readonly operation: 'agentWork.open'; readonly args: OpenWorkArgs })
  | (HostCallControlBase & { readonly operation: 'agentWork.propose'; readonly args: ProposeWorkArgs })
  | (HostCallControlBase & { readonly operation: 'agentWork.request'; readonly args: RequestWorkArgs })
  | (HostCallControlBase & { readonly operation: 'agentWork.get'; readonly args: GetWorkArgs })
  | (HostCallControlBase & { readonly operation: 'agentWork.close'; readonly args: CloseWorkArgs })
  | (HostCallControlBase & { readonly operation: 'agentWork.dispose'; readonly args: DisposeWorkArgs })

export interface HostCallFrame {
  readonly type: 'host.call'
  readonly control: HostCallControl
  /** Original business value only; never operation arguments or control facts. */
  readonly business?: JsonValue
}

export interface ArcValue {
  readonly id: string
  readonly version: number
  readonly schema: string
  readonly payload: {
    readonly control: Record<string, JsonValue>
    readonly business?: JsonValue
  }
}

export interface JournalEvent {
  readonly kind: string
  readonly node_id?: string
  readonly [key: string]: unknown
}

export interface ExecutionResultFrame {
  readonly type: 'execution.result'
  readonly identity: RunnerIdentity
  readonly compiled: {
    readonly id: string
    readonly version: string
    readonly node_ids: readonly string[]
    readonly input_arcs: readonly string[]
    readonly output_arcs: readonly string[]
  }
  readonly outputs: Record<string, ArcValue>
  readonly journal: readonly JournalEvent[]
}

export interface ExecutionFailureFrame {
  readonly type: 'execution.failure'
  readonly kind: string
  readonly message: string
  readonly journal: readonly JournalEvent[]
}

export interface CompileResultFrame {
  readonly type: 'compile.result'
  readonly graph_id: string
  readonly graph_version: string
  readonly node_ids: readonly string[]
  readonly capabilities: readonly string[]
}

export interface CompileFailureFrame {
  readonly type: 'compile.failure'
  readonly stage: string
  readonly message: string
  readonly graph_id?: string
  readonly graph_version?: string
}

export interface RunnerFailureFrame {
  readonly type: 'usage.failure' | 'run.failure'
  readonly message: string
}

export type RunnerFinalFrame =
  | ExecutionResultFrame
  | ExecutionFailureFrame
  | CompileResultFrame
  | CompileFailureFrame
  | RunnerFailureFrame

export type RunnerFrame = HostCallFrame | RunnerFinalFrame

const RUNNER_FINAL_FRAME_TYPES = new Set<RunnerFinalFrame['type']>([
  'execution.result',
  'execution.failure',
  'compile.result',
  'compile.failure',
  'usage.failure',
  'run.failure',
])

export function decodeRunnerFrame(line: string): RunnerFrame {
  let decoded: unknown
  try {
    decoded = JSON.parse(line)
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON'
    throw new HostProtocolError('HOST_PROTOCOL', `runner frame is not JSON: ${detail}`)
  }
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new HostProtocolError('HOST_PROTOCOL', 'runner frame must be an object')
  }

  const type = (decoded as { readonly type?: unknown }).type
  if (type === 'host.call') {
    const control = (decoded as { readonly control?: unknown }).control
    if (control === null || typeof control !== 'object' || Array.isArray(control)) {
      throw new HostProtocolError('HOST_PROTOCOL', 'host.call lacks control object')
    }
    return decoded as HostCallFrame
  }
  if (typeof type === 'string' && RUNNER_FINAL_FRAME_TYPES.has(type as RunnerFinalFrame['type'])) {
    if (type === 'execution.result') {
      return decodeExecutionResultFrame(decoded)
    }
    if (type === 'execution.failure') {
      return decodeExecutionFailureFrame(decoded)
    }
    if (type === 'compile.result') {
      return decodeCompileResultFrame(decoded)
    }
    if (type === 'compile.failure') {
      return decodeCompileFailureFrame(decoded)
    }
    return decodeRunnerFailureFrame(decoded, type as RunnerFailureFrame['type'])
  }
  throw new HostProtocolError('HOST_PROTOCOL', `runner frame has unsupported type ${JSON.stringify(type)}`)
}

function runnerObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostProtocolError('HOST_PROTOCOL', `runner frame lacks ${label}`)
  }
  return value as Record<string, unknown>
}

function stringField(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HostProtocolError('HOST_PROTOCOL', `${label} must be a non-empty string`)
  }
  return value
}

function stringArrayField(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new HostProtocolError('HOST_PROTOCOL', `${label} must be a non-empty string array`)
  }
  return value
}

function journalField(value: unknown, label: string): readonly JournalEvent[] {
  if (!Array.isArray(value) || value.some(item => item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw new HostProtocolError('HOST_PROTOCOL', `${label} must be an object array`)
  }
  return value as readonly JournalEvent[]
}

function identityField(value: unknown, label: string): RunnerIdentity {
  const identity = runnerObject(value, label)
  return {
    project_id: stringField(identity.project_id, `${label}.project_id`),
    graph_id: stringField(identity.graph_id, `${label}.graph_id`),
    graph_version: stringField(identity.graph_version, `${label}.graph_version`),
    execution_id: stringField(identity.execution_id, `${label}.execution_id`),
    attempt_id: stringField(identity.attempt_id, `${label}.attempt_id`),
  }
}

function decodeExecutionResultFrame(value: unknown): ExecutionResultFrame {
  const frame = runnerObject(value, 'execution.result')
  if (!Object.hasOwn(frame, 'identity')) throw new HostProtocolError('HOST_PROTOCOL', 'runner frame lacks execution.result.identity')
  if (!Object.hasOwn(frame, 'compiled')) throw new HostProtocolError('HOST_PROTOCOL', 'runner frame lacks execution.result.compiled')
  if (!Object.hasOwn(frame, 'outputs')) throw new HostProtocolError('HOST_PROTOCOL', 'runner frame lacks execution.result.outputs')
  if (!Object.hasOwn(frame, 'journal')) throw new HostProtocolError('HOST_PROTOCOL', 'runner frame lacks execution.result.journal')
  const identity = identityField(frame.identity, 'execution.result.identity')
  const compiledValue = runnerObject(frame.compiled, 'execution.result.compiled')
  const outputsValue = runnerObject(frame.outputs, 'execution.result.outputs')
  const journal = journalField(frame.journal, 'execution.result.journal')
  const compiled = {
    id: stringField(compiledValue.id, 'execution.result.compiled.id'),
    version: stringField(compiledValue.version, 'execution.result.compiled.version'),
    node_ids: stringArrayField(compiledValue.node_ids, 'execution.result.compiled.node_ids'),
    input_arcs: stringArrayField(compiledValue.input_arcs, 'execution.result.compiled.input_arcs'),
    output_arcs: stringArrayField(compiledValue.output_arcs, 'execution.result.compiled.output_arcs'),
  }
  if (compiled.id !== identity.graph_id || compiled.version !== identity.graph_version) {
    throw new HostProtocolError('HOST_PROTOCOL', 'execution.result compiled graph identity does not match identity')
  }
  if (compiled.output_arcs.length !== 1 || outputsValue[compiled.output_arcs[0]] === undefined) {
    throw new HostProtocolError('HOST_PROTOCOL', 'execution.result lacks its declared output ARC')
  }
  const outputs: Record<string, ArcValue> = {}
  for (const [arcId, arcValue] of Object.entries(outputsValue)) {
    const arc = runnerObject(arcValue, `execution.result.outputs.${arcId}`)
    const payload = runnerObject(arc.payload, `execution.result.outputs.${arcId}.payload`)
    outputs[arcId] = {
      id: stringField(arc.id, `execution.result.outputs.${arcId}.id`),
      version: requiredInteger(arc.version, `execution.result.outputs.${arcId}.version`),
      schema: stringField(arc.schema, `execution.result.outputs.${arcId}.schema`),
      payload: {
        control: runnerObject(payload.control, `execution.result.outputs.${arcId}.payload.control`) as Record<string, JsonValue>,
        ...(Object.hasOwn(payload, 'business') ? { business: payload.business as JsonValue } : {}),
      },
    }
  }
  return { type: 'execution.result', identity, compiled, outputs, journal }
}

function decodeExecutionFailureFrame(value: unknown): ExecutionFailureFrame {
  const frame = runnerObject(value, 'execution.failure')
  return {
    type: 'execution.failure',
    kind: stringField(frame.kind, 'execution.failure.kind'),
    message: stringField(frame.message, 'execution.failure.message'),
    journal: journalField(frame.journal, 'execution.failure.journal'),
  }
}

function decodeCompileResultFrame(value: unknown): CompileResultFrame {
  const frame = runnerObject(value, 'compile.result')
  return {
    type: 'compile.result',
    graph_id: stringField(frame.graph_id, 'compile.result.graph_id'),
    graph_version: stringField(frame.graph_version, 'compile.result.graph_version'),
    node_ids: stringArrayField(frame.node_ids, 'compile.result.node_ids'),
    capabilities: stringArrayField(frame.capabilities, 'compile.result.capabilities'),
  }
}

function decodeCompileFailureFrame(value: unknown): CompileFailureFrame {
  const frame = runnerObject(value, 'compile.failure')
  return {
    type: 'compile.failure',
    stage: stringField(frame.stage, 'compile.failure.stage'),
    message: stringField(frame.message, 'compile.failure.message'),
    ...(frame.graph_id === undefined ? {} : { graph_id: stringField(frame.graph_id, 'compile.failure.graph_id') }),
    ...(frame.graph_version === undefined ? {} : { graph_version: stringField(frame.graph_version, 'compile.failure.graph_version') }),
  }
}

function decodeRunnerFailureFrame(value: unknown, type: RunnerFailureFrame['type']): RunnerFailureFrame {
  const frame = runnerObject(value, type)
  return { type, message: stringField(frame.message, `${type}.message`) }
}

export interface HostOperationResult {
  readonly result: JsonValue
  /** Original business result only; absent when the operation has no business result. */
  readonly business?: JsonValue
}

export interface HostResultControlBase {
  readonly request_id: string
  readonly operation: string
  readonly status: 'ok'
}

export type HostResultControl =
  | (HostResultControlBase & { readonly operation: 'agentWork.findProvider'; readonly result: { readonly target: AgentWorkTarget } })
  | (HostResultControlBase & { readonly operation: 'agentWork.open'; readonly result: { readonly channelRef: string } })
  | (HostResultControlBase & { readonly operation: 'agentWork.propose'; readonly result: { readonly accepted: AgentWork } })
  | (HostResultControlBase & { readonly operation: 'agentWork.request'; readonly result: { readonly replyControl: JsonValue } })
  | (HostResultControlBase & { readonly operation: 'agentWork.get'; readonly result: { readonly replyControl: JsonValue } })
  | (HostResultControlBase & { readonly operation: 'agentWork.close'; readonly result: { readonly work: AgentWork } })
  | (HostResultControlBase & { readonly operation: 'agentWork.dispose'; readonly result: Record<string, never> })

export interface HostResultFrame {
  readonly type: 'host.result'
  readonly control: HostResultControl
  readonly business?: JsonValue
}

export interface HostErrorFrame {
  readonly type: 'host.error'
  readonly control: {
    readonly request_id: string
    readonly operation?: string
    readonly status: 'error'
    readonly error: { readonly code: string; readonly message: string; readonly deliveryState?: 'unconfirmed' }
  }
}

export type HostResponseFrame = HostResultFrame | HostErrorFrame

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HostProtocolError('INVALID_INPUT', `${label} must be a non-empty string`)
  }
  return value
}

export function requiredInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new HostProtocolError('INVALID_INPUT', `${label} must be a safe integer`)
  }
  return value
}

export function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') {
    throw new HostProtocolError('INVALID_INPUT', `${label} must be a boolean`)
  }
  return value
}

export function requiredObject(value: unknown, label: string): Record<string, JsonValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HostProtocolError('INVALID_INPUT', `${label} must be an object`)
  }
  return value as Record<string, JsonValue>
}

export function decodeResourceDemands(value: unknown, label: string): readonly ResourceDemand[] {
  if (!Array.isArray(value)) {
    throw new HostProtocolError('INVALID_INPUT', `${label} must be an array`)
  }
  return value.map((item, index) => {
    const demand = requiredObject(item, `${label}[${index}]`)
    const resourceId = requiredString(demand.resourceId, `${label}[${index}].resourceId`)
    const amount = requiredInteger(demand.amount, `${label}[${index}].amount`)
    if (amount < 1) {
      throw new HostProtocolError('INVALID_INPUT', `${label}[${index}].amount must be positive`)
    }
    return { resourceId, amount }
  })
}

export function decodeAgentWorkServiceSelection(value: unknown, label: string): AgentWorkServiceSelection {
  const selection = requiredObject(value, label)
  if (selection.mode === 'endpoint') {
    return { mode: 'endpoint' }
  }
  if (selection.mode !== 'capability') {
    throw new HostProtocolError('INVALID_INPUT', `${label}.mode must be endpoint or capability`)
  }
  const providerAgentId = requiredString(selection.providerAgentId, `${label}.providerAgentId`)
  const targetGeneration = requiredInteger(selection.targetGeneration, `${label}.targetGeneration`)
  const generationPolicy = selection.generationPolicy
  if (generationPolicy !== 'exact' && generationPolicy !== 'current') {
    throw new HostProtocolError('INVALID_INPUT', `${label}.generationPolicy must be exact or current`)
  }
  const linkGeneration = selection.linkGeneration === undefined
    ? undefined
    : requiredInteger(selection.linkGeneration, `${label}.linkGeneration`)
  return {
    mode: 'capability',
    providerAgentId,
    targetGeneration,
    generationPolicy,
    ...(linkGeneration === undefined ? {} : { linkGeneration }),
  }
}
