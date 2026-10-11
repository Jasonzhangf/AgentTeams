import { AcpError } from '../control-protocol/acp.ts'
import type {
  AgentModelBinding,
  ModelEntry,
  ModelRef,
  ProviderInstance,
  VersionedRuntimeConfig,
} from '../config/runtime-config.ts'

/**
 * DSH-native engine configuration derivation.
 *
 * Owner: dsh-adapter. It consumes the accepted Teams config (provider
 * instances + declared model catalog + this daemon's model binding) and derives
 * the DSH profile patch that makes that binding the engine's own route. It
 * declares no second provider binding, no second model catalog and no engine
 * registry: the Teams config stays the single source.
 *
 * The derived patch is emitted as JSON. JSON is a YAML 1.2 subset, so the DSH
 * launcher's YAML patch-list reader consumes it unchanged, and no YAML emitter
 * (or YAML-injection surface) enters the adapter.
 */

const CREDENTIAL_ENV_PREFIX = 'TEAMS_DSH_CREDENTIAL_'
const ROUTE_PREFIX = 'teams-'

export type DshProviderApi = 'openai-completions' | 'openai-responses'

/**
 * Engine-side pi-ai route name for a Teams provider instance.
 *
 * The prefix keeps the derived route disjoint from the routes the installed
 * DSH composition already owns (`deepseek-official`, the pi-ai catalog, and any
 * other mounted adapter's route). Registering a route another adapter owns
 * fails DSH plugin loading, so a prefixed name turns a possible collision into
 * an explicit, impossible condition instead of a start failure.
 */
export function dshProviderRoute(providerInstanceId: string): string {
  return `${ROUTE_PREFIX}${providerInstanceId}`
}

/** Map the frozen Teams provider protocol onto the DSH pi-ai wire protocol. */
export function dshProviderApi(protocol: ProviderInstance['protocol']): DshProviderApi {
  return protocol === 'openai-chat' ? 'openai-completions' : 'openai-responses'
}

export interface DshPiAiRoute {
  readonly api: DshProviderApi
  readonly baseURL: string
  readonly apiKeyEnv?: string
  readonly models: readonly { readonly id: string; readonly name: string }[]
}

export interface DshPiAiPatchEntry {
  readonly id: 'llm-pi-ai'
  readonly config: { readonly providers: Readonly<Record<string, DshPiAiRoute>> }
}

export interface DshAcpPatchEntry {
  readonly id: 'acp'
  readonly config: { readonly provider: string; readonly model: string }
}

/** A DSH profile patch list: row-id targeted, last write winning per row. */
export type DshProfilePatch = readonly [DshPiAiPatchEntry, DshAcpPatchEntry]

export interface DshNativeConfig {
  /** The engine route the derived patch selects. */
  readonly providerRoute: string
  readonly modelId: string
  /** The Teams model references this derivation proved and carried. */
  readonly modelTargets: readonly ModelRef[]
  /** Launch env key -> Teams credential reference; resolved by the runtime. */
  readonly credentialEnvRefs: Readonly<Record<string, string>>
  readonly patch: DshProfilePatch
  readonly patchContent: string
}

export interface CompileDshNativeConfigInput {
  readonly accepted: VersionedRuntimeConfig
  readonly binding: AgentModelBinding
}

function fail(message: string): never {
  throw new AcpError('UNSUPPORTED_CONFIGURATION', message)
}

function modelLabel(entry: ModelEntry): string {
  const override = entry.overrides.label
  if (typeof override === 'string' && override.length > 0) return override
  const base = entry.base.label
  if (typeof base === 'string' && base.length > 0) return base
  return entry.ref.modelId
}

/**
 * Derive the DSH profile patch and credential references for one daemon's
 * accepted binding. Every rejection is explicit: a missing, disabled,
 * catalog-less or model-less provider never falls back to a DSH shipped route.
 */
export function compileDshNativeConfig(input: CompileDshNativeConfigInput): DshNativeConfig {
  const targets: readonly ModelRef[] = input.binding.backup === undefined
    ? [input.binding.primary]
    : [input.binding.primary, input.binding.backup]

  const providers: Record<string, DshPiAiRoute> = {}
  const credentialEnvRefs: Record<string, string> = {}

  for (const target of targets) {
    const provider = input.accepted.providers[target.providerInstanceId]
    if (provider === undefined) {
      fail(`DSH engine launch: the model binding references unknown provider instance ${target.providerInstanceId}`)
    }
    if (provider.enabled !== true) {
      fail(`DSH engine launch: provider instance ${target.providerInstanceId} is disabled in the accepted config`)
    }
    const catalog = input.accepted.catalogs[target.providerInstanceId]
    if (catalog === undefined || catalog.state !== 'ready') {
      fail(`DSH engine launch: provider instance ${target.providerInstanceId} has no ready model catalog`)
    }
    const serviceable = catalog.entries.filter(entry => entry.availability !== 'unavailable')
    if (serviceable.length === 0) {
      fail(`DSH engine launch: provider instance ${target.providerInstanceId} declares no serviceable model`)
    }
    if (!serviceable.some(entry => entry.ref.modelId === target.modelId)) {
      fail(`DSH engine launch: provider instance ${target.providerInstanceId} does not declare bound model ${target.modelId}`)
    }

    const route = dshProviderRoute(target.providerInstanceId)
    if (providers[route] !== undefined) continue
    let apiKeyEnv: string | undefined
    if (provider.auth.kind === 'bearer') {
      apiKeyEnv = `${CREDENTIAL_ENV_PREFIX}${Object.keys(providers).length}`
      credentialEnvRefs[apiKeyEnv] = provider.auth.credentialRef
    }
    providers[route] = {
      api: dshProviderApi(provider.protocol),
      baseURL: provider.apiBaseUrl,
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      models: serviceable.map(entry => ({ id: entry.ref.modelId, name: modelLabel(entry) })),
    }
  }

  const primary = input.binding.primary
  const patch: DshProfilePatch = [
    { id: 'llm-pi-ai', config: { providers } },
    { id: 'acp', config: { provider: dshProviderRoute(primary.providerInstanceId), model: primary.modelId } },
  ]

  return {
    providerRoute: dshProviderRoute(primary.providerInstanceId),
    modelId: primary.modelId,
    modelTargets: targets,
    credentialEnvRefs,
    patch,
    patchContent: JSON.stringify(patch),
  }
}
