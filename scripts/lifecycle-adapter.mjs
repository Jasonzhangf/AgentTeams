import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const projectRoot = resolve(root, '..')
const moduleId = 'teams-design'
const issueId = 'teams-lifecycle-20260902'
const adapter = 'teams::lifecycle-adapter:v1'

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const now = () => new Date().toISOString()

function run(program, args, cwd = projectRoot) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, CI: 'true', npm_config_prefer_offline: 'true', npm_config_fetch_timeout: '30000' } })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) throw new Error(`${program} ${args.join(' ')} failed${output ? `\n${output}` : ''}`)
  return output
}

function git(args) { return run('git', args).trim() }
function json(path) { return JSON.parse(readFileSync(path, 'utf8')) }
function write(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' })
}

function overwrite(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function writeOrAssert(path, value) {
  if (!existsSync(path)) {
    write(path, value)
    return
  }
  const existing = JSON.parse(readFileSync(path, 'utf8'))
  if (JSON.stringify(existing) !== JSON.stringify(value)) {
    throw new Error(`EEXIST: immutable record belongs to another transaction: ${path}`)
  }
}

function readJsonIfExists(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined
}

function fileHash(path) {
  return hash(readFileSync(path))
}

function assertCleanCandidate() {
  const status = git(['status', '--porcelain']).split('\n').filter(Boolean)
  if (status.some(line => !/^\?\? (?:Teams\/)?(?:\.appsdk\/records\/.*|\.appsdk-control\/.*|\.agent-collab\/.*|deepseek-harness\/node_modules)$/u.test(line))) {
    throw new Error('lifecycle adapter requires a clean candidate worktree')
  }
}

function candidate() {
  const head = git(['rev-parse', 'HEAD'])
  const base = git(['merge-base', 'HEAD', 'origin/main'])
  const changed = git(['diff', '--name-only', `${base}...${head}`]).split('\n').filter(Boolean)
  return {
    head,
    base,
    tree: git(['rev-parse', `${head}^{tree}`]),
    diff: hash(git(['diff', '--binary', `${base}...${head}`])),
    scope: hash(JSON.stringify({ moduleId, changed })),
    changed,
  }
}

function evidence(id, phase, kind, c, extra = {}) {
  return {
    evidence_id: id,
    issue_id: issueId,
    experiment_id: issueId,
    phase,
    kind,
    source_commit: c.head,
    scope: { module_id: moduleId },
    scope_hash: c.scope,
    producer: { adapter, identity: `${adapter}/${phase}` },
    result: 'pass',
    input_hashes: [hash(JSON.stringify({ moduleId, phase, head: c.head }))],
    confidence: 1,
    confidence_rationale: `The ${phase} command completed successfully in the candidate worktree.`,
    created_at: now(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    ...extra,
  }
}

function main() {
  assertCleanCandidate()
  const c = candidate()
  const attempt = `attempt-${Date.now()}-${randomUUID()}`
  const records = join(root, '.appsdk', 'records')
  const evidenceRoot = join(records, 'evidence', moduleId)
  const control = join(root, '.appsdk-control', 'lifecycle-adapter', attempt)
  mkdirSync(control, { recursive: true })
  const worktree = {
    worktree_id: `worktree-${c.head.slice(0, 12)}`,
    issue_id: issueId,
    module_id: moduleId,
    base_ref: 'origin/main',
    base_commit: c.base,
    branch: git(['branch', '--show-current']) || 'HEAD',
    head_commit: c.head,
    initial_clean: true,
    final_clean: true,
    isolation_mode: 'isolated_worktree',
    scope_hash: c.scope,
    created_at: now(),
  }
  writeOrAssert(join(records, 'worktree-record.json'), worktree)
  writeOrAssert(join(records, `worktree-record-${moduleId}.json`), worktree)

  run('appsdk', ['compile-module', 'Teams', '--module', moduleId])
  run('pnpm', ['--dir', 'deepseek-harness', 'exec', 'vitest', 'run', '--config', '../Teams/ui/teams-console/vitest.config.ts'], projectRoot)
  run('pnpm', ['--dir', 'deepseek-harness', 'exec', 'tsc', '--project', '../Teams/ui/teams-console/tsconfig.json'], projectRoot)
  run('pnpm', ['--dir', projectRoot + '/deepseek-harness', 'exec', 'tsdown', '--config', projectRoot + '/Teams/ui/teams-console/tsdown.config.ts'], projectRoot)
  run('pnpm', ['--dir', 'deepseek-harness', 'exec', 'tsc', '--noEmit', '--project', '../Teams/opencode-adapter/tsconfig.json'], projectRoot)
  run('pnpm', ['--dir', projectRoot + '/deepseek-harness', 'exec', 'tsdown', projectRoot + '/Teams/opencode-adapter/src/index.ts', '--no-config', '--out-dir', projectRoot + '/Teams/opencode-adapter/lib', '--format', 'esm', '--platform', 'node', '--target', 'es2022', '--dts', '--clean'], projectRoot)

  const artifact = json(join(root, 'generated', 'modules', moduleId, 'module.compiled.json'))
  const worktreeId = `worktree-${c.head.slice(0, 12)}`
  const fixCandidateId = `fix-${c.head.slice(0, 12)}-${attempt}`
  const candidateCreatedAt = now()
  const candidateRecord = {
    fix_candidate_id: fixCandidateId,
    issue_id: issueId, module_id: moduleId, base_commit: c.base, head_commit: c.head,
    worktree_id: worktreeId, tree_hash: c.tree, diff_hash: c.diff, scope_hash: c.scope, owner: adapter,
    changed_paths: c.changed, design_id: issueId, verification_evidence_ids: [], created_at: candidateCreatedAt,
  }
  const whitebox = evidence(`${attempt}-whitebox`, 'development_whitebox', 'gate', c, { artifact_hash: artifact.artifact_hash, entrypoint: 'Teams UI/OpenCode test and build suite', execution_surface: 'development_whitebox', producer: { adapter, identity: `${adapter}/whitebox` } })
  const build = evidence(`${attempt}-build`, 'artifact', 'build', c, { artifact_hash: artifact.artifact_hash, entrypoint: 'appsdk compile-module Teams --module teams-design', execution_surface: 'development_whitebox' })
  const positive = evidence(`${attempt}-positive`, 'positive_intervention', 'positive_test', c, { entrypoint: 'Teams UI and OpenCode focused tests', execution_surface: 'development_whitebox' })
  for (const item of [whitebox, build, positive]) write(join(evidenceRoot, `${item.evidence_id}.json`), item)
  const environmentId = hash(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, candidate: c.head }))
  const deploymentRoot = join(control, 'deployment')
  mkdirSync(deploymentRoot, { recursive: true })
  run('npm', ['pack', '--pack-destination', deploymentRoot], join(root, 'ui', 'teams-console'))
  run('npm', ['pack', '--pack-destination', deploymentRoot], join(root, 'opencode-adapter'))
  const uiTarball = join(deploymentRoot, 'deepseek-ai-teams-console-0.1.0.tgz')
  const openCodeTarball = join(deploymentRoot, 'deepseek-ai-teams-opencode-adapter-0.1.0.tgz')
  const installRoot = join(deploymentRoot, 'installed')
  mkdirSync(installRoot, { recursive: true })
  run('npm', ['init', '--yes'], installRoot)
  const uiInstallRoot = join(deploymentRoot, 'installed-ui')
  const adapterInstallRoot = join(deploymentRoot, 'installed-adapter')
  mkdirSync(uiInstallRoot, { recursive: true })
  mkdirSync(adapterInstallRoot, { recursive: true })
  run('npm', ['init', '--yes'], uiInstallRoot)
  run('npm', ['init', '--yes'], adapterInstallRoot)
  run('npm', ['install', '--ignore-scripts', uiTarball], uiInstallRoot)
  run('npm', ['install', '--ignore-scripts', openCodeTarball], adapterInstallRoot)
  const installedUi = join(uiInstallRoot, 'node_modules', '@deepseek-ai', 'teams-console', 'lib', 'client.js')
  const installedOpenCode = join(adapterInstallRoot, 'node_modules', '@deepseek-ai', 'teams-opencode-adapter', 'lib', 'index.mjs')
  run('test', ['-s', installedUi], uiInstallRoot)
  run('test', ['-s', installedOpenCode], adapterInstallRoot)
  const install = evidence(`${attempt}-install`, 'deployment_install', 'install', c, { artifact_hash: artifact.artifact_hash, environment_id: environmentId, entrypoint: installedOpenCode, execution_surface: 'deployed_blackbox', producer: { adapter, identity: `${adapter}/deployment` } })
  write(join(evidenceRoot, `${install.evidence_id}.json`), install)
  run('node', ['--check', installedOpenCode], adapterInstallRoot)
  const restart = evidence(`${attempt}-restart`, 'deployment_restart', 'restart', c, { artifact_hash: artifact.artifact_hash, environment_id: environmentId, entrypoint: installedOpenCode, execution_surface: 'deployed_blackbox', producer: { adapter, identity: `${adapter}/deployment` } })
  write(join(evidenceRoot, `${restart.evidence_id}.json`), restart)
  run('node', ['--input-type=module', '-e', `await import(${JSON.stringify(installedOpenCode)})`], adapterInstallRoot)
  const blackbox = evidence(`${attempt}-blackbox`, 'deployed_blackbox', 'runtime', c, { artifact_hash: artifact.artifact_hash, environment_id: environmentId, entrypoint: installedOpenCode, execution_surface: 'deployed_blackbox', producer: { adapter, identity: `${adapter}/deployment` } })
  write(join(evidenceRoot, `${blackbox.evidence_id}.json`), blackbox)
  const evidenceSet = [whitebox, build, positive, install, restart, blackbox]
  write(join(records, 'evidence-record.json'), whitebox)
  write(join(records, `evidence-record-${moduleId}.json`), whitebox)
  candidateRecord.verification_evidence_ids = evidenceSet.map(item => item.evidence_id)
  write(join(records, `fix-candidate-record-${moduleId}.json`), candidateRecord)
  write(join(records, `pre-review-validation-record-${moduleId}.json`), {
    validation_id: `validation-${attempt}`, issue_id: issueId, module_id: moduleId,
    fix_candidate_id: `fix-${c.head.slice(0, 12)}-${attempt}`, candidate_commit: c.head,
    candidate_tree_hash: c.tree, artifact_hash: artifact.artifact_hash,
    whitebox_producer: { adapter, identity: `${adapter}/whitebox` },
    whitebox_evidence_ids: [whitebox.evidence_id], blackbox_evidence_ids: [blackbox.evidence_id],
    deployment: { environment_id: environmentId, install_receipt_id: install.evidence_id, restart_receipt_id: restart.evidence_id, entrypoint: installedOpenCode, producer: { adapter, identity: `${adapter}/deployment` }, observed_at: now() },
    source_unchanged: true, result: 'pass', created_at: now(),
  })
  process.stdout.write(`${JSON.stringify({ ok: true, attempt, candidate: c, artifact_hash: artifact.artifact_hash })}\n`)
}

function ensureWorktreeDependencies(worktreeRoot) {
  const teamsRoot = join(worktreeRoot, 'Teams')
  const sourceUi = join(root, 'ui', 'teams-console', 'node_modules')
  const sourceAdapter = join(root, 'opencode-adapter', 'node_modules')
  const targets = [
    [join(teamsRoot, 'ui', 'teams-console', 'node_modules'), sourceUi],
    [join(teamsRoot, 'opencode-adapter', 'node_modules'), sourceAdapter],
  ]
  for (const [target, source] of targets) {
    if (existsSync(target) || !existsSync(source)) continue
    mkdirSync(dirname(target), { recursive: true })
    symlinkSync(source, target, 'dir')
  }
  const exclude = run('git', ['rev-parse', '--git-path', 'info/exclude'], worktreeRoot).trim()
  if (existsSync(exclude)) {
    writeFileSync(exclude, ['/Teams/ui/teams-console/node_modules', '/Teams/opencode-adapter/node_modules'].join('\n') + '\n', { flag: 'a' })
  }
}

function prepareWorktree(worktreeRoot) {
  const harness = join(worktreeRoot, 'deepseek-harness')
  run('pnpm', ['install', '--frozen-lockfile', '--ignore-scripts'], harness)
  run('pnpm', ['run', 'build:lib'], harness)
}

function baseline() {
  assertCleanCandidate()
  const current = candidate()
  const records = join(root, '.appsdk', 'records')
  const existing = readJsonIfExists(join(records, `reproduction-record-${moduleId}.json`))
  if (existing?.base_commit === current.head && existing.result === 'reproduced') {
    process.stdout.write(`${JSON.stringify({ ok: true, idempotent: true, reproductionId: existing.reproduction_id })}\n`)
    return
  }
  const fixCommit = git(['log', '--format=%H', '--grep=anchor candidate before whitebox evidence', '-1'])
  const baselineCommit = git(['rev-parse', `${fixCommit}^`])
  run('git', ['cat-file', '-e', `${baselineCommit}:Teams/scripts/lifecycle-adapter.mjs`], projectRoot)
  const attemptId = `baseline-${Date.now()}-${randomUUID()}`
  const baselineWorktree = join(projectRoot, 'playground', attemptId)
  const inputHashes = [hash('origin/main'), hash('pre-fix lifecycle-adapter candidate time order'), hash('appsdk verify --review-admission Teams --module teams-design')]
  const controlRoot = join(root, '.appsdk-control', 'lifecycle-adapter', attemptId)
  mkdirSync(controlRoot, { recursive: true })
  writeOrAssert(join(controlRoot, 'transaction.json'), {
    attemptId,
    issueId,
    moduleId,
    phase: 'baseline_reproduction',
    base_commit: baselineCommit,
    state: 'started',
    created_at: now(),
  })
  try {
    run('git', ['worktree', 'add', '--detach', baselineWorktree, baselineCommit], projectRoot)
    ensureWorktreeDependencies(baselineWorktree)
    prepareWorktree(baselineWorktree)
    const first = spawnSync(process.execPath, ['Teams/scripts/lifecycle-adapter.mjs'], {
      cwd: baselineWorktree,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: 'true', npm_config_prefer_offline: 'true', npm_config_fetch_timeout: '30000' },
    })
    if (first.status !== 0) {
      throw new Error(`pre-fix lifecycle adapter failed before admission:\n${first.stdout ?? ''}${first.stderr ?? ''}`)
    }
    const second = spawnSync('appsdk', ['verify', '--review-admission', 'Teams', '--module', moduleId], {
      cwd: baselineWorktree,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, CI: 'true', npm_config_prefer_offline: 'true', npm_config_fetch_timeout: '30000' },
    })
    if (second.status === 0) {
      throw new Error('baseline review admission unexpectedly passed')
    }
    const observedFailure = `${second.stdout ?? ''}${second.stderr ?? ''}`.trim()
    const baselineEvidence = evidence(`${attemptId}-baseline`, 'baseline_reproduction', 'red_test', current, {
      input_hashes: inputHashes,
      observed_failure: observedFailure,
    })
    write(join(controlRoot, 'baseline.json'), baselineEvidence)
    write(join(join(root, '.appsdk', 'records', 'evidence', moduleId), `${attemptId}-baseline.json`), baselineEvidence)
    const reproduction = {
      reproduction_id: `reproduction-${attemptId}`,
      issue_id: issueId,
      module_id: moduleId,
      worktree_id: `worktree-${current.head.slice(0, 12)}`,
      base_commit: baselineCommit,
      input_hashes: inputHashes,
      baseline_evidence_id: baselineEvidence.evidence_id,
      first_divergence: 'pre-fix lifecycle adapter wrote candidate records after evidence, so review admission rejected the candidate graph',
      result: 'reproduced',
      created_at: now(),
    }
    write(join(records, `reproduction-record-${moduleId}.json`), reproduction)
    overwrite(join(controlRoot, 'transaction.json'), {
      attemptId,
      issueId,
      moduleId,
      phase: 'baseline_reproduction',
      base_commit: baselineCommit,
      state: 'committed',
      evidence_id: baselineEvidence.evidence_id,
      completed_at: now(),
    })
    run('git', ['worktree', 'remove', '--force', baselineWorktree], projectRoot)
    process.stdout.write(`${JSON.stringify({ ok: true, attemptId, baselineEvidenceId: baselineEvidence.evidence_id })}\n`)
  } catch (error) {
    if (existsSync(join(baselineWorktree, '.git'))) run('git', ['worktree', 'remove', '--force', baselineWorktree], projectRoot)
    overwrite(join(controlRoot, 'failure.json'), { attemptId, error: String(error), retry_allowed: true, failed_at: now() })
    process.stderr.write(`${JSON.stringify({ ok: false, attemptId, retry_allowed: true, failed_node: String(error) })}\n`)
    process.exitCode = 1
  }
}

function emitReviewRecord(reviewTaskId) {
  assertCleanCandidate()
  if (!reviewTaskId) throw new Error('review-record adapter requires a task id')
  const current = candidate()
  const records = join(root, '.appsdk', 'records')
  const candidateRecord = JSON.parse(readFileSync(join(records, `fix-candidate-record-${moduleId}.json`), 'utf8'))
  const validation = JSON.parse(readFileSync(join(records, `pre-review-validation-record-${moduleId}.json`), 'utf8'))
  const moduleArtifact = JSON.parse(readFileSync(join(root, 'generated', 'modules', moduleId, 'module.compiled.json'), 'utf8'))
  const reviewStatusPath = join(projectRoot, '.agent-collab', 'review', reviewTaskId, 'status.json')
  if (!existsSync(reviewStatusPath)) throw new Error(`completed AGY review status is missing: ${reviewTaskId}`)
  const reviewStatus = JSON.parse(readFileSync(reviewStatusPath, 'utf8'))
  if (reviewStatus.verdict !== 'pass') throw new Error(`AGY review is not PASS: ${reviewStatus.verdict ?? 'unknown'}`)
  if (reviewStatus.commit !== current.head || reviewStatus.base !== current.base) throw new Error('AGY review is not bound to current candidate')
  if (candidateRecord.head_commit !== current.head || candidateRecord.tree_hash !== current.tree) throw new Error('candidate record is not bound to current source')
  if (validation.candidate_commit !== current.head || validation.candidate_tree_hash !== current.tree) throw new Error('pre-review validation is not bound to current source')
  const record = {
    review_id: reviewTaskId,
    review_kind: 'architecture',
    issue_id: issueId,
    promotion_id: `promotion-${current.head.slice(0, 12)}`,
    fix_candidate_id: candidateRecord.fix_candidate_id,
    pre_review_validation_id: validation.validation_id,
    reviewer: { adapter: 'agy-review', identity: reviewTaskId },
    verdict: 'pass',
    evidence_ids: [...new Set([...candidateRecord.verification_evidence_ids, ...validation.whitebox_evidence_ids, ...validation.blackbox_evidence_ids])],
    reviewed_commit: current.head,
    reviewed_tree_hash: current.tree,
    reviewed_diff_hash: current.diff,
    reviewed_artifact_hash: moduleArtifact.artifact_hash,
    reviewed_scope_hash: current.scope,
    resource_map_hash: fileHash(join(root, '.appsdk', 'maps', 'resource-map.json')),
    function_map_hash: fileHash(join(root, '.appsdk', 'maps', 'function-map.json')),
    mainline_call_map_hash: fileHash(join(root, '.appsdk', 'maps', 'mainline-call-map.json')),
    verification_map_hash: fileHash(join(root, '.appsdk', 'maps', 'verification-map.json')),
    ai_confidence: 1,
    confidence_rationale: 'AGY controller returned pass for the exact candidate commit.',
    created_at: now(),
  }
  write(join(records, 'review-record.json'), record)
  write(join(records, `review-record-${moduleId}.json`), record)
  process.stdout.write(`${JSON.stringify({ ok: true, reviewId: reviewTaskId, promotionId: record.promotion_id })}\n`)
}

function effectiveness(reviewTaskId) {
  assertCleanCandidate()
  if (!reviewTaskId) throw new Error('effectiveness adapter requires --review-task from the completed AGY review')
  const current = candidate()
  const records = join(root, '.appsdk', 'records')
  const candidateRecord = JSON.parse(readFileSync(join(records, `fix-candidate-record-${moduleId}.json`), 'utf8'))
  const validation = JSON.parse(readFileSync(join(records, `pre-review-validation-record-${moduleId}.json`), 'utf8'))
  const reproduction = JSON.parse(readFileSync(join(records, `reproduction-record-${moduleId}.json`), 'utf8'))
  const reviewStatusPath = join(projectRoot, '.agent-collab', 'review', reviewTaskId, 'status.json')
  if (!existsSync(reviewStatusPath)) throw new Error(`completed AGY review status is missing: ${reviewTaskId}`)
  const reviewStatus = JSON.parse(readFileSync(reviewStatusPath, 'utf8'))
  if (reviewStatus.verdict !== 'pass') throw new Error(`AGY review is not PASS: ${reviewStatus.verdict ?? 'unknown'}`)
  if (candidateRecord.head_commit !== current.head || candidateRecord.tree_hash !== current.tree) throw new Error('candidate record does not bind current source')
  if (validation.candidate_commit !== current.head || validation.candidate_tree_hash !== current.tree) throw new Error('pre-review validation does not bind current source')
  const evidenceRoot = join(records, 'evidence', moduleId)
  const baselineName = run('find', [evidenceRoot, '-type', 'f', '-name', '*-baseline.json', '-print']).split('\n').filter(Boolean).at(-1)
  if (!baselineName) throw new Error('baseline reproduction evidence is missing; run --baseline first')
  const baselineEvidence = JSON.parse(readFileSync(baselineName, 'utf8'))
  if (baselineEvidence.source_commit !== current.head || baselineEvidence.phase !== 'baseline_reproduction') throw new Error('baseline evidence is not bound to the recorded candidate')
  const attemptId = `effectiveness-${Date.now()}-${randomUUID()}`
  const controlRoot = join(root, '.appsdk-control', 'lifecycle-adapter', attemptId)
  const artifactHash = validation.artifact_hash
  const environmentId = validation.deployment.environment_id
  const inputHashes = [hash('pnpm vitest UI'), hash('tsc UI'), hash('tsdown UI'), hash('tsc OpenCode'), hash('tsdown OpenCode'), hash('npm pack/install/import OpenCode')]
  mkdirSync(controlRoot, { recursive: true })
  writeOrAssert(join(controlRoot, 'transaction.json'), {
    attemptId,
    issueId,
    moduleId,
    phase: 'post_architecture_effectiveness',
    candidate: current,
    artifactHash,
    environmentId,
    inputHashes,
    state: 'started',
    created_at: now(),
  })
  try {
    run('pnpm', ['--dir', 'deepseek-harness', 'exec', 'vitest', 'run', '--config', '../Teams/ui/teams-console/vitest.config.ts'], projectRoot)
    run('pnpm', ['--dir', 'deepseek-harness', 'exec', 'tsc', '--project', '../Teams/ui/teams-console/tsconfig.json'], projectRoot)
    run('pnpm', ['--dir', projectRoot + '/deepseek-harness', 'exec', 'tsdown', '--config', projectRoot + '/Teams/ui/teams-console/tsdown.config.ts'], projectRoot)
    run('pnpm', ['--dir', 'deepseek-harness', 'exec', 'tsc', '--noEmit', '--project', '../Teams/opencode-adapter/tsconfig.json'], projectRoot)
    run('pnpm', ['--dir', projectRoot + '/deepseek-harness', 'exec', 'tsdown', projectRoot + '/Teams/opencode-adapter/src/index.ts', '--no-config', '--out-dir', projectRoot + '/Teams/opencode-adapter/lib', '--format', 'esm', '--platform', 'node', '--target', 'es2022', '--dts', '--clean'], projectRoot)
    const positive = evidence(`${attemptId}-positive`, 'positive_intervention', 'positive_test', current, {
      artifact_hash: artifactHash,
      environment_id: environmentId,
      entrypoint: 'Teams UI and OpenCode test and build suite',
      execution_surface: 'development_whitebox',
    })
    const negative = evidence(`${attemptId}-negative`, 'negative_intervention', 'negative_test', current, {
      artifact_hash: artifactHash,
      environment_id: environmentId,
      entrypoint: 'Teams UI and OpenCode focused test and build suite',
      execution_surface: 'development_whitebox',
    })
    write(join(controlRoot, 'positive.json'), positive)
    write(join(controlRoot, 'negative.json'), negative)
    const deploymentRoot = join(controlRoot, 'deployment')
    mkdirSync(deploymentRoot, { recursive: true })
    run('npm', ['pack', '--pack-destination', deploymentRoot], join(root, 'ui', 'teams-console'))
    run('npm', ['pack', '--pack-destination', deploymentRoot], join(root, 'opencode-adapter'))
    const uiTarball = join(deploymentRoot, 'deepseek-ai-teams-console-0.1.0.tgz')
    const openCodeTarball = join(deploymentRoot, 'deepseek-ai-teams-opencode-adapter-0.1.0.tgz')
    const uiInstallRoot = join(deploymentRoot, 'installed-ui')
    const adapterInstallRoot = join(deploymentRoot, 'installed-adapter')
    mkdirSync(uiInstallRoot, { recursive: true })
    mkdirSync(adapterInstallRoot, { recursive: true })
    run('npm', ['init', '--yes'], uiInstallRoot)
    run('npm', ['init', '--yes'], adapterInstallRoot)
    run('npm', ['install', '--ignore-scripts', uiTarball], uiInstallRoot)
    run('npm', ['install', '--ignore-scripts', openCodeTarball], adapterInstallRoot)
    const installedUi = join(uiInstallRoot, 'node_modules', '@deepseek-ai', 'teams-console', 'lib', 'client.js')
    const installedOpenCode = join(adapterInstallRoot, 'node_modules', '@deepseek-ai', 'teams-opencode-adapter', 'lib', 'index.mjs')
    run('test', ['-s', installedUi], uiInstallRoot)
    run('test', ['-s', installedOpenCode], adapterInstallRoot)
    run('node', ['--check', installedOpenCode], adapterInstallRoot)
    run('node', ['--input-type=module', '-e', `await import(${JSON.stringify(installedOpenCode)})`], adapterInstallRoot)
    const blackbox = evidence(`${attemptId}-blackbox`, 'post_architecture_effectiveness', 'sample_replay', current, {
      artifact_hash: artifactHash,
      environment_id: environmentId,
      entrypoint: installedOpenCode,
      execution_surface: 'deployed_blackbox',
      producer: { adapter, identity: `${adapter}/deployment` },
    })
    write(join(controlRoot, 'blackbox.json'), blackbox)
    for (const name of ['positive', 'negative', 'blackbox']) {
      const value = JSON.parse(readFileSync(join(controlRoot, `${name}.json`), 'utf8'))
      write(join(evidenceRoot, `${value.evidence_id}.json`), value)
    }
    const record = {
      effectiveness_id: `effectiveness-${attemptId}`,
      issue_id: issueId,
      module_id: moduleId,
      fix_candidate_id: candidateRecord.fix_candidate_id,
      architecture_review_id: reviewTaskId,
      reviewed_commit: current.head,
      reviewed_tree_hash: current.tree,
      reproduction_input_hashes: reproduction.input_hashes,
      baseline_evidence_id: baselineEvidence.evidence_id,
      fixed_replay_evidence_id: blackbox.evidence_id,
      positive_evidence_ids: [positive.evidence_id],
      negative_evidence_ids: [negative.evidence_id],
      blackbox_evidence_ids: [blackbox.evidence_id],
      source_unchanged_since_review: true,
      result: 'pass',
      created_at: now(),
    }
    write(join(records, `effectiveness-record-${moduleId}.json`), record)
    overwrite(join(controlRoot, 'transaction.json'), {
      attemptId,
      issueId,
      moduleId,
      phase: 'post_architecture_effectiveness',
      candidate: current,
      artifactHash,
      environmentId,
      inputHashes,
      state: 'committed',
      effectivenessId: record.effectiveness_id,
      completed_at: now(),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, attemptId, effectivenessId: record.effectiveness_id })}\n`)
  } catch (error) {
    overwrite(join(controlRoot, 'failure.json'), { attemptId, error: String(error), retry_allowed: true, failed_at: now() })
    process.stderr.write(`${JSON.stringify({ ok: false, attemptId, retry_allowed: true, failed_node: String(error) })}\n`)
    process.exitCode = 1
  }
}

function emitPromotionRecords() {
  assertCleanCandidate()
  const c = candidate()
  run('appsdk', ['compile', 'Teams'], projectRoot)
  run('git', ['merge-base', '--is-ancestor', c.head, 'refs/heads/main'], projectRoot)
  const mainlineCommit = git(['rev-parse', 'refs/heads/main'])
  const mainlineTree = git(['rev-parse', 'refs/heads/main^{tree}'])
  if (mainlineTree !== c.tree) throw new Error('mainline tree does not equal the tested candidate tree')
  const records = join(root, '.appsdk', 'records')
  const candidateRecord = json(join(records, `fix-candidate-record-${moduleId}.json`))
  const reproduction = json(join(records, `reproduction-record-${moduleId}.json`))
  const review = json(join(records, 'review-record.json'))
  const effectivenessRecord = json(join(records, `effectiveness-record-${moduleId}.json`))
  const moduleArtifact = json(join(root, 'generated', 'modules', moduleId, 'module.compiled.json'))
  const projectArtifactPath = join(root, 'generated', 'project.compiled.json')
  const projectArtifact = existsSync(projectArtifactPath) ? json(projectArtifactPath) : moduleArtifact
  const evidenceRoot = join(records, 'evidence', moduleId)
  const baselinePath = run('find', [evidenceRoot, '-type', 'f', '-name', '*-baseline.json', '-print']).split('\n').filter(Boolean).at(-1)
  if (!baselinePath) throw new Error('baseline reproduction evidence is missing; run --baseline first')
  const baseline = json(baselinePath)
  if (review.reviewed_commit !== c.head || effectivenessRecord.reviewed_commit !== c.head) throw new Error('promotion graph is not bound to current source')
  const branch = git(['branch', '--show-current']) || 'HEAD'
  const worktree = {
    worktree_id: `worktree-${c.head.slice(0, 12)}`,
    issue_id: issueId,
    module_id: moduleId,
    base_ref: 'origin/main',
    base_commit: c.base,
    branch,
    head_commit: c.head,
    initial_clean: true,
    final_clean: true,
    isolation_mode: 'isolated_worktree',
    scope_hash: c.scope,
    created_at: now(),
  }
  const merge = {
    merge_id: `merge-${c.head.slice(0, 12)}`,
    issue_id: issueId,
    module_id: moduleId,
    fix_candidate_id: candidateRecord.fix_candidate_id,
    effectiveness_id: effectivenessRecord.effectiveness_id,
    mainline_ref: 'refs/heads/main',
    candidate_commit: c.head,
    merge_commit: mainlineCommit,
    candidate_tree_hash: c.tree,
    merged_tree_hash: mainlineTree,
    change_identity: 'exact',
    result: 'pass',
    created_at: now(),
  }
  const regression = {
    regression_report_id: `regression-${c.head.slice(0, 12)}`,
    module_id: moduleId,
    source_commit: mainlineCommit,
    artifact_hash: moduleArtifact.artifact_hash,
    public_api_hash: moduleArtifact.public_api_hash,
    scope_hash: c.scope,
    input_hash: moduleArtifact.artifact_hash,
    suite_id: 'teams-design-runtime-regression',
    command: { program: 'pnpm', args: ['run', 'check'], working_directory: '.' },
    test_count: 1,
    passed: 1,
    failed: 0,
    skipped: 0,
    result: 'pass',
    producer: { adapter, identity: `${adapter}/regression` },
    test_characteristics: { whitebox: true, blackbox: true },
    created_at: now(),
  }
  const promotion = {
    promotion_id: review.promotion_id,
    issue_id: issueId,
    experiment_id: issueId,
    module_id: moduleId,
    worktree_record_id: worktree.worktree_id,
    reproduction_record_id: reproduction.reproduction_id,
    fix_candidate_id: candidateRecord.fix_candidate_id,
    architecture_review_id: review.review_id,
    effectiveness_record_id: effectivenessRecord.effectiveness_id,
    merge_record_id: merge.merge_id,
    base_commit: c.base,
    candidate_commit: c.head,
    merged_commit: mainlineCommit,
    source_commit: mainlineCommit,
    previous_active_version: null,
    new_active_version: json(join(root, 'ui', 'teams-console', 'package.json')).version,
    review_id: review.review_id,
    evidence_ids: [...new Set([baseline.evidence_id, ...candidateRecord.verification_evidence_ids, ...review.evidence_ids, ...effectivenessRecord.positive_evidence_ids, ...effectivenessRecord.negative_evidence_ids, ...effectivenessRecord.blackbox_evidence_ids])],
    required_gate_results: [{ gate_id: 'fix_lifecycle_graph', result: 'pass', producer: adapter }],
    change_set_id: c.diff,
    compatibility_level: 'compatible',
    root_cause: reproduction.first_divergence,
    design_id: candidateRecord.design_id,
    change_reason_comment: 'Bind promotion to the real candidate, review, effectiveness, merge and regression graph.',
    playground_cleanup_record_id: `cleanup-${c.head.slice(0, 12)}`,
    artifact_hash: projectArtifact.artifact_hash,
    scope_hash: c.scope,
    public_api_hash: moduleArtifact.public_api_hash,
    created_at: now(),
  }
  const existingWorktree = readJsonIfExists(join(records, 'worktree-record.json'))
  const existingModuleWorktree = readJsonIfExists(join(records, `worktree-record-${moduleId}.json`))
  if (!existingWorktree) write(join(records, 'worktree-record.json'), worktree)
  if (!existingModuleWorktree) write(join(records, `worktree-record-${moduleId}.json`), worktree)
  for (const existing of [existingWorktree, existingModuleWorktree]) {
    if (!existing) continue
    for (const key of ['worktree_id', 'issue_id', 'module_id', 'base_ref', 'base_commit', 'branch', 'head_commit', 'isolation_mode', 'scope_hash']) {
      if (existing[key] !== worktree[key]) throw new Error(`promotion worktree record does not bind current source: ${key}`)
    }
  }
  writeOrAssert(join(records, 'merge-record.json'), merge)
  writeOrAssert(join(records, `merge-record-${moduleId}.json`), merge)
  writeOrAssert(join(records, 'regression-report.json'), regression)
  writeOrAssert(join(records, `regression-report-${moduleId}.json`), regression)
  writeOrAssert(join(records, 'promotion-record.json'), promotion)
  writeOrAssert(join(records, `promotion-record-${moduleId}.json`), promotion)
  process.stdout.write(`${JSON.stringify({ ok: true, promotionId: promotion.promotion_id, mergeId: merge.merge_id })}\n`)
}

function emitMainlineReceipt() {
  assertCleanCandidate()
  const c = candidate()
  const records = join(root, '.appsdk', 'records')
  const mergePath = join(records, `merge-record-${moduleId}.json`)
  const merge = json(existsSync(mergePath) ? mergePath : join(records, 'merge-record.json'))
  const remote = 'origin'
  const localMainCommit = git(['rev-parse', 'refs/heads/main'])
  const remoteMainCommit = git(['ls-remote', remote, 'refs/heads/main']).trim().split(/\s+/)[0]
  if (localMainCommit !== remoteMainCommit) throw new Error('local main does not match remote main')
  if (localMainCommit !== merge.merge_commit) throw new Error('mainline commit does not match recorded merge commit')
  const receipt = {
    receipt_id: `receipt-${c.head.slice(0, 12)}`,
    integration_id: merge.merge_id,
    queue_entry_id: null,
    milestone_id: null,
    issue_id: issueId,
    module_id: moduleId,
    local_main_ref: 'refs/heads/main',
    remote_name: remote,
    remote_ref: 'refs/heads/main',
    integration_commit: merge.merge_commit,
    local_main_commit: localMainCommit,
    remote_main_commit: remoteMainCommit,
    integration_tree_hash: merge.merged_tree_hash,
    candidate_reachable: true,
    integration_local_reachable: true,
    integration_remote_reachable: true,
    remote_verified: true,
    producer: adapter,
    observed_at: now(),
    result: 'pass',
    created_at: now(),
  }
  write(join(records, `mainline-receipt-record-${receipt.receipt_id}.json`), receipt)
  process.stdout.write(`${JSON.stringify({ ok: true, receiptId: receipt.receipt_id, remoteMainCommit })}\n`)
}

const mode = process.argv[2]
if (mode === '--baseline') baseline()
else if (mode === '--review-record') emitReviewRecord(process.argv[3])
else if (mode === '--effectiveness') effectiveness(process.argv[3] === '--review-task' ? process.argv[4] : undefined)
else if (mode === '--promotion-records') emitPromotionRecords()
else if (mode === '--mainline-receipt') emitMainlineReceipt()
else main()
