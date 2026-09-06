import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import {
  assertProcessSucceeded,
  runFixedProcess,
  type FixedProcessRunner,
  type FixedProcessSpec,
} from './fixed-process.ts'
import {
  CliAdapterError,
  type BrowserContext,
  type ContextCreateRequest,
  type ContextCreateResult,
  type ContextDestroyRequest,
  type ContextDestroyResult,
  type NavigateRequest,
  type NavigateResult,
  type SnapshotRequest,
  type SnapshotResult,
} from './contracts.ts'
import type { JsonValue } from '../control-protocol/agent-services.ts'

const profilePattern = /^[A-Za-z0-9._-]+$/

export interface BrowserCliAdapterOptions {
  readonly executable: string
  readonly profile: string
  readonly headless?: boolean
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly runner?: FixedProcessRunner
}

export interface BrowserCliAdapter {
  contextCreate(request: ContextCreateRequest): Promise<ContextCreateResult>
  navigate(request: NavigateRequest): Promise<NavigateResult>
  snapshot(request: SnapshotRequest): Promise<SnapshotResult>
  contextDestroy(request: ContextDestroyRequest): Promise<ContextDestroyResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `${path} must be a non-empty string` })
  }
  return value
}

function validUrl(value: unknown, path: string): string {
  const url = requiredString(value, path)
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: `${path} must be an absolute HTTP(S) URL` })
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: `${path} must be an absolute HTTP(S) URL` })
  }
  return url
}

function jsonObject(stdout: string, command: string): { readonly raw: JsonValue; readonly object: Record<string, unknown> } {
  if (stdout.trim().length === 0) {
    throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `${command} returned empty stdout` })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch (error) {
    throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`, stdout })
  }
  if (!isRecord(parsed)) {
    throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `${command} returned a non-object JSON value`, stdout })
  }
  return { raw: parsed as JsonValue, object: parsed }
}

function validateOptions(options: BrowserCliAdapterOptions): void {
  if (!isAbsolute(options.executable)) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'browser executable must be an absolute path' })
  }
  if (!profilePattern.test(options.profile)) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'browser profile contains unsupported characters' })
  }
}

function validateContextId(contextId: unknown): string {
  return requiredString(contextId, 'contextId')
}

type BrowserContextState =
  | { readonly status: 'pending' | 'uncertain'; readonly contextId: string; readonly profile: string }
  | { readonly status: 'active'; readonly context: BrowserContext }

function stateContextId(state: BrowserContextState): string {
  return state.status === 'active' ? state.context.contextId : state.contextId
}

function stateProfile(state: BrowserContextState): string {
  return state.status === 'active' ? state.context.profile : state.profile
}

function contextConflict(state: BrowserContextState): CliAdapterError {
  const contextId = stateContextId(state)
  return new CliAdapterError({
    code: 'CONFLICT',
    message: `browser profile ${stateProfile(state)} already has context ${contextId}`,
    contextId,
  })
}

function activeContextMatches(state: BrowserContextState | undefined, contextId: string): BrowserContext {
  if (state === undefined || stateContextId(state) !== contextId) {
    throw new CliAdapterError({ code: 'NOT_FOUND', message: `unknown browser context ${contextId}` })
  }
  if (state.status !== 'active') {
    throw new CliAdapterError({
      code: 'CONFLICT',
      message: `browser context ${contextId} is not confirmed; destroy it before reuse`,
      contextId,
    })
  }
  return state.context
}

function destroyableContext(state: BrowserContextState | undefined, contextId: string): { readonly contextId: string; readonly profile: string } {
  if (state === undefined || stateContextId(state) !== contextId) {
    throw new CliAdapterError({ code: 'NOT_FOUND', message: `unknown browser context ${contextId}` })
  }
  return { contextId, profile: stateProfile(state) }
}

function withRecoveryContext(error: unknown, contextId: string): never {
  if (error instanceof CliAdapterError) {
    throw new CliAdapterError({ ...error.error, contextId })
  }
  throw new CliAdapterError({
    code: 'UNAVAILABLE',
    message: error instanceof Error ? error.message : String(error),
    contextId,
  })
}

export function createBrowserCliAdapter(options: BrowserCliAdapterOptions): BrowserCliAdapter {
  validateOptions(options)
  const headless = options.headless ?? true
  const runner = options.runner ?? runFixedProcess
  let contextState: BrowserContextState | undefined
  let profileOperationTail = Promise.resolve()
  const withProfileLock = <T>(operation: () => Promise<T>): Promise<T> => {
    const predecessor = profileOperationTail
    let release!: () => void
    profileOperationTail = new Promise<void>(resolve => {
      release = resolve
    })
    return predecessor.then(operation).finally(() => release())
  }

  const run = async (argv: readonly string[]): Promise<{ readonly raw: JsonValue; readonly object: Record<string, unknown> }> => {
    const spec: FixedProcessSpec = {
      executable: options.executable,
      argv,
      shell: false,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    }
    const output = await runner(spec)
    assertProcessSucceeded(spec, output)
    return jsonObject(output.stdout, argv[0] ?? 'browser command')
  }

  return {
    async contextCreate(request) {
      return withProfileLock(async () => {
        if (request.operation !== 'context.create') {
          throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'contextCreate received the wrong operation' })
        }
        if (contextState !== undefined) throw contextConflict(contextState)
        const initialUrl = request.initialUrl === undefined ? undefined : validUrl(request.initialUrl, 'initialUrl')
        const contextId = `browser-context-${randomUUID()}`
        contextState = { status: 'pending', contextId, profile: options.profile }
        try {
          await run(['daemon', 'start', '--profile', options.profile])
          const argv = ['start', '--profile', options.profile]
          if (initialUrl !== undefined) argv.push('--url', initialUrl)
          if (headless) argv.push('--headless')
          const started = await run(argv)
          const sessionId = requiredString(started.object.sessionId, 'start.sessionId')
          const profile = requiredString(started.object.profile, 'start.profile')
          if (profile !== options.profile) {
            throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: `start returned profile ${profile}, expected ${options.profile}` })
          }
          if (typeof started.object.headless === 'boolean' && started.object.headless !== headless) {
            throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: 'start returned an unexpected headless mode' })
          }
          const context: BrowserContext = { contextId, profile, sessionId }
          contextState = { status: 'active', context }
          return { ...context, raw: started.raw }
        } catch (error) {
          contextState = { status: 'uncertain', contextId, profile: options.profile }
          withRecoveryContext(error, contextId)
        }
      })
    },

    async navigate(request) {
      return withProfileLock(async () => {
        if (request.operation !== 'navigate') {
          throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'navigate received the wrong operation' })
        }
        const current = activeContextMatches(contextState, validateContextId(request.contextId))
        const url = validUrl(request.url, 'url')
        const navigated = await run(['goto', url, '--profile', current.profile, '--waitUntil', 'domcontentloaded'])
        if (navigated.object.profile !== current.profile || navigated.object.navigated !== true) {
          throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: 'goto did not confirm navigation', stdout: JSON.stringify(navigated.raw) })
        }
        const returnedUrl = requiredString(navigated.object.url, 'goto.url')
        return { contextId: current.contextId, url: returnedUrl, navigated: true, raw: navigated.raw }
      })
    },

    async snapshot(request) {
      return withProfileLock(async () => {
        if (request.operation !== 'snapshot') {
          throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'snapshot received the wrong operation' })
        }
        const current = activeContextMatches(contextState, validateContextId(request.contextId))
        const snapshot = await run(['snapshot', '--format', 'json', '--profile', current.profile])
        if (snapshot.object.profile !== current.profile || !isRecord(snapshot.object.data)) {
          throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: 'snapshot did not return the requested profile' })
        }
        const url = requiredString(snapshot.object.data.url, 'snapshot.data.url')
        const html = requiredString(snapshot.object.data.html, 'snapshot.data.html')
        return { contextId: current.contextId, url, html, raw: snapshot.raw }
      })
    },

    async contextDestroy(request) {
      return withProfileLock(async () => {
        if (request.operation !== 'context.destroy') {
          throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'contextDestroy received the wrong operation' })
        }
        const current = destroyableContext(contextState, validateContextId(request.contextId))
        const stopped = await run(['stop', '--profile', current.profile])
        if (stopped.object.profile !== current.profile || stopped.object.state !== 'stopped') {
          throw new CliAdapterError({ code: 'PROTOCOL_ERROR', message: 'stop did not confirm browser context destruction', stdout: JSON.stringify(stopped.raw) })
        }
        contextState = undefined
        return { contextId: current.contextId, profile: current.profile, state: 'stopped', raw: stopped.raw }
      })
    },
  }
}
