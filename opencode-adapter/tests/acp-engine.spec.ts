import { describe, expect, it } from 'vitest'
import type { AcpFrame } from '../../packages/shared/src/acp.ts'
import type { EngineHandle, EngineLaunchInput, EngineLaunchSpec } from '../../packages/shared/src/engine.ts'
import type { AcpPolicyIntent } from '../../config/acp-policy.ts'
import { extractAcpCapabilities, resolveAcpPolicy } from '../../config/acp-policy.ts'
import type { ProviderInstance, VersionedRuntimeConfig } from '../../config/runtime-config.ts'
import { openCodeAcpAdapter } from '../src/acp-engine.ts'

const intent: AcpPolicyIntent = {
  enabled: true,
  required: [],
  blacklist: [],
  clientCapabilities: [],
  callbackExecutor: 'controller',
}

function provider(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: 'probe',
    label: 'Probe',
    protocol: 'openai-chat',
    apiBaseUrl: 'http://127.0.0.1:9/v1',
    enabled: true,
    auth: { kind: 'bearer', credentialRef: 'env:PROBE_API_KEY' },
    ...overrides,
  }
}

function catalog(...entries: readonly { readonly providerInstanceId: string; readonly modelId: string }[]) {
  return {
    state: 'ready' as const,
    entries: entries.map(entry => ({ ref: entry, origin: 'manual' as const, base: {}, overrides: {} })),
  }
}

function acceptedConfig(overrides: Partial<VersionedRuntimeConfig> = {}): VersionedRuntimeConfig {
  return {
    revision: 7,
    acceptedRevision: 7,
    effectiveRevision: 7,
    providers: { probe: provider() },
    catalogs: { probe: catalog({ providerInstanceId: 'probe', modelId: 'probe-model' }) },
    agents: { 'agent-a': { primary: { providerInstanceId: 'probe', modelId: 'probe-model' } } },
    ...overrides,
  }
}

function launchInput(overrides: Partial<EngineLaunchInput> = {}): EngineLaunchInput {
  return {
    kind: 'opencode',
    executable: '/Users/fanzhang/.opencode/bin/opencode',
    workspace: '/tmp/teams-workspace',
    ownedDirectory: '/tmp/teams-owned/engine',
    target: {
      agentId: 'agent-a',
      targetGeneration: 3,
      acceptedRevision: 7,
      acceptedSourceRevision: 4,
      acceptedSourceHash: 'hash',
      endpointFingerprint: 'endpoint',
    },
    accepted: acceptedConfig(),
    policy: intent,
    ...overrides,
  }
}

function handle(): EngineHandle {
  return {
    engineInstanceId: 'engine-1',
    pid: 4242,
    targetGeneration: 3,
    acp: {
      read: async () => { throw new Error('adapter must not read the transport') },
      send: async () => { throw new Error('adapter must not write the transport') },
      closed: new Promise(() => {}),
      close: async () => {},
    },
    exited: new Promise(() => {}),
    stop: async () => ({ kind: 'exited', code: 0, signal: null }),
  }
}

function engineConfigOf(launch: EngineLaunchSpec): Record<string, unknown> {
  const content = launch.env.OPENCODE_CONFIG_CONTENT
  expect(typeof content).toBe('string')
  return JSON.parse(content as string) as Record<string, unknown>
}

function initializeResult(): AcpFrame {
  // Captured from the real installed `opencode 1.18.23` ACP server.
  return {
    jsonrpc: '2.0',
    id: 'acp-initialize-engine-1',
    result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        mcpCapabilities: { http: true, sse: true },
        promptCapabilities: { embeddedContext: true, image: true },
        sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
      },
      authMethods: [{ description: 'Run `opencode auth login` in the terminal', name: 'Login with opencode', id: 'opencode-login' }],
      agentInfo: { name: 'OpenCode', version: '1.18.23' },
    },
  }
}

function sessionNewResult(model: string): AcpFrame {
  // Captured from the real installed `opencode 1.18.23` ACP server.
  return {
    jsonrpc: '2.0',
    id: 2,
    result: {
      sessionId: 'ses_probe',
      configOptions: [
        { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [{ value: model, name: model }] },
        { id: 'mode', name: 'Session Mode', category: 'mode', type: 'select', currentValue: 'build', options: [{ value: 'build', name: 'build' }] },
      ],
    },
  }
}

describe('openCodeAcpAdapter.compileLaunch', () => {
  it('derives one isolated ACP launch from the accepted binding', async () => {
    const input = launchInput()
    const before = structuredClone(input)
    const launch = await openCodeAcpAdapter.compileLaunch(input)

    expect(launch.executable).toBe('/Users/fanzhang/.opencode/bin/opencode')
    expect(launch.args).toEqual(['acp', '--pure'])
    expect(launch.cwd).toBe('/tmp/teams-workspace')
    expect(launch.files).toEqual([])
    expect(launch.env.HOME).toBe('/tmp/teams-owned/engine')
    expect(launch.env.OPENCODE_DISABLE_PROJECT_CONFIG).toBe('true')
    expect(launch.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1')

    const config = engineConfigOf(launch)
    expect(config.model).toBe('probe/probe-model')
    expect(config.enabled_providers).toEqual(['probe'])
    const providers = config.provider as Record<string, { options: { baseURL: string; apiKey?: string } }>
    expect(providers.probe.options.baseURL).toBe('http://127.0.0.1:9/v1')
    expect(providers.probe.options.apiKey).toBe('{env:TEAMS_PROVIDER_0}')

    // The credential reference is opaque and the value never enters the launch.
    expect(launch.credentialEnvRefs).toEqual({ TEAMS_PROVIDER_0: 'env:PROBE_API_KEY' })
    expect(JSON.stringify(launch.env)).not.toContain('PROBE_API_KEY')
    expect(JSON.stringify(launch)).not.toContain('secret')

    // The accepted snapshot is an input, never mutated.
    expect(input).toEqual(before)
  })

  it('maps the openai-responses protocol without substituting another one', async () => {
    const launch = await openCodeAcpAdapter.compileLaunch(launchInput({
      accepted: acceptedConfig({ providers: { probe: provider({ protocol: 'openai-responses' }) } }),
    }))
    const providers = engineConfigOf(launch).provider as Record<string, { npm: string }>
    expect(providers.probe.npm).toBe('@ai-sdk/openai')
  })

  it('registers a configured backup without any automatic failover', async () => {
    const launch = await openCodeAcpAdapter.compileLaunch(launchInput({
      accepted: acceptedConfig({
        providers: { probe: provider(), 'probe-b': provider({ id: 'probe-b', protocol: 'openai-responses', apiBaseUrl: 'http://127.0.0.1:10/v1', auth: { kind: 'none' } }) },
        catalogs: {
          probe: catalog({ providerInstanceId: 'probe', modelId: 'probe-model' }),
          'probe-b': catalog({ providerInstanceId: 'probe-b', modelId: 'backup-model' }),
        },
        agents: { 'agent-a': { primary: { providerInstanceId: 'probe', modelId: 'probe-model' }, backup: { providerInstanceId: 'probe-b', modelId: 'backup-model' } } },
      }),
    }))
    const config = engineConfigOf(launch)
    expect(config.model).toBe('probe/probe-model')
    expect(config.enabled_providers).toEqual(['probe', 'probe-b'])
    const providers = config.provider as Record<string, { models: Record<string, unknown> }>
    expect(Object.keys(providers['probe-b'].models)).toEqual(['backup-model'])
    expect(launch.credentialEnvRefs).toEqual({ TEAMS_PROVIDER_0: 'env:PROBE_API_KEY' })
  })

  it('compiles no provider and no credential when the accepted config has no binding', async () => {
    const launch = await openCodeAcpAdapter.compileLaunch(launchInput({ accepted: acceptedConfig({ agents: {} }) }))
    const config = engineConfigOf(launch)
    expect(config.model).toBeUndefined()
    expect(config.provider).toBeUndefined()
    expect(launch.credentialEnvRefs).toEqual({})
  })

  it('maps a native-tool blacklist to an engine-enforced permission denial', async () => {
    const launch = await openCodeAcpAdapter.compileLaunch(launchInput({
      policy: { ...intent, blacklist: ['internal-tool:opencode:bash'] },
    }))
    expect(engineConfigOf(launch).permission).toEqual({ bash: 'deny' })
    expect(launch.supportedPolicies).toContain('internal-tool:opencode:bash')
  })

  it('rejects a native-tool key with no OpenCode enforcement owner', async () => {
    await expect(openCodeAcpAdapter.compileLaunch(launchInput({
      policy: { ...intent, blacklist: ['internal-tool:opencode:write'] },
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_POLICY' })
    await expect(openCodeAcpAdapter.compileLaunch(launchInput({
      policy: { ...intent, blacklist: ['internal-tool:dsh:bash'] },
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_POLICY' })
  })

  it('rejects a required native tool it cannot verify', async () => {
    await expect(openCodeAcpAdapter.compileLaunch(launchInput({
      policy: { ...intent, required: ['internal-tool:opencode:bash'] },
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_POLICY' })
  })

  it('rejects a wrong engine kind, a disabled policy and a non-absolute owned directory', async () => {
    await expect(openCodeAcpAdapter.compileLaunch(launchInput({ kind: 'dsh' })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
    await expect(openCodeAcpAdapter.compileLaunch(launchInput({ policy: { ...intent, enabled: false } })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
    await expect(openCodeAcpAdapter.compileLaunch(launchInput({ ownedDirectory: 'relative/dir' })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
  })

  it('rejects an unmappable accepted binding instead of compiling a partial launch', async () => {
    await expect(openCodeAcpAdapter.compileLaunch(launchInput({
      accepted: acceptedConfig({ agents: { 'agent-a': { primary: { providerInstanceId: 'missing', modelId: 'm' } } } }),
    }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONFIGURATION',
      detail: { source: 'opencode-adapter', code: 'NOT_FOUND' },
    })
    await expect(openCodeAcpAdapter.compileLaunch(launchInput({
      accepted: acceptedConfig({
        providers: { probe: provider({ enabled: false }) },
      }),
    }))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
  })
})

describe('openCodeAcpAdapter policy declaration', () => {
  it('is accepted by the frozen policy vocabulary as a real enforcement owner', () => {
    const policy = resolveAcpPolicy({
      intent: { ...intent, blacklist: ['internal-tool:opencode:bash'] },
      engineInstanceId: 'engine-1',
      supported: extractAcpCapabilities(initializeResult(), openCodeAcpAdapter.declaredMethods),
      enforceablePolicies: openCodeAcpAdapter.enforceablePolicies,
    })
    expect(policy.supported).toContain('internal-tool:opencode:bash')
    expect(policy.denied).toEqual(['internal-tool:opencode:bash'])
    expect(policy.effective).not.toContain('internal-tool:opencode:bash')
  })

  it('declares the permission callback the real initialize result does not', () => {
    const fromEngine = extractAcpCapabilities(initializeResult())
    expect(fromEngine).not.toContain('callback:session/request_permission')
    const policy = resolveAcpPolicy({
      intent,
      engineInstanceId: 'engine-1',
      supported: extractAcpCapabilities(initializeResult(), openCodeAcpAdapter.declaredMethods),
      enforceablePolicies: openCodeAcpAdapter.enforceablePolicies,
    })
    expect(policy.supported).toContain('callback:session/request_permission')
    expect(policy.effective).toContain('callback:session/request_permission')
  })
})

describe('openCodeAcpAdapter.verifyEffective', () => {
  it('proves the configured model only from the real session/new result', async () => {
    const input = launchInput()
    const verified = await openCodeAcpAdapter.verifyEffective({
      handle: handle(),
      launch: input,
      initializeResult: initializeResult(),
      sessionConfigResult: sessionNewResult('probe/probe-model'),
    })
    expect(verified.effectiveRevision).toBe(7)
    expect(verified.modelTarget).toEqual({ providerInstanceId: 'probe', modelId: 'probe-model' })
    expect(verified.evidence).toMatchObject({ modelVerification: 'session/new configOptions', modelCurrentValue: 'probe/probe-model' })
  })

  it('fails when the engine reports a different effective model', async () => {
    await expect(openCodeAcpAdapter.verifyEffective({
      handle: handle(),
      launch: launchInput(),
      initializeResult: initializeResult(),
      sessionConfigResult: sessionNewResult('other/other-model'),
    })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
  })

  it('keeps the model unknown when no session/new result was captured', async () => {
    const verified = await openCodeAcpAdapter.verifyEffective({
      handle: handle(),
      launch: launchInput(),
      initializeResult: initializeResult(),
    })
    expect(verified.modelTarget).toBeNull()
    expect(verified.evidence).toMatchObject({ modelVerification: 'unavailable' })
  })

  it('keeps an unbound engine default unknown instead of inventing a target', async () => {
    const verified = await openCodeAcpAdapter.verifyEffective({
      handle: handle(),
      launch: launchInput({ accepted: acceptedConfig({ agents: {} }) }),
      initializeResult: initializeResult(),
      sessionConfigResult: sessionNewResult('engine/default'),
    })
    expect(verified.modelTarget).toBeNull()
    expect(verified.evidence).toMatchObject({ modelBinding: 'none' })
  })

  it('refuses to verify against a target revision that is not the accepted revision', async () => {
    const input = launchInput()
    await expect(openCodeAcpAdapter.verifyEffective({
      handle: handle(),
      launch: { ...input, target: { ...input.target, acceptedRevision: 6 } },
      initializeResult: initializeResult(),
      sessionConfigResult: sessionNewResult('probe/probe-model'),
    })).rejects.toMatchObject({ code: 'STALE_GENERATION' })
  })
})
