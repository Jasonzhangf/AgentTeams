import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { get } from 'node:https'
import { createServer } from 'node:net'
import { expect, it } from 'vitest'
import { createRelayServer } from '../server/relay.ts'
import { startConsoleRuntime } from './console-runtime.ts'
import { loadConsoleProcessConfig } from './console-process.ts'

it('owns an authenticated HTTPS listener and releases its relay registration on stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'teams-console-runtime-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'key'), '-out', join(dir, 'cert')], { stdio: 'ignore' })
  const tls = { key: readFileSync(join(dir, 'key')), cert: readFileSync(join(dir, 'cert')) }
  const relay = await createRelayServer({ host: '127.0.0.1', port: 0, ...tls, maxPayload: 65536, maxConnections: 8, maxGrants: 4,
    maxBufferedAmount: 65536, maxPendingMessages: 8, maxPendingBytes: 131072, grantTtlMs: 5000,
    authenticate: value => value === 'Bearer console' ? { accountId: 'account', scopeId: 'scope', agentId: 'console' } : null })
  let consoleRuntime: Awaited<ReturnType<typeof startConsoleRuntime>> | undefined
  try {
    const options = { host: '127.0.0.1', port: 0, origin: 'https://127.0.0.1', username: 'operator', password: 'test-secret', tls,
      agentIds: [], staticRoot: resolve('console-host/static'), uiRoot: resolve('ui/teams-console/lib'),
      daemon: { presenceIntervalMs: 1000, relay: { declaration: { identity: { hostId: 'console', machineId: 'test', agentId: 'console', accountId: 'account', agentKind: 'custom' as const, label: 'Console' }, scopeId: 'scope', revision: 1, capabilities: [], routes: [] },
        transport: { endpoint: relay.url, credential: 'Bearer console', ca: tls.cert, connectTimeoutMs: 1000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 8 },
        admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxPendingRequests: 4, maxDataConnections: 4 } } }
    consoleRuntime = await startConsoleRuntime(options)
    const request = (authorization?: string) => new Promise<{ status: number; text: string }>((resolve, reject) => {
      get(consoleRuntime!.url + '/api/v1/projection', { ca: tls.cert, headers: authorization ? { authorization } : {} }, response => {
        let text = ''; response.on('data', chunk => { text += chunk }); response.on('end', () => resolve({ status: response.statusCode!, text }))
      }).on('error', reject)
    })
    expect((await request()).status).toBe(401)
    const response = await request(`Basic ${Buffer.from('operator:test-secret').toString('base64')}`)
    expect(response.status).toBe(200)
    expect(JSON.parse(response.text)).toMatchObject({ version: 1, agents: [] })
    await consoleRuntime.stop()
    await consoleRuntime.closed
    await expect(request()).rejects.toThrow()
    const occupied = createServer()
    await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve))
    try {
      await expect(startConsoleRuntime({ ...options, port: (occupied.address() as { port: number }).port })).rejects.toMatchObject({ code: 'EADDRINUSE' })
    } finally { await new Promise<void>(resolve => occupied.close(() => resolve())) }
    // Reusing the exact identity proves that the previous live registration was released.
    consoleRuntime = await startConsoleRuntime(options)
    await consoleRuntime.stop()
    const configuration = { version: 1, identity: options.daemon.relay.declaration.identity, scopeId: 'scope', presenceIntervalMs: 1000,
      agentIds: [], listen: { host: options.host, port: 0, origin: options.origin, certFile: './cert', keyFile: './key' },
      auth: { username: 'operator', passwordEnv: 'TEAMS_CONSOLE_TEST_PASSWORD' }, staticRoot: options.staticRoot, uiRoot: options.uiRoot,
      relay: { endpoint: relay.url, credentialEnv: 'TEAMS_CONSOLE_TEST_RELAY', caFile: './cert', connectTimeoutMs: 1000,
        admissionTimeoutMs: 1000, requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 8, maxPendingRequests: 4, maxDataConnections: 4 } }
    const path = join(dir, 'console.json')
    writeFileSync(path, JSON.stringify(configuration))
    const env = { ...process.env, TEAMS_CONSOLE_TEST_PASSWORD: 'test-secret', TEAMS_CONSOLE_TEST_RELAY: 'Bearer console' }
    await expect(loadConsoleProcessConfig(path, {})).rejects.toThrow(/credential/)
    expect((await loadConsoleProcessConfig(path, env)).tls?.cert).toEqual(tls.cert)
    const child = spawn(process.execPath, ['--experimental-transform-types', resolve('runtime/console-process.ts'), '--config', path], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    let output = ''
    child.stderr!.on('data', chunk => { output += chunk })
    const exit = once(child, 'exit')
    try {
      const ready = await new Promise<{ kind: string; url: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Console child startup deadline')), 3000)
        child.once('message', message => { clearTimeout(timer); resolve(message as { kind: string; url: string }) })
        child.once('exit', () => { clearTimeout(timer); reject(new Error('Console child exited before ready')) })
        child.once('error', error => { clearTimeout(timer); reject(error) })
      })
      expect(ready.kind).toBe('console.listening')
      const status = await new Promise<number>((resolve, reject) => {
        get(ready.url, { ca: tls.cert, headers: { authorization: `Basic ${Buffer.from('operator:test-secret').toString('base64')}` } }, response => {
          response.resume(); response.on('end', () => resolve(response.statusCode!))
        }).on('error', reject)
      })
      expect(status).toBe(200)
      child.kill('SIGTERM')
      expect((await exit)[0]).toBe(0)
      expect(output).not.toContain('test-secret')
      expect(output).not.toContain('Bearer console')
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit }
    }
  } finally { await consoleRuntime?.stop(); await relay.close(); rmSync(dir, { recursive: true }) }
}, 10000)
