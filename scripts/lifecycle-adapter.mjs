import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

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

function run(program, args, logPath, cwd = root) {
  const result = spawnSync(program, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
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

function stageInputs(candidateInfo, artifactHash) {
  const environmentId = artifactHash ? digest(JSON.stringify({
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    artifactHash,
  })) : undefined
  const deployedEntrypoint = 'pnpm smoke:installed -> installed runtime/server/relay-process.js + runtime/runtime/agent-process.js'
  return {
    verify: { inputCandidate: candidateInfo, ...moduleScope(), changedPaths: candidateInfo.changedPaths },
    smoke: { inputCandidate: candidateInfo, artifactHash, environmentId, entrypoint: deployedEntrypoint,
      runtimeInputs: pathHashes([
        join(root, 'scripts', 'installed-runtime-smoke.mjs'),
        join(root, 'package.json'),
        join(root, 'pnpm-workspace.yaml'),
      ]),
      credentialRefs: { TEAMS_RELAY_AGENT: process.env.TEAMS_RELAY_AGENT ? digest(process.env.TEAMS_RELAY_AGENT) : 'missing' } },
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

function runStage({ state, statePath, receiptRoot, stageId, command, logPath, candidateInfo, requiredPaths = [], extra = {}, remainingStages = [] }) {
  const fingerprint = stageFingerprint(candidateInfo, stageId, command, extra)
  const previous = state.stages[stageId]
  const currentPathHashes = pathHashes(requiredPaths)
  const previousReceiptPath = previous?.receiptPath
  const previousReceipt = previousReceiptPath && existsSync(previousReceiptPath) ? readJson(previousReceiptPath) : undefined
  const reusable = (previous?.status === 'passed' || previous?.status === 'reused') && previous.fingerprint === fingerprint &&
    previous.expiresAt !== undefined && Date.parse(previous.expiresAt) > Date.now() &&
    previous.logPath !== undefined && existsSync(previous.logPath) && previous.logHash === digest(readFileSync(previous.logPath)) &&
    JSON.stringify(previous.requiredPathHashes ?? {}) === JSON.stringify(currentPathHashes) &&
    requiredPaths.every(path => Object.hasOwn(currentPathHashes, path)) &&
    previousReceipt?.result === 'pass' && previousReceipt.receipt_id === previous.receiptId &&
    previousReceipt.fingerprint === fingerprint && Date.parse(previousReceipt.expires_at) > Date.now() &&
    Array.isArray(previousReceipt.evidence_ids) && previousReceipt.evidence_ids.length > 0
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
      receiptPath: previousReceiptPath, sourceEvidenceIds: previousReceipt.evidence_ids, expiresAt: previous.expiresAt }
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
    const output = run(command[0], command.slice(1), logPath)
    const receiptId = `stage-${stageId}-${Date.now()}`
    const receiptPath = join(receiptRoot, `${receiptId}.json`)
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
    writeJson(receiptPath, { receipt_id: receiptId, stage_id: stageId, result: 'pass', fingerprint,
      candidate: candidateInfo, command, log_path: logPath, log_hash: digest(readFileSync(logPath)),
      required_path_hashes: pathHashes(requiredPaths), tool_versions: toolVersions(),
      governance_input_hashes: governanceInputHashes(), evidence_ids: [], created_at: now(), expires_at: expiresAt })
    state.stages[stageId] = { ...state.stages[stageId], status: 'passed', receiptId, completedAt: now(),
      expiresAt, receiptPath, logHash: digest(readFileSync(logPath)), requiredPathHashes: pathHashes(requiredPaths) }
    saveStageState(statePath, state)
    return { output, fingerprint, reused: false, receiptId, receiptPath, sourceEvidenceIds: [], expiresAt }
  } catch (error) {
    state.stages[stageId] = { ...state.stages[stageId], status: 'blocked', error: String(error), failedAt: now() }
    saveStageState(statePath, state)
    throw error
  }
}

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
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
  const artifactPath = join(root, 'generated', 'modules', moduleId, 'module.compiled.json')
  const artifact = existsSync(artifactPath) ? readJson(artifactPath) : undefined
  const currentEvidenceIds = [
    ...(existing.whitebox_evidence_ids ?? []),
    ...(existing.blackbox_evidence_ids ?? []),
    existing.deployment?.install_receipt_id,
    existing.deployment?.restart_receipt_id,
  ].filter(Boolean)
  const sourceEvidenceIds = Object.values(existing.stage_execution ?? {})
    .flatMap(execution => execution.source_evidence_ids ?? [])
  const evidenceIds = [...new Set([...currentEvidenceIds, ...sourceEvidenceIds])]
  if (existing.result !== 'pass' || !artifact || artifact.artifact_hash !== existing.artifact_hash ||
      !existing.stage_execution || evidenceIds.length === 0) {
    throw new Error('existing pre-review validation is stale or incomplete; stage evidence must be invalidated and rerun')
  }
  const evidenceRoot = join(root, '.appsdk', 'records', 'evidence', moduleId)
  for (const evidenceId of evidenceIds) {
    const evidencePath = join(evidenceRoot, `${evidenceId}.json`)
    if (!existsSync(evidencePath)) throw new Error(`existing evidence ${evidenceId} is missing; stage evidence must be invalidated and rerun`)
    const evidence = readJson(evidencePath)
    if (evidence.result !== 'pass' || (currentEvidenceIds.includes(evidenceId) && evidence.source_commit !== candidateInfo.head) ||
        Date.parse(evidence.expires_at) <= Date.now()) {
      throw new Error(`existing evidence ${evidenceId} is stale; stage evidence must be invalidated and rerun`)
    }
  }
  for (const stageId of ['pnpm-verify', 'pnpm-smoke-installed']) {
    const stage = stageState.stages[stageId]
    if (!stage?.receiptPath || !existsSync(stage.receiptPath)) throw new Error(`existing stage receipt ${stageId} is missing; stage evidence must be invalidated and rerun`)
    const receipt = readJson(stage.receiptPath)
    if (receipt.result !== 'pass' || Date.parse(receipt.expires_at) <= Date.now() ||
        receipt.fingerprint !== expectedFingerprints[stageId] ||
        !receipt.evidence_ids.every(evidenceId => evidenceIds.includes(evidenceId)) ||
        !existsSync(receipt.log_path) || fileHash(receipt.log_path) !== receipt.log_hash ||
        Object.entries(receipt.required_path_hashes ?? {}).some(([path, hash]) => fileHash(path) !== hash)) {
      throw new Error(`existing stage receipt ${stageId} is stale; stage evidence must be invalidated and rerun`)
    }
  }
  return existing
}

function main() {
  assertCleanSource()
  const candidateInfo = candidate()
  const stageRoot = join(root, '.appsdk-control', 'lifecycle-adapter', 'stages')
  const stageStatePath = join(stageRoot, `${issueId}.json`)
  const stageState = loadStageState(stageStatePath, candidateInfo)
  const currentArtifactPath = join(root, 'generated', 'modules', moduleId, 'module.compiled.json')
  const currentArtifact = existsSync(currentArtifactPath) ? readJson(currentArtifactPath) : undefined
  const currentInputs = stageInputs(candidateInfo, currentArtifact?.artifact_hash)
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
  let validationPath = canonicalValidationPath
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
    const verifyStage = runStage({ state: stageState, statePath: stageStatePath, receiptRoot, stageId: 'pnpm-verify',
      command: ['pnpm', 'verify'], logPath: join(commandRoot, 'pnpm-verify.log'), candidateInfo,
      requiredPaths: [join(root, 'generated', 'modules', moduleId, 'module.compiled.json')],
      extra: currentInputs.verify,
      remainingStages: ['pnpm-smoke-installed'] })
    const verifyOutput = verifyStage.output
    const artifact = readJson(join(root, 'generated', 'modules', moduleId, 'module.compiled.json'))
    if (artifact.source_commit && artifact.source_commit !== candidateInfo.head) {
      throw new Error(`compiled artifact source commit ${artifact.source_commit} does not match ${candidateInfo.head}`)
    }
    const artifactHash = artifact.artifact_hash
    const smokeInputs = stageInputs(candidateInfo, artifactHash)
    const environmentId = smokeInputs.environmentId
    const deployedEntrypoint = smokeInputs.deployedEntrypoint

    const whiteboxCreatedAt = now()
    const smokeStage = runStage({ state: stageState, statePath: stageStatePath, receiptRoot, stageId: 'pnpm-smoke-installed',
      command: ['pnpm', 'smoke:installed'], logPath: join(commandRoot, 'pnpm-smoke-installed.log'), candidateInfo,
      requiredPaths: [join(root, 'generated', 'modules', moduleId, 'module.compiled.json'),
        join(root, 'scripts', 'installed-runtime-smoke.mjs'), join(root, 'package.json'), join(root, 'pnpm-workspace.yaml')],
      extra: smokeInputs.smoke,
      remainingStages: [] })
    const installedOutput = smokeStage.output
    const verifyExecution = verifyStage.reused ? { mode: 'reused', source_receipt_id: verifyStage.receiptId,
      source_receipt_path: verifyStage.receiptPath, source_evidence_ids: verifyStage.sourceEvidenceIds } :
      { mode: 'executed', receipt_id: verifyStage.receiptId, receipt_path: verifyStage.receiptPath }
    const smokeExecution = smokeStage.reused ? { mode: 'reused', source_receipt_id: smokeStage.receiptId,
      source_receipt_path: smokeStage.receiptPath, source_evidence_ids: smokeStage.sourceEvidenceIds } :
      { mode: 'executed', receipt_id: smokeStage.receiptId, receipt_path: smokeStage.receiptPath }
    assertCleanSource()
    if (git(['rev-parse', 'HEAD']) !== candidateInfo.head || git(['rev-parse', 'HEAD^{tree}']) !== candidateInfo.tree) {
      throw new Error('candidate source changed during lifecycle execution')
    }

    const worktreeId = `worktree-${candidateInfo.head.slice(0, 12)}`
    const fixCandidateId = `fix-${candidateInfo.head.slice(0, 12)}-${attempt}`
    const whitebox = evidence({
      id: `${attempt}-whitebox`,
      phase: 'development_whitebox',
      kind: 'gate',
      candidateInfo,
      createdAt: whiteboxCreatedAt,
      command: 'pnpm verify',
      commandOutput: verifyOutput,
      artifactHash,
      entrypoint: 'pnpm verify',
      executionSurface: 'development_whitebox',
      identity: `${adapter}/whitebox`,
      execution: verifyExecution,
      expiresAt: verifyStage.expiresAt,
    })
    const build = evidence({
      id: `${attempt}-artifact`,
      phase: 'artifact',
      kind: 'build',
      candidateInfo,
      createdAt: whiteboxCreatedAt,
      command: 'appsdk compile (inside pnpm verify)',
      commandOutput: verifyOutput,
      artifactHash,
      entrypoint: 'generated/modules/teams-source/module.compiled.json',
      executionSurface: 'development_whitebox',
      identity: `${adapter}/build`,
      execution: verifyExecution,
      expiresAt: verifyStage.expiresAt,
    })
    const installCreatedAt = now()
    const install = evidence({
      id: `${attempt}-install`,
      phase: 'deployment_install',
      kind: 'install',
      candidateInfo,
      createdAt: installCreatedAt,
      command: 'pnpm smoke:installed',
      commandOutput: installedOutput,
      artifactHash,
      environmentId,
      entrypoint: deployedEntrypoint,
      executionSurface: 'deployed_blackbox',
      identity: `${adapter}/deployment`,
      execution: smokeExecution,
      expiresAt: smokeStage.expiresAt,
    })
    const restartCreatedAt = now()
    const restart = evidence({
      id: `${attempt}-restart`,
      phase: 'deployment_restart',
      kind: 'restart',
      candidateInfo,
      createdAt: restartCreatedAt,
      command: 'pnpm smoke:installed',
      commandOutput: installedOutput,
      artifactHash,
      environmentId,
      entrypoint: deployedEntrypoint,
      executionSurface: 'deployed_blackbox',
      identity: `${adapter}/deployment`,
      execution: smokeExecution,
      expiresAt: smokeStage.expiresAt,
    })
    const blackboxCreatedAt = now()
    const blackbox = evidence({
      id: `${attempt}-blackbox`,
      phase: 'deployed_blackbox',
      kind: 'runtime',
      candidateInfo,
      createdAt: blackboxCreatedAt,
      command: 'pnpm smoke:installed',
      commandOutput: installedOutput,
      artifactHash,
      environmentId,
      entrypoint: deployedEntrypoint,
      executionSurface: 'deployed_blackbox',
      identity: `${adapter}/deployment`,
      execution: smokeExecution,
      expiresAt: smokeStage.expiresAt,
    })

    const evidenceRoot = join(recordsRoot, 'evidence', moduleId)
    const evidenceSet = [whitebox, build, install, restart, blackbox]
    if (!verifyStage.reused) bindStageEvidence(verifyStage, [whitebox.evidence_id, build.evidence_id])
    if (!smokeStage.reused) bindStageEvidence(smokeStage, [install.evidence_id, restart.evidence_id, blackbox.evidence_id])
    for (const item of evidenceSet) writeJson(join(evidenceRoot, `${item.evidence_id}.json`), item)
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
        observed_at: blackboxCreatedAt,
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
        ...evidenceSet.map(item => join(evidenceRoot, `${item.evidence_id}.json`)),
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

main()
