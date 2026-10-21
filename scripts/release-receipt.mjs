#!/usr/bin/env node
/**
 * Release gate for the internal MVP artifact.
 *
 * A staged package is never release-eligible by itself
 * (`scripts/package-artifact.mjs` writes `release_eligible: false` in every mode).
 * Eligibility belongs to this gate. It cuts the release tarball from the exact
 * staged root and grants `release_eligible: true` only when all of these hold for
 * the same package content:
 *
 *   - the staged package receipt is complete (final mode, content hash matches the
 *     staged root, version matches the root package);
 *   - an installed lifecycle receipt proves start and restart on that same content;
 *   - same-package black-box receipts record every case BB01-BB14 passed at least
 *     once on that content. One run may cover all cases; several runs on the same
 *     artifact may also cover them together, and a case that failed in one run and
 *     passed in another is recorded as flaky rather than dropped;
 *   - the cut tarball carries exactly the staged file set.
 *
 * Any missing or mismatched input throws. The gate writes no receipt on failure, so
 * a failed run cannot leave an eligible artifact behind.
 *
 * Usage:
 *   node scripts/release-receipt.mjs \
 *     --installed-receipt <path> \
 *     --blackbox-receipt <path>[,<path>...] \
 *     --retained-obligations <path> \
 *     --out <path> \
 *     [--tarball-dir <path>]
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const packRoot = join(root, 'generated', 'modules', 'teams-source', 'lib')
const packageReceiptPath = join(root, 'generated', 'modules', 'teams-source', 'package-receipt.json')

function fail(message) {
  throw new Error(message)
}

function listFiles(directory) {
  const files = []
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(child.slice(directory.length + 1).split('\\').join('/'))
      else fail(`unsupported staged entry: ${child}`)
    }
  }
  visit(directory)
  return files.sort()
}

export function hashFileSet(directory, files) {
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

function requireText(value, label) {
  if (typeof value !== 'string' || value === '') fail(`${label} is missing`)
  return value
}

/**
 * Assemble the release receipt from already-read inputs.
 *
 * Kept separate from the file system so a focused test can prove every refusal
 * path without building a package.
 */
export function assembleReleaseReceipt({ packageReceipt, installedLifecycle, blackBoxRuns, tarball, retainedObligations, generatedAt = new Date().toISOString() }) {
  if (packageReceipt?.mode !== 'final') fail(`the staged package mode is ${packageReceipt?.mode ?? 'missing'}, expected final`)
  if (packageReceipt.release_eligible !== false) fail('a staged package receipt must stay non-release; only this release gate grants eligibility')
  requireText(packageReceipt.content_sha256, 'the staged package content hash')
  requireText(packageReceipt.version, 'the staged package version')
  const candidate = packageReceipt.candidate ?? {}
  requireText(candidate.head_commit, 'the staged package candidate commit')

  if (installedLifecycle?.lifecycle?.status !== 'passed') {
    fail(`the installed lifecycle receipt is ${installedLifecycle?.lifecycle?.status ?? 'missing'}, expected passed`)
  }
  for (const phase of ['start', 'restart']) {
    const state = installedLifecycle.lifecycle[phase]?.state
    if (state !== 'running') fail(`the installed lifecycle ${phase} state is ${state ?? 'missing'}, expected running`)
  }
  if (installedLifecycle.package?.version !== packageReceipt.version) {
    fail(`the installed lifecycle version ${installedLifecycle.package?.version ?? 'missing'} does not match the staged package ${packageReceipt.version}`)
  }
  if (installedLifecycle.tarball?.content_sha256 !== packageReceipt.content_sha256) {
    fail('the installed lifecycle receipt installed different package content than the staged package')
  }
  if (installedLifecycle.candidate?.head_commit !== candidate.head_commit) {
    fail('the installed lifecycle receipt does not belong to the staged package candidate')
  }

  if (!Array.isArray(blackBoxRuns) || blackBoxRuns.length === 0) fail('at least one black-box receipt is required')
  const attempts = new Map()
  const runs = []
  for (const run of blackBoxRuns) {
    if (run?.installed_package?.content_sha256 !== packageReceipt.content_sha256) {
      fail(`a black-box receipt ran against different package content than the staged package: ${run?.receipt_path ?? '(unnamed)'}`)
    }
    if (run.candidate_commit !== candidate.head_commit) {
      fail(`a black-box receipt does not belong to the staged package candidate: ${run.receipt_path ?? '(unnamed)'}`)
    }
    if (!Array.isArray(run.cases) || run.cases.length === 0) fail('a black-box receipt records no cases')
    for (const entry of run.cases) {
      const list = attempts.get(entry.case_id) ?? []
      list.push(entry.status)
      attempts.set(entry.case_id, list)
    }
    runs.push({
      receipt_path: run.receipt_path,
      exit_code: run.exit?.code,
      case_ids: run.cases.map(entry => entry.case_id),
      failed: run.exit?.failed ?? [],
      unverified: run.exit?.unverified ?? [],
    })
  }
  // Each case must pass on this artifact at least once. A case that failed in an
  // earlier run and passed in a later run is recorded as flaky instead of hiding
  // the earlier failure.
  const notPassed = [...attempts].filter(([, statuses]) => !statuses.includes('passed')).map(([id, statuses]) => `${id}:${statuses.join('/')}`)
  if (notPassed.length > 0) fail(`these cases never passed on this package: ${notPassed.join(', ')}`)
  const caseIds = [...attempts.keys()].sort()
  const expected = Array.from({ length: 14 }, (_, index) => `BB${String(index + 1).padStart(2, '0')}`)
  const missing = expected.filter(id => !attempts.has(id))
  if (missing.length > 0) fail(`the black-box receipts do not cover these cases: ${missing.join(', ')}`)
  const unexpected = caseIds.filter(id => !expected.includes(id))
  if (unexpected.length > 0) fail(`the black-box receipts record unknown cases: ${unexpected.join(', ')}`)
  const flaky = [...attempts].filter(([, statuses]) => statuses.length > 1).map(([id, statuses]) => ({ case_id: id, attempts: statuses }))

  requireText(tarball?.filename, 'the release tarball name')
  requireText(tarball?.sha256, 'the release tarball hash')
  if (installedLifecycle.tarball?.sha256 !== tarball.sha256) {
    fail('the installed lifecycle receipt installed a different tarball than the release tarball')
  }
  if (!Array.isArray(tarball.files) || tarball.files.length === 0) fail('the release tarball file list is empty')
  const staged = [...(packageReceipt.files ?? [])].sort()
  const packed = [...tarball.files].sort()
  if (staged.length !== packed.length || staged.some((file, index) => file !== packed[index])) {
    fail('the release tarball does not carry exactly the staged file set')
  }

  const obligations = Array.isArray(retainedObligations?.retained) ? retainedObligations.retained : []
  if (obligations.length === 0) fail('the release receipt must name its retained obligations')

  return {
    schema_version: 1,
    kind: 'agentteams-internal-mvp-release-receipt',
    generated_at: generatedAt,
    release_eligible: true,
    scope: 'internal-mvp',
    version: packageReceipt.version,
    candidate,
    package: {
      name: packageReceipt.package?.name ?? 'agentteams',
      version: packageReceipt.version,
      pack_root: packageReceipt.pack_root,
      content_sha256: packageReceipt.content_sha256,
      files: staged,
    },
    tarball: {
      filename: tarball.filename,
      sha256: tarball.sha256,
      size: tarball.size,
      files: packed,
    },
    installed_lifecycle: {
      receipt_path: installedLifecycle.receipt_path,
      status: installedLifecycle.lifecycle.status,
      start_generation: installedLifecycle.lifecycle.start?.generation,
      restart_generation: installedLifecycle.lifecycle.restart?.generation,
      installed_tarball_sha256: installedLifecycle.tarball?.sha256,
      // The installed lifecycle proves this tarball installs, starts and restarts
      // with the fixture config it names. It is not proof for every config shape.
      scope: installedLifecycle.lifecycle_scope ?? { note: 'the installed receipt records no lifecycle scope' },
    },
    black_box: {
      cases_total: caseIds.length,
      cases_passed: caseIds.length,
      cases: caseIds,
      runs,
      flaky_cases: flaky,
      note: 'each case passed at least once on this package content; flaky_cases lists every case that failed in another run',
    },
    retained_obligations: obligations,
    non_claims: [
      'the release tarball is not published to any registry or deployed host',
      'no cross-device receipt for this package content exists',
      'source, test, build, installed, release and review evidence are separate layers',
      'the installed lifecycle evidence uses the fixture config named in installed_lifecycle.scope, not an operator-authored v4 config',
    ],
  }
}

function parseArgs(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || value === undefined) fail(`invalid argument: ${key ?? '(none)'}`)
    values[key.slice(2)] = value
  }
  return values
}

function readJsonFile(path, label) {
  if (!existsSync(path)) fail(`${label} is missing: ${path}`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (cause) {
    fail(`${label} is not valid JSON: ${cause.message}`)
  }
}

function cutTarball(directory) {
  mkdirSync(directory, { recursive: true })
  const packed = spawnSync('npm', ['pack', packRoot, '--pack-destination', directory, '--json'], {
    cwd: root,
    encoding: 'utf8',
  })
  if (packed.status !== 0) fail(`npm pack failed with status ${packed.status}: ${packed.stderr ?? ''}`)
  const result = JSON.parse(packed.stdout)[0]
  const path = join(directory, result.filename)
  const files = result.files.map(file => (typeof file === 'string' ? file : file.path))
  if (!existsSync(path)) fail(`npm pack reported ${result.filename} but the file is missing`)
  return { path, filename: result.filename, files, size: statSync(path).size, sha256: hashFile(path) }
}

function main(argv) {
  const args = parseArgs(argv)
  for (const required of ['installed-receipt', 'blackbox-receipt', 'retained-obligations', 'out']) {
    if (args[required] === undefined) fail(`--${required} is required`)
  }

  const packageReceipt = readJsonFile(packageReceiptPath, 'staged package receipt')
  const stagedFiles = listFiles(packRoot)
  const stagedContent = hashFileSet(packRoot, stagedFiles)
  if (stagedContent !== packageReceipt.content_sha256) {
    fail(`the staged root content ${stagedContent} does not match the package receipt ${packageReceipt.content_sha256}`)
  }
  packageReceipt.files = stagedFiles

  const installedLifecycle = readJsonFile(resolve(args['installed-receipt']), 'installed lifecycle receipt')
  const blackBoxPaths = args['blackbox-receipt'].split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  const blackBoxRuns = blackBoxPaths.map(path => {
    const absolute = resolve(path)
    return { ...readJsonFile(absolute, 'black-box receipt'), receipt_path: absolute.slice(root.length + 1) }
  })
  const retained = readJsonFile(resolve(args['retained-obligations']), 'retained obligations')

  const outDir = resolve(args.out, '..')
  const tarball = cutTarball(args['tarball-dir'] !== undefined ? resolve(args['tarball-dir']) : join(outDir, 'release'))

  const receipt = assembleReleaseReceipt({
    packageReceipt,
    installedLifecycle: {
      ...installedLifecycle,
      receipt_path: resolve(args['installed-receipt']).slice(root.length + 1),
    },
    blackBoxRuns,
    tarball: { filename: tarball.filename, sha256: tarball.sha256, size: tarball.size, files: tarball.files },
    retainedObligations: retained,
  })
  receipt.evidence_commit = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()

  writeFileSync(resolve(args.out), `${JSON.stringify(receipt, null, 2)}\n`)
  writeFileSync(`${tarball.path}.sha256`, `${tarball.sha256}  ${tarball.filename}\n`)
  console.log(`release tarball: ${tarball.path}`)
  console.log(`release tarball sha256: ${tarball.sha256}`)
  console.log(`release receipt: ${resolve(args.out)}`)
  return receipt
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
