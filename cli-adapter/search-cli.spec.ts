import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { FixedProcessResult, FixedProcessRunner, FixedProcessSpec } from './fixed-process.ts'
import { createReadOnlySearchCliAdapter } from './search-cli.ts'

const temporaryDirectories: string[] = []
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function result(stdout: string, exitCode = 0, stderr = ''): FixedProcessResult {
  return { exitCode, signal: null, timedOut: false, stdout, stderr }
}

function scriptedRunner(resultValue: FixedProcessResult): { readonly calls: FixedProcessSpec[]; readonly runner: FixedProcessRunner } {
  const calls: FixedProcessSpec[] = []
  return { calls, runner: async spec => { calls.push(spec); return resultValue } }
}

function rootDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'teams-b1-search-'))
  temporaryDirectories.push(directory)
  return directory
}

const matchLine = (path: string, line: number, text: string) => JSON.stringify({
  type: 'match',
  data: { path: { text: path }, lines: { text }, line_number: line, submatches: [] },
})

describe('fixed-root read-only search CLI adapter', () => {
  it('passes a fixed rg argv, disables rg config injection, and preserves matches', async () => {
    const root = rootDirectory()
    mkdirSync(join(root, 'docs'))
    writeFileSync(join(root, 'docs/readme.md'), 'browser CLI\n', 'utf8')
    const scripted = scriptedRunner(result(`${matchLine('docs/readme.md', 4, 'browser CLI\n')}\n`))
    const adapter = createReadOnlySearchCliAdapter({ root, executable: '/opt/homebrew/bin/rg', runner: scripted.runner })

    const found = await adapter.search({ operation: 'search', query: 'browser CLI', maxResults: 7 })

    expect(found).toMatchObject({ query: 'browser CLI', status: 'matched', exitCode: 0 })
    expect(found.matches[0]).toMatchObject({ path: 'docs/readme.md', line: 4, text: 'browser CLI\n' })
    expect(scripted.calls).toHaveLength(1)
    expect(scripted.calls[0]).toMatchObject({
      executable: '/opt/homebrew/bin/rg',
      cwd: realpathSync(root),
      shell: false,
      env: { RIPGREP_CONFIG_PATH: '/dev/null' },
    })
    expect(scripted.calls[0]?.argv).toEqual([
      '--json', '--fixed-strings', '--no-follow', '--color', 'never', '--max-count', '7', '--', 'browser CLI', '.',
    ])
  })

  it('reports ripgrep no-match as an explicit non-success result', async () => {
    const scripted = scriptedRunner(result('', 1))
    const adapter = createReadOnlySearchCliAdapter({ root: rootDirectory(), executable: '/opt/homebrew/bin/rg', runner: scripted.runner })
    await expect(adapter.search({ operation: 'search', query: 'missing' })).resolves.toMatchObject({ status: 'no_match', exitCode: 1, matches: [] })
  })

  it('propagates other nonzero exits instead of returning an empty success', async () => {
    const scripted = scriptedRunner(result('partial', 2, 'permission denied'))
    const adapter = createReadOnlySearchCliAdapter({ root: rootDirectory(), executable: '/opt/homebrew/bin/rg', runner: scripted.runner })
    await expect(adapter.search({ operation: 'search', query: 'secret' })).rejects.toMatchObject({
      error: { code: 'PROCESS_ERROR', exitCode: 2, stdout: 'partial', stderr: 'permission denied' },
    })
  })

  it('rejects a result whose real path escapes the configured root through a symlink', async () => {
    const root = rootDirectory()
    const outside = rootDirectory()
    mkdirSync(join(outside, 'nested'))
    symlinkSync(outside, join(root, 'escape'), 'dir')
    const scripted = scriptedRunner(result(`${matchLine('escape/nested/secret.txt', 1, 'secret\n')}\n`))
    const adapter = createReadOnlySearchCliAdapter({ root, executable: '/opt/homebrew/bin/rg', runner: scripted.runner })
    await expect(adapter.search({ operation: 'search', query: 'secret' })).rejects.toMatchObject({ error: { code: 'BOUNDARY_VIOLATION' } })
  })

  it('rejects a symlink as the configured root', () => {
    const root = rootDirectory()
    const target = rootDirectory()
    const link = join(root, 'root-link')
    symlinkSync(target, link, 'dir')
    expect(() => createReadOnlySearchCliAdapter({ root: link, executable: '/opt/homebrew/bin/rg' })).toThrowError(/BOUNDARY_VIOLATION/)
  })
})
