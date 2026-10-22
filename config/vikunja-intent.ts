import type { ConfigErrorCode } from './runtime-config.ts'

/**
 * Compiler for the optional `[vikunja]` config section (design amendment A5).
 *
 * One parser owns the section. It validates only the fields it declares, so a
 * missing section returns `undefined` without touching the rest of a config
 * file, and an unknown key inside the section fails explicitly instead of being
 * ignored. Secrets never enter the intent: `tokenRef` and `webhookSecretRef`
 * accept only the `env:NAME` and `file:PATH` reference forms, never an inline
 * value. The compiled intent is frozen because Config hands it to Runtime as an
 * accepted snapshot, not as a mutable draft.
 */
export interface VikunjaIntent {
  readonly baseUrl: string
  readonly tokenRef: string
  readonly projectId?: string
  readonly webhookSecretRef?: string
}

/** Intent errors reuse the canonical config error vocabulary. */
export type VikunjaIntentErrorCode = ConfigErrorCode

export class VikunjaIntentError extends Error {
  readonly code: VikunjaIntentErrorCode

  constructor(code: VikunjaIntentErrorCode, message: string) {
    super(message)
    this.name = 'VikunjaIntentError'
    this.code = code
  }
}

const SECTION_FIELDS = ['baseUrl', 'tokenRef', 'projectId', 'webhookSecretRef'] as const
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function fail(code: VikunjaIntentErrorCode, message: string): never {
  throw new VikunjaIntentError(code, message)
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('INVALID_INPUT', `${label} must be a table`)
  }
  return value as Record<string, unknown>
}

function fields(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key))
  if (unknown.length > 0) fail('INVALID_INPUT', `${label} has unsupported fields: ${unknown.join(', ')}`)
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('INVALID_INPUT', `${label} must be a non-empty string`)
  }
  return value
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : requiredString(value, label)
}

/**
 * A Vikunja endpoint is an API base: http(s) only, no embedded account
 * credentials, and no query or fragment that the request path would drop.
 */
function httpBaseUrl(value: unknown, label: string): string {
  const raw = requiredString(value, label)
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    fail('INVALID_INPUT', `${label} must be a valid http(s) URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail('INVALID_INPUT', `${label} must use http or https`)
  }
  if (url.username.length > 0 || url.password.length > 0) {
    fail('INVALID_INPUT', `${label} must not embed account credentials`)
  }
  if (url.hash.length > 0) fail('INVALID_INPUT', `${label} must not include a fragment`)
  if (url.search.length > 0) fail('INVALID_INPUT', `${label} must not include a query`)
  return raw
}

/** Only reference forms are accepted; the value of the secret stays outside Config. */
function secretRef(value: unknown, label: string): string {
  const ref = requiredString(value, label)
  if (ref.startsWith('env:')) {
    if (!ENV_NAME.test(ref.slice('env:'.length))) {
      fail('INVALID_INPUT', `${label} must use env:NAME with a valid environment-variable name`)
    }
    return ref
  }
  if (ref.startsWith('file:')) {
    if (ref.length === 'file:'.length) fail('INVALID_INPUT', `${label} must name a file`)
    return ref
  }
  fail('INVALID_INPUT', `${label} must use env:NAME or file:PATH; an inline secret value is not accepted`)
}

/**
 * Parse the decoded `[vikunja]` table into the frozen intent.
 *
 * Pass `undefined` when the config file has no `[vikunja]` table: absence is a
 * valid state, not an error, and no other config section is read or changed.
 */
export function parseVikunjaIntent(value: unknown): VikunjaIntent | undefined {
  if (value === undefined) return undefined
  const input = record(value, 'vikunja')
  fields(input, SECTION_FIELDS, 'vikunja')
  const baseUrl = httpBaseUrl(input.baseUrl, 'vikunja.baseUrl')
  const tokenRef = secretRef(input.tokenRef, 'vikunja.tokenRef')
  const projectId = optionalString(input.projectId, 'vikunja.projectId')
  const webhookSecretRef = input.webhookSecretRef === undefined
    ? undefined
    : secretRef(input.webhookSecretRef, 'vikunja.webhookSecretRef')
  return Object.freeze({
    baseUrl,
    tokenRef,
    ...(projectId === undefined ? {} : { projectId }),
    ...(webhookSecretRef === undefined ? {} : { webhookSecretRef }),
  })
}
