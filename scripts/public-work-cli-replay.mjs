#!/usr/bin/env node
// Real public-entry replay for the local Work request path (U4 / issue 4b6c377).
//
// This harness drives only public surfaces: the shipped CLI entry
// `cli/agentteams.mjs` and the `config.toml` user intent. It never imports
// runtime internals and never rebuilds control state, so a passing run proves
// the user-visible submit/query behaviour end to end.
//
// Usage: node scripts/public-work-cli-replay.mjs [--keep] [--receipt <dir>]
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const cli = join(root, 'cli', 'agentteams.mjs')
const keep = process.argv.includes('--keep')
const receiptIndex = process.argv.indexOf('--receipt')
const receiptDir = receiptIndex === -1 ? undefined : process.argv[receiptIndex + 1]

// macOS rejects unix socket paths longer than 104 bytes, and the launcher
// publishes its Work control socket below the config directory.
const workspace = mkdtempSync('/tmp/at-work-replay-')
const home = join(workspace, 'home')
const configPath = join(home, '.agentteams', 'config.toml')
const searchRoot = join(workspace, 'provider-files')
const providerData = join(workspace, 'provider-data')
const consumerData = join(workspace, 'consumer-data')

// The provider capability declares a real search executable; resolve it from the
// host instead of hard-coding a platform path.
const searchExecutable = execFileSync('/usr/bin/which', ['rg'], { encoding: 'utf8' }).trim()
if (searchExecutable.length === 0) throw new Error('public Work replay requires ripgrep on PATH')

const steps = []

async function cliStep(name, args, options = {}) {
  const started = Date.now()
  let code = 0
  let stdout = ''
  let stderr = ''
  try {
    const result = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: root,
      env: {
        ...process.env,
        HOME: home,
        AGENTTEAMS_PROVIDER_AUTH: 'local-provider',
        AGENTTEAMS_CONSUMER_AUTH: 'local-consumer',
      },
      maxBuffer: 32 * 1024 * 1024,
    })
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    code = typeof error.code === 'number' ? error.code : 1
    stdout = error.stdout ?? ''
    stderr = error.stderr ?? error.message
  }
  const step = { name, args, code, stdout, stderr, ms: Date.now() - started }
  steps.push(step)
  if (receiptDir !== undefined) {
    writeFileSync(join(receiptDir, `${name}.stdout`), stdout)
    writeFileSync(join(receiptDir, `${name}.stderr`), stderr)
    writeFileSync(join(receiptDir, `${name}.exit`), `${code}\n`)
  }
  return step
}

function configText() {
  return `version = 3

[bridge]
enabled = true

[agents.provider]
enabled = true
role = "provider"
label = "provider"

[agents.provider.identity]
hostId = "provider-host"
machineId = "local-machine"
accountId = "local-account"
agentKind = "custom"
label = "provider"

[agents.provider.runtime]
scopeId = "local-scope"
dataDirectory = ${JSON.stringify(providerData)}
policy = { revision = 1, allowedConsumers = ["consumer"], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = ${JSON.stringify(searchRoot)}, profilePrefix = "teams-provider" }

[agents.provider.services.file-search]
version = "1"
operations = ["search"]
resources = [{ resourceId = "search-slot", capacity = 2, unit = "slot" }]

[agents.consumer]
enabled = true
role = "receiver"
label = "consumer"

[agents.consumer.identity]
hostId = "consumer-host"
machineId = "local-machine"
accountId = "local-account"
agentKind = "custom"
label = "consumer"

[agents.consumer.runtime]
scopeId = "local-scope"
dataDirectory = ${JSON.stringify(consumerData)}
policy = { revision = 1, allowedConsumers = [], allowedManagers = [] }
cli = { camoExecutable = "/missing/camo", searchExecutable = ${JSON.stringify(searchExecutable)}, searchRoot = ${JSON.stringify(searchRoot)}, profilePrefix = "teams-consumer" }

[agents.consumer.connect]
targetAgentId = "provider"
capabilityId = "file-search"
capabilityVersion = "1"
operation = "search"
demands = [{ resourceId = "search-slot", amount = 1 }]
`
}

function parseReceipt(step) {
  return JSON.parse(step.stdout)
}

async function main() {
  if (receiptDir !== undefined) mkdirSync(receiptDir, { recursive: true })
  mkdirSync(join(home, '.agentteams'), { recursive: true })
  mkdirSync(searchRoot, { recursive: true })
  writeFileSync(join(searchRoot, 'needle.txt'), 'public work replay needle\n')

  const { initializeLocalConfig } = await import(join(root, 'generated', 'runtime-lib', 'runtime', 'local-config.js'))
  await initializeLocalConfig(configPath, configText())

  const failures = []
  const check = (condition, message) => { if (!condition) failures.push(message) }

  const start = await cliStep('start', ['start', '--config', configPath])
  check(start.code === 0, `start exited ${start.code}: ${start.stderr.trim()}`)

  const submitA = await cliStep('work-submit-a', ['work', 'submit', '--config', configPath, '--receiver', 'consumer', '--payload', '{"query":"needle"}'])
  check(submitA.code === 0, `submit A exited ${submitA.code}: ${submitA.stderr.trim()}`)
  const receiptA = submitA.code === 0 ? parseReceipt(submitA) : undefined
  check(receiptA?.control?.workId !== undefined, 'submit A did not return a workId')
  check(receiptA?.control?.providerAgentId === 'provider', 'submit A lost the provider identity')
  check(receiptA?.control?.capabilityId === 'file-search' && receiptA?.control?.capabilityVersion === '1', 'submit A lost the capability identity')
  check(receiptA?.control?.requestState === 'succeeded', `submit A requestState=${receiptA?.control?.requestState}`)

  const submitB = await cliStep('work-submit-b', ['work', 'submit', '--config', configPath, '--receiver', 'consumer', '--payload', '{"query":"second"}'])
  check(submitB.code === 0, `submit B exited ${submitB.code}: ${submitB.stderr.trim()}`)
  const receiptB = submitB.code === 0 ? parseReceipt(submitB) : undefined
  check(receiptB?.control?.workId !== undefined && receiptB.control.workId !== receiptA?.control?.workId, 'submit B reused the first work identity')

  if (receiptA !== undefined) {
    const query = await cliStep('work-query', ['work', 'query', '--config', configPath, '--receiver', 'consumer', '--work-id', receiptA.control.workId, '--request-id', receiptA.control.requestId])
    check(query.code === 0, `query exited ${query.code}: ${query.stderr.trim()}`)
    if (query.code === 0) {
      const observed = parseReceipt(query)
      check(observed.control?.workId === receiptA.control.workId, 'query returned a different workId')
      check(observed.control?.requestId === receiptA.control.requestId, 'query returned a different requestId')
      check(observed.control?.observed === true, 'query did not report an observation')
      check(JSON.stringify(observed.business) === JSON.stringify(receiptA.business), 'query business result differs from the original submit')
    }
  }

  const stop = await cliStep('stop', ['stop', '--config', configPath])
  check(stop.code === 0, `stop exited ${stop.code}: ${stop.stderr.trim()}`)

  const summary = {
    schema_version: 1,
    unit: '4b6c377-local-public-work',
    workspace,
    cli,
    steps: steps.map(step => ({ name: step.name, code: step.code, ms: step.ms })),
    submit_a: receiptA === undefined ? null : {
      workId: receiptA.control.workId,
      requestId: receiptA.control.requestId,
      providerAgentId: receiptA.control.providerAgentId,
      capabilityId: receiptA.control.capabilityId,
      capabilityVersion: receiptA.control.capabilityVersion,
      requestState: receiptA.control.requestState,
      workClosure: receiptA.control.workClosure,
      business: receiptA.business,
    },
    submit_b: receiptB === undefined ? null : { workId: receiptB.control.workId, requestId: receiptB.control.requestId },
    failures,
  }
  if (receiptDir !== undefined) writeFileSync(join(receiptDir, 'replay-summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)

  if (!keep) rmSync(workspace, { recursive: true, force: true })
  else process.stdout.write(`kept ${workspace}\n`)
  if (failures.length > 0) {
    process.stderr.write(`replay failed:\n- ${failures.join('\n- ')}\n`)
    process.exitCode = 1
  }
}

await main()
