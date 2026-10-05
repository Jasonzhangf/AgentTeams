import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { candidatePackReceipt, installedLifecycleReceipt } from '../scripts/lifecycle-adapter.mjs'
import { verifyInstalledRuntime } from '../scripts/package-sdk-smoke.mjs'
import { currentCandidateIdentity } from '../scripts/receipt-identity.mjs'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const packRoot = join(root, 'generated', 'modules', 'teams-source', 'lib')
const receiptPath = join(root, 'generated', 'modules', 'teams-source', 'package-receipt.json')
const execFileAsync = promisify(execFile)
const maxBuffer = 32 * 1024 * 1024

let evidenceDir: string
let installedReceiptPath: string
let installedSdkReceiptPath: string

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

async function runInstalledSdkSmoke(receipt = installedSdkReceiptPath): Promise<void> {
  await execFileAsync(process.execPath, ['scripts/package-sdk-smoke.mjs', '--receipt-path', receipt], {
    cwd: root,
    env: process.env,
    maxBuffer,
  })
}

async function runArtifactSmoke(): Promise<void> {
  await execFileAsync(process.execPath, ['scripts/artifact-smoke.mjs'], {
    cwd: root,
    env: process.env,
    maxBuffer,
  })
}

async function createStagedModeFixture(mode?: string): Promise<{ root: string; packRoot: string; marker: string; binDir: string }> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'u1-staged-mode-'))
  const fixturePackRoot = join(fixtureRoot, 'lib')
  const binDir = join(fixtureRoot, 'bin')
  const marker = join(fixtureRoot, 'npm-invoked')
  await mkdir(fixturePackRoot)
  await mkdir(binDir)
  const rootPackage = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { name: string; version: string }
  await writeFile(join(fixturePackRoot, 'package.json'), `${JSON.stringify({
    name: rootPackage.name,
    version: rootPackage.version,
  }, null, 2)}\n`)
  await writeFile(join(fixtureRoot, 'package-receipt.json'), `${JSON.stringify(mode === undefined ? {} : { mode }, null, 2)}\n`)
  const npmPath = join(binDir, 'npm')
  await writeFile(npmPath, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 97\n`)
  await chmod(npmPath, 0o755)
  return { root: fixtureRoot, packRoot: fixturePackRoot, marker, binDir }
}

function sha256Text(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function createInstalledRuntimeFixture(): Promise<{ root: string; manifest: Record<string, unknown> }> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'u1-installed-runtime-'))
  const runtimeRoot = join(fixtureRoot, 'runtime', 'dagpipe')
  const runner = join(runtimeRoot, 'bin', 'darwin-arm64', 'agentteams-dagpipe-runner')
  await mkdir(join(runtimeRoot, 'bin', 'darwin-arm64'), { recursive: true })
  await mkdir(join(runtimeRoot, 'graphs'), { recursive: true })
  const runnerContent = 'runtime-fixture-runner\n'
  await writeFile(runner, runnerContent)
  await chmod(runner, 0o755)
  const graphIds = ['agent-work', 'work-open', 'work-request', 'work-close', 'work-query']
  const graphs = []
  for (const id of graphIds) {
    const content = `${JSON.stringify({ id, version: '1' })}\n`
    await writeFile(join(runtimeRoot, 'graphs', `${id}.graph.json`), content)
    graphs.push({ id, path: `graphs/${id}.graph.json`, sha256: sha256Text(content) })
  }
  const manifest = {
    schemaVersion: 1,
    runner: { path: 'bin/darwin-arm64/agentteams-dagpipe-runner', sha256: sha256Text(runnerContent) },
    graphs,
  }
  await writeFile(join(runtimeRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { root: fixtureRoot, manifest }
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

it('rejects omitted, empty, incomplete, or mispathed installed graph manifests', async () => {
  const fixture = await createInstalledRuntimeFixture()
  try {
    expect(() => verifyInstalledRuntime(fixture.root)).not.toThrow()
    for (const mutate of [
      (manifest: any) => { delete manifest.graphs },
      (manifest: any) => { manifest.graphs = [] },
      (manifest: any) => { manifest.graphs = manifest.graphs.filter((graph: any) => graph.id !== 'work-close') },
    ]) {
      const manifest = structuredClone(fixture.manifest)
      mutate(manifest)
      await writeFile(join(fixture.root, 'runtime', 'dagpipe', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
      expect(() => verifyInstalledRuntime(fixture.root)).toThrow(/installed manifest graph set does not match packaged graphs/u)
    }
    const mispathed = structuredClone(fixture.manifest)
    const graphPath = join(fixture.root, 'runtime', 'dagpipe', 'graphs', 'agent-work.graph.json')
    await copyFile(graphPath, join(fixture.root, 'runtime', 'dagpipe', 'graphs', 'agent-work-copy.graph.json'))
    mispathed.graphs.find((graph: any) => graph.id === 'agent-work').path = 'graphs/agent-work-copy.graph.json'
    await writeFile(join(fixture.root, 'runtime', 'dagpipe', 'manifest.json'), `${JSON.stringify(mispathed, null, 2)}\n`)
    expect(() => verifyInstalledRuntime(fixture.root)).toThrow(/installed graph agent-work path is wrong/u)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

describe('agentteams install package', () => {
  beforeAll(async () => {
    evidenceDir = await mkdtemp(join(tmpdir(), 'u1-package-install-spec-'))
    installedReceiptPath = join(evidenceDir, 'installed-runtime-smoke.receipt.json')
    installedSdkReceiptPath = join(evidenceDir, 'installed-sdk-smoke.receipt.json')
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
    expect(receipt).toMatchObject({ mode: 'base', release_eligible: false, version: rootPackage.version, sdk: { included: false } })

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

    expect(await exists(join(packRoot, 'runtime', 'dagpipe'))).toBe(false)
    expect(await exists(join(packRoot, 'node_modules'))).toBe(false)
  }, 30_000)

  it('passes the public artifact smoke against the staged base pack', async () => {
    await expect(runArtifactSmoke()).resolves.toBeUndefined()
  }, 60_000)

  it('packs and installs the base tarball for public CLI and Console consumers', async () => {
    await execFileAsync(process.execPath, ['scripts/package-artifact.mjs', '--mode', 'base'], {
      cwd: root,
      env: process.env,
      maxBuffer,
    })
    await expect(runPackageUserSmoke()).resolves.toBeUndefined()
  }, 300_000)

  it('records base asset success without claiming installed lifecycle evidence', async () => {
    await runPackageUserSmoke()
    const baseReceipt = await readJson(join(evidenceDir, 'package-user-smoke.receipt.json'))
    expect(baseReceipt).toMatchObject({
      mode: 'base',
      release_eligible: false,
      lifecycle: { status: 'not_run' },
    })
    expect(baseReceipt).not.toHaveProperty('deployment_restart')
  }, 300_000)

  it.each([
    ['missing', undefined, /staged package receipt mode must be base or final, got undefined/u],
    ['unsupported', 'preview', /staged package receipt mode must be base or final, got preview/u],
  ])('rejects %s staged package mode before installed effects', async (_name, mode, message) => {
    const fixture = await createStagedModeFixture(mode)
    try {
      await expect(execFileAsync(process.execPath, [
        'scripts/package-user-smoke.mjs',
        '--pack-root', fixture.packRoot,
        '--receipt-path', join(fixture.packRoot, '..', 'package-user-smoke.receipt.json'),
      ], {
        cwd: root,
        env: { ...process.env, PATH: `${fixture.binDir}:${process.env.PATH}` },
        maxBuffer,
      })).rejects.toMatchObject({ stderr: expect.stringMatching(message) })
      expect(await exists(fixture.marker)).toBe(false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('rejects an unsupported staged mode at the installed lifecycle consumer before installed effects', async () => {
    const fixture = await createStagedModeFixture('preview')
    try {
      await expect(execFileAsync(process.execPath, [
        'scripts/installed-runtime-smoke.mjs',
        '--pack-root', fixture.packRoot,
        '--receipt-path', join(fixture.packRoot, '..', 'installed-runtime-smoke.receipt.json'),
      ], {
        cwd: root,
        env: { ...process.env, PATH: `${fixture.binDir}:${process.env.PATH}` },
        maxBuffer,
      })).rejects.toMatchObject({ stderr: expect.stringMatching(/unsupported staged package mode: preview/u) })
      expect(await exists(fixture.marker)).toBe(false)
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  it('produces the final SDK package by default', async () => {
    await execFileAsync(process.execPath, ['scripts/package-artifact.mjs'], { cwd: root, env: process.env, maxBuffer })
    const finalReceipt = await readJson(receiptPath)
    expect(finalReceipt).toMatchObject({ mode: 'final', release_eligible: false, sdk: { included: true } })
    const required = [
      'runtime/dagpipe/bin/darwin-arm64/agentteams-dagpipe-runner',
      'runtime/dagpipe/manifest.json',
      'runtime/dagpipe/graphs/agent-work.graph.json',
      'runtime/dagpipe/graphs/work-open.graph.json',
      'runtime/dagpipe/graphs/work-request.graph.json',
      'runtime/dagpipe/graphs/work-close.graph.json',
      'runtime/dagpipe/graphs/work-query.graph.json',
      'generated/runtime-lib/control-protocol/endpoint-ref.js',
      'generated/runtime-lib/control-protocol/json-value.js',
      'generated/runtime-lib/control-protocol/relay-codec.js',
      'generated/runtime-lib/control-protocol/work-wire.js',
      'generated/runtime-lib/network/work-channel.js',
      'generated/runtime-lib/runtime/agent-work-client.js',
      'generated/runtime-lib/runtime/dagpipe/host.js',
      'generated/runtime-lib/runtime/dagpipe/protocol.js',
    ]
    for (const path of required) expect(await exists(join(packRoot, path)), path).toBe(true)
    const finalFiles = finalReceipt.files as string[]
    for (const path of required) {
      if (path.startsWith('generated/runtime-lib/')) {
        expect(finalFiles, `final package receipt is missing ${path}`).toContain(path)
      }
    }
    await expect(runInstalledSdkSmoke()).resolves.toBeUndefined()
    const receipt = await readJson(installedSdkReceiptPath)
    expect(receipt).toMatchObject({ mode: 'final', release_eligible: false, status: 'passed' })
    expect(receipt.candidate).toEqual(finalReceipt.candidate)
  }, 300_000)

  it('consumes the staged runtime library through the public runtime smoke', async () => {
    const { stdout } = await execFileAsync(process.execPath, ['scripts/runtime-smoke.mjs'], {
      cwd: root,
      env: process.env,
      maxBuffer: 32 * 1024 * 1024,
    })
    expect(stdout).toContain('Packaged runtime smoke passed')
  }, 60_000)

  it('requires real installed start/restart lifecycle evidence', async () => {
    await runInstalledSmoke()

    const installedReceipt = await readJson(installedReceiptPath)
    const stagedReceipt = await readJson(receiptPath)
    expect(stagedReceipt.mode).toBe('final')
    expect(installedReceipt.mode).toBe(stagedReceipt.mode)
    expect(installedReceipt).toMatchObject({
      mode: 'final',
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
})
