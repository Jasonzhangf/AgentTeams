import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  assertProcessSucceeded,
  runFixedProcess,
  type FixedProcessRunner,
  type FixedProcessSpec,
  type FixedProcessResult,
} from './fixed-process.ts'
import { CliAdapterError, type SearchRequest, type SearchResult, type SearchMatch } from './contracts.ts'
import type { JsonValue } from '../control-protocol/agent-services.ts'

const defaultMaxResults = 100
const maximumResults = 1_000

export interface ReadOnlySearchCliOptions {
  readonly root: string
  readonly executable: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly runner?: FixedProcessRunner
}

export interface ReadOnlySearchCliAdapter {
  search(request: SearchRequest): Promise<SearchResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, path: string, code: 'INVALID_INPUT' | 'PROTOCOL_ERROR' = 'PROTOCOL_ERROR'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliAdapterError({ code, message: `${path} must be a non-empty string` })
  }
  return value
}

function positiveInteger(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > maximumResults) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: `${path} must be an integer from 1 to ${maximumResults}` })
  }
  return value
}

function ensureRoot(root: string): string {
  if (!isAbsolute(root)) {
    throw new CliAdapterError({ code: 'BOUNDARY_VIOLATION', message: 'search root must be an absolute path' })
  }
  let rootStat
  try {
    rootStat = lstatSync(root)
  } catch (error) {
    throw new CliAdapterError({ code: 'BOUNDARY_VIOLATION', message: `search root cannot be inspected: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new CliAdapterError({ code: 'BOUNDARY_VIOLATION', message: 'search root must be a real directory, not a symlink' })
  }
  try {
    return realpathSync(root)
  } catch (error) {
    throw new CliAdapterError({ code: 'BOUNDARY_VIOLATION', message: `search root cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}` })
  }
}

function insideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate)
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
}

function validateMatchPath(root: string, pathText: string): void {
  if (pathText.includes('\u0000')) {
    throw new CliAdapterError({ code: 'BOUNDARY_VIOLATION', message: 'search result path contains a NUL byte' })
  }
  const candidate = resolve(root, pathText)
  let canonicalCandidate: string
  try {
    canonicalCandidate = realpathSync(candidate)
  } catch (error) {
    throw new CliAdapterError({ code: 'BOUNDARY_VIOLATION', message: `search result path cannot be canonicalized: ${error instanceof Error ? error.message : String(error)}` })
  }
  if (!insideRoot(root, canonicalCandidate)) {
    throw new CliAdapterError({ code: 'BOUNDARY_VIOLATION', message: `search result escaped configured root: ${pathText}` })
  }
}

function parseMatches(root: string, stdout: string): SearchMatch[] {
  const matches: SearchMatch[] = []
  for (const [index, line] of stdout.split('\n').entries()) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `rg output line ${index + 1} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`, stdout })
    }
    if (!isRecord(parsed)) {
      throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `rg output line ${index + 1} is not an object`, stdout })
    }
    const type = parsed.type
    if (type === 'begin' || type === 'end' || type === 'summary') continue
    if (type !== 'match' || !isRecord(parsed.data)) {
      throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `rg output line ${index + 1} has an unsupported record type`, stdout })
    }
    const data = parsed.data
    if (!isRecord(data.path) || !isRecord(data.lines)) {
      throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `rg match line ${index + 1} is missing path or lines`, stdout })
    }
    const pathText = requiredString(data.path.text, `rg match line ${index + 1}.path.text`)
    validateMatchPath(root, pathText)
    if (typeof data.line_number !== 'number' || !Number.isInteger(data.line_number) || data.line_number < 1) {
      throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `rg match line ${index + 1} has an invalid line number`, stdout })
    }
    if (typeof data.lines.text !== 'string') {
      throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `rg match line ${index + 1} has invalid line text`, stdout })
    }
    matches.push({
      path: pathText,
      line: data.line_number,
      text: data.lines.text,
      raw: parsed as JsonValue,
    })
  }
  return matches
}

function processFailure(spec: FixedProcessSpec, output: FixedProcessResult): void {
  if (output.exitCode === 1 && !output.timedOut && !output.outputLimitExceeded) return
  assertProcessSucceeded(spec, output)
}

export function createReadOnlySearchCliAdapter(options: ReadOnlySearchCliOptions): ReadOnlySearchCliAdapter {
  if (!isAbsolute(options.executable)) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'search executable must be an absolute path' })
  }
  const root = ensureRoot(options.root)
  const runner = options.runner ?? runFixedProcess

  return {
    async search(request) {
      if (request.operation !== 'search') {
        throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'search received the wrong operation' })
      }
      const query = requiredString(request.query, 'query', 'INVALID_INPUT')
      if (query.includes('\u0000')) {
        throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'query contains a NUL byte' })
      }
      const maxResults = request.maxResults === undefined ? defaultMaxResults : positiveInteger(request.maxResults, 'maxResults')
      const spec: FixedProcessSpec = {
        executable: options.executable,
        argv: ['--json', '--fixed-strings', '--no-follow', '--color', 'never', '--max-count', String(maxResults), '--', query, '.'],
        cwd: root,
        env: { ...process.env, RIPGREP_CONFIG_PATH: '/dev/null' },
        shell: false,
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
      }
      const output = await runner(spec)
      processFailure(spec, output)
      if (output.exitCode !== 0 && output.exitCode !== 1) {
        throw new CliAdapterError({ code: 'PROCESS_ERROR', message: 'search exited without a supported status', exitCode: output.exitCode, signal: output.signal, stdout: output.stdout, stderr: output.stderr })
      }
      const matches = parseMatches(root, output.stdout)
      return {
        query,
        status: output.exitCode === 1 ? 'no_match' : 'matched',
        exitCode: output.exitCode,
        matches: matches.slice(0, maxResults),
        truncated: matches.length > maxResults,
        stdout: output.stdout,
        stderr: output.stderr,
      }
    },
  }
}
