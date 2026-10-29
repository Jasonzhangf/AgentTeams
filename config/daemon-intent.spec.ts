import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  applyDaemonCliOverrides,
  compileDaemonIntent,
  createDaemonIntentContext,
  DaemonIntentError,
  parseDaemonConfigText,
  parseDaemonIntent,
  readDaemonEffectiveConfig,
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

function errorMessage(task: () => unknown): string {
  try {
    task()
  } catch (error) {
    if (error instanceof DaemonIntentError) return error.message
    throw error
  }
  throw new Error('expected DaemonIntentError')
}

const examplesDirectory = fileURLToPath(new URL('./examples/', import.meta.url))

function exampleFile(name: string): string {
  return readFileSync(new URL(`./examples/${name}`, import.meta.url), 'utf8')
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

  it('parses the optional [vikunja] section for an agent daemon only', () => {
    const absent = parseDaemonIntent(agentConfig) as AgentDaemonIntent
    expect(absent.vikunja).toBeUndefined()

    const withVikunja = parseDaemonIntent({
      ...agentConfig,
      vikunja: { baseUrl: 'https://vikunja.example.test/teams', tokenRef: 'env:VIKUNJA_TOKEN', projectId: '42' },
    }) as AgentDaemonIntent
    expect(withVikunja.vikunja).toEqual({
      baseUrl: 'https://vikunja.example.test/teams',
      tokenRef: 'env:VIKUNJA_TOKEN',
      projectId: '42',
    })

    // A control or registry daemon never accepts the agent-only section.
    expect(errorCode(() => parseDaemonIntent({ ...controlConfig, vikunja: { baseUrl: 'https://vikunja.example.test', tokenRef: 'env:T' } })))
      .toBe('INVALID_INPUT')
    // An inline secret is refused by the section owner, not silently kept.
    expect(errorCode(() => parseDaemonIntent({ ...agentConfig, vikunja: { baseUrl: 'https://vikunja.example.test', tokenRef: 'plain-token' } })))
      .toBe('INVALID_INPUT')
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

  it('rejects the legacy v3 multi-agent file with a migration reason', () => {
    const code = errorCode(() => parseDaemonIntent({ version: 3, bridge: { enabled: true }, agents: { provider: {} } }))
    expect(code).toBe('UNSUPPORTED_VERSION')
    expect(errorMessage(() => parseDaemonIntent({ version: 3, agents: {} }))).toContain('migrate to version 4')
    expect(errorCode(() => parseDaemonIntent({ version: 2, relay: {}, endpoints: {} }))).toBe('UNSUPPORTED_VERSION')
    expect(errorCode(() => parseDaemonIntent({ version: 5, daemon: agentConfig.daemon }))).toBe('UNSUPPORTED_VERSION')
  })

  it('accepts exactly one daemon per file and rejects closed-schema mismatches', () => {
    expect(errorCode(() => parseDaemonIntent({ version: 4, daemon: [] }))).toBe('UNSUPPORTED_CONFIGURATION')
    expect(errorMessage(() => parseDaemonIntent({ version: 4, daemon: [] }))).toContain('exactly one daemon')
    expect(errorCode(() => parseDaemonIntent({ version: 4, daemon: { kind: 'relay', id: 'x' } }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({ ...agentConfig, agents: {} }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({ ...controlConfig, engine: { kind: 'dsh' } }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({ ...registryConfig, relations: { allowed: ['peer'] } }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({ ...agentConfig, unknownField: true }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({ ...controlConfig, webui: undefined }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({ ...registryConfig, listen: undefined }))).toBe('INVALID_INPUT')
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
    expect(() => parseDaemonIntent({
      ...agentConfig,
      listen: { ip: '192.168.1.20', port: 7443, tlsCertRef: 'file:./cert.pem', tlsKeyRef: 'file:./key.pem' },
      admissions: [{
        admissionRef: 'peer-registration',
        agentId: 'peer-a',
        accountId: 'local',
        scopeId: 'local',
        credentialRef: 'env:TEAMS_PEER_A',
      }],
    })).not.toThrow()
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

  it('validates provider and model values through the canonical config rules', () => {
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      providers: { openai: { ...agentConfig.providers.openai, protocol: 'openai-legacy' } },
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      providers: { openai: { ...agentConfig.providers.openai, apiBaseUrl: 'https://user:secret@api.example.test/v1' } },
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      providers: { openai: { ...agentConfig.providers.openai, credentialEnv: 'not a name' } },
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      models: [{ provider: 'openai', id: 'gpt-4.1', tools: 'yes' }],
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      models: [{ provider: 'openai', id: 'gpt-4.1', contextWindow: 0 }],
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      models: [{ provider: 'openai', id: 'gpt-4.1', label: '' }],
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      models: [
        { provider: 'openai', id: 'gpt-4.1' },
        { provider: 'openai', id: 'gpt-4.1' },
      ],
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      model: {
        primary: { provider: 'openai', model: 'gpt-4.1' },
        backup: { provider: 'openai', model: 'gpt-4.1' },
      },
    }))).toBe('CONFLICT')
  })

  it('parses TOML text and rejects invalid TOML explicitly', () => {
    expect(parseDaemonConfigText(exampleFile('registry.toml')).daemon.kind).toBe('registry')
    expect(errorCode(() => parseDaemonConfigText('version = '))).toBe('INVALID_INPUT')
  })

  it('rejects the config directory or its parent as a daemon data directory', () => {
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      daemon: { ...agentConfig.daemon, dataDirectory: '.' },
    }))).toBe('INVALID_INPUT')
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      daemon: { ...agentConfig.daemon, dataDirectory: '..' },
    }))).toBe('INVALID_INPUT')
  })

  it('rejects self-referencing identities and duplicate peer or admission identities', () => {
    expect(errorCode(() => parseDaemonIntent({
      ...controlConfig,
      peers: {
        ...controlConfig.peers,
        self: {
          agentId: 'control-a',
          hostId: 'control-host',
          accountId: 'local',
          scopeId: 'local',
          credentialRef: 'env:TEAMS_CONTROL_SELF',
        },
      },
    }))).toBe('INVALID_INPUT')

    expect(errorCode(() => parseDaemonIntent({
      ...registryConfig,
      admissions: [
        ...registryConfig.admissions,
        {
          admissionRef: 'self-registration',
          agentId: 'lan-registry',
          accountId: 'local',
          scopeId: 'local',
          credentialRef: 'env:TEAMS_REGISTRY_SELF',
        },
      ],
    }))).toBe('INVALID_INPUT')

    expect(errorCode(() => parseDaemonIntent({
      ...controlConfig,
      peers: {
        first: { ...controlConfig.peers.reasoner },
        second: { ...controlConfig.peers.reasoner },
      },
    }))).toBe('INVALID_INPUT')

    expect(errorCode(() => parseDaemonIntent({
      ...registryConfig,
      admissions: [
        ...registryConfig.admissions,
        { ...registryConfig.admissions[0], admissionRef: 'reasoner-registration-2' },
      ],
    }))).toBe('INVALID_INPUT')
  })
})

describe('duplicate daemon ownership', () => {
  it('rejects a second daemon that reuses an identity, ownership, or data directory', () => {
    const context = createDaemonIntentContext()
    parseDaemonIntent(agentConfig, context)

    expect(errorCode(() => parseDaemonIntent(agentConfig, context))).toBe('CONFLICT')

    // Same host/account/scope with another id: two daemons would claim one machine identity.
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      daemon: { ...agentConfig.daemon, id: 'reasoner-b', dataDirectory: './state/reasoner-b' },
    }, context))).toBe('CONFLICT')

    // Same identity tuple with another data directory is still the same daemon.
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      daemon: { ...agentConfig.daemon, dataDirectory: './state/elsewhere' },
    }, context))).toBe('CONFLICT')

    // Another identity must not reuse the same data directory.
    expect(errorCode(() => parseDaemonIntent({
      ...agentConfig,
      daemon: { ...agentConfig.daemon, id: 'reasoner-c', scopeId: 'other' },
    }, context))).toBe('CONFLICT')

    // A fully distinct identity, ownership and storage still parses.
    expect(() => parseDaemonIntent({
      ...agentConfig,
      daemon: { ...agentConfig.daemon, id: 'reasoner-d', scopeId: 'other', dataDirectory: './state/reasoner-d' },
    }, context)).not.toThrow()
  })

  it('stays stateless when no shared context is given', () => {
    expect(() => parseDaemonIntent(agentConfig)).not.toThrow()
    expect(() => parseDaemonIntent(agentConfig)).not.toThrow()
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

  it('closes provider and model references with the canonical accepted-config rule', () => {
    const unknownProvider = parseDaemonIntent({
      ...agentConfig,
      model: { primary: { provider: 'missing', model: 'gpt-4.1' } },
    })
    expect(errorCode(() => compileDaemonIntent(unknownProvider, { configDirectory: '/tmp/teams-config' }))).toBe('NOT_FOUND')

    const undeclaredModel = parseDaemonIntent({
      ...agentConfig,
      model: { primary: { provider: 'openai', model: 'missing' } },
    })
    expect(errorCode(() => compileDaemonIntent(undeclaredModel, { configDirectory: '/tmp/teams-config' }))).toBe('NOT_FOUND')

    const undeclaredModelEntry = parseDaemonIntent({
      ...agentConfig,
      models: [{ provider: 'missing-provider', id: 'gpt-4.1' }],
      model: undefined,
    })
    expect(errorCode(() => compileDaemonIntent(undeclaredModelEntry, { configDirectory: '/tmp/teams-config' }))).toBe('NOT_FOUND')
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

describe('D00 example configs', () => {
  it('parses and compiles the three daemon kinds and both agent examples', () => {
    const opencode = parseDaemonConfigText(exampleFile('agent-opencode.toml'))
    const dsh = parseDaemonConfigText(exampleFile('agent-dsh.toml'))
    const control = parseDaemonConfigText(exampleFile('control.toml'))
    const registry = parseDaemonConfigText(exampleFile('registry.toml'))

    expect(opencode.daemon.kind).toBe('agent')
    expect(dsh.daemon.kind).toBe('agent')
    expect(control.daemon.kind).toBe('control')
    expect(registry.daemon.kind).toBe('registry')

    const compiledAgent = compileDaemonIntent(opencode, { configDirectory: examplesDirectory })
    expect(compiledAgent.agents['reasoner-a']).toEqual({
      primary: { providerInstanceId: 'rcc-4444', modelId: 'gpt-5.5' },
      backup: { providerInstanceId: 'rcc-4444', modelId: 'kk.glm-5.3-flash' },
    })
    expect(compileDaemonIntent(dsh, { configDirectory: examplesDirectory }).agents['reasoner-b']).toEqual({
      primary: { providerInstanceId: 'rcc-4444', modelId: 'gpt-5.5' },
    })
    expect(compileDaemonIntent(control, { configDirectory: examplesDirectory }).agents).toEqual({})
    expect(compileDaemonIntent(registry, { configDirectory: examplesDirectory }).providers).toEqual({})

    expect(readDaemonEffectiveConfig(control)).toEqual({
      kind: 'control',
      daemonId: 'control-a',
      dataDirectory: './state/control-a',
      listener: { ip: '127.0.0.1', port: 7331 },
    })
  })
})

describe('CLI precedence and effective readback', () => {
  it('lets explicit CLI values win over the file without mutating the input', () => {
    const intent = parseDaemonIntent(agentConfig) as AgentDaemonIntent
    const effective = applyDaemonCliOverrides(intent, { engine: 'dsh', ip: '127.0.0.1', port: 7551 }) as AgentDaemonIntent
    // Switching engine kind drops the OpenCode executable; the workspace directory survives.
    expect(effective.engine).toEqual({ kind: 'dsh', workspace: './workspace' })
    expect(effective.listen).toEqual({ ip: '127.0.0.1', port: 7551 })
    expect(readDaemonEffectiveConfig(effective)).toEqual({
      kind: 'agent',
      daemonId: 'reasoner-a',
      dataDirectory: './state/reasoner-a',
      engine: 'dsh',
      listener: { ip: '127.0.0.1', port: 7551 },
    })
    // The parsed config keeps its own values; readback can never show a stale file value.
    expect(intent.engine?.kind).toBe('opencode')
    expect(intent.listen?.port).toBe(7443)
  })

  it('keeps the configured executable only when --serve repeats the configured engine kind', () => {
    const intent = parseDaemonIntent(agentConfig) as AgentDaemonIntent
    const switched = applyDaemonCliOverrides(intent, { engine: 'dsh' }) as AgentDaemonIntent
    expect(switched.engine).toEqual({ kind: 'dsh', workspace: './workspace' })
    expect(switched.engine?.executable).toBeUndefined()

    const sameKind = applyDaemonCliOverrides(intent, { engine: 'opencode' }) as AgentDaemonIntent
    expect(sameKind.engine).toEqual({
      kind: 'opencode',
      executable: '/opt/homebrew/bin/opencode',
      workspace: './workspace',
    })
  })

  it('creates the listener for a quick-start override and re-checks listener policy', () => {
    const withoutListen = parseDaemonIntent({
      version: 4,
      daemon: agentConfig.daemon,
      engine: { kind: 'opencode' },
    }) as AgentDaemonIntent
    const effective = applyDaemonCliOverrides(withoutListen, { ip: '127.0.0.1', port: 7551 }) as AgentDaemonIntent
    expect(effective.listen).toEqual({ ip: '127.0.0.1', port: 7551 })

    expect(errorCode(() => applyDaemonCliOverrides(withoutListen, { ip: '192.168.1.20', port: 7551 }))).toBe('INVALID_INPUT')
    expect(errorCode(() => applyDaemonCliOverrides(withoutListen, { ip: '127.0.0.1' }))).toBe('INVALID_INPUT')
    expect(errorCode(() => applyDaemonCliOverrides(withoutListen, { port: 7551 }))).toBe('INVALID_INPUT')
    expect(errorCode(() => applyDaemonCliOverrides(withoutListen, { ip: 'localhost', port: 7551 }))).toBe('INVALID_INPUT')
  })

  it('rejects engine overrides on non-agent daemons and re-checks control webui policy', () => {
    const control = parseDaemonIntent(controlConfig)
    expect(errorCode(() => applyDaemonCliOverrides(control, { engine: 'dsh' }))).toBe('UNSUPPORTED_CONFIGURATION')
    const registry = parseDaemonIntent(registryConfig)
    expect(errorCode(() => applyDaemonCliOverrides(registry, { engine: 'opencode' }))).toBe('UNSUPPORTED_CONFIGURATION')

    const movedControl = applyDaemonCliOverrides(control, { ip: '127.0.0.1', port: 7332 })
    expect(readDaemonEffectiveConfig(movedControl).listener).toEqual({ ip: '127.0.0.1', port: 7332 })
    // Authenticated but without TLS: the override must not silently accept a plaintext LAN listener.
    expect(errorCode(() => applyDaemonCliOverrides(control, { ip: '192.168.1.10', port: 7332 }))).toBe('INVALID_INPUT')

    const unauthenticatedControl = parseDaemonIntent({
      ...controlConfig,
      webui: { ip: '127.0.0.1', port: 7331 },
    })
    expect(errorCode(() => applyDaemonCliOverrides(unauthenticatedControl, { ip: '192.168.1.10', port: 7332 })))
      .toBe('AUTHENTICATION_REQUIRED')

    const movedRegistry = applyDaemonCliOverrides(registry, { ip: '127.0.0.1', port: 7445 })
    expect(readDaemonEffectiveConfig(movedRegistry).listener).toEqual({ ip: '127.0.0.1', port: 7445 })
    expect(errorCode(() => applyDaemonCliOverrides(registry, { ip: '192.168.1.10', port: 7445 }))).toBe('INVALID_INPUT')
  })
})
