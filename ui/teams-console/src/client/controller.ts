import type { ConsoleClientV1, ConsoleCommandResultV1, ConsoleProviderView, HistoryPage, HistoryQuery, JsonValue, TeamsConsoleLiveClientV1 } from './protocol.ts'
import { commandFailureMessage, formatServiceError } from './protocol.ts'
import { readDraft, readFocus, readPage, writeDraft, writeFocus, writePage, type DraftPersistence } from './drafts.ts'
import { ProjectionObservationController, type ObservationSession } from './observation.ts'
import { canSubmitMembership, projectMembershipDraft, selectNetworkMembers } from './page-networking.ts'
import type { NetworkMemberDraft } from './page-discovery.ts'
import { teamPages } from './model.ts'
import type { ConsoleEntry, TeamPage } from './model.ts'

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
  readonly drawerStack: readonly DrawerState[]
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
  readonly live: boolean
  readonly page: TeamPage
  readonly observation: ObservationSession
  readonly messageDraft: string
  readonly selectedSessionId: string | undefined
  readonly cancelState: 'idle' | 'requested' | 'confirmed' | 'unknown'
  readonly membershipDraft: readonly NetworkMemberDraft[]
  readonly historyStatus: 'idle' | 'loading' | 'ready' | 'refused' | 'error'
  readonly history: HistoryPage | null
  readonly historyError: { readonly code: string; readonly message: string } | null
  readonly historyNextBeforeSequence: number | undefined
  readonly refusedError: { readonly code: string; readonly message: string } | null
  readonly lastFocusKey: string | undefined
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
  drawerStack: [],
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
  live: false,
  page: 'discovery',
  observation: { projection: null, observation: 'unknown', health: { state: 'live' } },
  messageDraft: '',
  selectedSessionId: undefined,
  cancelState: 'idle',
  membershipDraft: [],
  historyStatus: 'idle',
  history: null,
  historyError: null,
  historyNextBeforeSequence: undefined,
  refusedError: null,
  lastFocusKey: undefined,
}

const liveDefaults = {
  live: false,
  page: 'discovery',
  observation: { projection: null, observation: 'unknown', health: { state: 'live' } },
  messageDraft: '',
  selectedSessionId: undefined,
  cancelState: 'idle',
  membershipDraft: [],
  historyStatus: 'idle',
  history: null,
  historyError: null,
  historyNextBeforeSequence: undefined,
  refusedError: null,
  lastFocusKey: undefined,
} satisfies Partial<ConsoleState>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown host error'
}

function cloneDraft(draft: ProviderDraft): ProviderDraft {
  return { ...draft }
}

function typedError(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof Error) {
    const code = (error as { readonly code?: unknown }).code
    return { code: typeof code === "string" ? code : "HISTORY_REFUSED", message: error.message }
  }
  return { code: "HISTORY_REFUSED", message: "Unknown history refusal" }
}

function actionResult(label: string, result: Extract<ConsoleCommandResultV1, { readonly ok: true }>): string {
  return result.result === undefined ? `${label}: accepted by Agent` : `${label}: ${JSON.stringify(result.result)}`
}

export class TeamsConsoleController {
  private state: ConsoleState = initialConsoleState
  private readonly listeners = new Set<() => void>()

  private readonly client: ConsoleClientV1
  private readonly liveClient?: TeamsConsoleLiveClientV1
  private readonly persistence?: DraftPersistence

  private observationController?: ProjectionObservationController
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()

  constructor(client: ConsoleClientV1, options: { readonly persistence?: DraftPersistence; readonly initialPage?: TeamPage } = {}) {
    this.client = client
    if (this.isTeamsLiveClient(client)) this.liveClient = client
    this.persistence = options.persistence
    this.state = {
      ...initialConsoleState,
      ...liveDefaults,
      live: this.liveClient !== undefined,
      page: options.initialPage ?? (readPage(options.persistence, teamPages as readonly TeamPage[]) as TeamPage | undefined) ?? 'discovery',
      messageDraft: readDraft(options.persistence, 'message') ?? '',
      membershipDraft: readDraft<NetworkMemberDraft[]>(options.persistence, 'networking') ?? [],
      lastFocusKey: readFocus(options.persistence),
    }
    if (this.liveClient !== undefined) {
      this.observeLiveProjection()
      // A page restored from persistence is never routed through selectPage, so the first
      // history read has to be started here as well.
      this.ensureHistoryLoaded(this.state.page)
    }
  }

  getSnapshot = (): ConsoleState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  startObservation(): void {
    this.observationController?.start()
  }

  destroy(): void {
    this.observationController?.stop()
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.observationController = undefined
  }

  setFocusKey(focusKey: string | undefined): void {
    this.update({ lastFocusKey: focusKey })
    writeFocus(this.persistence, focusKey)
  }

  private observeLiveProjection(): void {
    if (this.liveClient === undefined) return
    const liveClient = this.liveClient
    this.observationController = new ProjectionObservationController({
      subscribe: () => liveClient.subscribeProjection({
        onSnapshot: snapshot => { this.observationController?.onSnapshot(snapshot) },
        onHealth: health => { this.observationController?.onHealth(health) },
      }),
      onSnapshot: projection => this.update({ projection, status: 'ready' }),
      onObservation: observation => this.update({ observation }),
      onError: error => this.update({ status: 'error', error: errorText(error) }),
    })
  }

  private update(patch: Partial<ConsoleState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }

  private isTeamsLiveClient(client: ConsoleClientV1): client is TeamsConsoleLiveClientV1 {
    return typeof (client as TeamsConsoleLiveClientV1).readHistory === 'function'
      && typeof (client as TeamsConsoleLiveClientV1).subscribeProjection === 'function'
  }

  private scheduleTimer(timer: ReturnType<typeof setTimeout>): void {
    this.timers.add(timer)
    void timer
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
    this.update({ open: false, drawer: null, drawerStack: [], drawerExpanded: false, notice: null, error: null })
  }

  selectEntry(entry: ConsoleEntry): void {
    this.update({ entry, drawer: null, drawerStack: [], drawerExpanded: false, notice: null })
  }

  selectPage(page: TeamPage): void {
    this.update({ page, notice: null, refusedError: null })
    writePage(this.persistence, page)
    this.ensureHistoryLoaded(page)
  }

  /**
   * The history view owns no initial read. Its only other trigger is the "previous" control,
   * which is disabled until a page has already been read, so without this the view is a dead
   * end that can never show a record. The first read happens when the view is opened.
   */
  private ensureHistoryLoaded(page: TeamPage): void {
    if (page !== 'history') return
    // Only a live client has a history owner. A fixture client keeps its previous rendering
    // instead of flipping to a HISTORY_UNAVAILABLE refusal, matching the constructor path.
    if (this.liveClient === undefined) return
    if (this.state.history !== null || this.state.historyStatus === 'loading') return
    void this.loadHistory()
  }

  setMessageDraft(message: string): void {
    this.update({ messageDraft: message })
    writeDraft(this.persistence, 'message', message)
  }

  selectSessionSessionId(sessionId: string | undefined): void {
    this.update({ selectedSessionId: sessionId })
  }

  setMembershipDraft(draft: readonly NetworkMemberDraft[]): void {
    this.update({ membershipDraft: draft })
    writeDraft(this.persistence, 'networking', draft)
  }

  async connectAgent(agentId: string): Promise<boolean> {
    return this.runRefusedAction('Connect', () => this.client.command({ kind: 'connection.connect', agentId }))
  }

  async applyMembership(expectedRevision: number, members: readonly NetworkMemberDraft[]): Promise<boolean> {
    const projection = this.state.projection
    const known = projection === null ? [] : projectMembershipDraft(projection, members)
    if (known.length === 0) {
      this.update({ refusedError: { code: 'INVALID_NETWORK_DRAFT', message: 'Select at least one participating Agent.' } })
      return false
    }
    if (!canSubmitMembership(known, projection?.agents.find(agent => agent.agentId === 'control')?.agentId)) {
      this.update({ refusedError: { code: 'INVALID_NETWORK_DRAFT', message: 'Assign exactly one non-control master before submit.' } })
      return false
    }
    return this.runRefusedAction('Submit network draft', () => this.client.command({
      kind: 'network.membership.apply',
      agentId: known[0]?.agentId ?? '',
      expectedRevision,
      members: known,
    }))
  }

  selectNetworkMember(agentId: string, role: 'master' | 'peer'): void {
    this.setMembershipDraft(selectNetworkMembers(this.state.projection?.agents ?? [], this.state.membershipDraft, agentId, role))
  }

  async loadHistory(query?: Partial<HistoryQuery>): Promise<boolean> {
    if (this.liveClient === undefined) {
      this.update({ historyStatus: 'refused', historyError: { code: 'HISTORY_UNAVAILABLE', message: 'History owner is not bound to this UI client.' } })
      return false
    }
    const beforeSequence = query?.beforeSequence ?? this.state.historyNextBeforeSequence
    const historyQuery: HistoryQuery = { version: 1, kind: 'connection', limit: 20, ...(beforeSequence === undefined ? {} : { beforeSequence }) }
    this.update({ historyStatus: 'loading', historyError: null })
    try {
      const page = await this.liveClient.readHistory(historyQuery)
      this.update({ historyStatus: 'ready', history: page, historyNextBeforeSequence: page.nextBeforeSequence })
      return true
    } catch (error) {
      this.update({ historyStatus: 'refused', historyError: typedError(error) })
      return false
    }
  }

  async loadRequestHistory(query?: Partial<HistoryQuery>): Promise<boolean> {
    if (this.liveClient === undefined) {
      this.update({ historyStatus: 'refused', historyError: { code: 'HISTORY_UNAVAILABLE', message: 'History owner is not bound to this UI client.' } })
      return false
    }
    const beforeSequence = query?.beforeSequence
    const historyQuery: HistoryQuery = { version: 1, kind: 'request', limit: 20, ...(beforeSequence === undefined ? {} : { beforeSequence }) }
    this.update({ historyStatus: 'loading', historyError: null })
    try {
      const page = await this.liveClient.readHistory(historyQuery)
      this.update({ historyStatus: 'ready', history: page, historyNextBeforeSequence: page.nextBeforeSequence })
      return true
    } catch (error) {
      this.update({ historyStatus: 'refused', historyError: typedError(error) })
      return false
    }
  }

  private async runRefusedAction(label: string, action: () => Promise<ConsoleCommandResultV1>): Promise<boolean> {
    this.update({ busy: label, error: null, notice: null, refusedError: null })
    try {
      const result = await action()
      if (result.ok === false) {
        this.update({ busy: null, refusedError: { code: result.error.code, message: result.error.message }, error: null })
        return false
      }
      const refreshed = await this.refreshAfterAction()
      this.update({ busy: null, notice: actionResult(label, result) })
      return refreshed
    } catch (error) {
      this.update({ busy: null, error: `${label}: ${errorText(error)}` })
      return false
    }
  }

  setLocale(locale: 'en' | 'zh'): void {
    this.update({ locale })
  }

  setQuery(query: string): void {
    this.update({ query })
  }

  openAgent(agentId: string): void {
    this.pushDrawer({ kind: 'agent', agentId })
  }

  openSession(agentId: string, sessionId: string): void {
    this.pushDrawer({ kind: 'session', agentId, sessionId })
  }

  openSettings(agentId?: string): void {
    const drawer: DrawerState = { kind: 'settings', ...(agentId === undefined ? {} : { agentId }) }
    const stack = [...this.state.drawerStack, drawer]
    this.update({
      drawer,
      drawerStack: stack,
      drawerExpanded: false,
      selectedAgentId: agentId ?? this.state.selectedAgentId,
      providerFormOpen: false,
      editingProviderId: undefined,
      providerDraft: emptyProviderDraft,
      error: null,
    })
  }

  closeDrawer(): void {
    const stack = this.state.drawerStack.slice(0, -1)
    this.update({
      drawer: stack.at(-1) ?? null,
      drawerStack: stack,
      drawerExpanded: false,
      providerFormOpen: false,
      editingProviderId: undefined,
      providerDraft: emptyProviderDraft,
    })
  }

  toggleDrawerExpanded(): void {
    if (this.state.drawer !== null) this.update({ drawerExpanded: !this.state.drawerExpanded })
  }

  selectAgent(agentId: string): void {
    this.update({ selectedAgentId: agentId, providerFormOpen: false, editingProviderId: undefined, providerDraft: emptyProviderDraft, error: null })
  }

  private pushDrawer(drawer: DrawerState): void {
    this.update({
      drawer,
      drawerStack: [...this.state.drawerStack, drawer],
      drawerExpanded: false,
      error: null,
    })
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
      if (result.ok === false) {
        this.update({ busy: null, error: `${label}: ${failure ?? formatServiceError(result.error)}` })
        return false
      }
      const refreshed = await this.refreshAfterAction()
      if (!refreshed) {
        this.update({ busy: null, error: `${label} succeeded, but the host projection could not be refreshed.` })
        return false
      }
      this.update({ busy: null, notice: actionResult(label, result) })
      return true
    } catch (error) {
      this.update({ busy: null, error: `${label}: ${errorText(error)}` })
      return false
    }
  }

  async openSessionCommand(agentId: string, sessionId: string): Promise<boolean> {
    return this.runAction('Open session', () => this.client.command({ kind: 'session.open', agentId, sessionId }))
  }

  async createSession(agentId: string, title?: string): Promise<boolean> {
    return this.runAction('Create session', () => this.client.command({ kind: 'session.create', agentId, ...(title === undefined ? {} : { title }) }))
  }

  async cancelSession(agentId: string, sessionId: string): Promise<boolean> {
    this.update({ cancelState: 'requested' })
    const ok = await this.runAction('Cancel session', () => this.client.command({ kind: 'session.cancel', agentId, sessionId }))
    this.update({ cancelState: ok ? 'confirmed' : 'unknown' })
    return ok
  }

  async acknowledge(notificationId: string, agentId: string): Promise<boolean> {
    return this.runAction('Acknowledge notification', () => this.client.command({ kind: 'notification.ack', agentId, notificationId }))
  }

  async replyPermission(agentId: string, sessionId: string, permissionId: string, decision: 'once' | 'always' | 'reject', optionId?: string): Promise<boolean> {
    return this.runAction('Permission reply', () => this.client.command({ kind: 'permission.reply', agentId, sessionId, permissionId, decision, ...(optionId === undefined ? {} : { optionId }) }))
  }

  async sendSession(agentId: string, sessionId: string, payload: JsonValue): Promise<boolean> {
    this.update({ busy: 'Send message', error: null, notice: null })
    try {
      const result = await this.client.sendSession({ agentId, sessionId }, payload)
      const failure = commandFailureMessage(result)
      if (result.ok === false) {
        this.update({ busy: null, error: `Send message: ${failure ?? formatServiceError(result.error)}` })
        return false
      }
      const refreshed = await this.refreshAfterAction()
      if (!refreshed) {
        this.update({ busy: null, error: 'Send message succeeded, but the host projection could not be refreshed.' })
        return false
      }
      this.update({ busy: null, notice: actionResult('Send message', result) })
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
