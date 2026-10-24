import { isAbsolute } from 'node:path'
import type { JsonValue } from '../../packages/shared/src/agent-services.ts'
import type { AcpFrame } from '../../packages/shared/src/acp.ts'
import { AcpError } from '../../packages/shared/src/acp.ts'
import type { EngineAdapter, EngineHandle, EngineLaunchInput, EngineLaunchSpec } from '../../packages/shared/src/engine.ts'
import type { AcpPolicyIntent } from '../../config/acp-policy.ts'
import type { ModelRef, VersionedRuntimeConfig } from '../../config/runtime-config.ts'
import { compileOpenCodeConfig, OpenCodeAdapterError } from './index.ts'
import { createOpenCodeLaunchConfig } from './managed-config.ts'

/**
 * OpenCode engine adapter (owner: opencode-adapter).
 *
 * It compiles the accepted Teams config into one `EngineLaunchSpec` for the
 * installed OpenCode ACP server (`opencode acp --pure`) and maps the OpenCode
 * native policy surface onto the frozen `EngineAdapter` port. It declares no
 * second Session path, no second stdio transport, no second config source and
 * no second fault vocabulary: the runtime (`runtime/acp-daemon.ts`) owns the
 * child, the `AcpDuplex` and the `initialize` exchange, and `agent-host` owns
 * Session/RPC/permission semantics.
 *
 * Real behaviour observed on the installed `opencode 1.18.23` (run receipt
 * `/Volumes/Intel/playground/agentteams/.worker-runs/acp-d02-worker-20261010/`):
 * `initialize` declares protocolVersion 1 plus loadSession, mcpCapabilities
 * http/sse, promptCapabilities image/embeddedContext and sessionCapabilities
 * close/fork/list/resume; `session/new` reports the effective model in
 * `result.configOptions` (`id: "model"`, `currentValue: "<provider>/<model>"`);
 * `session/prompt` streams `session/update` frames and terminates with
 * `stopReason`; `session/cancel` is a **notification** (the request form is
 * answered `-32601 Method not found`); a tool that needs approval arrives as
 * the `session/request_permission` callback with `once`/`always`/`reject`
 * options; `permission.<tool> = "deny"` removes the tool from the engine's tool
 * set before any side effect.
 */

/**
 * Native OpenCode tool/permission keys that accept a flat `deny` action. This
 * is the real key set documented by the installed engine (`read, edit, glob,
 * grep, list, bash, task, external_directory, todowrite, question, webfetch,
 * websearch, lsp, doom_loop, skill`). A name outside this set has no OpenCode
 * enforcement owner, so the adapter rejects it instead of claiming a denial.
 */
const OPENCODE_NATIVE_TOOLS = [
  'read',
  'edit',
  'glob',
  'grep',
  'list',
  'bash',
  'task',
  'external_directory',
  'todowrite',
  'question',
  'webfetch',
  'websearch',
  'lsp',
  'doom_loop',
  'skill',
] as const

const NATIVE_TOOL_PREFIX = 'internal-tool:opencode:'

/**
 * Engine callbacks the installed ACP server really sends to its client. The
 * real `initialize` result declares no `sessionCapabilities.requestPermission`
 * marker, so `extractAcpCapabilities` alone would leave
 * `callback:session/request_permission` unsupported and the policy layer would
 * deny every real permission request. This declaration is the adapter's
 * evidence-backed claim that it carries the callback to the controller.
 */
const DECLARED_CALLBACKS = ['callback:session/request_permission'] as const

/** Policy keys this adapter adds to the engine's real capability set. */
const DECLARED_METHODS: readonly string[] = [
  ...OPENCODE_NATIVE_TOOLS.map(name => `${NATIVE_TOOL_PREFIX}${name}`),
  ...DECLARED_CALLBACKS,
]

/**
 * Policy keys this adapter can enforce before a side effect. Every declared
 * native tool maps to `permission.<tool> = "deny"` in the derived engine config;
 * the declared callback is enforced by the host refusing it instead of
 * default-approving it.
 */
const ENFORCEABLE_POLICIES: readonly string[] = [...DECLARED_METHODS]

const OPENCODE_SCHEMA = 'https://opencode.ai/config.json'

function fail(code: 'UNSUPPORTED_POLICY' | 'UNSUPPORTED_CONFIGURATION' | 'STALE_GENERATION', message: string): never {
  throw new AcpError(code, message)
}

function nativeToolOf(key: string): string | undefined {
  if (!key.startsWith(NATIVE_TOOL_PREFIX)) return undefined
  return key.slice(NATIVE_TOOL_PREFIX.length)
}

/**
 * Pre-launch native-policy boundary. It runs before any spawn or file write.
 *
 * - A blacklisted `internal-tool:opencode:<tool>` must map to a real OpenCode
 *   permission key; an unknown tool or another engine's kind is rejected as
 *   `UNSUPPORTED_POLICY` instead of being lowered to a no-op.
 * - A `required` native tool is rejected: this adapter can enforce a native
 *   tool denial, but it cannot prove the engine offers a native tool, and a
 *   `required` key must not pass on an unproven claim.
 *
 * Engine-independent `method:`/`capability:`/`callback:` keys stay owned by
 * `config/acp-policy.ts#resolveAcpPolicy`, which the runtime runs against the
 * real `initialize` declaration before the host serves any channel.
 */
export function assertOpenCodeNativePolicy(intent: AcpPolicyIntent): void {
  for (const key of intent.blacklist) {
    if (!key.startsWith('internal-tool:')) continue
    const tool = nativeToolOf(key)
    if (tool === undefined) {
      fail('UNSUPPORTED_POLICY', `OpenCode adapter cannot enforce a blacklist key for another engine: ${key}`)
    }
    if (!(OPENCODE_NATIVE_TOOLS as readonly string[]).includes(tool)) {
      fail('UNSUPPORTED_POLICY', `OpenCode adapter has no enforcement owner for native tool: ${key}`)
    }
  }
  for (const key of intent.required) {
    if (key.startsWith('internal-tool:')) {
      fail('UNSUPPORTED_POLICY', `OpenCode adapter cannot require a native tool it cannot verify: ${key}`)
    }
  }
}

/** The engine-config `permission` object for the accepted native blacklist. */
function nativeDenials(intent: AcpPolicyIntent): Readonly<Record<string, 'deny'>> | undefined {
  const permission: Record<string, 'deny'> = {}
  for (const key of intent.blacklist) {
    const tool = nativeToolOf(key)
    if (tool !== undefined) permission[tool] = 'deny'
  }
  return Object.keys(permission).length === 0 ? undefined : permission
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertLaunchInput(input: EngineLaunchInput): void {
  if (input === null || typeof input !== 'object') fail('UNSUPPORTED_CONFIGURATION', 'OpenCode launch input is required')
  if (input.kind !== 'opencode') {
    fail('UNSUPPORTED_CONFIGURATION', `OpenCode adapter cannot compile an engine launch for kind ${String(input.kind)}`)
  }
  if (!input.policy.enabled) {
    fail('UNSUPPORTED_CONFIGURATION', 'OpenCode ACP engine launch requires an enabled ACP policy')
  }
  if (typeof input.ownedDirectory !== 'string' || !isAbsolute(input.ownedDirectory)) {
    fail('UNSUPPORTED_CONFIGURATION', 'OpenCode engine ownedDirectory must be an absolute path')
  }
}

function bindingOf(accepted: VersionedRuntimeConfig, agentId: string): { readonly primary: ModelRef; readonly backup?: ModelRef } | undefined {
  return accepted.agents[agentId]
}

/**
 * Derive the engine config with the existing OpenCode compiler, and translate a
 * compile failure into the one fault family of the ACP/engine boundary. The
 * original adapter code and message stay in `detail`, so a missing model,
 * missing provider or conflicting target is reported, never hidden.
 */
function compileDerivedConfig(input: EngineLaunchInput): { config: Record<string, unknown>; credentialReferences: Readonly<Record<string, string>> } {
  try {
    const compiled = compileOpenCodeConfig(input.accepted, input.target.agentId)
    const launch = createOpenCodeLaunchConfig(compiled)
    return {
      config: { $schema: OPENCODE_SCHEMA, ...launch.config },
      credentialReferences: launch.credentialReferences as Readonly<Record<string, string>>,
    }
  } catch (cause) {
    if (cause instanceof AcpError) throw cause
    const adapterCode = cause instanceof OpenCodeAdapterError ? cause.code : 'INVALID_INPUT'
    const code = adapterCode === 'UNAUTHENTICATED' ? 'AUTHENTICATION_REQUIRED' : adapterCode === 'FORBIDDEN' ? 'FORBIDDEN' : 'UNSUPPORTED_CONFIGURATION'
    throw new AcpError(code, cause instanceof Error ? cause.message : 'OpenCode config compile failed', {
      source: 'opencode-adapter',
      code: adapterCode,
    })
  }
}

function modelOptionOf(sessionConfigResult: AcpFrame): { readonly currentValue?: string; readonly optionCount: number } | undefined {
  const result = sessionConfigResult.result
  if (!isRecord(result)) return undefined
  const configOptions = result.configOptions
  if (!Array.isArray(configOptions)) return undefined
  for (const option of configOptions) {
    if (!isRecord(option)) continue
    if (option.id !== 'model' && option.category !== 'model') continue
    const options = Array.isArray(option.options) ? option.options : []
    return {
      ...(typeof option.currentValue === 'string' ? { currentValue: option.currentValue } : {}),
      optionCount: options.length,
    }
  }
  return undefined
}

export interface OpenCodeEngineAdapter extends EngineAdapter {
  readonly kind: 'opencode'
  /** Feed to `StartAcpDaemonInput.policy.adapterMethods`. */
  readonly declaredMethods: readonly string[]
  /** Feed to `StartAcpDaemonInput.policy.enforceablePolicies`. */
  readonly enforceablePolicies: readonly string[]
  compileLaunch(input: EngineLaunchInput): Promise<EngineLaunchSpec>
  verifyEffective(input: {
    readonly handle: EngineHandle
    readonly launch: EngineLaunchInput
    readonly initializeResult: AcpFrame
    readonly sessionConfigResult?: AcpFrame
  }): Promise<{
    readonly effectiveRevision: number
    readonly modelTarget: ModelRef | null
    readonly evidence: JsonValue
  }>
}

export const openCodeAcpAdapter: OpenCodeEngineAdapter = {
  kind: 'opencode',
  declaredMethods: DECLARED_METHODS,
  enforceablePolicies: ENFORCEABLE_POLICIES,

  /**
   * Derive one OpenCode ACP launch from the accepted Teams config.
   *
   * The engine home is the daemon-owned directory (`HOME`), so no user
   * `.opencode`/`.claude`/`.agents` state is read or written: with the real
   * binary the user's 60 global commands collapse to the 3 built-in ones. The
   * accepted snapshot enters as `OPENCODE_CONFIG_CONTENT`, the documented
   * final-scope merge, and contains only `{env:...}` credential references.
   * `credentialEnvRefs` maps the derived env keys to the opaque accepted
   * references; the runtime resolves them into the child env.
   *
   * No binding, protocol, credential reference or backup is invented: the
   * primary is the model the engine selects, and a configured backup only adds
   * provider/model entries without any automatic failover.
   */
  async compileLaunch(input: EngineLaunchInput): Promise<EngineLaunchSpec> {
    assertLaunchInput(input)
    assertOpenCodeNativePolicy(input.policy)

    const binding = bindingOf(input.accepted, input.target.agentId)
    const derived = binding === undefined
      ? { config: { $schema: OPENCODE_SCHEMA } as Record<string, unknown>, credentialReferences: {} as Readonly<Record<string, string>> }
      : compileDerivedConfig(input)

    const permission = nativeDenials(input.policy)
    const engineConfig = permission === undefined ? derived.config : { ...derived.config, permission }

    return {
      executable: input.executable,
      args: ['acp', '--pure'],
      cwd: input.workspace,
      env: {
        PATH: process.env.PATH ?? '',
        // Daemon-owned engine home: OpenCode resolves ~/.opencode and its
        // external skill scans from HOME, so no user engine state is read.
        HOME: input.ownedDirectory,
        // The daemon must not mutate the shared installed engine.
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        // No project-level opencode.json: the accepted Teams config is the only source.
        OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
        OPENCODE_CONFIG_CONTENT: JSON.stringify(engineConfig),
      },
      credentialEnvRefs: derived.credentialReferences,
      files: [],
      supportedPolicies: DECLARED_METHODS,
    }
  },

  /**
   * Prove what the engine instance actually runs.
   *
   * `initialize` alone proves nothing about the selected model, so this method
   * only reports a non-null `modelTarget` when the real `session/new` result
   * reports that exact `<provider>/<model>` in `result.configOptions`. A
   * different engine-reported model is an explicit failure, and a missing
   * `session/new` result keeps the target unknown (`null`) instead of
   * converting the accepted binding into a fake success.
   *
   * The adapter never reads the transport: the runtime captures `initialize`
   * and the caller captures the one `session/new` result through the host.
   */
  async verifyEffective(input: {
    readonly handle: EngineHandle
    readonly launch: EngineLaunchInput
    readonly initializeResult: AcpFrame
    readonly sessionConfigResult?: AcpFrame
  }): Promise<{ readonly effectiveRevision: number; readonly modelTarget: ModelRef | null; readonly evidence: JsonValue }> {
    const launch = input.launch
    if (launch === null || typeof launch !== 'object') fail('UNSUPPORTED_CONFIGURATION', 'OpenCode verification requires the launch input')
    if (launch.target.acceptedRevision !== launch.accepted.acceptedRevision) {
      fail(
        'STALE_GENERATION',
        `OpenCode verification target revision ${launch.target.acceptedRevision} does not match accepted revision ${launch.accepted.acceptedRevision}`,
      )
    }
    const initializeResult = input.initializeResult
    if (!isRecord(initializeResult.result)) fail('UNSUPPORTED_CONFIGURATION', 'OpenCode verification requires a successful initialize result')
    const agentInfo = initializeResult.result.agentInfo
    const engineVersion = isRecord(agentInfo) && typeof agentInfo.version === 'string' ? agentInfo.version : undefined

    const binding = bindingOf(launch.accepted, launch.target.agentId)
    const baseEvidence = {
      adapter: 'opencode',
      engineInstanceId: input.handle.engineInstanceId,
      targetGeneration: input.handle.targetGeneration,
      acceptedRevision: launch.accepted.acceptedRevision,
      ...(engineVersion === undefined ? {} : { engineVersion }),
    }
    if (binding === undefined) {
      return {
        effectiveRevision: launch.accepted.effectiveRevision ?? launch.accepted.acceptedRevision,
        modelTarget: null,
        evidence: { ...baseEvidence, modelBinding: 'none', modelVerification: 'engine-default-unverified' },
      }
    }

    const expected = `${binding.primary.providerInstanceId}/${binding.primary.modelId}`
    if (input.sessionConfigResult === undefined) {
      return {
        effectiveRevision: launch.accepted.effectiveRevision ?? launch.accepted.acceptedRevision,
        modelTarget: null,
        evidence: { ...baseEvidence, modelBinding: expected, modelVerification: 'unavailable', reason: 'session/new result was not captured' },
      }
    }
    const option = modelOptionOf(input.sessionConfigResult)
    if (option === undefined) {
      return {
        effectiveRevision: launch.accepted.effectiveRevision ?? launch.accepted.acceptedRevision,
        modelTarget: null,
        evidence: { ...baseEvidence, modelBinding: expected, modelVerification: 'unavailable', reason: 'engine session/new reported no model config option' },
      }
    }
    if (option.currentValue !== expected) {
      fail(
        'UNSUPPORTED_CONFIGURATION',
        `OpenCode reports effective model ${option.currentValue ?? 'unknown'} but the accepted config selects ${expected}`,
      )
    }
    return {
      effectiveRevision: launch.accepted.effectiveRevision ?? launch.accepted.acceptedRevision,
      modelTarget: { providerInstanceId: binding.primary.providerInstanceId, modelId: binding.primary.modelId },
      evidence: {
        ...baseEvidence,
        modelBinding: expected,
        modelVerification: 'session/new configOptions',
        modelCurrentValue: option.currentValue,
        modelOptionCount: option.optionCount,
      },
    }
  },
}
