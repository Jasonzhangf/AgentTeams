import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCandidateIdentity, currentCandidateIdentity, validateCandidateIdentity } from './receipt-identity.mjs'

const root = resolve(import.meta.dirname, '..')
const moduleId = 'teams-source'
const issueId = 'teams-lifecycle-admission'
const adapter = 'agentteams::lifecycle-adapter:v1'
const stageStateVersion = 4

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const now = () => new Date().toISOString()

function writeJson(path, value, exclusive = true) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, exclusive ? { flag: 'wx' } : undefined)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

// A failing gate writes far more than the 64 KiB pipe buffer, and Node drops the remainder when
// the child exits abnormally. The stage log is the primary record of a failed admission, so
// route both streams through files and keep every byte.
function run(program, args, logPath, cwd = root, extraEnv = {}) {
  const captureRoot = mkdtempSync(join(tmpdir(), 'agentteams-stage-run-'))
  const stdoutPath = join(captureRoot, 'stdout.log')
  const stderrPath = join(captureRoot, 'stderr.log')
  let stdoutFd
  let stderrFd
  try {
    stdoutFd = openSync(stdoutPath, 'w')
    stderrFd = openSync(stderrPath, 'w')
    const result = spawnSync(program, args, {
      cwd,
      stdio: ['ignore', stdoutFd, stderrFd],
      env: {
        ...process.env,
        ...extraEnv,
        CI: 'true',
        npm_config_fetch_timeout: '30000',
        npm_config_prefer_offline: 'true',
      },
    })
    const output = `${readFileSync(stdoutPath, 'utf8')}${readFileSync(stderrPath, 'utf8')}`
    writeFileSync(logPath, output)
    if (result.status !== 0) {
      throw new Error(`${program} ${args.join(' ')} failed with status ${result.status}\n${output.trim()}`)
    }
    return output
  } finally {
    if (stdoutFd !== undefined) closeSync(stdoutFd)
    if (stderrFd !== undefined) closeSync(stderrFd)
    rmSync(captureRoot, { recursive: true, force: true })
  }
}

function pathHashes(paths) {
  return Object.fromEntries(paths.filter(path => existsSync(path)).map(path => [path, digest(readFileSync(path))]))
}

function fileHash(path) {
  return existsSync(path) ? digest(readFileSync(path)) : undefined
}

// A stage is reusable only from the inputs it really consumes. The five
// docs/architecture maps are the project's declared lifecycle inputs; they are
// tracked in docs/goals/teams-lifecycle.manifest.json. The module registry is
// listed separately from the other four maps because it is the admission owner
// for module scope.
const architectureMapPaths = [
  'docs/architecture/function-map.json',
  'docs/architecture/mainline-call-map.json',
  'docs/architecture/resource-map.json',
  'docs/architecture/verification-map.json',
]
const registryPaths = ['docs/architecture/module-registry.json']
const configPaths = [
  'package.json',
  'pnpm-workspace.yaml',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.runtime.json',
  'vitest.config.ts',
]
const smokeScriptPaths = [
  'scripts/package-artifact.mjs',
  'scripts/package-user-smoke.mjs',
  'scripts/installed-runtime-smoke.mjs',
  'scripts/package-sdk-smoke.mjs',
  'scripts/runtime-smoke.mjs',
]

// The clean-candidate precondition makes `HEAD:<path>` the content a stage
// reads. A git blob id is a real revision of that file, not a rebuilt identity
// hash, and a deleted path has no revision so it stays visible as null.
function gitRevision(path) {
  const result = spawnSync('git', ['rev-parse', `HEAD:${path}`], { cwd: root, encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

function revisions(paths) {
  return Object.fromEntries(paths.map(path => [path, gitRevision(path)]))
}

// The source roots that `pnpm verify` compiles or tests. Verify consumes the
// tracked source tree at HEAD, not the candidate diff: a source change absorbed
// from an advancing main must invalidate a previous PASS even when base...head
// is empty.
const sourceRoots = [
  'AGENTS.md',
  '.appsdk',
  'acp-adapter',
  'agent',
  'agent-host',
  'cli',
  'cli-adapter',
  'config',
  'console-host',
  'contracts',
  // The packaged Work graphs are inputs of the same compile/test run: the
  // DAGpipe runner build, the graph regression and the packaged Work replay
  // read them. No other docs tree is a verify input.
  'docs/design/dagpipe/graphs',
  'dsh-adapter',
  'endpoint',
  'memory-plugin',
  'network',
  'opencode-adapter',
  'packages',
  'runtime',
  'scripts',
  'search-plugin',
  'server',
  'ui/teams-console',
]

function sourceRevisions() {
  const excluded = new Set([...configPaths, ...architectureMapPaths, ...registryPaths])
  const result = spawnSync('git', ['ls-tree', '-r', '-z', 'HEAD', '--', ...sourceRoots],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`${result.stderr || result.stdout}`.trim())
  const source = {}
  for (const entry of result.stdout.split('\0')) {
    if (entry === '') continue
    const tab = entry.indexOf('\t')
    if (tab < 0) continue
    const [, type, revision] = entry.slice(0, tab).split(' ')
    const path = entry.slice(tab + 1)
    if (type !== 'blob' || excluded.has(path)) continue
    source[path] = revision
  }
  return source
}

function runtimeEnvironment() {
  return { node: process.version, platform: process.platform, arch: process.arch }
}

// `pnpm verify` consumes the tracked source tree at HEAD, the architecture maps,
// the module registry, the dependency config and the pinned SDK binary.
function verifyStageInputs() {
  return {
    source: sourceRevisions(),
    architecture_maps: revisions(architectureMapPaths),
    registry: revisions(registryPaths),
    config: revisions(configPaths),
    environment: { ...runtimeEnvironment(), sdk: fileHash(join(root, '.appsdk', 'sdk.bin')) ?? null },
  }
}

// `pnpm smoke:installed` consumes the artifact, the producer record that attests
// it, the dependency config, its own scripts and the runtime environment. The
// producer record is the existing verify stage receipt: when the producer
// re-executed, this pass has no reliable basis to keep its evidence, so the
// artifact is re-verified through that producing stage instead of trusting a
// version name, mtime or file existence.
function smokeStageInputs({ artifactHash, producerReceiptId }) {
  return {
    artifact: {
      producer_stage: 'pnpm-verify',
      producer_receipt: producerReceiptId ?? null,
      artifact_hash: artifactHash ?? null,
    },
    config: revisions(configPaths),
    smoke_scripts: revisions(smokeScriptPaths),
    environment: runtimeEnvironment(),
  }
}

const sha256Pattern = /^[0-9a-f]{64}$/u

export function installedLifecycleReceipt({ receiptPath, expectedReceiptSha256, expectedPackContentSha256, expectedCandidateIdentity }) {
  if (!existsSync(receiptPath)) throw new Error(`installed lifecycle receipt is missing: ${receiptPath}`)
  const receiptHash = digest(readFileSync(receiptPath)).slice('sha256:'.length)
  if (expectedReceiptSha256 !== undefined && receiptHash !== expectedReceiptSha256) {
    throw new Error(`installed lifecycle receipt ${receiptPath} hash ${receiptHash} does not match the producer reference ${expectedReceiptSha256}`)
  }
  const receipt = readJson(receiptPath)
  const receiptCandidate = validateCandidateIdentity(receipt.candidate)
  if (expectedCandidateIdentity !== undefined) {
    assertCandidateIdentity(receiptCandidate, expectedCandidateIdentity, 'installed lifecycle receipt')
  }
  const lifecycle = receipt.lifecycle
  if (receipt.release_eligible !== false) throw new Error('installed lifecycle receipt must remain a non-release package receipt')
  if (lifecycle?.status !== 'passed') throw new Error('installed lifecycle receipt does not contain a passed installed start/restart')
  const start = lifecycle.start
  const restart = lifecycle.restart
  if (start?.state !== 'running' || restart?.state !== 'running') throw new Error('installed lifecycle receipt start/restart state is not running')
  if (!Number.isSafeInteger(start.generation) || !Number.isSafeInteger(restart.generation) || restart.generation <= start.generation) {
    throw new Error('installed lifecycle receipt restart generation did not advance')
  }
  if (!Array.isArray(start.processes) || start.processes.length !== 3 ||
      !Array.isArray(restart.processes) || restart.processes.length !== 3) {
    throw new Error('installed lifecycle receipt must bind Relay and two independent Agent processes for each generation')
  }
  const startPids = new Set([start.launcher?.pid, ...start.processes.map(process => process.pid)])
  if (startPids.size !== 4 || startPids.has(undefined)) throw new Error('installed lifecycle receipt start process identities are incomplete')
  if (!Number.isSafeInteger(restart.launcher?.pid) || startPids.has(restart.launcher.pid)) {
    throw new Error('installed lifecycle receipt restart did not prove a new launcher PID')
  }
  for (const process of restart.processes) {
    if (!Number.isSafeInteger(process.pid) || startPids.has(process.pid)) {
      throw new Error('installed lifecycle receipt restart did not prove new Agent/Relay PIDs')
    }
    if (typeof process.entryPath !== 'string' || !process.entryPath.includes('node_modules/agentteams/generated/runtime-lib/')) {
      throw new Error(`installed lifecycle receipt process did not load installed bytes: ${process.entryPath}`)
    }
  }
  if (typeof receipt.install?.cli_realpath !== 'string' || !receipt.install.cli_realpath.includes('node_modules/agentteams/cli/agentteams.mjs')) {
    throw new Error('installed lifecycle receipt CLI identity is not bound to the installed package')
  }
  const pack = receipt.pack
  const tarball = receipt.tarball
  const installedContentSha256 = receipt.install?.installed_content_sha256
  if (typeof pack?.content_sha256 !== 'string' || !sha256Pattern.test(pack.content_sha256)) {
    throw new Error('installed lifecycle receipt has no staged pack content hash')
  }
  if (pack.root !== 'generated/modules/teams-source/lib') {
    throw new Error(`installed lifecycle receipt pack root ${pack.root} is not the teams-source staged pack root`)
  }
  if (pack.content_sha256 !== expectedPackContentSha256) {
    throw new Error(`installed lifecycle receipt pack content ${pack.content_sha256} does not match this candidate package ${expectedPackContentSha256}`)
  }
  if (typeof tarball?.sha256 !== 'string' || !sha256Pattern.test(tarball.sha256)) {
    throw new Error('installed lifecycle receipt tarball sha256 is missing or malformed')
  }
  if (tarball.filename !== `agentteams-${receipt.package?.version}.tgz`) {
    throw new Error(`installed lifecycle receipt tarball ${tarball.filename} is not the candidate package version`)
  }
  const tarballFiles = Array.isArray(tarball.files) ? [...tarball.files].sort() : undefined
  const packFiles = Array.isArray(pack.files) ? [...pack.files].sort() : undefined
  if (tarball.content_sha256 !== pack.content_sha256 || tarballFiles === undefined || packFiles === undefined ||
      JSON.stringify(tarballFiles) !== JSON.stringify(packFiles)) {
    throw new Error('installed lifecycle receipt tarball content does not match the staged pack')
  }
  if (installedContentSha256 !== pack.content_sha256) {
    throw new Error(`installed lifecycle receipt installed content ${installedContentSha256} does not match the staged pack ${pack.content_sha256}`)
  }
  return { path: receiptPath, hash: `sha256:${receiptHash}`, candidate: receiptCandidate, tarballSha256: tarball.sha256,
    installedContentSha256, packContentSha256: pack.content_sha256, lifecycle }
}

// The deployment environment id is a real fact of the installed run (host,
// runtime and artifact bytes) required by the deployed evidence contract. It is
// recorded, not compared, so reuse never turns it into a second decision.
function deploymentEnvironmentId(artifactHash) {
  return artifactHash ? digest(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    artifactHash,
  })) : undefined
}

// A reused stage keeps the candidate its original receipt was produced on, so
// its installed receipt is checked against that candidate instead of the
// checkout's current commit.
function receiptCandidateIdentity(receipt) {
  const candidate = receipt.candidate ?? {}
  return {
    head_commit: candidate.head,
    base_commit: candidate.base,
    tree_hash: candidate.tree,
    indexed_tree_hash: candidate.tree,
    source_state: 'committed',
  }
}

const deployedEntrypoint = 'pnpm smoke:installed -> installed agentteams CLI start/status/stop -> installed Relay and two Agent entrypoints with actual restart generation/PID evidence'

function loadStageState(path, candidateInfo) {
  if (!existsSync(path)) return { version: stageStateVersion, candidate: candidateInfo, stages: {}, invalidationHistory: [] }
  const state = readJson(path)
  if (state.version !== stageStateVersion) {
    return { version: stageStateVersion, candidate: candidateInfo, stages: {}, invalidationHistory: [], invalidated_from: path }
  }
  state.candidate = candidateInfo
  state.invalidationHistory ??= []
  return state
}

function saveStageState(path, state) {
  writeJson(path, state, false)
}

function bindStageEvidence(stage, evidenceIds, extras = {}) {
  if (!stage.receiptPath) throw new Error(`stage ${stage.stageId ?? 'unknown'} has no durable receipt`)
  const receipt = readJson(stage.receiptPath)
  if (receipt.evidence_ids.length !== 0 && JSON.stringify(receipt.evidence_ids) !== JSON.stringify(evidenceIds)) {
    throw new Error(`stage receipt ${receipt.receipt_id} already has different evidence ids`)
  }
  writeJson(stage.receiptPath, { ...receipt, ...extras, evidence_ids: evidenceIds }, false)
}

function evidencePath(evidenceId) {
  return join(root, '.appsdk', 'records', 'evidence', moduleId, `${evidenceId}.json`)
}

// A stage's original evidence stays valid only while the records it produced
// are still present and still describe the same command, candidate, artifact
// and deployment environment recorded in that stage receipt.
function validateStageEvidence(receipt, expectedRecords) {
  if (!Array.isArray(receipt.evidence_ids) || receipt.evidence_ids.length !== expectedRecords.length) return false
  const receiptCandidate = receipt.candidate ?? {}
  const artifactHash = receipt.artifact_hash
  for (const [index, expected] of expectedRecords.entries()) {
    const evidenceId = receipt.evidence_ids[index]
    const path = evidencePath(evidenceId)
    if (!existsSync(path)) return false
    const record = readJson(path)
    if (record.evidence_id !== evidenceId ||
        record.result !== 'pass' ||
        Date.parse(record.expires_at) <= Date.now() ||
        record.expires_at !== receipt.expires_at ||
        record.source_commit !== receiptCandidate.head ||
        record.scope_hash !== receiptCandidate.scopeHash ||
        record.scope?.module_id !== moduleId ||
        record.scope?.entrypoint !== expected.entrypoint ||
        record.producer?.adapter !== adapter ||
        record.producer?.identity !== expected.identity ||
        record.phase !== expected.phase ||
        record.kind !== expected.kind ||
        (artifactHash !== undefined && record.artifact_hash !== artifactHash) ||
        (expected.environmentId !== undefined && record.environment_id !== expected.environmentId) ||
        record.execution_surface !== expected.executionSurface ||
        record.command !== expected.command ||
        record.input_hashes?.[0] !== digest(JSON.stringify({
          command: expected.command,
          sourceCommit: receiptCandidate.head,
          artifactHash,
        }))) {
      return false
    }
  }
  return true
}

// Every stage receipt carries its actual consumed inputs. A later run compares
// only those actual inputs against the stored values; there is no second
// fingerprint, snapshot or reuse ledger.
function stageReusable(previous, previousReceipt, actualInputs, requiredPaths, command) {
  const previousInputs = previous?.actualInputs
  if ((previous?.status !== 'passed' && previous?.status !== 'reused') ||
      previousReceipt?.stage_id !== previous.stageId ||
      previousReceipt?.result !== 'pass' ||
      previousReceipt?.receipt_id !== previous.receiptId ||
      Date.parse(previous.expiresAt) <= Date.now() ||
      Date.parse(previousReceipt.expires_at) <= Date.now() ||
      previous.logPath === undefined || !existsSync(previous.logPath) ||
      previous.logHash !== digest(readFileSync(previous.logPath)) ||
      !Array.isArray(previousReceipt.evidence_ids) || previousReceipt.evidence_ids.length === 0 ||
      previousReceipt.log_hash !== previous.logHash ||
      JSON.stringify(previousReceipt.command) !== JSON.stringify(command) ||
      JSON.stringify(previous.command) !== JSON.stringify(command) ||
      previousInputs === undefined ||
      JSON.stringify(previousReceipt.actual_inputs ?? null) !== JSON.stringify(previousInputs) ||
      JSON.stringify(previousInputs) !== JSON.stringify(actualInputs)) {
    return false
  }
  const currentPathHashes = pathHashes(requiredPaths)
  return Object.keys(currentPathHashes).length === requiredPaths.length &&
    JSON.stringify(previousReceipt.required_path_hashes ?? {}) === JSON.stringify(currentPathHashes)
}

function changedInputGroups(previousInputs, actualInputs) {
  const groups = new Set([...Object.keys(previousInputs ?? {}), ...Object.keys(actualInputs ?? {})])
  return [...groups].filter(group => JSON.stringify(previousInputs?.[group] ?? null) !== JSON.stringify(actualInputs?.[group] ?? null))
}

function runStage({ state, statePath, receiptRoot, stageId, command, logPath, candidateInfo, requiredPaths = [], actualInputs = {},
  dependsOn = [], env = {}, stageEvidence, validateEvidence, executedExtras = {} }) {
  const previous = state.stages[stageId]
  const previousReceiptPath = previous?.receiptPath
  const previousReceipt = previousReceiptPath && existsSync(previousReceiptPath) ? readJson(previousReceiptPath) : undefined
  let reusable = stageReusable(previous, previousReceipt, actualInputs, requiredPaths, command)
  if (reusable && validateEvidence) reusable = validateEvidence(previousReceipt)
  if (reusable) {
    const reusedAt = now()
    state.stages[stageId] = { ...previous, status: 'reused', reusedAt, actualInputs, dependsOn: previous.dependsOn ?? dependsOn }
    saveStageState(statePath, state)
    return { output: readFileSync(previous.logPath, 'utf8'), reused: true, receiptId: previous.receiptId,
      receiptPath: previousReceiptPath, sourceEvidenceIds: previousReceipt.evidence_ids,
      evidenceRecords: previousReceipt.evidence_ids.map(evidenceId => readJson(evidencePath(evidenceId))),
      expiresAt: previous.expiresAt, reusedAt }
  }

  if (previous?.status === 'passed' || previous?.status === 'reused') {
    const invalidatedAt = now()
    const changed = changedInputGroups(previous.actualInputs, actualInputs)
    const invalidationReason = changed.length === 0 ? 'stored_evidence_invalid' : 'consumed_inputs_changed'
    state.invalidationHistory ??= []
    state.invalidationHistory.push({
      stage_id: stageId,
      invalidated_at: invalidatedAt,
      reason: invalidationReason,
      ...(changed.length === 0 ? {} : { changed_inputs: changed }),
    })
    state.stages[stageId] = { ...previous, status: 'invalidated', invalidatedAt, invalidationReason }
    saveStageState(statePath, state)
  }
  state.stages[stageId] = { stageId, status: 'running', command, actualInputs, dependsOn, startedAt: now(), logPath }
  saveStageState(statePath, state)
  try {
    const output = run(command[0], command.slice(1), logPath, root, env)
    const receiptId = `stage-${stageId}-${Date.now()}`
    const receiptPath = join(receiptRoot, `${receiptId}.json`)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    writeJson(receiptPath, { receipt_id: receiptId, stage_id: stageId, result: 'pass',
      candidate: candidateInfo, command, actual_inputs: actualInputs,
      log_path: logPath, log_hash: digest(readFileSync(logPath)),
      required_path_hashes: pathHashes(requiredPaths), evidence_ids: [], created_at: now(), expires_at: expiresAt })
    const evidenceRecords = stageEvidence ? stageEvidence({ output, receiptId, receiptPath, expiresAt }) : []
    for (const record of evidenceRecords) writeJson(evidencePath(record.evidence_id), record)
    const sourceEvidenceIds = evidenceRecords.map(record => record.evidence_id)
    const receiptExtras = { ...executedExtras }
    if (evidenceRecords[0]?.artifact_hash !== undefined) receiptExtras.artifact_hash = evidenceRecords[0].artifact_hash
    if (evidenceRecords[0]?.environment_id !== undefined) receiptExtras.environment_id = evidenceRecords[0].environment_id
    if (sourceEvidenceIds.length > 0) bindStageEvidence({ stageId, receiptPath }, sourceEvidenceIds, receiptExtras)
    state.stages[stageId] = { ...state.stages[stageId], status: 'passed', receiptId, completedAt: now(),
      expiresAt, receiptPath, logHash: digest(readFileSync(logPath)), actualInputs, dependsOn,
      evidenceIds: sourceEvidenceIds }
    saveStageState(statePath, state)
    return { output, reused: false, receiptId, receiptPath, sourceEvidenceIds, evidenceRecords, expiresAt }
  } catch (error) {
    state.stages[stageId] = { ...state.stages[stageId], status: 'blocked', error: String(error), failedAt: now() }
    saveStageState(statePath, state)
    throw error
  }
}

function git(args) {
  // The candidate diff hash is a required fix-candidate record field and the
  // whole base...head range can exceed the 1 MiB spawnSync default. Give git
  // room and report a real overflow as itself.
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${result.stderr || result.stdout}`.trim())
  return result.stdout.trim()
}

function candidate() {
  const head = git(['rev-parse', 'HEAD'])
  const base = git(['merge-base', 'HEAD', 'origin/main'])
  const changedPaths = git(['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean)
  return {
    head,
    base,
    tree: git(['rev-parse', `${head}^{tree}`]),
    diffHash: digest(git(['diff', '--binary', `${base}...${head}`])),
    scopeHash: digest(JSON.stringify({ moduleId, changed: changedPaths })),
    changedPaths,
  }
}

function assertCleanSource() {
  const dirty = git(['status', '--porcelain']).split('\n').filter(Boolean)
    .filter(line => !/^\?\? \.appsdk\/records\//u.test(line))
  if (dirty.length !== 0) {
    throw new Error(`lifecycle adapter requires a committed clean candidate:\n${dirty.join('\n')}`)
  }
}

function evidence({ id, phase, kind, candidateInfo, createdAt, command, commandOutput, artifactHash, environmentId, entrypoint, executionSurface, identity, execution, expiresAt }) {
  return {
    evidence_id: id,
    issue_id: issueId,
    experiment_id: issueId,
    phase,
    kind,
    source_commit: candidateInfo.head,
    scope: { module_id: moduleId, entrypoint },
    producer: { adapter, identity },
    result: 'pass',
    created_at: createdAt,
    expires_at: expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    input_hashes: [
      digest(JSON.stringify({ command, sourceCommit: candidateInfo.head, artifactHash })),
      digest(commandOutput),
    ],
    scope_hash: candidateInfo.scopeHash,
    ...(artifactHash ? { artifact_hash: artifactHash } : {}),
    ...(environmentId ? { environment_id: environmentId } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...(executionSurface ? { execution_surface: executionSurface } : {}),
    execution: execution ?? { mode: 'executed' },
    command,
  }
}

function writeRecord(path, value) {
  if (!existsSync(path)) {
    writeJson(path, value)
    return
  }
  const existing = readJson(path)
  if (JSON.stringify(existing) !== JSON.stringify(value)) {
    throw new Error(`immutable lifecycle record already exists with different content: ${path}`)
  }
}

// A validation is reusable only while every evidence id it names is still a
// present, passing, unexpired record and its stage_execution still names the
// current stage-store receipts. Candidate identity alone is not enough: an
// evidence repair can leave an older validation for the same candidate behind.
function validationEvidenceIds(validation) {
  const ids = new Set([
    ...(validation.whitebox_evidence_ids ?? []),
    ...(validation.blackbox_evidence_ids ?? []),
  ])
  if (validation.deployment?.install_receipt_id !== undefined) ids.add(validation.deployment.install_receipt_id)
  if (validation.deployment?.restart_receipt_id !== undefined) ids.add(validation.deployment.restart_receipt_id)
  for (const execution of Object.values(validation.stage_execution ?? {})) {
    for (const evidenceId of execution?.evidence_ids ?? []) ids.add(evidenceId)
  }
  return [...ids]
}

function validationEvidenceValid(validation) {
  const evidenceIds = validationEvidenceIds(validation)
  if (evidenceIds.length === 0) return false
  for (const evidenceId of evidenceIds) {
    const path = evidencePath(evidenceId)
    if (!existsSync(path)) return false
    const record = readJson(path)
    const expiresAt = Date.parse(record.expires_at)
    if (record.evidence_id !== evidenceId ||
        record.result !== 'pass' ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= Date.now()) {
      return false
    }
  }
  return true
}

function validationBindsCurrentStages(validation, stageState) {
  for (const stageId of ['pnpm-verify', 'pnpm-smoke-installed']) {
    const stage = stageState.stages?.[stageId]
    const execution = validation.stage_execution?.[stageId]
    if (stage?.receiptId === undefined || execution === undefined) return false
    const receiptId = execution.mode === 'reused' ? execution.source_receipt_id : execution.receipt_id
    if (receiptId !== stage.receiptId) return false
    const executionEvidenceIds = execution.evidence_ids ?? execution.source_evidence_ids ?? []
    if (JSON.stringify(executionEvidenceIds) !== JSON.stringify(stage.evidenceIds ?? [])) return false
  }
  return true
}

function findExistingValidationRecord(recordsRoot, candidateInfo, stageState) {
  if (!existsSync(recordsRoot)) return undefined
  for (const name of readdirSync(recordsRoot)) {
    if (!name.startsWith(`pre-review-validation-record-${moduleId}`)) continue
    const path = join(recordsRoot, name)
    try {
      const record = readJson(path)
      if (record.candidate_commit === candidateInfo.head &&
          record.candidate_tree_hash === candidateInfo.tree &&
          record.result === 'pass' &&
          validationBindsCurrentStages(record, stageState) &&
          validationEvidenceValid(record)) {
        return path
      }
    } catch {
      // A broken record is not evidence and cannot satisfy an idempotent entry.
    }
  }
  return undefined
}

function u1InstalledReceiptPath(head) {
  return join(root, '.appsdk-control', 'lifecycle-adapter', 'u1-installed-receipts', head, 'installed-runtime-smoke.receipt.json')
}

export function candidatePackReceipt(
  receiptPath = join(root, 'generated', 'modules', moduleId, 'package-receipt.json'),
  expectedCandidateIdentity = currentCandidateIdentity(root),
) {
  const packageReceiptPath = resolve(receiptPath)
  if (!existsSync(packageReceiptPath)) throw new Error(`staged package receipt is missing: ${packageReceiptPath}`)
  const packageReceipt = readJson(packageReceiptPath)
  const candidateIdentity = validateCandidateIdentity(packageReceipt.candidate)
  assertCandidateIdentity(candidateIdentity, expectedCandidateIdentity, 'staged package receipt')
  if (typeof packageReceipt.content_sha256 !== 'string' || !sha256Pattern.test(packageReceipt.content_sha256)) {
    throw new Error(`staged package receipt has no content hash: ${packageReceiptPath}`)
  }
  return { path: packageReceiptPath, contentSha256: packageReceipt.content_sha256, candidate: candidateIdentity }
}

function parseInstalledReceiptReference(output) {
  const match = /^u1-installed-receipt (\S+) sha256:([0-9a-f]{64})$/mu.exec(output)
  if (!match) throw new Error('installed runtime smoke did not emit an exact installed receipt reference')
  return { path: resolve(match[1]), sha256: match[2] }
}

function main() {
  assertCleanSource()
  const candidateInfo = candidate()
  const stageRoot = join(root, '.appsdk-control', 'lifecycle-adapter', 'stages')
  const stageStatePath = join(stageRoot, `${issueId}.json`)
  const stageState = loadStageState(stageStatePath, candidateInfo)
  const currentArtifactPath = join(root, 'generated', 'modules', moduleId, 'module.compiled.json')
  const previousSmokeStage = stageState.stages['pnpm-smoke-installed']
  const u1ReceiptPath = previousSmokeStage?.installedReceiptPath ?? u1InstalledReceiptPath(candidateInfo.head)
  const verifyInputs = verifyStageInputs()
  const attempt = `attempt-${Date.now()}-${randomUUID()}`
  const recordsRoot = join(root, '.appsdk', 'records')
  const validationPath = join(recordsRoot, `pre-review-validation-record-${moduleId}-${candidateInfo.head}-${attempt}.json`)
  const controlRoot = join(root, '.appsdk-control', 'lifecycle-adapter', attempt)
  const commandRoot = join(controlRoot, 'commands')
  const receiptRoot = join(stageRoot, 'receipts')
  const recordSuffix = `-${candidateInfo.head}-${attempt}`
  const worktreeRecordPath = join(recordsRoot, `worktree-record${recordSuffix}.json`)
  const moduleWorktreeRecordPath = join(recordsRoot, `worktree-record-${moduleId}${recordSuffix}.json`)
  const evidenceRecordPath = join(recordsRoot, `evidence-record${recordSuffix}.json`)
  const moduleEvidenceRecordPath = join(recordsRoot, `evidence-record-${moduleId}${recordSuffix}.json`)
  const candidateRecordPath = join(recordsRoot, `fix-candidate-record-${moduleId}${recordSuffix}.json`)
  mkdirSync(commandRoot, { recursive: true })
  writeJson(join(controlRoot, 'transaction.json'), {
    attempt,
    module_id: moduleId,
    issue_id: issueId,
    candidate: candidateInfo,
    state: 'running',
    created_at: now(),
  })

  try {
    const candidateCreatedAt = now()
    const verifyEvidenceSpec = [
      {
        identity: `${adapter}/whitebox`,
        phase: 'development_whitebox',
        kind: 'gate',
        entrypoint: 'pnpm verify',
        executionSurface: 'development_whitebox',
        command: 'pnpm verify',
      },
      {
        identity: `${adapter}/build`,
        phase: 'artifact',
        kind: 'build',
        entrypoint: 'generated/modules/teams-source/module.compiled.json',
        executionSurface: 'development_whitebox',
        command: 'appsdk compile (inside pnpm verify)',
      },
    ]
    const verifyStage = runStage({ state: stageState, statePath: stageStatePath, receiptRoot, stageId: 'pnpm-verify',
      command: ['pnpm', 'verify'], logPath: join(commandRoot, 'pnpm-verify.log'), candidateInfo,
      requiredPaths: [join(root, 'generated', 'modules', moduleId, 'module.compiled.json')],
      actualInputs: verifyInputs,
      dependsOn: [],
      stageEvidence: ({ output, receiptId, receiptPath, expiresAt }) => {
        const stageArtifact = readJson(currentArtifactPath)
        if (stageArtifact.source_commit && stageArtifact.source_commit !== candidateInfo.head) {
          throw new Error(`compiled artifact source commit ${stageArtifact.source_commit} does not match ${candidateInfo.head}`)
        }
        const artifactHash = stageArtifact.artifact_hash
        const execution = { mode: 'executed', receipt_id: receiptId, receipt_path: receiptPath }
        const createdAt = now()
        return [
          evidence({
            id: `${attempt}-whitebox`,
            phase: 'development_whitebox',
            kind: 'gate',
            candidateInfo,
            createdAt,
            command: 'pnpm verify',
            commandOutput: output,
            artifactHash,
            entrypoint: 'pnpm verify',
            executionSurface: 'development_whitebox',
            identity: `${adapter}/whitebox`,
            execution,
            expiresAt,
          }),
          evidence({
            id: `${attempt}-artifact`,
            phase: 'artifact',
            kind: 'build',
            candidateInfo,
            createdAt,
            command: 'appsdk compile (inside pnpm verify)',
            commandOutput: output,
            artifactHash,
            entrypoint: 'generated/modules/teams-source/module.compiled.json',
            executionSurface: 'development_whitebox',
            identity: `${adapter}/build`,
            execution,
            expiresAt,
          }),
        ]
      },
      validateEvidence: receipt => {
        if (!existsSync(currentArtifactPath)) return false
        const stageArtifact = readJson(currentArtifactPath)
        if (stageArtifact.source_commit && stageArtifact.source_commit !== receipt.candidate?.head) return false
        return validateStageEvidence(receipt, verifyEvidenceSpec)
      } })
    const artifact = readJson(currentArtifactPath)
    const artifactHash = artifact.artifact_hash
    const environmentId = deploymentEnvironmentId(artifactHash)
    const smokeInputs = smokeStageInputs({
      artifactHash,
      producerReceiptId: verifyStage.receiptId,
    })
    const smokeEvidenceSpec = [
      {
        identity: `${adapter}/deployment`,
        phase: 'deployment_install',
        kind: 'install',
        entrypoint: deployedEntrypoint,
        executionSurface: 'deployed_blackbox',
        command: 'pnpm smoke:installed',
        environmentId,
      },
      {
        identity: `${adapter}/deployment`,
        phase: 'deployment_restart',
        kind: 'restart',
        entrypoint: deployedEntrypoint,
        executionSurface: 'deployed_blackbox',
        command: 'pnpm smoke:installed',
        environmentId,
      },
      {
        identity: `${adapter}/deployment`,
        phase: 'deployed_blackbox',
        kind: 'runtime',
        entrypoint: deployedEntrypoint,
        executionSurface: 'deployed_blackbox',
        command: 'pnpm smoke:installed',
        environmentId,
      },
    ]

    const smokeStage = runStage({ state: stageState, statePath: stageStatePath, receiptRoot, stageId: 'pnpm-smoke-installed',
      command: ['pnpm', 'smoke:installed'], logPath: join(commandRoot, 'pnpm-smoke-installed.log'), candidateInfo,
      dependsOn: ['pnpm-verify'],
      requiredPaths: [join(root, 'generated', 'modules', moduleId, 'module.compiled.json'),
        join(root, 'generated', 'modules', moduleId, 'package-receipt.json'), u1ReceiptPath,
        join(root, 'scripts', 'package-user-smoke.mjs'), join(root, 'scripts', 'installed-runtime-smoke.mjs'),
        join(root, 'scripts', 'runtime-smoke.mjs'), join(root, 'package.json'), join(root, 'pnpm-workspace.yaml')],
      actualInputs: smokeInputs,
      env: { AGENTTEAMS_U1_INSTALLED_RECEIPT_PATH: u1ReceiptPath },
      executedExtras: { installed_receipt_path: u1ReceiptPath },
      stageEvidence: ({ output, receiptId, receiptPath, expiresAt }) => {
        const receiptReference = parseInstalledReceiptReference(output)
        if (receiptReference.path !== u1ReceiptPath) {
          throw new Error(`installed receipt path ${receiptReference.path} does not match the adapter-owned ${u1ReceiptPath}`)
        }
        const installedLifecycle = installedLifecycleReceipt({
          receiptPath: receiptReference.path,
          expectedReceiptSha256: receiptReference.sha256,
          expectedPackContentSha256: candidatePackReceipt().contentSha256,
          expectedCandidateIdentity: currentCandidateIdentity(root),
        })
        const installedOutput = `${output}
installed lifecycle receipt ${installedLifecycle.path} ${installedLifecycle.hash}
installed lifecycle tarball ${installedLifecycle.tarballSha256}
installed lifecycle pack content ${installedLifecycle.packContentSha256}
installed lifecycle generations ${installedLifecycle.lifecycle.start.generation} -> ${installedLifecycle.lifecycle.restart.generation}
`
        const execution = { mode: 'executed', receipt_id: receiptId, receipt_path: receiptPath }
        const createdAt = now()
        return [
          evidence({
            id: `${attempt}-install`,
            phase: 'deployment_install',
            kind: 'install',
            candidateInfo,
            createdAt,
            command: 'pnpm smoke:installed',
            commandOutput: installedOutput,
            artifactHash,
            environmentId,
            entrypoint: deployedEntrypoint,
            executionSurface: 'deployed_blackbox',
            identity: `${adapter}/deployment`,
            execution,
            expiresAt,
          }),
          evidence({
            id: `${attempt}-restart`,
            phase: 'deployment_restart',
            kind: 'restart',
            candidateInfo,
            createdAt,
            command: 'pnpm smoke:installed',
            commandOutput: installedOutput,
            artifactHash,
            environmentId,
            entrypoint: deployedEntrypoint,
            executionSurface: 'deployed_blackbox',
            identity: `${adapter}/deployment`,
            execution,
            expiresAt,
          }),
          evidence({
            id: `${attempt}-blackbox`,
            phase: 'deployed_blackbox',
            kind: 'runtime',
            candidateInfo,
            createdAt,
            command: 'pnpm smoke:installed',
            commandOutput: installedOutput,
            artifactHash,
            environmentId,
            entrypoint: deployedEntrypoint,
            executionSurface: 'deployed_blackbox',
            identity: `${adapter}/deployment`,
            execution,
            expiresAt,
          }),
        ]
      },
      validateEvidence: receipt => {
        try {
          const installedReceiptPath = receipt.installed_receipt_path ?? u1ReceiptPath
          const receiptReference = parseInstalledReceiptReference(readFileSync(receipt.log_path, 'utf8'))
          if (receiptReference.path !== installedReceiptPath) return false
          installedLifecycleReceipt({
            receiptPath: receiptReference.path,
            expectedReceiptSha256: receiptReference.sha256,
            expectedPackContentSha256: candidatePackReceipt(undefined, receiptCandidateIdentity(receipt)).contentSha256,
            expectedCandidateIdentity: receiptCandidateIdentity(receipt),
          })
        } catch {
          return false
        }
        return validateStageEvidence(receipt, smokeEvidenceSpec)
      } })

    // Persist the installed receipt path on the stage record when the stage first
    // executes. Later reuse and re-execution read this stored path instead of
    // deriving a new one from the current HEAD commit.
    if (stageState.stages['pnpm-smoke-installed']?.installedReceiptPath !== u1ReceiptPath) {
      stageState.stages['pnpm-smoke-installed'] = {
        ...stageState.stages['pnpm-smoke-installed'],
        installedReceiptPath: u1ReceiptPath,
      }
      saveStageState(stageStatePath, stageState)
    }

    // A repeated entry for a candidate that already has a committed pre-review
    // validation runs no command: both stages settled from their own stored
    // inputs and receipts, so the completed validation is returned instead of
    // writing a second record for the same candidate.
    const committedValidationPath = findExistingValidationRecord(recordsRoot, candidateInfo, stageState)
    if (committedValidationPath !== undefined && verifyStage.reused && smokeStage.reused) {
      const transactionPath = join(controlRoot, 'transaction.json')
      writeJson(transactionPath, { ...readJson(transactionPath), state: 'idempotent', completed_at: now() }, false)
      process.stdout.write(`${JSON.stringify({ ok: true, idempotent: true,
        validation_id: readJson(committedValidationPath).validation_id, candidate: candidateInfo.head })}\n`)
      return
    }
    const verifyExecution = verifyStage.reused ? { mode: 'reused', source_receipt_id: verifyStage.receiptId,
      source_receipt_path: verifyStage.receiptPath, source_evidence_ids: verifyStage.sourceEvidenceIds,
      evidence_ids: verifyStage.sourceEvidenceIds } :
      { mode: 'executed', receipt_id: verifyStage.receiptId, receipt_path: verifyStage.receiptPath,
        evidence_ids: verifyStage.sourceEvidenceIds }
    const smokeExecution = smokeStage.reused ? { mode: 'reused', source_receipt_id: smokeStage.receiptId,
      source_receipt_path: smokeStage.receiptPath, source_evidence_ids: smokeStage.sourceEvidenceIds,
      evidence_ids: smokeStage.sourceEvidenceIds } :
      { mode: 'executed', receipt_id: smokeStage.receiptId, receipt_path: smokeStage.receiptPath,
        evidence_ids: smokeStage.sourceEvidenceIds }
    const verifyEvidenceRecords = verifyStage.evidenceRecords
    const smokeEvidenceRecords = smokeStage.evidenceRecords
    const whitebox = verifyEvidenceRecords.find(record => record.phase === 'development_whitebox')
    const build = verifyEvidenceRecords.find(record => record.phase === 'artifact')
    const install = smokeEvidenceRecords.find(record => record.phase === 'deployment_install')
    const restart = smokeEvidenceRecords.find(record => record.phase === 'deployment_restart')
    const blackbox = smokeEvidenceRecords.find(record => record.phase === 'deployed_blackbox')
    if (!whitebox || !build || !install || !restart || !blackbox) {
      throw new Error('lifecycle stage evidence records are incomplete')
    }
    assertCleanSource()
    if (git(['rev-parse', 'HEAD']) !== candidateInfo.head || git(['rev-parse', 'HEAD^{tree}']) !== candidateInfo.tree) {
      throw new Error('candidate source changed during lifecycle execution')
    }

    const worktreeId = `worktree-${candidateInfo.head.slice(0, 12)}`
    const fixCandidateId = `fix-${candidateInfo.head.slice(0, 12)}-${attempt}`
    const evidenceSet = [whitebox, build, install, restart, blackbox]
    const worktree = {
      worktree_id: worktreeId,
      issue_id: issueId,
      module_id: moduleId,
      base_ref: 'origin/main',
      base_commit: candidateInfo.base,
      branch: git(['branch', '--show-current']) || 'HEAD',
      head_commit: candidateInfo.head,
      initial_clean: true,
      final_clean: true,
      isolation_mode: 'isolated_worktree',
      scope_hash: candidateInfo.scopeHash,
      created_at: candidateCreatedAt,
    }
    const candidateRecord = {
      fix_candidate_id: fixCandidateId,
      issue_id: issueId,
      module_id: moduleId,
      worktree_id: worktreeId,
      base_commit: candidateInfo.base,
      head_commit: candidateInfo.head,
      tree_hash: candidateInfo.tree,
      diff_hash: candidateInfo.diffHash,
      design_id: issueId,
      owner: adapter,
      scope_hash: candidateInfo.scopeHash,
      changed_paths: candidateInfo.changedPaths,
      verification_evidence_ids: evidenceSet.map(item => item.evidence_id),
      created_at: candidateCreatedAt,
    }
    const validation = {
      validation_id: `validation-${attempt}`,
      issue_id: issueId,
      module_id: moduleId,
      fix_candidate_id: fixCandidateId,
      candidate_commit: candidateInfo.head,
      candidate_tree_hash: candidateInfo.tree,
      artifact_hash: artifactHash,
      whitebox_producer: { adapter, identity: `${adapter}/whitebox` },
      whitebox_evidence_ids: [whitebox.evidence_id],
      blackbox_evidence_ids: [blackbox.evidence_id],
      deployment: {
        environment_id: environmentId,
        install_receipt_id: install.evidence_id,
        restart_receipt_id: restart.evidence_id,
        entrypoint: deployedEntrypoint,
        producer: { adapter, identity: `${adapter}/deployment` },
        observed_at: blackbox.created_at,
      },
      stage_execution: {
        'pnpm-verify': verifyExecution,
        'pnpm-smoke-installed': smokeExecution,
      },
      source_unchanged: true,
      result: 'pass',
      created_at: now(),
    }
    writeRecord(worktreeRecordPath, worktree)
    writeRecord(moduleWorktreeRecordPath, worktree)
    writeRecord(evidenceRecordPath, whitebox)
    writeRecord(moduleEvidenceRecordPath, whitebox)
    writeJson(candidateRecordPath, candidateRecord)
    writeJson(validationPath, validation)
    writeJson(join(controlRoot, 'result.json'), {
      attempt,
      state: 'committed',
      candidate: candidateInfo,
      artifact_hash: artifactHash,
      environment_id: environmentId,
      records: [
        candidateRecordPath,
        validationPath,
        ...evidenceSet.map(item => evidencePath(item.evidence_id)),
      ],
      completed_at: now(),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, attempt, candidate: candidateInfo.head, artifact_hash: artifactHash, records: validationPath })}\n`)
  } catch (error) {
    writeJson(join(controlRoot, 'failure.json'), {
      attempt,
      state: 'failed',
      error: String(error),
      failed_at: now(),
    }, false)
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main()
}
