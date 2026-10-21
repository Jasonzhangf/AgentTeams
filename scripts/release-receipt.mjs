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
 *   - a same-package black-box receipt records every case passed with no failure
 *     and no unverified case;
 *   - the cut tarball carries exactly the staged file set.
 *
 * Any missing or mismatched input throws. The gate writes no receipt on failure, so
 * a failed run cannot leave an eligible artifact behind.
 *
 * Usage:
 *   node scripts/release-receipt.mjs \
 *     --installed-receipt <path> \
 *     --blackbox-receipt <path> \
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
export function assembleReleaseReceipt({ packageReceipt, installedLifecycle, blackBox, tarball, retainedObligations, generatedAt = new Date().toISOString() }) {
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

  if (blackBox?.exit?.code !== 0) fail(`the black-box receipt exit code is ${blackBox?.exit?.code ?? 'missing'}, expected 0`)
  if ((blackBox.exit.failed ?? []).length > 0) fail(`the black-box receipt records failed cases: ${blackBox.exit.failed.join(', ')}`)
  if ((blackBox.exit.unverified ?? []).length > 0) fail(`the black-box receipt records unverified cases: ${blackBox.exit.unverified.join(', ')}`)
  if (!Array.isArray(blackBox.cases) || blackBox.cases.length === 0) fail('the black-box receipt records no cases')
  const notPassed = blackBox.cases.filter(entry => entry.status !== 'passed').map(entry => `${entry.case_id}:${entry.status}`)
  if (notPassed.length > 0) fail(`the black-box receipt has cases that did not pass: ${notPassed.join(', ')}`)
  if (blackBox.installed_package?.content_sha256 !== packageReceipt.content_sha256) {
    fail('the black-box receipt ran against different package content than the staged package')
  }
  if (blackBox.candidate_commit !== candidate.head_commit) {
    fail('the black-box receipt does not belong to the staged package candidate')
  }

  requireText(tarball?.filename, 'the release tarball name')
  requireText(tarball?.sha256, 'the release tarball hash')
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
    },
    black_box: {
      receipt_path: blackBox.receipt_path,
      cases_total: blackBox.cases.length,
      cases_passed: blackBox.cases.length,
      exit_code: 0,
      cases: blackBox.cases.map(entry => entry.case_id),
    },
    retained_obligations: obligations,
    non_claims: [
      'the release tarball is not published to any registry or deployed host',
      'no cross-device receipt for this package content exists',
      'source, test, build, installed, release and review evidence are separate layers',
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
  const blackBox = readJsonFile(resolve(args['blackbox-receipt']), 'black-box receipt')
  const retained = readJsonFile(resolve(args['retained-obligations']), 'retained obligations')

  const outDir = resolve(args.out, '..')
  const tarball = cutTarball(args['tarball-dir'] !== undefined ? resolve(args['tarball-dir']) : join(outDir, 'release'))

  const receipt = assembleReleaseReceipt({
    packageReceipt,
    installedLifecycle: {
      ...installedLifecycle,
      receipt_path: resolve(args['installed-receipt']).slice(root.length + 1),
    },
    blackBox: { ...blackBox, receipt_path: resolve(args['blackbox-receipt']).slice(root.length + 1) },
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
