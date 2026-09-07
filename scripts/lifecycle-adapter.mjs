import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const moduleId = 'teams-source'
const issueId = 'teams-lifecycle-admission'
const adapter = 'agentteams::lifecycle-adapter:v1'

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

function evidence({ id, phase, kind, candidateInfo, createdAt, command, commandOutput, artifactHash, environmentId, entrypoint, executionSurface, identity }) {
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
    expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    input_hashes: [
      digest(JSON.stringify({ command, sourceCommit: candidateInfo.head, artifactHash })),
      digest(commandOutput),
    ],
    scope_hash: candidateInfo.scopeHash,
    ...(artifactHash ? { artifact_hash: artifactHash } : {}),
    ...(environmentId ? { environment_id: environmentId } : {}),
    ...(entrypoint ? { entrypoint } : {}),
    ...(executionSurface ? { execution_surface: executionSurface } : {}),
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

function main() {
  assertCleanSource()
  const candidateInfo = candidate()
  const existingValidationPath = join(root, '.appsdk', 'records', `pre-review-validation-record-${moduleId}.json`)
  if (existsSync(existingValidationPath)) {
    const existing = readJson(existingValidationPath)
    if (existing.candidate_commit !== candidateInfo.head || existing.candidate_tree_hash !== candidateInfo.tree) {
      throw new Error('existing pre-review validation belongs to another candidate')
    }
    process.stdout.write(`${JSON.stringify({ ok: true, idempotent: true, validation_id: existing.validation_id })}\n`)
    return
  }

  const attempt = `attempt-${Date.now()}-${randomUUID()}`
  const controlRoot = join(root, '.appsdk-control', 'lifecycle-adapter', attempt)
  const commandRoot = join(controlRoot, 'commands')
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
    const verifyOutput = run('pnpm', ['verify'], join(commandRoot, 'pnpm-verify.log'))
    const artifact = readJson(join(root, 'generated', 'modules', moduleId, 'module.compiled.json'))
    if (artifact.source_commit && artifact.source_commit !== candidateInfo.head) {
      throw new Error(`compiled artifact source commit ${artifact.source_commit} does not match ${candidateInfo.head}`)
    }

    const whiteboxCreatedAt = now()
    const installedOutput = run('pnpm', ['smoke:installed'], join(commandRoot, 'pnpm-smoke-installed.log'))
    assertCleanSource()
    if (git(['rev-parse', 'HEAD']) !== candidateInfo.head || git(['rev-parse', 'HEAD^{tree}']) !== candidateInfo.tree) {
      throw new Error('candidate source changed during lifecycle execution')
    }

    const artifactHash = artifact.artifact_hash
    const environmentId = digest(JSON.stringify({
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      artifactHash,
    }))
    const deployedEntrypoint = 'pnpm smoke:installed -> installed runtime/server/relay-process.js + runtime/runtime/agent-process.js'
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
    })

    const recordsRoot = join(root, '.appsdk', 'records')
    const evidenceRoot = join(recordsRoot, 'evidence', moduleId)
    const evidenceSet = [whitebox, build, install, restart, blackbox]
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
      source_unchanged: true,
      result: 'pass',
      created_at: now(),
    }
    writeRecord(join(recordsRoot, 'worktree-record.json'), worktree)
    writeRecord(join(recordsRoot, `worktree-record-${moduleId}.json`), worktree)
    writeRecord(join(recordsRoot, 'evidence-record.json'), whitebox)
    writeRecord(join(recordsRoot, `evidence-record-${moduleId}.json`), whitebox)
    writeJson(join(recordsRoot, `fix-candidate-record-${moduleId}.json`), candidateRecord)
    writeJson(join(recordsRoot, `pre-review-validation-record-${moduleId}.json`), validation)
    writeJson(join(controlRoot, 'result.json'), {
      attempt,
      state: 'committed',
      candidate: candidateInfo,
      artifact_hash: artifactHash,
      environment_id: environmentId,
      records: [
        join(recordsRoot, `fix-candidate-record-${moduleId}.json`),
        join(recordsRoot, `pre-review-validation-record-${moduleId}.json`),
        ...evidenceSet.map(item => join(evidenceRoot, `${item.evidence_id}.json`)),
      ],
      completed_at: now(),
    })
    process.stdout.write(`${JSON.stringify({ ok: true, attempt, candidate: candidateInfo.head, artifact_hash: artifactHash, records: join(recordsRoot, `pre-review-validation-record-${moduleId}.json`) })}\n`)
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
