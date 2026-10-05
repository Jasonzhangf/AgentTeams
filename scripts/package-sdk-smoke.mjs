#!/usr/bin/env node

// Installed public SDK consumer smoke.
//
// It is not a second producer or a full MVP driver. It packs the single staged
// pack root, installs that tarball outside the source tree, and then consumes
// only installed package modules and the installed runner/graphs/manifest.

import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const defaultPackRoot = resolve(root, 'generated', 'modules', 'teams-source', 'lib')
const defaultReceiptDir = resolve(root, 'generated', 'u1-receipts', `${Date.now()}-${process.pid}`)
const defaultReceiptPath = process.env.AGENTTEAMS_U1_SDK_RECEIPT_PATH
  ? resolve(process.env.AGENTTEAMS_U1_SDK_RECEIPT_PATH)
  : join(defaultReceiptDir, 'installed-sdk.receipt.json')

function fail(message) {
  throw new Error(`package SDK smoke: ${message}`)
}

function parseOptions(argv) {
  const options = {
    packRoot: defaultPackRoot,
    receiptPath: defaultReceiptPath,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) fail(`${argument} requires a value`)
      index += 1
      return next
    }
    if (argument === '--pack-root') options.packRoot = resolve(value())
    else if (argument === '--receipt-path') options.receiptPath = resolve(value())
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function listFiles(directory) {
  const files = []
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(relative(directory, child).split(sep).join('/'))
      else fail(`unsupported installed entry: ${child}`)
    }
  }
  visit(directory)
  return files.sort()
}

function hashDirectory(directory) {
  const digest = createHash('sha256')
  for (const file of listFiles(directory)) {
    digest.update(file)
    digest.update('\0')
    digest.update(readFileSync(join(directory, file)))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function writeReceipt(path, receipt) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`)
}

function installedRuntimeFiles(installedRoot) {
  return {
    runner: join(installedRoot, 'runtime', 'dagpipe', 'bin', 'darwin-arm64', 'agentteams-dagpipe-runner'),
    manifest: join(installedRoot, 'runtime', 'dagpipe', 'manifest.json'),
    graphs: {
      'agent-work': join(installedRoot, 'runtime', 'dagpipe', 'graphs', 'agent-work.graph.json'),
      'work-open': join(installedRoot, 'runtime', 'dagpipe', 'graphs', 'work-open.graph.json'),
      'work-request': join(installedRoot, 'runtime', 'dagpipe', 'graphs', 'work-request.graph.json'),
      'work-close': join(installedRoot, 'runtime', 'dagpipe', 'graphs', 'work-close.graph.json'),
      'work-query': join(installedRoot, 'runtime', 'dagpipe', 'graphs', 'work-query.graph.json'),
    },
  }
}

export function verifyInstalledRuntime(installedRoot) {
  const paths = installedRuntimeFiles(installedRoot)
  if (!existsSync(paths.manifest)) fail('installed runtime manifest is missing')
  if (!existsSync(paths.runner)) fail('installed runner is missing')
  const manifest = JSON.parse(readFileSync(paths.manifest, 'utf8'))
  if (manifest.schemaVersion !== 1) fail('installed manifest schemaVersion is not 1')
  if (manifest.runner?.path !== 'bin/darwin-arm64/agentteams-dagpipe-runner') fail('installed manifest runner path is wrong')
  const runnerHash = hashFile(paths.runner)
  if (runnerHash !== manifest.runner.sha256) fail('installed runner hash does not match manifest')
  if ((statMode(paths.runner) & 0o111) === 0) fail('installed runner is not executable')
  const graphIds = Object.keys(paths.graphs)
  const definitions = Array.isArray(manifest.graphs) ? manifest.graphs : []
  if (definitions.length !== graphIds.length ||
      graphIds.some(id => !definitions.some(definition => definition?.id === id))) {
    fail('installed manifest graph set does not match packaged graphs')
  }
  const runtimeRoot = join(installedRoot, 'runtime', 'dagpipe')
  for (const id of graphIds) {
    const definition = definitions.find(candidate => candidate?.id === id)
    const expectedPath = relative(runtimeRoot, paths.graphs[id]).split(sep).join('/')
    if (definition.path !== expectedPath) fail(`installed graph ${id} path is wrong`)
    const graphPath = paths.graphs[id]
    if (!existsSync(graphPath)) fail(`installed graph ${id} is missing`)
    if (hashFile(graphPath) !== definition.sha256) fail(`installed graph ${id} hash does not match manifest`)
  }
  return manifest
}

function statMode(path) {
  return statSync(path).mode
}

export function assertInstalledRuntimeRejected(name, installedRoot) {
  let rejection
  try {
    verifyInstalledRuntime(installedRoot)
  } catch (error) {
    rejection = error
  }
  if (!rejection) fail(`tampered installed package copy ${name} was accepted`)
  return { name, code: rejection?.code, message: rejection?.message ?? String(rejection) }
}

function declarationFor(id, capabilities = []) {
  return {
    identity: { hostId: id, machineId: id, agentId: id, accountId: 'account', agentKind: 'custom', label: id },
    scopeId: 'scope',
    revision: 1,
    capabilities,
    routes: [],
  }
}

function clientOptions(url, id, capabilities = [], cert) {
  return {
    transport: {
      endpoint: url,
      credential: `Bearer ${id}`,
      ca: cert,
      connectTimeoutMs: 2000,
      maxMessageBytes: 65536,
      maxBufferedBytes: 65536,
      maxPendingFrames: 16,
    },
    admissionTimeoutMs: 2000,
    requestTimeoutMs: 2000,
    maxPendingRequests: 8,
    maxDataConnections: 8,
    declaration: declarationFor(id, capabilities),
  }
}

function compileGraph(runnerPath, graphPath, capabilities) {
  const args = ['compile', '--graph', graphPath]
  if (capabilities) args.push('--capabilities', JSON.stringify(capabilities))
  const stdout = execFileSync(runnerPath, args, { encoding: 'utf8' })
  const lines = stdout.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1])
}

function writeTls(directory) {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(directory, 'key'), '-out', join(directory, 'cert')], { stdio: 'ignore' })
  return { key: readFileSync(join(directory, 'key')), cert: readFileSync(join(directory, 'cert')) }
}

export async function runInstalledSdkSmoke(options = {}) {
  const packRoot = resolve(options.packRoot ?? defaultPackRoot)
  const receiptPath = options.receiptPath ? resolve(options.receiptPath) : defaultReceiptPath
  assert.ok(existsSync(join(packRoot, 'package.json')), `pack root is missing: ${packRoot}`)
  const packageReceiptPath = join(packRoot, '..', 'package-receipt.json')
  const packageReceipt = JSON.parse(readFileSync(packageReceiptPath, 'utf8'))
  assert.equal(packageReceipt.mode, 'final', 'installed SDK smoke requires the final staged pack')
  assert.equal(packageReceipt.sdk.included, true, 'final staged pack must include SDK assets')

  const temporaryRoot = mkdtempSync(join(tmpdir(), 'agentteams-sdk-smoke-'))
  const prefix = join(temporaryRoot, 'prefix')
  const home = join(temporaryRoot, 'home')
  const npmCache = join(temporaryRoot, 'npm-cache')
  const packDestination = join(temporaryRoot, 'pack')
  for (const path of [prefix, home, npmCache, packDestination]) mkdirSync(path, { recursive: true })

  let receipt
  let harness
  let relayServer
  let provider
  let consumer
  let client
  try {
    const npmEnv = { ...process.env, HOME: home, npm_config_cache: npmCache }
    const packed = await execFileAsync('npm', ['pack', packRoot, '--pack-destination', packDestination, '--json'], {
      cwd: temporaryRoot,
      env: npmEnv,
      maxBuffer: 32 * 1024 * 1024,
    })
    const packResult = JSON.parse(packed.stdout)[0]
    const tarball = join(packDestination, packResult.filename)
    const tarballSha256 = hashFile(tarball)
    await execFileAsync('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--no-package-lock', '--no-save', tarball], {
      cwd: temporaryRoot,
      env: npmEnv,
      maxBuffer: 32 * 1024 * 1024,
    })

    const installedRoot = realpathSync(join(prefix, 'node_modules', 'agentteams'))
    const installedContentSha256 = hashDirectory(installedRoot)
    assert.equal(installedContentSha256, packageReceipt.content_sha256, 'installed SDK package content does not match the staged final pack')
    const runtimeFiles = installedRuntimeFiles(installedRoot)
    const manifest = verifyInstalledRuntime(installedRoot)

    const imported = {}
    for (const [name, rel] of [
      ['createRelayServer', 'server/relay.js'],
      ['createRelayClient', 'network/relay-client.js'],
      ['startAgentDaemon', 'runtime/agent-daemon.js'],
      ['createCliWorkExecutor', 'agent-host/cli-executor.js'],
      ['createWorkHost', 'agent-host/work-host.js'],
      ['createWorkIngress', 'agent-host/work-ingress.js'],
      ['createFileWorkStore', 'agent/work-resource.js'],
      ['createWorkLedger', 'agent/work-resource.js'],
      ['compileDeclarationEndpoints', 'server/endpoint-discovery.js'],
      ['createWorkChannel', 'network/work-channel.js'],
      ['createAgentWorkClient', 'runtime/agent-work-client.js'],
      ['runWorkExecution', 'runtime/dagpipe/host.js'],
    ]) {
      const mod = await import(pathToFileURL(join(installedRoot, 'generated', 'runtime-lib', rel)).href)
      imported[name] = mod[name]
    }

    const tlsDirectory = join(temporaryRoot, 'tls')
    mkdirSync(tlsDirectory, { recursive: true })
    const { key, cert } = writeTls(tlsDirectory)

    const searchRoot = join(temporaryRoot, 'search-root')
    mkdirSync(searchRoot)
    writeFileSync(join(searchRoot, 'alpha.txt'), 'alpha marker sdk-final-pack\n')

    relayServer = await imported.createRelayServer({
      host: '127.0.0.1',
      port: 0,
      key,
      cert,
      maxPayload: 65536,
      maxConnections: 16,
      maxGrants: 8,
      maxBufferedAmount: 65536,
      maxPendingMessages: 16,
      maxPendingBytes: 131072,
      grantTtlMs: 10_000,
      authenticate: credential => credential?.startsWith('Bearer ')
        ? { agentId: credential.slice(7), accountId: 'account', scopeId: 'scope' }
        : null,
    })

    const executor = imported.createCliWorkExecutor({
      services: [
        {
          capabilityId: 'file-search',
          version: '1',
          operations: ['search'],
          resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }],
        },
      ],
      searchRoot,
      profilePrefix: 'teams-sdk-final-pack',
      camoExecutable: '/missing/camo',
      searchExecutable: (await execFileAsync('which', ['rg'], { cwd: temporaryRoot, env: process.env })).stdout.trim(),
    })
    let host
    provider = await imported.startAgentDaemon({
      presenceIntervalMs: 1000,
      relay: {
        ...clientOptions(relayServer.url, 'provider', executor.capabilities, cert),
        onEvent: async event => {
          if (event.kind !== 'relay.offer') return
          const socket = await provider.network.openData(event.grant)
          const ingress = imported.createWorkIngress(host, { accountId: 'account', scopeId: 'scope', agentId: event.grant.sourceAgentId })
          imported.createWorkChannel(socket, {
            timeoutMs: 2000,
            maxPending: 4,
            maxIncoming: 4,
            onRequest: request => ingress(request),
          })
        },
      },
    })
    const ledger = imported.createWorkLedger({
      provider: { accountId: 'account', scopeId: 'scope', agentId: 'provider' },
      generation: provider.network.generation,
      capabilities: executor.capabilities,
      endpointCatalog: imported.compileDeclarationEndpoints(declarationFor('provider', executor.capabilities)),
      store: imported.createFileWorkStore(join(temporaryRoot, 'work-ledger.json')),
    })
    host = imported.createWorkHost({
      ledger,
      executor,
      policy: () => ({ revision: 1, authorizeWork: () => true }),
    })
    consumer = await imported.startAgentDaemon({ presenceIntervalMs: 1000, relay: clientOptions(relayServer.url, 'consumer', [], cert) })
    client = imported.createAgentWorkClient(
      consumer.network,
      { accountId: 'account', scopeId: 'scope', agentId: 'consumer' },
      { timeoutMs: 2000, maxPending: 8 },
    )
    harness = { relay: relayServer, provider, consumer, client, ledger, executor, stop: async () => {
      await client.dispose()
      await consumer.stop()
      await provider.stop()
      await relayServer.close()
    } }

    const runnerPath = runtimeFiles.runner
    const graphPath = runtimeFiles.graphs['agent-work']
    const projectId = 'agentteams-installed-sdk-smoke'
    const hostCalls = []
    const runResult = await imported.runWorkExecution(client, {
      runnerPath,
      graphPath,
      projectId,
      executionId: 'exec-installed-alpha',
      attemptId: '1',
      intent: {
        control: {
          receiverAgentId: 'consumer',
          targetAgentId: 'provider',
          capabilityId: 'file-search',
          capabilityVersion: '1',
          operation: 'search',
          workId: 'work-installed-alpha',
          requestId: 'req-installed-alpha',
          policyRevision: 1,
          demands: [{ resourceId: 'search-slot', amount: 1 }],
        },
        business: { query: 'alpha marker' },
      },
      onHostCall: frame => hostCalls.push(frame),
    })
    assert.equal(runResult.status, 'completed', `installed host did not complete Work execution: ${JSON.stringify(runResult)}`)
    const business = runResult.business
    assert.equal(business?.status, 'matched', 'runner did not return a matched provider result')
    assert.ok(Array.isArray(business.matches) && business.matches.some(match => match.path === './alpha.txt' && match.text === 'alpha marker sdk-final-pack\n'),
      'runner did not return the real rg marker result')
    assert.ok(runResult.evidence.hostOperations.includes('agentWork.request'), 'runner did not dispatch the real provider request')
    assert.equal(runResult.cleanup.channelsOpened, 1, 'host channel open count mismatch')
    assert.equal(runResult.cleanup.channelsDisposed, 1, 'host channel dispose count mismatch')
    const requestCall = hostCalls.find(frame => frame.control.operation === 'agentWork.request')
    assert.deepEqual(requestCall?.business, { query: 'alpha marker' }, 'installed host did not preserve the request business payload')
    const ledgerWorks = ledger.snapshot.works
    assert.ok(ledgerWorks.some(work => work.workId === 'work-installed-alpha' && work.state === 'closed'), 'provider ledger did not close the installed Work')

    const compileFrames = {}
    const missingOperator = structuredClone(JSON.parse(readFileSync(graphPath, 'utf8')))
    missingOperator.nodes[0].operator = 'teams.missing-installed-operator'
    const missingPath = join(temporaryRoot, 'missing-operator.graph.json')
    writeFileSync(missingPath, `${JSON.stringify(missingOperator)}\n`)
    compileFrames.missingOperator = compileGraph(runnerPath, missingPath)
    assert.equal(compileFrames.missingOperator.type, 'compile.failure', 'missing operator did not fail compile')
    assert.ok(compileFrames.missingOperator.message?.includes('missing operator'), 'missing operator compile failure did not describe the missing binding')

    compileFrames.missingEffects = compileGraph(runnerPath, graphPath, [])
    assert.equal(compileFrames.missingEffects.type, 'compile.failure', 'missing effects did not fail compile')
    assert.ok(compileFrames.missingEffects.message?.includes('undeclared capability'), 'missing effects compile failure did not describe the missing capability')

    const tamperCases = [
      ['missing-runner', copy => { rmSync(copy.runtimeFiles.runner, { force: true }) }],
      ['missing-manifest', copy => { rmSync(copy.runtimeFiles.manifest, { force: true }) }],
      ['missing-graph', copy => { rmSync(copy.runtimeFiles.graphs['work-query'], { force: true }) }],
      ['dropped-graph-manifest-entry', copy => {
        const manifest = JSON.parse(readFileSync(copy.runtimeFiles.manifest, 'utf8'))
        manifest.graphs = manifest.graphs.filter(definition => definition.id !== 'work-close')
        writeFileSync(copy.runtimeFiles.manifest, `${JSON.stringify(manifest, null, 2)}\n`)
      }],
      ['runner-hash-mismatch', copy => { writeFileSync(copy.runtimeFiles.runner, 'sentinel', { flag: 'w' }) }],
      ['graph-hash-mismatch', copy => { writeFileSync(copy.runtimeFiles.graphs['agent-work'], '{}', { flag: 'w' }) }],
    ]
    const failures = []
    for (const [name, mutate] of tamperCases) {
      const copyRoot = join(temporaryRoot, `tampered-${name}`)
      cpSync(installedRoot, copyRoot, { recursive: true })
      const copy = { runtimeFiles: installedRuntimeFiles(copyRoot) }
      mutate(copy)
      failures.push(assertInstalledRuntimeRejected(name, copyRoot))
    }

    receipt = {
      schema_version: 1,
      mode: 'final',
      release_eligible: false,
      status: 'passed',
      candidate: packageReceipt.candidate,
      package: packageReceipt.package ?? { name: 'agentteams', version: packageReceipt.version, pack_root: packageReceipt.pack_root },
      tarball: { filename: packResult.filename, sha256: tarballSha256 },
      install: { prefix, home, installed_root: installedRoot, installed_content_sha256: installedContentSha256 },
      runtime: {
        manifest_sha256: hashFile(runtimeFiles.manifest),
        runner_sha256: hashFile(runtimeFiles.runner),
        graphs: Object.fromEntries(Object.entries(runtimeFiles.graphs).map(([id, path]) => [id, hashFile(path)])),
      },
      consumer: {
        entrypoint: 'installed npm tarball -> installed compiled runWorkExecution -> packaged DAGpipe runner -> real provider rg marker',
        run_result: { status: runResult.status, control: runResult.control, business, evidence: runResult.evidence, cleanup: runResult.cleanup },
        compile: compileFrames,
        tamper_failures: failures,
      },
      cleanup: { temporary_root: temporaryRoot, removed: false },
    }
  } catch (error) {
    receipt = {
      schema_version: 1,
      mode: 'final',
      release_eligible: false,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      cleanup: { temporary_root: temporaryRoot, removed: false },
    }
    throw error
  } finally {
    if (harness) await harness.stop()
    else {
      if (client) await client.dispose()
      if (consumer) await consumer.stop()
      if (provider) await provider.stop()
      if (relayServer) await relayServer.close()
    }
    rmSync(temporaryRoot, { recursive: true, force: true })
    if (receipt !== undefined) {
      receipt.cleanup.removed = !existsSync(temporaryRoot)
      writeReceipt(receiptPath, receipt)
    }
  }
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runInstalledSdkSmoke(parseOptions(process.argv.slice(2)))
    .then(() => console.log('Installed SDK consumer smoke passed'))
    .catch(error => {
      console.error(error instanceof Error ? error.message : String(error))
      process.exitCode = 1
    })
}
