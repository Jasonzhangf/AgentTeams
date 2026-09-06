import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
import { createBrowserCliAdapter, type BrowserCliAdapter } from './browser-cli.ts'
import { asAdapterError, CliAdapterError, type AdapterResult, type CliRequest } from './contracts.ts'
import { createReadOnlySearchCliAdapter, type ReadOnlySearchCliAdapter } from './search-cli.ts'

const defaultCamoExecutable = '/opt/homebrew/bin/camo'
const defaultSearchExecutable = '/opt/homebrew/bin/rg'

export interface CliStartupOptions {
  readonly camoExecutable: string
  readonly searchExecutable: string
  readonly profile: string
  readonly searchRoot: string
  readonly headless: boolean
}

export interface CliRuntime {
  readonly browser: BrowserCliAdapter
  readonly search: ReadOnlySearchCliAdapter
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: `${path} must be a non-empty string` })
  }
  return value
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new CliAdapterError({ code: 'INVALID_INPUT', message: `${path} has unsupported field ${key}` })
    }
  }
}

function nextArgument(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: `${flag} requires a value` })
  }
  return value
}

export function parseStartupOptions(argv: readonly string[]): CliStartupOptions {
  let camoExecutable = defaultCamoExecutable
  let searchExecutable = defaultSearchExecutable
  let profile: string | undefined
  let searchRoot: string | undefined
  let headless = true

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--camo-executable') {
      camoExecutable = nextArgument(argv, index, argument)
      index += 1
    } else if (argument === '--search-executable') {
      searchExecutable = nextArgument(argv, index, argument)
      index += 1
    } else if (argument === '--profile') {
      profile = nextArgument(argv, index, argument)
      index += 1
    } else if (argument === '--search-root') {
      searchRoot = nextArgument(argv, index, argument)
      index += 1
    } else if (argument === '--headless') {
      headless = true
    } else {
      throw new CliAdapterError({ code: 'INVALID_INPUT', message: `unsupported startup argument ${argument}` })
    }
  }

  return {
    camoExecutable,
    searchExecutable,
    profile: requiredString(profile, 'profile'),
    searchRoot: requiredString(searchRoot, 'searchRoot'),
    headless,
  }
}

export function parseCliRequest(value: unknown): CliRequest {
  if (!isRecord(value)) throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'request must be an object' })
  const operation = requiredString(value.operation, 'operation')
  if (operation === 'context.create') {
    assertKeys(value, ['operation', 'initialUrl'], 'context.create')
    if (value.initialUrl !== undefined && typeof value.initialUrl !== 'string') {
      throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'context.create.initialUrl must be a string' })
    }
    return { operation, ...(value.initialUrl === undefined ? {} : { initialUrl: value.initialUrl }) }
  }
  if (operation === 'navigate') {
    assertKeys(value, ['operation', 'contextId', 'url'], 'navigate')
    return { operation, contextId: requiredString(value.contextId, 'contextId'), url: requiredString(value.url, 'url') }
  }
  if (operation === 'snapshot' || operation === 'context.destroy') {
    assertKeys(value, ['operation', 'contextId'], operation)
    return { operation, contextId: requiredString(value.contextId, 'contextId') }
  }
  if (operation === 'search') {
    assertKeys(value, ['operation', 'query', 'maxResults'], 'search')
    if (value.maxResults !== undefined && (typeof value.maxResults !== 'number' || !Number.isInteger(value.maxResults))) {
      throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'search.maxResults must be an integer' })
    }
    return {
      operation,
      query: requiredString(value.query, 'query'),
      ...(value.maxResults === undefined ? {} : { maxResults: value.maxResults }),
    }
  }
  throw new CliAdapterError({ code: 'INVALID_INPUT', message: `unsupported operation ${operation}` })
}

export function parseJsonRequestLine(line: string): CliRequest {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch (error) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: `request line is invalid JSON: ${error instanceof Error ? error.message : String(error)}` })
  }
  return parseCliRequest(value)
}

export function createCliRuntime(options: CliStartupOptions): CliRuntime {
  return {
    browser: createBrowserCliAdapter({ executable: options.camoExecutable, profile: options.profile, headless: options.headless }),
    search: createReadOnlySearchCliAdapter({ root: options.searchRoot, executable: options.searchExecutable }),
  }
}

export async function dispatchCliRequest(runtime: CliRuntime, request: CliRequest): Promise<AdapterResult> {
  if (request.operation === 'context.create') return runtime.browser.contextCreate(request)
  if (request.operation === 'navigate') return runtime.browser.navigate(request)
  if (request.operation === 'snapshot') return runtime.browser.snapshot(request)
  if (request.operation === 'context.destroy') return runtime.browser.contextDestroy(request)
  return runtime.search.search(request)
}

export async function runCli(argv: readonly string[], input: NodeJS.ReadableStream, output: NodeJS.WritableStream): Promise<void> {
  const runtime = createCliRuntime(parseStartupOptions(argv))
  const lines = createInterface({ input, crlfDelay: Infinity })
  for await (const line of lines) {
    if (line.trim().length === 0) continue
    let request: CliRequest | undefined
    try {
      request = parseJsonRequestLine(line)
      const result = await dispatchCliRequest(runtime, request)
      output.write(`${JSON.stringify({ ok: true, operation: request.operation, result })}\n`)
    } catch (error) {
      const serialized = asAdapterError(error)
      output.write(`${JSON.stringify({ ok: false, ...(request === undefined ? {} : { operation: request.operation }), error: serialized })}\n`)
    }
  }
}

async function main(): Promise<void> {
  await runCli(process.argv.slice(2), process.stdin, process.stdout)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    process.stderr.write(`${JSON.stringify(asAdapterError(error))}\n`)
    process.exitCode = 1
  })
}
