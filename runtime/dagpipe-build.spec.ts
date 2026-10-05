import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const repoRoot = resolve(import.meta.dirname, '..')
const buildParent = join(repoRoot, 'runtime', 'dagpipe', '.build')
const buildEntry = join(repoRoot, 'runtime', 'dagpipe', 'build.mjs')
const graphPaths = {
  agent_work: join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'agent-work.graph.json'),
  work_open: join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-open.graph.json'),
  work_request: join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-request.graph.json'),
  work_close: join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-close.graph.json'),
  work_query: join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-query.graph.json'),
}
const expectedEffects = [
  'agent.work.close',
  'agent.work.get',
  'agent.work.propose',
  'agent.work.request',
  'directory.read',
  'network.close',
  'network.connect',
]
const ownedBuildRoots = new Set<string>()
const consumerDirectory = mkdtempSync(join(tmpdir(), 'dagpipe-build-consumers-'))

interface BuildResult {
  readonly receiptPath: string
  readonly runnerPath: string
  readonly receipt: Record<string, any>
}

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex')
}

function hashFile(path: string): string {
  return sha256(readFileSync(path))
}

function relativeToRepo(path: string): string {
  return relative(repoRoot, path).split('\\').join('/')
}

function cargoHostTarget(): string {
  const version = execFileSync('rustc', ['-vV'], { cwd: repoRoot, encoding: 'utf8' })
  const match = /^host: (.+)$/m.exec(version)
  if (!match) throw new Error('rustc -vV did not report a host target')
  return match[1].trim()
}

function parseFinalFrame(stdout: string): Record<string, any> {
  const lines = stdout.trim().split('\n').filter(Boolean)
  return JSON.parse(lines[lines.length - 1]) as Record<string, any>
}

function runBuildConsumer(index: number, resultPath: string): Promise<BuildResult> {
  const script = `
    import { writeFile } from 'node:fs/promises'
    import { buildRunner } from ${JSON.stringify(pathToFileURL(buildEntry).href)}
    const built = await buildRunner()
    await writeFile(process.env.DAGPIPE_BUILD_RESULT, JSON.stringify(built))
  `
  return new Promise((resolveBuild, rejectBuild) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: repoRoot,
      env: {
        ...process.env,
        DAGPIPE_BUILD_RESULT: resultPath,
        DAGPIPE_BUILD_CONSUMER: String(index),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    child.on('error', rejectBuild)
    child.on('close', (code, signal) => {
      if (code !== 0) {
        rejectBuild(new Error(
          `build consumer ${index} failed: code=${code} signal=${signal}\n${stdout}${stderr}`,
        ))
        return
      }
      try {
        resolveBuild(JSON.parse(readFileSync(resultPath, 'utf8')) as BuildResult)
      } catch (error) {
        rejectBuild(error)
      }
    })
  })
}

function verifyReceipt(result: BuildResult): void {
  const { receipt, receiptPath, runnerPath } = result
  expect(receipt.protocol).toBe('teams-dagpipe-runner-build-receipt')
  expect(receipt.version).toBe(2)
  expect(receiptPath).toBe(join(dirname(runnerPath), '..', '..', '..', 'build-receipt.json'))
  expect(relativeToRepo(receiptPath)).toMatch(
    /^runtime\/dagpipe\/\.build\/(?!current$)[^/]+\/build-receipt\.json$/,
  )
  expect(relativeToRepo(runnerPath)).toMatch(
    /^runtime\/dagpipe\/\.build\/(?!current$)[^/]+\/target\/[^/]+\/debug\/teams-dagpipe-runner$/,
  )
  const buildRoot = dirname(receiptPath)
  expect(runnerPath).toBe(join(buildRoot, 'target', cargoHostTarget(), 'debug', 'teams-dagpipe-runner'))
  expect(runnerPath).not.toContain('/.build/current/')
  expect(hashFile(runnerPath)).toBe(receipt.artifact.sha256)
  expect(statSync(runnerPath).size).toBe(receipt.artifact.size)
  expect(receipt.artifact.path).toBe(relativeToRepo(runnerPath))

  expect(receipt.inputs.build_entry).toEqual({
    path: 'runtime/dagpipe/build.mjs',
    sha256: hashFile(buildEntry),
  })
  const runnerSource = join(repoRoot, 'runtime', 'dagpipe', 'runner', 'src', 'bin', 'runner.rs')
  expect(receipt.inputs.runner_source).toEqual({
    path: 'runtime/dagpipe/runner/src/bin/runner.rs',
    sha256: hashFile(runnerSource),
  })
  const templatePath = join(repoRoot, 'runtime', 'dagpipe', 'runner', 'Cargo.toml.template')
  const lockPath = join(repoRoot, 'runtime', 'dagpipe', 'runner', 'Cargo.lock')
  expect(receipt.inputs.build_template).toEqual({
    path: 'runtime/dagpipe/runner/Cargo.toml.template',
    sha256: hashFile(templatePath),
  })
  expect(receipt.inputs.lock).toEqual({
    path: 'runtime/dagpipe/runner/Cargo.lock',
    sha256: hashFile(lockPath),
  })

  expect(receipt.generated.manifest).toEqual({
    path: 'Cargo.toml',
    sha256: hashFile(join(buildRoot, 'Cargo.toml')),
  })
  expect(receipt.generated.lock).toEqual({
    path: 'Cargo.lock',
    sha256: hashFile(join(buildRoot, 'Cargo.lock')),
  })
  expect(hashFile(join(buildRoot, 'Cargo.lock'))).toBe(hashFile(lockPath))

  const sdkPath = execFileSync('dagpipe', ['sdk', 'path'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim()
  expect(receipt.sdk.crate).toBe('pipeline_runtime')
  expect(receipt.sdk.path).toBe(execFileSync('realpath', [sdkPath], { encoding: 'utf8' }).trim())
  expect(receipt.sdk.manifest).toEqual({
    path: 'Cargo.toml',
    sha256: hashFile(join(receipt.sdk.path, 'Cargo.toml')),
  })

  const graphs = Object.fromEntries(Object.entries(graphPaths).map(([name, path]) => [
    name,
    { path: relativeToRepo(path), sha256: hashFile(path) },
  ]))
  expect(receipt.graphs).toEqual(graphs)
  const operators = [...new Set(Object.values(graphPaths).flatMap(path => (
    (JSON.parse(readFileSync(path, 'utf8')) as { nodes: { operator: string; operator_version: string }[] })
      .nodes.map(node => `${node.operator}@${node.operator_version}`)
  )))].sort()
  expect(receipt.registry).toEqual({ operators, effects: expectedEffects })

  const compileFrame = parseFinalFrame(execFileSync(runnerPath, [
    'compile',
    '--graph',
    graphPaths.agent_work,
  ], { cwd: repoRoot, encoding: 'utf8' }))
  expect(compileFrame).toMatchObject({
    type: 'compile.result',
    graph_id: 'agentteams.agent-work',
    graph_version: '2',
  })
  expect(compileFrame.capabilities).toEqual(expectedEffects)
  expect(hashFile(runnerPath)).toBe(receipt.artifact.sha256)
}

afterAll(() => {
  rmSync(consumerDirectory, { recursive: true, force: true })
  for (const buildRoot of ownedBuildRoots) {
    rmSync(buildRoot, { recursive: true, force: true })
  }
})

describe('DAGpipe runner build isolation', () => {
  it('keeps two concurrent native build consumers immutable and usable', async () => {
    const consumers = await Promise.all([0, 1].map(index => runBuildConsumer(
      index,
      join(consumerDirectory, `result-${index}.json`),
    )))
    for (const result of consumers) {
      ownedBuildRoots.add(dirname(result.receiptPath))
    }

    expect(consumers[0].runnerPath).not.toBe(consumers[1].runnerPath)
    expect(consumers[0].receiptPath).not.toBe(consumers[1].receiptPath)
    expect(consumers[0].runnerPath).not.toBe(consumers[1].receiptPath)
    expect(consumers[0].receiptPath).not.toBe(consumers[1].runnerPath)
    for (const result of consumers) {
      expect(dirname(result.receiptPath).startsWith(buildParent)).toBe(true)
      verifyReceipt(result)
    }
    expect(dirname(consumers[0].receiptPath)).not.toBe(dirname(consumers[1].receiptPath))
  }, 300_000)
})
