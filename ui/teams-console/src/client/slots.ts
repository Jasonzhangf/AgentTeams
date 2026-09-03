import type { TeamsConsoleController } from './controller.ts'
import type { AgentPresetBinding, TeamsHostActions, TeamsHostProjection, TeamsMemoryProjection, TeamsNotificationProjection, TeamsSearchProjection } from './model.ts'

export interface TeamsSidebarFace {
  readonly controller: TeamsConsoleController
}

export interface TeamsClientConfig {
  readonly agentPresetBindings?: readonly AgentPresetBinding[]
  readonly settingsNavigation?: SettingsNavigationHandlers
  readonly sessionActions?: SessionActionHandlers
  readonly hostProjection?: TeamsHostProjection
  readonly hostActions?: TeamsHostActions
}

export interface TeamsOverlayFace {
  readonly controller: TeamsConsoleController
  readonly projections?: {
    readonly notifications: TeamsNotificationProjection
    readonly search: TeamsSearchProjection
    readonly memory: TeamsMemoryProjection
  }
  readonly agentPresetBindings?: readonly AgentPresetBinding[]
  readonly settingsNavigation?: SettingsNavigationHandlers
  readonly hostProjection?: TeamsHostProjection
  readonly hostActions?: TeamsHostActions
}

/** Typed navigation hooks exposed by the host. Teams never owns network or config truth. */
export interface SettingsNavigationHandlers {
  readonly openMachineConnection: () => void
  readonly openAgentRuntime: (agentId: string) => void
}

export interface SessionActionHandlers {
  readonly openCurrentAgentSession: (agent: import('./model.ts').AgentFixture, close: () => void) => void
  readonly openSession: (sessionId: string, close: () => void) => void
}
