import { randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { assertJsonValue } from '../control-protocol/json-value.ts'
import { parseServiceError } from '../control-protocol/relay-codec.ts'
import type {
  AgentWork,
  AuthenticatedAgent,
  CapabilityDeclaration,
  JsonValue,
  OperationDeclaration,
  ResourceAllocation,
  ResourceDemand,
  RequestState,
  ServiceError,
  ServiceErrorCode,
  WorkProposal,
  WorkRequest,
} from '../control-protocol/agent-services.ts'

export interface WorkServiceError extends Error {
  readonly error: ServiceError
}

export interface ProviderWorkPolicy {
  readonly revision: number
  readonly authorizeWork: (consumer: AuthenticatedAgent, proposal: WorkProposal) => boolean
  readonly authorizeRequest?: (consumer: AuthenticatedAgent, work: AgentWork, operation: OperationDeclaration) => boolean
}

export interface StoredWorkRequest {
  readonly control: WorkRequest['control']
  readonly payload: JsonValue
  readonly state: RequestState
  readonly response?: JsonValue
  readonly error?: ServiceError
  readonly allocationIds: readonly string[]
}

export interface WorkLedgerSnapshot {
  readonly version: 1
  readonly revision: number
  readonly provider: AuthenticatedAgent
  readonly works: readonly AgentWork[]
  readonly requests: readonly StoredWorkRequest[]
  readonly allocations: readonly ResourceAllocation[]
}

export interface WorkStore {
  load(): WorkLedgerSnapshot | undefined
  save(expectedRevision: number, snapshot: WorkLedgerSnapshot): void
}

export interface WorkLedgerOptions {
  readonly provider: AuthenticatedAgent
  readonly generation: number
  readonly capabilities: readonly CapabilityDeclaration[]
  readonly store: WorkStore
}

export interface WorkLedger {
  readonly provider: AuthenticatedAgent
  readonly capabilities: readonly CapabilityDeclaration[]
  readonly store: WorkStore
  currentGeneration: number
  snapshot: WorkLedgerSnapshot
}

export interface WorkRequestRecord {
  readonly control: WorkRequest['control']
  readonly payload: JsonValue
  readonly state: RequestState
  readonly response?: JsonValue
  readonly error?: ServiceError
  readonly allocations: readonly ResourceAllocation[]
}

export interface RequestWorkResult {
  readonly request: WorkRequestRecord
  readonly executionAllowed: boolean
  readonly duplicate: boolean
}

export interface RequestCompletion {
  readonly outcome: 'succeeded' | 'failed' | 'cancelled' | 'unknown'
  readonly payload?: JsonValue
  readonly error?: ServiceError
}

export interface RecoveryAllocationObservation {
  readonly allocationId: string
  readonly state: 'held' | 'released' | 'unknown'
}

export interface RecoveryObservation {
  readonly workId: string
  readonly requestId?: string
  readonly requestState?: RequestState
  /** Terminal reconciliation must carry trusted completion data, not only a state label. */
  readonly completion?: RequestCompletion
  readonly allocations?: readonly RecoveryAllocationObservation[]
}

/** Local authority is never part of WorkRequestControl or any remote reply. */
export interface TrustedWorkAuthority {
  readonly kind: 'trusted-local-work-authority'
}

export interface FileLockOwnerIdentity {
  readonly pid: number
  readonly startToken: string
}

export interface FileLockRecoveryProof {
  readonly ownerPid: number
  readonly ownerStartToken: string
  readonly lockToken: string
}

export type VerifyFileLockOwnerExited = (owner: FileLockOwnerIdentity) => boolean

const trustedAuthorities = new WeakSet<object>()
const processStartToken = randomUUID()

/**
 * The runtime persists this token beside its daemon lease so it can prove that
 * a stale work-store lock belonged to the previous daemon owner. It is never
 * sent over the network or included in Work payloads.
 */
export function currentWorkProcessStartToken(): string {
  return processStartToken
}

export function createTrustedWorkAuthority(): TrustedWorkAuthority {
  const authority: TrustedWorkAuthority = { kind: 'trusted-local-work-authority' }
  trustedAuthorities.add(authority)
  return authority
}

function fail(code: ServiceErrorCode, message: string): never {
  const error = new Error(`${code}: ${message}`) as WorkServiceError
  error.name = 'WorkServiceError'
  Object.defineProperty(error, 'error', { value: { code, message }, enumerable: true })
  throw error
}

export function isWorkServiceError(error: unknown): error is WorkServiceError {
  return error instanceof Error && error.name === 'WorkServiceError' && isRecord((error as WorkServiceError).error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail('INVALID_INPUT', `${label} is required`)
  return value
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    fail('INVALID_INPUT', `${label} must be a positive integer`)
  }
  return value
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    fail('INVALID_INPUT', `${label} must be a non-negative integer`)
  }
  return value
}

function authenticatedAgent(value: unknown, label: string): AuthenticatedAgent {
  if (!isRecord(value)) fail('UNAUTHENTICATED', `${label} is missing`)
  return {
    accountId: requiredString(value.accountId, `${label}.accountId`),
    scopeId: requiredString(value.scopeId, `${label}.scopeId`),
    agentId: requiredString(value.agentId, `${label}.agentId`),
  }
}

function sameIdentity(left: AuthenticatedAgent, right: AuthenticatedAgent): boolean {
  return left.accountId === right.accountId && left.scopeId === right.scopeId && left.agentId === right.agentId
}

function jsonValue(value: unknown, path: string): JsonValue {
  try {
    assertJsonValue(value, path)
  } catch (error) {
    fail('INVALID_INPUT', error instanceof Error ? error.message : String(error))
  }
  return normalizeJsonValue(value as JsonValue)
}

function normalizeJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(normalizeJsonValue)
  const output = Object.create(null) as Record<string, JsonValue>
  for (const [key, entry] of Object.entries(value)) output[key] = normalizeJsonValue(entry)
  return output
}

function serviceError(value: unknown, path: string): ServiceError {
  try { return parseServiceError(value, path) }
  catch (error) { fail('INVALID_INPUT', error instanceof Error ? error.message : `${path} must be an error`) }
}

function workState(value: unknown, path: string): AgentWork['state'] {
  const state = requiredString(value, path) as AgentWork['state']
  if (!['accepted', 'closing', 'closed', 'rejected'].includes(state)) fail('INVALID_INPUT', `${path} is unsupported`)
  return state
}

function requestState(value: unknown, path: string): RequestState {
  const state = requiredString(value, path) as RequestState
  if (!['running', 'succeeded', 'failed', 'cancel_requested', 'cancelled', 'unknown'].includes(state)) {
    fail('INVALID_INPUT', `${path} is unsupported`)
  }
  return state
}

function allocationState(value: unknown, path: string): ResourceAllocation['state'] {
  const state = requiredString(value, path) as ResourceAllocation['state']
  if (!['held', 'released', 'unknown'].includes(state)) fail('INVALID_INPUT', `${path} is unsupported`)
  return state
}

function allocationScope(value: unknown, path: string): ResourceAllocation['scope'] {
  const scope = requiredString(value, path) as ResourceAllocation['scope']
  if (scope !== 'request' && scope !== 'work') fail('INVALID_INPUT', `${path} is unsupported`)
  return scope
}

function parseWork(value: unknown, index: number): AgentWork {
  if (!isRecord(value)) fail('INVALID_INPUT', `works[${index}] must be an object`)
  return {
    workId: requiredString(value.workId, `works[${index}].workId`),
    consumerAgentId: requiredString(value.consumerAgentId, `works[${index}].consumerAgentId`),
    providerAgentId: requiredString(value.providerAgentId, `works[${index}].providerAgentId`),
    capabilityId: requiredString(value.capabilityId, `works[${index}].capabilityId`),
    capabilityVersion: requiredString(value.capabilityVersion, `works[${index}].capabilityVersion`),
    policyRevision: positiveInteger(value.policyRevision, `works[${index}].policyRevision`),
    state: workState(value.state, `works[${index}].state`),
  }
}

function parseProposal(value: unknown, path: string): WorkProposal {
  if (!isRecord(value)) fail('INVALID_INPUT', `${path} must be an object`)
  return {
    workId: requiredString(value.workId, `${path}.workId`),
    consumerAgentId: requiredString(value.consumerAgentId, `${path}.consumerAgentId`),
    providerAgentId: requiredString(value.providerAgentId, `${path}.providerAgentId`),
    capabilityId: requiredString(value.capabilityId, `${path}.capabilityId`),
    capabilityVersion: requiredString(value.capabilityVersion, `${path}.capabilityVersion`),
    policyRevision: positiveInteger(value.policyRevision, `${path}.policyRevision`),
  }
}

function parseControl(value: unknown, path: string): WorkRequest['control'] {
  if (!isRecord(value)) fail('INVALID_INPUT', `${path} must be an object`)
  if (!Array.isArray(value.demands)) fail('INVALID_INPUT', `${path}.demands must be an array`)
  return {
    workId: requiredString(value.workId, `${path}.workId`),
    requestId: requiredString(value.requestId, `${path}.requestId`),
    operation: requiredString(value.operation, `${path}.operation`),
    targetGeneration: positiveInteger(value.targetGeneration, `${path}.targetGeneration`),
    demands: value.demands.map((demand, index) => {
      if (!isRecord(demand)) fail('INVALID_INPUT', `${path}.demands[${index}] must be an object`)
      return {
        resourceId: requiredString(demand.resourceId, `${path}.demands[${index}].resourceId`),
        amount: positiveInteger(demand.amount, `${path}.demands[${index}].amount`),
      }
    }),
  }
}

function parseRequest(value: unknown, index: number): StoredWorkRequest {
  if (!isRecord(value)) fail('INVALID_INPUT', `requests[${index}] must be an object`)
  const allocationIds = Array.isArray(value.allocationIds)
    ? value.allocationIds.map((allocationId, allocationIndex) => requiredString(allocationId, `requests[${index}].allocationIds[${allocationIndex}]`))
    : fail('INVALID_INPUT', `requests[${index}].allocationIds must be an array`)
  if (new Set(allocationIds).size !== allocationIds.length) fail('INVALID_INPUT', `requests[${index}].allocationIds contains duplicates`)
  const result: {
    control: WorkRequest['control']
    payload: JsonValue
    state: RequestState
    allocationIds: readonly string[]
    response?: JsonValue
    error?: ServiceError
  } = {
    control: parseControl(value.control, `requests[${index}].control`),
    payload: jsonValue(value.payload, `requests[${index}].payload`),
    state: requestState(value.state, `requests[${index}].state`),
    allocationIds,
  }
  if (value.response !== undefined) result.response = jsonValue(value.response, `requests[${index}].response`)
  if (value.error !== undefined) result.error = serviceError(value.error, `requests[${index}].error`)
  return result
}

function parseAllocation(value: unknown, index: number): ResourceAllocation {
  if (!isRecord(value)) fail('INVALID_INPUT', `allocations[${index}] must be an object`)
  const result: {
    allocationId: string
    workId: string
    requestId?: string
    resourceId: string
    amount: number
    scope: ResourceAllocation['scope']
    state: ResourceAllocation['state']
  } = {
    allocationId: requiredString(value.allocationId, `allocations[${index}].allocationId`),
    workId: requiredString(value.workId, `allocations[${index}].workId`),
    resourceId: requiredString(value.resourceId, `allocations[${index}].resourceId`),
    amount: positiveInteger(value.amount, `allocations[${index}].amount`),
    scope: allocationScope(value.scope, `allocations[${index}].scope`),
    state: allocationState(value.state, `allocations[${index}].state`),
  }
  if (value.requestId !== undefined) result.requestId = requiredString(value.requestId, `allocations[${index}].requestId`)
  if (result.scope === 'request' && result.requestId === undefined) {
    fail('INVALID_INPUT', `allocations[${index}].requestId is required for request scope`)
  }
  if (result.scope === 'work' && result.requestId !== undefined) {
    fail('INVALID_INPUT', `allocations[${index}].requestId is forbidden for work scope`)
  }
  return result
}

function validateSnapshot(value: unknown): WorkLedgerSnapshot {
  if (!isRecord(value)) fail('INVALID_INPUT', 'work store snapshot must be an object')
  if (value.version !== 1) fail('INVALID_INPUT', 'work store version is unsupported')
  if (!Array.isArray(value.works) || !Array.isArray(value.requests) || !Array.isArray(value.allocations)) {
    fail('INVALID_INPUT', 'work store collections are invalid')
  }
  const snapshot: WorkLedgerSnapshot = {
    version: 1,
    revision: nonNegativeInteger(value.revision, 'work store revision'),
    provider: authenticatedAgent(value.provider, 'work store provider'),
    works: value.works.map(parseWork),
    requests: value.requests.map(parseRequest),
    allocations: value.allocations.map(parseAllocation),
  }
  const workIds = new Set<string>()
  for (const work of snapshot.works) {
    if (workIds.has(work.workId)) fail('INVALID_INPUT', `duplicate work ${work.workId}`)
    if (work.providerAgentId !== snapshot.provider.agentId) fail('INVALID_INPUT', `work ${work.workId} targets another provider`)
    workIds.add(work.workId)
  }
  const requestIds = new Set<string>()
  for (const request of snapshot.requests) {
    const key = requestKey(request.control.workId, request.control.requestId)
    if (requestIds.has(key)) fail('INVALID_INPUT', `duplicate request ${key}`)
    requestIds.add(key)
  }
  const allocationIds = new Set<string>()
  for (const allocation of snapshot.allocations) {
    if (allocationIds.has(allocation.allocationId)) fail('INVALID_INPUT', `duplicate allocation ${allocation.allocationId}`)
    allocationIds.add(allocation.allocationId)
  }
  const requestsByKey = new Map(snapshot.requests.map(request => [requestKey(request.control.workId, request.control.requestId), request]))
  const worksById = new Map(snapshot.works.map(work => [work.workId, work]))
  const referencedAllocationIds = new Map<string, number>()
  for (const request of snapshot.requests) {
    if (!workIds.has(request.control.workId)) fail('INVALID_INPUT', `request references missing work ${request.control.workId}`)
    const owningWork = worksById.get(request.control.workId)
    if (owningWork?.state === 'closed' && request.state !== 'succeeded' && request.state !== 'failed' && request.state !== 'cancelled') {
      fail('INVALID_INPUT', `work ${request.control.workId} was destroyed before request ${request.control.requestId} completed`)
    }
    for (const allocationId of request.allocationIds) {
      const allocation = snapshot.allocations.find(candidate => candidate.allocationId === allocationId)
      if (allocation === undefined) fail('INVALID_INPUT', `request references missing allocation ${allocationId}`)
      if (allocation.workId !== request.control.workId) fail('INVALID_INPUT', `allocation ${allocationId} belongs to another work`)
      if (allocation.scope === 'request' && allocation.requestId !== request.control.requestId) {
        fail('INVALID_INPUT', `request allocation ${allocationId} is bound to another request`)
      }
      referencedAllocationIds.set(allocationId, (referencedAllocationIds.get(allocationId) ?? 0) + 1)
    }
  }
  for (const allocation of snapshot.allocations) {
    if (!workIds.has(allocation.workId)) fail('INVALID_INPUT', `allocation references missing work ${allocation.workId}`)
    if (!referencedAllocationIds.has(allocation.allocationId)) fail('INVALID_INPUT', `orphan allocation ${allocation.allocationId}`)
    if (allocation.scope === 'request') {
      const request = requestsByKey.get(requestKey(allocation.workId, allocation.requestId as string))
      if (request === undefined || !request.allocationIds.includes(allocation.allocationId)) {
        fail('INVALID_INPUT', `request allocation ${allocation.allocationId} is not linked to its request`)
      }
      if (referencedAllocationIds.get(allocation.allocationId) !== 1) {
        fail('INVALID_INPUT', `request allocation ${allocation.allocationId} is linked more than once`)
      }
      const terminal = request.state === 'succeeded' || request.state === 'failed' || request.state === 'cancelled'
      if (terminal && allocation.state !== 'released') {
        fail('INVALID_INPUT', `request allocation ${allocation.allocationId} remains occupied after completion`)
      }
      if (!terminal && allocation.state === 'released') {
        fail('INVALID_INPUT', `request allocation ${allocation.allocationId} was released before completion`)
      }
    } else if (allocation.state === 'released' && worksById.get(allocation.workId)?.state !== 'closed') {
      fail('INVALID_INPUT', `work allocation ${allocation.allocationId} was released before work destruction`)
    }
  }
  return snapshot
}

function requestKey(workId: string, requestId: string): string {
  return JSON.stringify([workId, requestId])
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
}

function validateCapabilities(capabilities: readonly CapabilityDeclaration[]): void {
  if (!Array.isArray(capabilities)) fail('INVALID_INPUT', 'capabilities must be an array')
  const capabilityIds = new Set<string>()
  const resourceOwners = new Map<string, string>()
  for (const capability of capabilities) {
    if (typeof capability !== 'object' || capability === null || Array.isArray(capability)) fail('INVALID_INPUT', 'capability must be an object')
    requiredString(capability.capabilityId, 'capabilityId')
    requiredString(capability.version, `capability ${capability.capabilityId}.version`)
    if (capabilityIds.has(capability.capabilityId)) fail('CONFLICT', `duplicate capability ${capability.capabilityId}`)
    capabilityIds.add(capability.capabilityId)
    if (!Array.isArray(capability.operations) || !Array.isArray(capability.resources)) {
      fail('INVALID_INPUT', `capability ${capability.capabilityId} declarations are invalid`)
    }
    const operationIds = new Set<string>()
    for (const operation of capability.operations) {
      if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) fail('INVALID_INPUT', `capability ${capability.capabilityId}.operation must be an object`)
      requiredString(operation.operation, `capability ${capability.capabilityId}.operation`)
      if (operationIds.has(operation.operation)) fail('CONFLICT', `duplicate operation ${operation.operation}`)
      operationIds.add(operation.operation)
      if (operation.cancellation !== 'unsupported' && operation.cancellation !== 'cooperative') {
        fail('INVALID_INPUT', `operation ${operation.operation}.cancellation is unsupported`)
      }
      if (!isRecord(operation.inputSchema) || !isRecord(operation.outputSchema)) {
        fail('INVALID_INPUT', `operation ${operation.operation} schemas must be objects`)
      }
      jsonValue(operation.inputSchema, `operation ${operation.operation}.inputSchema`)
      jsonValue(operation.outputSchema, `operation ${operation.operation}.outputSchema`)
    }
    for (const resource of capability.resources) {
      if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) fail('INVALID_INPUT', `capability ${capability.capabilityId}.resource must be an object`)
      requiredString(resource.resourceId, `capability ${capability.capabilityId}.resourceId`)
      positiveInteger(resource.capacity, `resource ${resource.resourceId}.capacity`)
      if (resource.unit !== 'slot' && resource.unit !== 'context') fail('INVALID_INPUT', `resource ${resource.resourceId}.unit is unsupported`)
      if (resource.sharing !== 'exclusive' && resource.sharing !== 'shared') fail('INVALID_INPUT', `resource ${resource.resourceId}.sharing is unsupported`)
      if (resource.allocationScope !== 'request' && resource.allocationScope !== 'work') {
        fail('INVALID_INPUT', `resource ${resource.resourceId}.allocationScope is unsupported`)
      }
      if (resource.sharing === 'exclusive' && resource.capacity !== 1) {
        fail('INVALID_INPUT', `exclusive resource ${resource.resourceId} must have capacity 1`)
      }
      const previousOwner = resourceOwners.get(resource.resourceId)
      if (previousOwner !== undefined) {
        fail('CONFLICT', `resource ${resource.resourceId} is declared by both ${previousOwner} and ${capability.capabilityId}`)
      }
      resourceOwners.set(resource.resourceId, capability.capabilityId)
    }
  }
}

function readStore(filePath: string): WorkLedgerSnapshot | undefined {
  if (!existsSync(filePath)) return undefined
  try {
    return validateSnapshot(JSON.parse(readFileSync(filePath, 'utf8')))
  } catch (error) {
    if (isWorkServiceError(error)) throw error
    fail('INVALID_INPUT', `work store is corrupted: ${error instanceof Error ? error.message : String(error)}`)
  }
}

interface FileLockMetadata extends FileLockRecoveryProof {
  readonly version: 1
}

function parseFileLockProof(value: unknown, path: string): FileLockRecoveryProof {
  if (!isRecord(value)) fail('INVALID_INPUT', `${path} must be an object`)
  return {
    ownerPid: positiveInteger(value.ownerPid, `${path}.ownerPid`),
    ownerStartToken: requiredString(value.ownerStartToken, `${path}.ownerStartToken`),
    lockToken: requiredString(value.lockToken, `${path}.lockToken`),
  }
}

function parseFileLockMetadata(value: unknown, path: string): FileLockMetadata {
  if (!isRecord(value) || value.version !== 1) fail('INVALID_INPUT', `${path} has unsupported metadata`)
  return { version: 1, ...parseFileLockProof(value, path) }
}

function readFileLockMetadata(lockPath: string): FileLockMetadata {
  try {
    return parseFileLockMetadata(JSON.parse(readFileSync(lockPath, 'utf8')), lockPath)
  } catch (error) {
    if (isWorkServiceError(error)) throw error
    fail('INVALID_INPUT', `lock metadata is corrupted: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function readFileWorkStoreLockProof(filePath: string): FileLockRecoveryProof | undefined {
  requiredString(filePath, 'filePath')
  const lockPath = `${filePath}.lock`
  if (!existsSync(lockPath)) return undefined
  return readFileLockMetadata(lockPath)
}

function withFileLock<T>(filePath: string, action: () => T): T {
  const lockPath = `${filePath}.lock`
  let descriptor: number
  try {
    descriptor = openSync(lockPath, 'wx', 0o600)
  } catch (error) {
    fail('UNAVAILABLE', `work store is locked: ${error instanceof Error ? error.message : String(error)}`)
  }
  const metadata: FileLockMetadata = {
    version: 1,
    ownerPid: process.pid,
    ownerStartToken: processStartToken,
    lockToken: randomUUID(),
  }
  try {
    writeSync(descriptor, `${JSON.stringify(metadata)}\n`, 0, 'utf8')
    fsyncSync(descriptor)
    return action()
  } finally {
    closeSync(descriptor)
    try {
      unlinkSync(lockPath)
    } catch {
      // Keep the original operation result; a stale lock fails closed on the next write.
    }
  }
}

/**
 * Remove a crashed writer lock only after the daemon owner proves the exact
 * PID/start-token pair exited. The daemon must serialize recovery with any
 * replacement writer; this API never uses lock age or a timeout as proof.
 */
export function recoverFileWorkStoreLock(
  filePath: string,
  authority: TrustedWorkAuthority,
  proof: FileLockRecoveryProof,
  verifyOwnerExited: VerifyFileLockOwnerExited,
): void {
  requireTrustedAuthority(authority)
  requiredString(filePath, 'filePath')
  if (typeof verifyOwnerExited !== 'function') fail('INVALID_INPUT', 'verifyOwnerExited is required')
  const lockPath = `${filePath}.lock`
  if (!existsSync(lockPath)) return
  const expected = parseFileLockProof(proof, 'recovery proof')
  const metadata = readFileLockMetadata(lockPath)
  if (metadata.ownerPid !== expected.ownerPid || metadata.ownerStartToken !== expected.ownerStartToken || metadata.lockToken !== expected.lockToken) {
    fail('CONFLICT', 'recovery proof does not match the current lock owner')
  }
  let ownerExited = false
  try {
    ownerExited = verifyOwnerExited({ pid: metadata.ownerPid, startToken: metadata.ownerStartToken })
  } catch (error) {
    fail('UNAVAILABLE', `owner exit proof failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!ownerExited) fail('UNAVAILABLE', 'lock owner exit is not proven')
  try {
    unlinkSync(lockPath)
  } catch (error) {
    fail('UNAVAILABLE', `work store lock recovery failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function writeAtomic(filePath: string, snapshot: WorkLedgerSnapshot): void {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
  const serialized = `${JSON.stringify(snapshot)}\n`
  let descriptor: number | undefined
  try {
    descriptor = openSync(temporaryPath, 'wx', 0o600)
    writeSync(descriptor, serialized, 0, 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    renameSync(temporaryPath, filePath)
    const directoryDescriptor = openSync(dirname(filePath), 'r')
    try {
      fsyncSync(directoryDescriptor)
    } finally {
      closeSync(directoryDescriptor)
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath)
  }
}

export function createFileWorkStore(filePath: string): WorkStore {
  requiredString(filePath, 'filePath')
  mkdirSync(dirname(filePath), { recursive: true })
  return {
    load: () => readStore(filePath),
    save: (expectedRevision, snapshot) => withFileLock(filePath, () => {
      const current = readStore(filePath)
      const actualRevision = current?.revision ?? 0
      if (actualRevision !== expectedRevision) fail('REVISION_CONFLICT', `expected revision ${expectedRevision}, found ${actualRevision}`)
      if (snapshot.revision !== expectedRevision + 1) fail('REVISION_CONFLICT', 'work store revision must advance by one')
      validateSnapshot(snapshot)
      writeAtomic(filePath, snapshot)
    }),
  }
}

export function createWorkLedger(options: WorkLedgerOptions): WorkLedger {
  const provider = authenticatedAgent(options.provider, 'provider')
  const generation = positiveInteger(options.generation, 'generation')
  validateCapabilities(options.capabilities)
  const loaded = options.store.load()
  if (loaded !== undefined && !sameIdentity(loaded.provider, provider)) {
    fail('FORBIDDEN', 'work store belongs to another provider identity')
  }
  const snapshot = loaded ?? {
    version: 1 as const,
    revision: 0,
    provider,
    works: [],
    requests: [],
    allocations: [],
  }
  return { provider, currentGeneration: generation, capabilities: options.capabilities, store: options.store, snapshot }
}

function commit(ledger: WorkLedger, snapshot: WorkLedgerSnapshot): void {
  if (snapshot.revision !== ledger.snapshot.revision + 1) fail('REVISION_CONFLICT', 'work ledger revision is not adjacent')
  ledger.store.save(ledger.snapshot.revision, snapshot)
  ledger.snapshot = snapshot
}

function nextSnapshot(ledger: WorkLedger, patch: Omit<Partial<WorkLedgerSnapshot>, 'version' | 'revision' | 'provider'>): WorkLedgerSnapshot {
  return {
    ...ledger.snapshot,
    ...patch,
    version: 1,
    provider: ledger.provider,
    revision: ledger.snapshot.revision + 1,
  }
}

function findWork(ledger: WorkLedger, workId: string): AgentWork {
  const work = ledger.snapshot.works.find(candidate => candidate.workId === workId)
  if (work === undefined) fail('NOT_FOUND', `unknown work ${workId}`)
  return work
}

function findRequest(ledger: WorkLedger, workId: string, requestId: string): StoredWorkRequest {
  const request = ledger.snapshot.requests.find(candidate => candidate.control.workId === workId && candidate.control.requestId === requestId)
  if (request === undefined) fail('NOT_FOUND', `unknown request ${requestKey(workId, requestId)}`)
  return request
}

function recordFor(ledger: WorkLedger, request: StoredWorkRequest): WorkRequestRecord {
  const allocations = request.allocationIds.map((allocationId) => {
    const allocation = ledger.snapshot.allocations.find(candidate => candidate.allocationId === allocationId)
    if (allocation === undefined) fail('INVALID_INPUT', `request references missing allocation ${allocationId}`)
    return allocation
  })
  return { ...request, allocations }
}

function capabilityFor(ledger: WorkLedger, work: AgentWork): CapabilityDeclaration {
  const capability = ledger.capabilities.find(candidate => candidate.capabilityId === work.capabilityId)
  if (capability === undefined) fail('NOT_FOUND', `unknown capability ${work.capabilityId}`)
  if (capability.version !== work.capabilityVersion) fail('UNSUPPORTED_VERSION', `capability ${work.capabilityId} version is no longer available`)
  return capability
}

function operationFor(ledger: WorkLedger, work: AgentWork, operationId: string): OperationDeclaration {
  const operation = capabilityFor(ledger, work).operations.find(candidate => candidate.operation === operationId)
  if (operation === undefined) fail('UNSUPPORTED_OPERATION', `operation ${operationId} is not declared by ${work.capabilityId}`)
  return operation
}

function assertConsumer(value: unknown, work: AgentWork): AuthenticatedAgent {
  const consumer = authenticatedAgent(value, 'authenticatedConsumer')
  if (consumer.agentId !== work.consumerAgentId) fail('FORBIDDEN', 'authenticated consumer does not own this work')
  return consumer
}

function assertSameScope(agent: AuthenticatedAgent, provider: AuthenticatedAgent): void {
  if (agent.accountId !== provider.accountId || agent.scopeId !== provider.scopeId) {
    fail('FORBIDDEN', 'authenticated agent is outside the provider scope')
  }
}

function assertProvider(work: WorkProposal, provider: AuthenticatedAgent): void {
  if (work.providerAgentId !== provider.agentId) fail('FORBIDDEN', 'work proposal does not target the local provider')
}

function validateDemands(capability: CapabilityDeclaration, demands: readonly ResourceDemand[]): Map<string, ResourceDemand> {
  const declarations = new Map(capability.resources.map(resource => [resource.resourceId, resource]))
  const result = new Map<string, ResourceDemand>()
  for (const demand of demands) {
    const resource = declarations.get(demand.resourceId)
    if (resource === undefined) fail('UNSUPPORTED_OPERATION', `resource ${demand.resourceId} is not declared`)
    positiveInteger(demand.amount, `demand ${demand.resourceId}.amount`)
    if (result.has(demand.resourceId)) fail('CONFLICT', `resource ${demand.resourceId} is demanded twice`)
    result.set(demand.resourceId, demand)
  }
  for (const resource of capability.resources) {
    if (!result.has(resource.resourceId)) fail('INVALID_INPUT', `demand ${resource.resourceId} is required`)
  }
  return result
}

function rejectRequest(ledger: WorkLedger, request: WorkRequest, error: ServiceError): RequestWorkResult {
  const stored: StoredWorkRequest = {
    control: request.control,
    payload: request.payload,
    state: 'failed',
    error,
    allocationIds: [],
  }
  commit(ledger, nextSnapshot(ledger, { requests: [...ledger.snapshot.requests, stored] }))
  return { request: recordFor(ledger, stored), executionAllowed: false, duplicate: false }
}

export function proposeWork(
  ledger: WorkLedger,
  authenticatedConsumer: AuthenticatedAgent,
  proposal: WorkProposal,
  policy: ProviderWorkPolicy,
): AgentWork {
  const consumer = authenticatedAgent(authenticatedConsumer, 'authenticatedConsumer')
  assertSameScope(consumer, ledger.provider)
  const normalizedProposal = parseProposal(proposal, 'proposal')
  assertProvider(normalizedProposal, ledger.provider)
  if (normalizedProposal.consumerAgentId !== consumer.agentId) fail('FORBIDDEN', 'work proposal consumer is not the authenticated agent')
  const existing = ledger.snapshot.works.find(work => work.workId === normalizedProposal.workId)
  if (existing !== undefined) {
    const existingProposal: WorkProposal = {
      workId: existing.workId,
      consumerAgentId: existing.consumerAgentId,
      providerAgentId: existing.providerAgentId,
      capabilityId: existing.capabilityId,
      capabilityVersion: existing.capabilityVersion,
      policyRevision: existing.policyRevision,
    }
    const sameProposal = stableJson(existingProposal) === stableJson(normalizedProposal)
    if (!sameProposal) fail('CONFLICT', `work ${normalizedProposal.workId} already exists with different parameters`)
    return existing
  }
  if (normalizedProposal.policyRevision !== policy.revision) fail('REVISION_CONFLICT', 'work policy revision is stale')
  const capability = ledger.capabilities.find(candidate => candidate.capabilityId === normalizedProposal.capabilityId)
  if (capability === undefined) fail('NOT_FOUND', `unknown capability ${normalizedProposal.capabilityId}`)
  if (capability.version !== normalizedProposal.capabilityVersion) fail('UNSUPPORTED_VERSION', `unsupported capability version ${normalizedProposal.capabilityVersion}`)
  const state: AgentWork['state'] = policy.authorizeWork(consumer, normalizedProposal) ? 'accepted' : 'rejected'
  const work: AgentWork = { ...normalizedProposal, state }
  commit(ledger, nextSnapshot(ledger, { works: [...ledger.snapshot.works, work] }))
  return work
}

function assertRequestShape(value: unknown): WorkRequest {
  if (!isRecord(value)) fail('INVALID_INPUT', 'request must be an object')
  return {
    control: parseControl(value.control, 'request.control'),
    payload: jsonValue(value.payload, 'request.payload'),
  }
}

function requestMatches(existing: StoredWorkRequest, request: WorkRequest): boolean {
  return stableJson(existing.control) === stableJson(request.control) && stableJson(existing.payload) === stableJson(request.payload)
}

function activeAllocations(ledger: WorkLedger, resourceId: string): readonly ResourceAllocation[] {
  return ledger.snapshot.allocations.filter(allocation => allocation.resourceId === resourceId && allocation.state !== 'released')
}

export function requestWork(
  ledger: WorkLedger,
  input: { readonly authenticatedConsumer: AuthenticatedAgent; readonly request: WorkRequest; readonly policy: ProviderWorkPolicy },
): RequestWorkResult {
  const request = assertRequestShape(input.request)
  const work = findWork(ledger, request.control.workId)
  const consumer = assertConsumer(input.authenticatedConsumer, work)
  assertSameScope(consumer, ledger.provider)
  const existing = ledger.snapshot.requests.find(candidate => candidate.control.workId === request.control.workId && candidate.control.requestId === request.control.requestId)
  if (existing !== undefined) {
    if (!requestMatches(existing, request)) fail('CONFLICT', `request ${requestKey(request.control.workId, request.control.requestId)} parameters changed`)
    return { request: recordFor(ledger, existing), executionAllowed: false, duplicate: true }
  }
  if (work.state !== 'accepted') return rejectRequest(ledger, request, { code: 'FORBIDDEN', message: `work is ${work.state}` })
  if (input.policy.revision !== work.policyRevision) {
    fail('REVISION_CONFLICT', `work policy revision ${work.policyRevision} is not current`)
  }
  if (request.control.targetGeneration !== ledger.currentGeneration) {
    fail('STALE_GENERATION', `request targets generation ${request.control.targetGeneration}, current is ${ledger.currentGeneration}`)
  }
  const capability = capabilityFor(ledger, work)
  const operation = operationFor(ledger, work, request.control.operation)
  if (input.policy.authorizeRequest?.(consumer, work, operation) === false) {
    return rejectRequest(ledger, request, { code: 'FORBIDDEN', message: 'provider policy revoked this work request' })
  }
  if (ledger.snapshot.requests.some(request => request.control.workId === work.workId && request.state === 'unknown')) {
    return rejectRequest(ledger, request, { code: 'RESULT_UNKNOWN', message: 'work has an unresolved request result' })
  }
  if (ledger.snapshot.allocations.some(allocation =>
    allocation.workId === work.workId
    && allocation.scope === 'work'
    && allocation.state === 'unknown')) {
    return rejectRequest(ledger, request, { code: 'RESULT_UNKNOWN', message: 'work has an unresolved resource allocation' })
  }
  const demands = validateDemands(capability, request.control.demands)
  const workAllocations = new Map(ledger.snapshot.allocations
    .filter(allocation => allocation.workId === work.workId && allocation.scope === 'work' && allocation.state !== 'released')
    .map(allocation => [allocation.resourceId, allocation]))
  if (workAllocations.size > 0) {
    for (const [resourceId, allocation] of workAllocations) {
      const demand = demands.get(resourceId)
      if (demand === undefined || demand.amount !== allocation.amount) {
        return rejectRequest(ledger, request, { code: 'CONFLICT', message: `work allocation demand changed for ${resourceId}` })
      }
      const resource = capability.resources.find(candidate => candidate.resourceId === resourceId)
      if (resource?.allocationScope !== 'work') {
        return rejectRequest(ledger, request, { code: 'CONFLICT', message: `work allocation scope changed for ${resourceId}` })
      }
    }
    for (const demand of demands.values()) {
      const resource = capability.resources.find(candidate => candidate.resourceId === demand.resourceId)
      if (resource?.allocationScope === 'work' && !workAllocations.has(demand.resourceId)) {
        return rejectRequest(ledger, request, { code: 'CONFLICT', message: `work allocation demand changed for ${demand.resourceId}` })
      }
    }
  }
  const newAllocations: ResourceAllocation[] = []
  for (const demand of demands.values()) {
    const resource = capability.resources.find(candidate => candidate.resourceId === demand.resourceId)
    if (resource === undefined) fail('UNSUPPORTED_OPERATION', `resource ${demand.resourceId} is not declared`)
    if (workAllocations.has(demand.resourceId)) continue
    const occupied = activeAllocations(ledger, demand.resourceId).reduce((sum, allocation) => sum + allocation.amount, 0)
    if (resource.sharing === 'exclusive' && (occupied > 0 || demand.amount !== 1)) {
      return rejectRequest(ledger, request, { code: 'RESOURCE_EXHAUSTED', message: `exclusive resource ${resource.resourceId} is occupied` })
    }
    if (occupied + demand.amount > resource.capacity) {
      return rejectRequest(ledger, request, { code: 'RESOURCE_EXHAUSTED', message: `resource ${resource.resourceId} capacity exhausted` })
    }
    newAllocations.push({
      allocationId: `allocation-${randomUUID()}`,
      workId: work.workId,
      ...(resource.allocationScope === 'request' ? { requestId: request.control.requestId } : {}),
      resourceId: resource.resourceId,
      amount: demand.amount,
      scope: resource.allocationScope,
      state: 'held',
    })
  }
  const allocationIds = [
    ...workAllocations.values(),
    ...newAllocations,
  ].map(allocation => allocation.allocationId)
  const stored: StoredWorkRequest = {
    control: request.control,
    payload: request.payload,
    state: 'running',
    allocationIds,
  }
  commit(ledger, nextSnapshot(ledger, {
    requests: [...ledger.snapshot.requests, stored],
    allocations: [...ledger.snapshot.allocations, ...newAllocations],
  }))
  return { request: recordFor(ledger, stored), executionAllowed: true, duplicate: false }
}

export function getRequest(ledger: WorkLedger, workId: string, requestId: string): WorkRequestRecord {
  return recordFor(ledger, findRequest(ledger, workId, requestId))
}

export function requestCancellation(
  ledger: WorkLedger,
  authenticatedConsumer: AuthenticatedAgent,
  workId: string,
  requestId: string,
): WorkRequestRecord {
  const work = findWork(ledger, workId)
  const consumer = assertConsumer(authenticatedConsumer, work)
  assertSameScope(consumer, ledger.provider)
  const current = findRequest(ledger, workId, requestId)
  if (current.state === 'succeeded' || current.state === 'failed' || current.state === 'cancelled') return recordFor(ledger, current)
  if (current.state === 'unknown') fail('RESULT_UNKNOWN', `request ${requestKey(workId, requestId)} has unknown result`)
  const operation = operationFor(ledger, work, current.control.operation)
  if (operation.cancellation === 'unsupported') fail('UNSUPPORTED_OPERATION', `operation ${operation.operation} does not support cancellation`)
  if (current.state === 'cancel_requested') return recordFor(ledger, current)
  const updated: StoredWorkRequest = { ...current, state: 'cancel_requested' }
  commit(ledger, nextSnapshot(ledger, { requests: ledger.snapshot.requests.map(request => request === current ? updated : request) }))
  return recordFor(ledger, updated)
}

function requireTrustedAuthority(authority: TrustedWorkAuthority): void {
  if (typeof authority !== 'object' || authority === null || !trustedAuthorities.has(authority)) {
    fail('FORBIDDEN', 'operation requires local trusted authority')
  }
}

function completionState(outcome: RequestCompletion['outcome']): RequestState {
  if (outcome === 'succeeded') return 'succeeded'
  if (outcome === 'failed') return 'failed'
  if (outcome === 'cancelled') return 'cancelled'
  return 'unknown'
}

interface NormalizedCompletion {
  readonly outcome: RequestCompletion['outcome']
  readonly payload?: JsonValue
  readonly error?: ServiceError
}

function parseCompletion(value: unknown, path: string): NormalizedCompletion {
  if (!isRecord(value)) fail('INVALID_INPUT', `${path} must be an object`)
  const outcome = requiredString(value.outcome, `${path}.outcome`) as RequestCompletion['outcome']
  if (!['succeeded', 'failed', 'cancelled', 'unknown'].includes(outcome)) fail('INVALID_INPUT', `${path}.outcome is unsupported`)
  const payload = value.payload === undefined ? undefined : jsonValue(value.payload, `${path}.payload`)
  const error = value.error === undefined ? undefined : serviceError(value.error, `${path}.error`)
  return { outcome, ...(payload === undefined ? {} : { payload }), ...(error === undefined ? {} : { error }) }
}

function completionError(completion: NormalizedCompletion): ServiceError | undefined {
  if (completion.outcome === 'unknown') return completion.error ?? { code: 'RESULT_UNKNOWN', message: 'request result is unknown' }
  if (completion.outcome === 'failed') return completion.error ?? { code: 'UPSTREAM_ERROR', message: 'request failed' }
  return completion.error
}

export function completeRequest(
  ledger: WorkLedger,
  authority: TrustedWorkAuthority,
  workId: string,
  requestId: string,
  completion: RequestCompletion,
): WorkRequestRecord {
  requireTrustedAuthority(authority)
  const normalizedCompletion = parseCompletion(completion, 'completion')
  const outcome = normalizedCompletion.outcome
  const payload = normalizedCompletion.payload
  const current = findRequest(ledger, workId, requestId)
  const nextState = completionState(outcome)
  const error = completionError(normalizedCompletion)
  if (current.state === 'succeeded' || current.state === 'failed' || current.state === 'cancelled') {
    if (current.state !== nextState || stableJson(current.response) !== stableJson(payload) || stableJson(current.error) !== stableJson(error)) {
      fail('CONFLICT', `request ${requestKey(workId, requestId)} already completed differently`)
    }
    return recordFor(ledger, current)
  }
  const allocationIds = new Set(current.allocationIds)
  const allocations = ledger.snapshot.allocations.map(allocation => {
    if (!allocationIds.has(allocation.allocationId)) return allocation
    if (outcome === 'unknown') return { ...allocation, state: 'unknown' as const }
    if (allocation.scope === 'request') return { ...allocation, state: 'released' as const }
    return allocation
  })
  const updated: StoredWorkRequest = {
    ...current,
    state: nextState,
    ...(payload === undefined ? { response: undefined } : { response: payload }),
    ...(error === undefined ? { error: undefined } : { error }),
  }
  commit(ledger, nextSnapshot(ledger, {
    requests: ledger.snapshot.requests.map(request => request === current ? updated : request),
    allocations,
  }))
  return recordFor(ledger, updated)
}

export function closeWork(ledger: WorkLedger, authenticatedConsumer: AuthenticatedAgent, workId: string): AgentWork {
  const work = findWork(ledger, workId)
  const consumer = assertConsumer(authenticatedConsumer, work)
  assertSameScope(consumer, ledger.provider)
  if (work.state === 'closed' || work.state === 'closing' || work.state === 'rejected') return work
  const updated: AgentWork = { ...work, state: 'closing' }
  commit(ledger, nextSnapshot(ledger, { works: ledger.snapshot.works.map(candidate => candidate === work ? updated : candidate) }))
  return updated
}

export function confirmWorkDestroyed(ledger: WorkLedger, authority: TrustedWorkAuthority, workId: string): AgentWork {
  requireTrustedAuthority(authority)
  const work = findWork(ledger, workId)
  if (work.state === 'closed') return work
  if (work.state !== 'closing') fail('CONFLICT', `work ${workId} is ${work.state}, not closing`)
  const requests = ledger.snapshot.requests.filter(request => request.control.workId === workId)
  if (requests.some(request => request.state === 'unknown')) fail('RESULT_UNKNOWN', `work ${workId} has an unresolved request`)
  if (requests.some(request => request.state === 'running' || request.state === 'cancel_requested')) {
    fail('CONFLICT', `work ${workId} still has an active request`)
  }
  const allocations = ledger.snapshot.allocations.map(allocation => allocation.workId === workId ? { ...allocation, state: 'released' as const } : allocation)
  const updated: AgentWork = { ...work, state: 'closed' }
  commit(ledger, nextSnapshot(ledger, {
    works: ledger.snapshot.works.map(candidate => candidate === work ? updated : candidate),
    allocations,
  }))
  return updated
}

function parseRecoveryObservation(value: unknown, index: number): RecoveryObservation {
  if (!isRecord(value)) fail('INVALID_INPUT', `recovery observations[${index}] must be an object`)
  const workId = requiredString(value.workId, `recovery observations[${index}].workId`)
  const requestId = value.requestId === undefined
    ? undefined
    : requiredString(value.requestId, `recovery observations[${index}].requestId`)
  const observedRequestState = value.requestState === undefined
    ? undefined
    : requestState(value.requestState, `recovery observations[${index}].requestState`)
  const completion = value.completion === undefined
    ? undefined
    : parseCompletion(value.completion, `recovery observations[${index}].completion`)
  if (requestId === undefined && (observedRequestState !== undefined || completion !== undefined)) {
    fail('INVALID_INPUT', `recovery observations[${index}].requestState/completion requires requestId`)
  }
  if (completion !== undefined && observedRequestState !== undefined && completionState(completion.outcome) !== observedRequestState) {
    fail('CONFLICT', `recovery observations[${index}] state does not match completion outcome`)
  }
  if (observedRequestState !== undefined && ['succeeded', 'failed', 'cancelled'].includes(observedRequestState) && completion === undefined) {
    fail('CONFLICT', `recovery observations[${index}] terminal state requires completion data`)
  }
  if (value.allocations !== undefined && !Array.isArray(value.allocations)) {
    fail('INVALID_INPUT', `recovery observations[${index}].allocations must be an array`)
  }
  const allocations = (value.allocations ?? []).map((allocation, allocationIndex) => {
    if (!isRecord(allocation)) fail('INVALID_INPUT', `recovery observations[${index}].allocations[${allocationIndex}] must be an object`)
    return {
      allocationId: requiredString(allocation.allocationId, `recovery observations[${index}].allocations[${allocationIndex}].allocationId`),
      state: allocationState(allocation.state, `recovery observations[${index}].allocations[${allocationIndex}].state`),
    }
  })
  return {
    workId,
    ...(requestId === undefined ? {} : { requestId }),
    ...(observedRequestState === undefined ? {} : { requestState: observedRequestState }),
    ...(completion === undefined ? {} : { completion }),
    ...(allocations.length === 0 ? {} : { allocations }),
  }
}

export function recover(ledger: WorkLedger, authority: TrustedWorkAuthority, observations: readonly RecoveryObservation[]): WorkLedger {
  requireTrustedAuthority(authority)
  if (!Array.isArray(observations)) fail('INVALID_INPUT', 'recovery observations must be an array')
  const normalizedObservations = observations.map(parseRecoveryObservation)
  const observationByRequest = new Map<string, RecoveryObservation>()
  const observationByAllocation = new Map<string, RecoveryAllocationObservation['state']>()
  const completionByRequest = new Map<string, { readonly workId: string; readonly requestId: string; readonly completion: NormalizedCompletion }>()
  for (const observation of normalizedObservations) {
    if (observation.requestId !== undefined) {
      const key = requestKey(observation.workId, observation.requestId)
      const current = findRequest(ledger, observation.workId, observation.requestId)
      if (observationByRequest.has(key)) fail('CONFLICT', `duplicate recovery request observation ${key}`)
      const observedState = observation.requestState ?? (observation.completion === undefined ? undefined : completionState(observation.completion.outcome))
      if (observedState !== undefined && current.state !== observedState) {
        const validTransition = current.state === 'running'
          ? ['cancel_requested', 'succeeded', 'failed', 'cancelled', 'unknown'].includes(observedState)
          : current.state === 'cancel_requested'
            ? ['succeeded', 'failed', 'cancelled', 'unknown'].includes(observedState)
            : current.state === 'unknown' && observation.completion !== undefined
              ? ['succeeded', 'failed', 'cancelled'].includes(observedState)
            : false
        if (!validTransition) fail('CONFLICT', `invalid recovery transition for request ${key}`)
      }
      observationByRequest.set(key, observation)
      if (observation.completion !== undefined) {
        completionByRequest.set(key, { workId: observation.workId, requestId: observation.requestId, completion: observation.completion })
      }
    }
  }
  for (const observation of normalizedObservations) {
    const work = findWork(ledger, observation.workId)
    for (const observedAllocation of observation.allocations ?? []) {
      const allocation = ledger.snapshot.allocations.find(candidate => candidate.allocationId === observedAllocation.allocationId)
      if (allocation === undefined) fail('NOT_FOUND', `unknown recovery allocation ${observedAllocation.allocationId}`)
      if (allocation.workId !== work.workId) fail('CONFLICT', `recovery allocation ${observedAllocation.allocationId} belongs to another work`)
      if (observationByAllocation.has(observedAllocation.allocationId)) fail('CONFLICT', `duplicate recovery allocation observation ${observedAllocation.allocationId}`)
      if (allocation.state === 'released' && observedAllocation.state !== 'released') {
        fail('CONFLICT', `recovery cannot resurrect released allocation ${observedAllocation.allocationId}`)
      }
      if (observedAllocation.state === 'released' && allocation.scope === 'work' && allocation.state !== 'released') {
        fail('CONFLICT', `work allocation ${observedAllocation.allocationId} requires confirmWorkDestroyed before release`)
      }
      if (observedAllocation.state === 'released' && allocation.scope === 'request') {
        const request = findRequest(ledger, allocation.workId, allocation.requestId as string)
        const requestObservation = observationByRequest.get(requestKey(allocation.workId, allocation.requestId as string))
        const observedTerminal = requestObservation?.requestState === 'succeeded' || requestObservation?.requestState === 'failed' || requestObservation?.requestState === 'cancelled'
          || (requestObservation?.completion !== undefined && ['succeeded', 'failed', 'cancelled'].includes(requestObservation.completion.outcome))
        if (!observedTerminal && !['succeeded', 'failed', 'cancelled'].includes(request.state)) {
          fail('CONFLICT', `request allocation ${observedAllocation.allocationId} lacks terminal request evidence`)
        }
      }
      observationByAllocation.set(observedAllocation.allocationId, observedAllocation.state)
    }
  }
  for (const { workId, requestId, completion } of completionByRequest.values()) {
    if (!['succeeded', 'failed', 'cancelled'].includes(completion.outcome)) continue
    const request = findRequest(ledger, workId, requestId)
    for (const allocationId of request.allocationIds) {
      const allocation = ledger.snapshot.allocations.find(candidate => candidate.allocationId === allocationId)
      if (allocation?.scope === 'request' && observationByAllocation.get(allocationId) !== undefined && observationByAllocation.get(allocationId) !== 'released') {
        fail('CONFLICT', `terminal recovery cannot retain request allocation ${allocationId}`)
      }
    }
  }
  const activeWorkIds = new Set(ledger.snapshot.requests.filter(request => request.state === 'running' || request.state === 'cancel_requested').map(request => request.control.workId))
  let changed = false
  const requests = ledger.snapshot.requests.map(request => {
    if (request.state !== 'running' && request.state !== 'cancel_requested' && request.state !== 'unknown') return request
    const observation = observationByRequest.get(requestKey(request.control.workId, request.control.requestId))
    const completion = completionByRequest.get(requestKey(request.control.workId, request.control.requestId))?.completion
    const observedState = observation?.requestState ?? (completion === undefined ? undefined : completionState(completion.outcome))
    if (completion !== undefined) {
      const nextState = completionState(completion.outcome)
      const error = completionError(completion)
      if (request.state === nextState && stableJson(request.response) === stableJson(completion.payload) && stableJson(request.error) === stableJson(error)) return request
      const updated: StoredWorkRequest = {
        ...request,
        state: nextState,
        ...(completion.payload === undefined ? { response: undefined } : { response: completion.payload }),
        ...(error === undefined ? { error: undefined } : { error }),
      }
      changed = true
      return updated
    }
    if (observedState !== undefined) {
      if (observedState === request.state) return request
      const updated: StoredWorkRequest = {
        ...request,
        state: observedState,
        ...(observedState === 'unknown' ? { error: { code: 'RESULT_UNKNOWN' as const, message: 'recovery could not confirm request completion' } } : {}),
      }
      changed = true
      return updated
    }
    if (request.state === 'unknown') return request
    changed = true
    return { ...request, state: 'unknown' as const, error: { code: 'RESULT_UNKNOWN' as const, message: 'request was active during daemon restart' } }
  })
  const allocations = ledger.snapshot.allocations.map(allocation => {
    const observedState = observationByAllocation.get(allocation.allocationId)
    if (observedState !== undefined && observedState !== allocation.state) {
      changed = true
      return { ...allocation, state: observedState }
    }
    if (allocation.scope === 'request' && allocation.requestId !== undefined) {
      const completion = completionByRequest.get(requestKey(allocation.workId, allocation.requestId))?.completion
      if (completion !== undefined && ['succeeded', 'failed', 'cancelled'].includes(completion.outcome) && allocation.state !== 'released') {
        changed = true
        return { ...allocation, state: 'released' as const }
      }
    }
    if (observedState === undefined && activeWorkIds.has(allocation.workId) && allocation.state !== 'released' && allocation.state !== 'unknown') {
      changed = true
      return { ...allocation, state: 'unknown' as const }
    }
    return allocation
  })
  if (changed) commit(ledger, nextSnapshot(ledger, { requests, allocations }))
  return ledger
}
