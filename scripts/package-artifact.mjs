import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { currentCandidateIdentity } from './receipt-identity.mjs'
import { buildRunner } from '../runtime/dagpipe/build.mjs'

const root = resolve(import.meta.dirname, '..')
const moduleRoot = resolve(root, 'generated', 'modules', 'teams-source')
const output = resolve(moduleRoot, 'lib')
const receiptPath = resolve(moduleRoot, 'package-receipt.json')
const rootPackagePath = resolve(root, 'package.json')
const graphDefinitions = [
  { id: 'agent-work', source: resolve(root, 'docs', 'design', 'dagpipe', 'graphs', 'agent-work.graph.json'), receipt: 'agent_work' },
  { id: 'work-open', source: resolve(root, 'docs', 'design', 'dagpipe', 'graphs', 'work-open.graph.json'), receipt: 'work_open' },
  { id: 'work-request', source: resolve(root, 'docs', 'design', 'dagpipe', 'graphs', 'work-request.graph.json'), receipt: 'work_request' },
  { id: 'work-close', source: resolve(root, 'docs', 'design', 'dagpipe', 'graphs', 'work-close.graph.json'), receipt: 'work_close' },
  { id: 'work-query', source: resolve(root, 'docs', 'design', 'dagpipe', 'graphs', 'work-query.graph.json'), receipt: 'work_query' },
]

function fail(message) {
  throw new Error(`package artifact: ${message}`)
}

function parseMode(argv) {
  let mode = 'final'
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--mode') {
      mode = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--mode=')) {
      mode = argument.slice('--mode='.length)
    } else {
      fail(`unknown argument: ${argument}`)
    }
  }
  if (mode !== 'base' && mode !== 'final') fail(`mode must be base or final, received: ${mode ?? '<missing>'}`)
  return mode
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`required ${label} is missing: ${path}`)
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) fail(`required ${label} is missing: ${path}`)
}

function copyFile(source, destination, label) {
  requireFile(source, label)
  mkdirSync(resolve(destination, '..'), { recursive: true })
  cpSync(source, destination)
}

function copyDirectory(source, destination, label) {
  requireDirectory(source, label)
  cpSync(source, destination, { recursive: true })
}

function listFiles(directory) {
  const files = []
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(relative(directory, child).split(sep).join('/'))
      else fail(`unsupported staged entry: ${child}`)
    }
  }
  visit(directory)
  return files.sort()
}

function hashFileSet(directory, files) {
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file)
    digest.update('\0')
    digest.update(readFileSync(join(directory, file)))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function hashFile(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function requireHash(path, expected, label) {
  requireFile(path, label)
  const actual = hashFile(path)
  if (actual !== expected) fail(`${label} hash mismatch: expected ${expected}, got ${actual}`)
  return actual
}

function validateRunnerReceipt(receipt) {
  if (receipt?.protocol !== 'teams-dagpipe-runner-build-receipt' || receipt?.version !== 2) {
    fail('runner build receipt must use teams-dagpipe-runner-build-receipt version 2')
  }
  if (receipt.target !== 'darwin' && receipt.target !== 'aarch64-apple-darwin') {
    fail(`runner build target is unsupported: ${receipt.target}`)
  }
  if (receipt.sdk?.crate !== 'pipeline_runtime' || receipt.sdk?.version !== '0.1.1') {
    fail(`runner SDK identity is unsupported: ${receipt.sdk?.crate}@${receipt.sdk?.version}`)
  }
  if (typeof receipt.sdk.sdk_build_inputs_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(receipt.sdk.sdk_build_inputs_sha256)) {
    fail('runner receipt lacks a valid sdk.sdk_build_inputs_sha256')
  }
  if (receipt.artifact?.kind !== 'rust-bin' || receipt.artifact?.install_name !== 'agentteams-dagpipe-runner') {
    fail('runner receipt artifact identity is unsupported')
  }
  if (!Number.isSafeInteger(receipt.artifact.size) || receipt.artifact.size < 1) {
    fail('runner receipt artifact size is invalid')
  }
}

function packageManifest(rootPackage, mode) {
  const required = ['name', 'version', 'type', 'bin', 'files', 'engines', 'os', 'cpu', 'dependencies']
  for (const field of required) {
    if (rootPackage[field] === undefined) fail(`root package.json is missing required field: ${field}`)
  }
  const files = mode === 'base'
    ? rootPackage.files.filter(file => file !== 'runtime/dagpipe')
    : rootPackage.files
  return {
    name: rootPackage.name,
    version: rootPackage.version,
    private: true,
    type: rootPackage.type,
    bin: rootPackage.bin,
    files,
    engines: rootPackage.engines,
    os: rootPackage.os,
    cpu: rootPackage.cpu,
    dependencies: rootPackage.dependencies,
  }
}

const mode = parseMode(process.argv.slice(2))

requireFile(rootPackagePath, 'root package.json')
const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'))
let runnerBuild
let runnerHash
if (mode === 'final') {
  runnerBuild = await buildRunner()
  validateRunnerReceipt(runnerBuild.receipt)
  requireFile(runnerBuild.runnerPath, 'runner build artifact')
  runnerHash = hashFile(runnerBuild.runnerPath)
  if (runnerHash !== runnerBuild.receipt.artifact.sha256) {
    fail(`runner binary hash mismatch: receipt ${runnerBuild.receipt.artifact.sha256}, actual ${runnerHash}`)
  }
  if (statSync(runnerBuild.runnerPath).size !== runnerBuild.receipt.artifact.size) {
    fail('runner binary size does not match the build receipt')
  }
  for (const graph of graphDefinitions) {
    const receiptGraph = runnerBuild.receipt.graphs?.[graph.receipt]
    if (!receiptGraph || receiptGraph.path !== relative(root, graph.source).split(sep).join('/')) {
      fail(`runner receipt does not bind ${graph.id} to the current graph source`)
    }
    requireHash(graph.source, receiptGraph.sha256, `${graph.id} graph`)
  }
}
rmSync(output, { recursive: true, force: true })
rmSync(receiptPath, { force: true })
mkdirSync(output, { recursive: true })

copyFile(resolve(root, 'cli', 'agentteams.mjs'), resolve(output, 'cli', 'agentteams.mjs'), 'CLI entry')
copyDirectory(resolve(root, 'generated', 'runtime-lib'), resolve(output, 'generated', 'runtime-lib'), 'compiled runtime')
copyDirectory(resolve(root, 'console-host', 'lib'), resolve(output, 'console-host', 'lib'), 'Console library')
copyDirectory(resolve(root, 'console-host', 'static'), resolve(output, 'console-host', 'static'), 'Console static assets')
copyDirectory(resolve(root, 'ui', 'teams-console', 'lib'), resolve(output, 'ui', 'teams-console'), 'UI library')
copyDirectory(resolve(root, 'ui', 'teams-console', 'assets'), resolve(output, 'ui', 'teams-console', 'assets'), 'UI assets')

const manifest = packageManifest(rootPackage, mode)
let runtimeManifest
if (mode === 'final') {
  const runnerRelativePath = 'bin/darwin-arm64/agentteams-dagpipe-runner'
  const runtimeRoot = resolve(output, 'runtime', 'dagpipe')
  const runnerDestination = resolve(runtimeRoot, runnerRelativePath)
  copyFile(runnerBuild.runnerPath, runnerDestination, 'runner build artifact')
  if ((statSync(runnerDestination).mode & 0o111) === 0) fail('packaged runner is not executable')
  const graphs = []
  for (const graph of graphDefinitions) {
    const destinationRelativePath = `graphs/${graph.id}.graph.json`
    const destination = resolve(runtimeRoot, destinationRelativePath)
    copyFile(graph.source, destination, `${graph.id} graph`)
    const digest = hashFile(destination)
    if (digest !== runnerBuild.receipt.graphs[graph.receipt].sha256) {
      fail(`packaged ${graph.id} graph hash mismatch`)
    }
    graphs.push({ id: graph.id, path: destinationRelativePath, sha256: digest })
  }
  const packagedRunnerHash = hashFile(runnerDestination)
  if (packagedRunnerHash !== runnerHash) fail('packaged runner hash mismatch')
  runtimeManifest = {
    schemaVersion: 1,
    runner: {
      path: runnerRelativePath,
      sha256: packagedRunnerHash,
      platform: 'darwin',
      arch: 'arm64',
    },
    sdk: {
      crate: runnerBuild.receipt.sdk.crate,
      version: runnerBuild.receipt.sdk.version,
      buildInputsSha256: runnerBuild.receipt.sdk.sdk_build_inputs_sha256,
    },
    buildReceiptSha256: hashFile(runnerBuild.receiptPath),
    graphs,
  }
  writeFileSync(resolve(runtimeRoot, 'manifest.json'), `${JSON.stringify(runtimeManifest, null, 2)}\n`)
}
writeFileSync(resolve(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const files = listFiles(output)
const sdk = mode === 'final'
  ? {
      included: true,
      release_eligible: false,
      reason: 'final package stages the reviewed runner, five Work graphs and identity manifest; user entrypoint acceptance remains open',
      receipt_path: relative(root, runnerBuild.receiptPath).split(sep).join('/'),
      receipt_sha256: hashFile(runnerBuild.receiptPath),
      runner_path: runnerBuild.receipt.artifact.installed_path,
      runner_sha256: runnerHash,
      runner_size: runnerBuild.receipt.artifact.size,
      sdk_build_inputs_sha256: runnerBuild.receipt.sdk.sdk_build_inputs_sha256,
      graphs: graphDefinitions.map(graph => ({
        id: graph.id,
        path: graph.source.startsWith(root) ? relative(root, graph.source).split(sep).join('/') : graph.source,
        sha256: runnerBuild.receipt.graphs[graph.receipt].sha256,
      })),
      manifest: runtimeManifest,
    }
  : { included: false, release_eligible: false, reason: 'base mode explicitly omits runtime/dagpipe runner, manifest and graphs' }
const receipt = {
  schema_version: 1,
  mode,
  release_eligible: false,
  version: manifest.version,
  candidate: currentCandidateIdentity(root),
  pack_root: relative(root, output).split(sep).join('/'),
  content_sha256: hashFileSet(output, files),
  files,
  dependencies: manifest.dependencies,
  sdk,
}
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`package artifact ${mode} ${manifest.name}@${manifest.version} ${receipt.content_sha256} ${receipt.pack_root}`)
