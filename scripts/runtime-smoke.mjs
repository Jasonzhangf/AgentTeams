import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRelayServer } from '../generated/modules/teams-source/lib/runtime/server/relay.js'
import { loginRelay } from '../generated/modules/teams-source/lib/runtime/network/relay-login.js'

// Exercise the packaged JS directly in Node, without TypeScript/test transforms.
const directory = mkdtempSync(join(tmpdir(), 'teams-runtime-smoke-'))
let relay
let client
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' })
  const cert = readFileSync(join(directory, 'cert.pem'))
  relay = await createRelayServer({ host: '127.0.0.1', port: 0,
    key: readFileSync(join(directory, 'key.pem')), cert,
    maxPayload: 65536, maxConnections: 4, maxGrants: 4, maxBufferedAmount: 65536,
    maxPendingMessages: 8, maxPendingBytes: 65536, grantTtlMs: 5000,
    authenticate: credential => credential === 'Bearer smoke-only'
      ? { accountId: 'smoke', scopeId: 'smoke', agentId: 'smoke' } : null,
  })
  client = await loginRelay({ transport: { endpoint: relay.url, credential: 'Bearer smoke-only', ca: cert,
    maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 8, connectTimeoutMs: 1000 },
    admissionTimeoutMs: 1000,
    declaration: { identity: { hostId: 'smoke', machineId: 'smoke', agentId: 'smoke', accountId: 'smoke', agentKind: 'custom', label: 'smoke' },
      scopeId: 'smoke', revision: 1, capabilities: [], routes: [] },
  })
  assert.equal(client.receipt.generation, 1)
  await client.transport.send({ bytes: Buffer.from(JSON.stringify({ kind: 'relay.directory', requestId: 'smoke-directory', subscribe: false })), binary: false })
  const response = JSON.parse((await client.transport.read()).bytes.toString())
  assert.equal(response.kind, 'relay.directory')
  assert.equal(response.requestId, 'smoke-directory')
  assert.equal(response.peers.length, 1)
  assert.equal(response.peers[0].declaration.identity.agentId, 'smoke')
  console.log('Packaged runtime smoke passed: verified TLS, real Relay admission and scoped directory. Local library evidence; no daemon deployment or NAT claim.')
} finally {
  try { await client?.transport.close() } finally {
    try { await relay?.close() } finally { rmSync(directory, { recursive: true, force: true }) }
  }
}
