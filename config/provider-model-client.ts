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

export interface OpenAIModelCatalogClientOptions {
  readonly timeoutMs?: number
  readonly maxResponseBytes?: number
}

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
  return {
    listModels: async ({ provider, credential }) => {
      const endpoint = modelEndpoint(provider)
      const headers = headersFor(provider, credential)
      if (typeof globalThis.fetch !== 'function') throw configError(provider, 'UNAVAILABLE', 'config: fetch is unavailable')
      const controller = new AbortController()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      try {
        const response = await globalThis.fetch(endpoint, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: controller.signal,
        })
        if (!response.ok) {
          throw configError(provider, statusCode(response.status), `config: model catalog request returned HTTP ${response.status}`, response.status)
        }
        const body = await readResponseBody(response, provider, maxResponseBytes)
        return parseDescriptors(body, provider)
      } catch (cause) {
        controller.abort()
        if (cause instanceof RuntimeConfigError) throw cause
        if (timedOut || isAbortError(cause)) throw configError(provider, 'UNAVAILABLE', 'config: model catalog request timed out')
        throw configError(provider, 'UNAVAILABLE', 'config: model catalog request failed')
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
