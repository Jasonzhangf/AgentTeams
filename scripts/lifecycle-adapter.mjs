import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCandidateIdentity, currentCandidateIdentity, validateCandidateIdentity } from './receipt-identity.mjs'

const root = resolve(import.meta.dirname, '..')
const moduleId = 'teams-source'
const issueId = 'teams-lifecycle-admission'
const adapter = 'agentteams::lifecycle-adapter:v1'
const stageStateVersion = 3

const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const now = () => new Date().toISOString()

function writeJson(path, value, exclusive = true) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, exclusive ? { flag: 'wx' } : undefined)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function run(program, args, logPath, cwd = root, extraEnv = {}) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      ...extraEnv,
      CI: 'true',
      npm_config_fetch_timeout: '30000',
      npm_config_prefer_offline: 'true',
    },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  writeFileSync(logPath, output)
  if (result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed with status ${result.status}\n${output.trim()}`)
  }
  return output
}

function stageFingerprint(candidateInfo, stageId, command, extra = {}) {
  const lockfile = join(root, 'pnpm-lock.yaml')
  const { inputCandidate = candidateInfo, ...stageInputs } = extra
  return digest(JSON.stringify({
    stageId,
    command,
    candidate: inputCandidate,
    lockfile: existsSync(lockfile) ? digest(readFileSync(lockfile)) : undefined,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    tools: toolVersions(),
    governance: governanceInputHashes(),
    ...stageInputs,
  }))
}

function pathHashes(paths) {
  return Object.fromEntries(paths.filter(path => existsSync(path)).map(path => [path, digest(readFileSync(path))]))
}

function fileHash(path) {
  return existsSync(path) ? digest(readFileSync(path)) : undefined
}

function governanceInputHashes() {
  return pathHashes([
    join(root, '.appsdk', 'maps', 'function-map.json'),
    join(root, '.appsdk', 'maps', 'mainline-call-map.json'),
    join(root, '.appsdk', 'maps', 'module-registry.json'),
    join(root, '.appsdk', 'maps', 'resource-map.json'),
    join(root, '.appsdk', 'maps', 'verification-map.json'),
    join(root, '.appsdk', 'contracts', 'project.schema.json'),
    join(root, '.appsdk', 'contracts', 'sdk-bundle.manifest.json'),
    join(root, 'docs', 'architecture', 'function-map.json'),
    join(root, 'docs', 'architecture', 'mainline-call-map.json'),
    join(root, 'docs', 'architecture', 'module-map.json'),
    join(root, 'docs', 'architecture', 'resource-map.json'),
    join(root, 'docs', 'architecture', 'verification-map.json'),
  ])
}

function moduleScope() {
  const registry = readJson(join(root, '.appsdk', 'maps', 'module-registry.json'))
  const module = registry.modules.find(item => item.module_id === moduleId)
  if (!module) throw new Error(`module registry entry missing for ${moduleId}`)
  return { allowedPaths: module.owned_paths, forbiddenPaths: module.forbidden_paths }
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
  if (receipt.release_eligible !== false) throw new Error('installed lifecycle receipt must remain a non-release base package receipt')
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

function stageInputs(candidateInfo, artifactHash, installedReceiptPath) {
  const environmentId = artifactHash ? digest(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    artifactHash,
  })) : undefined
  const deployedEntrypoint = 'pnpm smoke:installed -> installed agentteams CLI start/status/stop -> installed Relay and two Agent entrypoints with actual restart generation/PID evidence'
  return {
    verify: { inputCandidate: candidateInfo, ...moduleScope(), changedPaths: candidateInfo.changedPaths },
    smoke: { inputCandidate: candidateInfo, artifactHash, environmentId, entrypoint: deployedEntrypoint,
      installedReceiptPath,
      runtimeInputs: pathHashes([
        join(root, 'scripts', 'package-user-smoke.mjs'),
        join(root, 'scripts', 'installed-runtime-smoke.mjs'),
        join(root, 'scripts', 'runtime-smoke.mjs'),
        join(root, 'package.json'),
        join(root, 'pnpm-workspace.yaml'),
      ]),
      credentialRefs: {
        AGENTTEAMS_PROVIDER_AUTH: process.env.AGENTTEAMS_PROVIDER_AUTH ? digest(process.env.AGENTTEAMS_PROVIDER_AUTH) : 'generated-default-by-cli',
        AGENTTEAMS_RECEIVER_AUTH: process.env.AGENTTEAMS_RECEIVER_AUTH ? digest(process.env.AGENTTEAMS_RECEIVER_AUTH) : 'generated-default-by-cli',
      } },
    environmentId,
    deployedEntrypoint,
  }
}

function toolVersions() {
  const pnpm = spawnSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' })
  const appsdk = spawnSync('appsdk', ['--version'], { cwd: root, encoding: 'utf8' })
  const openssl = spawnSync('openssl', ['version'], { cwd: root, encoding: 'utf8' })
  return { pnpm: pnpm.stdout?.trim(), appsdk: appsdk.stdout?.trim(), openssl: openssl.stdout?.trim(), node: process.version }
}

function loadStageState(path, candidateInfo) {
  if (!existsSync(path)) return { version: stageStateVersion, candidate: candidateInfo, stages: {}, reuseReceipts: [], invalidationHistory: [] }
  const state = readJson(path)
  if (state.version !== stageStateVersion) {
    return { version: stageStateVersion, candidate: candidateInfo, stages: {}, reuseReceipts: [], invalidationHistory: [], invalidated_from: path }
  }
  state.candidate = candidateInfo
  state.reuseReceipts ??= []
  state.invalidationHistory ??= []
  return state
}

function saveStageState(path, state) {
  writeJson(path, state, false)
}

function bindStageEvidence(stage, evidenceIds) {
  if (!stage.receiptPath) throw new Error(`stage ${stage.stageId ?? 'unknown'} has no durable receipt`)
  const receipt = readJson(stage.receiptPath)
  if (receipt.evidence_ids.length !== 0 && JSON.stringify(receipt.evidence_ids) !== JSON.stringify(evidenceIds)) {
    throw new Error(`stage receipt ${receipt.receipt_id} already has different evidence ids`)
  }
  writeJson(stage.receiptPath, { ...receipt, evidence_ids: evidenceIds }, false)
}

function evidencePath(evidenceId) {
  return join(root, '.appsdk', 'records', 'evidence', moduleId, `${evidenceId}.json`)
}

function validateStageEvidence(receipt, expectedRecords, candidateInfo, artifactHash) {
  if (!Array.isArray(receipt.evidence_ids) || receipt.evidence_ids.length !== expectedRecords.length) return false
  for (const [index, expected] of expectedRecords.entries()) {
    const evidenceId = receipt.evidence_ids[index]
    const path = evidencePath(evidenceId)
    if (!existsSync(path)) return false
    const record = readJson(path)
    if (record.evidence_id !== evidenceId ||
        record.result !== 'pass' ||
        Date.parse(record.expires_at) <= Date.now() ||
        record.expires_at !== receipt.expires_at ||
        record.source_commit !== candidateInfo.head ||
        record.scope_hash !== candidateInfo.scopeHash ||
        record.scope?.module_id !== moduleId ||
        record.scope?.entrypoint !== expected.entrypoint ||
        record.producer?.adapter !== adapter ||
        record.producer?.identity !== expected.identity ||
        record.phase !== expected.phase ||
        record.kind !== expected.kind ||
        record.artifact_hash !== artifactHash ||
        record.environment_id !== expected.environmentId ||
        record.execution_surface !== expected.executionSurface ||
        record.command !== expected.command ||
        record.input_hashes?.[0] !== digest(JSON.stringify({
          command: expected.command,
          sourceCommit: candidateInfo.head,
          artifactHash,
        }))) {
      return false
    }
  }
  return true
}

function runStage({ state, statePath, receiptRoot, stageId, command, logPath, candidateInfo, requiredPaths = [], extra = {},
  remainingStages = [], env = {}, stageEvidence, validateEvidence }) {
  const fingerprint = stageFingerprint(candidateInfo, stageId, command, extra)
  const previous = state.stages[stageId]
  const currentPathHashes = pathHashes(requiredPaths)
  const previousReceiptPath = previous?.receiptPath
  const previousReceipt = previousReceiptPath && existsSync(previousReceiptPath) ? readJson(previousReceiptPath) : undefined
  let reusable = (previous?.status === 'passed' || previous?.status === 'reused') && previous.fingerprint === fingerprint &&
    previous.expiresAt !== undefined && Date.parse(previous.expiresAt) > Date.now() &&
    previous.logPath !== undefined && existsSync(previous.logPath) && previous.logHash === digest(readFileSync(previous.logPath)) &&
    JSON.stringify(previous.requiredPathHashes ?? {}) === JSON.stringify(currentPathHashes) &&
    requiredPaths.every(path => Object.hasOwn(currentPathHashes, path)) &&
    previousReceipt?.stage_id === stageId &&
    JSON.stringify(previousReceipt?.command) === JSON.stringify(command) &&
    JSON.stringify(previousReceipt?.candidate) === JSON.stringify(candidateInfo) &&
    previousReceipt?.result === 'pass' && previousReceipt.receipt_id === previous.receiptId &&
    previousReceipt.fingerprint === fingerprint && Date.parse(previousReceipt.expires_at) > Date.now() &&
    JSON.stringify(previousReceipt.tool_versions) === JSON.stringify(toolVersions()) &&
    JSON.stringify(previousReceipt.governance_input_hashes) === JSON.stringify(governanceInputHashes()) &&
    Array.isArray(previousReceipt.evidence_ids) && previousReceipt.evidence_ids.length > 0
  if (reusable && validateEvidence) reusable = validateEvidence(previousReceipt)
  if (reusable) {
    const reusedAt = now()
    const reuseReceiptId = `reuse-${stageId}-${Date.now()}`
    const reuseReceipt = {
      reuse_receipt_id: reuseReceiptId,
      unit_id: candidateInfo.head,
      stage_id: stageId,
      fingerprint,
      original_receipt: { receipt_id: previous.receiptId, path: previousReceiptPath, evidence_ids: previousReceipt.evidence_ids },
      reused_gate: stageId,
      recheck_commands: ['recompute stage fingerprint', 'verify log and required artifact hashes'],
      reused_at: reusedAt,
      expires_at: previous.expiresAt,
      reason: 'exact candidate, command, runtime, log and required artifact inputs are unchanged',
      remaining_gates: remainingStages,
    }
    state.reuseReceipts.push(reuseReceipt)
    state.stages[stageId] = { ...previous, status: 'reused', reuseReceiptId, reusedAt, reuseReceipt }
    saveStageState(statePath, state)
    return { output: readFileSync(previous.logPath, 'utf8'), fingerprint, reused: true, receiptId: previous.receiptId,
      receiptPath: previousReceiptPath, sourceEvidenceIds: previousReceipt.evidence_ids,
      evidenceRecords: previousReceipt.evidence_ids.map(evidenceId => readJson(evidencePath(evidenceId))),
      expiresAt: previous.expiresAt }
  }

  if (previous?.status === 'passed' || previous?.status === 'reused') {
    const invalidatedAt = now()
    state.invalidationHistory ??= []
    state.invalidationHistory.push({
      stage_id: stageId,
      previous_fingerprint: previous.fingerprint,
      invalidated_at: invalidatedAt,
      reason: previous.fingerprint !== fingerprint ? 'fingerprint_changed' : 'receipt_or_required_input_invalid',
    })
    state.stages[stageId] = { ...previous, status: 'invalidated', invalidatedAt,
      invalidationReason: previous.fingerprint !== fingerprint ? 'fingerprint_changed' : 'receipt_or_required_input_invalid' }
    saveStageState(statePath, state)
  }
  state.stages[stageId] = { stageId, status: 'running', fingerprint, command, startedAt: now(), logPath }
  saveStageState(statePath, state)
  try {
    const output = run(command[0], command.slice(1), logPath, root, env)
    const receiptId = `stage-${stageId}-${Date.now()}`
    const receiptPath = join(receiptRoot, `${receiptId}.json`)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    writeJson(receiptPath, { receipt_id: receiptId, stage_id: stageId, result: 'pass', fingerprint,
      candidate: candidateInfo, command, log_path: logPath, log_hash: digest(readFileSync(logPath)),
      required_path_hashes: pathHashes(requiredPaths), tool_versions: toolVersions(),
      governance_input_hashes: governanceInputHashes(), evidence_ids: [], created_at: now(), expires_at: expiresAt })
    const evidenceRecords = stageEvidence ? stageEvidence({ output, receiptId, receiptPath, expiresAt }) : []
    for (const record of evidenceRecords) writeJson(evidencePath(record.evidence_id), record)
    const sourceEvidenceIds = evidenceRecords.map(record => record.evidence_id)
    if (sourceEvidenceIds.length > 0) bindStageEvidence({ stageId, receiptPath }, sourceEvidenceIds)
    state.stages[stageId] = { ...state.stages[stageId], status: 'passed', receiptId, completedAt: now(),
      expiresAt, receiptPath, logHash: digest(readFileSync(logPath)), requiredPathHashes: pathHashes(requiredPaths),
      evidenceIds: sourceEvidenceIds }
    saveStageState(statePath, state)
    return { output, fingerprint, reused: false, receiptId, receiptPath, sourceEvidenceIds, evidenceRecords, expiresAt }
  } catch (error) {
    state.stages[stageId] = { ...state.stages[stageId], status: 'blocked', error: String(error), failedAt: now() }
    saveStageState(statePath, state)
    throw error
  }
}

function git(args) {
  // The candidate fingerprint diffs the whole base...head range as binary. A
  // governance promotion can push that past the 1 MiB spawnSync default, which
  // surfaces as status null plus ENOBUFS and would otherwise be misreported as a
  // diff-shaped failure. Give git room and report a real overflow as itself.
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

function assertExistingValidationReusable(validationPath, candidateInfo, stageState, expectedFingerprints) {
  const existing = readJson(validationPath)
  if (existing.candidate_commit !== candidateInfo.head || existing.candidate_tree_hash !== candidateInfo.tree) {
    throw new Error('existing pre-review validation belongs to another candidate')
  }
  installedLifecycleReceipt({
    receiptPath: u1InstalledReceiptPath(candidateInfo.head),
    expectedPackContentSha256: candidatePackReceipt().contentSha256,
    expectedCandidateIdentity: currentCandidateIdentity(root),
  })
  const artifactPath = join(root, 'generated', 'modules', moduleId, 'module.compiled.json')
  const artifact = existsSync(artifactPath) ? readJson(artifactPath) : undefined
  const currentEvidenceIds = [
    ...(existing.whitebox_evidence_ids ?? []),
    ...(existing.blackbox_evidence_ids ?? []),
    existing.deployment?.install_receipt_id,
    existing.deployment?.restart_receipt_id,
  ].filter(Boolean)
  const stageEvidenceIds = Object.values(existing.stage_execution ?? {})
    .flatMap(execution => [...(execution.evidence_ids ?? []), ...(execution.source_evidence_ids ?? [])])
  const evidenceIds = [...new Set([...currentEvidenceIds, ...stageEvidenceIds])]
  if (existing.result !== 'pass' || !artifact || artifact.artifact_hash !== existing.artifact_hash ||
      !existing.stage_execution || evidenceIds.length === 0) {
    throw new Error('existing pre-review validation is stale or incomplete; stage evidence must be invalidated and rerun')
  }
  const evidenceRoot = join(root, '.appsdk', 'records', 'evidence', moduleId)
  for (const evidenceId of evidenceIds) {
    const evidencePath = join(evidenceRoot, `${evidenceId}.json`)
    if (!existsSync(evidencePath)) throw new Error(`existing evidence ${evidenceId} is missing; stage evidence must be invalidated and rerun`)
    const evidence = readJson(evidencePath)
    if (evidence.result !== 'pass' || evidence.source_commit !== candidateInfo.head ||
        evidence.scope?.module_id !== moduleId || evidence.scope_hash !== candidateInfo.scopeHash ||
        evidence.artifact_hash !== existing.artifact_hash || evidence.producer?.adapter !== adapter ||
        Date.parse(evidence.expires_at) <= Date.now()) {
      throw new Error(`existing evidence ${evidenceId} is stale; stage evidence must be invalidated and rerun`)
    }
  }
  for (const stageId of ['pnpm-verify', 'pnpm-smoke-installed']) {
    const stage = stageState.stages[stageId]
    if (!stage?.receiptPath || !existsSync(stage.receiptPath)) throw new Error(`existing stage receipt ${stageId} is missing; stage evidence must be invalidated and rerun`)
    const receipt = readJson(stage.receiptPath)
    const expectedCommand = stageId === 'pnpm-verify' ? ['pnpm', 'verify'] : ['pnpm', 'smoke:installed']
    if (receipt.stage_id !== stageId || JSON.stringify(receipt.command) !== JSON.stringify(expectedCommand) ||
        JSON.stringify(receipt.candidate) !== JSON.stringify(candidateInfo) ||
        receipt.result !== 'pass' || Date.parse(receipt.expires_at) <= Date.now() ||
        receipt.fingerprint !== expectedFingerprints[stageId] ||
        JSON.stringify(receipt.tool_versions) !== JSON.stringify(toolVersions()) ||
        JSON.stringify(receipt.governance_input_hashes) !== JSON.stringify(governanceInputHashes()) ||
        !Array.isArray(receipt.evidence_ids) || receipt.evidence_ids.length === 0 ||
        !receipt.evidence_ids.every(evidenceId => evidenceIds.includes(evidenceId)) ||
        !existsSync(receipt.log_path) || fileHash(receipt.log_path) !== receipt.log_hash ||
        Object.entries(receipt.required_path_hashes ?? {}).some(([path, hash]) => fileHash(path) !== hash)) {
      throw new Error(`existing stage receipt ${stageId} is stale; stage evidence must be invalidated and rerun`)
    }
  }
  return existing
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
  const currentArtifact = existsSync(currentArtifactPath) ? readJson(currentArtifactPath) : undefined
  const u1ReceiptPath = u1InstalledReceiptPath(candidateInfo.head)
  const currentInputs = stageInputs(candidateInfo, currentArtifact?.artifact_hash, u1ReceiptPath)
  const expectedFingerprints = {
    'pnpm-verify': stageFingerprint(candidateInfo, 'pnpm-verify', ['pnpm', 'verify'], currentInputs.verify),
    'pnpm-smoke-installed': stageFingerprint(candidateInfo, 'pnpm-smoke-installed', ['pnpm', 'smoke:installed'], currentInputs.smoke),
  }
  const attempt = `attempt-${Date.now()}-${randomUUID()}`
  const recordsRoot = join(root, '.appsdk', 'records')
  const canonicalValidationPath = join(recordsRoot, `pre-review-validation-record-${moduleId}.json`)
  const candidateValidationPrefix = `pre-review-validation-record-${moduleId}-${candidateInfo.head}-`
  const existingValidationPaths = [canonicalValidationPath]
  if (existsSync(recordsRoot)) {
    for (const name of readdirSync(recordsRoot)) {
      if (name.startsWith(candidateValidationPrefix)) existingValidationPaths.push(join(recordsRoot, name))
    }
  }
  let validationPath = Object.keys(stageState.stages).length > 0
    ? join(recordsRoot, `${candidateValidationPrefix}${attempt}.json`)
    : canonicalValidationPath
  for (const existingValidationPath of [...new Set(existingValidationPaths)]) {
    if (!existsSync(existingValidationPath)) continue
    try {
      const existing = assertExistingValidationReusable(existingValidationPath, candidateInfo, stageState, expectedFingerprints)
      process.stdout.write(`${JSON.stringify({ ok: true, idempotent: true, validation_id: existing.validation_id })}\n`)
      return
    } catch (error) {
      stageState.invalidationHistory.push({ stage_id: 'pre-review-validation', validation_path: existingValidationPath,
        invalidated_at: now(), reason: String(error) })
      saveStageState(stageStatePath, stageState)
      validationPath = join(recordsRoot, `${candidateValidationPrefix}${attempt}.json`)
    }
  }
  const controlRoot = join(root, '.appsdk-control', 'lifecycle-adapter', attempt)
  const commandRoot = join(controlRoot, 'commands')
  const receiptRoot = join(stageRoot, 'receipts')
  const recordSuffix = validationPath === canonicalValidationPath ? '' : `-${candidateInfo.head}-${attempt}`
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
      extra: currentInputs.verify,
      remainingStages: ['pnpm-smoke-installed'],
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
        if (stageArtifact.source_commit && stageArtifact.source_commit !== candidateInfo.head) return false
        return validateStageEvidence(receipt, verifyEvidenceSpec, candidateInfo, stageArtifact.artifact_hash)
      } })
    const artifact = readJson(currentArtifactPath)
    if (artifact.source_commit && artifact.source_commit !== candidateInfo.head) {
      throw new Error(`compiled artifact source commit ${artifact.source_commit} does not match ${candidateInfo.head}`)
    }
    const artifactHash = artifact.artifact_hash
    const smokeInputs = stageInputs(candidateInfo, artifactHash, u1ReceiptPath)
    const environmentId = smokeInputs.environmentId
    const deployedEntrypoint = smokeInputs.deployedEntrypoint
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
      requiredPaths: [join(root, 'generated', 'modules', moduleId, 'module.compiled.json'),
        join(root, 'generated', 'modules', moduleId, 'package-receipt.json'), u1ReceiptPath,
        join(root, 'scripts', 'package-user-smoke.mjs'), join(root, 'scripts', 'installed-runtime-smoke.mjs'),
        join(root, 'scripts', 'runtime-smoke.mjs'), join(root, 'package.json'), join(root, 'pnpm-workspace.yaml')],
      extra: smokeInputs.smoke,
      env: { AGENTTEAMS_U1_INSTALLED_RECEIPT_PATH: u1ReceiptPath },
      remainingStages: [],
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
          const receiptReference = parseInstalledReceiptReference(readFileSync(receipt.log_path, 'utf8'))
          if (receiptReference.path !== u1ReceiptPath) return false
          installedLifecycleReceipt({
            receiptPath: receiptReference.path,
            expectedReceiptSha256: receiptReference.sha256,
            expectedPackContentSha256: candidatePackReceipt().contentSha256,
            expectedCandidateIdentity: currentCandidateIdentity(root),
          })
        } catch {
          return false
        }
        return validateStageEvidence(receipt, smokeEvidenceSpec, candidateInfo, artifactHash)
      } })
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
