#!/usr/bin/env node
/**
 * D03 black-box driver: the real `agentteams --serve dsh` user entry.
 *
 * It runs the installed CLI as a real child process against a v4 agent config
 * whose engine is the real installed DSH ACP server (`/opt/homebrew/bin/dsh`),
 * then proves:
 *   1. exactly one agent daemon and exactly one DSH engine child exist;
 *   2. the entry's readiness line reports the accepted model verified from the
 *      engine's own session/new (`["teams-workbuddy","wb-deepseek-v4.1-flash"]`);
 *   3. a real prompt reaches the configured provider route and returns real
 *      inference (this is a live provider call, not a stub);
 *   4. a real cancel ends an in-flight prompt with stopReason cancelled;
 *   5. the entry stops by explicit PID, reaps the DSH engine child and removes
 *      its owned DSH_HOME (the derived patch file and the engine session store);
 *   6. the live engine child's own `DSH_HOME` is the daemon-owned directory
 *      (read back from the running process), so the real `~/.dsh` was never the
 *      engine home.
 *
 * This driver is the DSH sibling of
 * `docs/evidence/acp-d02-integration-20261010/black-box-serve.mjs` and uses the
 * same frame codec shape. It reuses exactly the credential/route facts that
 * `dsh-adapter/real-engine-evidence.mjs` uses: the Teams provider route is the
 * D03 evidence config (`openai-responses` through the configured proxy), and the
 * credential value is read from the real DSH credential store
 * (`~/.dsh/.credentials.yaml`, entry `DEEPSEEK_FLASH_API_KEY`) and passed to the
 * entry through the environment, which is what the entry's
 * `resolveCredentialReference` expects. No secret is printed.
 *
 * Usage: node docs/evidence/acp-d03-serve-20261010/black-box-serve-dsh.mjs
 * Env:   AGENTTEAMS_CLI          run another copy of the entry, e.g. an installed
 *                                node_modules/agentteams/cli/agentteams.mjs
 *        DSH_EXECUTABLE          default /opt/homebrew/bin/dsh
 *        D03_PROVIDER_BASE_URL   default the D03 evidence proxy route
 *        D03_PROVIDER_MODEL      default wb-deepseek-v4.1-flash
 *        D03_CREDENTIAL_REF      default DEEPSEEK_FLASH_API_KEY
 *        DSH_CREDENTIALS_FILE    default $DSH_HOME/.credentials.yaml or ~/.dsh/.credentials.yaml
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createConnection, createServer as createNetServer } from 'node:net'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const installedCli = process.env.AGENTTEAMS_CLI
const CLI = installedCli ?? join(repositoryRoot, 'cli', 'agentteams.mjs')
const CLI_ROOT = installedCli === undefined ? repositoryRoot : resolve(dirname(installedCli), '..')
const DSH = process.env.DSH_EXECUTABLE ?? '/opt/homebrew/bin/dsh'
const PROVIDER_BASE_URL = process.env.D03_PROVIDER_BASE_URL ?? 'https://api.xyxl1225.online/8318/v1'
const PROVIDER_MODEL = process.env.D03_PROVIDER_MODEL ?? 'wb-deepseek-v4.1-flash'
const CREDENTIAL_REF = process.env.D03_CREDENTIAL_REF ?? 'DEEPSEEK_FLASH_API_KEY'
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.HOME, '.dsh')
const CREDENTIALS_FILE = process.env.DSH_CREDENTIALS_FILE ?? join(DSH_HOME, '.credentials.yaml')
const REAL_DSH_HOME = join(process.env.HOME, '.dsh')

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

/**
 * The real environment of one live process, read back with `ps -E`.
 *
 * Only the named variables are returned, so no credential value from the
 * environment is ever printed or stored.
 */
function environmentOf(pid, names) {
  const output = execFileSync('ps', ['-E', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
  const values = {}
  for (const token of output.split(/\s+/)) {
    const separator = token.indexOf('=')
    if (separator <= 0) continue
    const name = token.slice(0, separator)
    if (names.includes(name)) values[name] = token.slice(separator + 1)
  }
  return values
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

/** Read the real DSH credential value; the value is never printed. */
function readCredential(reference) {
  if (!existsSync(CREDENTIALS_FILE)) {
    throw new Error(`no DSH credential store at ${CREDENTIALS_FILE}; --serve dsh needs a real credential for ${reference}`)
  }
  const match = new RegExp(`^\\s{2}${reference}:\\s*(\\S+)\\s*$`, 'm').exec(readFileSync(CREDENTIALS_FILE, 'utf8'))
  if (match === null) throw new Error(`credential reference ${reference} is not present in ${CREDENTIALS_FILE}`)
  return match[1]
}

function agentConfig({ port, dataDirectory, workspace }) {
  return `version = 4

[daemon]
kind = "agent"
id = "reasoner-dsh"
hostId = "host-a"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(dataDirectory)}

[engine]
kind = "dsh"
executable = ${JSON.stringify(DSH)}
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

[providers.workbuddy]
label = "Workbuddy Gateway"
protocol = "openai-responses"
apiBaseUrl = ${JSON.stringify(PROVIDER_BASE_URL)}
credentialEnv = ${JSON.stringify(CREDENTIAL_REF)}

[[models]]
provider = "workbuddy"
id = ${JSON.stringify(PROVIDER_MODEL)}
label = "WB DeepSeek V4.1 Flash"

[model.primary]
provider = "workbuddy"
model = ${JSON.stringify(PROVIDER_MODEL)}
`
}

/** Minimal ACP client: newline-delimited JSON-RPC over the entry's listener. */
function connectClient(port) {
  return new Promise((resolveConnect, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    let buffer = ''
    const frames = []
    const seen = []
    const waiters = []
    socket.on('error', error => reject(error))
    socket.on('connect', () => resolveConnect({
      send: frame => new Promise(resolveSend => socket.write(`${JSON.stringify(frame)}\n`, resolveSend)),
      awaitFrame: (match, timeoutMs = 240_000) => new Promise((resolveFrame, rejectFrame) => {
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
      /** Every frame the entry sent, in arrival order (updates plus results). */
      all: () => [...seen],
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
        const frame = JSON.parse(line)
        frames.push(frame)
        seen.push(frame)
        for (const check of [...waiters]) check()
      }
    })
  })
}

/** The assistant text the engine streamed as session/update frames. */
function assistantText(frames, sessionId) {
  return frames
    .filter(frame => frame.method === 'session/update' && frame.params?.sessionId === sessionId)
    .map(frame => frame.params?.update ?? {})
    .filter(update => update.sessionUpdate === 'agent_message_chunk')
    .map(update => update.content?.text ?? '')
    .join('')
}

function sessionIdOf(frame) {
  const sessionId = frame.result?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('session/new returned no sessionId')
  return sessionId
}

const directory = await mkdtemp(join(tmpdir(), 'd03-serve-blackbox-'))
const port = await availableLoopbackPort()
const configPath = join(directory, 'agent.toml')
const dataDirectory = join(directory, 'state')
const ownedHome = join(dataDirectory, 'engine')
await writeFile(configPath, agentConfig({ port, dataDirectory, workspace: join(directory, 'workspace') }))
const credential = readCredential(CREDENTIAL_REF)

console.log(`# D03 black-box --serve dsh entry`)
console.log(`cli=${CLI}`)
console.log(`dsh=${DSH}`)
console.log(`config=${configPath}`)
console.log(`provider=${PROVIDER_BASE_URL} model=${PROVIDER_MODEL}`)
console.log(`credential=${CREDENTIAL_REF} (value read from ${CREDENTIALS_FILE}, not printed)`)
console.log(`listener=127.0.0.1:${port}`)

const entry = spawn(process.execPath, [CLI, '--serve', 'dsh', '--ip', '127.0.0.1', '--port', String(port), '--config', configPath], {
  cwd: CLI_ROOT,
  env: { ...process.env, [CREDENTIAL_REF]: credential },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stdout = ''
let stderr = ''
entry.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); process.stdout.write(chunk) })
entry.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); process.stderr.write(chunk) })

let client
try {
  const readyLine = await new Promise((resolveLine, rejectLine) => {
    const deadline = setTimeout(() => rejectLine(new Error(`the entry never printed a readiness line; stderr=${stderr}`)), 180_000)
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

  assert(fields.engine === 'dsh', 'the entry reports the dsh engine')
  assert(fields.model === `workbuddy/${PROVIDER_MODEL}`, `the entry reports the verified accepted model (${fields.model})`)
  assert(fields.modelVerification === 'session/new configOptions', `the model was verified from session/new (${fields.modelVerification})`)
  assert(fields.listener === `127.0.0.1:${port}`, 'the entry serves the configured listener')
  assert(Number.isSafeInteger(daemonPid) && daemonPid > 0, `the entry reports its own daemon pid (${daemonPid})`)
  assert(Number.isSafeInteger(enginePid) && enginePid > 0, `the entry reports the engine child pid (${enginePid})`)
  assert(daemonPid === entry.pid, 'the reported daemon pid is the real CLI process pid')

  const engineRow = processRow(enginePid)
  assert(engineRow.length > 0, `the reported engine pid ${enginePid} is a live process: ${engineRow}`)
  assert(/dsh/.test(engineRow) && /--profile/.test(engineRow) && /acp/.test(engineRow), 'the engine child really runs `dsh --profile acp`')
  const children = childrenOf(daemonPid)
  assert(children.length === 1, `the daemon has exactly one child process (${children.map(row => `${row.pid}:${row.command.split(' ').slice(0, 3).join(' ')}`).join(' | ')})`)
  assert(children[0].pid === enginePid, 'the one child is the reported engine pid')

  // The engine home is the daemon-owned directory, never the real ~/.dsh. The
  // claim is checked against the live engine child's own environment, so it is
  // discriminating instead of a path tautology (`ownedHome` is a fresh tmpdir).
  assert(fields.dataDirectory.startsWith(directory), 'the daemon data directory stays inside the driver work root')
  const engineEnvironment = environmentOf(enginePid, ['DSH_HOME'])
  assert(engineEnvironment.DSH_HOME === ownedHome, `the live engine child's own DSH_HOME is the owned home (${engineEnvironment.DSH_HOME})`)
  assert(engineEnvironment.DSH_HOME !== REAL_DSH_HOME, `the live engine child's DSH_HOME is not the real ~/.dsh (${REAL_DSH_HOME})`)
  assert(!existsSync(join(REAL_DSH_HOME, 'teams-dsh-acp.patch.json')), 'the derived patch was never written into the real ~/.dsh')
  assert(existsSync(ownedHome), `the engine really created its owned DSH home (${ownedHome})`)
  const patchPath = join(ownedHome, 'teams-dsh-acp.patch.json')
  assert(existsSync(patchPath), 'the entry wrote the derived DSH profile patch into the owned home')
  const patch = JSON.parse(await readFile(patchPath, 'utf8'))
  const acpRow = patch.find(row => row.id === 'acp')
  assert(acpRow?.config?.provider === 'teams-workbuddy' && acpRow?.config?.model === PROVIDER_MODEL, `the patch selects the derived route ${JSON.stringify(acpRow?.config)}`)
  assert(existsSync(join(ownedHome, 'profiles', 'acp')), 'the real DSH engine materialized its acp profile inside the owned home')

  console.log(`\n## real initialize, session/new and prompt through the entry listener`)
  client = await connectClient(port)
  await client.send({ jsonrpc: '2.0', id: 'init-1', method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } })
  const initialized = await client.awaitFrame(frame => frame.id === 'init-1')
  assert(initialized.result?.protocolVersion === 1, 'the entry served a real initialize result')
  assert(initialized.result?.agentInfo?.name === 'deepseek-harness-acp', `the engine identity is the real DSH ACP server (${initialized.result?.agentInfo?.name})`)

  await client.send({ jsonrpc: '2.0', id: 'new-1', method: 'session/new', params: { cwd: join(directory, 'workspace'), mcpServers: [] } })
  const created = await client.awaitFrame(frame => frame.id === 'new-1')
  const sessionId = sessionIdOf(created)
  const modelOption = (created.result?.configOptions ?? []).find(option => option.id === 'model')
  assert(modelOption?.currentValue === JSON.stringify(['teams-workbuddy', PROVIDER_MODEL]), `the engine's own session/new reports the derived route (${modelOption?.currentValue})`)

  await client.send({ jsonrpc: '2.0', id: 'prompt-1', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'Reply with exactly: DSH-SERVE-OK' }] } })
  const prompted = await client.awaitFrame(frame => frame.id === 'prompt-1')
  assert(prompted.error === undefined, `the real prompt completed without an error frame (${JSON.stringify(prompted.error ?? null)})`)
  assert(prompted.result?.stopReason === 'end_turn', `the real prompt reached the provider and finished (${prompted.result?.stopReason})`)
  const reply = assistantText(client.all(), sessionId)
  assert(reply.length > 0, `the engine streamed real assistant text (${JSON.stringify(reply.slice(0, 80))})`)
  assert(/DSH-SERVE-OK/.test(reply), `the real provider reply matched the prompt (${JSON.stringify(reply.slice(0, 80))})`)

  console.log(`\n## real cancel`)
  await client.send({ jsonrpc: '2.0', id: 'prompt-2', method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'Count from 1 to 400, one number per line, then summarize.' }] } })
  await new Promise(resolveWait => setTimeout(resolveWait, 1500))
  await client.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
  const cancelled = await client.awaitFrame(frame => frame.id === 'prompt-2')
  assert(cancelled.result?.stopReason === 'cancelled', `the cancel notification ended the in-flight prompt (${cancelled.result?.stopReason ?? JSON.stringify(cancelled)})`)

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

  // The owned DSH home and its derived patch are removed on the stop path.
  assert(!existsSync(ownedHome), `the owned DSH home ${ownedHome} was removed on stop`)
  assert(!existsSync(patchPath), 'the derived patch file was removed with the owned home')
  const history = JSON.parse(await readFile(join(dataDirectory, 'acp-history.json'), 'utf8'))
  const events = history.records.map(record => record.event)
  assert(events.includes('request.dispatched') && events.includes('result.received'), 'the daemon wrote its durable execution history')
  assert(existsSync(dataDirectory), 'the daemon data directory itself is retained')

  console.log(`\nBLACK-BOX PASS: one daemon + one real DSH engine child, verified derived route, real prompt, real cancel, explicit-PID stop, owned DSH home removed.`)
  console.log(JSON.stringify({ daemonPid, enginePid, sessionId, model: fields.model, modelVerification: fields.modelVerification, route: acpRow?.config?.provider, stop: stoppedLine }, null, 2))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  console.error(`--- entry stdout ---\n${stdout}\n--- entry stderr ---\n${stderr}`)
  process.exitCode = 1
} finally {
  if (client !== undefined) await client.close().catch(() => undefined)
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
