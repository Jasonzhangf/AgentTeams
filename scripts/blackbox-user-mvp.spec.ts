import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse as parseToml } from 'toml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  Bb10SourceError,
  bb10LaunchEnv,
  bb09ConfigText,
  canonicalSessionConfigText,
  cases,
  exitCode,
  parseArgs,
  parseCanonicalProviderSource,
  parseFlatSecretKey,
  parseRccServerSource,
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
})
