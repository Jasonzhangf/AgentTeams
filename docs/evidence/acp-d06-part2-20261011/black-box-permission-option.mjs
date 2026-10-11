#!/usr/bin/env node
/**
 * D06 PART 2 black box: the real permission optionId decision path.
 *
 * Real entrypoints only:
 *   - the real CLI `agentteams --serve opencode` entry
 *   - the real installed OpenCode engine (OPENCODE_EXECUTABLE, default
 *     /Users/fanzhang/.opencode/bin/opencode) behind a local OpenAI-compatible stub
 *   - a real ACP client over the entry's loopback listener
 *
 * It proves A2.6 end to end on the real boundary:
 *   1. the callback carries the engine's own option set, including the real ACP `kind`;
 *   2. the projection to the frozen ConsolePermissionOption vocabulary is verbatim and
 *      never fabricated;
 *   3. a reply carrying an optionId the engine never offered is refused before it reaches
 *      the engine: the tool is not released, no approval is auto-issued, and the refusal
 *      is one durable callback.denied fact instead of a callback.reply;
 *   4. a refused reply never consumes the pending callback: the very same still-pending
 *      callback is answered with the engine's own optionId, the reply is forwarded
 *      unchanged, and the tool really runs;
 *   5. a reply carrying a callback id no pending callback holds is refused and approves
 *      nothing, while a fresh permission callback still arrives afterwards.
 *
 * `pnpm build` must have run: the CLI loads `generated/runtime-lib/`.
 *
 * Cleanup is explicit-PID only. It never uses pkill/killall/kill $(...).
 */
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
const ACP_KIND_TO_CONSOLE = { allow_once: 'once', allow_always: 'always', reject_once: 'reject', reject_always: 'reject' }
const FOREIGN_OPTION_ID = 'option-the-engine-never-offered'
const STALE_CALLBACK_ID = 'callback-id-no-pending-callback-holds'

const checks = []
function check(name, detail) {
  checks.push({ name, ok: true, detail: detail ?? undefined })
  process.stdout.write(`PASS ${name}${detail === undefined ? '' : ` — ${detail}`}\n`)
}

function processAlive(pid) {
  try { return execFileSync('ps', ['-p', String(pid)]).toString().split('\n').length > 1 } catch { return false }
}

/** The daemon's own durable ACP history, written by the engine host. */
async function readHistory(dataDirectory) {
  return JSON.parse(await readFile(join(dataDirectory, 'acp-history.json'), 'utf8'))
}

function availableLoopbackPort() {
  return new Promise((resolvePort, rejectPort) => {
    const listener = createNetServer()
    listener.once('error', rejectPort)
    listener.listen(0, '127.0.0.1', () => {
      const port = listener.address().port
      listener.close(() => resolvePort(port))
    })
  })
}

/** OpenAI-compatible stub: every conversation proposes one tool call, then a text reply. */
function startStubProvider() {
  const calls = []
  const server = createServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body)
      const toolNames = (parsed.tools ?? []).map(tool => tool.function?.name ?? '').filter(name => name.length > 0)
      // One tool call per conversation: once the conversation already carries a tool
      // result, the model answers in text, so each prompt asks permission exactly once.
      const carriesToolResult = (parsed.messages ?? []).some(message =>
        message?.role === 'tool' || message?.role === 'function' || message?.tool_call_id !== undefined)
      calls.push({ model: parsed.model ?? '', toolNames, carriesToolResult, at: Date.now() })
      const model = parsed.model ?? 'probe-model'
      const chunk = delta => `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`
      const finish = `data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion', created: 1, model, choices: [{ index: 0, message: { role: 'assistant', content: 'PROBE-REPLY-OK' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (toolNames.length === 0 || carriesToolResult) {
        response.write(chunk({ role: 'assistant', content: 'PROBE-TOOL-DONE' }))
        response.write(finish)
        response.end('data: [DONE]\n\n')
        return
      }
      response.write(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_probe_${calls.length}`, type: 'function', function: { name: 'read', arguments: JSON.stringify({ filePath: '/etc/hosts' }) } }] }))
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  return new Promise(resolveStart => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolveStart({ baseUrl: `http://127.0.0.1:${address.port}/v1`, calls, close: () => new Promise(resolveClose => server.close(() => resolveClose())) })
    })
  })
}

function connectClient(port) {
  return new Promise((resolveConnect, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buffer = ''
    const frames = []
    const waiters = []
    socket.on('error', reject)
    socket.on('connect', () => resolveConnect({
      send: frame => new Promise(resolveSend => socket.write(`${JSON.stringify(frame)}\n`, resolveSend)),
      awaitFrame: (match, timeoutMs = 90_000, label = step) => new Promise((resolveFrame, rejectFrame) => {
        const check = () => {
          for (let index = 0; index < frames.length; index += 1) {
            if (match(frames[index])) {
              clearTimeout(deadline)
              settle()
              resolveFrame(frames.splice(index, 1)[0])
              return true
            }
          }
          return false
        }
        // A negative await (a "this must not arrive" wait) settles as a timeout, but its
        // matcher must stop consuming frames: otherwise a later real frame is spliced by
        // the stale matcher and the honest wait for it times out for the wrong reason.
        let deadline
        let settled = false
        const settle = () => {
          if (settled) return
          settled = true
          clearTimeout(deadline)
          const at = waiters.indexOf(check)
          if (at >= 0) waiters.splice(at, 1)
        }
        deadline = setTimeout(() => { settle(); rejectFrame(new Error(`timed out waiting for an ACP frame at ${label}`)) }, timeoutMs)
        if (check()) return
        waiters.push(check)
      }),
      close: () => new Promise(resolveClose => socket.end(() => resolveClose())),
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
        for (const checkFn of [...waiters]) checkFn()
      }
    })
  })
}

const directory = await mkdtemp(join(tmpdir(), 'acp-d06-p2-permission-'))
const provider = await startStubProvider()
const port = await availableLoopbackPort()
const configPath = join(directory, 'agent.toml')
const dataDirectory = join(directory, 'state')
const workspace = join(directory, 'workspace')
await mkdir(workspace, { recursive: true })
await writeFile(configPath, `version = 4

[daemon]
kind = "agent"
id = "permission-probe"
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
apiBaseUrl = ${JSON.stringify(provider.baseUrl)}
label = "Probe provider"
enabled = true
credentialEnv = "PROBE_API_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
`)

console.log('# D06 PART 2 permission optionId black box')
console.log(`cli=${CLI}`)
console.log(`engine=${EXECUTABLE}`)
console.log(`listener=127.0.0.1:${port}`)

const entry = spawn(process.execPath, [CLI, '--serve', 'opencode', '--ip', '127.0.0.1', '--port', String(port), '--config', configPath], {
  cwd: CLI_ROOT,
  env: { ...process.env, PROBE_API_KEY: PROBE_CREDENTIAL },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
entry.stdout.on('data', chunk => { stdout += chunk.toString('utf8') })
entry.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })

let client
let step = 'connect'
let passed = false
try {
  await new Promise((resolveReady, rejectReady) => {
    const deadline = setTimeout(() => rejectReady(new Error(`the entry never printed a readiness line; stderr=${stderr}`)), 90_000)
    const poll = setInterval(() => {
      const line = stdout.split('\n').find(candidate => candidate.startsWith('serving '))
      if (line !== undefined) { clearInterval(poll); clearTimeout(deadline); resolveReady(line) }
    }, 50)
  })
  const fields = {}
  for (const match of stdout.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^=]*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/g)) {
    fields[match[1]] = match[2].trim()
  }
  const daemonPid = Number(fields.daemonPid)
  const enginePid = Number(fields.enginePid)
  if (!Number.isSafeInteger(daemonPid) || daemonPid <= 0) throw new Error(`no real daemon pid in: ${stdout}`)
  if (!Number.isSafeInteger(enginePid) || enginePid <= 0) throw new Error(`no real engine pid in: ${stdout}`)
  check('the real --serve entry reached readiness with one engine child',
    `daemonPid=${daemonPid} enginePid=${enginePid} model=${fields.model}`)

  client = await connectClient(port)
  step = 'initialize'
  await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
  await client.awaitFrame(frame => frame.id === 'init-1')
  await client.send({ jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: workspace, mcpServers: [] } })
  const session = await client.awaitFrame(frame => frame.id === 'new-1')
  const sessionId = session.result?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('session/new returned no sessionId')
  check('the entry created a real engine session', `sessionId=${sessionId}`)

  step = 'prompt 1'
  await client.send({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } })
  const callback = await client.awaitFrame(frame => frame.method === 'session/request_permission', 60_000)
  const options = callback.params.options
  if (!Array.isArray(options) || options.length === 0) throw new Error('the engine offered no permission options')
  const optionIds = options.map(option => option.optionId)
  const optionKinds = options.map(option => option.kind)
  check('the callback carries the engine own option set with real ACP kinds',
    options.map(option => `${option.optionId}/${option.kind}`).join(','))
  if (new Set(optionIds).size !== optionIds.length) throw new Error('the engine duplicated an optionId')
  if (optionKinds.some(kind => ACP_KIND_TO_CONSOLE[kind] === undefined)) {
    throw new Error(`the engine sent an unknown kind: ${optionKinds.join(',')}`)
  }
  check('the projection to the frozen Console vocabulary is verbatim and never fabricated',
    `ids=[${optionIds.join(',')}] projected=[${optionKinds.map(kind => ACP_KIND_TO_CONSOLE[kind]).join(',')}]`)

  // 3. A foreign optionId is refused before it reaches the engine. The real engine is
  //    permissive: the refused reply is neither forwarded to it nor answered with the
  //    ACP cancellation outcome, so the pending callback stays with the engine waiting
  //    for a valid answer. The real observable facts are therefore that no callback.reply
  //    was forwarded, the refusal is one durable callback.denied fact, and only after the
  //    engine's own optionId arrives does the tool really run.
  step = 'foreign optionId reply'
  await client.send({ jsonrpc: '2.0', id: callback.id, result: { outcome: { outcome: 'selected', optionId: FOREIGN_OPTION_ID } } })
  step = 'foreign refusal assertions'
  await client.awaitFrame(frame => frame.id === 'prompt-1', 6_000).then(() => true).catch(() => false)
  const denied = await readHistory(dataDirectory)
  const denial = denied.records.find(record => record.event === 'callback.denied')
  if (denial === undefined) {
    throw new Error(`the refusal left no durable callback.denied fact: ${denied.records.map(r => r.event).join(',')}`)
  }
  if (denial.sessionId !== sessionId) throw new Error(`the denial belongs to another session: ${denial.sessionId}`)
  const deniedReply = denial.frame?.result ?? denial.frame?.outcome
  if (deniedReply?.outcome?.optionId !== FOREIGN_OPTION_ID) {
    throw new Error(`the denial does not carry the refused reply: ${JSON.stringify(denial.frame)}`)
  }
  const foreignReplied = denied.records.some(record =>
    record.event === 'callback.reply' && (record.frame?.id === callback.id || record.frame?.result?.outcome?.optionId === FOREIGN_OPTION_ID))
  if (foreignReplied) throw new Error('a refused reply was recorded as a forwarded callback.reply')
  const cancellations = denied.records.filter(record => record.event === 'callback.unknown' || record.frame?.result?.outcome?.outcome === 'cancelled')
  if (cancellations.length > 0) {
    throw new Error(`the refusal reached the engine as a cancellation: ${JSON.stringify(cancellations)}`)
  }
  check('a foreign optionId is refused before the engine: no reply forwarded, no cancellation issued',
    `denial sequence=${denial.sequence} denied optionId=${FOREIGN_OPTION_ID} prompt still pending after 6s`)

  // 4. The refused reply never consumed the pending callback: the very same callback is
  //    still pending, so the engine's own optionId is forwarded unchanged and releases
  //    the tool, and the approval is one durable callback.reply.
  step = 'approved reply 1'
  const callsBeforeRelease = provider.calls.length
  await client.send({ jsonrpc: '2.0', id: callback.id, result: { outcome: { outcome: 'selected', optionId: optionIds[0] } } })
  const released = await client.awaitFrame(frame => frame.id === 'prompt-1', 90_000)
  if (released.error !== undefined) throw new Error(`the engine own optionId was refused: ${JSON.stringify(released.error)}`)
  if (released.result?.stopReason !== 'end_turn') {
    throw new Error(`the prompt did not complete after the real approval: ${JSON.stringify(released.result)}`)
  }
  if (provider.calls.length <= callsBeforeRelease) throw new Error('the approved tool call reached no provider request')
  check('the same still-pending callback is answerable and the engine own optionId releases the tool',
    `optionId=${optionIds[0]} stopReason=${released.result.stopReason} providerCalls=${provider.calls.length - callsBeforeRelease}`)
  const afterRelease = await readHistory(dataDirectory)
  const forwarded = afterRelease.records.find(record =>
    record.event === 'callback.reply' && record.frame?.result?.outcome?.optionId === optionIds[0] && record.frame?.id === callback.id)
  if (forwarded === undefined) {
    throw new Error(`the approved optionId was not forwarded to the engine: ${afterRelease.records.map(r => r.event).join(',')}`)
  }
  const denialsAfter = afterRelease.records.filter(record => record.event === 'callback.denied')
  if (denialsAfter.length !== 1) throw new Error(`the approval added another denial: ${denialsAfter.length}`)
  check('the approved optionId is recorded as a durable callback.reply',
    `optionId=${optionIds[0]} sequence=${forwarded.sequence} denials=${denialsAfter.length}`)

  // 5. A reply carrying a callback id no pending callback holds is refused and approves
  //    nothing, while a fresh permission callback still arrives afterwards.
  step = 'session 2 new'
  await client.send({ jsonrpc: '2.0', id: 'new-2', method: 'session/new', params: { cwd: workspace, mcpServers: [] } })
  const sessionTwo = await client.awaitFrame(frame => frame.id === 'new-2')
  const sessionIdTwo = sessionTwo.result?.sessionId
  if (typeof sessionIdTwo !== 'string' || sessionIdTwo.length === 0) throw new Error('session/new returned no second sessionId')
  const callsBeforeStale = provider.calls.length
  await client.send({ jsonrpc: '2.0', id: 'prompt-2', method: 'session/prompt', params: { sessionId: sessionIdTwo, prompt: [{ type: 'text', text: 'read /etc/hosts' }] } })
  step = 'permission callback 2'
  const callbackTwo = await client.awaitFrame(frame => frame.method === 'session/request_permission', 60_000)
  check('a fresh permission callback still arrives after the refusal', `optionIds=${callbackTwo.params.options.map(o => o.optionId).join(',')}`)
  step = 'stale callback reply'
  await client.send({ jsonrpc: '2.0', id: STALE_CALLBACK_ID, result: { outcome: { outcome: 'selected', optionId: optionIds[0] } } })
  const staleApproved = await client.awaitFrame(frame => frame.id === 'prompt-2', 8_000).then(() => true).catch(() => false)
  if (staleApproved) throw new Error('a reply for an unknown callback id released the prompt')
  const staleHistory = await readHistory(dataDirectory)
  const staleApproval = staleHistory.records.some(record => record.event === 'callback.reply' && record.frame?.id === STALE_CALLBACK_ID)
  if (staleApproval) throw new Error('an unknown callback id was recorded as a forwarded approval')
  check('a missing or stale callback id approves nothing',
    `id=${STALE_CALLBACK_ID} prompt still pending, providerCalls=${provider.calls.length - callsBeforeStale}`)
  step = 'cancel prompt 2'
  await client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: sessionIdTwo } })
  await client.awaitFrame(frame => frame.id === 'prompt-2', 30_000)

  // Explicit-PID stop.
  step = 'explicit-PID stop'
  const exited = new Promise(resolveExit => entry.once('exit', (code, signal) => resolveExit({ code, signal })))
  process.kill(daemonPid, 'SIGTERM')
  const exit = await Promise.race([
    exited,
    new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error('the entry did not exit after SIGTERM')), 60_000)),
  ])
  check('the entry stops by explicit PID and the engine child is gone',
    `code=${exit.code} signal=${exit.signal} engineAlive=${processAlive(enginePid)}`)

  passed = true
  console.log(`\nD06 PART 2 permission optionId black box PASS: ${checks.length} checks`)
} catch (error) {
  process.stderr.write(`\nD06 PART 2 permission black box FAIL: ${error instanceof Error ? error.stack : String(error)}\n`)
  if (stderr.length > 0) process.stderr.write(`--- entry stderr ---\n${stderr}\n`)
  process.exitCode = 1
} finally {
  if (client !== undefined) await client.close().catch(() => undefined)
  await provider.close()
  if (entry.exitCode === null && entry.signalCode === null) {
    const reaped = new Promise(resolveExit => entry.once('exit', resolveExit))
    entry.kill('SIGTERM')
    const gone = await Promise.race([reaped.then(() => true), new Promise(resolveWait => setTimeout(() => resolveWait(false), 10_000))])
    if (!gone) {
      entry.kill('SIGKILL')
      await new Promise(resolveExit => entry.once('exit', resolveExit))
    }
  }
  if (passed) {
    await rm(directory, { recursive: true, force: true })
  } else {
    console.error(`KEEPING ${directory} for failure forensics`)
  }
}