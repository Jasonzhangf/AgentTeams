import { RuntimeConfigError, type CredentialResolver, type ModelEntry, type ProviderModelClient, type RuntimeConfigApplier, type RuntimeConfigStore } from '../config/runtime-config.ts'
import { parseConsoleCommand, type ConsoleCommandV1, type ConsoleCommandResultV1, type ConsoleProjectionV1 } from '../control-protocol/console-api.ts'

type ConfigCommand = Extract<ConsoleCommandV1, { kind: `config.${string}` }>

/** Daemon assembly port. Caller authenticates the principal; config remains the durable owner. */
export function createConsoleConfigBinding(options: {
  readonly agentId: string
  readonly store: RuntimeConfigStore
  readonly models: ProviderModelClient
  readonly credentials?: CredentialResolver
  readonly applier: RuntimeConfigApplier
}) {
  const { agentId, store, models, credentials, applier } = options
  if (!agentId) throw new Error('Console config binding requires an Agent ID')
  const dispatch = async (input: ConfigCommand): Promise<void> => {
      const command = parseConsoleCommand(input)
      if (command.agentId !== agentId) throw new RuntimeConfigError({ code: 'FORBIDDEN', message: 'Configuration target does not match this daemon' })
      switch (command.kind) {
        case 'config.putProvider':
          store.putProviderInstance(command.expectedRevision, command.provider)
          return
        case 'config.bindModel': {
          const current = store.read().agents[agentId]
          store.bindAgentModel(command.expectedRevision, agentId, {
            primary: { providerInstanceId: command.providerId, modelId: command.modelId },
            ...(current?.backup === undefined ? {} : { backup: current.backup }),
          })
          return
        }
        case 'config.model.put':
          store.putModelEntry(command.expectedRevision, command.entry as ModelEntry)
          return
        case 'config.agent.select-backup':
          store.selectAgentBackup(command.expectedRevision, agentId, command.backup)
          return
        case 'config.refreshModels': {
          const result = await store.refreshProviderModels(command.expectedRevision, command.providerId, models, credentials)
          if (result.status === 'error') throw new RuntimeConfigError(result.error!)
          return
        }
        case 'config.apply': {
          const result = await store.applyAcceptedConfig(applier)
          if (result.status !== 'applied') throw new RuntimeConfigError(result.error)
          return
        }
        default: throw new RuntimeConfigError({ code: 'UNSUPPORTED_OPERATION', message: 'Command does not belong to the config owner' })
      }
  }
  return {
    readProjection: (): ConsoleProjectionV1['configs'][number] => {
      const config = store.read()
      return {
        agentId, acceptedRevision: config.acceptedRevision,
        ...(config.effectiveRevision === undefined ? {} : { effectiveRevision: config.effectiveRevision }),
        ...(config.lastApplyError === undefined ? {} : { error: config.lastApplyError }),
        providers: Object.values(config.providers).map(provider => {
          const catalog = config.catalogs[provider.id]
          if (!catalog) throw new RuntimeConfigError({ code: 'UNAVAILABLE', message: 'Provider catalog state is missing', providerInstanceId: provider.id })
          return {
            id: provider.id, label: provider.label, protocol: provider.protocol, apiBaseUrl: provider.apiBaseUrl,
            enabled: provider.enabled, authKind: provider.auth.kind, catalogState: catalog.state,
            ...(catalog.error === undefined ? {} : { error: catalog.error }),
            models: catalog.entries.map(entry => {
              const label = entry.overrides.label ?? entry.base.label
              return { id: entry.ref.modelId, ...(label === undefined ? {} : { label }) }
            }),
          }
        }),
      }
    },
    command: async (input: ConfigCommand): Promise<ConsoleCommandResultV1> => {
      try {
        await dispatch(input)
        return { ok: true }
      } catch (error) {
        if (error instanceof RuntimeConfigError) return { ok: false, error: error.toJSON() }
        throw error // Unknown transport/storage outcome must remain a failed call, never a fabricated result.
      }
    },
  }
}
