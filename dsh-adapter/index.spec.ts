import { describe, expect, it } from 'vitest'
import { AcpError } from '../control-protocol/acp.ts'
import { assertAcpAllowed, extractAcpCapabilities, resolveAcpPolicy } from '../config/acp-policy.ts'
import type { EngineLaunchInput, EngineLaunchSpec } from '../control-protocol/engine.ts'
import type { VersionedRuntimeConfig } from '../config/runtime-config.ts'
import { createDshEngineAdapter, DSH_EXTENSION_METHODS, DSH_UNSUPPORTED_FEATURES } from './index.ts'

/**
 * Fixtures are the real frames captured from the installed DSH ACP server
 * (`dsh --profile acp`) during D03 reconnaissance. They are read-back data,
 * never hand-authored engine claims.
 */
const REAL_INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: 1,
    agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
    agentCapabilities: {
      mcpCapabilities: { http: true },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    },
    authMethods: [],
  },
} as const

function realSessionNew(provider: string, model: string) {
  return {
    jsonrpc: '2.0',
    id: 2,
    result: {
      sessionId: '4e59bca4-4237-4853-93db-48da94a409f7',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: JSON.stringify([provider, model]),
          options: [
            { group: 'deepseek-official', name: 'DeepSeek', options: [{ value: '["deepseek-official","deepseek-flash"]', name: 'Flash' }] },
            { group: provider, name: provider, options: [{ value: JSON.stringify([provider, model]), name: model }] },
          ],
        },
      ],
    },
  } as const
}

function acceptedConfig(overrides: Partial<VersionedRuntimeConfig> = {}): VersionedRuntimeConfig {
  return {
    revision: 7,
    acceptedRevision: 7,
    providers: {
      gateway: {
        id: 'gateway',
        label: 'Gateway',
        protocol: 'openai-chat',
        apiBaseUrl: 'http://127.0.0.1:4444/v1',
        enabled: true,
        auth: { kind: 'bearer', credentialRef: 'GATEWAY_API_KEY' },
      },
    },
    catalogs: {
      gateway: {
        state: 'ready',
        entries: [
          { ref: { providerInstanceId: 'gateway', modelId: 'gpt-5.5' }, origin: 'manual', base: { label: 'RCC GPT-5.5' }, overrides: {} },
        ],
      },
    },
    agents: { 'agent-a': { primary: { providerInstanceId: 'gateway', modelId: 'gpt-5.5' } } },
    ...overrides,
  }
}

function launchInput(overrides: Partial<EngineLaunchInput> = {}): EngineLaunchInput {
  return {
    kind: 'dsh',
    executable: '/opt/homebrew/bin/dsh',
    workspace: '/tmp/d03-workspace',
    ownedDirectory: '/tmp/d03-owned',
    target: {
      agentId: 'agent-a',
      targetGeneration: 3,
      acceptedRevision: 7,
      acceptedSourceRevision: 2,
      acceptedSourceHash: 'hash',
      endpointFingerprint: 'fingerprint',
    },
    accepted: acceptedConfig(),
    policy: { enabled: true, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' },
    ...overrides,
  }
}

async function compile(input: EngineLaunchInput): Promise<EngineLaunchSpec> {
  return await createDshEngineAdapter().compileLaunch(input)
}

async function compileFault(input: EngineLaunchInput): Promise<AcpError> {
  try {
    await compile(input)
  } catch (error) {
    if (error instanceof AcpError) return error
    throw error
  }
  throw new Error('expected the DSH adapter to reject this launch')
}

describe('dsh adapter launch compilation', () => {
  it('rejects an engine kind this adapter does not own', async () => {
    const fault = await compileFault(launchInput({ kind: 'opencode' }))
    expect(fault.code).toBe('UNSUPPORTED_CONFIGURATION')
    expect(fault.message).toContain('DSH adapter')
  })

  it('rejects a relative executable, workspace or owned directory before deriving anything', async () => {
    for (const patch of [{ executable: 'dsh' }, { workspace: 'relative/ws' }, { ownedDirectory: 'relative/owned' }]) {
      const fault = await compileFault(launchInput(patch))
      expect(fault.code).toBe('UNSUPPORTED_CONFIGURATION')
    }
  })

  it('requires an enabled ACP policy', async () => {
    const fault = await compileFault(launchInput({ policy: { enabled: false, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' } }))
    expect(fault.code).toBe('UNSUPPORTED_CONFIGURATION')
  })

  it('rejects a blacklist key with no enforcement owner before producing a launch spec', async () => {
    const fault = await compileFault(launchInput({
      policy: { enabled: true, required: [], blacklist: ['internal-tool:dsh:bash'], clientCapabilities: [], callbackExecutor: 'controller' },
    }))
    expect(fault.code).toBe('UNSUPPORTED_POLICY')
    expect(fault.message).toContain('internal-tool:dsh:bash')
  })

  it('rejects a statically unsupported required capability before producing a launch spec', async () => {
    const fault = await compileFault(launchInput({
      policy: { enabled: true, required: ['method:session/load'], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' },
    }))
    expect(fault.code).toBe('UNSUPPORTED_CAPABILITY')
    expect(fault.message).toContain('session/load')
  })

  it('rejects a daemon identity with no configured model binding instead of using an engine default', async () => {
    const fault = await compileFault(launchInput({ accepted: acceptedConfig({ agents: {} }) }))
    expect(fault.code).toBe('UNSUPPORTED_CONFIGURATION')
    expect(fault.message).toContain('agent-a')
  })

  it('rejects a binding whose provider instance is unknown, disabled or has no ready catalog', async () => {
    const unknown = await compileFault(launchInput({ accepted: acceptedConfig({ providers: {} }) }))
    expect(unknown.code).toBe('UNSUPPORTED_CONFIGURATION')

    const disabled = acceptedConfig()
    const disabledProvider = { ...disabled.providers.gateway, enabled: false }
    const disabledFault = await compileFault(launchInput({ accepted: { ...disabled, providers: { gateway: disabledProvider } } }))
    expect(disabledFault.code).toBe('UNSUPPORTED_CONFIGURATION')

    const notReady = acceptedConfig()
    const emptyCatalog = await compileFault(launchInput({
      accepted: { ...notReady, catalogs: { gateway: { state: 'error', entries: notReady.catalogs.gateway.entries } } },
    }))
    expect(emptyCatalog.code).toBe('UNSUPPORTED_CONFIGURATION')
  })

  it('rejects a bound model that the provider catalog does not declare', async () => {
    const config = acceptedConfig()
    const fault = await compileFault(launchInput({
      accepted: { ...config, agents: { 'agent-a': { primary: { providerInstanceId: 'gateway', modelId: 'not-declared' } } } },
    }))
    expect(fault.code).toBe('UNSUPPORTED_CONFIGURATION')
    expect(fault.message).toContain('not-declared')
  })

  it('compiles the real DSH ACP launch: profile, patch file, workspace and owned DSH home', async () => {
    const spec = await compile(launchInput())
    expect(spec.executable).toBe('/opt/homebrew/bin/dsh')
    expect(spec.args).toEqual(['--profile', 'acp', '--patch', '/tmp/d03-owned/teams-dsh-acp.patch.json'])
    expect(spec.cwd).toBe('/tmp/d03-workspace')
    expect(spec.files).toHaveLength(1)
    expect(spec.files[0].path).toBe('/tmp/d03-owned/teams-dsh-acp.patch.json')
    expect(spec.files[0].mode).toBe(0o600)
    expect(spec.env.DSH_HOME).toBe('/tmp/d03-owned')
    expect(spec.env.DSH_PERMISSION_MODE).toBe('workspace-write')
    expect(spec.env.DSH_TELEMETRY_DISABLED).toBe('1')
  })

  it('does not inherit the parent harness environment into the engine', async () => {
    const previous = process.env.DSH_SESSION_ID
    process.env.DSH_SESSION_ID = 'parent-session'
    try {
      const spec = await compile(launchInput())
      expect(spec.env.DSH_SESSION_ID).toBeUndefined()
      expect(spec.env.PATH).toBe(process.env.PATH)
    } finally {
      if (previous === undefined) delete process.env.DSH_SESSION_ID
      else process.env.DSH_SESSION_ID = previous
    }
  })

  it('derives an engine-owned pi-ai route and selects the Teams model in the patch', async () => {
    const spec = await compile(launchInput())
    const patch = JSON.parse(spec.files[0].content) as { id: string; config: Record<string, unknown> }[]
    const acp = patch.find(entry => entry.id === 'acp')
    expect(acp?.config).toEqual({ provider: 'teams-gateway', model: 'gpt-5.5' })
    const piAi = patch.find(entry => entry.id === 'llm-pi-ai')
    const providers = piAi?.config.providers as Record<string, Record<string, unknown>>
    expect(Object.keys(providers)).toEqual(['teams-gateway'])
    expect(providers['teams-gateway'].api).toBe('openai-completions')
    expect(providers['teams-gateway'].baseURL).toBe('http://127.0.0.1:4444/v1')
    expect(providers['teams-gateway'].apiKeyEnv).toBe('TEAMS_DSH_CREDENTIAL_0')
    expect(providers['teams-gateway'].models).toEqual([{ id: 'gpt-5.5', name: 'RCC GPT-5.5' }])
  })

  it('maps the openai-responses protocol onto the DSH responses api', async () => {
    const config = acceptedConfig()
    const spec = await compile(launchInput({
      accepted: {
        ...config,
        providers: { gateway: { ...config.providers.gateway, protocol: 'openai-responses' } },
      },
    }))
    const patch = JSON.parse(spec.files[0].content) as { id: string; config: { providers: Record<string, { api: string }> } }[]
    expect(patch.find(entry => entry.id === 'llm-pi-ai')?.config.providers['teams-gateway'].api).toBe('openai-responses')
  })

  it('maps a bearer credential to a launch credential reference and omits it for keyless providers', async () => {
    const withKey = await compile(launchInput())
    expect(withKey.credentialEnvRefs).toEqual({ TEAMS_DSH_CREDENTIAL_0: 'GATEWAY_API_KEY' })

    const config = acceptedConfig()
    const keyless = await compile(launchInput({
      accepted: { ...config, providers: { gateway: { ...config.providers.gateway, auth: { kind: 'none' } } } },
    }))
    expect(keyless.credentialEnvRefs).toEqual({})
    const patch = JSON.parse(keyless.files[0].content) as { id: string; config: { providers: Record<string, Record<string, unknown>> } }[]
    expect(patch.find(entry => entry.id === 'llm-pi-ai')?.config.providers['teams-gateway'].apiKeyEnv).toBeUndefined()
  })

  it('declares the DSH extension methods as the policies it carries', async () => {
    const spec = await compile(launchInput())
    for (const method of DSH_EXTENSION_METHODS) expect(spec.supportedPolicies).toContain(`method:${method}`)
    expect(spec.supportedPolicies).toContain('acp')
  })

  it('declares the engine approval callback so the frozen policy admits it', async () => {
    const adapter = createDshEngineAdapter()
    expect(adapter.declaredMethods).toContain('callback:session/request_permission')
    const spec = await adapter.compileLaunch(launchInput())
    expect(spec.supportedPolicies).toContain('callback:session/request_permission')

    // The frozen policy owner admits an engine callback only when the adapter
    // declared its key: without the declaration the host refuses the engine's
    // approval request before any controller can answer it.
    const supported = extractAcpCapabilities(REAL_INITIALIZE, adapter.declaredMethods)
    const policy = resolveAcpPolicy({
      intent: { enabled: true, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' },
      engineInstanceId: 'engine-1',
      supported,
      enforceablePolicies: supported,
    })
    expect(() => assertAcpAllowed({
      policy,
      direction: 'from-engine',
      frame: {
        jsonrpc: '2.0',
        id: 'engine-callback-1',
        method: 'session/request_permission',
        params: { sessionId: 's', toolCall: {}, options: [{ optionId: 'allow-once', name: 'Allow', kind: 'allow_once' }] },
      },
    })).not.toThrow()

    const undeclared = resolveAcpPolicy({
      intent: { enabled: true, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' },
      engineInstanceId: 'engine-1',
      supported: extractAcpCapabilities(REAL_INITIALIZE),
      enforceablePolicies: extractAcpCapabilities(REAL_INITIALIZE),
    })
    expect(() => assertAcpAllowed({
      policy: undeclared,
      direction: 'from-engine',
      frame: { jsonrpc: '2.0', id: 'engine-callback-2', method: 'session/request_permission', params: { sessionId: 's' } },
    })).toThrow(AcpError)
  })
})

describe('dsh adapter capability declaration', () => {
  it('declares engine-owned session management as engine-declared, never adapter-owned', () => {
    const adapter = createDshEngineAdapter()
    for (const method of ['session/list', 'session/resume', 'session/close']) {
      const entry = adapter.capabilities.find(capability => capability.key === `method:${method}`)
      expect(entry?.support).toBe('engine')
    }
  })

  it('declares the unsupported DSH ACP surface with its contract reason', () => {
    for (const method of ['session/load', 'session/delete', 'session/fork']) {
      const entry = DSH_UNSUPPORTED_FEATURES.find(capability => capability.key === `method:${method}`)
      expect(entry?.support).toBe('unsupported')
      expect(entry?.reason.length).toBeGreaterThan(0)
    }
    const sse = DSH_UNSUPPORTED_FEATURES.find(capability => capability.key === 'capability:/mcpCapabilities/sse')
    expect(sse?.support).toBe('unsupported')
  })

  it('declares the set_config_option extension as adapter-carried', () => {
    const entry = createDshEngineAdapter().capabilities.find(capability => capability.key === 'method:session/set_config_option')
    expect(entry?.support).toBe('adapter')
  })
})

describe('dsh adapter effectiveness proof', () => {
  it('rejects a non-DSH engine identity from the real initialize result', async () => {
    const adapter = createDshEngineAdapter()
    const spec = await adapter.compileLaunch(launchInput())
    await expect(adapter.verifyEffective({
      handle: fakeHandle(),
      launch: launchInput(),
      initializeResult: { ...REAL_INITIALIZE, result: { ...REAL_INITIALIZE.result, agentInfo: { name: 'opencode', version: '1' } } },
      sessionConfigResult: realSessionNew('teams-gateway', 'gpt-5.5'),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
    expect(spec.args[0]).toBe('--profile')
  })

  it('rejects an initialize result that omits an engine-owned session capability', async () => {
    const adapter = createDshEngineAdapter()
    const result = {
      ...REAL_INITIALIZE.result,
      agentCapabilities: { ...REAL_INITIALIZE.result.agentCapabilities, sessionCapabilities: { close: {}, list: {} } },
    }
    await expect(adapter.verifyEffective({
      handle: fakeHandle(),
      launch: launchInput(),
      initializeResult: { ...REAL_INITIALIZE, result },
      sessionConfigResult: realSessionNew('teams-gateway', 'gpt-5.5'),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })

  it('proves the Teams provider/model from the real session/new config options', async () => {
    const adapter = createDshEngineAdapter()
    const proof = await adapter.verifyEffective({
      handle: fakeHandle(),
      launch: launchInput(),
      initializeResult: REAL_INITIALIZE,
      sessionConfigResult: realSessionNew('teams-gateway', 'gpt-5.5'),
    })
    expect(proof.effectiveRevision).toBe(7)
    expect(proof.modelTarget).toEqual({ providerInstanceId: 'gateway', modelId: 'gpt-5.5' })
    expect(proof.evidence).toMatchObject({
      engine: 'dsh',
      engineVersion: '0.0.1',
      engineRoute: 'teams-gateway',
      modelOptionValue: '["teams-gateway","gpt-5.5"]',
    })
  })

  it('refuses to claim effectiveness when the engine selected a different model', async () => {
    const adapter = createDshEngineAdapter()
    await expect(adapter.verifyEffective({
      handle: fakeHandle(),
      launch: launchInput(),
      initializeResult: REAL_INITIALIZE,
      sessionConfigResult: realSessionNew('teams-gateway', 'other-model'),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
  })

  it('refuses to claim effectiveness without a real session/new readback', async () => {
    const adapter = createDshEngineAdapter()
    await expect(adapter.verifyEffective({
      handle: fakeHandle(),
      launch: launchInput(),
      initializeResult: REAL_INITIALIZE,
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
  })
})

function fakeHandle() {
  return {
    engineInstanceId: 'engine-1',
    pid: 4242,
    targetGeneration: 3,
    acp: {
      read: async () => ({}),
      send: async () => {},
      closed: new Promise<never>(() => {}),
      close: async () => {},
    },
    exited: new Promise<{ code: number | null; signal: string | null }>(() => {}),
    stop: async () => ({ kind: 'exited' as const, code: 0, signal: null }),
  }
}
