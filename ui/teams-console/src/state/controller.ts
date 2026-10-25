import type { ConsoleClientV1, ConsoleCommandResultV1, ConsoleProviderView, HistoryPage, HistoryQuery, JsonValue, TeamsConsoleLiveClientV1 } from '../client/protocol.ts'
import { commandFailureMessage, formatServiceError } from '../client/protocol.ts'
import type { GroupRequestOutcome, GroupRequestSender } from '../client/group-client.ts'
import type { GroupWireReply, GroupWireRequest } from '../../../../packages/shared/src/group-wire.ts'
import {
  applyAccess, applyRefusal, applyReply, applyUnknown, defaultActor, groupActors,
  contextKeyOf, initialGroupWorkspaceState, intentKeyOf, isReadFrame,
  needsConfirmation, requestContextOf, withCommitId,
  type GroupMutationMemory, type GroupOutcome, type GroupRequestContext, type GroupWorkspaceState,
} from './group-workspace.ts'
import { readDraft, readFocus, readPage, writeDraft, writeFocus, writePage, type DraftPersistence } from './drafts.ts'
import { ProjectionObservationController, type ObservationSession } from './observation.ts'
import { canSubmitMembership, projectMembershipDraft, selectNetworkMembers, type NetworkMemberDraft } from '../components/page-networking.ts'
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
  readonly projection: import('../client/protocol.ts').ConsoleProjectionV1 | null
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
  /** True when the injected client also carries the additive group request port. */
  readonly groupCapable: boolean
  readonly group: GroupWorkspaceState
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

/**
 * Visible group content owned by one actor/group context. Switching context drops all of
 * it before the next owner answer arrives, so a late reply can never repaint the old view.
 */
const clearedGroupContent = {
  messages: [],
  messageStatus: 'idle',
  messageHasMore: false,
  messageCursor: undefined,
  issue: null,
  issueStatus: 'idle',
  issues: [],
  issueListStatus: 'idle',
  actions: [],
  actionStatus: 'idle',
  invitations: [],
  composer: '',
  confirm: null,
  stopReport: null,
  readError: undefined,
  mutation: null,
  retryable: null,
  commits: {},
  outcome: { kind: 'idle' as const },
} satisfies Partial<GroupWorkspaceState>

/** Period between quiet background `group.list` re-reads on the visible groups page. */
const GROUP_LIST_POLL_INTERVAL_MS = 4000

/**
 * One write result kept under the context that produced it. `retryable` keeps the original
 * request and commit ids, so only the owning context can retry it.
 */
interface ParkedGroupResult {
  readonly context: GroupRequestContext
  readonly outcome: GroupOutcome
  readonly retryable: GroupMutationMemory | null
  readonly commits: Readonly<Record<string, string>>
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
  groupCapable: false,
  group: initialGroupWorkspaceState,
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

/** Whether a write sent in `owner` belongs to the `view` context. */
function contextMatches(view: GroupRequestContext, owner: GroupRequestContext): boolean {
  if (owner.actorId !== view.actorId) return false
  if (owner.groupId !== undefined && owner.groupId !== view.groupId) return false
  if (owner.sessionId !== undefined && owner.sessionId !== view.sessionId) return false
  return true
}

function actionResult(label: string, result: Extract<ConsoleCommandResultV1, { readonly ok: true }>): string {
  return result.result === undefined ? `${label}: accepted by Agent` : `${label}: ${JSON.stringify(result.result)}`
}

export class TeamsConsoleController {
  private state: ConsoleState = initialConsoleState
  private readonly listeners = new Set<() => void>()

  private readonly client: ConsoleClientV1
  private readonly liveClient?: TeamsConsoleLiveClientV1
  private readonly groupClient?: GroupRequestSender
  private readonly persistence?: DraftPersistence

  private observationController?: ProjectionObservationController
  private readonly timers = new Set<ReturnType<typeof setTimeout>>()
  private groupPollTimer: ReturnType<typeof setTimeout> | undefined
  private groupPollInFlight = false
  /**
   * Bumped on every identity or group switch. A reply carries the generation it was asked
   * in, so an answer that lands after the user moved on is dropped instead of being applied
   * to the new context.
   */
  private groupGeneration = 0
  /** Write results parked under the context that produced them; visible only there. */
  private readonly parkedResults = new Map<string, ParkedGroupResult>()
  /** Typed composer text parked under `actorId::groupId` while the user is elsewhere. */
  private readonly composerDrafts = new Map<string, string>()

  constructor(client: ConsoleClientV1, options: { readonly persistence?: DraftPersistence; readonly initialPage?: TeamPage } = {}) {
    this.client = client
    if (this.isTeamsLiveClient(client)) this.liveClient = client
    if (this.isGroupSender(client)) this.groupClient = client
    this.persistence = options.persistence
    this.state = {
      ...initialConsoleState,
      ...liveDefaults,
      live: this.liveClient !== undefined,
      groupCapable: this.groupClient !== undefined,
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
    this.ensureGroupsLoaded(this.state.page)
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
    this.stopGroupPoll()
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
      onSnapshot: projection => {
        this.update({ projection, status: 'ready' })
        this.syncGroupActors()
      },
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
      this.syncGroupActors()
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
    this.syncGroupPoll()
  }

  closeConsole(): void {
    this.update({ open: false, drawer: null, drawerStack: [], drawerExpanded: false, notice: null, error: null })
    this.stopGroupPoll()
  }

  selectEntry(entry: ConsoleEntry): void {
    this.update({ entry, drawer: null, drawerStack: [], drawerExpanded: false, notice: null })
  }

  selectPage(page: TeamPage): void {
    this.update({ page, notice: null, refusedError: null })
    writePage(this.persistence, page)
    this.ensureHistoryLoaded(page)
    this.ensureGroupsLoaded(page)
    this.syncGroupPoll()
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

  // The group workspace owns no business truth. It sends typed frames through the
  // additive group port, stores only validated owner replies, and keeps an explicit
  // loading / empty / failed / unknown / refused phase instead of guessing an outcome.
  private isGroupSender(client: ConsoleClientV1): client is ConsoleClientV1 & GroupRequestSender {
    return typeof (client as unknown as GroupRequestSender).requestGroup === 'function'
  }

  private updateGroup(patch: (state: GroupWorkspaceState) => GroupWorkspaceState): void {
    this.update({ group: patch(this.state.group) })
  }

  private composerKey(): string {
    return `${this.state.group.actorId ?? ''}::${this.state.group.selectedGroupId ?? ''}`
  }

  /** Keep the text typed in the context the user is leaving. */
  private parkComposer(): void {
    const key = this.composerKey()
    const text = this.state.group.composer
    if (text.length === 0) this.composerDrafts.delete(key)
    else this.composerDrafts.set(key, text)
  }

  /** Restore the text that belongs to the context the user is entering. */
  private restoreComposer(): void {
    const text = this.composerDrafts.get(this.composerKey()) ?? ''
    if (this.state.group.composer !== text) this.updateGroup(state => ({ ...state, composer: text }))
  }

  /**
   * Enter another actor/group view. Every switch uses the same order so an old answer can
   * neither land in the new view nor suppress the result already parked for the new view.
   */
  private switchGroupContext(
    update: (state: GroupWorkspaceState) => GroupWorkspaceState,
    options: { readonly composerAlreadySaved?: boolean } = {},
  ): void {
    // `setGroupComposer` writes the typed text into the drafts map under the key in force,
    // so the owner-driven path already saved the old context's text and only restores.
    if (options.composerAlreadySaved !== true) this.parkComposer()
    this.groupGeneration += 1
    this.parkInFlightGroupMutation()
    this.updateGroup(update)
    this.restoreComposer()
    this.applyContextResult()
  }

  private nextRequestId(): string {
    const cryptoImpl = globalThis.crypto as { readonly randomUUID?: () => string } | undefined
    if (cryptoImpl?.randomUUID !== undefined) return cryptoImpl.randomUUID()
    return `ui-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`
  }

  private withRequestId(frame: GroupWireRequest): GroupWireRequest {
    return { ...frame, requestId: this.nextRequestId() }
  }

  /** Retained commit ids live per context, so a switched context never inherits one. */
  private commitKeyOf(context: GroupRequestContext, frame: GroupWireRequest): string {
    return `${contextKeyOf(context)}::${intentKeyOf(frame)}`
  }

  /** Attach the retained commit id for this intent, or retain a new one. */
  private withCommit(frame: GroupWireRequest): GroupWireRequest {
    const key = this.commitKeyOf(requestContextOf(this.state.group, frame), frame)
    const retained = this.state.group.commits[key] ?? this.nextRequestId()
    if (this.state.group.commits[key] === undefined) {
      this.updateGroup(state => ({ ...state, commits: { ...state.commits, [key]: retained } }))
    }
    return withCommitId(frame, retained)
  }

  /**
   * Build the frame to send. A first attempt retains a fresh request id and commit id;
   * a retry reuses both so the owner cannot create a second business object.
   */
  private frameFor(frame: GroupWireRequest, retained?: GroupMutationMemory): GroupWireRequest {
    if (retained === undefined) return this.withCommit(this.withRequestId(frame))
    const committed = retained.commitId === undefined ? retained.frame : withCommitId(retained.frame, retained.commitId)
    return { ...committed, requestId: retained.requestId }
  }

  private mutationMemory(frame: GroupWireRequest, retained?: GroupMutationMemory): GroupMutationMemory {
    if (retained !== undefined) return { ...retained, frame, requestId: frame.requestId }
    const key = intentKeyOf(frame)
    const context = requestContextOf(this.state.group, frame)
    const commitId = this.state.group.commits[this.commitKeyOf(context, frame)]
    return { intentKey: key, requestId: frame.requestId, frame, context, ...(commitId === undefined ? {} : { commitId }) }
  }

  /** A write in flight when its context changes stays parked under the context that sent it. */
  private parkInFlightGroupMutation(options: { readonly issueScopedOnly?: boolean } = {}): void {
    const pending = this.state.group.mutation
    if (pending === null) return
    // A group-level write survives an issue switch, so only session-bound writes park there.
    if (options.issueScopedOnly === true && pending.context.sessionId === undefined) return
    this.parkWriteResult(pending.context, {
      kind: 'unknown',
      frame: pending.frame.kind,
      requestId: pending.requestId,
      code: 'RESULT_UNKNOWN',
      message: 'Context changed before the owner answered; switch back to retry with the same commit.',
    }, pending, pending.commitId === undefined
      ? {}
      : { [this.commitKeyOf(pending.context, pending.frame)]: pending.commitId })
    this.updateGroup(state => ({ ...state, mutation: null }))
  }

  /** The actor/group/issue the view shows; a session component only when one is open. */
  private currentViewContext(): GroupRequestContext {
    const group = this.state.group
    return {
      actorId: group.actorId ?? '',
      groupId: group.selectedGroupId,
      ...(group.issue === null ? {} : { sessionId: group.issue.sessionId }),
    }
  }

  /** The parked result that belongs to `view`, if any. */
  private parkedFor(view: GroupRequestContext): ParkedGroupResult | undefined {
    let best: ParkedGroupResult | undefined
    let bestRank = -1
    for (const parked of this.parkedResults.values()) {
      if (!contextMatches(view, parked.context)) continue
      const rank = parked.context.sessionId !== undefined ? 2 : parked.context.groupId !== undefined ? 1 : 0
      if (rank > bestRank) {
        best = parked
        bestRank = rank
      }
    }
    return best
  }

  /**
   * Show only what the current context owns. An in-flight write that still belongs here keeps
   * its pending result; every other context's parked result stays out of the view.
   */
  private applyContextResult(view: GroupRequestContext = this.currentViewContext()): void {
    const group = this.state.group
    const pending = group.mutation !== null && contextMatches(view, group.mutation.context)
      ? group.mutation
      : null
    const parked = this.parkedFor(view)
    this.updateGroup(state => ({
      ...state,
      mutation: pending,
      retryable: parked?.retryable ?? null,
      commits: parked?.commits ?? {},
      outcome: pending === null
        ? parked?.outcome ?? { kind: 'idle' as const }
        : { kind: 'pending', frame: pending.frame.kind, requestId: pending.requestId },
    }))
  }

  /** Keep one write result under its own context, so a switch never shows or erases it. */
  private recordResult(context: GroupRequestContext, state: GroupWorkspaceState): void {
    this.parkWriteResult(context, state.outcome, state.retryable, state.commits)
  }

  /** Keep one write result under its own context, so a switch never shows or erases it. */
  private parkWriteResult(
    context: GroupRequestContext,
    outcome: GroupOutcome,
    retryable: GroupMutationMemory | null,
    commits: Readonly<Record<string, string>>,
  ): void {
    this.parkedResults.set(contextKeyOf(context), { context, outcome, retryable, commits })
  }

  /** A write whose answer arrived after its context changed is parked, never stranded. */
  private parkDroppedWrite(memory: GroupMutationMemory): void {
    this.parkWriteResult(memory.context, {
      kind: 'unknown',
      frame: memory.frame.kind,
      requestId: memory.requestId,
      code: 'RESULT_UNKNOWN',
      message: 'Context changed before the owner answered; switch back to retry with the same commit.',
    }, memory, memory.commitId === undefined
      ? {}
      : { [this.commitKeyOf(memory.context, memory.frame)]: memory.commitId })
    this.updateGroup(state => state.mutation !== null && state.mutation.requestId === memory.requestId
      ? { ...state, mutation: null }
      : state)
    this.applyContextResult()
  }

  /** A late create success never repaints another view; it is kept for the created group. */
  private parkLateCreatedWrite(memory: GroupMutationMemory, createdContext: GroupRequestContext): void {
    this.parkedResults.delete(contextKeyOf(memory.context))
    this.parkWriteResult(createdContext, { kind: 'succeeded', frame: 'group.create' }, null, {})
    this.updateGroup(state => state.mutation !== null && state.mutation.requestId === memory.requestId
      ? { ...state, mutation: null }
      : state)
    this.applyContextResult()
  }

  /** Group actors come from the projection; `control` is never an actor. */
  private syncGroupActors(): void {
    const projection = this.state.projection
    const actors = projection === null ? [] : groupActors(projection.agents.map(agent => agent.agentId))
    const current = this.state.group.actorId
    const actorId = current !== undefined && actors.includes(current)
      ? current
      : defaultActor(actors, this.state.selectedAgentId)
    if (this.state.group.actorId === actorId && this.state.group.actors.length === actors.length) return
    this.updateGroup(state => ({ ...state, actors, ...(actorId === undefined ? { actorId: undefined } : { actorId }) }))
  }

  setGroupActor(agentId: string): void {
    if (!this.state.group.actors.includes(agentId)) return
    if (this.state.group.actorId === agentId) return
    // A different identity shares no draft, retry credential or visible history with the
    // previous one. The generation bump makes any answer to the old identity inert.
    this.switchGroupContext(state => ({
      ...state,
      ...clearedGroupContent,
      actorId: agentId,
      selectedGroupId: undefined,
      groups: [],
      listStatus: 'idle',
    }))
    this.syncGroupPoll()
    // Choosing the actor is the only action available in that phase, so it must lead
    // straight to the real group list rather than to another empty screen. The previous
    // actor's in-flight list is already inert, so it must not block this read.
    void this.loadGroups()
  }

  private ensureGroupsLoaded(page: TeamPage): void {
    if (page !== 'groups') return
    if (this.groupClient === undefined) return
    this.syncGroupActors()
    if (this.state.group.listStatus !== 'idle') return
    void this.loadGroups()
  }

  /**
   * A quiet background re-read of the group list while the groups page is visible.
   * It never starts a follow-up page/issue/action read, never shows a loading phase and
   * never settles a parked write: only the merged owner list is applied, and only when
   * the membership/list actually changed.
   */
  private syncGroupPoll(): void {
    const canPoll = this.groupClient !== undefined
      && this.state.open
      && this.state.page === 'groups'
      && this.state.group.actorId !== undefined
    if (!canPoll) {
      this.stopGroupPoll()
      return
    }
    if (this.groupPollTimer !== undefined || this.groupPollInFlight) return
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      if (this.groupPollTimer === timer) this.groupPollTimer = undefined
      void this.pollGroups()
    }, GROUP_LIST_POLL_INTERVAL_MS)
    this.groupPollTimer = timer
    this.scheduleTimer(timer)
  }

  private stopGroupPoll(): void {
    if (this.groupPollTimer === undefined) return
    clearTimeout(this.groupPollTimer)
    this.timers.delete(this.groupPollTimer)
    this.groupPollTimer = undefined
  }

  private async pollGroups(): Promise<void> {
    const client = this.groupClient
    const actorId = this.state.group.actorId
    if (client === undefined || actorId === undefined || !this.state.open || this.state.page !== 'groups') {
      this.stopGroupPoll()
      return
    }
    if (this.groupPollInFlight || this.state.group.listStatus === 'loading') {
      this.syncGroupPoll()
      return
    }
    this.groupPollInFlight = true
    const generation = this.groupGeneration
    let outcome: GroupRequestOutcome
    try {
      outcome = await client.requestGroup(actorId, { kind: 'group.list', requestId: this.nextRequestId() })
    } catch {
      outcome = { kind: 'transport', message: 'Background group list read failed' }
    } finally {
      this.groupPollInFlight = false
    }
    // A late answer from before an identity/group switch is inert here, exactly like every
    // other owner reply; the current view keeps its own content and parked results.
    if (generation === this.groupGeneration
      && this.state.open
      && this.state.page === 'groups'
      && this.state.group.actorId === actorId
      && outcome.kind === 'reply'
      && outcome.reply.kind === 'group.list') {
      this.mergePolledGroups(outcome.reply)
    }
    this.syncGroupPoll()
  }

  /** Apply a polled list only when it changes something; identical answers do not re-render. */
  private mergePolledGroups(reply: Extract<GroupWireReply, { readonly kind: 'group.list' }>): void {
    const current = this.state.group
    const next = applyReply(current, reply, 'group.list')
    const changed = current.access.kind !== 'ready'
      || current.listStatus !== next.listStatus
      || current.selectedGroupId !== next.selectedGroupId
      || current.groups.length !== reply.groups.length
      || JSON.stringify(current.groups) !== JSON.stringify(reply.groups)
    if (!changed) return
    this.updateGroup(() => next)
  }

  async loadGroups(): Promise<boolean> {
    if (this.groupClient === undefined) {
      this.updateGroup(state => applyAccess(state, { kind: 'not-configured', message: 'This Console client carries no group port.' }))
      return false
    }
    this.syncGroupActors()
    if (this.state.group.actorId === undefined) {
      // The workspace renders the actor choice (several candidates) or the typed
      // not-configured state (none) instead of a loading phase that cannot finish.
      this.updateGroup(state => ({ ...state, listStatus: state.groups.length === 0 ? 'idle' : state.listStatus }))
      return false
    }
    this.updateGroup(state => ({ ...state, listStatus: 'loading' }))
    const generation = this.groupGeneration
    const contextBefore = this.composerKey()
    const sent = await this.dispatch({ kind: 'group.list', requestId: '' })
    if (generation !== this.groupGeneration) return false
    if (!sent) {
      this.updateGroup(state => ({ ...state, listStatus: state.groups.length === 0 ? 'idle' : state.listStatus }))
      return false
    }
    // An owner-selected group is the same switch as a user selection: bump the generation,
    // park the old context's pending write, then restore the entered context's own result.
    if (this.composerKey() !== contextBefore) {
      this.switchGroupContext(state => ({ ...state, ...clearedGroupContent }), { composerAlreadySaved: true })
    }
    await this.loadSelectedGroup()
    this.syncGroupPoll()
    return true
  }

  private async loadSelectedGroup(): Promise<void> {
    const groupId = this.state.group.selectedGroupId
    if (groupId === undefined) return
    const generation = this.groupGeneration
    await this.dispatch({ kind: 'message.page', requestId: '', groupId })
    if (generation !== this.groupGeneration) return
    // The group already owns its issues. Read them back so a reopened workspace can open
    // one the user already has instead of asking for an id.
    await this.dispatch({ kind: 'issue.list', requestId: '', groupId })
    if (generation !== this.groupGeneration) return
    // Actions belong to one issue session. With no session loaded the actions area shows its
    // own "create an issue first" state; an actor-wide list is never presented as this group's.
    const sessionId = this.state.group.issue?.sessionId
    if (sessionId === undefined) return
    await this.dispatch({ kind: 'action.list', requestId: '', sessionId })
  }

  async selectGroup(groupId: string): Promise<boolean> {
    if (this.state.group.selectedGroupId === groupId) return true
    this.switchGroupContext(state => ({
      ...state,
      ...clearedGroupContent,
      selectedGroupId: groupId,
    }))
    await this.loadSelectedGroup()
    this.syncGroupPoll()
    return true
  }

  async refreshGroup(): Promise<boolean> {
    return this.loadGroups()
  }

  /** The narrow manage panel is a UI preference, not a group fact; nothing else changes. */
  toggleGroupManageOpen(open: boolean): void {
    this.updateGroup(state => ({ ...state, manageOpen: open }))
  }

  setGroupComposer(text: string): void {
    this.updateGroup(state => ({ ...state, composer: text }))
    const key = this.composerKey()
    if (text.length === 0) this.composerDrafts.delete(key)
    else this.composerDrafts.set(key, text)
  }

  /**
   * Send one frame. A critical frame is parked for confirmation first, so a destructive
   * action always names its target before anything leaves the UI.
   */
  private async send(
    frame: GroupWireRequest,
    options: { readonly skipConfirmation?: boolean; readonly retained?: GroupMutationMemory } = {},
  ): Promise<boolean> {
    if (this.groupClient === undefined) {
      this.updateGroup(state => applyAccess(state, { kind: 'not-configured', message: 'This Console client carries no group port.' }))
      return false
    }
    this.syncGroupActors()
    const actorId = this.state.group.actorId
    if (actorId === undefined) {
      // Nothing is sent without an actor. Zero candidates is a typed not-configured
      // condition; several candidates with none chosen stays a selectable phase so the
      // user can pick one instead of being locked out.
      if (this.state.group.actors.length === 0) {
        this.updateGroup(state => applyAccess(state, { kind: 'not-configured', message: 'No projected agent can act for this group; the Console control owner never acts.' }))
      }
      return false
    }
    if (needsConfirmation(frame) && options.skipConfirmation !== true) {
      const parked = this.frameFor(frame)
      this.updateGroup(state => ({ ...state, confirm: this.mutationMemory(parked), error: undefined }))
      return false
    }
    const built = options.retained === undefined ? this.frameFor(frame) : this.frameFor(frame, options.retained)
    // A read only refreshes its own section. It never becomes a pending write, so its answer
    // can neither be shown as the current operation nor clear another write's unknown state.
    const read = isReadFrame(built.kind)
    const memory = read ? null : this.mutationMemory(built, options.retained)
    const generation = this.groupGeneration
    this.updateGroup(state => ({
      ...state,
      // Only executing the parked action clears it. An unrelated read or refresh must not
      // silently drop a confirmation the user is still looking at.
      confirm: options.retained === undefined ? state.confirm : null,
      mutation: memory === null ? state.mutation : memory,
      outcome: read ? state.outcome : { kind: 'pending', frame: built.kind, requestId: built.requestId },
      error: undefined,
    }))
    const outcome: GroupRequestOutcome = await this.groupClient.requestGroup(actorId, built)
    if (read) {
      if (generation !== this.groupGeneration) return false
      return this.applyReadOutcome(outcome, built)
    }
    if (memory === null) return false
    const createdReply = outcome.kind === 'reply' && outcome.reply.kind === 'group.created'
      ? outcome.reply
      : undefined
    // The actor comparison is never relaxed. A group.create may widen the group part when the
    // owner selects the group it just created, but only in the same generation: a user choice
    // made after the send always bumps the generation and makes the old answer inert.
    const createdGroupSelection = built.kind === 'group.create'
      && memory.context.actorId === (this.state.group.actorId ?? '')
      && generation === this.groupGeneration
      && this.state.group.selectedGroupId !== memory.context.groupId
    const dropped = memory.context.actorId !== (this.state.group.actorId ?? '')
      || (generation !== this.groupGeneration && memory.context.sessionId !== undefined)
      || (generation !== this.groupGeneration && built.kind === 'group.create')
      || (memory.context.groupId !== undefined
        && memory.context.groupId !== this.state.group.selectedGroupId
        && !createdGroupSelection)
      || (memory.context.sessionId !== undefined && memory.context.sessionId !== this.state.group.issue?.sessionId)
    if (dropped) {
      if (createdReply !== undefined) {
        this.parkLateCreatedWrite(memory, { ...memory.context, groupId: createdReply.group.groupId })
      } else {
        this.parkDroppedWrite(memory)
      }
      return false
    }
    // A create answer selects the new group, so it is itself a context switch: older
    // in-flight reads must not land in the new group and the composer must follow it.
    const switchesToCreated = createdReply !== undefined
      && this.state.group.selectedGroupId !== createdReply.group.groupId
    if (switchesToCreated) {
      this.parkComposer()
      this.groupGeneration += 1
      this.updateGroup(state => ({ ...state, confirm: null }))
    }
    const applied = this.applyWriteOutcome(memory, built, outcome)
    if (switchesToCreated) {
      this.restoreComposer()
      this.applyContextResult({ actorId: this.state.group.actorId ?? '', groupId: createdReply!.group.groupId })
    }
    return applied
  }

  /** A read answer only refreshes its own section and never settles a parked write. */
  private applyReadOutcome(outcome: GroupRequestOutcome, built: GroupWireRequest): boolean {
    switch (outcome.kind) {
      case 'reply':
        this.updateGroup(state => applyReply(state, outcome.reply, built.kind))
        return true
      case 'refused':
        this.updateGroup(state => applyRefusal(state, outcome.code, outcome.message, built.kind))
        return false
      case 'access':
        this.updateGroup(state => applyAccess(state, outcome.access))
        return false
      default:
        this.updateGroup(state => applyUnknown(state, built, outcome.message, requestContextOf(this.state.group, built)))
        return false
    }
  }

  /** A write answer settles only where it was sent and is kept under that same context. */
  private applyWriteOutcome(memory: GroupMutationMemory, built: GroupWireRequest, outcome: GroupRequestOutcome): boolean {
    switch (outcome.kind) {
      case 'reply': {
        const next = applyReply(this.state.group, outcome.reply, built.kind)
        this.update({ group: next })
        const context = outcome.reply.kind === 'group.created'
          ? { ...memory.context, groupId: outcome.reply.group.groupId }
          : memory.context
        this.recordResult(context, next)
        return true
      }
      case 'refused': {
        const next = applyRefusal(this.state.group, outcome.code, outcome.message, built.kind)
        this.update({ group: next })
        this.recordResult(memory.context, next)
        return false
      }
      case 'access':
        this.updateGroup(state => applyAccess(state, outcome.access))
        return false
      default: {
        const next = applyUnknown(this.state.group, built, outcome.message, memory.context)
        this.update({ group: next })
        this.recordResult(memory.context, next)
        return false
      }
    }
  }

  async sendGroupMessage(): Promise<boolean> {
    const state = this.state.group
    const groupId = state.selectedGroupId
    if (groupId === undefined) {
      this.updateGroup(current => ({ ...current, error: { code: 'INVALID_INPUT', message: 'Select a group before sending.' } }))
      return false
    }
    const body = state.composer.trim()
    if (body.length === 0) {
      this.updateGroup(current => ({ ...current, error: { code: 'INVALID_INPUT', message: 'Message body is required.' } }))
      return false
    }
    const group = state.groups.find(candidate => candidate.groupId === groupId)
    const targets = group === undefined
      ? []
      : group.members.filter(member => member.intervals.length > 0).map(member => member.agentId)
    if (targets.length === 0) {
      this.updateGroup(current => ({ ...current, error: { code: 'INVALID_INPUT', message: 'This group has no active member to receive the message.' } }))
      return false
    }
    const sent = await this.send({
      kind: 'message.send',
      requestId: '',
      commitId: '',
      groupId,
      targetAgentIds: targets,
      replyRequired: false,
      body,
    })
    if (!sent) return false
    this.updateGroup(current => ({ ...current, composer: '' }))
    this.composerDrafts.delete(this.composerKey())
    await this.dispatch({ kind: 'message.page', requestId: '', groupId })
    return true
  }

  async createGroup(name: string): Promise<boolean> {
    const trimmed = name.trim()
    if (trimmed.length === 0) {
      this.updateGroup(state => ({ ...state, error: { code: 'INVALID_INPUT', message: 'Group name is required.' } }))
      return false
    }
    const sent = await this.send({ kind: 'group.create', requestId: '', name: trimmed })
    // A new group is empty, not unreadable: load its real (empty) first page so the
    // workspace lands on an operable state instead of a loading screen.
    if (sent) await this.loadSelectedGroup()
    return sent
  }

  async inviteMember(groupId: string, agentId: string, role: 'master' | 'peer'): Promise<boolean> {
    return this.send({ kind: 'group.invite', requestId: '', groupId, agentId, role })
  }

  /**
   * Let the acting owner assign work to one member. The edge lives on the owner's own
   * membership, so the frame re-states the owner id, its role, and the widened edge list.
   */
  async grantCommand(memberAgentId: string): Promise<boolean> {
    const state = this.state.group
    const groupId = state.selectedGroupId
    const actorId = state.actorId
    if (groupId === undefined || actorId === undefined) {
      this.updateGroup(current => ({ ...current, error: { code: 'INVALID_INPUT', message: 'Select a group and an acting agent first.' } }))
      return false
    }
    const group = state.groups.find(entry => entry.groupId === groupId)
    const actor = group?.members.find(member => member.agentId === actorId)
    if (group === undefined || actor === undefined) {
      this.updateGroup(current => ({ ...current, error: { code: 'INVALID_INPUT', message: 'The acting agent is not a member of this group.' } }))
      return false
    }
    if (group.ownerAgentId !== actorId) {
      this.updateGroup(current => ({ ...current, error: { code: 'FORBIDDEN', message: 'Only the group owner can widen these edges.' } }))
      return false
    }
    const mastersOf = [...new Set([...actor.mastersOf, memberAgentId])]
    return this.send({ kind: 'group.grant', requestId: '', groupId, agentId: actorId, role: actor.role, mastersOf })
  }

  async createIssue(title: string, body: string, vikunjaProjectId: string): Promise<boolean> {
    const groupId = this.state.group.selectedGroupId
    if (groupId === undefined) {
      this.updateGroup(state => ({ ...state, error: { code: 'INVALID_INPUT', message: 'Select a group before creating an issue.' } }))
      return false
    }
    return this.send({ kind: 'issue.create', requestId: '', commitId: '', groupId, vikunjaProjectId, title, body })
  }

  /**
   * Open one issue this group already owns. An id that is neither in the group's own issue
   * list nor already open is never sent to the owner.
   */
  async openIssue(sessionId: string): Promise<boolean> {
    const group = this.state.group
    const known = group.issue?.sessionId === sessionId
      || group.issues.some(session => session.sessionId === sessionId)
    if (!known) return false
    // A session-bound write that is still open belongs to the issue being left, so it is
    // parked under that issue instead of staying pending or following the new view.
    this.parkInFlightGroupMutation({ issueScopedOnly: true })
    // Opening an issue is a selection change: a later open supersedes this one, so the
    // older query and its follow-up action list are both inert when they answer.
    this.groupGeneration += 1
    // Hide the previous issue's write result before the owner answers for this one. A
    // group-level message result stays visible because it belongs to the whole group.
    this.applyContextResult({ actorId: group.actorId ?? '', groupId: group.selectedGroupId })
    const opened = await this.dispatch({ kind: 'issue.query', requestId: '', sessionId })
    if (!opened) return false
    // The opened issue may own a parked write result; restore it with its original ids.
    this.applyContextResult()
    // Actions belong to the opened session; load them now that it is visible.
    await this.dispatch({ kind: 'action.list', requestId: '', sessionId })
    return true
  }

  async closeIssue(reason: string, conclusion: string): Promise<boolean> {
    const issue = this.state.group.issue
    if (issue === null) {
      this.updateGroup(state => ({ ...state, error: { code: 'INVALID_INPUT', message: 'No issue is loaded for this group.' } }))
      return false
    }
    return this.send({
      kind: 'issue.close',
      requestId: '',
      commitId: '',
      sessionId: issue.sessionId,
      reason,
      conclusion,
    })
  }

  async reopenIssue(reason: string): Promise<boolean> {
    const issue = this.state.group.issue
    if (issue === null) {
      this.updateGroup(state => ({ ...state, error: { code: 'INVALID_INPUT', message: 'No issue is loaded for this group.' } }))
      return false
    }
    return this.send({ kind: 'issue.reopen', requestId: '', commitId: '', sessionId: issue.sessionId, reason })
  }

  async createAction(assigneeAgentId: string, reason: string, expectedResult: string): Promise<boolean> {
    const issue = this.state.group.issue
    if (issue === null) {
      this.updateGroup(state => ({ ...state, error: { code: 'INVALID_INPUT', message: 'Create an issue before creating an action.' } }))
      return false
    }
    return this.send({
      kind: 'action.create',
      requestId: '',
      commitId: '',
      sessionId: issue.sessionId,
      assigneeAgentId,
      actionKind: 'reply',
      reason,
      expectedResult,
      replyRequired: false,
    })
  }

  async submitAction(actionId: string, resultBody: string): Promise<boolean> {
    return this.send({ kind: 'action.submit', requestId: '', resultCommitId: '', actionId, resultBody })
  }

  async refuseAction(actionId: string, reason: string): Promise<boolean> {
    return this.send({ kind: 'action.refuse', requestId: '', actionId, reason })
  }

  async reportAction(actionId: string, report: 'blocked' | 'failed', reason: string): Promise<boolean> {
    return this.send({ kind: 'action.report', requestId: '', actionId, report, reason })
  }

  /** A stored request is only replayable in the identity, group and issue that produced it. */
  private inCurrentContext(memory: GroupMutationMemory): boolean {
    return contextMatches(this.currentViewContext(), memory.context)
  }

  /** Execute the parked critical action after the user confirms its target. */
  async confirmPendingGroupAction(): Promise<boolean> {
    const confirm = this.state.group.confirm
    if (confirm === null) return false
    if (!this.inCurrentContext(confirm)) {
      this.updateGroup(state => ({ ...state, confirm: null }))
      return false
    }
    const sent = await this.send(confirm.frame, { skipConfirmation: true, retained: confirm })
    if (sent) await this.loadSelectedGroup()
    return sent
  }

  cancelPendingGroupAction(): void {
    this.updateGroup(state => ({ ...state, confirm: null }))
  }

  /** Retry a mutation whose owner outcome was never observed, reusing its commit id. */
  async retryGroupMutation(): Promise<boolean> {
    const retryable = this.state.group.retryable
    if (retryable === null) return false
    // Returning to the original context re-enables the retry; a different identity or group
    // never replays another context's write.
    if (!this.inCurrentContext(retryable)) return false
    const sent = await this.send(retryable.frame, { skipConfirmation: true, retained: retryable })
    if (sent) await this.loadSelectedGroup()
    return sent
  }

  private async dispatch(frame: GroupWireRequest): Promise<boolean> {
    return this.send(frame, { skipConfirmation: true })
  }
}
