import { isAbsolute, join } from 'node:path'
import type { JsonValue } from '../packages/shared/src/agent-services.ts'
import type { AcpFrame } from '../packages/shared/src/acp.ts'
import { AcpError } from '../packages/shared/src/acp.ts'
import type {
  EngineAdapter,
  EngineHandle,
  EngineLaunchInput,
  EngineLaunchSpec,
} from '../packages/shared/src/engine.ts'
import type { AcpPolicyIntent } from '../config/acp-policy.ts'
import type { AgentModelBinding, ModelRef } from '../config/runtime-config.ts'
import { compileDshNativeConfig } from './native-config.ts'

/**
 * DSH engine adapter.
 *
 * Owner: dsh-adapter. It compiles the real `EngineLaunchSpec` for the installed
 * DSH ACP server (`dsh --profile acp`) and maps DSH-specific features onto the
 * frozen ACP/engine ports. It declares no second Session path, no second stdio
 * transport and no engine registry: the D01 runtime owns the child, the single
 * stdio `AcpDuplex` and the Session/execution-policy boundary.
 *
 * Boundaries owned here:
 * - the derived DSH profile patch (provider routes + selected model),
 * - the engine environment (`DSH_HOME` isolation, permission mode, telemetry),
 * - the static policy check that must happen before any engine side effect,
 * - the effectiveness proof read from the real `initialize`/`session/new`
 *   results the runtime captured.
 *
 * Anything the installed DSH ACP surface does not carry is refused explicitly
 * with a typed fault. Nothing here falls back to a DSH shipped default route,
 * and no success is claimed without a real engine readback.
 */

/** Name of the derived patch file inside the daemon-owned directory. */
export const DSH_PATCH_FILE_NAME = 'teams-dsh-acp.patch.json'

/** `agentInfo.name` the real DSH ACP server reports; the engine's own identity. */
export const DSH_AGENT_INFO_NAME = 'deepseek-harness-acp'

/**
 * The engine's permission mode for a Teams-owned daemon. DSH derives its
 * sandbox mode and its approval policy from this variable, so pinning it makes
 * the permission behaviour deterministic instead of inheriting whatever the
 * launching shell happened to export. `workspace-write` keeps approval `ask`,
 * which is what routes real `session/request_permission` callbacks to the
 * controller. This is the DSH shipped CLI default, not a Teams-specified value.
 */
export const DSH_PERMISSION_MODE = 'workspace-write'

/** DSH's documented telemetry opt-out; any non-empty value disables export. */
export const DSH_TELEMETRY_DISABLED = '1'

/** ACP methods the DSH adapter itself carries beyond the engine declaration. */
export const DSH_EXTENSION_METHODS = ['session/set_config_option'] as const

/**
 * Engine-to-client callbacks the DSH ACP server raises to its controller.
 *
 * The real DSH engine asks for approval with a standard
 * `session/request_permission` callback; it uses no client filesystem or
 * terminal operation. The ACP initialize result cannot advertise client
 * methods, so this is the adapter's own declaration. Without it the frozen
 * policy vocabulary has no `callback:` key and the host refuses the engine's
 * approval request before any controller can see it.
 */
export const DSH_ENGINE_CALLBACKS = ['session/request_permission'] as const

/** Session-management methods the real DSH initialize result declares. */
export const DSH_ENGINE_SESSION_METHODS = ['session/list', 'session/resume', 'session/close'] as const

/**
 * Policy key classes the D01 agent-host enforces before any engine write:
 * the base capability gate, method admission, engine capability admission,
 * client capability admission and engine callback admission. `internal-tool:*`
 * keys are deliberately absent: DSH ACP exposes no native tool-level policy, so
 * such a key has no enforcement owner here and must fail configuration.
 */
const ENFORCED_POLICY_CLASSES = ['acp', 'method:', 'capability:', 'client-capability:', 'callback:'] as const

export function dshHasPolicyEnforcementOwner(key: string): boolean {
  return ENFORCED_POLICY_CLASSES.some(prefix => (prefix === 'acp' ? key === 'acp' : key.startsWith(prefix)))
}

export interface DshCapability {
  /** A policy-vocabulary key, or a `feature:` label that is never a policy key. */
  readonly key: string
  /**
   * `adapter` — carried by this adapter and declared to the host;
   * `engine` — declared by the real DSH initialize result at runtime;
   * `unsupported` — outside the DSH ACP surface and refused explicitly.
   */
  readonly support: 'adapter' | 'engine' | 'unsupported'
  readonly owner: 'dsh-adapter' | 'dsh-acp' | 'acp-host'
  readonly reason: string
}

/**
 * The refused surface. Every entry is a contract-level limitation of the DSH
 * ACP server, not a build flag, so the adapter may reject it before spawning.
 */
export const DSH_UNSUPPORTED_FEATURES: readonly DshCapability[] = [
  {
    key: 'method:session/load',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP omits session/load; a persisted session is reattached with session/resume and its log is restored without replaying old updates.',
  },
  {
    key: 'method:session/delete',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP omits session deletion; a persisted session stays resumable.',
  },
  {
    key: 'method:session/fork',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP omits session forks.',
  },
  {
    key: 'capability:/mcpCapabilities/sse',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP admits stdio and Streamable HTTP MCP only; an SSE MCP transport is rejected.',
  },
  {
    key: 'capability:/mcpCapabilities/acp',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP admits stdio and Streamable HTTP MCP only; an ACP-transport MCP server is rejected.',
  },
  {
    key: 'client-capability:/fs/readTextFile',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP does not use client filesystem operations; the engine reads files through its own sandboxed tools.',
  },
  {
    key: 'client-capability:/fs/writeTextFile',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP does not use client filesystem operations; the engine writes files through its own sandboxed tools.',
  },
  {
    key: 'client-capability:/terminal',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP omits ACP terminals; the engine runs commands through its own tool set.',
  },
  {
    key: 'capability:/elicitation',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP omits elicitation; the automation surface carries no interactive question channel.',
  },
  {
    key: 'feature:additionalDirectories',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'One primary workspace: additional directories remain unsupported, so session/new must name exactly one absolute cwd.',
  },
  {
    key: 'feature:modes',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP omits session modes.',
  },
  {
    key: 'feature:commands',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP omits available commands.',
  },
  {
    key: 'feature:plans',
    support: 'unsupported',
    owner: 'dsh-acp',
    reason: 'DSH ACP omits plan presentation.',
  },
]

/** Capabilities whose support is declared by the real engine at initialize. */
export const DSH_ENGINE_DECLARED_CAPABILITIES: readonly DshCapability[] = [
  ...DSH_ENGINE_SESSION_METHODS.map(method => ({
    key: `method:${method}`,
    support: 'engine' as const,
    owner: 'dsh-acp' as const,
    reason: 'Declared by the real initialize result under agentCapabilities.sessionCapabilities.',
  })),
  {
    key: 'capability:/mcpCapabilities/http',
    support: 'engine',
    owner: 'dsh-acp',
    reason: 'Declared by the real initialize result when Streamable HTTP MCP is mounted.',
  },
  {
    key: 'capability:/promptCapabilities/image',
    support: 'engine',
    owner: 'dsh-acp',
    reason: 'Conditional: the engine advertises it only when the durable attachment store and the exact selected route support images.',
  },
  {
    key: 'capability:/promptCapabilities/audio',
    support: 'engine',
    owner: 'dsh-acp',
    reason: 'Declared by the real initialize result; false in the observed installed build.',
  },
  {
    key: 'capability:/promptCapabilities/embeddedContext',
    support: 'engine',
    owner: 'dsh-acp',
    reason: 'Declared by the real initialize result; false in the observed installed build.',
  },
]

/** Capabilities the adapter carries itself and must declare to the host. */
export const DSH_ADAPTER_CAPABILITIES: readonly DshCapability[] = [
  {
    key: `method:${DSH_EXTENSION_METHODS[0]}`,
    support: 'adapter',
    owner: 'dsh-adapter',
    reason: 'The adapter carries the standard ACP config-option mutation used to read back and change the derived model selection.',
  },
  ...DSH_ENGINE_CALLBACKS.map(callback => ({
    key: `callback:${callback}`,
    support: 'adapter' as const,
    owner: 'dsh-adapter' as const,
    reason: 'The adapter declares the engine-to-client approval callback the DSH ACP server raises; the ACP initialize result cannot advertise client methods.',
  })),
]

/**
 * The exact adapter-declared policy keys, in the vocabulary the frozen policy
 * owner accepts: bare extension method names and prefixed callback keys. This
 * is what the runtime must pass as `adapterMethods`.
 */
export function dshDeclaredPolicyKeys(): string[] {
  return [
    ...DSH_EXTENSION_METHODS.map(method => `method:${method}`),
    ...DSH_ENGINE_CALLBACKS.map(callback => `callback:${callback}`),
  ]
}

/**
 * The exact adapter-declared enforceable policy keys. This is what the runtime
 * must pass as `enforceablePolicies`.
 *
 * The set is derived from the one enforcement-owner rule, applied to the whole
 * declared DSH ACP surface, so the adapter's pre-launch blacklist assertion and
 * the runtime's enforceable set can never drift. The D01 host enforces the base
 * capability, method, engine-capability, client-capability and engine-callback
 * classes before any engine write; a declared `feature:` label is not a policy
 * key and a key outside those classes has no enforcement owner here, so neither
 * becomes enforceable.
 */
export function dshEnforceablePolicyKeys(): string[] {
  const declared = [...DSH_ADAPTER_CAPABILITIES, ...DSH_ENGINE_DECLARED_CAPABILITIES, ...DSH_UNSUPPORTED_FEATURES]
  return [...new Set(declared.map(entry => entry.key).filter(dshHasPolicyEnforcementOwner))]
}

export interface DshEffectivenessProof {
  readonly effectiveRevision: number
  readonly modelTarget: ModelRef | null
  readonly evidence: JsonValue
}

export interface DshEngineAdapter extends EngineAdapter {
  readonly kind: 'dsh'
  /**
   * Adapter-declared policy keys for the frozen `adapterMethods` input: the
   * extension methods this adapter carries plus the engine callbacks it
   * declares. Bare method names and prefixed `callback:` keys are both part of
   * the frozen policy vocabulary.
   */
  readonly declaredMethods: readonly string[]
  /**
   * Adapter-declared policy keys for the frozen `enforceablePolicies` input: the
   * declared DSH ACP surface restricted to the classes
   * `dshHasPolicyEnforcementOwner` accepts. The adapter owns this answer; the
   * runtime must not substitute `declaredMethods` or any other set.
   */
  readonly enforceablePolicies: readonly string[]
  /** The typed support/refusal list for the DSH ACP surface. */
  readonly capabilities: readonly DshCapability[]
  compileLaunch(input: EngineLaunchInput): Promise<EngineLaunchSpec>
  verifyEffective(input: {
    readonly handle: EngineHandle
    readonly launch: EngineLaunchInput
    readonly initializeResult: AcpFrame
    readonly sessionConfigResult?: AcpFrame
  }): Promise<DshEffectivenessProof>
}

function fail(code: 'UNSUPPORTED_CONFIGURATION' | 'UNSUPPORTED_POLICY' | 'UNSUPPORTED_CAPABILITY', message: string): never {
  throw new AcpError(code, message)
}

function assertAbsolutePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || !isAbsolute(value)) {
    fail('UNSUPPORTED_CONFIGURATION', `DSH engine launch ${label} must be an absolute path`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The complete child environment. The engine is a separate process tree with
 * its own DSH home; inheriting the launching harness's `DSH_*` state would let
 * an ambient profile or session leak into the engine, so those variables are
 * dropped and the adapter-owned ones are set explicitly.
 */
function engineEnvironment(ownedDirectory: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('DSH_')) continue
    env[key] = value
  }
  env.DSH_HOME = ownedDirectory
  env.DSH_PERMISSION_MODE = DSH_PERMISSION_MODE
  env.DSH_TELEMETRY_DISABLED = DSH_TELEMETRY_DISABLED
  return env
}

/**
 * Refuse, before any engine side effect, every policy the DSH adapter cannot
 * carry. A blacklist key needs an enforcement owner; a required key that the
 * DSH ACP contract permanently lacks can never be satisfied.
 */
function assertLaunchPolicy(policy: AcpPolicyIntent): void {
  if (!isRecord(policy)) fail('UNSUPPORTED_CONFIGURATION', 'DSH engine launch requires an ACP policy intent')
  if (policy.enabled !== true) {
    fail('UNSUPPORTED_CONFIGURATION', 'DSH engine launch requires an enabled ACP policy')
  }
  if (policy.callbackExecutor !== 'controller') {
    fail('UNSUPPORTED_CONFIGURATION', 'DSH engine launch requires the controller callback executor')
  }
  for (const key of policy.blacklist) {
    if (!dshHasPolicyEnforcementOwner(key)) {
      fail(
        'UNSUPPORTED_POLICY',
        `DSH ACP has no enforcement owner for blacklist key ${key}; the engine exposes no native tool-level policy`,
      )
    }
  }
  const permanentlyUnsupported = new Set(DSH_UNSUPPORTED_FEATURES.map(entry => entry.key))
  for (const key of policy.required) {
    if (permanentlyUnsupported.has(key)) {
      fail('UNSUPPORTED_CAPABILITY', `DSH ACP does not support the required capability ${key}`)
    }
  }
}

function modelBindingOf(input: EngineLaunchInput): AgentModelBinding {
  const accepted = input.accepted
  if (!isRecord(accepted) || !isRecord(accepted.agents)) {
    fail('UNSUPPORTED_CONFIGURATION', 'DSH engine launch requires the accepted runtime config')
  }
  const agentId = isRecord(input.target) && typeof input.target.agentId === 'string' ? input.target.agentId : ''
  const binding = (accepted.agents as Record<string, AgentModelBinding | undefined>)[agentId]
  if (binding === undefined) {
    fail(
      'UNSUPPORTED_CONFIGURATION',
      `DSH engine launch requires a configured model binding for daemon agent ${agentId}; the engine's shipped default route is not a Teams-specified binding`,
    )
  }
  return binding
}

/** Static policy keys the adapter carries; the rest come from the real engine. */
function declaredPolicies(): string[] {
  return ['acp', ...dshDeclaredPolicyKeys()]
}

function engineIdentity(initializeResult: AcpFrame): { readonly name: string; readonly version: string } {
  const result = initializeResult.result
  if (!isRecord(result)) fail('UNSUPPORTED_CONFIGURATION', 'DSH effectiveness is unproven: initialize returned no result object')
  const agentInfo = result.agentInfo
  if (!isRecord(agentInfo) || typeof agentInfo.name !== 'string') {
    fail('UNSUPPORTED_CONFIGURATION', 'DSH effectiveness is unproven: initialize returned no agent identity')
  }
  if (agentInfo.name !== DSH_AGENT_INFO_NAME) {
    fail(
      'UNSUPPORTED_CONFIGURATION',
      `the launched engine reports agentInfo.name ${agentInfo.name}, not the DSH ACP server ${DSH_AGENT_INFO_NAME}`,
    )
  }
  return { name: agentInfo.name, version: typeof agentInfo.version === 'string' ? agentInfo.version : 'unknown' }
}

function sessionCapabilities(initializeResult: AcpFrame): readonly string[] {
  const result = initializeResult.result
  const agentCapabilities = isRecord(result) ? result.agentCapabilities : undefined
  const declared = isRecord(agentCapabilities) ? agentCapabilities.sessionCapabilities : undefined
  if (!isRecord(declared)) {
    fail('UNSUPPORTED_CAPABILITY', 'the DSH engine declared no session capabilities in its initialize result')
  }
  const present = DSH_ENGINE_SESSION_METHODS.filter(method => {
    // The engine declares session capabilities under their bare names; the ACP
    // method name carries the `session/` prefix (see extractAcpCapabilities).
    const marker = declared[method.slice('session/'.length)]
    return marker === true || isRecord(marker)
  })
  const missing = DSH_ENGINE_SESSION_METHODS.filter(method => !present.includes(method))
  if (missing.length > 0) {
    fail(
      'UNSUPPORTED_CAPABILITY',
      `the DSH engine does not declare session capabilit${missing.length === 1 ? 'y' : 'ies'} ${missing.join(', ')}`,
    )
  }
  return present
}

function configOptionsOf(sessionConfigResult: AcpFrame): readonly Record<string, unknown>[] {
  const result = sessionConfigResult.result
  const configOptions = isRecord(result) ? result.configOptions : undefined
  if (!Array.isArray(configOptions)) {
    fail('UNSUPPORTED_CONFIGURATION', 'DSH effectiveness is unproven: session/new returned no configuration-option state')
  }
  return configOptions.filter(isRecord)
}

/**
 * Compile the real launch for the installed DSH ACP server. Every rejection is
 * explicit and happens before the runtime writes a file or spawns a process.
 */
export function createDshEngineAdapter(): DshEngineAdapter {
  return {
    kind: 'dsh',
    declaredMethods: dshDeclaredPolicyKeys(),
    enforceablePolicies: dshEnforceablePolicyKeys(),
    capabilities: [...DSH_ADAPTER_CAPABILITIES, ...DSH_ENGINE_DECLARED_CAPABILITIES, ...DSH_UNSUPPORTED_FEATURES],

    async compileLaunch(input: EngineLaunchInput): Promise<EngineLaunchSpec> {
      if (!isRecord(input)) fail('UNSUPPORTED_CONFIGURATION', 'DSH engine launch input is required')
      if (input.kind !== 'dsh') {
        fail('UNSUPPORTED_CONFIGURATION', `the DSH adapter cannot launch engine kind ${String(input.kind)}`)
      }
      assertAbsolutePath(input.executable, 'executable')
      assertAbsolutePath(input.workspace, 'workspace')
      assertAbsolutePath(input.ownedDirectory, 'ownedDirectory')
      assertLaunchPolicy(input.policy)

      const binding = modelBindingOf(input)
      const native = compileDshNativeConfig({ accepted: input.accepted, binding })
      const patchPath = join(input.ownedDirectory, DSH_PATCH_FILE_NAME)

      return {
        executable: input.executable,
        args: ['--profile', 'acp', '--patch', patchPath],
        cwd: input.workspace,
        env: engineEnvironment(input.ownedDirectory),
        credentialEnvRefs: native.credentialEnvRefs,
        files: [{ path: patchPath, content: native.patchContent, mode: 0o600 }],
        supportedPolicies: declaredPolicies(),
      }
    },

    async verifyEffective(input): Promise<DshEffectivenessProof> {
      if (!isRecord(input)) fail('UNSUPPORTED_CONFIGURATION', 'DSH effectiveness input is required')
      const binding = modelBindingOf(input.launch)
      const native = compileDshNativeConfig({ accepted: input.launch.accepted, binding })

      const identity = engineIdentity(input.initializeResult)
      const declared = sessionCapabilities(input.initializeResult)

      if (input.sessionConfigResult === undefined) {
        fail(
          'UNSUPPORTED_CONFIGURATION',
          `DSH effectiveness is unproven: no real session/new result was captured for the configured binding ${native.providerRoute}/${native.modelId}`,
        )
      }
      const options = configOptionsOf(input.sessionConfigResult)
      const modelOption = options.find(option => option.id === 'model')
      const expected = JSON.stringify([native.providerRoute, native.modelId])
      const actual = typeof modelOption?.currentValue === 'string' ? modelOption.currentValue : undefined
      if (actual !== expected) {
        fail(
          'UNSUPPORTED_CONFIGURATION',
          `DSH selected ${actual === undefined ? 'no model option' : actual} instead of the configured ${expected}`,
        )
      }

      return {
        effectiveRevision: input.launch.accepted.acceptedRevision,
        modelTarget: binding.primary,
        evidence: {
          engine: 'dsh',
          engineIdentity: identity.name,
          engineVersion: identity.version,
          engineRoute: native.providerRoute,
          modelOptionId: 'model',
          modelOptionValue: actual,
          // Same readiness vocabulary as the OpenCode adapter: the model is
          // proven from the engine's own session/new configuration options.
          modelVerification: 'session/new configOptions',
          configOptionIds: options.map(option => (typeof option.id === 'string' ? option.id : 'unknown')),
          sessionCapabilities: [...declared],
          profilePatchFile: DSH_PATCH_FILE_NAME,
          source: 'real initialize result plus real session/new configuration-option readback',
        },
      }
    },
  }
}
