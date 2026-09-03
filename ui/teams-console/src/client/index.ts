import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { TeamsKey } from './locale.ts'
import { NS, en, zh } from './locale.ts'
import { TeamsConsoleController } from './controller.ts'
import type { AgentPresetBinding } from './model.ts'
import type { TeamsClientConfig } from './slots.ts'
import { TeamsOverlay } from './TeamsOverlay.tsx'
import { TeamsSidebarAction } from './TeamsSidebarAction.tsx'

declare module '@deepseek-ai/cordis' {
  interface Context {
    teamsConsole: TeamsConsoleController
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    teams: TeamsKey
  }
}

export const inject = ['slots', 'locale', 'sessions']

export function apply(ctx: ClientContext, config: TeamsClientConfig = {}): void {
  const controller = new TeamsConsoleController(
    config.sessionActions === undefined && config.hostActions === undefined ? undefined : (agent) => {
      if (config.hostActions !== undefined && agent.currentSessionId !== undefined) {
        config.hostActions.openSession(agent.currentSessionId)
        controller.closeConsole()
      } else {
        config.sessionActions?.openCurrentAgentSession(agent, () => { controller.closeConsole() })
      }
    },
    config.sessionActions === undefined && config.hostActions === undefined ? undefined : (sessionId) => {
      if (config.hostActions !== undefined) {
        config.hostActions.openSession(sessionId)
        controller.closeConsole()
      } else {
        config.sessionActions?.openSession(sessionId, () => { controller.closeConsole() })
      }
    },
  )
  ctx.provide('teamsConsole', controller)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'teams: dictionaries')

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'teams-console',
    order: 20,
    locale: NS,
    inject: (): { controller: TeamsConsoleController } => ({ controller }),
  }, TeamsSidebarAction))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'teams-console-overlay',
    order: 100,
    locale: NS,
    inject: (): { controller: TeamsConsoleController; agentPresetBindings: readonly AgentPresetBinding[]; settingsNavigation: NonNullable<TeamsClientConfig['settingsNavigation']>; hostProjection?: TeamsClientConfig['hostProjection'] | undefined; hostActions?: TeamsClientConfig['hostActions'] | undefined } => ({
      controller,
      agentPresetBindings: config.agentPresetBindings ?? [],
      settingsNavigation: config.settingsNavigation ?? {
        openMachineConnection: () => undefined,
        openAgentRuntime: () => undefined,
      },
      hostProjection: config.hostProjection,
      hostActions: config.hostActions,
    }),
  }, TeamsOverlay))
}

export type { ConsoleEntry, AgentFixture, SessionFixture, NotificationFixture } from './model.ts'
export { TeamsConsoleController } from './controller.ts'
