import type { AgentFixture, ConsoleEntry } from './model.ts'

export type CurrentSessionOpener = (agent: AgentFixture) => void
export type SessionOpener = (sessionId: string) => void

export type DrawerRequest =
  | { readonly kind: 'agent'; readonly agent: AgentFixture }
  | { readonly kind: 'session'; readonly agent: AgentFixture; readonly sessionId: string }
  | { readonly kind: 'notifications'; readonly agent: AgentFixture }

export interface TeamsConsoleState {
  readonly open: boolean
  readonly entry: ConsoleEntry
  readonly drawers: readonly DrawerRequest[]
  readonly expanded: boolean
  readonly notice: string | null
}

const initialState: TeamsConsoleState = {
  open: false,
  entry: 'topology',
  drawers: [],
  expanded: false,
  notice: null,
}

export class TeamsConsoleController {
  private state: TeamsConsoleState = initialState
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly openCurrentSession?: CurrentSessionOpener,
    private readonly openSessionExternally?: SessionOpener,
  ) {}

  getSnapshot = (): TeamsConsoleState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private update(next: TeamsConsoleState): void {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  openConsole(): void {
    this.update({ ...this.state, open: true, notice: null })
  }

  closeConsole(): void {
    this.update({ ...initialState })
  }

  selectEntry(entry: ConsoleEntry): void {
    this.update({ ...this.state, entry, drawers: [], expanded: false, notice: null })
  }

  pushDrawer(drawer: DrawerRequest): void {
    this.update({ ...this.state, drawers: [...this.state.drawers, drawer], notice: null })
  }

  popDrawer(): void {
    const drawers = this.state.drawers.slice(0, -1)
    this.update({ ...this.state, drawers, expanded: drawers.length === 0 ? false : this.state.expanded })
  }

  toggleExpanded(): void {
    if (this.state.drawers.length === 0) return
    this.update({ ...this.state, expanded: !this.state.expanded })
  }

  focusCurrentSession(agent: AgentFixture): void {
    if (agent.currentSessionId === undefined) {
      this.update({ ...this.state, notice: `${agent.label}: ${'No current session'}` })
      return
    }
    if (this.openCurrentSession !== undefined) {
      this.openCurrentSession(agent)
      return
    }
    this.pushDrawer({ kind: 'session', agent, sessionId: agent.currentSessionId })
  }

  focusSession(agent: AgentFixture, sessionId: string): void {
    if (this.openSessionExternally !== undefined) {
      this.openSessionExternally(sessionId)
      return
    }
    this.pushDrawer({ kind: 'session', agent, sessionId })
  }

  focusNotifications(agent: AgentFixture): void {
    this.pushDrawer({ kind: 'notifications', agent })
  }

  showNotice(notice: string): void {
    this.update({ ...this.state, notice })
  }
}

export { initialState as teamsConsoleInitialState }
