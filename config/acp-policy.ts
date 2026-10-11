import { createHash } from 'node:crypto'
import type { JsonValue } from '../control-protocol/agent-services.ts'
import type { AcpFaultCode, AcpFrame } from '../control-protocol/acp.ts'
import { AcpError } from '../control-protocol/acp.ts'

export interface AcpPolicyIntent {
  readonly enabled: boolean
  readonly required: readonly string[]
  readonly blacklist: readonly string[]
  readonly clientCapabilities: readonly string[]
  readonly callbackExecutor: 'controller'
}

export interface AcpPolicySnapshot {
  readonly revision: string
  readonly engineInstanceId: string
  readonly supported: readonly string[]
  readonly effective: readonly string[]
  readonly denied: readonly string[]
}

export class AcpPolicyError extends Error {
  readonly code: AcpFaultCode

  constructor(code: AcpFaultCode, message: string) {
    super(message)
    this.name = 'AcpPolicyError'
    this.code = code
  }
}

const BASE_CAPABILITY = 'acp'
const REQUIRED_METHODS = [
  'initialize',
  'session/new',
  'session/prompt',
  'session/cancel',
  'session/update',
] as const
const REQUIRED_METHOD_KEYS = REQUIRED_METHODS.map(method => `method:${method}`)
const KNOWN_PREFIXES = ['capability:', 'client-capability:', 'method:', 'callback:', 'internal-tool:'] as const

function fail(code: AcpFaultCode, message: string): never {
  throw new AcpPolicyError(code, message)
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertStringArray(value: unknown, path: string): asserts value is readonly string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    fail('UNSUPPORTED_CONFIGURATION', `${path} must be an array of non-empty strings`)
  }
}

function isJsonPointer(value: string): boolean {
  if (!value.startsWith('/')) return false
  return value.slice(1).split('/').every(segment => !/~(?:[^01]|$)/.test(segment))
}

function classifyPolicyKey(key: string): 'capability' | 'client-capability' | 'method' | 'callback' | 'internal-tool' | 'base' {
  if (key === BASE_CAPABILITY) return 'base'
  if (key.startsWith('capability:')) {
    if (!isJsonPointer(key.slice('capability:'.length))) fail('UNSUPPORTED_POLICY', `invalid ACP capability key ${key}`)
    return 'capability'
  }
  if (key.startsWith('client-capability:')) {
    if (!isJsonPointer(key.slice('client-capability:'.length))) {
      fail('UNSUPPORTED_POLICY', `invalid ACP client capability key ${key}`)
    }
    return 'client-capability'
  }
  if (key.startsWith('method:')) {
    if (key.length === 'method:'.length) fail('UNSUPPORTED_POLICY', `invalid ACP method key ${key}`)
    return 'method'
  }
  if (key.startsWith('callback:')) {
    if (key.length === 'callback:'.length) fail('UNSUPPORTED_POLICY', `invalid ACP callback key ${key}`)
    return 'callback'
  }
  if (key.startsWith('internal-tool:')) {
    const parts = key.split(':')
    if (parts.length !== 3 || parts[1].length === 0 || parts[2].length === 0) {
      fail('UNSUPPORTED_POLICY', `invalid ACP internal tool key ${key}`)
    }
    return 'internal-tool'
  }
  if (KNOWN_PREFIXES.some(prefix => key.startsWith(prefix))) {
    fail('UNSUPPORTED_POLICY', `invalid ACP policy key ${key}`)
  }
  fail('UNSUPPORTED_POLICY', `unknown ACP policy key ${key}`)
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

function revisionOf(input: {
  readonly engineInstanceId: string
  readonly supported: readonly string[]
  readonly effective: readonly string[]
  readonly denied: readonly string[]
}): string {
  return createHash('sha256').update(JSON.stringify({
    engineInstanceId: input.engineInstanceId,
    supported: sorted(input.supported),
    effective: sorted(input.effective),
    denied: sorted(input.denied),
  })).digest('hex')
}

function addCapabilityPointers(
  value: JsonValue,
  pointer: string,
  depth: number,
  output: Set<string>,
): void {
  if (value === true) {
    output.add(`capability:${pointer}`)
    addSessionMethodForMarker(pointer, output)
    return
  }
  if (value === false || value === null) return
  if (!isRecord(value)) return
  const entries = Object.entries(value)
  if (entries.length === 0) {
    // A genuine empty-object marker (e.g. sessionCapabilities.resume = {}) is a
    // supported exact key, but only below a capability group. An empty object at
    // the agentCapabilities level or a group level is a container, not a capability.
    if (depth >= 2) {
      output.add(`capability:${pointer}`)
      addSessionMethodForMarker(pointer, output)
    }
    return
  }
  for (const [key, child] of entries) {
    const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1')
    addCapabilityPointers(child, `${pointer}/${escaped}`, depth + 1, output)
  }
}

/** A session capability marker maps to its corresponding optional session method. */
function addSessionMethodForMarker(pointer: string, output: Set<string>): void {
  const prefix = '/sessionCapabilities/'
  if (!pointer.startsWith(prefix)) return
  const name = pointer.slice(prefix.length)
  if (name.length === 0 || name.includes('/')) return
  const decoded = name.replaceAll('~1', '/').replaceAll('~0', '~')
  output.add(`method:session/${decoded}`)
}

function normalizeAdapterDeclaration(declared: string): string {
  if (declared === BASE_CAPABILITY || KNOWN_PREFIXES.some(prefix => declared.startsWith(prefix))) {
    return declared
  }
  // Bare adapter method names are normalized before classification.
  return `method:${declared}`
}

/**
 * Convert a real ACP initialize result plus adapter-verified extension keys
 * into the policy vocabulary. False capability booleans never become supported.
 */
export function extractAcpCapabilities(
  initializeResult: AcpFrame,
  adapterMethods: readonly string[] = [],
): readonly string[] {
  const result = initializeResult.result
  if (!isRecord(result)) fail('INVALID_ACP_FRAME', 'ACP initialize result must contain an object result')

  const capabilities = new Set<string>([BASE_CAPABILITY, ...REQUIRED_METHOD_KEYS])
  const agentCapabilities = result.agentCapabilities
  if (isRecord(agentCapabilities)) addCapabilityPointers(agentCapabilities, '', 0, capabilities)
  else if (agentCapabilities !== undefined) fail('INVALID_ACP_FRAME', 'ACP agentCapabilities must be an object')

  for (const declared of adapterMethods) {
    const key = normalizeAdapterDeclaration(declared)
    classifyPolicyKey(key)
    capabilities.add(key)
  }
  return [...capabilities]
}

export function resolveAcpPolicy(input: {
  readonly intent: AcpPolicyIntent
  readonly engineInstanceId: string
  readonly supported: readonly string[]
  readonly enforceablePolicies: readonly string[]
}): AcpPolicySnapshot {
  if (typeof input.intent?.enabled !== 'boolean') {
    fail('UNSUPPORTED_CONFIGURATION', 'ACP policy enabled must be a boolean')
  }
  if (input.intent.callbackExecutor !== 'controller') {
    fail('UNSUPPORTED_CONFIGURATION', 'ACP callbackExecutor must be controller')
  }
  if (typeof input.engineInstanceId !== 'string' || input.engineInstanceId.length === 0) {
    fail('UNSUPPORTED_CONFIGURATION', 'ACP engineInstanceId is required')
  }
  assertStringArray(input.intent.required, 'ACP required')
  assertStringArray(input.intent.blacklist, 'ACP blacklist')
  assertStringArray(input.intent.clientCapabilities, 'ACP clientCapabilities')
  assertStringArray(input.supported, 'ACP supported')
  assertStringArray(input.enforceablePolicies, 'ACP enforceablePolicies')

  const supported = unique(input.supported)
  const enforceable = new Set(unique(input.enforceablePolicies))
  const required = new Set(input.intent.required)
  const blacklist = unique(input.intent.blacklist)

  for (const key of supported) classifyPolicyKey(key)
  for (const key of enforceable) classifyPolicyKey(key)
  for (const key of required) classifyPolicyKey(key)
  for (const key of blacklist) classifyPolicyKey(key)

  if (!input.intent.enabled) {
    if (required.size > 0) fail('UNSUPPORTED_CONFIGURATION', 'disabled ACP policy cannot require capabilities')
    const effective: readonly string[] = []
    const denied: readonly string[] = []
    return {
      revision: revisionOf({ engineInstanceId: input.engineInstanceId, supported, effective, denied }),
      engineInstanceId: input.engineInstanceId,
      supported,
      effective,
      denied,
    }
  }

  if (!supported.includes(BASE_CAPABILITY)) {
    fail('UNSUPPORTED_CAPABILITY', 'enabled ACP policy requires the acp capability')
  }
  for (const key of REQUIRED_METHOD_KEYS) {
    if (!supported.includes(key)) fail('UNSUPPORTED_CAPABILITY', `enabled ACP policy requires ${key}`)
  }
  for (const key of required) {
    if (!supported.includes(key)) fail('UNSUPPORTED_CAPABILITY', `required ACP capability is unsupported: ${key}`)
  }
  for (const key of blacklist) {
    if (!enforceable.has(key)) fail('UNSUPPORTED_POLICY', `ACP blacklist key has no enforcement owner: ${key}`)
    if (key === BASE_CAPABILITY || REQUIRED_METHOD_KEYS.includes(key)) {
      fail('UNSUPPORTED_POLICY', `required ACP path cannot be blacklisted: ${key}`)
    }
    if (required.has(key)) fail('UNSUPPORTED_POLICY', `ACP capability cannot be both required and blacklisted: ${key}`)
  }

  const blacklistSet = new Set(blacklist)
  const effective = supported.filter(key => !blacklistSet.has(key))
  const denied = blacklist.filter(key => supported.includes(key))
  return {
    revision: revisionOf({ engineInstanceId: input.engineInstanceId, supported, effective, denied }),
    engineInstanceId: input.engineInstanceId,
    supported,
    effective,
    denied,
  }
}

function assertAllowedKey(policy: AcpPolicySnapshot, key: string, unsupportedCode: AcpFaultCode): void {
  if (!policy.supported.includes(key)) fail(unsupportedCode, `ACP method or capability is unsupported: ${key}`)
  if (!policy.effective.includes(key)) fail('CAPABILITY_DENIED', `ACP method or capability is denied: ${key}`)
}

function paramsOf(frame: AcpFrame): Record<string, JsonValue> | null {
  const params = frame.params
  return isRecord(params) ? params : null
}

function requiredCapability(
  policy: AcpPolicySnapshot,
  key: string,
): void {
  if (!policy.supported.includes(key)) fail('UNSUPPORTED_CAPABILITY', `ACP capability is unsupported: ${key}`)
  if (!policy.effective.includes(key)) fail('CAPABILITY_DENIED', `ACP capability is denied: ${key}`)
}

function assertClientCapabilities(policy: AcpPolicySnapshot, params: Record<string, JsonValue> | null): void {
  const requested = params?.clientCapabilities
  if (requested === undefined) return
  if (!isRecord(requested)) fail('INVALID_ACP_FRAME', 'ACP initialize clientCapabilities must be an object')
  const keys = new Set<string>()
  addClientCapabilityKeys(requested, '', keys)
  for (const key of keys) {
    requiredCapability(policy, `client-capability:${key}`)
  }
}

function addClientCapabilityKeys(value: JsonValue, pointer: string, output: Set<string>): void {
  if (value === true) {
    output.add(pointer)
    return
  }
  if (value === false || value === null || !isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1')
    addClientCapabilityKeys(child, `${pointer}/${escaped}`, output)
  }
}

function assertPromptModalities(policy: AcpPolicySnapshot, params: Record<string, JsonValue> | null): void {
  const prompt = params?.prompt
  if (prompt === undefined) return
  if (!Array.isArray(prompt)) fail('INVALID_ACP_FRAME', 'ACP session/prompt prompt must be an array')
  for (const item of prompt) {
    if (!isRecord(item)) fail('INVALID_ACP_FRAME', 'ACP prompt content must be an object')
    const type = item.type
    if (type === 'text') continue
    if (type === 'image') requiredCapability(policy, 'capability:/promptCapabilities/image')
    else if (type === 'audio') requiredCapability(policy, 'capability:/promptCapabilities/audio')
    else if (type === 'resource' || type === 'resource_link') {
      requiredCapability(policy, 'capability:/promptCapabilities/embeddedContext')
    } else {
      fail('UNSUPPORTED_CAPABILITY', `unsupported ACP prompt modality: ${String(type)}`)
    }
  }
}

function assertMcpTransports(policy: AcpPolicySnapshot, params: Record<string, JsonValue> | null): void {
  const servers = params?.mcpServers
  if (servers === undefined) return
  if (!Array.isArray(servers)) fail('INVALID_ACP_FRAME', 'ACP mcpServers must be an array')
  for (const server of servers) {
    if (!isRecord(server) || typeof server.type !== 'string' || server.type.length === 0) {
      fail('INVALID_ACP_FRAME', 'ACP MCP server must declare a type')
    }
    requiredCapability(policy, `capability:/mcpCapabilities/${server.type}`)
  }
}

/**
 * Validate an ACP frame against the effective policy before dispatch.
 * The method/parameter checks happen before any child write or executor call.
 */
export function assertAcpAllowed(input: {
  readonly policy: AcpPolicySnapshot
  readonly direction: 'to-engine' | 'from-engine'
  readonly frame: AcpFrame
}): void {
  if (input.direction !== 'to-engine' && input.direction !== 'from-engine') {
    fail('UNSUPPORTED_CONFIGURATION', `invalid ACP direction ${String(input.direction)}`)
  }
  const frame = input.frame
  try {
    // Keep policy enforcement strict even when the caller used a typed frame.
    if (frame.jsonrpc !== '2.0') throw new Error('ACP frame.jsonrpc must equal "2.0"')
  } catch (error) {
    fail('INVALID_ACP_FRAME', error instanceof Error ? error.message : 'invalid ACP frame')
  }
  const method = frame.method
  if (typeof method !== 'string' || method.length === 0) return

  const prefix = input.direction === 'to-engine' ? 'method' : 'callback'
  assertAllowedKey(input.policy, `${prefix}:${method}`, 'UNSUPPORTED_METHOD')

  if (input.direction === 'to-engine') {
    const params = paramsOf(frame)
    if (method === 'initialize') assertClientCapabilities(input.policy, params)
    if (method === 'session/new') assertMcpTransports(input.policy, params)
    if (method === 'session/prompt') assertPromptModalities(input.policy, params)
  }
}
