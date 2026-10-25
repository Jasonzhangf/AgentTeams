#!/usr/bin/env node
/**
 * Issue 8dde877 - independent live acceptance for the first user-usable group WebUI.
 * Owned by Jenny (project master). Drives real CLI, real daemons, real Vikunja and real Chrome.
 * Explicit-PID cleanup only. No pkill/killall/kill $(...)/tmux operations.
 */
import { execFileSync, spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer as createNetServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const evidenceDirectory = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(evidenceDirectory, '..', '..', '..')
const CLI = join(repositoryRoot, 'cli', 'agentteams.mjs')
const OPENCODE = process.env.OPENCODE_EXECUTABLE ?? join(homedir(), '.opencode', 'bin', 'opencode')
const CHROME = process.env.CHROME_BIN ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VIKUNJA_BASE = (process.env.VIKUNJA_BASE_URL ?? 'http://127.0.0.1:3456').replace(/\/+$/u, '')
const VIKUNJA_TOKEN = process.env.VIKUNJA_TOKEN ?? ''
const VIKUNJA_PROJECT = process.env.VIKUNJA_PROJECT_ID ?? '2'
const ACCOUNT = 'local'
const SCOPE = 'local'
const AGENT_A = 'groups-a'
const AGENT_B = 'groups-b'
const AGENT_ABSENT = 'groups-c'
const CONTROL_ID = 'groups-console'
const HOST_A = 'host-groups-a'
const HOST_B = 'host-groups-b'
const USERNAME = 'groups-accept'
const PASSWORD_ENV = 'GROUPS_ACCEPT_PASSWORD'
const PASSWORD = 'groups-accept-secret'
const BASIC = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`
const CREDENTIALS = { a: 'Bearer groups-accept-a-secret', b: 'Bearer groups-accept-b-secret', control: 'Bearer groups-accept-control-secret', peer: 'Bearer groups-accept-peer-secret', provider: 'groups-accept-provider-secret' }
const skipBrowser = process.argv.includes('--skip-browser')
const keepOnFailure = process.argv.includes('--keep')
const checks = []
const gaps = []
let step = 'startup'
let ownedRoot
let cliRuns = 0
let logDirectory
let provider
let registryConfigPath
let controlConfigPath
let controlOrigin
let requestCounter = 0
const spawned = []
const receipts = { driver: 'group-webui-first-delivery-20261024/live-group-webui.mjs', startedAt: new Date().toISOString(), steps: [] }

function check(name, detail) { checks.push({ name, detail }); console.log(`PASS ${name} — ${detail}`) }
function gap(name, reason) { gaps.push({ name, reason }); console.log(`GAP ${name} — ${reason}`) }
function record(name, value) { receipts.steps.push({ step, name, value }); console.log(`  -- ${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`) }
function assert(condition, message) { if (!condition) throw new Error(`LIVE ACCEPTANCE FAIL [${step}]: ${message}`) }
function sleep(ms) { return new Promise(resolveSleep => setTimeout(resolveSleep, ms)) }

function runCli(args, env) {
  cliRuns += 1
  const logPath = join(logDirectory, `cli-${cliRuns}.log`)
  const fd = openSync(logPath, 'a')
  try {
    execFileSync(process.execPath, [CLI, ...args], { cwd: repositoryRoot, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd] })
  } finally { closeSync(fd) }
  return readFileSync(logPath, 'utf8')
}

function parseFields(line) {
  const fields = {}
  for (const match of line.matchAll(/([A-Za-z][A-Za-z0-9]*)=([^=]*?)(?=\s+[A-Za-z][A-Za-z0-9]*=|$)/g)) fields[match[1]] = match[2].trim()
  return fields
}

async function availablePort(host) {
  const listener = createNetServer()
  await new Promise((resolveListen, reject) => { listener.once('error', reject); listener.listen(0, host, resolveListen) })
  const address = listener.address()
  await new Promise(resolveClose => listener.close(resolveClose))
  return address.port
}

function generateTls(directory, name) {
  const keyPath = join(directory, `${name}-key.pem`)
  const certPath = join(directory, `${name}-cert.pem`)
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', `/CN=${name}`, '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', keyPath, '-out', certPath], { stdio: 'ignore' })
  return { keyPath, certPath }
}

async function startStubProvider() {
  const server = createHttpServer((request, response) => {
    if (request.method !== 'POST') { response.writeHead(404).end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      if (!body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-accept', object: 'chat.completion', created: 1, model: 'accept-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ACCEPT-STUB' }, finish_reason: 'stop' }] }))
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-accept', object: 'chat.completion.chunk', created: 1, model: 'accept-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'ACCEPT-STUB' }, finish_reason: null }] })}\n\n`)
      response.write(`data: ${JSON.stringify({ id: 'chatcmpl-accept', object: 'chat.completion.chunk', created: 1, model: 'accept-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const address = server.address()
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise(resolveClose => server.close(resolveClose)) }
}

function registryConfig({ directory, port, keyPath, certPath }) {
  const admission = (ref, agentId, credentialRef) => `\n[[admissions]]\nadmissionRef = "${ref}"\nagentId = "${agentId}"\naccountId = "${ACCOUNT}"\nscopeId = "${SCOPE}"\ncredentialRef = "${credentialRef}"\n`
  return `version = 4

[daemon]
kind = "registry"
id = "groups-registry"
hostId = "groups-registry-host"
accountId = "${ACCOUNT}"
scopeId = "${SCOPE}"
dataDirectory = ${JSON.stringify(join(directory, 'registry-state'))}

[listen]
ip = "127.0.0.1"
port = ${port}
tlsCertRef = "file:${certPath}"
tlsKeyRef = "file:${keyPath}"
${admission('adm-a', AGENT_A, 'env:GROUPS_CRED_A')}${admission('adm-b', AGENT_B, 'env:GROUPS_CRED_B')}${admission('adm-control', CONTROL_ID, 'env:GROUPS_CRED_CONTROL')}`
}

function agentConfig({ id, hostId, directory, port, registryPort, trustPath }) {
  return `version = 4

[daemon]
kind = "agent"
id = "${id}"
hostId = "${hostId}"
accountId = "${ACCOUNT}"
scopeId = "${SCOPE}"
dataDirectory = ${JSON.stringify(join(directory, 'state'))}

[engine]
kind = "opencode"
executable = ${JSON.stringify(OPENCODE)}
workspace = ${JSON.stringify(join(directory, 'workspace'))}

[listen]
ip = "127.0.0.1"
port = ${port}

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = []
clientCapabilities = []
callbackExecutor = "controller"

[relations]
allowed = ["master", "peer"]

[[admissions]]
admissionRef = "adm-peer"
agentId = "${id === AGENT_A ? AGENT_B : AGENT_A}"
accountId = "${ACCOUNT}"
scopeId = "${SCOPE}"
credentialRef = "env:GROUPS_CRED_PEER"

[discovery]
serverId = "groups-registry"
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = ${JSON.stringify(id === AGENT_A ? 'env:GROUPS_CRED_A' : 'env:GROUPS_CRED_B')}
tlsTrustRef = "file:${trustPath}"

[providers.accept]
protocol = "openai-chat"
apiBaseUrl = ${JSON.stringify(provider.baseUrl)}
label = "acceptance stub provider"
enabled = true
credentialEnv = "GROUPS_PROVIDER_KEY"

[[models]]
provider = "accept"
id = "accept-model"

[model.primary]
provider = "accept"
model = "accept-model"

[vikunja]
baseUrl = ${JSON.stringify(VIKUNJA_BASE)}
tokenRef = "env:GROUPS_VIKUNJA_TOKEN"
projectId = ${JSON.stringify(VIKUNJA_PROJECT)}
`
}

function controlConfig({ directory, port, registryPort, trustPath }) {
  const peer = (agentId, hostId) => `\n[peers.${agentId}]\nagentId = "${agentId}"\nhostId = "${hostId}"\naccountId = "${ACCOUNT}"\nscopeId = "${SCOPE}"\ncredentialRef = "env:GROUPS_CRED_PEER"\n`
  return `version = 4

[daemon]
kind = "control"
id = "${CONTROL_ID}"
hostId = "groups-console-host"
accountId = "${ACCOUNT}"
scopeId = "${SCOPE}"
dataDirectory = ${JSON.stringify(join(directory, 'control-state'))}

[webui]
ip = "127.0.0.1"
port = ${port}
allowedOrigin = "http://127.0.0.1:${port}"

[webui.auth]
username = "${USERNAME}"
passwordEnv = "${PASSWORD_ENV}"

[relations]
allowed = ["master", "peer"]

[discovery]
serverId = "groups-registry"
endpoint = "wss://127.0.0.1:${registryPort}"
credentialRef = "env:GROUPS_CRED_CONTROL"
tlsTrustRef = "file:${trustPath}"
${peer(AGENT_A, HOST_A)}${peer(AGENT_B, HOST_B)}${peer(AGENT_ABSENT, 'host-groups-c')}`
}

function spawnAgent({ label, port, configPath, env }) {
  const child = spawn(process.execPath, [CLI, '--serve', 'opencode', '--ip', '127.0.0.1', '--port', String(port), '--config', configPath], { cwd: repositoryRoot, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const entry = { label, child, stdout: '', stderr: '', ready: undefined }
  child.stdout.on('data', chunk => {
    entry.stdout += chunk.toString('utf8')
    for (const line of entry.stdout.split('\n')) if (entry.ready === undefined && line.startsWith('serving ')) entry.ready = line
  })
  child.stderr.on('data', chunk => { entry.stderr += chunk.toString('utf8') })
  spawned.push(entry)
  return entry
}

async function awaitReady(entry, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (entry.ready !== undefined) return parseFields(entry.ready)
    if (entry.child.exitCode !== null) throw new Error(`${entry.label} exited before readiness; stderr=${entry.stderr}`)
    await sleep(100)
  }
  throw new Error(`${entry.label} never became ready; stderr=${entry.stderr}`)
}

async function awaitRegistrationOnline(entry, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const line = entry.stdout.split('\n').filter(candidate => candidate.startsWith('registration ')).pop()
    if (line !== undefined && line.includes('state=online')) return line
    if (entry.child.exitCode !== null) throw new Error(`${entry.label} exited before registration online; stderr=${entry.stderr}`)
    await sleep(100)
  }
  throw new Error(`${entry.label} never registered online; stdout=${entry.stdout}`)
}

async function awaitFile(path, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await sleep(100)
  }
  throw new Error(`${label} never appeared at ${path} within ${timeoutMs}ms`)
}

function socketRequest(socketPath, frame, timeoutMs = 30_000) {
  return new Promise((resolveReply, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`socket ${socketPath} timed out for ${frame.kind}`)) }, timeoutMs)
    const finish = (error, value) => { clearTimeout(timer); socket.destroy(); if (error !== undefined) reject(error); else resolveReply(value) }
    socket.setEncoding('utf8')
    socket.once('error', error => finish(error))
    socket.on('data', chunk => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) return
      try { finish(undefined, JSON.parse(buffer.slice(0, index))) } catch (error) { finish(error) }
    })
    socket.once('connect', () => socket.write(`${JSON.stringify(frame)}\n`))
  })
}

async function groupRequest(agentId, frame, authorization = BASIC) {
  const response = await fetch(`${controlOrigin}/api/v1/group-request?agentId=${encodeURIComponent(agentId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authorization === null ? {} : { authorization }) },
    body: JSON.stringify({ requestId: frame.requestId, frame }),
  })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  return { status: response.status, body }
}

async function vikunja(method, path, payload) {
  const response = await fetch(`${VIKUNJA_BASE}${path}`, { method, headers: { authorization: `Bearer ${VIKUNJA_TOKEN}`, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) })
  const text = await response.text()
  let body
  try { body = JSON.parse(text) } catch { body = text }
  assert(response.ok, `Vikunja ${method} ${path} returned HTTP ${response.status}: ${text.slice(0, 300)}`)
  return body
}

function frame(value) { requestCounter += 1; return { requestId: `accept-${process.pid}-${requestCounter}`, ...value } }
function replyError(reply) { return reply?.kind === 'relay.error' ? reply.error : undefined }

/* Chrome over CDP */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.handlers = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(typeof event.data === 'string' ? event.data : '')
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const { resolve: resolveCall, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error !== undefined) reject(new Error(`${message.error.message} (${message.error.code})`))
        else resolveCall(message.result)
        return
      }
      if (typeof message.method === 'string') {
        for (const handler of this.handlers.get(message.method) ?? []) handler(message.params)
      }
    })
  }
  on(method, handler) {
    const handlers = this.handlers.get(method) ?? []
    handlers.push(handler)
    this.handlers.set(method, handlers)
    return () => {
      const current = this.handlers.get(method) ?? []
      this.handlers.set(method, current.filter(candidate => candidate !== handler))
    }
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId
    this.nextId += 1
    return new Promise((resolveCall, reject) => {
      this.pending.set(id, { resolve: resolveCall, reject })
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    })
  }
}

async function connectBrowser(wsUrl) {
  const socket = new WebSocket(wsUrl)
  await new Promise((resolveOpen, reject) => { socket.addEventListener('open', resolveOpen, { once: true }); socket.addEventListener('error', () => reject(new Error('CDP websocket failed to open')), { once: true }) })
  return new Cdp(socket)
}

async function evaluate(browser, sessionId, expression) {
  const result = await browser.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId)
  if (result.exceptionDetails !== undefined) throw new Error(`page evaluation failed: ${result.exceptionDetails.text ?? JSON.stringify(result.exceptionDetails)}`)
  return result.result?.value
}

async function waitDom(browser, sessionId, expression, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await evaluate(browser, sessionId, expression)
    if (value !== undefined && value !== null && value !== false) return value
    await sleep(200)
  }
  const snapshot = await evaluate(browser, sessionId, 'document.body ? document.body.innerText.slice(0, 2000) : "no body"')
  throw new Error(`DOM wait failed: ${label}; body=${snapshot}`)
}

async function click(browser, sessionId, selector) {
  const clicked = await evaluate(browser, sessionId, `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (node === null) return false; node.click(); return true })()`)
  assert(clicked === true, `element ${selector} was clickable`)
}

async function fill(browser, sessionId, selector, value) {
  const filled = await evaluate(browser, sessionId, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)})
    if (node === null) return false
    if (node.tagName === 'SELECT') {
      node.value = ${JSON.stringify(value)}
      node.dispatchEvent(new Event('change', { bubbles: true }))
      return node.value === ${JSON.stringify(value)}
    }
    const proto = node.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter !== undefined) setter.call(node, ${JSON.stringify(value)})
    else node.value = ${JSON.stringify(value)}
    node.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  assert(filled === true, `field ${selector} accepted input`)
}

async function screenshot(browser, sessionId, path) {
  const shot = await browser.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId)
  writeFileSync(path, Buffer.from(shot.data, 'base64'))
}

async function setActor(browser, sessionId, actor) {
  const changed = await evaluate(browser, sessionId, `(() => {
    const select = document.querySelector('[data-group-actor-select]')
    if (select === null) return false
    select.value = ${JSON.stringify(actor)}
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  assert(changed === true, 'the actor selector was available for a multi-agent Console')
}

/**
 * Pause only the group requests that match `predicate`. Every other request is
 * continued immediately, so the page still uses the real Console route. A held
 * request is released with continueRequest or failed as a real network error.
 */
async function openRequestGate(browser, sessionId, predicate) {
  const held = []
  const off = browser.on('Fetch.requestPaused', params => {
    let frame
    try { frame = JSON.parse(params.request.postData ?? '{}').frame } catch { frame = undefined }
    if (frame !== undefined && predicate(frame)) {
      held.push({ requestId: params.requestId, frame })
      return
    }
    void browser.send('Fetch.continueRequest', { requestId: params.requestId }, sessionId).catch(() => undefined)
  })
  await browser.send('Fetch.enable', { patterns: [{ urlPattern: `${controlOrigin}/api/v1/group-request*`, requestStage: 'Request' }] }, sessionId)
  return {
    held,
    async waitFor(count, timeoutMs = 15_000) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (held.length >= count) return held[count - 1]
        await sleep(100)
      }
      throw new Error(`request gate never captured ${count} matching request(s); held=${held.length}`)
    },
    async continueRequest(requestId) {
      await browser.send('Fetch.continueRequest', { requestId }, sessionId)
    },
    async fail(requestId) {
      await browser.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionReset' }, sessionId)
    },
    async close() {
      off()
      await browser.send('Fetch.disable', {}, sessionId).catch(() => undefined)
    },
  }
}

async function selectedGroupId(browser, sessionId) {
  return evaluate(browser, sessionId, 'document.querySelector(\'[data-group-selected-id]\')?.dataset.groupSelectedId ?? null')
}

async function waitSelectedGroup(browser, sessionId, groupId, label) {
  await waitDom(browser, sessionId, `document.querySelector('[data-group-selected-id]')?.dataset.groupSelectedId === ${JSON.stringify(groupId)}`, label)
}

async function messageCount(browser, sessionId, body) {
  return evaluate(browser, sessionId, `Array.from(document.querySelectorAll('[data-group-message]')).filter(node => node.innerText.includes(${JSON.stringify(body)})).length`)
}

async function selectGroupAndOpenIssue(browser, sessionId, actor, groupId, issueSessionId) {
  await setActor(browser, sessionId, actor)
  await waitDom(browser, sessionId, `document.querySelector('[data-group-actor]')?.dataset.groupActor === ${JSON.stringify(actor)}`, `the ${actor} identity is active`)
  await waitDom(browser, sessionId, `document.querySelector('[data-group-item="${groupId}"]') !== null`, `the ${actor} group list contains the selected group`)
  await click(browser, sessionId, `[data-group-item="${groupId}"]`)
  await waitSelectedGroup(browser, sessionId, groupId, `the ${actor} selected the group`)
  await waitDom(browser, sessionId, `document.querySelector('[data-group-issue-open="${issueSessionId}"]') !== null`, `the ${actor} issue list contains the open issue`, 30_000)
  await click(browser, sessionId, `[data-group-issue-open="${issueSessionId}"]`)
  await waitDom(browser, sessionId, `document.querySelector('[data-group-issue-session]')?.dataset.groupIssueSession === ${JSON.stringify(issueSessionId)}`, `the ${actor} reopened the issue`, 30_000)
}

/**
 * Real-browser negative replays for the context-switch invariant:
 * 1. one actor's unknown write is invisible to another actor and retries with the same ids;
 * 2. a late read for the group the user left cannot repaint the newly selected group.
 */
async function runNegativeReplays(browser, sessionId, createdId, socketGroupId, messageBody) {
  step = 'negative actor isolation'
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId)
  await sleep(300)
  const unique = `unknown-${Date.now()}`
  let gate = await openRequestGate(browser, sessionId, frame => frame.kind === 'message.send' && frame.groupId === createdId)
  await fill(browser, sessionId, '[data-group-composer-input]', unique)
  await click(browser, sessionId, '[data-group-send]')
  const first = await gate.waitFor(1)
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-outcome="pending"]\') !== null', 'the failed send is pending before the actor switch')

  await setActor(browser, sessionId, AGENT_B)
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-workspace]\')?.dataset.groupActorCount === "2" && document.querySelector(\'[data-group-list]\') !== null', 'the other actor sees its own group list')
  const otherActorState = await evaluate(browser, sessionId, `({
    retry: document.querySelector('[data-group-retry]') !== null,
    unknown: document.querySelector('[data-group-outcome="unknown"]') !== null,
    leakedDraft: document.body.innerText.includes(${JSON.stringify(unique)}),
    composer: document.querySelector('[data-group-composer-input]')?.value ?? null,
  })`)
  assert(otherActorState.retry === false, 'another actor shows no retry for the parked write')
  assert(otherActorState.unknown === false, 'another actor shows no unknown result for the parked write')
  assert(otherActorState.leakedDraft === false && otherActorState.composer === '', 'another actor sees neither the parked draft nor the pending body')
  await gate.fail(first.requestId)
  await sleep(500)

  await setActor(browser, sessionId, AGENT_A)
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-workspace]\')?.dataset.groupActorCount === "2" && document.querySelector(\'[data-group-list]\') !== null', 'the original actor reloads its group list')
  await click(browser, sessionId, `[data-group-item="${createdId}"]`)
  await waitSelectedGroup(browser, sessionId, createdId, 'the original group is selected again')
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-outcome="unknown"]\') !== null && document.querySelector(\'[data-group-retry]\') !== null', 'the original actor recovers its unknown result and retry', 15_000)
  const restoredDraft = await evaluate(browser, sessionId, 'document.querySelector(\'[data-group-composer-input]\')?.value ?? null')
  assert(restoredDraft === unique, 'the original actor recovers its parked composer draft')
  await gate.close()

  gate = await openRequestGate(browser, sessionId, frame => frame.kind === 'message.send' && frame.groupId === createdId)
  await click(browser, sessionId, '[data-group-retry]')
  const second = await gate.waitFor(1)
  assert(second.frame.requestId === first.frame.requestId, `the retry reuses requestId (${first.frame.requestId} -> ${second.frame.requestId})`)
  assert(second.frame.commitId !== undefined && second.frame.commitId === first.frame.commitId, `the retry reuses commitId (${first.frame.commitId} -> ${second.frame.commitId})`)
  await gate.continueRequest(second.requestId)
  await gate.close()
  await waitDom(browser, sessionId, `Array.from(document.querySelectorAll('[data-group-message]')).some(node => node.innerText.includes(${JSON.stringify(unique)}))`, 'the retried message is delivered once', 30_000)
  assert(await messageCount(browser, sessionId, unique) === 1, 'the retried message appears exactly once')
  assert(await evaluate(browser, sessionId, 'document.querySelector(\'[data-group-retry]\') === null') === true, 'the retry control clears after the owner confirms the write')
  check('negative actor isolation', `actor A's unknown message stayed hidden from B, returned to A, and retried with requestId ${first.frame.requestId} and commitId ${first.frame.commitId}`)

  step = 'negative late read'
  gate = await openRequestGate(browser, sessionId, frame => frame.kind === 'message.page' && frame.groupId === createdId)
  await click(browser, sessionId, `[data-group-item="${socketGroupId}"]`)
  await waitSelectedGroup(browser, sessionId, socketGroupId, 'the other group opens before the held read')
  await click(browser, sessionId, `[data-group-item="${createdId}"]`)
  const heldRead = await gate.waitFor(1)
  await click(browser, sessionId, `[data-group-item="${socketGroupId}"]`)
  await waitSelectedGroup(browser, sessionId, socketGroupId, 'the user switches to the other group while the old read is held')
  await waitDom(browser, sessionId, 'Array.from(document.querySelectorAll(\'[data-group-message]\')).some(node => node.innerText.includes("hello from agent A"))', 'the new group content is visible')
  await gate.continueRequest(heldRead.requestId)
  await sleep(800)
  const late = await evaluate(browser, sessionId, `({
    selected: document.querySelector('[data-group-selected-id]')?.dataset.groupSelectedId ?? null,
    leaked: document.body.innerText.includes(${JSON.stringify(messageBody)}),
    rowSelected: document.querySelector('[data-group-item="${socketGroupId}"]')?.dataset.groupSelected ?? null,
  })`)
  assert(late.selected === socketGroupId, `the late read did not change the selected group (${late.selected})`)
  assert(late.rowSelected === 'true', 'the new group row stays selected')
  assert(late.leaked === false, 'the old group message did not repaint the new group')
  await gate.close()
  check('negative late read isolation', 'a message.page for the left group landed after the switch and did not repaint the newly selected group')
}

async function runBrowser(groupName, messageBody, agentBSocket, agentASocket, socketGroupId) {
  step = 'chrome launch'
  assert(existsSync(CHROME), `Chrome exists at ${CHROME}`)
  const child = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${join(ownedRoot, 'chrome-profile')}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--window-size=1440,900', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] })
  spawned.push({ label: 'chrome', child })
  const endpoint = await new Promise((resolveEndpoint, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('Chrome never printed a DevTools endpoint')), 30_000)
    child.stderr.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/u)
      if (match !== null) { clearTimeout(timer); resolveEndpoint(match[1]) }
    })
  })
  const browser = await connectBrowser(endpoint)
  const target = await browser.send('Target.createTarget', { url: 'about:blank' })
  const attached = await browser.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
  const sessionId = attached.sessionId
  for (const domain of ['Page', 'Network', 'Runtime']) await browser.send(`${domain}.enable`, {}, sessionId)
  await browser.send('Network.setExtraHTTPHeaders', { headers: { Authorization: BASIC } }, sessionId)
  await browser.send('Page.navigate', { url: `${controlOrigin}/` }, sessionId)

  step = 'chrome group page'
  await waitDom(browser, sessionId, 'document.querySelectorAll(\'[data-team-page]\').length > 0', 'team navigation rendered', 60_000)
  await click(browser, sessionId, '[data-team-page="groups"]')
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-workspace]\') !== null', 'group workspace rendered')
  const hasSelect = await evaluate(browser, sessionId, 'document.querySelector(\'[data-group-actor-select]\') !== null')
  if (hasSelect) {
    await setActor(browser, sessionId, AGENT_A)
    await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-actor]\')?.dataset.groupActor === "groups-a"', 'the chosen actor becomes the active group identity')
    check('multi-actor selector', 'a two-agent Console shows a reachable actor selector and becomes ready after choosing one')
  }

  step = 'group create through the UI'
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-list]\') !== null || document.querySelector(\'[data-group-empty]\') !== null', 'group list or empty state rendered')
  await fill(browser, sessionId, '[data-group-input="group-create-name"]', groupName)
  await evaluate(browser, sessionId, '(() => { const node = document.querySelector(\'[data-group-create] button\'); if (node) node.click(); return node !== null })()')
  const createdId = await waitDom(browser, sessionId, `(() => { const row = Array.from(document.querySelectorAll('[data-group-item]')).find(candidate => candidate.dataset.groupName === ${JSON.stringify(groupName)}); return row === undefined ? null : row.dataset.groupItem })()`, 'created group row rendered')
  check('group create', `the real UI created group ${createdId} (${groupName}) through the typed Console route`)
  record('uiGroupId', createdId)

  step = 'message through the UI'
  await click(browser, sessionId, `[data-group-item="${createdId}"]`)
  await waitDom(browser, sessionId, `document.querySelector('[data-group-selected-id]')?.dataset.groupSelectedId === ${JSON.stringify(createdId)}`, 'selected group detail rendered')

  step = 'invite and grant through the UI'
  await fill(browser, sessionId, '[data-group-input="invite-agent"]', AGENT_B)
  await fill(browser, sessionId, '[data-group-input="invite-role"]', 'peer')
  const inviteGate = await openRequestGate(browser, sessionId, frame => frame.kind === 'group.invite')
  await click(browser, sessionId, '[data-group-invite-action]')
  const inviteRequest = await inviteGate.waitFor(1)
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-outcome="pending"]\') !== null', 'the invite is pending before the owner answers')
  await inviteGate.continueRequest(inviteRequest.requestId)
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-outcome="succeeded"]\') !== null', 'the invite owner reply is visible before B accepts')
  await inviteGate.close()
  const uiAccepted = await socketRequest(agentBSocket, frame({ kind: 'group.respond', groupId: createdId, accept: true }))
  assert(replyError(uiAccepted) === undefined, `agent B accepts the UI-created invitation (${JSON.stringify(replyError(uiAccepted))})`)
  // The owner workspace must reflect the acceptance without a user identity switch or
  // manual reload. Wait a bounded real-user window; switch only to continue if it fails.
  let membershipRefreshed = false
  try {
    await waitDom(browser, sessionId, `document.querySelector('[data-group-member="${AGENT_B}"]') !== null`, 'the invited member appears without switching identity', 8_000)
    membershipRefreshed = true
  } catch {}
  if (!membershipRefreshed) {
    gap('membership refresh', 'after B accepts, the owner workspace does not refresh its member list within 8s; this replay switched actors to continue')
    await setActor(browser, sessionId, AGENT_B)
    await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-actor]\')?.dataset.groupActor === "groups-b"', 'the invited actor is selectable')
    await setActor(browser, sessionId, AGENT_A)
    await waitDom(browser, sessionId, `document.querySelector('[data-group-member="${AGENT_B}"]') !== null`, 'the invited member appears after reload')
  } else {
    check('membership refresh', 'B acceptance appears in the owner member list without switching identity')
  }
  await click(browser, sessionId, `[data-group-grant="${AGENT_B}"]`)
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-outcome="succeeded"]\') !== null', 'the grant owner reply is visible before the edge check')
  const uiGranted = await socketRequest(agentASocket, frame({ kind: 'group.list' }))
  assert(replyError(uiGranted) === undefined && uiGranted.groups.some(group => group.groupId === createdId
    && group.members.some(member => member.agentId === AGENT_A && member.mastersOf.includes(AGENT_B))),
    `the owner edge is stored on A after the UI grant (${JSON.stringify(replyError(uiGranted))})`)
  check('invite and grant', `the UI invited ${AGENT_B}, B accepted through the real socket, and the owner granted the command edge`)

  await fill(browser, sessionId, '[data-group-composer-input]', messageBody)
  await click(browser, sessionId, '[data-group-send]')
  await waitDom(browser, sessionId, `Array.from(document.querySelectorAll('[data-group-message]')).some(node => node.innerText.includes(${JSON.stringify(messageBody)}))`, 'sent message rendered from the owner reply')
  check('message send', `the UI sent "${messageBody}" and rendered the owner reply`)

  step = 'issue through the UI'
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-issue-panel]\') !== null', 'issue panel rendered')
  const issueTitle = `accept-issue-${Date.now()}`
  await fill(browser, sessionId, '[data-group-input="issue-title"]', issueTitle)
  await fill(browser, sessionId, '[data-group-input="issue-body"]', 'issue created by the real Console UI')
  await fill(browser, sessionId, '[data-group-input="issue-project"]', VIKUNJA_PROJECT)
  await click(browser, sessionId, '[data-group-issue-action="create"]')
  const issueSession = await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-issue-session]\')?.dataset.groupIssueSession ?? null', 'issue session rendered after real Vikunja create', 60_000)
  check('issue create', `the UI created a real Vikunja issue session ${issueSession}`)
  const tasks = await vikunja('GET', `/api/v1/projects/${encodeURIComponent(VIKUNJA_PROJECT)}/tasks`)
  const task = Array.isArray(tasks) ? tasks.find(candidate => candidate.title === issueTitle) : undefined
  assert(task !== undefined, 'Vikunja holds the issue the UI created')
  await waitDom(browser, sessionId, `document.querySelector('[data-group-input="action-assignee"] option[value="${AGENT_B}"]') !== null`, 'the granted member becomes a real assignee option once the issue is open')

  step = 'action through the UI'
  await fill(browser, sessionId, '[data-group-input="action-assignee"]', AGENT_B)
  await fill(browser, sessionId, '[data-group-input="action-reason"]', 'verify the action path')
  await fill(browser, sessionId, '[data-group-input="action-expected"]', 'a confirmed result comment')
  await click(browser, sessionId, '[data-group-action-create]')
  const actionId = await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-action]\')?.dataset.groupAction ?? null', 'action row rendered after owner reply')
  check('action create', `the UI created action ${actionId} for ${AGENT_B}`)

  await selectGroupAndOpenIssue(browser, sessionId, AGENT_B, createdId, issueSession)
  await waitDom(browser, sessionId, `document.querySelector('[data-group-action="${actionId}"]') !== null`, 'the assignee sees the action after reopening the issue')
  await fill(browser, sessionId, `[data-group-input="action-result-${actionId}"]`, 'result from the assignee')
  await click(browser, sessionId, `[data-group-action="${actionId}"] [data-group-action-verb="submit"]`)
  await waitDom(browser, sessionId, `document.querySelector('[data-group-action="${actionId}"]')?.dataset.groupActionState === 'completed'`, 'action reaches completed after the assignee result', 60_000)
  check('action submit', `${AGENT_B} submitted the action and the owner reply shows completed`)
  const comments = await vikunja('GET', `/api/v1/tasks/${task.id}/comments`)
  assert(Array.isArray(comments) && comments.some(comment => String(comment.comment ?? '').includes('result from the assignee')), 'the action result was written back to the real Vikunja issue')

  step = 'unstopped close feedback through the UI'
  await selectGroupAndOpenIssue(browser, sessionId, AGENT_A, createdId, issueSession)
  await fill(browser, sessionId, '[data-group-input="action-assignee"]', AGENT_B)
  await fill(browser, sessionId, '[data-group-input="action-reason"]', 'leave this action unfinished before close')
  await fill(browser, sessionId, '[data-group-input="action-expected"]', 'must stay visible after close')
  await click(browser, sessionId, '[data-group-action-create]')
  const actionIds = await waitDom(browser, sessionId, `(() => {
    const ids = Array.from(document.querySelectorAll('[data-group-action]')).map(node => node.dataset.groupAction)
    return ids.length >= 2 ? ids : null
  })()`, 'the unfinished action row is rendered before close')
  const unfinishedActionId = actionIds.find(id => id !== actionId)
  assert(unfinishedActionId !== undefined, 'the unfinished action is distinct from the completed action')
  await fill(browser, sessionId, '[data-group-input="issue-reason"]', 'acceptance complete')
  await fill(browser, sessionId, '[data-group-input="issue-conclusion"]', 'the real UI path works')
  await click(browser, sessionId, '[data-group-issue-action="close"]')
  await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-confirm-accept]\') !== null', 'critical close asks for confirmation')

  let stopFact = false
  let stopDetail = null
  try {
    await click(browser, sessionId, '[data-group-confirm-accept]')
    await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-issue-panel]\')?.dataset.groupIssueState === "closed"', 'issue closes after the owner reply', 60_000)
    const closedState = await evaluate(browser, sessionId, `(() => {
      const action = document.querySelector('[data-group-action="${unfinishedActionId}"]')
      const items = Array.from(document.querySelectorAll('[data-group-unstopped-item]'))
      return {
        actionState: action?.dataset.groupActionState ?? null,
        count: items.length,
        text: items.map(node => node.innerText).join('\\n'),
      }
    })()`)
    assert(closedState.actionState === 'cancelled', `pending action is cancelled by close (${JSON.stringify(closedState)})`)
    assert(!closedState.text.includes(unfinishedActionId), `pending cancellation does not falsely report an unstopped action (${JSON.stringify(closedState)})`)
    stopFact = true
  } catch (error) {
    stopDetail = error instanceof Error ? error.message : String(error)
    gap('pending close stop fact', stopDetail)
    const stillOpen = await evaluate(browser, sessionId, 'document.querySelector(\'[data-group-confirm-accept]\') !== null')
    if (stillOpen) {
      await click(browser, sessionId, '[data-group-confirm-accept]')
      await waitDom(browser, sessionId, 'document.querySelector(\'[data-group-issue-panel]\')?.dataset.groupIssueState === "closed"', 'issue closes after the owner reply', 60_000)
    }
  }
  if (stopFact) {
    check('pending close stop fact', `the UI showed ${unfinishedActionId} as cancelled after close and did not report a false unstopped action`)
  }

  step = 'issue close through the UI'
  const closedTask = await vikunja('GET', `/api/v1/tasks/${task.id}`)
  assert(closedTask.done === true, 'the real Vikunja task is done after the UI close')
  assert(String(closedTask.description ?? '').includes('[agentteams:'), 'closing preserved the issue description and its stable reference')
  check('issue close', 'the UI closed the issue through confirmation and preserved the description')

  step = 'layout 1440x900'
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId)
  await sleep(500)
  const desktop = await evaluate(browser, sessionId, `(() => { const rect = document.querySelector('[data-group-composer-input]')?.getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth - window.innerWidth, visible: rect !== undefined && rect.width > 0 && rect.height > 0 && rect.bottom <= window.innerHeight + 1 } })()`)
  assert(desktop.overflow <= 0, `desktop has no horizontal overflow (overflow=${desktop.overflow})`)
  assert(desktop.visible, 'desktop composer is visible in the viewport')
  await screenshot(browser, sessionId, join(evidenceDirectory, 'desktop-1440x900.png'))
  check('desktop layout', '1440x900: no horizontal overflow and composer visible')

  await runNegativeReplays(browser, sessionId, createdId, socketGroupId, messageBody)

  step = 'layout 390x844'
  await browser.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId)
  await sleep(700)
  const mobile = await evaluate(browser, sessionId, `(() => { const rect = document.querySelector('[data-group-composer-input]')?.getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth - window.innerWidth, visible: rect !== undefined && rect.width > 0 && rect.height > 0 && rect.bottom <= window.innerHeight + 1 } })()`)
  assert(mobile.overflow <= 0, `mobile has no horizontal overflow (overflow=${mobile.overflow})`)
  if (!mobile.visible) {
    gap('mobile composer above fold', `390x844: composer rect is below the fold; ${JSON.stringify(mobile)}`)
  } else {
    check('mobile layout', '390x844: no horizontal overflow and composer visible')
  }

  step = 'mobile navigation'
  const mobileGroupReady = await evaluate(browser, sessionId, `(() => {
    const group = document.querySelector('[data-group-mobile-group]')
    return group !== null && group.tagName === 'SELECT' && group.options.length >= 2
  })()`)
  if (!mobileGroupReady) {
    gap('mobile group dropdown', '390x844: no data-group-mobile-group select with the real group choices; the vertical group list still owns the first screen')
  } else {
    await fill(browser, sessionId, '[data-group-mobile-group]', createdId)
    await waitSelectedGroup(browser, sessionId, createdId, 'the mobile group dropdown selects the real group')
    let mobileIssueReady = false
    try {
      await waitDom(browser, sessionId, `(() => {
        const issue = document.querySelector('[data-group-mobile-issue]')
        return issue !== null && issue.tagName === 'SELECT'
          && Array.from(issue.options).some(option => option.value === ${JSON.stringify(issueSession)})
      })()`, 'the mobile issue dropdown lists the selected group issue', 15_000)
      mobileIssueReady = true
    } catch {}
    if (!mobileIssueReady) {
      gap('mobile issue dropdown', '390x844: no data-group-mobile-issue select listing the real issue session')
    } else {
      await fill(browser, sessionId, '[data-group-mobile-issue]', issueSession)
      await waitDom(browser, sessionId, `document.querySelector('[data-group-issue-session]')?.dataset.groupIssueSession === ${JSON.stringify(issueSession)}`, 'the mobile issue dropdown reopens the real issue', 15_000)
      const mobileChat = await evaluate(browser, sessionId, `(() => {
        const node = document.querySelector('[data-group-messages]')
        if (node === null) return null
        const rect = node.getBoundingClientRect()
        return { top: rect.top, bottom: rect.bottom, visible: rect.top < window.innerHeight && rect.bottom > 0 }
      })()`)
      assert(mobileChat !== null && mobileChat.visible === true, `390x844: the selected group's messages are on the first screen (${JSON.stringify(mobileChat)})`)
      check('mobile navigation', '390x844: group and issue dropdowns switch through the real group/issue path and the conversation is on the first screen')
    }
  }
  await screenshot(browser, sessionId, join(evidenceDirectory, 'mobile-390x844.png'))

  await browser.send('Browser.close').catch(() => undefined)
}

async function main() {
  assert(VIKUNJA_TOKEN.length > 0, 'VIKUNJA_TOKEN is set (the driver never prints it)')
  assert(existsSync(OPENCODE), `OpenCode executable exists at ${OPENCODE}`)
  assert(existsSync(join(repositoryRoot, 'generated', 'runtime-lib')), 'generated/runtime-lib exists; run pnpm build first')
  assert(existsSync(join(repositoryRoot, 'ui', 'teams-console', 'lib', 'browser.js')), 'the compiled UI exists; run pnpm build first')
  // Unix socket paths are limited to ~104 bytes on macOS, so the fixture root
  // must stay short enough to hold <root>/agent-a/state/agent-messaging.sock.
  ownedRoot = mkdtempSync('/tmp/group-webui-accept-')
  logDirectory = join(ownedRoot, 'logs')
  mkdirSync(logDirectory, { recursive: true })
  const home = join(ownedRoot, 'home')
  mkdirSync(home, { recursive: true })
  record('root', ownedRoot)

  provider = await startStubProvider()
  const tls = generateTls(ownedRoot, 'registry')
  const registryPort = await availablePort('127.0.0.1')
  const controlPort = await availablePort('127.0.0.1')
  const portA = await availablePort('127.0.0.1')
  const portB = await availablePort('127.0.0.1')
  registryConfigPath = join(ownedRoot, 'registry.toml')
  controlConfigPath = join(ownedRoot, 'control.toml')
  const configA = join(ownedRoot, 'agent-a.toml')
  const configB = join(ownedRoot, 'agent-b.toml')
  writeFileSync(registryConfigPath, registryConfig({ directory: join(ownedRoot, 'registry'), port: registryPort, keyPath: tls.keyPath, certPath: tls.certPath }))
  writeFileSync(configA, agentConfig({ id: AGENT_A, hostId: HOST_A, directory: join(ownedRoot, 'agent-a'), port: portA, registryPort, trustPath: tls.certPath }))
  writeFileSync(configB, agentConfig({ id: AGENT_B, hostId: HOST_B, directory: join(ownedRoot, 'agent-b'), port: portB, registryPort, trustPath: tls.certPath }))
  writeFileSync(controlConfigPath, controlConfig({ directory: join(ownedRoot, 'control'), port: controlPort, registryPort, trustPath: tls.certPath }))
  const env = { HOME: home, GROUPS_CRED_A: CREDENTIALS.a, GROUPS_CRED_B: CREDENTIALS.b, GROUPS_CRED_CONTROL: CREDENTIALS.control, GROUPS_CRED_PEER: CREDENTIALS.peer, GROUPS_PROVIDER_KEY: CREDENTIALS.provider, GROUPS_VIKUNJA_TOKEN: VIKUNJA_TOKEN, [PASSWORD_ENV]: PASSWORD }

  step = 'registry'
  runCli(['registry', 'start', '--config', registryConfigPath], env)
  const registryStatus = parseFields(runCli(['registry', 'status', '--config', registryConfigPath], env).trim())
  assert(registryStatus.state === 'running', `the registry reports running (${registryStatus.state})`)
  record('registry', { pid: Number(registryStatus.pid), endpoint: `wss://127.0.0.1:${registryPort}` })

  step = 'agent A'
  const entryA = spawnAgent({ label: 'agent-a', port: portA, configPath: configA, env })
  const fieldsA = await awaitReady(entryA)
  await awaitRegistrationOnline(entryA)
  record('agentA', { pid: entryA.child.pid, listener: fieldsA.listener })
  step = 'agent B'
  const entryB = spawnAgent({ label: 'agent-b', port: portB, configPath: configB, env })
  const fieldsB = await awaitReady(entryB)
  await awaitRegistrationOnline(entryB)
  record('agentB', { pid: entryB.child.pid, listener: fieldsB.listener })

  const socketA = join(ownedRoot, 'agent-a', 'state', 'agent-messaging.sock')
  const socketB = join(ownedRoot, 'agent-b', 'state', 'agent-messaging.sock')
  await awaitFile(socketA, 'agent A group socket')
  await awaitFile(socketB, 'agent B group socket')
  const recordPathFor = agentId => join(home, '.agentteams', 'sessions', ACCOUNT, SCOPE, agentId, 'local-group-endpoint.json')
  await awaitFile(recordPathFor(AGENT_A), 'agent A local group endpoint record')
  await awaitFile(recordPathFor(AGENT_B), 'agent B local group endpoint record')
  const publishedA = JSON.parse(readFileSync(recordPathFor(AGENT_A), 'utf8'))
  assert(publishedA.groupEndpoint?.socketPath === socketA, `agent A published the socket it really bound (${publishedA.groupEndpoint?.socketPath})`)
  check('endpoint publication', 'both agent daemons published their own local group endpoint records')

  step = 'control'
  const controlStart = parseFields(runCli(['control', 'start', '--config', controlConfigPath], env).trim())
  assert(controlStart.state === 'running', `the control daemon reports running (${controlStart.state})`)
  controlOrigin = `http://127.0.0.1:${controlPort}`
  record('control', { pid: Number(controlStart.pid), origin: controlOrigin })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { const response = await fetch(`${controlOrigin}/api/v1/projection`); if (response.status === 401) break } catch { /* still binding */ }
    await sleep(200)
  }
  const authenticated = await fetch(`${controlOrigin}/api/v1/projection`, { headers: { authorization: BASIC } })
  assert(authenticated.status === 200, `the Console projection is readable with the declared credential (${authenticated.status})`)
  const projection = await authenticated.json()
  const projectedAgents = (projection.agents ?? []).map(agent => agent.agentId)
  assert(projectedAgents.includes(AGENT_A) && projectedAgents.includes(AGENT_B), `the Console projection lists both agent daemons (${projectedAgents.join(',')})`)
  check('console projection', `the real Console discovers both agents (${projectedAgents.join(',')})`)

  step = 'group create via owner socket'
  const created = await socketRequest(socketA, frame({ kind: 'group.create', name: 'acceptance group' }))
  assert(replyError(created) === undefined, `group.create is accepted (${JSON.stringify(replyError(created))})`)
  assert(created.kind === 'group.created', `group.create returns group.created (${created.kind})`)
  const groupId = created.group.groupId
  record('groupId', groupId)

  step = 'invite and accept'
  const invited = await socketRequest(socketA, frame({ kind: 'group.invite', groupId, agentId: AGENT_B, role: 'peer' }))
  assert(replyError(invited) === undefined, `group.invite is accepted (${JSON.stringify(replyError(invited))})`)
  const accepted = await socketRequest(socketB, frame({ kind: 'group.respond', groupId, accept: true }))
  assert(replyError(accepted) === undefined, `group.respond accept is accepted (${JSON.stringify(replyError(accepted))})`)
  const granted = await socketRequest(socketA, frame({ kind: 'group.grant', groupId, agentId: AGENT_A, role: 'master', mastersOf: [AGENT_B] }))
  assert(replyError(granted) === undefined, `group.grant is accepted (${JSON.stringify(replyError(granted))})`)
  assert(granted.kind === 'group.member' && granted.group.members.some(member => member.agentId === AGENT_A && member.mastersOf.includes(AGENT_B)), 'the owner granted the real command edge')
  const listB = await socketRequest(socketB, frame({ kind: 'group.list' }))
  assert(listB.kind === 'group.list' && listB.groups.some(group => group.groupId === groupId), 'the invited agent now lists the group')
  check('membership', `${AGENT_B} accepted the invitation and lists the group as a member`)

  step = 'messages'
  const sent = await socketRequest(socketA, frame({ kind: 'message.send', commitId: `commit-${Date.now()}`, groupId, targetAgentIds: [AGENT_B], replyRequired: false, body: 'hello from agent A' }))
  assert(replyError(sent) === undefined, `message.send is accepted (${JSON.stringify(replyError(sent))})`)
  const page = await socketRequest(socketB, frame({ kind: 'message.page', groupId }))
  assert(page.kind === 'message.page' && page.messages.some(message => message.body === 'hello from agent A'), 'agent B reads the message through the real owner page')
  check('message page', 'a message sent by A is read back by B through the owner')

  step = 'issue create'
  const issueTitle = `owner-issue-${Date.now()}`
  const issue = await socketRequest(socketA, frame({ kind: 'issue.create', commitId: `issue-${Date.now()}`, groupId, vikunjaProjectId: VIKUNJA_PROJECT, title: issueTitle, body: 'owner path issue' }))
  assert(replyError(issue) === undefined, `issue.create is accepted (${JSON.stringify(replyError(issue))})`)
  assert(issue.kind === 'issue.session', `issue.create returns issue.session (${issue.kind})`)
  const issueSessionId = issue.session.sessionId
  const tasks = await vikunja('GET', `/api/v1/projects/${encodeURIComponent(VIKUNJA_PROJECT)}/tasks`)
  const task = Array.isArray(tasks) ? tasks.find(candidate => candidate.title === issueTitle) : undefined
  assert(task !== undefined, 'the real Vikunja project holds the created issue')
  check('issue create (owner)', `the group owner created Vikunja issue ${task.id}`)

  step = 'action lifecycle'
  const actionCreated = await socketRequest(socketA, frame({ kind: 'action.create', commitId: `action-${Date.now()}`, sessionId: issueSessionId, assigneeAgentId: AGENT_B, actionKind: 'comment', reason: 'owner path action', expectedResult: 'a real result comment', replyRequired: true }))
  assert(replyError(actionCreated) === undefined, `action.create is accepted (${JSON.stringify(replyError(actionCreated))})`)
  const actionId = actionCreated.action.actionId
  const submitted = await socketRequest(socketB, frame({ kind: 'action.submit', resultCommitId: `result-${Date.now()}`, actionId, resultBody: 'owner path result' }))
  assert(replyError(submitted) === undefined, `action.submit is accepted (${JSON.stringify(replyError(submitted))})`)
  const comments = await vikunja('GET', `/api/v1/tasks/${task.id}/comments`)
  assert(Array.isArray(comments) && comments.some(comment => String(comment.comment ?? '').includes('owner path result')), 'the action result is written back to Vikunja')
  check('action lifecycle (owner)', 'the assignee submitted the action and Vikunja holds the result comment')

  step = 'issue close preserves the issue body'
  const closed = await socketRequest(socketA, frame({ kind: 'issue.close', commitId: `close-${Date.now()}`, sessionId: issueSessionId, reason: 'owner path complete', conclusion: 'verified' }))
  assert(replyError(closed) === undefined, `issue.close is accepted (${JSON.stringify(replyError(closed))})`)
  const closedTask = await vikunja('GET', `/api/v1/tasks/${task.id}`)
  assert(closedTask.done === true, 'the real Vikunja task is done after close')
  assert(String(closedTask.description ?? '').includes('[agentteams:'), 'close preserved the description and stable reference')
  check('issue close (owner)', 'close set done=true and preserved the issue description')

  step = 'typed refusals'
  const refused = await socketRequest(socketB, frame({ kind: 'issue.close', commitId: `close-${Date.now()}`, sessionId: issueSessionId, reason: 'not the initiator', conclusion: 'should refuse' }))
  assert(refused.kind === 'relay.error' && refused.error.code === 'FORBIDDEN', `a non-initiator close is refused FORBIDDEN (${JSON.stringify(refused)})`)
  check('refusal', 'a non-initiator close is refused with the original typed code')

  step = 'http authentication'
  const anonymous = await groupRequest(AGENT_A, frame({ kind: 'group.list' }), null)
  assert(anonymous.status === 401, `an anonymous group request is refused 401 (${anonymous.status})`)
  step = 'http unknown target'
  const unknown = await groupRequest('no-such-agent', frame({ kind: 'group.list' }))
  assert(unknown.status === 400 && unknown.body?.code === 'INVALID_INPUT', `an undeclared agentId is refused 400 INVALID_INPUT (${JSON.stringify(unknown)})`)
  step = 'http not configured'
  const notConfigured = await groupRequest(AGENT_ABSENT, frame({ kind: 'group.list' }))
  assert(notConfigured.status === 503 && notConfigured.body?.code === 'GROUP_ENDPOINT_NOT_CONFIGURED', `a declared peer without a record is 503 GROUP_ENDPOINT_NOT_CONFIGURED (${JSON.stringify(notConfigured)})`)
  check('http access states', 'anonymous, unknown target and not-configured are three distinct typed outcomes')

  step = 'http group roundtrip'
  const httpList = await groupRequest(AGENT_A, frame({ kind: 'group.list' }))
  assert(httpList.status === 200 && httpList.body?.ok === true && httpList.body.reply.kind === 'group.list', `the Console forwards group.list (${JSON.stringify(httpList.body).slice(0, 200)})`)
  assert(httpList.body.reply.groups.some(group => group.groupId === groupId), 'the Console reply carries the real group')
  const httpPage = await groupRequest(AGENT_B, frame({ kind: 'message.page', groupId }))
  assert(httpPage.status === 200 && httpPage.body?.ok === true, `the Console forwards message.page for B (${JSON.stringify(httpPage.body).slice(0, 200)})`)
  check('http group roundtrip', 'the Console route reaches the real group owner and keeps its reply')

  if (skipBrowser) gap('browser replay', 'skipped by --skip-browser; this run does not claim desktop or mobile UI evidence')
  else await runBrowser(`ui-group-${Date.now()}`, `ui message ${Date.now()}`, socketB, socketA, groupId)

  writeFileSync(join(evidenceDirectory, 'receipt.json'), `${JSON.stringify({ ...receipts, finishedAt: new Date().toISOString(), checks, gaps }, null, 2)}\n`)
  console.log(`\n${checks.length} checks passed; ${gaps.length} gaps`)
}

async function cleanup() {
  for (const entry of spawned.reverse()) {
    if (entry.child?.exitCode !== null && entry.child?.exitCode !== undefined) continue
    try { entry.child.kill('SIGTERM') } catch { /* already gone */ }
  }
  await sleep(1_500)
  for (const entry of spawned) {
    if (entry.child?.exitCode !== null && entry.child?.exitCode !== undefined) continue
    try { entry.child.kill('SIGKILL') } catch { /* already gone */ }
  }
  const env = { HOME: join(ownedRoot ?? '', 'home'), [PASSWORD_ENV]: PASSWORD }
  if (controlConfigPath !== undefined && existsSync(controlConfigPath)) { try { runCli(['control', 'stop', '--config', controlConfigPath], env) } catch { /* recorded by the failing step */ } }
  if (registryConfigPath !== undefined && existsSync(registryConfigPath)) { try { runCli(['registry', 'stop', '--config', registryConfigPath], env) } catch { /* recorded by the failing step */ } }
  if (provider !== undefined) await provider.close().catch(() => undefined)
}

main().then(
  async () => {
    await cleanup()
    if (ownedRoot !== undefined) rmSync(ownedRoot, { recursive: true, force: true })
    process.exit(0)
  },
  async error => {
    console.error(`\n${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
    await cleanup()
    if (ownedRoot !== undefined && keepOnFailure) console.error(`retained owned root: ${ownedRoot}`)
    else if (ownedRoot !== undefined) rmSync(ownedRoot, { recursive: true, force: true })
    process.exit(1)
  },
)
