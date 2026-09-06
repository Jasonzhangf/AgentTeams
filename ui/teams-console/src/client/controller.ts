import type { ConsoleClientV1, ConsoleCommandResultV1, ConsoleProviderView, JsonValue } from './protocol.ts'
import { commandFailureMessage, formatServiceError } from './protocol.ts'
import type { ConsoleEntry } from './model.ts'

export type DrawerState =
  | { readonly kind: 'agent'; readonly agentId: string }
  | { readonly kind: 'session'; readonly agentId: string; readonly sessionId: string }
  | { readonly kind: 'settings'; readonly agentId?: string }

export interface ProviderDraft {
  readonly id: string
  readonly label: string
  readonly protocol: 'openai-chat' | 'openai-responses'
  readonly apiBaseUrl: string
  readonly enabled: boolean
  readonly authKind: 'none' | 'bearer'
  readonly credentialRef: string
}

export interface ConsoleState {
  readonly open: boolean
  readonly entry: ConsoleEntry
  readonly drawer: DrawerState | null
  readonly drawerExpanded: boolean
  readonly projection: import('./protocol.ts').ConsoleProjectionV1 | null
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly error: string | null
  readonly notice: string | null
  readonly busy: string | null
  readonly query: string
  readonly locale: 'en' | 'zh'
  readonly selectedAgentId: string | undefined
  readonly providerFormOpen: boolean
  readonly editingProviderId: string | undefined
  readonly providerDraft: ProviderDraft
}

export const emptyProviderDraft: ProviderDraft = {
  id: '',
  label: '',
  protocol: 'openai-chat',
  apiBaseUrl: '',
  enabled: true,
  authKind: 'none',
  credentialRef: '',
}

export const initialConsoleState: ConsoleState = {
  open: false,
  entry: 'topology',
  drawer: null,
  drawerExpanded: false,
  projection: null,
  status: 'idle',
  error: null,
  notice: null,
  busy: null,
  query: '',
  locale: 'en',
  selectedAgentId: undefined,
  providerFormOpen: false,
  editingProviderId: undefined,
  providerDraft: emptyProviderDraft,
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown host error'
}

function cloneDraft(draft: ProviderDraft): ProviderDraft {
  return { ...draft }
}

export class TeamsConsoleController {
  private state: ConsoleState = initialConsoleState
  private readonly listeners = new Set<() => void>()

  constructor(private readonly client: ConsoleClientV1) {}

  getSnapshot = (): ConsoleState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private update(patch: Partial<ConsoleState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private async loadProjection(showLoading: boolean): Promise<boolean> {
    if (showLoading) this.update({ status: 'loading', error: null })
    try {
      const projection = await this.client.readProjection()
      this.update({ projection, status: 'ready', error: null })
      return true
    } catch (error) {
      this.update({ status: 'error', error: errorText(error) })
      return false
    }
  }

  async refresh(): Promise<void> {
    await this.loadProjection(true)
  }

  openConsole(): void {
    this.update({ open: true, notice: null })
    if (this.state.projection === null && this.state.status !== 'loading') void this.refresh()
  }

  closeConsole(): void {
    this.update({ open: false, drawer: null, drawerExpanded: false, notice: null, error: null })
  }

  selectEntry(entry: ConsoleEntry): void {
    this.update({ entry, drawer: null, drawerExpanded: false, notice: null })
  }

  setLocale(locale: 'en' | 'zh'): void {
    this.update({ locale })
  }

  setQuery(query: string): void {
    this.update({ query })
  }

  openAgent(agentId: string): void {
    this.update({ drawer: { kind: 'agent', agentId }, drawerExpanded: false, error: null })
  }

  openSession(agentId: string, sessionId: string): void {
    this.update({ drawer: { kind: 'session', agentId, sessionId }, drawerExpanded: false, error: null })
  }

  openSettings(agentId?: string): void {
    this.update({
      drawer: { kind: 'settings', ...(agentId === undefined ? {} : { agentId }) },
      drawerExpanded: false,
      selectedAgentId: agentId ?? this.state.selectedAgentId,
      providerFormOpen: false,
      editingProviderId: undefined,
      providerDraft: emptyProviderDraft,
      error: null,
    })
  }

  closeDrawer(): void {
    this.update({ drawer: null, drawerExpanded: false, providerFormOpen: false, editingProviderId: undefined, providerDraft: emptyProviderDraft })
  }

  toggleDrawerExpanded(): void {
    if (this.state.drawer !== null) this.update({ drawerExpanded: !this.state.drawerExpanded })
  }

  selectAgent(agentId: string): void {
    this.update({ selectedAgentId: agentId, providerFormOpen: false, editingProviderId: undefined, providerDraft: emptyProviderDraft, error: null })
  }

  beginAddProvider(): void {
    this.update({ providerFormOpen: true, editingProviderId: undefined, providerDraft: cloneDraft(emptyProviderDraft), error: null })
  }

  closeProviderForm(): void {
    this.update({ providerFormOpen: false, editingProviderId: undefined, providerDraft: emptyProviderDraft, error: null })
  }

  editProvider(provider: ConsoleProviderView): void {
    this.update({
      editingProviderId: provider.id,
      providerFormOpen: true,
      providerDraft: {
        id: provider.id,
        label: provider.label,
        protocol: provider.protocol,
        apiBaseUrl: provider.apiBaseUrl,
        enabled: provider.enabled,
        authKind: provider.authKind,
        // The projection intentionally exposes no credential value or reference.
        credentialRef: '',
      },
      error: null,
    })
  }

  setProviderDraft<K extends keyof ProviderDraft>(key: K, value: ProviderDraft[K]): void {
    this.state = { ...this.state, providerDraft: { ...this.state.providerDraft, [key]: value } }
  }

  setProviderAuthKind(authKind: ProviderDraft['authKind']): void {
    this.update({ providerDraft: { ...this.state.providerDraft, authKind } })
  }

  private async refreshAfterAction(): Promise<boolean> {
    return this.loadProjection(false)
  }

  private async runAction(label: string, action: () => Promise<ConsoleCommandResultV1>): Promise<boolean> {
    this.update({ busy: label, error: null, notice: null })
    try {
      const result = await action()
      const failure = commandFailureMessage(result)
      if (failure !== undefined) {
        this.update({ busy: null, error: `${label}: ${failure}` })
        return false
      }
      const refreshed = await this.refreshAfterAction()
      if (!refreshed) {
        this.update({ busy: null, error: `${label} succeeded, but the host projection could not be refreshed.` })
        return false
      }
      this.update({ busy: null, notice: `${label} complete` })
      return true
    } catch (error) {
      this.update({ busy: null, error: `${label}: ${errorText(error)}` })
      return false
    }
  }

  async openSessionCommand(agentId: string, sessionId: string): Promise<boolean> {
    return this.runAction('Open session', () => this.client.command({ kind: 'session.open', agentId, sessionId }))
  }

  async acknowledge(notificationId: string, agentId: string): Promise<boolean> {
    return this.runAction('Acknowledge notification', () => this.client.command({ kind: 'notification.ack', agentId, notificationId }))
  }

  async replyPermission(agentId: string, sessionId: string, permissionId: string, decision: 'once' | 'always' | 'reject'): Promise<boolean> {
    return this.runAction('Permission reply', () => this.client.command({ kind: 'permission.reply', agentId, sessionId, permissionId, decision }))
  }

  async sendSession(agentId: string, sessionId: string, payload: JsonValue): Promise<boolean> {
    this.update({ busy: 'Send message', error: null, notice: null })
    try {
      const result = await this.client.sendSession({ agentId, sessionId }, payload)
      const failure = commandFailureMessage(result)
      if (failure !== undefined) {
        this.update({ busy: null, error: `Send message: ${failure}` })
        return false
      }
      this.update({ busy: null, notice: 'Message sent' })
      return true
    } catch (error) {
      this.update({ busy: null, error: `Send message: ${errorText(error)}` })
      return false
    }
  }

  async refreshModels(agentId: string, providerId: string): Promise<boolean> {
    const config = this.state.projection?.configs.find(candidate => candidate.agentId === agentId)
    if (config === undefined) {
      this.update({ error: 'Refresh models: Agent config is not projected.' })
      return false
    }
    return this.runAction('Refresh models', () => this.client.command({
      kind: 'config.refreshModels',
      agentId,
      expectedRevision: config.acceptedRevision,
      providerId,
    }))
  }

  async bindModel(agentId: string, providerId: string, modelId: string): Promise<boolean> {
    if (modelId.length === 0) {
      this.update({ error: 'Bind model: select a model returned by the host catalog.' })
      return false
    }
    const config = this.state.projection?.configs.find(candidate => candidate.agentId === agentId)
    const provider = config?.providers.find(candidate => candidate.id === providerId)
    if (config === undefined || provider === undefined) {
      this.update({ error: 'Bind model: provider config is not projected.' })
      return false
    }
    if (!provider.models.some(model => model.id === modelId)) {
      this.update({ error: `Bind model: unknown model "${modelId}"; refresh the catalog first.` })
      return false
    }
    return this.runAction('Bind model', () => this.client.command({
      kind: 'config.bindModel',
      agentId,
      expectedRevision: config.acceptedRevision,
      providerId,
      modelId,
    }))
  }

  async putProvider(agentId: string): Promise<boolean> {
    const draft = this.state.providerDraft
    if (draft.id.trim().length === 0 || draft.label.trim().length === 0 || draft.apiBaseUrl.trim().length === 0) {
      this.update({ error: 'Save provider: ID, label, and API base URL are required.' })
      return false
    }
    try {
      const parsed = new URL(draft.apiBaseUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('API base URL must use http or https.')
    } catch (error) {
      this.update({ error: `Save provider: ${errorText(error)}` })
      return false
    }
    if (draft.authKind === 'bearer' && draft.credentialRef.trim().length === 0) {
      this.update({ error: 'Save provider: a credential reference is required for bearer auth; values never belong in Teams UI.' })
      return false
    }
    const config = this.state.projection?.configs.find(candidate => candidate.agentId === agentId)
    if (config === undefined) {
      this.update({ error: 'Save provider: Agent config is not projected.' })
      return false
    }
    return this.runAction('Save provider', () => this.client.command({
      kind: 'config.putProvider',
      agentId,
      expectedRevision: config.acceptedRevision,
      provider: {
        id: draft.id.trim(),
        label: draft.label.trim(),
        protocol: draft.protocol,
        apiBaseUrl: draft.apiBaseUrl.trim(),
        enabled: draft.enabled,
        auth: draft.authKind === 'none'
          ? { kind: 'none' }
          : { kind: 'bearer', credentialRef: draft.credentialRef.trim() },
      },
    }))
  }

  async applyConfig(agentId: string): Promise<boolean> {
    return this.runAction('Apply configuration', () => this.client.command({ kind: 'config.apply', agentId }))
  }

  dismissNotice(): void {
    this.update({ notice: null })
  }

  getLastErrorCode(): string | undefined {
    const error = this.state.projection?.configs.find(config => config.error !== undefined)?.error
    return error === undefined ? undefined : formatServiceError(error)
  }
}
