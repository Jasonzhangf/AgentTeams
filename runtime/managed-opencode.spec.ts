import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startManagedOpenCode } from './managed-opencode.ts'

it('rejects child exit before readiness instead of reporting effective config', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-test-'))
  const executable = process.execPath
  await writeFile(join(directory, 'serve'), 'process.exit(17)\n')
  try {
    await expect(startManagedOpenCode({ executable, directory, port: 32145, startupTimeoutMs: 1000, stopTimeoutMs: 1000,
      compiled: { agentId: 'a', acceptedRevision: 1, primary: { provider: 'p', model: 'm', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1/v1' } },
      resolveCredential: async () => { throw new Error('no credential expected') } })).rejects.toThrow(/exited/)
  } finally { await rm(directory, { recursive: true }) }
})

it('reports startup deadline while child remains alive without readiness', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-test-'))
  const executable = join(directory, 'sleep')
  await writeFile(executable, '#!/bin/sh\nsleep 2\n'); await chmod(executable, 0o700)
  try {
    await expect(startManagedOpenCode({ executable, directory, port: 32146, startupTimeoutMs: 100, stopTimeoutMs: 1000,
      compiled: { agentId: 'a', acceptedRevision: 1, primary: { provider: 'p', model: 'm', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1/v1' } },
      resolveCredential: async () => { throw new Error('no credential expected') } })).rejects.toThrow(/startup deadline/)
  } finally { await rm(directory, { recursive: true }) }
})

it('preserves native ENOENT for a missing executable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-test-'))
  try {
    await expect(startManagedOpenCode({ executable: join(directory, 'missing'), directory, port: 32147, startupTimeoutMs: 1000, stopTimeoutMs: 1000,
      compiled: { agentId: 'a', acceptedRevision: 1, primary: { provider: 'p', model: 'm', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1/v1' } },
      resolveCredential: async () => { throw new Error('no credential expected') } })).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(directory, { recursive: true }) }
})

it('escalates so a substrate that ignores SIGTERM cannot hold stop open', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-test-'))
  // Stands in for a real managed OpenCode serve: it becomes ready, then ignores
  // SIGTERM and lives until the Agent's stop path forces it down.
  const executable = join(directory, 'stubborn.mjs')
  await writeFile(executable, [
    '#!/usr/bin/env node',
    "import { createServer } from 'node:http'",
    "process.on('SIGTERM', () => {})",
    "const port = Number(process.argv[process.argv.indexOf('--port') + 1])",
    "const password = process.env.OPENCODE_SERVER_PASSWORD",
    "const authorization = 'Basic ' + Buffer.from('teams:' + password).toString('base64')",
    "const config = { model: 'p/m', enabled_providers: ['p'], provider: JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).provider }",
    "const server = createServer((request, response) => {",
    "  if (request.headers.authorization !== authorization) { response.writeHead(401).end(); return }",
    "  response.writeHead(200, { 'content-type': 'application/json' })",
    "  response.end(JSON.stringify(request.url === '/global/health' ? { ok: true } : config))",
    "})",
    "server.listen(port, '127.0.0.1')",
  ].join('\n'))
  await chmod(executable, 0o700)
  const compiled = { agentId: 'a', acceptedRevision: 1, primary: { provider: 'p', model: 'm', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1/v1' } }
  const startedAt = Date.now()
  const handle = await startManagedOpenCode({ executable, directory, port: 32148, startupTimeoutMs: 4000, stopTimeoutMs: 2000,
    compiled, resolveCredential: async reference => `resolved:${reference}` })
  const pid = handle.pid
  try {
    await handle.stop()
    const elapsed = Date.now() - startedAt
    // The whole stop stays inside one stopTimeoutMs budget, so the Agent's own
    // teardown window still has room to observe the exit.
    expect(elapsed).toBeLessThan(4000)
    await expect(handle.closed).resolves.toMatchObject({ signal: 'SIGKILL' })
  } finally {
    try { process.kill(pid, 'SIGKILL') } catch { /* already reaped */ }
    await rm(directory, { recursive: true })
  }
  await expect(waitForProcessGone(pid)).resolves.toBe(true)
})

async function waitForProcessGone(pid: number, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { process.kill(pid, 0) } catch { return true }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  return false
}
