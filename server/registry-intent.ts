import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { AuthenticatedAgent } from '../packages/shared/src/agent-services.ts'
import type { AdmissionIntent, RegistryDaemonIntent } from '../config/daemon-intent.ts'
import { REGISTRY_IMPLEMENTATION, type RegistryImplementation } from '../config/daemon-intent.ts'
import { DEFAULT_PEER_TTL_MS, type RelayServerOptions } from './relay.ts'

/**
 * The single owner that maps the frozen `RegistryDaemonIntent` onto the
 * existing `server/Relay` server options. `RelayProcessConfig` v1 JSON stays an
 * internal projection of the local launcher and is never a second editable
 * source for the registry; this module is the only registry mapping site.
 */

/**
 * A registry `listen` always needs an explicit certificate and key, including a
 * loopback listener. The runtime never generates a certificate and never
 * downgrades to plaintext `ws`.
 */
export const REGISTRY_TLS_OPENSSL_COMMAND =
  'openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=<registry-host>" -keyout certs/registry-key.pem -out certs/registry-cert.pem'

/** Reuses the deployed Relay limit policy and adds the server-owned presence lease. */
export const REGISTRY_SERVER_DEFAULTS = {
  maxPayload: 65_536,
  maxConnections: 64,
  maxGrants: 32,
  maxBufferedAmount: 65_536,
  maxPendingMessages: 32,
  maxPendingBytes: 65_536,
  grantTtlMs: 10_000,
  peerTtlMs: DEFAULT_PEER_TTL_MS,
} as const

export type RegistryIntentFaultCode =
  | 'TLS_REQUIRED'
  | 'UNSUPPORTED_CONFIGURATION'
  | 'INVALID_INPUT'
  | 'UNAUTHENTICATED'
  | 'CONFLICT'
  | 'NOT_FOUND'

export class RegistryIntentFault extends Error {
  constructor(readonly code: RegistryIntentFaultCode, message: string, cause?: unknown) {
    super(message, { cause })
    this.name = 'RegistryIntentFault'
  }
}

export interface RegistryCredentialBinding {
  readonly admissionRef: string
  readonly identity: AuthenticatedAgent
  /** `env:NAME` or `file:<absolute-path>`; the value itself is never stored here. */
  readonly credentialRef: string
}

export interface RegistryServerPlan {
  readonly implementation: RegistryImplementation
  readonly host: string
  readonly port: number
  readonly tls: { readonly certFile: string; readonly keyFile: string }
  readonly limits: typeof REGISTRY_SERVER_DEFAULTS
  readonly credentials: readonly RegistryCredentialBinding[]
}

function absoluteFileRef(ref: string, label: string): string {
  if (!ref.startsWith('file:')) {
    throw new RegistryIntentFault('INVALID_INPUT', `${label} must resolve to a file: reference`)
  }
  const path = ref.slice('file:'.length)
  if (!isAbsolute(path)) {
    throw new RegistryIntentFault('INVALID_INPUT', `${label} must be an absolute path after resolveDaemonIntent`)
  }
  return path
}

function admissionBinding(admission: AdmissionIntent): RegistryCredentialBinding {
  return {
    admissionRef: admission.admissionRef,
    identity: { accountId: admission.accountId, scopeId: admission.scopeId, agentId: admission.agentId },
    credentialRef: admission.credentialRef,
  }
}

/**
 * Pure projection of one already-resolved registry intent. It reads no secret
 * and touches no file, so `registry status` can print it without a credential.
 */
export function resolveRegistryServerPlan(intent: RegistryDaemonIntent): RegistryServerPlan {
  if (intent?.daemon?.kind !== 'registry') {
    throw new RegistryIntentFault('UNSUPPORTED_CONFIGURATION', 'registry server options require a registry daemon config')
  }
  const { tlsCertRef, tlsKeyRef } = intent.listen
  if (tlsCertRef === undefined || tlsKeyRef === undefined) {
    throw new RegistryIntentFault(
      'TLS_REQUIRED',
      `registry listen requires explicit tlsCertRef and tlsKeyRef, even on a loopback address; generate a local certificate with: ${REGISTRY_TLS_OPENSSL_COMMAND}`,
    )
  }
  return {
    implementation: REGISTRY_IMPLEMENTATION,
    host: intent.listen.ip,
    port: intent.listen.port,
    tls: {
      certFile: absoluteFileRef(tlsCertRef, 'listen.tlsCertRef'),
      keyFile: absoluteFileRef(tlsKeyRef, 'listen.tlsKeyRef'),
    },
    limits: REGISTRY_SERVER_DEFAULTS,
    credentials: intent.admissions.map(admissionBinding),
  }
}

export interface RegistryCredentialLoadOptions {
  readonly env?: NodeJS.ProcessEnv
  /** Test seam only; production reads the referenced file. */
  readonly readFile?: (path: string) => Promise<string>
}

function credentialValue(ref: string, options: RegistryCredentialLoadOptions): Promise<string> {
  if (ref.startsWith('env:')) {
    const name = ref.slice('env:'.length)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new RegistryIntentFault('INVALID_INPUT', `credential reference ${ref} is not a valid environment-variable name`)
    }
    const value = (options.env ?? process.env)[name]
    if (typeof value !== 'string' || value.length === 0) {
      throw new RegistryIntentFault('UNAUTHENTICATED', `credential environment ${name} is missing or empty`)
    }
    return Promise.resolve(value)
  }
  if (!ref.startsWith('file:')) {
    throw new RegistryIntentFault('INVALID_INPUT', `credential reference ${ref} must use env:NAME or file:<path>`)
  }
  const path = ref.slice('file:'.length)
  return (options.readFile ?? (async candidate => await readFile(candidate, 'utf8')))(path).catch(cause => {
    throw new RegistryIntentFault('NOT_FOUND', `credential file could not be read: ${path}`, cause)
  })
}

/**
 * Resolves every admitted credential value exactly once. The returned map is
 * keyed by the exact `Authorization` header value; it is never a projection
 * field and never enters a directory entry or control frame.
 */
export async function loadRegistryCredentials(
  plan: RegistryServerPlan,
  options: RegistryCredentialLoadOptions = {},
): Promise<ReadonlyMap<string, AuthenticatedAgent>> {
  const credentials = new Map<string, AuthenticatedAgent>()
  for (const binding of plan.credentials) {
    const raw = await credentialValue(binding.credentialRef, options)
    const value = raw.replace(/\r?\n$/, '')
    if (value.length === 0 || /[\r\n]/.test(value)) {
      throw new RegistryIntentFault('UNAUTHENTICATED', `credential ${binding.credentialRef} is empty or contains a line break`)
    }
    if (credentials.has(value)) {
      throw new RegistryIntentFault('CONFLICT', `duplicate credential value for admission ${binding.admissionRef}`)
    }
    credentials.set(value, { ...binding.identity })
  }
  return credentials
}

export interface RegistryRelayTls {
  readonly key: string | Buffer
  readonly cert: string | Buffer
}

/**
 * Assembles the exact `RelayServerOptions` for one registry. Identity matching
 * against the declaration stays owned by `createRelayServer`.
 */
export function createRegistryRelayOptions(
  plan: RegistryServerPlan,
  input: { readonly credentials: ReadonlyMap<string, AuthenticatedAgent>; readonly tls: RegistryRelayTls },
): RelayServerOptions {
  return {
    host: plan.host,
    port: plan.port,
    key: input.tls.key,
    cert: input.tls.cert,
    ...plan.limits,
    authenticate: credential => {
      if (credential === undefined) return null
      const identity = input.credentials.get(credential)
      return identity === undefined ? null : { ...identity }
    },
  }
}
