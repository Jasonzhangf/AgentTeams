import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  parseDaemonConfigText,
  resolveDaemonIntent,
  type RegistryDaemonIntent,
} from '../config/daemon-intent.ts'
import {
  REGISTRY_SERVER_DEFAULTS,
  REGISTRY_TLS_OPENSSL_COMMAND,
  RegistryIntentFault,
  createRegistryRelayOptions,
  loadRegistryCredentials,
  resolveRegistryServerPlan,
} from './registry-intent.ts'

let directory: string
let credentialFile: string

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-registry-intent-'))
  credentialFile = join(directory, 'reasoner-a.cred')
  writeFileSync(credentialFile, 'Bearer registry-secret-a\n')
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

function registryIntent(overrides: { readonly tls?: boolean; readonly admissions?: string } = {}): RegistryDaemonIntent {
  const tls = overrides.tls === false
    ? ''
    : 'tlsCertRef = "file:./certs/registry-cert.pem"\ntlsKeyRef = "file:./certs/registry-key.pem"\n'
  const admissions = overrides.admissions ?? `
[[admissions]]
admissionRef = "reasoner-a-registration"
agentId = "reasoner-a"
accountId = "local"
scopeId = "local"
credentialRef = "env:TEAMS_REGISTRY_REASONER_A"

[[admissions]]
admissionRef = "control-a-registration"
agentId = "control-a"
accountId = "local"
scopeId = "local"
credentialRef = "file:./reasoner-a.cred"
`
  const text = `version = 4

[daemon]
kind = "registry"
id = "lan-registry"
hostId = "registry-host"
accountId = "local"
scopeId = "local"
dataDirectory = "./state/lan-registry"

[listen]
ip = "127.0.0.1"
port = 7444
${tls}${admissions}`
  return resolveDaemonIntent(parseDaemonConfigText(text), { configDirectory: directory }) as RegistryDaemonIntent
}

describe('D04 registry intent mapping', () => {
  it('maps a resolved registry intent onto the Relay server plan without a second config source', () => {
    const plan = resolveRegistryServerPlan(registryIntent())
    expect(plan).toMatchObject({
      implementation: 'server/Relay',
      host: '127.0.0.1',
      port: 7444,
      tls: {
        certFile: join(directory, 'certs/registry-cert.pem'),
        keyFile: join(directory, 'certs/registry-key.pem'),
      },
      limits: REGISTRY_SERVER_DEFAULTS,
    })
    expect(plan.credentials.map(binding => [binding.admissionRef, binding.identity])).toEqual([
      ['reasoner-a-registration', { accountId: 'local', scopeId: 'local', agentId: 'reasoner-a' }],
      ['control-a-registration', { accountId: 'local', scopeId: 'local', agentId: 'control-a' }],
    ])
  })

  it('fails a loopback registry without explicit TLS refs and documents the openssl command', () => {
    let fault: unknown
    try {
      resolveRegistryServerPlan(registryIntent({ tls: false }))
    } catch (error) {
      fault = error
    }
    expect(fault).toBeInstanceOf(RegistryIntentFault)
    expect(fault).toMatchObject({ code: 'TLS_REQUIRED' })
    const message = (fault as Error).message
    expect(message).toContain('tlsCertRef')
    expect(message).toContain('tlsKeyRef')
    expect(message).toContain(REGISTRY_TLS_OPENSSL_COMMAND)
    expect(REGISTRY_TLS_OPENSSL_COMMAND).toContain('openssl req -x509')
  })

  it('rejects a non-registry daemon intent as an unsupported configuration', () => {
    const agent = resolveDaemonIntent(parseDaemonConfigText(`version = 4

[daemon]
kind = "agent"
id = "reasoner-a"
hostId = "host-a"
accountId = "local"
scopeId = "local"
dataDirectory = "./state/reasoner-a"
`), { configDirectory: directory })
    let fault: unknown
    try {
      resolveRegistryServerPlan(agent as RegistryDaemonIntent)
    } catch (error) {
      fault = error
    }
    expect(fault).toMatchObject({ code: 'UNSUPPORTED_CONFIGURATION' })
  })

  it('resolves env and file credentials, rejects missing ones, and keeps every value out of the plan', async () => {
    const plan = resolveRegistryServerPlan(registryIntent())
    expect(JSON.stringify(plan)).not.toContain('registry-secret-a')
    const credentials = await loadRegistryCredentials(plan, { env: { TEAMS_REGISTRY_REASONER_A: 'Bearer registry-secret-env' } })
    expect([...credentials.entries()]).toEqual([
      ['Bearer registry-secret-env', { accountId: 'local', scopeId: 'local', agentId: 'reasoner-a' }],
      ['Bearer registry-secret-a', { accountId: 'local', scopeId: 'local', agentId: 'control-a' }],
    ])

    await expect(loadRegistryCredentials(plan, { env: {} })).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
  })

  it('builds relay options that authenticate only the admitted credentials', async () => {
    const plan = resolveRegistryServerPlan(registryIntent())
    const credentials = await loadRegistryCredentials(plan, { env: { TEAMS_REGISTRY_REASONER_A: 'Bearer registry-secret-env' } })
    const options = createRegistryRelayOptions(plan, {
      credentials,
      tls: { key: Buffer.from('key'), cert: Buffer.from('cert') },
    })
    expect(options).toMatchObject({ host: '127.0.0.1', port: 7444, ...REGISTRY_SERVER_DEFAULTS })
    expect(options.authenticate('Bearer registry-secret-env')).toEqual({ accountId: 'local', scopeId: 'local', agentId: 'reasoner-a' })
    expect(options.authenticate('Bearer unknown')).toBeNull()
    expect(options.authenticate(undefined)).toBeNull()
  })
})
