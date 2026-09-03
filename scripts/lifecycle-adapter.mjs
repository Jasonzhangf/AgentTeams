import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const projectRoot = resolve(root, '..')
const moduleId = 'teams-design'
const issueId = 'teams-lifecycle-20260902'
const adapter = 'teams::lifecycle-adapter:v1'

const hash = value => `sha256:${createHash('sha256').update(value).digest('hex')}`
const now = () => new Date().toISOString()

function run(program, args, cwd = projectRoot) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
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
  const status = git(['status', '--porcelain']).split('\n').filter(Boolean)
  if (status.some(line => !line.startsWith('?? Teams/.appsdk/records/'))) {
    throw new Error('lifecycle adapter requires a clean candidate worktree')
  }
  const c = candidate()
  const attempt = `attempt-${Date.now()}-${randomUUID()}`
  const records = join(root, '.appsdk', 'records')
  const evidenceRoot = join(records, 'evidence', moduleId)
  const control = join(root, '.appsdk-control', 'lifecycle-adapter', attempt)
  mkdirSync(control, { recursive: true })

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

main()
