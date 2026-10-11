import { describe, expect, it } from 'vitest'
import {
  compileDaemonIntent,
  DaemonIntentError,
  parseDaemonIntent,
  resolveDaemonIntent,
  type AgentDaemonIntent,
  type ControlDaemonIntent,
  type RegistryDaemonIntent,
} from './daemon-intent.ts'

function errorCode(task: () => unknown): string {
  try {
    task()
  } catch (error) {
    if (error instanceof DaemonIntentError) return error.code
    throw error
  }
  throw new Error('expected DaemonIntentError')
}

const agentConfig = {
  version: 4,
  daemon: {
    kind: 'agent',
    id: 'reasoner-a',
    hostId: 'host-a',
    accountId: 'local',
    scopeId: 'local',
    dataDirectory: './state/reasoner-a',
  },
  engine: {
    kind: 'opencode',
    executable: '/opt/homebrew/bin/opencode',
    workspace: './workspace',
  },
  listen: {
    ip: '127.0.0.1',
    port: 7443,
  },
  acp: {
    enabled: true,
    required: ['method:session/load'],
    blacklist: ['callback:session/request_permission'],
    clientCapabilities: [],
    callbackExecutor: 'controller',
  },
  relations: {
    allowed: ['master', 'peer'],
  },
  providers: {
    openai: {
      protocol: 'openai-chat',
      apiBaseUrl: 'https://api.example.test/v1',
      label: 'Example OpenAI',
      credentialEnv: 'EXAMPLE_API_KEY',
    },
  },
  models: [
    {
      provider: 'openai',
      id: 'gpt-4.1',
      label: 'GPT-4.1',
      contextWindow: 128000,
      maxOutputTokens: 16384,
      tools: true,
      streaming: true,
      reasoning: true,
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
    },
    {
      provider: 'openai',
      id: 'gpt-4.1-mini',
      label: 'GPT-4.1 mini',
    },
  ],
  model: {
    primary: { provider: 'openai', model: 'gpt-4.1' },
    backup: { provider: 'openai', model: 'gpt-4.1-mini' },
  },
} as const

const controlConfig = {
  version: 4,
  daemon: {
    kind: 'control',
    id: 'control-a',
    hostId: 'control-host',
    accountId: 'local',
    scopeId: 'local',
    dataDirectory: './state/control-a',
  },
  webui: {
    ip: '127.0.0.1',
    port: 7331,
    auth: { username: 'teams', passwordEnv: 'TEAMS_CONSOLE_PASSWORD' },
    allowedOrigin: 'http://127.0.0.1:7331',
  },
  relations: { allowed: ['master', 'peer'] },
  peers: {
    reasoner: {
      agentId: 'reasoner-a',
      hostId: 'host-a',
      accountId: 'local',
      scopeId: 'local',
      endpoint: 'wss://192.168.1.21:7443',
      credentialRef: 'env:TEAMS_CONTROL_TO_A',
      tlsTrustRef: 'file:./certs/agent-ca.pem',
    },
  },
} as const

const registryConfig = {
  version: 4,
  daemon: {
    kind: 'registry',
    id: 'lan-registry',
    hostId: 'registry-host',
    accountId: 'local',
    scopeId: 'local',
    dataDirectory: './state/lan-registry',
  },
  listen: {
    ip: '127.0.0.1',
    port: 7444,
  },
  admissions: [
    {
      admissionRef: 'reasoner-registration',
      agentId: 'reasoner-a',
      accountId: 'local',
      scopeId: 'local',
      credentialRef: 'env:TEAMS_REASONER_REGISTRATION',
    },
  ],
} as const

describe('daemon intent parser', () => {
  it('parses the agent shape and applies amendment defaults', () => {
    const intent = parseDaemonIntent({
      version: 4,
      daemon: agentConfig.daemon,
      engine: { kind: 'dsh' },
      listen: { ip: '::1', port: 7443 },
      acp: { enabled: true },
    })
    expect(intent.daemon.kind).toBe('agent')
    const agent = intent as AgentDaemonIntent
    expect(agent.engine).toEqual({ kind: 'dsh' })
    expect(agent.acp).toEqual({
      enabled: true,
      required: [],
      blacklist: [],
      clientCapabilities: [],
      callbackExecutor: 'controller',
    })
    expect(agent.relations).toEqual({ allowed: ['peer'] })
    expect(agent.admissions).toEqual([])
    expect(agent.peers).toEqual({})
    expect(agent.providers).toEqual({})
    expect(agent.models).toEqual([])
  })

  it('parses control and registry shapes without creating a second provider shape', () => {
    const control = parseDaemonIntent(controlConfig)
    const registry = parseDaemonIntent(registryConfig)
    expect(control.daemon.kind).toBe('control')
    expect(registry.daemon.kind).toBe('registry')
    const parsedControl = control as ControlDaemonIntent
    const parsedRegistry = registry as RegistryDaemonIntent
    expect(parsedControl.webui.auth).toEqual({ username: 'teams', passwordEnv: 'TEAMS_CONSOLE_PASSWORD' })
    expect(parsedControl.peers.reasoner.endpoint).toBe('wss://192.168.1.21:7443')
    expect(parsedRegistry.listen).toEqual({ ip: '127.0.0.1', port: 7444 })
    expect(parsedRegistry.admissions[0].credentialRef).toBe('env:TEAMS_REASONER_REGISTRATION')
  })

  it('rejects legacy v3 and closed-schema mismatches before compilation', () => {
    expect(errorCode(() => parseDaemonIntent({ version: 3, agents: {} }))).toBe('UNSUPPORTED_CONFIGURATION')
    expect(errorCode(() => parseDaemonIntent({ version: 4, daemon: [] }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({ ...agentConfig, agents: {} }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({ ...controlConfig, engine: { kind: 'dsh' } }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({ ...registryConfig, relations: { allowed: ['peer'] } }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({ ...agentConfig, unknownField: true }))).toBe('INVALID_INPUT')
  })

  it('rejects invalid IP, port, credential, and non-loopback listener policy', () => {
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      listen: { ip: 'localhost', port: 7443 },
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      listen: { ip: '0.0.0.0', port: 7443 },
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      listen: { ip: '127.0.0.1', port: 0 },
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      admissions: [{
        admissionRef: 'bad',
        agentId: 'peer',
        accountId: 'local',
        scopeId: 'local',
        credentialRef: 'plain-secret',
      }],
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      listen: { ip: '192.168.1.20', port: 7443 },
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      listen: { ip: '192.168.1.20', port: 7443, tlsCertRef: 'file:./cert.pem', tlsKeyRef: 'file:./key.pem' },
    }))).toBe('INVALID_INPUT')
  })

  it('requires authenticated TLS WebUI for non-loopback control', () => {
    expect(errorCode(() => parseDaemonIntent({
      ...controlConfig,
      webui: { ip: '192.168.1.10', port: 7331 },
    }))).toBe('AUTHENTICATION_REQUIRED')
    expect(errorCode(() => parseDaemonIntent({
      ...controlConfig,
      webui: {
        ip: '192.168.1.10',
        port: 7331,
        auth: { username: 'teams', passwordEnv: 'TEAMS_CONSOLE_PASSWORD' },
      },
    }))).toBe('INVALID_INPUT')
    expect(() => parseDaemonIntent({
      ...controlConfig,
      webui: {
        ip: '192.168.1.10',
        port: 7331,
        auth: { username: 'teams', passwordEnv: 'TEAMS_CONSOLE_PASSWORD' },
        tlsCertRef: 'file:./cert.pem',
        tlsKeyRef: 'file:./key.pem',
      },
    })).not.toThrow()
  })

  it('requires explicit authenticated WSS discovery and peer trust references', () => {
    expect(errorCode(() => parseDaemonIntent({
      ...controlConfig,
      discovery: {
        serverId: 'lan-registry',
        endpoint: 'https://192.168.1.10:7444',
        credentialRef: 'env:TEAMS_DISCOVERY_CREDENTIAL',
        tlsTrustRef: 'file:./certs/registry-ca.pem',
      },
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...controlConfig,
      peers: {
        reasoner: {
          ...controlConfig.peers.reasoner,
          endpoint: 'wss://192.168.1.21:7443',
          tlsTrustRef: undefined,
        },
      },
    }))).toBe('INVALID_INPUT')
  })

  it('rejects unknown model bindings without inventing a provider', () => {
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      model: { primary: { provider: 'missing', model: 'gpt-4.1' } },
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      model: { primary: { provider: 'openai', model: 'missing' } },
    }))).toBe('INVALID_INPUT')
  })
})

describe('daemon intent compiler', () => {
  it('compiles one accepted agent revision with manual catalog entries', () => {
    const intent = parseDaemonIntent(agentConfig) as AgentDaemonIntent
    const compiled = compileDaemonIntent(intent, { configDirectory: '/tmp/teams-config' })
    expect(compiled.revision).toBe(1)
    expect(compiled.acceptedRevision).toBe(1)
    expect(compiled.effectiveRevision).toBeUndefined()
    expect(compiled.providers.openai).toMatchObject({
      id: 'openai',
      label: 'Example OpenAI',
      protocol: 'openai-chat',
      apiBaseUrl: 'https://api.example.test/v1',
      enabled: true,
      auth: { kind: 'bearer', credentialRef: 'EXAMPLE_API_KEY' },
    })
    expect(compiled.catalogs.openai.state).toBe('ready')
    expect(compiled.catalogs.openai.entries).toHaveLength(2)
    expect(compiled.catalogs.openai.entries[0]).toMatchObject({
      ref: { providerInstanceId: 'openai', modelId: 'gpt-4.1' },
      origin: 'manual',
      base: {
        label: 'GPT-4.1',
        contextWindow: 128000,
        maxOutputTokens: 16384,
        tools: true,
        streaming: true,
        reasoning: true,
        inputModalities: ['text', 'image'],
        outputModalities: ['text'],
      },
      overrides: {},
    })
    expect(compiled.agents['reasoner-a']).toEqual({
      primary: { providerInstanceId: 'openai', modelId: 'gpt-4.1' },
      backup: { providerInstanceId: 'openai', modelId: 'gpt-4.1-mini' },
    })
  })

  it('keeps agents empty when no primary binding is declared', () => {
    const intent = parseDaemonIntent({
      version: 4,
      daemon: agentConfig.daemon,
      engine: { kind: 'dsh' },
      listen: { ip: '127.0.0.1', port: 7443 },
      acp: { enabled: true },
      providers: {
        openai: {
          protocol: 'openai-chat',
          apiBaseUrl: 'https://api.example.test/v1',
          label: 'Example OpenAI',
        },
      },
      models: [{ provider: 'openai', id: 'gpt-4.1' }],
    }) as AgentDaemonIntent
    const compiled = compileDaemonIntent(intent, { configDirectory: '/tmp/teams-config' })
    expect(compiled.agents).toEqual({})
    expect(compiled.catalogs.openai.state).toBe('ready')
  })

  it('returns an empty versioned config for control and registry daemons', () => {
    const control = parseDaemonIntent(controlConfig) as ControlDaemonIntent
    const registry = parseDaemonIntent(registryConfig) as RegistryDaemonIntent
    expect(compileDaemonIntent(control, { configDirectory: '/tmp/teams-config' })).toEqual({
      revision: 1,
      acceptedRevision: 1,
      providers: {},
      catalogs: {},
      agents: {},
    })
    expect(compileDaemonIntent(registry, { configDirectory: '/tmp/teams-config' })).toEqual({
      revision: 1,
      acceptedRevision: 1,
      providers: {},
      catalogs: {},
      agents: {},
    })
  })

  it('resolves launch paths and file references without reading them', () => {
    const intent = parseDaemonIntent({
      ...agentConfig,
      listen: {
        ip: '127.0.0.1',
        port: 7443,
        tlsCertRef: 'file:./certs/agent.pem',
        tlsKeyRef: 'file:./certs/agent-key.pem',
      },
      discovery: {
        serverId: 'lan-registry',
        endpoint: 'wss://192.168.1.10:7444',
        credentialRef: 'file:./secrets/discovery.token',
        tlsTrustRef: 'file:./certs/registry-ca.pem',
      },
    }) as AgentDaemonIntent
    const resolved = resolveDaemonIntent(intent, { configDirectory: '/tmp/teams-config' }) as AgentDaemonIntent
    expect(resolved.daemon.dataDirectory).toBe('/tmp/teams-config/state/reasoner-a')
    expect(resolved.engine?.workspace).toBe('/tmp/teams-config/workspace')
    expect(resolved.listen?.tlsCertRef).toBe('file:/tmp/teams-config/certs/agent.pem')
    expect(resolved.listen?.tlsKeyRef).toBe('file:/tmp/teams-config/certs/agent-key.pem')
    expect(resolved.discovery?.credentialRef).toBe('file:/tmp/teams-config/secrets/discovery.token')
    expect(resolved.discovery?.tlsTrustRef).toBe('file:/tmp/teams-config/certs/registry-ca.pem')
  })
})
