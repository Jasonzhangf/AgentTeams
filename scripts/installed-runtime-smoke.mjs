import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, writeFileSync, cpSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = resolve(root, 'generated/modules/teams-source/lib')
const install = mkdtempSync(join(tmpdir(), 'agentteams-installed-'))
let relay
let agent
let relayOutput = ''
let agentOutput = ''

function run(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }))
      else resolvePromise({ stdout, stderr })
    })
  })
}

function waitForLine(child, output, pattern, timeoutMs = 5000) {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`process startup timeout: ${output()}`)), timeoutMs)
    const onData = chunk => {
      const match = pattern.exec(chunk.toString())
      if (match === null) return
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      resolvePromise(match)
    }
    child.stdout?.on('data', onData)
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`process exited before startup: ${output()}`)) })
    child.once('error', error => { clearTimeout(timer); reject(error) })
  })
}

async function stop(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill(signal)
  const [code, exitSignal] = await exited
  assert.equal(code, 0, `${signal} process exit: ${exitSignal}`)
}

try {
  cpSync(source, install, { recursive: true })
  await run('pnpm', ['install', '--prod'], { cwd: install, env: process.env })
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(install, 'relay-key.pem'), '-out', join(install, 'relay-cert.pem')], { stdio: 'ignore' })
  const relayConfig = join(install, 'relay.json')
  writeFileSync(relayConfig, JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 0 },
    tls: { keyFile: './relay-key.pem', certFile: './relay-cert.pem' },
    limits: { maxPayload: 65536, maxConnections: 8, maxGrants: 4, maxBufferedAmount: 65536, maxPendingMessages: 8, maxPendingBytes: 131072, grantTtlMs: 10000 },
    credentials: [{ credentialEnv: 'TEAMS_RELAY_AGENT', identity: { accountId: 'install-account', scopeId: 'install-scope', agentId: 'installed-agent' } }] }))
  relay = spawn(process.execPath, ['runtime/server/relay-process.js', '--config', relayConfig],
    { cwd: install, env: { ...process.env, TEAMS_RELAY_AGENT: 'Bearer install-agent' }, stdio: ['ignore', 'pipe', 'pipe'] })
  relay.stderr?.on('data', chunk => { relayOutput += chunk.toString() })
  relay.stdout?.on('data', chunk => { relayOutput += chunk.toString() })
  const address = (await waitForLine(relay, () => relayOutput, /relay listening (wss:\/\/127\.0\.0\.1:\d+)/))[1]
  const agentConfig = join(install, 'agent.json')
  mkdirSync(join(install, 'agent-files'), { recursive: true })
  writeFileSync(agentConfig, JSON.stringify({ version: 1,
    identity: { hostId: 'installed-host', machineId: 'installed-machine', agentId: 'installed-agent', accountId: 'install-account', agentKind: 'custom', label: 'Installed Agent' },
    scopeId: 'install-scope', dataDirectory: './agent-data', leasePort: 0, presenceIntervalMs: 1000,
    policy: { revision: 1, allowedConsumers: [], allowedManagers: [] },
    cli: { camoExecutable: '/missing/camo', searchExecutable: '/missing/rg', searchRoot: './agent-files', profilePrefix: 'teams-installed' },
    relay: { endpoint: address, credentialEnv: 'TEAMS_RELAY_AGENT', caFile: './relay-cert.pem', connectTimeoutMs: 1000, admissionTimeoutMs: 1000,
      requestTimeoutMs: 2000, maxMessageBytes: 65536, maxBufferedBytes: 65536, maxPendingFrames: 8, maxPendingRequests: 4, maxDataConnections: 4 } }))
  // An OS-selected lease port is not a stable identity binding; choose a free one explicitly.
  const leaseProbe = await run(process.execPath, ['-e', "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { cwd: install })
  const config = JSON.parse(readFileSync(agentConfig, 'utf8'))
  config.leasePort = Number(leaseProbe.stdout.trim())
  writeFileSync(agentConfig, JSON.stringify(config))
  agent = spawn(process.execPath, ['runtime/runtime/agent-process.js', '--config', agentConfig],
    { cwd: install, env: { ...process.env, TEAMS_RELAY_AGENT: 'Bearer install-agent' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  agent.stdout?.on('data', chunk => { agentOutput += chunk.toString() })
  agent.stderr?.on('data', chunk => { agentOutput += chunk.toString() })
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`agent startup timeout: ${agentOutput}`)), 5000)
    agent.once('message', message => {
      clearTimeout(timer)
      assert.deepEqual(message, { kind: 'daemon.registered', agentId: 'installed-agent', generation: 1 })
      resolvePromise()
    })
    agent.once('error', reject)
    agent.once('exit', () => reject(new Error(`agent exited before registration: ${agentOutput}`)))
  })
  await stop(agent, 'SIGTERM')
  agent = spawn(process.execPath, ['runtime/runtime/agent-process.js', '--config', agentConfig],
    { cwd: install, env: { ...process.env, TEAMS_RELAY_AGENT: 'Bearer install-agent' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  agent.stdout?.on('data', chunk => { agentOutput += chunk.toString() })
  agent.stderr?.on('data', chunk => { agentOutput += chunk.toString() })
  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new Error(`agent restart timeout: ${agentOutput}`)), 5000)
    agent.once('message', message => {
      clearTimeout(timer)
      assert.deepEqual(message, { kind: 'daemon.registered', agentId: 'installed-agent', generation: 2 })
      resolvePromise()
    })
    agent.once('error', reject)
    agent.once('exit', () => reject(new Error(`agent exited before restart registration: ${agentOutput}`)))
  })
  await stop(agent, 'SIGINT')
  await stop(relay, 'SIGTERM')
  assert.equal(relayOutput.includes('Bearer install-agent'), false)
  assert.equal(agentOutput.includes('Bearer install-agent'), false)
  console.log('Installed runtime smoke passed: isolated pnpm install, Relay and Agent startup, restart, and signal shutdown.')
} finally {
  if (agent) await stop(agent, 'SIGKILL').catch(() => undefined)
  if (relay) await stop(relay, 'SIGKILL').catch(() => undefined)
  rmSync(install, { recursive: true, force: true })
}
