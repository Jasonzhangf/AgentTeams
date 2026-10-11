#!/usr/bin/env node
/**
 * D02 black-box driver: the real `agentteams --serve opencode` user entry.
 *
 * It runs the installed CLI as a real child process against a v4 agent config
 * whose provider is a local OpenAI-compatible stub, then proves:
 *   1. exactly one agent daemon and exactly one OpenCode engine child exist;
 *   2. the entry's readiness line reports the accepted model verified from the
 *      engine's own session/new;
 *   3. a real prompt reaches the stub provider with the accepted model;
 *   4. a permission callback reaches the controller and its reply releases the tool;
 *   5. a real cancel ends an in-flight prompt with stopReason cancelled;
 *   6. the entry stops by explicit PID and reaps the engine child.
 *
 * Usage: node docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs
 * Env:   OPENCODE_EXECUTABLE (default /Users/fanzhang/.opencode/bin/opencode)
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createConnection, createServer as createNetServer } from 'node:net'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const CLI = join(repositoryRoot, 'cli', 'agentteams.mjs')
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

function childrenOf(pid) {
  const table = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
  return table.split('\n').map(line => line.trim()).filter(line => line.length > 0).map(line => {
    const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match === null ? null : { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }
  }).filter(row => row !== null && row.ppid === pid)
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

/** Local OpenAI-compatible stub: a tool call first, then text, then a slow reply. */
function lastUserText(parsed) {
  const messages = Array.isArray(parsed.messages) ? parsed.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue
    const content = messages[index].content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join(' ')
  }
  return ''
}

function startStubProvider() {
  const calls = []
  let toolCalls = 0
  const server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const toolNames = (parsed.tools ?? []).map(tool => tool.function?.name ?? '').filter(name => name.length > 0)
      calls.push({ model: parsed.model ?? '', toolNames })
      const model = parsed.model ?? 'probe-model'
      const chunk = delta => `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      const finish = `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'PROBE-REPLY-OK' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      // Key the slow branch on the real prompt text so the cancel window is
      // deterministic and does not depend on how many provider calls happened.
      const plan = lastUserText(parsed).includes('SLOW-CANCEL')
        ? { kind: 'slow', text: 'PROBE-LATE', delayMs: 15_000 }
        : (toolNames.length === 0
            ? { kind: 'text', text: 'title' }
            : (++toolCalls === 1 ? { kind: 'tool', tool: 'read', args: { filePath: '/etc/hosts' } } : { kind: 'text', text: 'PROBE-TOOL-DONE' }))
      if (plan.kind === 'tool') {
        response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_probe_${toolCalls}`, type: 'function', function: { name: plan.tool, arguments: JSON.stringify(plan.args) } }] }))
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
        response.end('data: [DONE]\n\n')
        return
      }
      if (plan.kind === 'slow') {
        response.write(chunk({ role: 'assistant', content: 'PROBE-START' }))
        setTimeout(() => { response.write(chunk({ content: plan.text })); response.write(finish); response.end('data: [DONE]\n\n') }, plan.delayMs)
        return
      }
      response.write(chunk({ role: 'assistant', content: plan.text }))
      response.write(finish)
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise((resolveStart) => {
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

function agentConfig({ baseUrl, port, dataDirectory, workspace }) {
  return `version = 4

[daemon]
kind = "agent"
id = "reasoner-a"
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

function sessionIdOf(frame) {
  const sessionId = frame.result?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('session/new returned no sessionId')
  return sessionId
}

const directory = await mkdtemp(join(tmpdir(), 'd02-serve-blackbox-'))
const provider = await startStubProvider()
const port = await availableLoopbackPort()
const configPath = join(directory, 'agent.toml')
const dataDirectory = join(directory, 'state')
await writeFile(configPath, agentConfig({ baseUrl: provider.baseUrl, port, dataDirectory, workspace: join(directory, 'workspace') }))

console.log(`# D02 black-box serve entry`)
console.log(`config=${configPath}`)
console.log(`provider=${provider.baseUrl}`)
console.log(`listener=127.0.0.1:${port}`)

const entry = spawn(process.execPath, [CLI, '--serve', 'opencode', '--ip', '127.0.0.1', '--port', String(port), '--config', configPath], {
  cwd: repositoryRoot,
  env: { ...process.env, PROBE_API_KEY: PROBE_CREDENTIAL },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
entry.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); process.stdout.write(chunk) })
entry.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); process.stderr.write(chunk) })

let client
try {
  const readyLine = await new Promise((resolveLine, rejectLine) => {
    const deadline = setTimeout(() => rejectLine(new Error(`the entry never printed a readiness line; stderr=${stderr}`)), 90_000)
    const poll = setInterval(() => {
      const line = stdout.split('\n').find(candidate => candidate.startsWith('serving '))
      if (line !== undefined) { clearInterval(poll); clearTimeout(deadline); resolveLine(line) }
    }, 50)
  })
  console.log(`\n## readiness`)
  console.log(readyLine)
  // Values may contain spaces (modelVerification=session/new configOptions), so
  // split on `key=` boundaries instead of on every space.
  const fields = {}
  for (const match of readyLine.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^=]*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/g)) {
    fields[match[1]] = match[2].trim()
  }
  const daemonPid = Number(fields.daemonPid)
  const enginePid = Number(fields.enginePid)

  assert(fields.engine === 'opencode', 'the entry reports the opencode engine')
  assert(fields.model === 'probe/probe-model', `the entry reports the verified accepted model (${fields.model})`)
  assert(fields.modelVerification === 'session/new configOptions', `the model was verified from session/new (${fields.modelVerification})`)
  assert(fields.listener === `127.0.0.1:${port}`, 'the entry serves the configured listener')
  assert(Number.isSafeInteger(daemonPid) && daemonPid > 0, `the entry reports its own daemon pid (${daemonPid})`)
  assert(Number.isSafeInteger(enginePid) && enginePid > 0, `the entry reports the engine child pid (${enginePid})`)
  assert(daemonPid === entry.pid, 'the reported daemon pid is the real CLI process pid')

  const engineRow = processRow(enginePid)
  assert(engineRow.length > 0, `the reported engine pid ${enginePid} is a live process: ${engineRow}`)
  assert(/opencode/.test(engineRow) && /acp/.test(engineRow), 'the engine child really runs `opencode acp`')
  const children = childrenOf(daemonPid)
  assert(children.length === 1, `the daemon has exactly one child process (${children.map(row => `${row.pid}:${row.command.split(' ').slice(0, 3).join(' ')}`).join(' | ')})`)
  assert(children[0].pid === enginePid, 'the one child is the reported engine pid')

  console.log(`\n## prompt, permission and cancel through the entry listener`)
  client = await connectClient(port)
  await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
  const initialized = await client.awaitFrame(frame => frame.id === 'init-1')
  assert(initialized.result?.protocolVersion === 1, 'the entry served a real initialize result')

  await client.send({ jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: directory, mcpServers: [] } })
  const sessionId = sessionIdOf(await client.awaitFrame(frame => frame.id === 'new-1'))
  assert(sessionId.startsWith('ses_'), `the entry created a real engine session (${sessionId})`)

  await client.send({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } })
  const callback = await client.awaitFrame(frame => frame.method === 'session/request_permission', 60_000)
  const options = callback.params.options.map(option => option.optionId)
  assert(JSON.stringify(options) === JSON.stringify(['once', 'always', 'reject']), `the permission callback offered the real options (${options.join(',')})`)
  await client.send({ jsonrpc: '2.0', id: callback.id, result: { outcome: { outcome: 'selected', optionId: 'once' } } })
  const first = await client.awaitFrame(frame => frame.id === 'prompt-1')
  assert(first.result?.stopReason === 'end_turn', `the permission reply released the tool and the prompt completed (${first.result?.stopReason})`)
  assert(provider.calls.some(call => call.model === 'probe-model'), 'the stub provider really received a request for the accepted model')

  await client.send({ jsonrpc: '2.0', id: 'prompt-2', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'SLOW-CANCEL' }] } })
  await client.awaitFrame(frame => frame.method === 'session/update', 60_000)
  await client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  const cancelled = await client.awaitFrame(frame => frame.id === 'prompt-2')
  assert(cancelled.result?.stopReason === 'cancelled', `the cancel notification ended the in-flight prompt (${cancelled.result?.stopReason})`)

  console.log(`\n## explicit-PID stop`)
  // Register the exit listener before the signal so the event cannot be missed.
  const exited = new Promise(resolveExit => entry.once('exit', (code, signal) => resolveExit({ code, signal })))
  process.kill(daemonPid, 'SIGTERM')
  const exit = await Promise.race([
    exited,
    new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error('the entry did not exit after SIGTERM')), 60_000)),
  ])
  const stoppedLine = stdout.split('\n').find(line => line.startsWith('stopped '))
  console.log(stoppedLine ?? '(no stopped line)')
  assert(stoppedLine !== undefined, 'the entry printed its stop receipt')
  assert(/engine=exited/.test(stoppedLine), `the engine child exited through the real EngineStopResult (${stoppedLine})`)
  assert(processRow(enginePid).length === 0, `the engine pid ${enginePid} is gone after the stop`)
  assert(childrenOf(daemonPid).length === 0, 'the daemon left no child process behind')
  assert(exit.code === 0, `the entry exited cleanly by explicit PID (code=${exit.code} signal=${exit.signal})`)

  const history = JSON.parse(await readFile(join(dataDirectory, 'acp-history.json'), 'utf8'))
  const events = history.records.map(record => record.event)
  assert(events.includes('request.dispatched') && events.includes('result.received'), 'the daemon wrote its durable execution history')

  console.log(`\nBLACK-BOX PASS: one daemon + one engine child, verified model, prompt, permission callback, cancel, explicit-PID stop.`)
  console.log(JSON.stringify({ daemonPid, enginePid, sessionId, providerCalls: provider.calls.length, model: fields.model, modelVerification: fields.modelVerification, stop: stoppedLine }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(`--- entry stdout ---\n${stdout}\n--- entry stderr ---\n${stderr}`)
  process.exitCode = 1
} finally {
  if (client !== undefined) await client.close().catch(() => undefined)
  await provider.close()
  if (entry.exitCode === null && entry.signalCode === null) {
    // Never leave the entry running; it is the process this driver started.
    const reaped = new Promise(resolveExit => entry.once('exit', resolveExit))
    entry.kill('SIGTERM')
    const gone = await Promise.race([reaped.then(() => true), new Promise(resolveWait => setTimeout(() => resolveWait(false), 10_000))])
    if (!gone) {
      entry.kill('SIGKILL')
      await new Promise(resolveExit => entry.once('exit', resolveExit))
    }
  }
  await rm(directory, { recursive: true, force: true })
}
