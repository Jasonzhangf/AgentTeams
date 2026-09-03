import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamsConsoleState } from './controller.ts'
import type { TeamsOverlayFace } from './slots.ts'
import type { TeamsHostActions } from './model.ts'
import type { AgentPresetBinding } from './model.ts'
import type { ConsoleEntry, AgentFixture, DshSessionProjection, TeamsHostProjection, TeamsMemoryProjection, TeamsNotificationProjection, TeamsSearchProjection } from './model.ts'
import { agents, notifications, projectAgentCurrentSessions, projectDshSessionList, referenceProjections, sessions } from './model.ts'
import { Drawer } from './Drawer.tsx'
import css from './teams.module.css'

export type TeamsOverlayProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'teams'>
  & TeamsOverlayFace
  & { readonly agentPresetBindings: readonly AgentPresetBinding[] }
  & { readonly settingsNavigation?: NonNullable<TeamsOverlayFace['settingsNavigation']> }
  & { readonly hostProjection?: TeamsHostProjection }
  & { readonly hostActions?: TeamsHostActions }

const entries: readonly { id: ConsoleEntry; label: string }[] = [
  { id: 'topology', label: 'topology' },
  { id: 'conversations', label: 'conversations' },
  { id: 'notifications', label: 'notifications' },
  { id: 'search', label: 'search' },
  { id: 'memory', label: 'memory' },
]

function agentOf(id: string, liveAgents: readonly AgentFixture[] = agents): AgentFixture | undefined {
  return liveAgents.find(agent => agent.id === id)
}


function StatusDot({ status }: { readonly status: AgentFixture['status'] }): ReactNode {
  return <span className={`${css.statusDot} ${css[`status-${status}`]}`} aria-label={status} />
}

function sessionAvailable(
  sessionId: string | undefined,
  availableSessionIds: ReadonlySet<string>,
): sessionId is string {
  return sessionId !== undefined && availableSessionIds.has(sessionId)
}

function AgentCard({ agent, controller, t, availableSessionIds }: {
  readonly agent: AgentFixture
  readonly controller: TeamsOverlayFace['controller']
  readonly t: TeamsOverlayProps['t']
  readonly availableSessionIds: ReadonlySet<string>
}): ReactNode {
  const currentSessionAvailable = sessionAvailable(agent.currentSessionId, availableSessionIds)
  return (
    <article className={css.agentCard}>
      <div className={css.agentCardTopline}>
        <div className={css.agentIdentity}>
          <StatusDot status={agent.status} />
          <div>
            <strong>{agent.label}</strong>
            <span>{agent.machine}</span>
          </div>
        </div>
        {agent.notificationCount > 0 && (
          <button
            type="button"
            className={css.notificationBadge}
            aria-label={`${agent.notificationCount} ${t('notificationsCount')}`}
            onClick={() => { controller.focusNotifications(agent) }}
          >
            {agent.notificationCount}
          </button>
        )}
      </div>
      <div className={css.agentMeta}>
        <span>{agent.provider} / {agent.model}</span>
        <span>{agent.sessionCount} {t('sessions')}</span>
      </div>
      {agent.relation !== undefined && <span className={css.relation}>{agent.relation}</span>}
      <div className={css.agentActions}>
        <button
          type="button"
          className={css.primaryAction}
          disabled={!currentSessionAvailable}
          onClick={() => { if (currentSessionAvailable) controller.focusCurrentSession(agent) }}
        >
          {agent.currentSessionId === undefined
            ? t('noCurrentSession')
            : currentSessionAvailable ? t('currentSession') : t('sessionUnavailable')}
        </button>
        <button
          type="button"
          className={css.secondaryAction}
          onClick={() => { controller.pushDrawer({ kind: 'agent', agent }) }}
        >
          {t('open')}
        </button>
      </div>
    </article>
  )
}

function TopologyView({ controller, t, availableSessionIds, liveAgents }: Pick<TeamsOverlayProps, 'controller' | 't'> & {
  readonly availableSessionIds: ReadonlySet<string>
  readonly liveAgents: readonly AgentFixture[]
}): ReactNode {
  const machineNames = [...new Set(liveAgents.map(agent => agent.machine))]
  return (
    <div className={css.viewBody}>
      <div className={css.viewHeading}>
        <div>
          <h2>{t('topology')}</h2>
          <p>{t('fixtureNotice')}</p>
        </div>
        <span className={css.summary}>{machineNames.length} {t('machine')} · {liveAgents.length} agents</span>
      </div>
      <div className={css.machineList}>
        {machineNames.map(machine => (
          <section className={css.machineSection} key={machine}>
            <div className={css.machineHeader}>
              <strong>{machine}</strong>
              <span>{t('online')}</span>
            </div>
            <div className={css.agentGrid}>
              {liveAgents.filter(agent => agent.machine === machine).map(agent => (
                <AgentCard key={agent.id} agent={agent} controller={controller} t={t} availableSessionIds={availableSessionIds} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  )
}

function ConversationsView({ controller, t, availableSessionIds }: Pick<TeamsOverlayProps, 'controller' | 't'> & {
  readonly availableSessionIds: ReadonlySet<string>
}): ReactNode {
  return (
    <div className={css.viewBody}>
      <div className={css.viewHeading}>
        <div><h2>{t('conversations')}</h2><p>{t('active')} first, then {t('history')}</p></div>
      </div>
      <div className={css.list}>
        {sessions.map(session => {
          const agent = agentOf(session.agentId)
          if (agent === undefined) return null
          return (
            <button
              type="button"
              className={css.listRow}
              key={session.id}
              disabled={!availableSessionIds.has(session.id)}
              onClick={() => { if (availableSessionIds.has(session.id)) controller.focusSession(agent, session.id) }}
            >
              <span className={css.listState}>{session.state === 'active' ? t('active') : t('history')}</span>
              <span className={css.listCopy}><strong>{session.title}</strong><span>{agent.label} · {session.preview}</span></span>
              <time>{session.updated}</time>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function NotificationsView({ controller, t, availableSessionIds, projection, hostActions }: Pick<TeamsOverlayProps, 'controller' | 't'> & {
  readonly availableSessionIds: ReadonlySet<string>
  readonly projection: TeamsNotificationProjection
  readonly hostActions?: TeamsHostActions
}): ReactNode {
  return (
    <div className={css.viewBody}>
      <div className={css.viewHeading}>
        <div><h2>{t('notifications')}</h2><p>{t('attention')} first</p></div>
      </div>
      <div className={css.list}>
        {projection.items.map(notification => {
          const agent = agentOf(notification.agentId)
          if (agent === undefined) return null
          return (
            <div className={`${css.listRow} ${notification.priority === 'high' ? css.listRowAttention : ''}`} key={notification.id}>
              <button type="button" className={css.listCopy} onClick={() => {
                if (notification.interactive && sessionAvailable(notification.sessionId, availableSessionIds)) controller.focusSession(agent, notification.sessionId)
                else controller.pushDrawer({ kind: 'notifications', agent })
              }}>
              <span className={css.priority}>{notification.priority}</span>
              <span><strong>{notification.title}</strong><span>{agent.label} · {notification.detail}</span></span>
              </button>
              {hostActions !== undefined && !notification.processed && (
                <span className={css.agentActions}>
                  {notification.interactive && notification.sessionId !== undefined && notification.requestId !== undefined && (
                    <span className={css.agentActions}>
                      <button type="button" className={css.primaryAction} onClick={() => { hostActions.replyPermission(notification.sessionId as string, notification.requestId as string, 'once') }}>Allow once</button>
                      <button type="button" className={css.secondaryAction} onClick={() => { hostActions.replyPermission(notification.sessionId as string, notification.requestId as string, 'always') }}>Always</button>
                      <button type="button" className={css.secondaryAction} onClick={() => { hostActions.replyPermission(notification.sessionId as string, notification.requestId as string, 'reject') }}>Reject</button>
                    </span>
                  )}
                  <button
                    type="button"
                    className={css.secondaryAction}
                    aria-label={`Acknowledge ${notification.title}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      hostActions.acknowledgeNotification(notification.id)
                    }}
                  >Ack</button>
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function SearchView({ controller, t, availableSessionIds, projection }: Pick<TeamsOverlayProps, 'controller' | 't'> & {
  readonly availableSessionIds: ReadonlySet<string>
  readonly projection: TeamsSearchProjection
}): ReactNode {
  const result = projection.results[0]
  if (result === undefined) return null
  const agent = agentOf(result.agentId)
  return (
    <div className={css.viewBody}>
      <div className={css.viewHeading}><div><h2>{t('search')}</h2><p>{t('fixtureNotice')}</p></div></div>
      <label className={css.searchBox}>
        <span className={css.visuallyHidden}>{t('search')}</span>
        <input type="search" placeholder={t('searchPlaceholder')} defaultValue="runtime" />
      </label>
      {agent !== undefined && (
          <button
            type="button"
            className={css.searchResult}
            disabled={result.sessionId === undefined || !availableSessionIds.has(result.sessionId)}
            onClick={() => {
              if (result.sessionId !== undefined && availableSessionIds.has(result.sessionId)) controller.focusSession(agent, result.sessionId)
            }}
          >
          <strong>{result.title}</strong>
          <span>{agent.label} · {result.excerpt}</span>
        </button>
      )}
    </div>
  )
}

function MemoryView({ t, projection }: Pick<TeamsOverlayProps, 't'> & { readonly projection: TeamsMemoryProjection }): ReactNode {
  return (
    <div className={css.viewBody}>
      <div className={css.viewHeading}><div><h2>{t('memory')}</h2><p>{t('memoryStatus')}</p></div></div>
      <div className={css.pluginState}>
        <span className={css.stateMarker}>M</span>
        <div><strong>Session memory records</strong><span>Summarize · validate · save · load · export</span></div>
        <span className={css.stateLabel}>{projection.state}</span>
      </div>
    </div>
  )
}

function SettingsContent({
  t,
  settingsNavigation,
}: Pick<TeamsOverlayProps, 't'> & {
  readonly settingsNavigation: { readonly openMachineConnection: () => void; readonly openAgentRuntime: (agentId: string) => void }
}): ReactNode {
  const handlers = settingsNavigation
  const machineBound = settingsNavigation !== undefined
  const agentBound = settingsNavigation !== undefined
  return (
    <div className={css.agentDetail}>
      <div className={css.detailHero}><span className={css.stateMarker}>CFG</span><h3>{t('settings')}</h3></div>
      <p>{t('settingsDescription')}</p>
      <button
        type="button"
        className={css.secondaryAction}
        disabled={!machineBound}
        onClick={() => { handlers.openMachineConnection() }}
      >{t('machineConnection')}</button>
      <button
        type="button"
        className={css.secondaryAction}
        disabled={!agentBound}
        onClick={() => { handlers.openAgentRuntime('planner') }}
      >{t('agentRuntime')}</button>
    </div>
  )
}

const NOOP_SETTINGS = {
  openMachineConnection: () => undefined,
  openAgentRuntime: (_: string) => undefined,
}

function DrawerContent({ drawer, controller, t, availableSessionIds, settingsNavigation }: {
  readonly drawer: TeamsConsoleState['drawers'][number]
  readonly controller: TeamsOverlayFace['controller']
  readonly t: TeamsOverlayProps['t']
  readonly availableSessionIds: ReadonlySet<string>
  readonly settingsNavigation?: TeamsOverlayProps['settingsNavigation']
}): ReactNode {
  const effectiveSettings = settingsNavigation ?? NOOP_SETTINGS
  if (drawer.kind === 'session') {
    return (
      <div className={css.sessionHandoff}>
        <span className={css.handoffMark}>DSH</span>
        <h3>{drawer.agent.currentSessionTitle ?? t('currentSession')}</h3>
        <p>{t('sessionHandoff')}</p>
        <button type="button" className={css.primaryAction} onClick={() => { controller.focusSession(drawer.agent, drawer.sessionId) }}>
          {t('open')}
        </button>
      </div>
    )
  }
  if (drawer.kind === 'notifications') {
    return (
      <div className={css.list}>
        {notifications.filter(item => item.agentId === drawer.agent.id).map(item => (
          <div className={css.notificationDetail} key={item.id}>
            <span className={css.priority}>{item.priority}</span>
            <strong>{item.title}</strong>
            <p>{item.detail}</p>
            {item.sessionId !== undefined && (
              <button
                type="button"
                className={css.primaryAction}
                disabled={!availableSessionIds.has(item.sessionId)}
                onClick={() => {
                  if (availableSessionIds.has(item.sessionId as string)) {
                    controller.focusSession(drawer.agent, item.sessionId as string)
                  }
                }}
              >
                {availableSessionIds.has(item.sessionId) ? t('open') : t('sessionUnavailable')}
              </button>
            )}
          </div>
        ))}
      </div>
    )
  }
  if (drawer.kind === 'settings') {
    return <SettingsContent t={t} settingsNavigation={effectiveSettings} />
  }
  return (
    <div className={css.agentDetail}>
      <div className={css.detailHero}><StatusDot status={drawer.agent.status} /><h3>{drawer.agent.label}</h3></div>
      <dl>
        <div><dt>{t('machine')}</dt><dd>{drawer.agent.machine}</dd></div>
        <div><dt>Provider</dt><dd>{drawer.agent.provider}</dd></div>
        <div><dt>Model</dt><dd>{drawer.agent.model}</dd></div>
        <div><dt>{t('sessions')}</dt><dd>{drawer.agent.sessionCount}</dd></div>
      </dl>
      <button type="button" className={css.primaryAction} onClick={() => { controller.focusCurrentSession(drawer.agent) }}>
        {t('currentSession')}
      </button>
    </div>
  )
}

export function TeamsOverlay({ controller, t, useSessions, projections, agentPresetBindings, settingsNavigation, hostProjection, hostActions }: TeamsOverlayProps): ReactNode {
  const state: TeamsConsoleState = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const sessionsState = useSessions(snapshot => snapshot)
  const availableSessionIds = useMemo(
    () => new Set(hostProjection?.sessions.map(session => session.id) ?? Object.keys(sessionsState?.byId ?? {})),
    [hostProjection, sessionsState],
  )
  const liveAgents = useMemo(() => hostProjection?.agents ?? projectAgentCurrentSessions(
    agents,
    projectDshSessionList({
      ...(sessionsState?.current === undefined ? {} : { current: sessionsState.current }),
      byId: Object.fromEntries(Object.entries(sessionsState?.byId ?? {}).map(([id, session]) => [id, session as DshSessionProjection])),
    }, agentPresetBindings),
    sessionsState?.current,
  ), [agentPresetBindings, hostProjection, sessionsState])
  const topDrawer = state.drawers[state.drawers.length - 1]
  const resolvedProjections = useMemo(() => projections ?? referenceProjections(), [projections])
  const drawerDepth = state.drawers.length
  const activeLabel = useMemo(() => entries.find(entry => entry.id === state.entry)?.label ?? 'topology', [state.entry])

  useEffect(() => {
    if (!state.open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (state.drawers.length > 0) controller.popDrawer()
        else controller.closeConsole()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => { window.removeEventListener('keydown', onKeyDown) }
  }, [controller, state.open, state.drawers.length])

  if (!state.open) return null

  return (
    <div className={`${css.overlay} ${state.expanded ? css.overlayExpanded : ''}`} data-teams-console data-entry={activeLabel}>
      <div className={css.backdrop} onClick={() => { controller.closeConsole() }} />
      <section className={css.console} aria-label={t('entry')}>
        <header className={css.consoleHeader}>
          <div><strong>{t('entry')}</strong><span>{t('fixtureNotice')}</span></div>
          <div className={css.headerActions}>
            <button type="button" className={css.settingsButton} aria-label={t('settings')} title={t('settings')} onClick={() => { controller.pushDrawer({ kind: 'settings' }) }}>CFG</button>
            <button type="button" className={css.closeButton} onClick={() => { controller.closeConsole() }}>{t('close')}</button>
          </div>
        </header>
        <nav className={css.entryNav} aria-label={t('entry')}>
          {entries.map(entry => (
            <button
              type="button"
              className={`${css.entryButton} ${state.entry === entry.id ? css.entryButtonActive : ''}`}
              key={entry.id}
              onClick={() => { controller.selectEntry(entry.id) }}
            >
              {t(entry.id)}
            </button>
          ))}
        </nav>
        {state.entry === 'topology' && <TopologyView controller={controller} t={t} availableSessionIds={availableSessionIds} liveAgents={liveAgents} />}
        {state.entry === 'conversations' && <ConversationsView controller={controller} t={t} availableSessionIds={availableSessionIds} />}
        {state.entry === 'notifications' && <NotificationsView controller={controller} t={t} availableSessionIds={availableSessionIds} projection={hostProjection?.notifications ?? resolvedProjections.notifications} hostActions={hostActions} />}
        {state.entry === 'search' && <SearchView controller={controller} t={t} availableSessionIds={availableSessionIds} projection={resolvedProjections.search} />}
        {state.entry === 'memory' && <MemoryView t={t} projection={resolvedProjections.memory} />}
        {state.notice !== null && <div className={css.notice} role="status">{state.notice}</div>}
        {topDrawer !== undefined && (
          <div className={css.drawerStack}>
            {state.drawers.map((drawer, index) => (
              <Drawer key={`${drawer.kind}-${index}`} drawer={drawer} depth={index} controller={controller} t={t}>
                {index === drawerDepth - 1 && (
                  <DrawerContent
                    drawer={drawer}
                    controller={controller}
                    t={t}
                    availableSessionIds={availableSessionIds}
                    settingsNavigation={settingsNavigation}
                  />
                )}
              </Drawer>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
