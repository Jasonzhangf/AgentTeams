import type {
  ConfigErrorCode,
  ModelMetadata,
  ProviderInstance,
  ProviderModelClient,
  ProviderModelDescriptor,
  ResolvedCredential,
} from './runtime-config.ts'
import { RuntimeConfigError } from './runtime-config.ts'

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576
const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_RETRY_BASE_MS = 250

export interface OpenAIModelCatalogClientOptions {
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
  /** Retry attempts for transient failures, including the first try. Default 3 (first + 2 retries). */
  readonly maxAttempts?: number
  /** Delay between retries; tests inject a no-op or a recorder instead of real timers. */
  readonly sleep?: (milliseconds: number) => Promise<void>
  /** Fetch implementation; tests inject a fake to avoid binding a socket. */
  readonly fetch?: typeof globalThis.fetch
}

/** HTTP statuses whose request may be retried without changing semantics on a new attempt. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

function configError(
  provider: ProviderInstance,
  code: ConfigErrorCode,
  message: string,
  status?: number,
): RuntimeConfigError {
  return new RuntimeConfigError({
    code,
    message,
    ...(status === undefined ? {} : { status }),
    providerInstanceId: provider.id,
  })
}

function option(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new RuntimeConfigError({ code: 'INVALID_INPUT', message: `config: ${label} must be a positive integer` })
  }
  return resolved
}

function statusCode(status: number): ConfigErrorCode {
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'FORBIDDEN'
  if (status === 404) return 'NOT_FOUND'
  if (status >= 500) return 'UPSTREAM_ERROR'
  return 'UNAVAILABLE'
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null
}

function modelEndpoint(provider: ProviderInstance): URL {
  if (provider.protocol !== 'openai-chat' && provider.protocol !== 'openai-responses') {
    throw configError(provider, 'UNSUPPORTED_OPERATION', `config: unsupported model catalog protocol ${provider.protocol}`)
  }
  let endpoint: URL
  try {
    endpoint = new URL(provider.apiBaseUrl)
  } catch {
    throw configError(provider, 'INVALID_INPUT', 'config: provider apiBaseUrl must be a valid URL')
  }
  if ((endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') || endpoint.username.length > 0 || endpoint.password.length > 0) {
    throw configError(provider, 'INVALID_INPUT', 'config: provider apiBaseUrl must be an http(s) URL without embedded credentials')
  }
  if (endpoint.search.length > 0 || endpoint.hash.length > 0) {
    throw configError(provider, 'INVALID_INPUT', 'config: provider apiBaseUrl must not include a query or fragment')
  }
  endpoint.pathname = `${endpoint.pathname.replace(/\/+$/u, '')}/models`
  return endpoint
}

function headersFor(provider: ProviderInstance, credential: ResolvedCredential | undefined): Headers {
  const headers = new Headers({ accept: 'application/json' })
  if (provider.auth.kind !== 'bearer') return headers
  if (credential === undefined || credential.kind !== 'bearer' || credential.value.trim().length === 0) {
    throw configError(provider, 'CREDENTIAL_UNAVAILABLE', 'config: bearer credential is required for model catalog refresh')
  }
  try {
    headers.set('authorization', `Bearer ${credential.value}`)
  } catch {
    throw configError(provider, 'INVALID_INPUT', 'config: bearer credential is not valid for an HTTP header')
  }
  return headers
}

function isAbortError(value: unknown): boolean {
  return isRecord(value) && value.name === 'AbortError'
}

async function readResponseBody(response: Response, provider: ProviderInstance, maxResponseBytes: number): Promise<string> {
  const contentLength = response.headers.get('content-length')
  const declaredLength = contentLength === null ? undefined : Number(contentLength)
  if (declaredLength !== undefined && Number.isFinite(declaredLength) && declaredLength > maxResponseBytes) {
    throw configError(provider, 'RESOURCE_EXHAUSTED', 'config: model catalog response is too large')
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      total += result.value.byteLength
      if (total > maxResponseBytes) {
        try {
          await reader.cancel()
        } catch {
          // The size error is the owning failure even if the transport is already closed.
        }
        throw configError(provider, 'RESOURCE_EXHAUSTED', 'config: model catalog response is too large')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

function stringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? [...value] : undefined
}

function projectMetadata(model: Readonly<Record<string, unknown>>): ModelMetadata {
  const label = typeof model.name === 'string'
    ? model.name
    : typeof model.display_name === 'string'
      ? model.display_name
      : typeof model.label === 'string'
        ? model.label
        : undefined
  const contextWindow = positiveInteger(model.context_window)
  const maxOutputTokens = positiveInteger(model.max_output_tokens)
  const inputModalities = stringArray(model.input_modalities)
  const outputModalities = stringArray(model.output_modalities)
  return {
    ...(label === undefined ? {} : { label }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(typeof model.tools === 'boolean' ? { tools: model.tools } : {}),
    ...(typeof model.streaming === 'boolean' ? { streaming: model.streaming } : {}),
    ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    ...(inputModalities === undefined ? {} : { inputModalities }),
    ...(outputModalities === undefined ? {} : { outputModalities }),
  }
}

function parseDescriptors(body: string, provider: ProviderInstance): readonly ProviderModelDescriptor[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw configError(provider, 'UPSTREAM_ERROR', 'config: model catalog response is not valid JSON')
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw configError(provider, 'UPSTREAM_ERROR', 'config: model catalog response data must be an array')
  }
  const ids = new Set<string>()
  return parsed.data.map((item): ProviderModelDescriptor => {
    if (!isRecord(item) || typeof item.id !== 'string' || item.id.trim().length === 0) {
      throw configError(provider, 'UPSTREAM_ERROR', 'config: model catalog data contains an invalid model')
    }
    if (ids.has(item.id)) throw configError(provider, 'CONFLICT', `config: model catalog contains duplicate model ${item.id}`)
    ids.add(item.id)
    return { modelId: item.id, metadata: projectMetadata(item) }
  })
}

export function createOpenAIModelCatalogClient(options: OpenAIModelCatalogClientOptions = {}): ProviderModelClient {
  const timeoutMs = option(options.timeoutMs, DEFAULT_TIMEOUT_MS, 'model catalog timeoutMs')
  const maxResponseBytes = option(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES, 'model catalog maxResponseBytes')
  const maxAttempts = option(options.maxAttempts, DEFAULT_MAX_ATTEMPTS, 'model catalog maxAttempts')
  const sleep = options.sleep ?? (async (milliseconds: number) => { await new Promise<void>(resolve => setTimeout(resolve, milliseconds)) })
  const fetchImpl = options.fetch ?? globalThis.fetch
  return {
    listModels: async ({ provider, credential }) => {
      const endpoint = modelEndpoint(provider)
      const headers = headersFor(provider, credential)
      if (typeof fetchImpl !== 'function') throw configError(provider, 'UNAVAILABLE', 'config: fetch is unavailable')
      let lastError: unknown
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const result = await attemptListModels(fetchImpl, timeoutMs, endpoint, headers, provider, maxResponseBytes)
        if (result.ok) return result.value
        lastError = result.error
        if (!result.retryable || attempt >= maxAttempts) break
        await sleep(result.retryAfterMs ?? backoffDelayFor(attempt))
      }
      throw lastError instanceof Error ? lastError : configError(provider, 'UNAVAILABLE', 'config: model catalog request failed')
    },
  }
}

type CatalogAttempt =
  | { readonly ok: true; readonly value: readonly ProviderModelDescriptor[] }
  | { readonly ok: false; readonly error: RuntimeConfigError; readonly retryable: boolean; readonly retryAfterMs?: number }

async function attemptListModels(
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
  endpoint: URL,
  headers: Headers,
  provider: ProviderInstance,
  maxResponseBytes: number,
): Promise<CatalogAttempt> {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  let response: Response
  try {
    response = await fetchImpl(endpoint, { method: 'GET', headers, redirect: 'manual', signal: controller.signal })
  } catch (cause) {
    clearTimeout(timer)
    if (cause instanceof RuntimeConfigError) return { ok: false, error: cause, retryable: false }
    const error = controller.signal.aborted || isAbortError(cause)
      ? configError(provider, 'UNAVAILABLE', 'config: model catalog request timed out')
      : configError(provider, 'UNAVAILABLE', 'config: model catalog request failed')
    return { ok: false, error, retryable: true }
  }
  try {
    if (!response.ok) {
      const retryable = RETRYABLE_STATUS.has(response.status)
      const retryAfterMs = retryable ? parseRetryAfter(response.headers.get('retry-after')) : undefined
      const error = configError(provider, statusCode(response.status), `config: model catalog request returned HTTP ${response.status}`, response.status)
      return { ok: false, error, retryable, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
    }
    const body = await readResponseBody(response, provider, maxResponseBytes)
    return { ok: true, value: parseDescriptors(body, provider) }
  } catch (cause) {
    if (cause instanceof RuntimeConfigError) return { ok: false, error: cause, retryable: false }
    return { ok: false, error: configError(provider, 'UNAVAILABLE', 'config: model catalog response failed'), retryable: true }
  } finally {
    clearTimeout(timer)
  }
}

/** Retry-After is delta-seconds or an HTTP-date; anything else falls back to backoff. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : undefined
  const date = Date.parse(value)
  if (Number.isNaN(date)) return undefined
  return Math.max(0, date - Date.now())
}

/**
 * Bounded exponential backoff between attempts: 250ms after the first failure,
 * 500ms after the second. The contract fixes the sequence; a real deployment may
 * read Retry-After from a 429/503 response to cap this, but tests inject `sleep`
 * and `maxAttempts`, so the bound is deterministic here.
 */
function backoffDelayFor(attempt: number): number {
  return Math.min(DEFAULT_RETRY_BASE_MS * 2 ** (attempt - 1), DEFAULT_RETRY_BASE_MS * 2)
}
