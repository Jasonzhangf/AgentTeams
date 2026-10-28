#!/usr/bin/env node
/**
 * P0 black-box driver: replace a real `agentteams --serve opencode` daemon on
 * the same data directory while another data directory keeps serving.
 *
 * It proves:
 *   1. the first real CLI daemon and its real OpenCode engine exit when the
 *      replacement starts on the same data directory;
 *   2. the replacement publishes the only state record and serves a real ACP
 *      initialize/session/prompt request;
 *   3. a second data directory's daemon and engine stay alive;
 *   4. explicit-PID stop releases the replacement's state record, engine home
 *      and engine child.
 *
 * Usage: node docs/evidence/daemon-single-instance-p0/black-box-serve-replacement.mjs
 * Env:   OPENCODE_EXECUTABLE (default /Users/fanzhang/.opencode/bin/opencode)
 *        AGENTTEAMS_CLI     run another copy of the entry
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection, createServer as createNetServer } from 'node:net'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const installedCli = process.env.AGENTTEAMS_CLI
const CLI = installedCli ?? join(repositoryRoot, 'cli', 'agentteams.mjs')
const CLI_ROOT = installedCli === undefined ? repositoryRoot : resolve(dirname(installedCli), '..')
const EXECUTABLE = process.env.OPENCODE_EXECUTABLE ?? '/Users/fanzhang/.opencode/bin/opencode'
const PROBE_CREDENTIAL = 'probe-secret-value'

function assert(condition, message) {
  if (!condition) throw new Error(`BLACK-BOX FAIL: ${message}`)
  console.log(`  ok: ${message}`)
}

function processRow(pid) {
  try {
    return execFileSync('ps', ['-o', 'pid=,ppid=,command=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

async function availableLoopbackPort() {
  const listener = createNetServer()
  await new Promise((resolveListen, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = listener.address()
  await new Promise(resolveClose => listener.close(() => resolveClose()))
  return address.port
}

function startStubProvider() {
  const calls = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      calls.push({ model: parsed.model ?? '' })
      const model = parsed.model ?? 'probe-model'
      const chunk = delta => `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      const finish = `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'PROBE-REPLY-OK' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(chunk({ role: 'assistant', content: 'PROBE-REPLY-OK' }))
      response.write(finish)
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise(resolveStart => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolveStart({
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        calls,
        close: () => new Promise(resolveClose => server.close(() => resolveClose())),
      })
    })
  })
}

function agentConfig({ agentId, baseUrl, port, dataDirectory, workspace }) {
  return `version = 4

[daemon]
kind = "agent"
id = ${JSON.stringify(agentId)}
hostId = "host-a"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(dataDirectory)}

[engine]
kind = "opencode"
executable = ${JSON.stringify(EXECUTABLE)}
workspace = ${JSON.stringify(workspace)}

[listen]
ip = "127.0.0.1"
port = ${port}

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = []
clientCapabilities = []
callbackExecutor = "controller"

[providers.probe]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(baseUrl)}
label = "Probe provider"
enabled = true
credentialEnv = "PROBE_API_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
`
}

/** Minimal ACP client: newline-delimited JSON-RPC over the entry's listener. */
function connectClient(port) {
  return new Promise((resolveConnect, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buffer = ''
    const frames = []
    const waiters = []
    socket.on('error', error => reject(error))
    socket.on('connect', () => resolveConnect({
      send: frame => new Promise(resolveSend => socket.write(`${JSON.stringify(frame)}\n`, resolveSend)),
      awaitFrame: (match, timeoutMs = 90_000) => new Promise((resolveFrame, rejectFrame) => {
        const deadline = setTimeout(() => rejectFrame(new Error('timed out waiting for an ACP frame')), timeoutMs)
        const check = () => {
          for (let index = 0; index < frames.length; index += 1) {
            if (match(frames[index])) {
              const [frame] = frames.splice(index, 1)
              clearTimeout(deadline)
              resolveFrame(frame)
              return true
            }
          }
          return false
        }
        if (check()) return
        waiters.push(check)
      }),
      close: () => new Promise(resolveClose => { socket.end(() => resolveClose()) }),
    }))
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim().length === 0) continue
        frames.push(JSON.parse(line))
        for (const check of [...waiters]) check()
      }
    })
  })
}

function parseReadyLine(line) {
  const fields = {}
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^=]*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/g)) {
    fields[match[1]] = match[2].trim()
  }
  return fields
}

function spawnEntry(configPath, port) {
  const state = { stdout: '', stderr: '' }
  const child = spawn(process.execPath, [CLI, '--serve', 'opencode', '--ip', '127.0.0.1', '--port', String(port), '--config', configPath], {
    cwd: CLI_ROOT,
    env: { ...process.env, PROBE_API_KEY: PROBE_CREDENTIAL },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', chunk => { state.stdout += chunk.toString('utf8') })
  child.stderr.on('data', chunk => { state.stderr += chunk.toString('utf8') })
  return { child, state }
}

async function waitForReady(entry, label) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const line = entry.state.stdout.split('\n').find(candidate => candidate.startsWith('serving '))
    if (line !== undefined) return line
    if (entry.child.exitCode !== null || entry.child.signalCode !== null) {
      throw new Error(`${label} exited before readiness: code=${entry.child.exitCode} signal=${entry.child.signalCode} stderr=${entry.state.stderr}`)
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 50))
  }
  throw new Error(`${label} never printed a readiness line: stderr=${entry.state.stderr}`)
}

async function startServe(configPath, port, label) {
  const entry = spawnEntry(configPath, port)
  const line = await waitForReady(entry, label)
  const fields = parseReadyLine(line)
  const daemonPid = Number(fields.daemonPid)
  const enginePid = Number(fields.enginePid)
  assert(entry.child.pid === daemonPid, `${label} reports the real CLI process pid`)
  assert(Number.isSafeInteger(enginePid) && enginePid > 0, `${label} reports a real engine pid`)
  assert(processRow(enginePid).includes('opencode'), `${label} engine ${enginePid} is a live opencode process`)
  return { ...entry, line, fields, daemonPid, enginePid }
}

function waitForExit(child, timeoutMs = 60_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode })
  }
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => reject(new Error(`pid ${child.pid} did not exit in ${timeoutMs}ms`)), timeoutMs)
    child.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }) })
  })
}

async function stopByPid(entry, label) {
  const exited = waitForExit(entry.child)
  process.kill(entry.daemonPid, 'SIGTERM')
  const exit = await exited
  const stopped = entry.state.stdout.split('\n').find(line => line.startsWith('stopped '))
  assert(stopped !== undefined, `${label} printed its stop receipt`)
  assert(/engine=exited/.test(stopped), `${label} confirmed the engine exited (${stopped})`)
  assert(exit.code === 0, `${label} exited cleanly`)
  return stopped
}

const directory = await mkdtemp(join(tmpdir(), 'p0-serve-replacement-'))
const provider = await startStubProvider()
const portA = await availableLoopbackPort()
const portB = await availableLoopbackPort()
const dataA = join(directory, 'state-a')
const dataB = join(directory, 'state-b')
const configA = join(directory, 'agent-a.toml')
const configB = join(directory, 'agent-b.toml')
await writeFile(configA, agentConfig({ agentId: 'reasoner-a', baseUrl: provider.baseUrl, port: portA, dataDirectory: dataA, workspace: join(directory, 'workspace-a') }))
await writeFile(configB, agentConfig({ agentId: 'reasoner-b', baseUrl: provider.baseUrl, port: portB, dataDirectory: dataB, workspace: join(directory, 'workspace-b') }))

console.log('# P0 real --serve replacement black-box')
console.log(`cli=${CLI}`)
console.log(`opencode=${EXECUTABLE}`)
console.log(`dataA=${dataA}`)
console.log(`dataB=${dataB}`)

let oldA
let newA
let otherB
let client
try {
  console.log('\n## first real instance on dataA')
  oldA = await startServe(configA, portA, 'old dataA')
  const oldState = JSON.parse(await readFile(join(dataA, 'agent-serve-state.json'), 'utf8'))
  assert(oldState.daemonPid === oldA.daemonPid && oldState.enginePid === oldA.enginePid, 'dataA state names the first daemon and engine')

  console.log('\n## second real instance on dataB')
  otherB = await startServe(configB, portB, 'dataB')
  const bState = JSON.parse(await readFile(join(dataB, 'agent-serve-state.json'), 'utf8'))
  assert(bState.daemonPid === otherB.daemonPid && bState.enginePid === otherB.enginePid, 'dataB state names its own daemon and engine')

  console.log('\n## replacement on dataA')
  const oldExit = waitForExit(oldA.child)
  newA = await startServe(configA, portA, 'replacement dataA')
  const oldReceipt = await oldExit
  assert(oldReceipt.code === 0, `the replaced dataA daemon exited cleanly (code=${oldReceipt.code} signal=${oldReceipt.signal})`)
  assert(processRow(oldA.enginePid).length === 0, `the replaced dataA engine ${oldA.enginePid} is gone`)
  assert(newA.daemonPid !== oldA.daemonPid, 'the replacement is a new daemon process')
  assert(newA.enginePid !== oldA.enginePid, 'the replacement is a new engine process')
  const newState = JSON.parse(await readFile(join(dataA, 'agent-serve-state.json'), 'utf8'))
  assert(newState.daemonPid === newA.daemonPid && newState.enginePid === newA.enginePid, 'dataA has exactly the replacement state record')
  assert(processRow(otherB.enginePid).length > 0, 'the other data directory engine is still alive')
  assert(otherB.child.exitCode === null && otherB.child.signalCode === null, 'the other data directory daemon is still alive')

  console.log('\n## real ACP request on the replacement')
  client = await connectClient(portA)
  await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
  const initialized = await client.awaitFrame(frame => frame.id === 'init-1')
  assert(initialized.result?.protocolVersion === 1, 'the replacement served a real initialize result')
  await client.send({ jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: directory, mcpServers: [] } })
  const session = await client.awaitFrame(frame => frame.id === 'new-1')
  const sessionId = session.result?.sessionId
  assert(typeof sessionId === 'string' && sessionId.length > 0, `the replacement created a real engine session (${sessionId})`)
  await client.send({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'replacement prompt' }] } })
  const prompted = await client.awaitFrame(frame => frame.id === 'prompt-1')
  assert(prompted.result?.stopReason === 'end_turn', `the replacement completed a real prompt (${prompted.result?.stopReason ?? JSON.stringify(prompted)})`)
  assert(provider.calls.some(call => call.model === 'probe-model'), 'the stub provider received the accepted model from the replacement')

  console.log('\n## explicit-PID stop and cleanup')
  const stoppedA = await stopByPid(newA, 'replacement dataA')
  assert(processRow(newA.enginePid).length === 0, 'the replacement engine is gone after stop')
  assert(!existsSync(join(dataA, 'agent-serve-state.json')), 'the replacement state record is gone after stop')
  assert(!existsSync(join(dataA, 'engine')), 'the replacement engine home is gone after stop')
  await stopByPid(otherB, 'dataB')
  assert(!existsSync(join(dataB, 'agent-serve-state.json')), 'the other data directory state record is gone after stop')
  assert(!existsSync(join(dataB, 'engine')), 'the other data directory engine home is gone after stop')

  console.log('\nBLACK-BOX PASS: real dataA replacement, real ACP prompt, other dataB alive, explicit-PID cleanup.')
  console.log(JSON.stringify({
    oldA: { daemonPid: oldA.daemonPid, enginePid: oldA.enginePid },
    newA: { daemonPid: newA.daemonPid, enginePid: newA.enginePid },
    otherB: { daemonPid: otherB.daemonPid, enginePid: otherB.enginePid },
    sessionId,
    providerCalls: provider.calls.length,
    stopA: stoppedA,
  }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  for (const [label, entry] of [['old dataA', oldA], ['replacement dataA', newA], ['dataB', otherB]]) {
    if (entry !== undefined) console.error(`--- ${label} stdout ---\n${entry.state.stdout}\n--- ${label} stderr ---\n${entry.state.stderr}`)
  }
  process.exitCode = 1
} finally {
  if (client !== undefined) await client.close().catch(() => undefined)
  await provider.close().catch(() => undefined)
  for (const entry of [newA, oldA, otherB]) {
    if (entry === undefined) continue
    if (entry.child.exitCode === null && entry.child.signalCode === null) {
      const exited = waitForExit(entry.child, 10_000).catch(() => undefined)
      entry.child.kill('SIGTERM')
      const gone = await Promise.race([exited, new Promise(resolveWait => setTimeout(() => resolveWait(false), 10_000))])
      if (gone === false && entry.child.exitCode === null && entry.child.signalCode === null) {
        entry.child.kill('SIGKILL')
        await waitForExit(entry.child, 10_000).catch(() => undefined)
      }
    }
    if (processRow(entry.enginePid).length > 0) {
      process.kill(entry.enginePid, 'SIGTERM')
      await new Promise(resolveWait => setTimeout(resolveWait, 1_000))
      if (processRow(entry.enginePid).length > 0) process.kill(entry.enginePid, 'SIGKILL')
    }
  }
  await rm(directory, { recursive: true, force: true }).catch(() => undefined)
}
