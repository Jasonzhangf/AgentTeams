import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { processAlive } from './local-ownership.ts'
import {
  RegistryProcessError,
  loadRegistryIntent,
  readRegistryState,
  registryStatePath,
  startRegistryDaemon,
  statusRegistryDaemon,
  stopRegistryDaemon,
  type RegistryDaemonStatus,
} from './registry-process.ts'

let directory: string
let credentialFile: string
const startedConfigs: string[] = []

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'teams-registry-process-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' })
  credentialFile = join(directory, 'credential.txt')
  writeFileSync(credentialFile, 'Bearer reasoner-a\n')
})
afterEach(async () => {
  // Explicit PID cleanup only; never a pattern kill.
  for (const configPath of startedConfigs.splice(0)) {
    try {
      await stopRegistryDaemon(configPath)
    } catch {
      try {
        const state = await readRegistryState(registryStatePath(await loadRegistryIntent(configPath)))
        if (state !== undefined && state.pid > 0 && processAlive(state.pid)) process.kill(state.pid, 'SIGTERM')
      } catch { /* no persisted process for this config */ }
    }
  }
})
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function freePort(): Promise<number> {
  return await new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once('error', rejectPort)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') { server.close(); rejectPort(new Error('no port')); return }
      const port = address.port
      server.close(() => resolvePort(port))
    })
  })
}

async function registryConfig(options: { port?: number; tls?: boolean; kind?: string } = {}): Promise<string> {
  const port = options.port ?? await freePort()
  const configPath = join(directory, `registry-${port}-${Math.random().toString(36).slice(2, 8)}.toml`)
  const tls = options.tls === false ? '' : `
tlsCertRef = "file:${join(directory, 'cert.pem')}"
tlsKeyRef = "file:${join(directory, 'key.pem')}"`
  writeFileSync(configPath, `version = 4

[daemon]
kind = "${options.kind ?? 'registry'}"
id = "lan-registry"
hostId = "registry-host"
accountId = "account"
scopeId = "scope"
dataDirectory = ${JSON.stringify(join(directory, `state-${port}`))}

[listen]
ip = "127.0.0.1"
port = ${port}${tls}

[[admissions]]
admissionRef = "reasoner-a"
agentId = "reasoner-a"
accountId = "account"
scopeId = "scope"
credentialRef = "file:${credentialFile}"
`)
  return configPath
}

function track(configPath: string): string {
  startedConfigs.push(configPath)
  return configPath
}

async function expectFault(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (error) {
    caught = error
  }
  expect(caught).toBeInstanceOf(RegistryProcessError)
  expect((caught as RegistryProcessError).code).toBe(code)
}

it('starts the production registry entry, reports it running and stops it by explicit pid', async () => {
  const configPath = track(await registryConfig())
  const started: RegistryDaemonStatus = await startRegistryDaemon(configPath)
  expect(started).toMatchObject({ state: 'running', daemonId: 'lan-registry', generation: 1 })
  expect(started.pid).toBeGreaterThan(0)
  expect(started.url).toMatch(/^wss:\/\/127\.0\.0\.1:\d+$/)
  expect(processAlive(started.pid!)).toBe(true)

  const status = await statusRegistryDaemon(configPath)
  expect(status).toEqual(started)

  const stopped = await stopRegistryDaemon(configPath, 1)
  expect(stopped.state).toBe('stopped')
  expect(processAlive(started.pid!)).toBe(false)
  expect((await statusRegistryDaemon(configPath)).state).toBe('stopped')
})

it('refuses a second start while the registry generation is alive', async () => {
  const configPath = track(await registryConfig())
  const started = await startRegistryDaemon(configPath)
  await expectFault(startRegistryDaemon(configPath), 'ALREADY_RUNNING')
  expect((await statusRegistryDaemon(configPath)).generation).toBe(started.generation)
})

it('refuses a stop from a stale generation without touching the live process', async () => {
  const configPath = track(await registryConfig())
  const started = await startRegistryDaemon(configPath)
  await expectFault(stopRegistryDaemon(configPath, 7), 'STALE_GENERATION')
  expect(processAlive(started.pid!)).toBe(true)
  expect((await stopRegistryDaemon(configPath, started.generation)).state).toBe('stopped')
})

it('fails an explicit registry listen without tlsCertRef and tlsKeyRef and never spawns', async () => {
  const configPath = track(await registryConfig({ tls: false }))
  await expect(startRegistryDaemon(configPath)).rejects.toThrowError(/openssl req -x509/)
  expect(await readRegistryState(registryStatePath(await loadRegistryIntent(configPath)))).toBeUndefined()
})

it('rejects a non-registry config as an unsupported registry configuration', async () => {
  const configPath = track(await registryConfig({ kind: 'agent' }))
  await expectFault(loadRegistryIntent(configPath), 'INVALID_CONFIG')
})

it('reports a persisted but dead pid as failed instead of running', async () => {
  const configPath = track(await registryConfig())
  const intent = await loadRegistryIntent(configPath)
  const statePath = registryStatePath(intent)
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify({
    version: 1, configPath, entryPath: join(directory, 'registry-process.js'), daemonId: 'lan-registry',
    startToken: 'dead-token', generation: 3, pid: 999_999, state: 'running',
    url: 'wss://127.0.0.1:1', updatedAt: new Date().toISOString(),
  })}\n`)
  expect(await statusRegistryDaemon(configPath)).toMatchObject({ state: 'failed', generation: 3, error: 'registry process pid is not alive' })
})
