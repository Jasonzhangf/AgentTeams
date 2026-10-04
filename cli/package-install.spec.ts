import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { candidatePackReceipt, installedLifecycleReceipt } from '../scripts/lifecycle-adapter.mjs'
import { currentCandidateIdentity } from '../scripts/receipt-identity.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const packRoot = join(root, 'generated', 'modules', 'teams-source', 'lib')
const receiptPath = join(root, 'generated', 'modules', 'teams-source', 'package-receipt.json')
const frozenEvidenceDir = join(root, 'docs', 'evidence', '746dd7b-u1-package-20261003')
const execFileAsync = promisify(execFile)
const maxBuffer = 32 * 1024 * 1024

let evidenceDir: string
let installedReceiptPath: string

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

async function packFiles(): Promise<string[]> {
  const directory = await mkdtemp(join(tmpdir(), 'u1-package-install-pack-'))
  try {
    const { stdout } = await execFileAsync('npm', ['pack', packRoot, '--pack-destination', directory, '--json'], {
      cwd: root,
      env: process.env,
      maxBuffer,
    })
    const result = JSON.parse(stdout)[0] as { files: Array<string | { path: string }> }
    return result.files.map(file => typeof file === 'string' ? file : file.path).sort()
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runPackageUserSmoke(): Promise<void> {
  await execFileAsync(process.execPath, ['scripts/package-user-smoke.mjs', '--evidence-dir', evidenceDir], {
    cwd: root,
    env: process.env,
    maxBuffer,
  })
}

async function runInstalledSmoke(receipt = installedReceiptPath): Promise<void> {
  await execFileAsync(process.execPath, ['scripts/installed-runtime-smoke.mjs', '--receipt-path', receipt], {
    cwd: root,
    env: process.env,
    maxBuffer,
  })
}

async function tamperedReceipt(name: string, mutate: (receipt: any) => void): Promise<string> {
  const receipt = JSON.parse(await readFile(installedReceiptPath, 'utf8'))
  mutate(receipt)
  const path = join(evidenceDir, name)
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`)
  return path
}

async function tamperedPackageReceipt(name: string, mutate: (receipt: any) => void): Promise<string> {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))
  mutate(receipt)
  const path = join(evidenceDir, name)
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`)
  return path
}

async function createIdentityFixtureRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'u1-receipt-identity-'))
  await execFileAsync('git', ['init', '--quiet'], { cwd: repo, env: process.env, maxBuffer })
  await writeFile(join(repo, 'source.txt'), 'tracked source\n')
  await execFileAsync('git', ['add', 'source.txt'], { cwd: repo, env: process.env, maxBuffer })
  await execFileAsync('git', ['-c', 'user.name=receipt-test', '-c', 'user.email=receipt-test@example.invalid', 'commit', '--quiet', '-m', 'fixture'], {
    cwd: repo,
    env: process.env,
    maxBuffer,
  })
  await execFileAsync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: repo, env: process.env, maxBuffer })
  return repo
}

describe('agentteams install package', () => {
  beforeAll(async () => {
    evidenceDir = await mkdtemp(join(tmpdir(), 'u1-package-install-spec-'))
    installedReceiptPath = join(evidenceDir, 'installed-runtime-smoke.receipt.json')
    await execFileAsync('pnpm', ['build'], { cwd: root, env: process.env, maxBuffer })
    await execFileAsync(process.execPath, ['scripts/package-artifact.mjs', '--mode', 'base'], {
      cwd: root,
      env: process.env,
      maxBuffer,
    })
  }, 300_000)

  it('emits and consumes exact current Git candidate identity', async () => {
    const packageReceipt = JSON.parse(await readFile(receiptPath, 'utf8'))

    expect(packageReceipt.candidate).toEqual(currentCandidateIdentity(root))
  })

  it('allows declared SDK evidence and lifecycle record paths', async () => {
    const repo = await createIdentityFixtureRepo()
    try {
      const identityBefore = currentCandidateIdentity(repo)
      const allowedPaths = [
        '.appsdk/records/evidence/teams-source/attempt-1-artifact.json',
        '.appsdk/records/evidence-record.json',
        '.appsdk/records/worktree-record.json',
        '.appsdk/records/fix-candidate-record-teams-source-attempt-1.json',
        '.appsdk/records/pre-review-validation-record-teams-source-attempt-1.json',
        '.appsdk/records/evidence-record-teams-source-attempt-1.json',
        '.appsdk/records/worktree-record-teams-source-attempt-1.json',
      ]
      for (const path of allowedPaths) {
        await mkdir(join(repo, path, '..'), { recursive: true })
        await writeFile(join(repo, path), '{}\n')
      }
      expect(currentCandidateIdentity(repo)).toEqual(identityBefore)
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('rejects unclassified or nested SDK record paths', async () => {
    const repo = await createIdentityFixtureRepo()
    try {
      const rejectedPaths = [
        '.appsdk/records/source.md',
        '.appsdk/records/fix-candidate-record-teams-source-attempt-1.txt',
        '.appsdk/records/evidence/teams-source/nested/attempt-1-artifact.json',
        '.appsdk/records/evidence/teams-source/source.md',
      ]
      for (const path of rejectedPaths) {
        await mkdir(join(repo, path, '..'), { recursive: true })
        await writeFile(join(repo, path), 'fixture\n')
        expect(() => currentCandidateIdentity(repo)).toThrow(path)
        await rm(join(repo, path), { force: true })
      }
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('still rejects untracked product source', async () => {
    const repo = await createIdentityFixtureRepo()
    try {
      await writeFile(join(repo, 'untracked-product.ts'), 'export const fixture = true\n')
      expect(() => currentCandidateIdentity(repo)).toThrow()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('still rejects unstaged tracked source', async () => {
    const repo = await createIdentityFixtureRepo()
    try {
      await writeFile(join(repo, 'source.txt'), 'unstaged source\n')
      expect(() => currentCandidateIdentity(repo)).toThrow()
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it('builds one base pack root with the root version and installable layout', async () => {
    const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const packageJson = JSON.parse(await readFile(join(packRoot, 'package.json'), 'utf8'))
    const receipt = JSON.parse(await readFile(receiptPath, 'utf8'))

    expect(packageJson).toMatchObject({
      name: 'agentteams',
      version: rootPackage.version,
      private: true,
      type: 'module',
      bin: { agentteams: './cli/agentteams.mjs' },
      files: ['cli', 'generated/runtime-lib', 'console-host/lib', 'console-host/static', 'ui/teams-console'],
      engines: { node: '^22.22.2' },
      os: ['darwin'],
      cpu: ['arm64'],
      dependencies: rootPackage.dependencies,
    })
    expect(receipt).toMatchObject({ mode: 'base', release_eligible: false, version: rootPackage.version })

    const required = [
      'cli/agentteams.mjs',
      'generated/runtime-lib/runtime/local-process.js',
      'console-host/lib/index.mjs',
      'console-host/static/console.html',
      'ui/teams-console/index.js',
      'ui/teams-console/browser.js',
      'ui/teams-console/client/render.js',
      'ui/teams-console/assets/agentbrowser-icon.jpg',
    ]
    for (const path of required) expect(await exists(join(packRoot, path)), path).toBe(true)

    const declaredFiles = packageJson.files as string[]
    const receiptFiles = receipt.files as string[]
    const packedFiles = await packFiles()
    for (const declared of declaredFiles) {
      expect(await exists(join(packRoot, declared)), `declared base entry is missing from staged pack: ${declared}`).toBe(true)
      const inReceipt = receiptFiles.some(file => file === declared || file.startsWith(`${declared}/`))
      const inTarball = packedFiles.some(file => file === declared || file.startsWith(`${declared}/`))
      expect(inReceipt, `declared base entry is absent from package receipt: ${declared}`).toBe(true)
      expect(inTarball, `declared base entry is absent from packed tarball: ${declared}`).toBe(true)
    }
    expect(packedFiles).toEqual(receiptFiles)

    expect(await exists(join(packRoot, 'runtime', 'package.json'))).toBe(false)
    expect(await exists(join(packRoot, 'node_modules'))).toBe(false)
  }, 30_000)

  it('packs and installs the base tarball for public CLI and Console consumers', async () => {
    await execFileAsync(process.execPath, ['scripts/package-artifact.mjs', '--mode', 'base'], {
      cwd: root,
      env: process.env,
      maxBuffer,
    })
    await expect(runPackageUserSmoke()).resolves.toBeUndefined()
  }, 300_000)

  it('requires explicit base mode until the final SDK build interface exists', async () => {
    let error: unknown
    try {
      await execFileAsync(process.execPath, ['scripts/package-artifact.mjs'], { cwd: root, env: process.env })
    } catch (caught) {
      error = caught
    }
    expect(error).toMatchObject({
      stderr: expect.stringContaining('final mode requires the frozen D3/U4 SDK build receipt interface'),
    })
  })

  it('consumes the staged runtime library through the public runtime smoke', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/runtime-smoke.mjs'], {
      cwd: root,
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    })
    expect(stdout).toContain('Packaged runtime smoke passed')
  }, 60_000)

  it('records base asset success without claiming installed lifecycle evidence', async () => {
    await runPackageUserSmoke()
    const baseReceipt = await readJson(join(evidenceDir, 'package-user-smoke.receipt.json'))
    expect(baseReceipt).toMatchObject({
      release_eligible: false,
      lifecycle: { status: 'not_run' },
    })
    expect(baseReceipt).not.toHaveProperty('deployment_restart')
  }, 300_000)

  it('requires real installed start/restart lifecycle evidence', async () => {
    await runInstalledSmoke()

    const installedReceipt = await readJson(installedReceiptPath)
    expect(installedReceipt).toMatchObject({
      release_eligible: false,
      lifecycle: {
        status: 'passed',
        start: { state: 'running' },
        restart: { state: 'running' },
      },
    })

    const lifecycle = installedReceipt.lifecycle as {
      start: { generation: number; launcher: { pid: number }; processes: Array<{ id: string; pid: number; entryPath: string }> }
      restart: { generation: number; launcher: { pid: number }; processes: Array<{ id: string; pid: number; entryPath: string }> }
    }
    expect(lifecycle.restart.generation).toBeGreaterThan(lifecycle.start.generation)
    expect(lifecycle.restart.launcher.pid).not.toBe(lifecycle.start.launcher.pid)
    expect(new Set(lifecycle.start.processes.map(process => process.pid)).size).toBe(3)
    expect(new Set(lifecycle.restart.processes.map(process => process.pid)).size).toBe(3)
    const startPids = new Set(lifecycle.start.processes.map(process => process.pid))
    for (const process of lifecycle.restart.processes) expect(startPids.has(process.pid)).toBe(false)
    for (const process of [...lifecycle.start.processes, ...lifecycle.restart.processes]) {
      expect(process.entryPath).toContain('node_modules/agentteams/generated/runtime-lib/')
    }
  }, 300_000)

  it('accepts the installed receipt bound to this candidate staged package', async () => {
    const packageReceipt = await readJson(receiptPath)
    const installed = installedLifecycleReceipt({
      receiptPath: installedReceiptPath,
      expectedPackContentSha256: packageReceipt.content_sha256,
      expectedCandidateIdentity: packageReceipt.candidate,
    })
    expect(installed.packContentSha256).toBe(packageReceipt.content_sha256)
    expect(installed.installedContentSha256).toBe(packageReceipt.content_sha256)
    expect(installed.tarballSha256).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('rejects an emitted package receipt with missing or tampered candidate identity', async () => {
    for (const [name, mutate] of [
      ['missing-candidate.receipt.json', receipt => { delete receipt.candidate }],
      ['old-tree-candidate.receipt.json', receipt => {
        receipt.candidate.tree_hash = '4'.repeat(40)
        receipt.candidate.indexed_tree_hash = '4'.repeat(40)
        receipt.candidate.source_state = 'committed'
      }],
      ['old-base-candidate.receipt.json', receipt => {
        receipt.candidate.base_commit = '0'.repeat(40)
      }],
    ]) {
      const wrongPath = await tamperedPackageReceipt(name, mutate)
      expect(() => candidatePackReceipt(wrongPath)).toThrow(
        /candidate .*missing|candidate .*does not match this candidate|candidate source_state does not match candidate tree identity/u,
      )
    }
  })

  it('rejects a consumed installed receipt with missing, tampered, old-tree, or old-base identity', async () => {
    const packageReceipt = await readJson(receiptPath)
    for (const [name, mutate] of [
      ['missing-candidate.receipt.json', receipt => { delete receipt.candidate }],
      ['tampered-candidate.receipt.json', receipt => {
        receipt.candidate.head_commit = '1'.repeat(40)
      }],
      ['old-tree-candidate.receipt.json', receipt => {
        receipt.candidate.tree_hash = '2'.repeat(40)
        receipt.candidate.indexed_tree_hash = '2'.repeat(40)
        receipt.candidate.source_state = 'committed'
      }],
      ['old-base-candidate.receipt.json', receipt => {
        receipt.candidate.base_commit = '3'.repeat(40)
      }],
    ]) {
      const wrongCandidate = await tamperedReceipt(name, mutate)
      expect(() => installedLifecycleReceipt({
        receiptPath: wrongCandidate,
        expectedPackContentSha256: packageReceipt.content_sha256,
        expectedCandidateIdentity: packageReceipt.candidate,
      })).toThrow(/candidate .*missing|candidate .*does not match this candidate|candidate source_state does not match candidate tree identity/u)
    }
  })

  it('rejects an installed receipt produced for a different package artifact', async () => {
    const packageReceipt = await readJson(receiptPath)
    const wrongCandidate = await tamperedReceipt('wrong-pack.receipt.json', receipt => {
      receipt.pack.content_sha256 = '0'.repeat(64)
      receipt.tarball.content_sha256 = '0'.repeat(64)
      receipt.install.installed_content_sha256 = '0'.repeat(64)
    })
    expect(() => installedLifecycleReceipt({
      receiptPath: wrongCandidate,
      expectedPackContentSha256: packageReceipt.content_sha256,
      expectedCandidateIdentity: packageReceipt.candidate,
    })).toThrow(/does not match this candidate package/u)
  })

  it('rejects an installed receipt whose installed content is another artifact', async () => {
    const packageReceipt = await readJson(receiptPath)
    const wrongContent = await tamperedReceipt('wrong-installed-content.receipt.json', receipt => {
      receipt.install.installed_content_sha256 = 'f'.repeat(64)
    })
    expect(() => installedLifecycleReceipt({
      receiptPath: wrongContent,
      expectedPackContentSha256: packageReceipt.content_sha256,
      expectedCandidateIdentity: packageReceipt.candidate,
    })).toThrow(/installed content .* does not match the staged pack/u)
  })

  it('rejects an installed receipt whose tarball is another artifact', async () => {
    const packageReceipt = await readJson(receiptPath)
    const wrongTarball = await tamperedReceipt('wrong-tarball.receipt.json', receipt => {
      receipt.tarball.sha256 = '1'.repeat(64)
      receipt.tarball.content_sha256 = '1'.repeat(64)
    })
    expect(() => installedLifecycleReceipt({
      receiptPath: wrongTarball,
      expectedPackContentSha256: packageReceipt.content_sha256,
      expectedCandidateIdentity: packageReceipt.candidate,
    })).toThrow(/tarball content does not match the staged pack/u)
  })

  it('rejects a missing installed receipt', async () => {
    const packageReceipt = await readJson(receiptPath)
    expect(() => installedLifecycleReceipt({
      receiptPath: join(evidenceDir, 'absent.receipt.json'),
      expectedPackContentSha256: packageReceipt.content_sha256,
      expectedCandidateIdentity: packageReceipt.candidate,
    })).toThrow(/receipt is missing/u)
  })

  it('rejects an advanced restart that reuses the original launcher PID', async () => {
    const packageReceipt = await readJson(receiptPath)
    const sameLauncher = await tamperedReceipt('same-launcher.receipt.json', receipt => {
      const lifecycle = receipt.lifecycle
      lifecycle.restart.launcher.pid = lifecycle.start.launcher.pid
      lifecycle.restart.processes = lifecycle.start.processes.map(process => ({
        ...process,
        pid: process.pid + 1000,
        startToken: `same-launcher-${process.startToken}`,
      }))
    })
    expect(() => installedLifecycleReceipt({
      receiptPath: sameLauncher,
      expectedPackContentSha256: packageReceipt.content_sha256,
      expectedCandidateIdentity: packageReceipt.candidate,
    })).toThrow(/restart did not prove a new launcher/u)
  })

  it('leaves the frozen 20261003 receipts byte-unchanged across public smoke runs', async () => {
    const frozenPackage = join(frozenEvidenceDir, 'package-user-smoke.receipt.json')
    const frozenInstalled = join(frozenEvidenceDir, 'installed-runtime-smoke.receipt.json')
    const before = await Promise.all([sha256(frozenPackage), sha256(frozenInstalled)])
    await runPackageUserSmoke()
    await runInstalledSmoke(join(evidenceDir, 'frozen-check.receipt.json'))
    const after = await Promise.all([sha256(frozenPackage), sha256(frozenInstalled)])
    expect(after).toEqual(before)
  }, 300_000)
})
