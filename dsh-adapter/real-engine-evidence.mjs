#!/usr/bin/env node
/**
 * DSH real-engine evidence driver (D03).
 *
 * Owner: dsh-adapter. This is evidence tooling, not a runtime module: it is not
 * part of the runtime build and no product code imports it.
 *
 * It drives the real installed DSH ACP engine through the real D03 adapter and
 * the real D01 runtime, using a real Teams v4 agent config compiled by the real
 * config owner. It prints a JSON receipt and exits non-zero on the first failed
 * gate. Nothing here mocks the engine: when the engine, the config or the
 * credential is missing the run fails explicitly instead of reporting success.
 *
 * Usage:
 *   pnpm build:runtime
 *   node dsh-adapter/real-engine-evidence.mjs --config <agent.toml> [--receipt <path>] [--keep]
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const repoRoot = resolve(here, '..')
const lib = (name) => join(repoRoot, 'generated', 'runtime-lib', name)

const { createDshEngineAdapter, DSH_PATCH_FILE_NAME } = await import(lib('dsh-adapter/index.js'))
const { startAcpAgentDaemon } = await import(lib('runtime/acp-daemon.js'))
const { createAcpHistoryStore } = await import(lib('runtime/acp-history-store.js'))
const { parseDaemonConfigText, resolveDaemonIntent, compileDaemonIntent } = await import(lib('config/daemon-intent.js'))
const { AcpError } = await import(lib('control-protocol/acp.js'))

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? fallback : process.argv[index + 1]
}
const has = (name) => process.argv.includes(`--${name}`)
const sleep = (ms) => new Promise(done => setTimeout(done, ms))

const configPath = arg('config')
if (configPath === undefined) {
  console.error('FAIL: --config <agent.toml> is required; no engine evidence is produced without a real Teams config')
  process.exit(2)
}

const gates = []
let daemon
const workRoot = mkdtempSync(join(tmpdir(), 'd03-real-engine-'))

function finish(code) {
  if (daemon !== undefined) console.error('cleanup: the daemon was not stopped before exit')
  const receipt = {
    generatedAt: new Date().toISOString(),
    engine: 'dsh',
    configPath: resolve(configPath),
    workRoot,
    gates,
  }
  const receiptPath = arg('receipt')
  if (receiptPath !== undefined) writeFileSync(resolve(receiptPath), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt, null, 2))
  process.exit(code)
}
function gate(name, detail) {
  gates.push({ gate: name, result: 'PASS', detail })
  console.log(`PASS ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
function fail(name, detail) {
  gates.push({ gate: name, result: 'FAIL', detail })
  console.error(`FAIL ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
  finish(1)
}

// ── real Teams config: parse -> resolve -> compile ────────────────────────────
const intent = parseDaemonConfigText(readFileSync(resolve(configPath), 'utf8'))
if (intent.daemon.kind !== 'agent') fail('config.kind', `expected an agent daemon config, got ${intent.daemon.kind}`)
const configDirectory = resolve(configPath, '..')
const resolved = resolveDaemonIntent(intent, { configDirectory })
const accepted = compileDaemonIntent(intent, { configDirectory })
gate('config.compile', {
  daemonId: resolved.daemon.id,
  engine: resolved.engine?.kind,
  executable: resolved.engine?.executable,
  workspace: resolved.engine?.workspace,
  acceptedRevision: accepted.acceptedRevision,
  providers: Object.keys(accepted.providers),
  catalogStates: Object.fromEntries(Object.entries(accepted.catalogs).map(([id, catalog]) => [id, `${catalog.state}:${catalog.entries.length}`])),
})
if (resolved.engine?.kind !== 'dsh') fail('config.engine', 'the evidence config must select the dsh engine')

const ownedDirectory = join(workRoot, 'dsh-home')
const adapter = createDshEngineAdapter()
const launchInput = {
  kind: 'dsh',
  executable: resolved.engine.executable,
  workspace: resolved.engine.workspace,
  ownedDirectory,
  target: {
    agentId: resolved.daemon.id,
    targetGeneration: 1,
    acceptedRevision: accepted.acceptedRevision,
    acceptedSourceRevision: accepted.acceptedRevision,
    acceptedSourceHash: 'd03-evidence',
    endpointFingerprint: 'd03-evidence',
  },
  accepted,
  policy: resolved.acp,
}

// ── adapter: real launch spec ────────────────────────────────────────────────
let spec
try {
  spec = await adapter.compileLaunch(launchInput)
} catch (error) {
  fail('adapter.compileLaunch', error instanceof AcpError ? `${error.code}: ${error.message}` : String(error))
}
gate('adapter.compileLaunch', {
  executable: spec.executable,
  args: spec.args,
  cwd: spec.cwd,
  dshHome: spec.env.DSH_HOME,
  permissionMode: spec.env.DSH_PERMISSION_MODE,
  telemetryDisabled: spec.env.DSH_TELEMETRY_DISABLED,
  credentialEnvRefs: spec.credentialEnvRefs,
  files: spec.files.map(file => ({ path: file.path, mode: file.mode, bytes: file.content.length })),
  supportedPolicies: spec.supportedPolicies,
})

// ── credential resolution from the real DSH credential store ────────────────
const credentialStorePath = join(process.env.DSH_HOME ?? join(process.env.HOME, '.dsh'), '.credentials.yaml')
function resolveCredential(reference) {
  if (!existsSync(credentialStorePath)) {
    throw new Error(`no credential store at ${credentialStorePath} for reference ${reference}`)
  }
  const match = new RegExp(`^\\s{2}${reference}:\\s*(\\S+)\\s*$`, 'm').exec(readFileSync(credentialStorePath, 'utf8'))
  if (match === null) throw new Error(`credential reference ${reference} is not present in ${credentialStorePath}`)
  return match[1]
}
for (const reference of Object.values(spec.credentialEnvRefs)) {
  try {
    gate('credential.resolve', { reference, resolved: (await resolveCredential(reference)).length > 0 })
  } catch (error) {
    fail('credential.resolve', String(error))
  }
}

// ── runtime: real child + single bootstrap initialize + host ────────────────
const store = await createAcpHistoryStore({ directory: join(workRoot, 'history') })
const outcome = await startAcpAgentDaemon({
  launch: spec,
  engineInstanceId: 'd03-dsh-engine-1',
  targetGeneration: 1,
  policy: { intent: resolved.acp, adapterMethods: adapter.declaredMethods },
  history: store,
  // ACP `initialize` requires an explicit protocolVersion; the DSH server
  // rejects a request that omits it (observed fault: -32602 Invalid params).
  initialize: { params: { protocolVersion: 1, clientCapabilities: {} }, timeoutMs: 60_000 },
  stopTimeoutMs: 5_000,
  resolveCredential,
})
if (outcome.kind === 'failed') fail('runtime.startAcpAgentDaemon', { fault: outcome.fault, cleanup: outcome.cleanup })
daemon = outcome.daemon
gate('runtime.start', {
  pid: daemon.handle.pid,
  engineInstanceId: daemon.handle.engineInstanceId,
  policyRevision: daemon.policy.revision,
  effective: daemon.policy.effective.length,
  denied: daemon.policy.denied,
  initializeAgentInfo: daemon.initializeResult.result?.agentInfo,
})

const ref = { connectionId: 'd03-connection', channelId: 'd03-channel', targetGeneration: 1, engineInstanceId: 'd03-dsh-engine-1' }
await daemon.host.open({
  ref,
  principal: { accountId: 'd03-account', scopeId: 'd03-scope', agentId: resolved.daemon.id },
  policy: daemon.policy,
})

let cursor = 0
let clientId = 0
const seen = []
const pendingCallbacks = []
async function pump(limit = 200) {
  const page = await daemon.host.read(ref, cursor, limit)
  cursor = page.nextSequence
  for (const delivery of page.frames) {
    seen.push(delivery.frame)
    if (typeof delivery.frame.method === 'string' && Object.hasOwn(delivery.frame, 'id')) pendingCallbacks.push(delivery.frame)
  }
}
async function waitFor(predicate, label, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = seen.find(predicate)
    if (hit !== undefined) return hit
    if (Date.now() > deadline) fail(`wait:${label}`, `timed out after ${timeoutMs}ms`)
    await pump()
    await sleep(120)
  }
}
/**
 * Wait until the engine stops sending frames. A real DSH `session/cancel`
 * produces the cancelled terminal result while late `session/update` frames can
 * still arrive; without this barrier those frames would be attributed to the
 * next prompt's window.
 */
async function drain(quietMs = 3000, maxMs = 90_000) {
  const started = Date.now()
  let lastCount = seen.length
  let lastGrowth = Date.now()
  for (;;) {
    await pump()
    if (seen.length !== lastCount) {
      lastCount = seen.length
      lastGrowth = Date.now()
    }
    if (Date.now() - lastGrowth >= quietMs) return { quiet: true, frames: seen.length }
    if (Date.now() - started >= maxMs) return { quiet: false, frames: seen.length }
    await sleep(200)
  }
}

async function request(method, params) {
  const id = ++clientId
  await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id, method, params } })
  return await waitFor(frame => frame.id === id && typeof frame.method !== 'string', `${method} response`)
}

// The engine raises permission callbacks as deliveries with a host-assigned
// outward id; the client answers with that id. The option ids are the engine's
// and are never rewritten here.
async function answerPermissions(collected, policy) {
  while (pendingCallbacks.length > 0) {
    const callback = pendingCallbacks.shift()
    if (callback.method !== 'session/request_permission') {
      await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id: callback.id, error: { code: -32601, message: `unsupported engine callback ${callback.method}` } } })
      continue
    }
    const options = callback.params?.options ?? []
    const chosen = policy === 'reject' ? undefined : (options.find(option => option.kind === 'allow_once') ?? options.find(option => option.kind === 'allow_always') ?? options[0])
    collected.push({
      toolCall: callback.params?.toolCall?.title ?? null,
      optionIds: options.map(option => option.optionId),
      optionKinds: options.map(option => option.kind),
      selectedOptionId: chosen?.optionId ?? null,
    })
    await daemon.host.receive({
      ...ref,
      frame: {
        jsonrpc: '2.0',
        id: callback.id,
        result: { outcome: chosen === undefined ? { outcome: 'cancelled' } : { outcome: 'selected', optionId: chosen.optionId } },
      },
    })
  }
}

async function runPrompt(text, options = {}) {
  const id = ++clientId
  const from = seen.length
  const permissions = []
  await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId: currentSessionId, prompt: [{ type: 'text', text }] } } })
  if (options.cancelAfterMs !== undefined) {
    await sleep(options.cancelAfterMs)
    await daemon.host.receive({ ...ref, frame: { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: currentSessionId } } })
  }
  const drained = { quiet: true, frames: 0 }
  const deadline = Date.now() + 240_000
  for (;;) {
    await pump()
    await answerPermissions(permissions, options.permissionPolicy ?? 'allow')
    const result = seen.find(frame => frame.id === id && typeof frame.method !== 'string')
    if (result !== undefined) {
      // Drain first so late frames stay inside this prompt's window instead of
      // leaking into the next one, then attribute frames to this prompt.
      const settled = await drain()
      drained.quiet = settled.quiet
      drained.frames = settled.frames
      const frames = seen.slice(from)
      const updates = frames.filter(frame => frame.method === 'session/update').map(frame => frame.params?.update ?? {})
      return {
        stopReason: result.result?.stopReason ?? null,
        error: result.error ?? null,
        assistantText: updates.filter(update => update.sessionUpdate === 'agent_message_chunk').map(update => update.content?.text ?? '').join(''),
        updateKinds: [...new Set(updates.map(update => update.sessionUpdate))],
        toolCalls: updates.filter(update => typeof update.sessionUpdate === 'string' && update.sessionUpdate.startsWith('tool_call')).map(update => ({ kind: update.sessionUpdate, title: update.title ?? null, status: update.status ?? null })),
        permissions,
        drained,
      }
    }
    if (Date.now() > deadline) fail('session/prompt', `timed out waiting for a real prompt result: ${text}`)
    await sleep(150)
  }
}

// ── channel admission: the host serves the captured engine initialize ───────
const clientInitialize = await request('initialize', { protocolVersion: 1, clientCapabilities: {} })
gate('channel.initialize', {
  agentInfo: clientInitialize.result?.agentInfo,
  agentCapabilities: clientInitialize.result?.agentCapabilities,
})

// ── real session/new, then the real effectiveness proof ─────────────────────
const created = await request('session/new', { cwd: resolved.engine.workspace, mcpServers: [] })
const currentSessionId = created.result?.sessionId
if (typeof currentSessionId !== 'string') fail('session/new', `no sessionId in ${JSON.stringify(created)}`)
const modelOption = (created.result?.configOptions ?? []).find(option => option.id === 'model')
gate('session/new', {
  sessionId: currentSessionId,
  configOptionIds: (created.result?.configOptions ?? []).map(option => option.id),
  modelOptionValue: modelOption?.currentValue ?? null,
})

try {
  const proof = await adapter.verifyEffective({
    handle: daemon.handle,
    launch: launchInput,
    initializeResult: daemon.initializeResult,
    sessionConfigResult: created,
  })
  gate('adapter.verifyEffective', proof)
} catch (error) {
  fail('adapter.verifyEffective', error instanceof AcpError ? `${error.code}: ${error.message}` : String(error))
}

// ── real prompt: process + reply + terminal result ─────────────────────────
const reply = await runPrompt('Reply with exactly: DSH-ACP-OK')
if (reply.assistantText.length === 0) fail('session/prompt.reply', `the engine returned no assistant text: ${JSON.stringify(reply)}`)
gate('session/prompt', reply)

// ── real cancel: a prompt cancelled while in flight ────────────────────────
const cancelled = await runPrompt('Count from 1 to 400, one number per line, then summarize.', { cancelAfterMs: 1500 })
if (cancelled.stopReason !== 'cancelled') fail('session/cancel', `expected the engine's cancelled terminal state, got ${JSON.stringify(cancelled)}`)
// A real DSH cancel emits the `cancelled` terminal result and may still deliver
// late `session/update` frames afterwards. The drain above is the barrier that
// keeps those frames out of the next prompt; the byte count records how much the
// engine produced after the terminal result.
gate('session/cancel', {
  stopReason: cancelled.stopReason,
  error: cancelled.error,
  lateTextBytesAfterTerminalResult: cancelled.assistantText.length,
  drainedQuiet: cancelled.drained.quiet,
})

// ── real config-option mutation (the adapter-declared extension) ───────────
const setOption = await request('session/set_config_option', { sessionId: currentSessionId, configId: 'model', value: modelOption.currentValue })
const setModelValue = (setOption.result?.configOptions ?? []).find(option => option.id === 'model')?.currentValue ?? null
if (setModelValue !== modelOption.currentValue) fail('session/set_config_option', `the engine reported ${String(setModelValue)} after selecting ${String(modelOption.currentValue)}`)
gate('session/set_config_option', { configOptionIds: (setOption.result?.configOptions ?? []).map(option => option.id), modelOptionValue: setModelValue })

// ── native policy side effects: workspace sandbox + permission option ids ──
const insidePath = join(resolved.engine.workspace, 'd03-inside-probe.txt')
const outsidePath = join(homedir(), 'd03-outside-probe.txt')
rmSync(insidePath, { force: true })
rmSync(outsidePath, { force: true })
const inside = await runPrompt(`Use your shell tool to run exactly this command: printf d03-inside > ${insidePath} . Then reply DONE.`)
// The engine may refuse an outside write at the sandbox layer instead of asking
// for approval, and the retry that produces the approval request is the model's
// own choice. The prompt therefore asks for the escalation explicitly, so the
// approval path is exercised on purpose rather than by luck.
const outside = await runPrompt(`Use your shell tool to run exactly this command: printf d03-outside > ${outsidePath} . The workspace-write sandbox may deny this because the path is outside the session workspace; if it does, request permission to run the command outside the sandbox, run it again after that permission is granted, and then reply DONE.`)
const nativePolicy = {
  inside: { created: existsSync(insidePath), permissions: inside.permissions, toolCalls: inside.toolCalls, stopReason: inside.stopReason },
  outside: { created: existsSync(outsidePath), permissions: outside.permissions, toolCalls: outside.toolCalls, stopReason: outside.stopReason },
}
for (const entry of [...inside.permissions, ...outside.permissions]) {
  if (entry.optionIds.length === 0 || entry.optionIds.some(id => typeof id !== 'string' || id.length === 0)) {
    fail('native.permission.optionIds', `the engine offered a permission prompt without usable option ids: ${JSON.stringify(entry)}`)
  }
  if (entry.selectedOptionId !== null && !entry.optionIds.includes(entry.selectedOptionId)) {
    fail('native.permission.optionIds', `the selected option id is not one the engine offered: ${JSON.stringify(entry)}`)
  }
}
if (!nativePolicy.inside.created) {
  fail('native.policy.workspace', `a command writing inside the session workspace did not create ${insidePath}: ${JSON.stringify(inside)}`)
}
// The engine gates an outside write either with a real approval request or at
// the sandbox layer; which one it picks varies with the tool invocation. Both
// are correct policy outcomes, so the invariant asserted here is the one that
// must never break: the write only lands when the controller really allowed it.
if (nativePolicy.outside.created) {
  if (outside.permissions.length === 0) {
    fail('native.policy.workspace', `the workspace-write sandbox allowed a write outside the workspace with no approval request: ${outsidePath}`)
  }
  if (outside.permissions.every(entry => entry.selectedOptionId === null)) {
    fail('native.policy.permission', `the write landed although the controller selected no option: ${JSON.stringify(outside.permissions)}`)
  }
}
gate('native.policy', nativePolicy)
rmSync(insidePath, { force: true })
rmSync(outsidePath, { force: true })

// The mirror case: a controller rejection must never release the gated write,
// whether the engine asks for approval or the sandbox refuses on its own.
const rejectedPath = join(homedir(), 'd03-rejected-probe.txt')
rmSync(rejectedPath, { force: true })
const rejected = await runPrompt(`Use your shell tool to run exactly this command: printf d03-rejected > ${rejectedPath} . The workspace-write sandbox may deny this because the path is outside the session workspace; if it does, request permission to run the command outside the sandbox and run it again, then reply DONE.`, { permissionPolicy: 'reject' })
if (rejected.permissions.some(entry => entry.selectedOptionId !== null)) fail('native.policy.reject', `a rejecting controller still selected an option: ${JSON.stringify(rejected.permissions)}`)
if (existsSync(rejectedPath)) fail('native.policy.reject', `a rejected approval still performed the gated write: ${rejectedPath}`)
gate('native.policy.reject', { permissions: rejected.permissions, created: false, stopReason: rejected.stopReason })
rmSync(rejectedPath, { force: true })

// ── real session management: list / close / list / resume ──────────────────
const beforeClose = await request('session/list', {})
const beforeIds = (beforeClose.result?.sessions ?? []).map(row => row.sessionId)
const filtered = await request('session/list', { cwd: resolved.engine.workspace })
const filteredIds = (filtered.result?.sessions ?? []).map(row => row.sessionId)
const closed = await request('session/close', { sessionId: currentSessionId })
const afterClose = await request('session/list', {})
const afterIds = (afterClose.result?.sessions ?? []).map(row => row.sessionId)
const resumed = await request('session/resume', { sessionId: currentSessionId, cwd: resolved.engine.workspace, mcpServers: [] })
// ACP `session/resume` answers with configuration options only; the addressed
// session id is the client's own request id and is not echoed back.
if (resumed.error !== undefined) fail('session/resume', JSON.stringify(resumed.error))
const resumedModel = (resumed.result?.configOptions ?? []).find(option => option.id === 'model')?.currentValue ?? null
if (resumedModel !== modelOption.currentValue) {
  fail('session/resume', `the resumed session reports ${String(resumedModel)} instead of the derived ${String(modelOption.currentValue)}`)
}
gate('session.management', {
  listBeforeClose: { count: beforeIds.length, containsCreated: beforeIds.includes(currentSessionId) },
  listFilteredByCwd: { count: filteredIds.length, containsCreated: filteredIds.includes(currentSessionId) },
  close: closed.result ?? null,
  listAfterClose: { count: afterIds.length, containsCreated: afterIds.includes(currentSessionId) },
  resume: { configOptionIds: (resumed.result?.configOptions ?? []).map(option => option.id), modelOptionValue: resumedModel },
})

// ── engine-owned storage isolation ─────────────────────────────────────────
const sessionsRoot = join(ownedDirectory, 'sessions')
const profileRoot = join(ownedDirectory, 'profiles', 'acp')
if (!existsSync(sessionsRoot)) fail('dsh.home.sessions', `no engine session store under ${sessionsRoot}`)
if (!existsSync(profileRoot)) fail('dsh.home.profile', `no materialized acp profile under ${profileRoot}`)
if (!existsSync(join(ownedDirectory, DSH_PATCH_FILE_NAME))) fail('dsh.home.patch', `derived patch file missing under ${ownedDirectory}`)
gate('dsh.home', {
  home: ownedDirectory,
  profileEntries: readdirSync(profileRoot).sort(),
  sessionEntries: readdirSync(sessionsRoot).length,
  patchFile: DSH_PATCH_FILE_NAME,
})

// ── stop + reap ────────────────────────────────────────────────────────────
const pid = daemon.handle.pid
const stopped = await daemon.stop()
daemon = undefined
gate('runtime.stop', stopped)
if (stopped.kind !== 'exited') fail('runtime.stop.exited', `engine exit was not confirmed: ${JSON.stringify(stopped)}`)
if (spawnSync('ps', ['-p', String(pid), '-o', 'pid='], { encoding: 'utf8' }).stdout.trim() !== '') {
  fail('runtime.stop.reap', `pid ${pid} still exists after stop`)
}
gate('runtime.stop.reap', { pid, gone: true })

const historyPage = await store.query({ version: 1, limit: 100 })
gate('history.readback', {
  records: historyPage.records.length,
  events: [...new Set(historyPage.records.map(record => record.event))],
})

if (!has('keep')) {
  rmSync(workRoot, { recursive: true, force: true })
  gate('resource.cleanup', { removed: workRoot })
} else {
  gate('resource.cleanup', { retained: workRoot })
}
finish(0)
