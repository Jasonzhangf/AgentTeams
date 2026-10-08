import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { get as httpsGet } from 'node:https'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse as parseToml } from 'toml'
import { afterEach, describe, expect, it } from 'vitest'
import { createJsonFileConfigPersistence, createRuntimeConfigStore } from '../config/runtime-config.ts'
import { createRelayClient, type RelayClient } from '../network/relay-client.ts'
import { serveConsole } from '../network/console-channel.ts'
import { admitMachineSource, createTomlRuntimeConfigPersistence, serializeTomlDocument, writeLocalConfig } from '../runtime/local-config.ts'
import { startConsoleRuntime } from '../runtime/console-runtime.ts'
import { createConsoleConfigBinding } from '../runtime/console-config.ts'
import { createRelayServer } from '../server/relay.ts'
import {
  Bb10SourceError,
  agentPolicyRefusalExpectedRevision,
  bb10LaunchEnv,
  bb09ConfigText,
  bb09RefreshCompletion,
  canonicalSessionConfigText,
  cases,
  exitCode,
  parseArgs,
  parseCanonicalProviderSource,
  parseFlatSecretKey,
  parseRccServerSource,
  readAcceptedConfigRevision,
  readDeclaredSecretKey,
  redactCredential,
} from './blackbox-user-mvp.mjs'

const temporaryRoots: string[] = []

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bb10-spec-'))
  temporaryRoots.push(root)
  return root
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface HttpProjectionIdentity {
  readonly agentId: string
  readonly accountId: string
  readonly scopeId: string
}

function tlsMaterial(root: string): { readonly key: Buffer; readonly cert: Buffer } {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(root, 'key'), '-out', join(root, 'cert')], { stdio: 'ignore' })
  return { key: readFileSync(join(root, 'key')), cert: readFileSync(join(root, 'cert')) }
}

function projectionFixture(agentId: string) {
  return {
    version: 1 as const,
    agents: [],
    sessions: [],
    notifications: [],
    configs: [],
    works: [{
      agentId,
      workId: `work-${agentId}`,
      consumerAgentId: 'consumer',
      providerAgentId: agentId,
      capabilityId: 'file-search',
      capabilityVersion: '1',
      policyRevision: 1,
      state: 'accepted' as const,
    }],
    relations: [{
      agentId,
      consumerAgentId: 'consumer',
      providerAgentId: agentId,
      capabilityId: 'file-search',
      capabilityVersion: '1',
      relationPermission: 'granted' as const,
      workId: `work-${agentId}`,
    }],
  }
}

function httpsProjection(url: string, ca: Buffer): Promise<{ readonly status: number; readonly body: any }> {
  const authorization = `Basic ${Buffer.from('operator:test-secret').toString('base64')}`
  return new Promise((resolveResponse, reject) => {
    httpsGet(`${url}/api/v1/projection`, { ca, headers: { authorization } }, response => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { text += chunk })
      response.on('end', () => {
        let body: unknown
        try { body = JSON.parse(text) } catch { body = { raw: text } }
        resolveResponse({ status: response.statusCode ?? 0, body })
      })
    }).on('error', reject)
  })
}

async function runHttpProjectionCase(input: {
  readonly console: HttpProjectionIdentity
  readonly peers: readonly HttpProjectionIdentity[]
}): Promise<{ readonly response: { readonly status: number; readonly body: any }; readonly admitted: readonly string[] }> {
  const root = temporaryRoot()
  const tls = tlsMaterial(root)
  const identities = new Map([
    [input.console.agentId, input.console],
    ...input.peers.map(peer => [peer.agentId, peer] as const),
  ])
  let relay: Awaited<ReturnType<typeof createRelayServer>> | undefined
  let consoleRuntime: Awaited<ReturnType<typeof startConsoleRuntime>> | undefined
  const peers: { readonly client: RelayClient; readonly served: Promise<void>[] }[] = []
  try {
    relay = await createRelayServer({
      host: '127.0.0.1', port: 0, key: tls.key, cert: tls.cert,
      maxPayload: 65536, maxConnections: 16, maxGrants: 8, maxBufferedAmount: 65536,
      maxPendingMessages: 16, maxPendingBytes: 131072, grantTtlMs: 10000,
      authenticate: credential => {
        const token = credential?.startsWith('Bearer ') ? credential.slice(7) : undefined
        const identity = token === undefined ? undefined : identities.get(token)
        return identity === undefined ? null : { agentId: identity.agentId, accountId: identity.accountId, scopeId: identity.scopeId }
      },
    })

    for (const peer of input.peers) {
      let client: RelayClient | undefined
      const served: Promise<void>[] = []
      client = await createRelayClient({
        transport: { endpoint: relay.url, credential: `Bearer ${peer.agentId}`, ca: tls.cert,
          connectTimeoutMs: 1000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16 },
        admissionTimeoutMs: 1000, requestTimeoutMs: 1000, maxPendingRequests: 8, maxDataConnections: 8,
        declaration: {
          identity: { hostId: `${peer.agentId}-host`, machineId: `${peer.agentId}-machine`, agentId: peer.agentId,
            accountId: peer.accountId, agentKind: 'custom', label: `Peer ${peer.agentId}` },
          scopeId: peer.scopeId, revision: 1,
          capabilities: [{
            capabilityId: 'file-search', version: '1',
            operations: [{ operation: 'search', inputSchema: {}, outputSchema: {}, cancellation: 'unsupported' }],
            resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot', sharing: 'exclusive', allocationScope: 'request' }],
          }],
          routes: [],
        },
        onEvent: async event => {
          if (event.kind !== 'relay.offer') return
          const socket = await client!.openData(event.grant)
          const serving = serveConsole(socket, async request => {
            if (request.kind !== 'console.projection') {
              return { kind: 'console.result' as const, correlationId: request.correlationId,
                result: { ok: false as const, error: { code: 'UNSUPPORTED_OPERATION' as const, message: 'projection only' } } }
            }
            return { kind: 'console.projection.result' as const, correlationId: request.correlationId,
              projection: projectionFixture(peer.agentId) }
          }, 2000)
          void serving.catch(() => undefined)
          served.push(serving)
        },
      })
      const directory = await client.directory(false)
      expect(directory.find(row => row.declaration.identity.agentId === peer.agentId)?.presence).toBe('online')
      peers.push({ client, served })
    }

    consoleRuntime = await startConsoleRuntime({
      host: '127.0.0.1', port: 0, origin: 'https://127.0.0.1', username: 'operator', password: 'test-secret', tls,
      agentIds: [], sessionRequestTimeoutMs: 600_000,
      staticRoot: resolve('console-host/static'), uiRoot: resolve('ui/teams-console/lib'),
      daemon: {
        presenceIntervalMs: 1000,
        relay: {
          declaration: {
            identity: { hostId: 'console-host', machineId: 'console-machine', agentId: input.console.agentId,
              accountId: input.console.accountId, agentKind: 'custom', label: 'Console' },
            scopeId: input.console.scopeId, revision: 1, capabilities: [], routes: [],
          },
          transport: { endpoint: relay.url, credential: `Bearer ${input.console.agentId}`, ca: tls.cert,
            connectTimeoutMs: 1000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 16 },
          admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxPendingRequests: 4, maxDataConnections: 4,
        },
      },
    })

    const response = await httpsProjection(consoleRuntime.url, tls.cert)
    await Promise.all(peers.flatMap(peer => peer.served))
    return { response, admitted: input.peers.map(peer => peer.agentId) }
  } finally {
    if (consoleRuntime !== undefined) {
      await consoleRuntime.stop().catch(() => undefined)
      await consoleRuntime.closed.catch(() => undefined)
    }
    await Promise.all(peers.map(peer => peer.client.close().catch(() => undefined)))
    await relay?.close().catch(() => undefined)
    rmSync(root, { recursive: true, force: true })
  }
}

/** A declared canonical provider source. It carries no real credential. */
function canonicalSourceText(options: { entries?: string, providerId?: string, providerType?: string, withProvider?: boolean, withAuth?: boolean } = {}): string {
  const provider = options.withProvider === false ? '' : `[provider]
id = ${JSON.stringify(options.providerId ?? 'sample_openai')}
enabled = true
type = ${JSON.stringify(options.providerType ?? 'openai_chat')}
baseURL = "https://example.invalid/v1"
defaultModel = "sample-max"
`
  const entries = options.entries
    ?? 'entries = [{ alias = "key1", secretFile = "/tmp/bb10-spec-secret.conf", secretKey = "sample.key1" }]'
  const auth = options.withAuth === false ? '' : `
[provider.auth]
type = "apikey"
${entries}
`
  return `version = "2.0.0"

${provider}${auth}`
}

function rccSourceText(options: { server?: string } = {}): string {
  const server = options.server ?? `[servers.routecodex_v3_4444]
enabled = true
bind = "0.0.0.0"
port = 4444
endpoints = ["responses", "anthropic", "gemini", "openai_chat"]
expose_models = ["gpt-5.5"]
`
  return `version = "1.0.0"

${server}`
}

function expectSourceFailure(run: () => unknown, missingCapability: string): Bb10SourceError {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(Bb10SourceError)
    const failure = error as Bb10SourceError
    expect(failure.missingCapability).toBe(missingCapability)
    expect(failure.message.length).toBeGreaterThan(0)
    return failure
  }
  throw new Error('the source was accepted although it must fail')
}

describe('blackbox user MVP driver interface', () => {
  it('parses a case list and receipt path into the public runner contract', () => {
    const parsed = parseArgs(['--case', 'BB01,BB02', '--receipt', 'generated/u7-driver/receipt.json'])
    expect(parsed.caseIds).toEqual(['BB01', 'BB02'])
    expect(parsed.receiptPath.endsWith('/generated/u7-driver/receipt.json')).toBe(true)
    expect(parsed.command).toBe('run')
  })

  it('expands --case all to every registered case', () => {
    const parsed = parseArgs(['--case', 'all'])
    expect(parsed.caseIds).toHaveLength(14)
    expect(parsed.caseIds).toEqual(cases.map(item => item.id))
  })

  it('routes --help and --list without executing cases', () => {
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['--list']).command).toBe('list')
  })

  it('keeps every unverified case wired to an exact missing capability', () => {
    for (const item of cases.filter(candidate => candidate.implemented === false)) {
      expect(item.missingCapability).toMatch(/\S/u)
      expect(item.publicProbe === 'work' || item.publicProbe === 'status').toBe(true)
    }
  })

  it('exits non-zero with a distinct unverified code', () => {
    expect(exitCode.passed).toBe(0)
    expect(exitCode.failed).toBe(1)
    expect(exitCode.unverified).toBe(2)
    expect(exitCode.unverified).not.toBe(exitCode.failed)
  })
})

describe('BB10 declared provider sources', () => {
  it('derives the Teams provider facts from the declared canonical source', () => {
    const parsed = parseCanonicalProviderSource(canonicalSourceText(), 'declared.toml')
    expect(parsed.id).toBe('sample_openai')
    expect(parsed.instanceId).toBe('sample-openai')
    expect(parsed.protocol).toBe('openai-chat')
    expect(parsed.baseUrl).toBe('https://example.invalid/v1')
    expect(parsed.defaultModel).toBe('sample-max')
    expect(parsed.authAlias).toBe('key1')
    expect(parsed.secretKey).toBe('sample.key1')
    expect(parsed.secretFile).toBe('/tmp/bb10-spec-secret.conf')
  })

  it('rejects a canonical source without a provider, auth table, unique entry or key', () => {
    expectSourceFailure(() => parseCanonicalProviderSource(canonicalSourceText({ withProvider: false }), 'declared.toml'),
      'canonical provider source is unusable')
    expectSourceFailure(() => parseCanonicalProviderSource(canonicalSourceText({ withAuth: false }), 'declared.toml'),
      'canonical provider source is unusable')
    expectSourceFailure(() => parseCanonicalProviderSource(canonicalSourceText({ entries: 'entries = []' }), 'declared.toml'),
      'canonical credential entry is not unique')
    expectSourceFailure(() => parseCanonicalProviderSource(canonicalSourceText({
      entries: 'entries = [{ alias = "k1", secretFile = "/tmp/a", secretKey = "k1" }, { alias = "k2", secretFile = "/tmp/b", secretKey = "k2" }]',
    }), 'declared.toml'), 'canonical credential entry is not unique')
    expectSourceFailure(() => parseCanonicalProviderSource(canonicalSourceText({
      entries: 'entries = [{ alias = "k1", secretFile = "/tmp/a", secretKey = "" }]',
    }), 'declared.toml'), 'canonical provider source is unusable')
    expectSourceFailure(() => parseCanonicalProviderSource(canonicalSourceText({ providerType: 'unsupported' }), 'declared.toml'),
      'canonical provider protocol is unsupported')
  })

  it('derives the RCC provider endpoint from its declared server block', () => {
    const parsed = parseRccServerSource(rccSourceText(), 'rcc.toml', 'routecodex_v3_4444')
    expect(parsed.host).toBe('127.0.0.1')
    expect(parsed.port).toBe(4444)
    expect(parsed.protocol).toBe('openai-chat')
    expect(parsed.baseUrl).toBe('http://127.0.0.1:4444/v1')
  })

  it('rejects a missing, disabled, endpoint-less or port-less RCC server', () => {
    expectSourceFailure(() => parseRccServerSource(rccSourceText(), 'rcc.toml', 'absent_server'), 'rcc server source is unusable')
    expectSourceFailure(() => parseRccServerSource(rccSourceText({
      server: `[servers.routecodex_v3_4444]
enabled = false
bind = "0.0.0.0"
port = 4444
endpoints = ["openai_chat"]
`,
    }), 'rcc.toml', 'routecodex_v3_4444'), 'rcc server source is unusable')
    expectSourceFailure(() => parseRccServerSource(rccSourceText({
      server: `[servers.routecodex_v3_4444]
enabled = true
bind = "0.0.0.0"
port = 4444
endpoints = ["responses"]
`,
    }), 'rcc.toml', 'routecodex_v3_4444'), 'rcc server does not expose the openai_chat endpoint')
    expectSourceFailure(() => parseRccServerSource(rccSourceText({
      server: `[servers.routecodex_v3_4444]
enabled = true
bind = "0.0.0.0"
port = 0
endpoints = ["openai_chat"]
`,
    }), 'rcc.toml', 'routecodex_v3_4444'), 'rcc server source is unusable')
  })
})

describe('BB10 declared credential source', () => {
  it('reads the declared key from a flat name=value file and strips only outer quotes', () => {
    const text = `# comment line
sample.key1 = "value-one"

sample.other = plain-two
sample.quoted = 'value-three'
`
    expect(parseFlatSecretKey(text, 'sample.key1', 'secrets.conf')).toBe('value-one')
    expect(parseFlatSecretKey(text, 'sample.other', 'secrets.conf')).toBe('plain-two')
    expect(parseFlatSecretKey(text, 'sample.quoted', 'secrets.conf')).toBe('value-three')
  })

  it('rejects a missing key, an empty value, a duplicate key and a malformed line', () => {
    expectSourceFailure(() => parseFlatSecretKey('sample.key1 = v\n', 'absent.key', 'secrets.conf'),
      'canonical credential key is absent')
    expectSourceFailure(() => parseFlatSecretKey('sample.key1 =   \n', 'sample.key1', 'secrets.conf'),
      'canonical credential source is unusable')
    expectSourceFailure(() => parseFlatSecretKey('sample.key1 = a\nsample.key1 = b\n', 'sample.key1', 'secrets.conf'),
      'canonical credential source is unusable')
    expectSourceFailure(() => parseFlatSecretKey('not-a-pair\n', 'sample.key1', 'secrets.conf'),
      'canonical credential source is unusable')
  })

  it('never carries the raw credential line or value into a precondition failure', () => {
    const secretLine = 'sample.key1 = super-secret-sentinel-value'
    const failure = expectSourceFailure(() => parseFlatSecretKey(`${secretLine}\n`, 'absent.key', 'secrets.conf'),
      'canonical credential key is absent')
    const reported = `${failure.message} ${JSON.stringify(failure.detail)}`
    expect(reported).not.toContain('super-secret-sentinel-value')
    expect(reported).not.toContain(secretLine)
    expect(failure.detail).toEqual({ key: 'absent.key' })
  })

  it('reads the declared path and key of a changed declaration', () => {
    const root = temporaryRoot()
    const first = join(root, 'first.conf')
    const second = join(root, 'second.conf')
    writeFileSync(first, 'sample.key1 = first-value\n', { encoding: 'utf8', mode: 0o600 })
    writeFileSync(second, 'sample.key2 = second-value\n', { encoding: 'utf8', mode: 0o600 })
    expect(readDeclaredSecretKey(first, 'sample.key1')).toBe('first-value')
    expect(readDeclaredSecretKey(second, 'sample.key2')).toBe('second-value')
    expectSourceFailure(() => readDeclaredSecretKey(second, 'sample.key1'), 'canonical credential key is absent')
    expectSourceFailure(() => readDeclaredSecretKey(join(root, 'absent.conf'), 'sample.key1'),
      'canonical credential source is unusable')
  })
})

describe('BB10 isolated config and launch environment', () => {
  it('persists only the credential env name and the exact catalog model spellings', () => {
    const text = canonicalSessionConfigText({
      rccBaseUrl: 'http://127.0.0.1:4444/v1',
      canonicalBaseUrl: 'https://example.invalid/v1/',
      canonicalModel: 'sample-max',
    }, '/usr/bin/rg')
    expect(text).toContain('credentialEnv = "TEAMS_BB10_CANONICAL_API_KEY"')
    expect(text).toContain('provider = "rcc-4444"')
    expect(text).toContain('model = "goaichat_openai.qwen3.8-max"')
    expect(text).toContain('provider = "goaichat-openai"')
    expect(text).toContain('id = "sample-max"')
    expect(text).toContain('apiBaseUrl = "https://example.invalid/v1"')
    expect(text).toContain('searchExecutable = "/usr/bin/rg"')
    // The exact catalog token is persisted: no `/` <-> `.` rewrite.
    expect(text).not.toContain('goaichat_openai/qwen3.8-max')
    expect(text).not.toContain('goaichat.openai.qwen3.8-max')
  })

  it('passes the credential through one dedicated child env without mutating the fixture env', () => {
    const fixture = { env: { PATH: '/usr/bin', HOME: '/tmp/bb10-home' } }
    const launchEnv = bb10LaunchEnv(fixture, 'sentinel-value')
    expect(launchEnv.TEAMS_BB10_CANONICAL_API_KEY).toBe('sentinel-value')
    expect(launchEnv.PATH).toBe('/usr/bin')
    expect(fixture.env).toEqual({ PATH: '/usr/bin', HOME: '/tmp/bb10-home' })
    expect(Object.keys(launchEnv).sort()).toEqual(['HOME', 'PATH', 'TEAMS_BB10_CANONICAL_API_KEY'])
  })

  it('redacts a credential value and any userinfo form from recorded text', () => {
    const redacted = redactCredential('http://console:secret-value@127.0.0.1:9/ secret-value', ['secret-value'])
    expect(redacted).not.toContain('secret-value')
    expect(redacted).toBe('http://console:<redacted>@127.0.0.1:9/ <redacted>')
  })
})

describe('BB09 fixture identity domain', () => {
  // Contract: the BB09 fixture identity domain must equal the system-generated
  // Console domain. The Console identity is fixed to local/local --
  // runtime/local-config.ts:1285-1292 (CONSOLE_IDENTITY.accountId 'local') and
  // runtime/local-config.ts:1510 (scopeId 'local'). The relay directory is the
  // only filter point -- server/relay.ts:474 keeps a peer only when
  // peer.declaration.identity.accountId and peer.declaration.scopeId match the
  // connecting Console auth. A daemon in another account/scope is therefore
  // invisible to directory discovery, so the fixture must stay in the Console
  // domain. This guard parses the real TOML the driver emits with the same
  // parser the driver uses.
  it('keeps both BB09 daemons in the Console local/local domain and leaves static binding unset', () => {
    const build = (allowedManagers: string[]) => parseToml(bb09ConfigText({
      stubBaseUrl: 'http://127.0.0.1:1',
      searchExecutable: '/usr/bin/rg',
      allowedManagers,
    })) as Record<string, any>
    const main = build(['__console'])
    const refusal = build([])

    for (const agentId of ['bb-provider', 'bb-receiver']) {
      // Both daemons must share the system-generated Console identity domain;
      // a fabricated bb-account/bb-scope makes the relay return zero peers.
      expect(main.agents[agentId].identity.accountId).toBe('local')
      expect(main.agents[agentId].runtime.scopeId).toBe('local')
      // The identity domain is the only change: the daemon still declares the
      // __console manager and the refusal scenario still denies it.
      expect(main.agents[agentId].runtime.policy.allowedManagers).toEqual(['__console'])
      expect(refusal.agents[agentId].runtime.policy.allowedManagers).toEqual([])
    }
    // The agent ids (TOML table keys) are unchanged.
    expect(Object.keys(main.agents).sort()).toEqual(['bb-provider', 'bb-receiver'])

    // The main scenario must keep directory discovery: a static [console]
    // agentIds binding would bypass the relay filter and hide this bug.
    expect(main.console.enabled).toBe(true)
    expect(main.console.agentIds).toBeUndefined()
    // The refusal scenario also stays on directory discovery.
    expect(refusal.console.agentIds).toBeUndefined()
  })

  it('BB09 static fixture preserves explicit agentIds', () => {
    const build = (agentIds?: string[]) => parseToml(bb09ConfigText({
      stubBaseUrl: 'http://127.0.0.1:1',
      searchExecutable: '/usr/bin/rg',
      allowedManagers: ['__console'],
      ...(agentIds === undefined ? {} : { agentIds }),
    })) as Record<string, any>
    const explicit = build(['bb-provider', 'bb-receiver'])
    const defaultMain = build()

    expect(explicit.console.agentIds).toEqual(['bb-provider', 'bb-receiver'])
    for (const agentId of ['bb-provider', 'bb-receiver']) {
      expect(explicit.agents[agentId].identity.accountId).toBe('local')
      expect(explicit.agents[agentId].runtime.scopeId).toBe('local')
      expect(explicit.agents[agentId].runtime.policy.allowedManagers).toEqual(['__console'])
    }
    expect(defaultMain.console.agentIds).toBeUndefined()
  })
})

describe('BB09 HTTP projection admission', () => {
  it('BB09 HTTP projection account mismatch', async () => {
    const { response, admitted } = await runHttpProjectionCase({
      console: { agentId: 'console', accountId: 'account-a', scopeId: 'scope-a' },
      peers: [
        { agentId: 'peer-1', accountId: 'account-b', scopeId: 'scope-a' },
        { agentId: 'peer-2', accountId: 'account-b', scopeId: 'scope-a' },
      ],
    })

    expect(admitted).toEqual(['peer-1', 'peer-2'])
    expect(response.status).toBe(200)
    expect(response.body.agents).toEqual([])
    expect(response.body.agents.some((row: any) => row.agentId === 'peer-1' || row.agentId === 'peer-2')).toBe(false)
  })

  it('BB09 HTTP projection scope mismatch', async () => {
    const { response, admitted } = await runHttpProjectionCase({
      console: { agentId: 'console', accountId: 'account-a', scopeId: 'scope-a' },
      peers: [
        { agentId: 'peer-1', accountId: 'account-a', scopeId: 'scope-b' },
        { agentId: 'peer-2', accountId: 'account-a', scopeId: 'scope-b' },
      ],
    })

    expect(admitted).toEqual(['peer-1', 'peer-2'])
    expect(response.status).toBe(200)
    expect(response.body.agents).toEqual([])
    expect(response.body.agents.some((row: any) => row.agentId === 'peer-1' || row.agentId === 'peer-2')).toBe(false)
  })

  it('BB09 HTTP projection same domain', async () => {
    const { response, admitted } = await runHttpProjectionCase({
      console: { agentId: 'console', accountId: 'account-a', scopeId: 'scope-a' },
      peers: [
        { agentId: 'peer-1', accountId: 'account-a', scopeId: 'scope-a' },
        { agentId: 'peer-2', accountId: 'account-a', scopeId: 'scope-a' },
      ],
    })

    expect(admitted).toEqual(['peer-1', 'peer-2'])
    expect(response.status).toBe(200)
    const agentIds = response.body.agents.map((row: any) => row.agentId).sort()
    expect(agentIds).toEqual(['peer-1', 'peer-2'])
    expect(agentIds).not.toContain('console')
    expect(response.body.works.map((row: any) => row.workId).sort()).toEqual(['work-peer-1', 'work-peer-2'])
  })
})

describe('BB09 accepted config revision preconditions', () => {
  const agentId = 'bb-provider'
  const configText = 'version = 3\n\n[bridge]\nenabled = true\n'

  it('reads a missing durable slice as undefined while the real TOML view starts at revision 0 without creating a slice', async () => {
    const root = temporaryRoot()
    const configPath = join(root, 'config.toml')
    const internalPath = join(root, 'internal.toml')
    await writeLocalConfig(configPath, configText)
    await admitMachineSource(internalPath, configText)
    const beforeText = readFileSync(internalPath, 'utf8')

    const persistence = createTomlRuntimeConfigPersistence({ configPath, internalPath, agentId })
    const view = await persistence.loadDaemonUnlocked(agentId)
    expect(view.acceptedRevision).toBe(0)
    expect(readAcceptedConfigRevision(internalPath, agentId)).toBeUndefined()

    expect(readFileSync(internalPath, 'utf8')).toBe(beforeText)
    const durable = parseToml(readFileSync(internalPath, 'utf8')) as any
    expect(durable.configRuntime?.accepted?.[agentId]).toBeUndefined()
  })

  it('keeps a durable revision 0 distinct from a missing accepted slice', async () => {
    const root = temporaryRoot()
    const configPath = join(root, 'config.toml')
    const internalPath = join(root, 'internal.toml')
    await writeLocalConfig(configPath, configText)
    writeFileSync(internalPath, serializeTomlDocument({
      version: 2,
      configRuntime: {
        accepted: {
          [agentId]: {
            acceptedRevision: 0,
            acceptedSourceRevision: 0,
            acceptedSourceHash: 'sha256:test',
          },
        },
      },
    }))

    const persistence = createTomlRuntimeConfigPersistence({ configPath, internalPath, agentId })
    const view = await persistence.loadDaemonUnlocked(agentId)
    expect(view.acceptedRevision).toBe(0)
    expect(readAcceptedConfigRevision(internalPath, agentId)).toBe(0)
  })

  it.each([
    ['missing', undefined],
    ['non-number', 'zero'],
    ['fractional', 1.5],
  ])('rejects a durable accepted slice with %s acceptedRevision', (_, acceptedRevision) => {
    const root = temporaryRoot()
    const internalPath = join(root, 'internal.toml')
    const slice: Record<string, unknown> = { acceptedSourceRevision: 0, acceptedSourceHash: 'sha256:test' }
    if (acceptedRevision !== undefined) slice.acceptedRevision = acceptedRevision
    writeFileSync(internalPath, serializeTomlDocument({
      version: 2,
      configRuntime: { accepted: { [agentId]: slice } },
    }))

    expect(() => readAcceptedConfigRevision(internalPath, agentId)).toThrow(/acceptedRevision/)
  })

  it('fails explicitly when the durable store cannot be read or parsed', () => {
    const root = temporaryRoot()
    const missingPath = join(root, 'missing.toml')
    const malformedPath = join(root, 'malformed.toml')
    writeFileSync(malformedPath, 'not = [')

    expect(() => readAcceptedConfigRevision(missingPath, agentId)).toThrow(/could not be read/)
    expect(() => readAcceptedConfigRevision(malformedPath, agentId)).toThrow(/valid TOML/)
  })

  it('resolves the production refusal precondition from a missing slice or revision 0 and rejects an advanced revision', () => {
    expect(agentPolicyRefusalExpectedRevision(undefined)).toBe(0)
    expect(agentPolicyRefusalExpectedRevision(0)).toBe(0)
    expect(() => agentPolicyRefusalExpectedRevision(1)).toThrow(/already has an accepted config revision/)
  })
})

describe('BB09 config operation semantics', () => {
  it('does not treat a visible model as refresh completion while the action is still busy', () => {
    const busy = {
      selectedAgent: 'bb-provider',
      models: ['', 'bb-console-model'],
      liveRegion: 'Refresh models…',
      liveRegionIsError: false,
      refreshDisabled: true,
    }
    expect(bb09RefreshCompletion(busy)).toBe(false)
    expect(bb09RefreshCompletion({ ...busy, liveRegion: 'Refresh models: accepted by Agent', refreshDisabled: false })).toBe(true)
    expect(bb09RefreshCompletion({ ...busy, liveRegion: 'Refresh models: accepted by Agent' })).toBe(false)
    expect(bb09RefreshCompletion({ ...busy, liveRegion: 'Refresh models: host unavailable', refreshDisabled: false, liveRegionIsError: true })).toBe(false)
    expect(bb09RefreshCompletion({ ...busy, selectedAgent: 'bb-receiver', liveRegion: 'Refresh models: accepted by Agent', refreshDisabled: false })).toBe(false)
  })

  it('uses a real accepting bindModel operation after refresh stays observation-only', async () => {
    const root = temporaryRoot()
    const agentId = 'bb-provider'
    const providerId = 'bb-console-stub'
    const modelId = 'bb-console-model'
    const store = createRuntimeConfigStore(createJsonFileConfigPersistence(join(root, 'config.json')))
    const binding = createConsoleConfigBinding({
      agentId,
      store,
      models: { listModels: async () => [{ modelId, metadata: {} }] },
      applier: { apply: async request => ({ status: 'applied', effectiveRevision: request.config.acceptedRevision }) },
    })

    await binding.command({
      kind: 'config.putProvider', agentId, expectedRevision: 0,
      provider: {
        id: providerId, label: 'BB09 Console Stub', protocol: 'openai-chat',
        apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true, auth: { kind: 'none' },
      },
    })
    const acceptedBeforeRefresh = (await store.read()).acceptedRevision
    expect(acceptedBeforeRefresh).toBe(1)

    await expect(binding.command({
      kind: 'config.refreshModels', agentId, expectedRevision: acceptedBeforeRefresh, providerId,
    })).resolves.toEqual({ ok: true })
    expect((await store.read()).acceptedRevision).toBe(acceptedBeforeRefresh)

    await expect(binding.command({
      kind: 'config.bindModel', agentId, expectedRevision: acceptedBeforeRefresh, providerId, modelId,
    })).resolves.toEqual({ ok: true })
    const acceptedAfterBind = await store.read()
    expect(acceptedAfterBind.acceptedRevision).toBe(acceptedBeforeRefresh + 1)
    expect(acceptedAfterBind.agents[agentId].primary).toEqual({ providerInstanceId: providerId, modelId })
  })
})

describe('BB10 config operation semantics', () => {
  it('switches canonical primary first and keeps the original RCC primary as a distinct backup', async () => {
    const root = temporaryRoot()
    const agentId = 'bb-provider'
    const canonical = { providerInstanceId: 'goaichat-openai', modelId: 'qwen3.8-max' }
    const rcc = { providerInstanceId: 'rcc-4444', modelId: 'goaichat_openai.qwen3.8-max' }
    const store = createRuntimeConfigStore(createJsonFileConfigPersistence(join(root, 'config.json')))
    const binding = createConsoleConfigBinding({
      agentId,
      store,
      models: { listModels: async ({ provider }) => provider.id === canonical.providerInstanceId
        ? [{ modelId: canonical.modelId, metadata: {} }]
        : [{ modelId: rcc.modelId, metadata: {} }] },
      applier: { apply: async request => ({ status: 'applied', effectiveRevision: request.config.acceptedRevision }) },
    })

    await binding.command({ kind: 'config.putProvider', agentId, expectedRevision: 0, provider: {
      id: rcc.providerInstanceId, label: 'RCC 4444', protocol: 'openai-chat',
      apiBaseUrl: 'http://127.0.0.1:4444/v1', enabled: true, auth: { kind: 'none' },
    } })
    await binding.command({ kind: 'config.putProvider', agentId, expectedRevision: 1, provider: {
      id: canonical.providerInstanceId, label: 'GoAIChat OpenAI', protocol: 'openai-chat',
      apiBaseUrl: 'https://example.test/v1', enabled: true, auth: { kind: 'none' },
    } })
    await binding.command({ kind: 'config.refreshModels', agentId, expectedRevision: 2, providerId: rcc.providerInstanceId })
    await binding.command({ kind: 'config.refreshModels', agentId, expectedRevision: 2, providerId: canonical.providerInstanceId })
    await binding.command({ kind: 'config.bindModel', agentId, expectedRevision: 2,
      providerId: rcc.providerInstanceId, modelId: rcc.modelId })

    const before = await store.read()
    expect(before.acceptedRevision).toBe(3)
    expect(before.agents[agentId]).toEqual({ primary: rcc })

    await expect(binding.command({ kind: 'config.bindModel', agentId, expectedRevision: before.acceptedRevision,
      providerId: canonical.providerInstanceId, modelId: canonical.modelId })).resolves.toEqual({ ok: true })
    const primarySwitched = await store.read()
    expect(primarySwitched.acceptedRevision).toBe(before.acceptedRevision + 1)
    expect(primarySwitched.agents[agentId]).toEqual({ primary: canonical })

    await expect(binding.command({ kind: 'config.agent.select-backup', agentId,
      expectedRevision: before.acceptedRevision + 1, backup: rcc })).resolves.toEqual({ ok: true })
    const final = await store.read()
    expect(final.acceptedRevision).toBe(before.acceptedRevision + 2)
    expect(final.agents[agentId]).toEqual({ primary: canonical, backup: rcc })
    expect(final.agents[agentId].backup).not.toEqual(final.agents[agentId].primary)
  })
})
