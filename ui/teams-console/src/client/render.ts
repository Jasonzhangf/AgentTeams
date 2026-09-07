import type { ConsoleEntry, UiStatus } from './model.ts'
import { modelLabel, projectAgents, projectConfig, projectNotifications, projectSessionFlow, projectSessions, providerById, providerLabel } from './model.ts'
import type { ConsoleState, DrawerState, ProviderDraft, TeamsConsoleController } from './controller.ts'
import { messages, type Locale, type MessageKey } from './locale.ts'
import type { ConsoleProviderView, JsonValue } from './protocol.ts'

const entries: readonly ConsoleEntry[] = ['topology', 'conversations', 'notifications', 'search', 'memory']
const agentBrowserIcon = new URL('../../assets/agentbrowser-icon.jpg', import.meta.url).toString()

type RenderOptions = { readonly fixtureLabel?: string }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag)
  if (className !== undefined) value.className = className
  return value
}

function append(parent: Node, ...children: readonly (Node | string | null | undefined)[]): void {
  for (const child of children) {
    if (child === null || child === undefined) continue
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

function button(
  label: string,
  className: string,
  action: () => void | Promise<void>,
  disabled = false,
  focusKey?: string,
): HTMLButtonElement {
  const value = element('button', `teams-button ${className}`)
  value.type = 'button'
  value.textContent = label
  value.disabled = disabled
  if (focusKey !== undefined) value.dataset.focusKey = focusKey
  value.addEventListener('click', async () => { await action() })
  return value
}

function heading(title: string): HTMLElement {
  const value = element('div')
  const titleNode = element('h1', 'teams-view-title')
  titleNode.textContent = title
  append(value, titleNode)
  return value
}

function statusPill(text: string, className = ''): HTMLElement {
  const value = element('span', `teams-status-pill ${className}`)
  value.textContent = text
  return value
}

function emptyState(text: string): HTMLElement {
  const value = element('div', 'teams-empty')
  value.textContent = text
  return value
}

function errorState(message: string, retry: () => Promise<void>, t: Record<MessageKey, string>): HTMLElement {
  const value = element('div', 'teams-error-panel')
  const title = element('strong')
  title.textContent = t.projectionError
  const detail = element('span')
  detail.textContent = message
  append(value, title, detail, button(t.retry, 'teams-button-secondary', retry))
  return value
}

function actionDisabled(state: ConsoleState): boolean {
  return state.busy !== null
}

function agentName(projection: ConsoleState['projection'], agentId: string, t: Record<MessageKey, string>): string {
  return projection?.agents.find(agent => agent.agentId === agentId)?.label ?? `${t.unknownAgent} (${agentId})`
}

function presenceLabel(presence: UiStatus, t: Record<MessageKey, string>): string {
  return presence === 'online' ? t.online : presence === 'offline' ? t.offline : t.unknown
}

function renderViewHeader(title: string, count: string | undefined): HTMLElement {
  const value = element('div', 'teams-view-header')
  append(value, heading(title), count === undefined ? null : statusPill(count))
  return value
}

function renderTopology(controller: TeamsConsoleController, state: ConsoleState, t: Record<MessageKey, string>): HTMLElement {
  const value = element('section')
  const projection = state.projection
  if (projection === null) return value
  const agents = projectAgents(projection)
  append(value, renderViewHeader(t.topology, `${agents.length} ${t.agents}`))
  if (agents.length === 0) {
    append(value, emptyState(t.empty))
    return value
  }
  const grid = element('div', 'teams-grid')
  for (const agent of agents) {
    const card = element('article', 'teams-agent-card')
    const header = element('div', 'teams-card-header')
    const identity = element('div', 'teams-identity')
    if (agent.capabilities.includes('browser')) {
      const icon = element('img', 'teams-agent-icon')
      icon.src = agentBrowserIcon
      icon.alt = `${agent.label} icon`
      icon.width = 32
      icon.height = 32
      append(identity, icon)
    }
    const presence = element('span', `teams-presence teams-presence-${agent.presence}`)
    presence.setAttribute('aria-label', presenceLabel(agent.presence, t))
    const copy = element('div', 'teams-identity-copy')
    const name = element('strong')
    name.textContent = agent.label
    const machine = element('span')
    machine.textContent = `${agent.machineId} · ${presenceLabel(agent.presence, t)}`
    append(copy, name, machine)
    append(identity, presence, copy)
    append(header, identity, statusPill(`${agent.notificationCount} ${t.notifications}`))

    const meta = element('div', 'teams-agent-meta')
    if (agent.providerId !== undefined) {
      const providerMeta = element('span')
      const providerStrong = element('strong')
      providerStrong.textContent = agent.providerId
      append(providerMeta, `${t.provider}: `, providerStrong)
      append(meta, providerMeta)
    }
    if (agent.modelId !== undefined) {
      const modelMeta = element('span')
      const modelStrong = element('strong')
      modelStrong.textContent = agent.modelId
      append(modelMeta, `${t.model}: `, modelStrong)
      append(meta, modelMeta)
    }
    if (agent.sessionCount > 0) {
      const count = element('span')
      count.textContent = `${agent.sessionCount} ${t.sessions}`
      append(meta, count)
    }

    const capability = element('span', 'teams-field-hint')
    capability.textContent = agent.capabilities.length === 0 ? `${t.capabilities}: —` : `${t.capabilities}: ${agent.capabilities.join(', ')}`

    const actions = element('div', 'teams-card-actions')
    const current = agent.currentSessionId
    const sessionExists = current !== undefined && projection.sessions.some(session => session.sessionId === current && session.agentId === agent.agentId)
    if (current !== undefined && sessionExists) {
      append(actions, button(
        t.currentSession,
        'teams-button-primary',
        async () => {
          controller.openSession(agent.agentId, current)
          await controller.openSessionCommand(agent.agentId, current)
        },
        actionDisabled(state),
        `agent:${agent.agentId}:current-session`,
      ))
    }
    append(actions, button(t.details, 'teams-button-secondary', () => { controller.openAgent(agent.agentId) }, actionDisabled(state), `agent:${agent.agentId}:details`))
    if (projection.configs.some(config => config.agentId === agent.agentId)) {
      append(actions, button(t.configure, 'teams-button-secondary', () => { controller.openSettings(agent.agentId) }, actionDisabled(state), `agent:${agent.agentId}:configure`))
    }
    append(card, header, meta.childElementCount === 0 ? null : meta, capability, actions)
    append(grid, card)
  }
  append(value, grid)
  return value
}

function renderConversations(controller: TeamsConsoleController, state: ConsoleState, t: Record<MessageKey, string>): HTMLElement {
  const value = element('section')
  const projection = state.projection
  if (projection === null) return value
  const sessions = projectSessions(projection)
  append(value, renderViewHeader(t.conversations, `${sessions.length} ${t.sessions}`))
  if (sessions.length === 0) {
    append(value, emptyState(t.empty))
    return value
  }
  const list = element('div', 'teams-list')
  for (const session of sessions) {
    const item = element('article', 'teams-list-item')
    const main = element('div', 'teams-list-main')
    const primary = element('strong', 'teams-list-primary')
    primary.textContent = session.title ?? t.sessionUntitled
    const secondary = element('span', 'teams-list-secondary')
    secondary.textContent = `${agentName(projection, session.agentId, t)} · ${session.sessionId}`
    append(main, primary, secondary)
    const actions = element('div', 'teams-list-actions')
    append(actions, button(t.openSession, 'teams-button-primary', async () => {
      controller.openSession(session.agentId, session.sessionId)
      await controller.openSessionCommand(session.agentId, session.sessionId)
    }, actionDisabled(state), `session:${session.agentId}:${session.sessionId}`))
    append(item, main, actions)
    append(list, item)
  }
  append(value, list)
  return value
}

function renderNotifications(controller: TeamsConsoleController, state: ConsoleState, t: Record<MessageKey, string>): HTMLElement {
  const value = element('section')
  const projection = state.projection
  if (projection === null) return value
  const notifications = projectNotifications(projection)
  const pending = notifications.filter(notification => notification.state === 'pending').length
  append(value, renderViewHeader(t.notifications, `${pending} ${t.pending}`))
  if (notifications.length === 0) {
    append(value, emptyState(t.empty))
    return value
  }
  const list = element('div', 'teams-list')
  for (const notification of notifications) {
    const item = element('article', `teams-list-item ${notification.state === 'pending' ? 'teams-notification-pending' : ''}`)
    const main = element('div', 'teams-list-main')
    const kind = element('span', 'teams-notification-kind')
    kind.textContent = notification.kind === 'permission' ? t.permission : t.notice
    const primary = element('strong', 'teams-list-primary')
    primary.textContent = notification.title
    const secondary = element('span', 'teams-list-secondary')
    secondary.textContent = [
      agentName(projection, notification.agentId, t),
      notification.state === 'pending' ? t.pending : t.resolved,
      notification.priority,
      notification.occurredAt,
    ].filter(value => value !== undefined).join(' · ')
    const notificationDetail = notification.detail
    let detail: HTMLElement | null = null
    if (notificationDetail !== undefined) {
      detail = element('span', 'teams-list-secondary')
      detail.textContent = notificationDetail
    }
    append(main, kind, primary, secondary, detail)
    const actions = element('div', 'teams-list-actions')
    const sessionTargetExists = notification.sessionId !== undefined && projection.sessions.some(session => session.agentId === notification.agentId && session.sessionId === notification.sessionId)
    if (sessionTargetExists) {
      append(actions, button(t.openSession, 'teams-button-secondary', () => {
        controller.openSession(notification.agentId, notification.sessionId as string)
      }, actionDisabled(state), `notification:${notification.notificationId}:session`))
    }
    if (notification.kind === 'permission' && notification.state === 'pending' && sessionTargetExists && notification.permissionId !== undefined) {
      append(actions,
        button(t.allowOnce, 'teams-button-primary', async () => { await controller.replyPermission(notification.agentId, notification.sessionId as string, notification.permissionId as string, 'once') }, actionDisabled(state)),
        button(t.alwaysAllow, 'teams-button-secondary', async () => { await controller.replyPermission(notification.agentId, notification.sessionId as string, notification.permissionId as string, 'always') }, actionDisabled(state)),
        button(t.reject, 'teams-button-danger', async () => { await controller.replyPermission(notification.agentId, notification.sessionId as string, notification.permissionId as string, 'reject') }, actionDisabled(state)),
      )
    } else if (notification.kind === 'permission' && notification.state === 'pending' && !sessionTargetExists) {
      const error = element('span', 'teams-inline-error')
      error.textContent = t.invalidNotificationTarget
      append(actions, error)
    }
    if (notification.state === 'pending') {
      append(actions, button(t.acknowledge, 'teams-button-secondary', async () => { await controller.acknowledge(notification.notificationId, notification.agentId) }, actionDisabled(state)))
    }
    append(item, main, actions)
    append(list, item)
  }
  append(value, list)
  return value
}

function renderSearch(controller: TeamsConsoleController, state: ConsoleState, t: Record<MessageKey, string>, root: HTMLElement): HTMLElement {
  const value = element('section')
  const projection = state.projection
  if (projection === null) return value
  append(value, renderViewHeader(t.search, undefined))
  const label = element('label', 'teams-field teams-search')
  const labelText = element('span')
  labelText.textContent = t.search
  const input = element('input', 'teams-input')
  input.type = 'search'
  input.placeholder = t.searchPlaceholder
  input.value = state.query
  input.addEventListener('input', () => {
    controller.setQuery(input.value)
    const next = root.querySelector<HTMLInputElement>('.teams-search input')
    if (next !== null) {
      next.focus()
      next.setSelectionRange(next.value.length, next.value.length)
    }
  })
  append(label, labelText, input)
  append(value, label)

  const query = state.query.trim().toLocaleLowerCase()
  const results = [
    ...projection.sessions.map(session => ({ title: session.title ?? t.sessionUntitled, detail: `${agentName(projection, session.agentId, t)} · ${session.sessionId}`, agentId: session.agentId, sessionId: session.sessionId })),
    ...projection.notifications.map(notification => ({ title: notification.title, detail: `${agentName(projection, notification.agentId, t)} · ${notification.kind}`, agentId: notification.agentId, sessionId: notification.sessionId })),
  ].filter(result => query.length === 0 || `${result.title} ${result.detail}`.toLocaleLowerCase().includes(query))
  if (results.length === 0) {
    append(value, emptyState(t.noResults))
    return value
  }
  const list = element('div', 'teams-list')
  for (const result of results) {
    const item = element('article', 'teams-list-item')
    const main = element('div', 'teams-list-main')
    const primary = element('strong', 'teams-list-primary')
    primary.textContent = result.title
    const secondary = element('span', 'teams-list-secondary')
    secondary.textContent = result.detail
    append(main, primary, secondary)
    const actions = element('div', 'teams-list-actions')
    if (result.sessionId !== undefined) append(actions, button(t.openSession, 'teams-button-primary', () => { controller.openSession(result.agentId, result.sessionId as string) }, actionDisabled(state), `search:${result.agentId}:${result.sessionId}`))
    append(item, main, actions)
    append(list, item)
  }
  append(value, list)
  return value
}

function renderMemory(t: Record<MessageKey, string>): HTMLElement {
  const value = element('section')
  append(value, renderViewHeader(t.memory, undefined))
  const panel = element('div', 'teams-memory-panel')
  panel.textContent = t.memoryUnavailable
  append(value, panel)
  return value
}

function renderAgentDetail(controller: TeamsConsoleController, state: ConsoleState, agentId: string, t: Record<MessageKey, string>): HTMLElement {
  const value = element('div', 'teams-composer')
  const projection = state.projection
  const agent = projection?.agents.find(candidate => candidate.agentId === agentId)
  if (agent === undefined) {
    append(value, emptyState(t.unknownAgent))
    return value
  }
  const title = element('h3')
  title.textContent = agent.label
  const intro = element('p')
  intro.textContent = `${agent.machineId} · ${presenceLabel(agent.presence, t)} · ${agent.capabilities.length} ${t.capabilities}`
  const actions = element('div', 'teams-button-row')
  const sessionExists = agent.currentSessionId !== undefined && projection?.sessions.some(session => session.agentId === agent.agentId && session.sessionId === agent.currentSessionId) === true
  if (agent.currentSessionId !== undefined && sessionExists) {
    append(actions, button(t.currentSession, 'teams-button-primary', async () => {
      controller.openSession(agent.agentId, agent.currentSessionId as string)
      await controller.openSessionCommand(agent.agentId, agent.currentSessionId as string)
    }, actionDisabled(state), `drawer-agent:${agent.agentId}:current-session`))
  }
  if (projection?.configs.some(config => config.agentId === agent.agentId) === true) {
    append(actions, button(t.configure, 'teams-button-secondary', () => { controller.openSettings(agent.agentId) }, actionDisabled(state), `drawer-agent:${agent.agentId}:configure`))
  }
  append(value, title, intro, actions)
  return value
}

function renderSessionDrawer(controller: TeamsConsoleController, state: ConsoleState, agentId: string, sessionId: string, t: Record<MessageKey, string>): HTMLElement {
  const value = element('form', 'teams-composer')
  const session = state.projection?.sessions.find(candidate => candidate.agentId === agentId && candidate.sessionId === sessionId)
  const title = element('h3')
  title.textContent = session?.title ?? t.sessionUntitled
  const description = element('p')
  description.textContent = `${agentName(state.projection, agentId, t)} · ${sessionId}`
  const activity = element('section', 'teams-session-activity')
  const activityTitle = element('h4')
  activityTitle.textContent = t.activity
  append(activity, activityTitle)
  if (state.projection?.sessionEvents === undefined) {
    append(activity, emptyState(t.activityUnavailable))
  } else {
    const events = projectSessionFlow(state.projection, agentId, sessionId)
    if (events.length === 0) {
      append(activity, emptyState(t.activityEmpty))
    } else {
      const timeline = element('ol', 'teams-session-timeline')
      for (const event of events) {
        const item = element('li', `teams-session-event teams-session-event-${event.kind}`)
        const eventHeader = element('div', 'teams-session-event-header')
        const kind = element('span', 'teams-notification-kind')
        kind.textContent = event.kind
        const eventTitle = element('strong')
        eventTitle.textContent = event.title
        append(eventHeader, kind, eventTitle, event.state === undefined ? null : statusPill(event.state), event.occurredAt === undefined ? null : statusPill(event.occurredAt))
        const detailText = event.detail
        let detail: HTMLElement | null = null
        if (detailText !== undefined) {
          detail = element('pre', 'teams-session-event-detail')
          detail.textContent = detailText
        }
        const eventActions = element('div', 'teams-button-row')
        if (event.kind === 'approval' && event.state === 'pending' && event.permissionId !== undefined) {
          const permissionId = event.permissionId
          append(eventActions,
            button(t.allowOnce, 'teams-button-primary', async () => { await controller.replyPermission(agentId, sessionId, permissionId, 'once') }, actionDisabled(state)),
            button(t.alwaysAllow, 'teams-button-secondary', async () => { await controller.replyPermission(agentId, sessionId, permissionId, 'always') }, actionDisabled(state)),
            button(t.reject, 'teams-button-danger', async () => { await controller.replyPermission(agentId, sessionId, permissionId, 'reject') }, actionDisabled(state)),
          )
        }
        append(item, eventHeader, detail, eventActions.childElementCount === 0 ? null : eventActions)
        append(timeline, item)
      }
      append(activity, timeline)
    }
  }
  const label = element('label', 'teams-field')
  const labelText = element('span')
  labelText.textContent = t.message
  const textarea = element('textarea', 'teams-textarea')
  textarea.required = true
  textarea.placeholder = t.message
  textarea.setAttribute('aria-required', 'true')
  append(label, labelText, textarea)
  const actions = element('div', 'teams-button-row')
  append(actions, button(t.openSession, 'teams-button-secondary', async () => { await controller.openSessionCommand(agentId, sessionId) }, actionDisabled(state)))
  const sendMessage = async (): Promise<void> => {
    if (textarea.value.trim().length === 0) {
      textarea.setCustomValidity(t.messageRequired)
      textarea.reportValidity()
      return
    }
    textarea.setCustomValidity('')
    const payload: JsonValue = { text: textarea.value }
    await controller.sendSession(agentId, sessionId, payload)
    if (controller.getSnapshot().error === null) textarea.value = ''
  }
  const send = button(t.send, 'teams-button-primary', () => undefined, actionDisabled(state))
  send.type = 'submit'
  append(actions, send)
  value.addEventListener('submit', async event => {
    event.preventDefault()
    await sendMessage()
  })
  append(value, title, description, activity, label, actions)
  return value
}

function inputField<T extends keyof ProviderDraft>(labelText: string, draft: ProviderDraft, key: T, controller: TeamsConsoleController, type: 'text' | 'url' = 'text'): HTMLElement {
  const label = element('label', 'teams-field')
  const title = element('span')
  title.textContent = labelText
  const input = element('input', 'teams-input')
  input.type = type
  input.value = String(draft[key])
  input.addEventListener('input', () => { controller.setProviderDraft(key, input.value as ProviderDraft[T]) })
  append(label, title, input)
  return label
}

function renderProviderForm(controller: TeamsConsoleController, state: ConsoleState, agentId: string, t: Record<MessageKey, string>): HTMLElement {
  const draft = state.providerDraft
  const form = element('form', 'teams-config-form')
  const title = element('h3')
  title.textContent = state.editingProviderId === undefined ? t.addProvider : t.editProvider
  const fields = element('div', 'teams-field-grid')
  append(fields,
    inputField(t.providerId, draft, 'id', controller),
    inputField(t.providerLabel, draft, 'label', controller),
    inputField(t.apiBaseUrl, draft, 'apiBaseUrl', controller, 'url'),
  )
  const protocolLabel = element('label', 'teams-field')
  const protocolTitle = element('span')
  protocolTitle.textContent = t.protocol
  const protocol = element('select', 'teams-select')
  for (const value of ['openai-chat', 'openai-responses'] as const) {
    const option = element('option')
    option.value = value
    option.textContent = value
    option.selected = draft.protocol === value
    protocol.append(option)
  }
  protocol.addEventListener('change', () => { controller.setProviderDraft('protocol', protocol.value as ProviderDraft['protocol']) })
  append(protocolLabel, protocolTitle, protocol)

  const authLabel = element('label', 'teams-field')
  const authTitle = element('span')
  authTitle.textContent = t.authKind
  const auth = element('select', 'teams-select')
  for (const value of ['none', 'bearer'] as const) {
    const option = element('option')
    option.value = value
    option.textContent = value === 'none' ? t.noAuth : t.bearer
    option.selected = draft.authKind === value
    auth.append(option)
  }
  auth.addEventListener('change', () => { controller.setProviderAuthKind(auth.value as ProviderDraft['authKind']) })
  append(authLabel, authTitle, auth)
  append(fields, protocolLabel, authLabel)

  if (draft.authKind === 'bearer') {
    const credential = inputField(t.credentialRef, draft, 'credentialRef', controller)
    credential.classList.add('teams-field-full')
    const hint = element('span', 'teams-field-hint')
    hint.textContent = t.credentialHint
    credential.append(hint)
    append(fields, credential)
  }

  const enabled = element('label', 'teams-checkbox teams-field-full')
  const checkbox = element('input')
  checkbox.type = 'checkbox'
  checkbox.checked = draft.enabled
  checkbox.addEventListener('change', () => { controller.setProviderDraft('enabled', checkbox.checked) })
  const enabledText = element('span')
  enabledText.textContent = t.enabled
  append(enabled, checkbox, enabledText)
  append(fields, enabled)

  const actions = element('div', 'teams-button-row')
  append(actions,
    button(t.saveProvider, 'teams-button-primary', async () => { await controller.putProvider(agentId) }, actionDisabled(state)),
    button(t.cancel, 'teams-button-secondary', () => { controller.closeProviderForm() }, actionDisabled(state)),
  )
  form.addEventListener('submit', async event => {
    event.preventDefault()
    await controller.putProvider(agentId)
  })
  append(form, title, fields, actions)
  return form
}

function catalogClass(state: ConsoleProviderView['catalogState']): string {
  return state === 'ready' ? 'is-ready' : state === 'empty' ? 'is-empty' : state === 'error' ? 'is-error' : ''
}

function renderProviderCard(controller: TeamsConsoleController, state: ConsoleState, agentId: string, provider: ConsoleProviderView, modelId: string | undefined, t: Record<MessageKey, string>): HTMLElement {
  const card = element('article', 'teams-provider-card')
  const header = element('div', 'teams-provider-header')
  const titleGroup = element('div', 'teams-identity-copy')
  const title = element('h3', 'teams-provider-title')
  title.textContent = providerLabel(provider)
  const meta = element('span', 'teams-provider-meta')
  meta.textContent = `${provider.id} · ${provider.protocol} · ${provider.apiBaseUrl}`
  append(titleGroup, title, meta)
  const catalog = element('span', `teams-catalog-state ${catalogClass(provider.catalogState)}`)
  catalog.textContent = provider.catalogState === 'ready' ? t.catalogReady : provider.catalogState === 'empty' ? t.catalogEmpty : provider.catalogState === 'error' ? t.catalogError : t.catalogStale
  append(header, titleGroup, catalog)
  const details = element('div', 'teams-provider-details')
  if (provider.error !== undefined) {
    const error = element('span', 'teams-field-hint')
    error.textContent = `${provider.error.code}: ${provider.error.message}`
    append(details, error)
  }
  const actions = element('div', 'teams-provider-actions')
  append(actions,
    button(t.editProvider, 'teams-button-secondary', () => { controller.editProvider(provider) }, actionDisabled(state)),
    button(t.refreshModels, 'teams-button-secondary', async () => { await controller.refreshModels(agentId, provider.id) }, actionDisabled(state)),
  )
  const modelRow = element('div', 'teams-model-row')
  const modelField = element('label', 'teams-field')
  const modelTitle = element('span')
  modelTitle.textContent = t.selectModel
  const select = element('select', 'teams-select')
  const unknown = modelId !== undefined && !provider.models.some(model => model.id === modelId)
  const placeholder = element('option')
  placeholder.value = ''
  placeholder.textContent = unknown ? `${t.unknownModel}: ${modelId}` : provider.models.length === 0 ? t.noModels : t.selectModel
  placeholder.selected = !provider.models.some(model => model.id === modelId)
  placeholder.disabled = provider.models.length > 0 && !unknown
  select.append(placeholder)
  for (const model of provider.models) {
    const option = element('option')
    option.value = model.id
    option.textContent = model.label ?? model.id
    option.selected = model.id === modelId
    select.append(option)
  }
  append(modelField, modelTitle, select)
  const bind = button(t.bindModel, 'teams-button-primary', async () => { await controller.bindModel(agentId, provider.id, select.value) }, actionDisabled(state) || provider.models.length === 0 || select.value.length === 0)
  select.addEventListener('change', () => { bind.disabled = actionDisabled(controller.getSnapshot()) || select.value.length === 0 })
  append(modelRow, modelField, bind)
  append(details, actions, modelRow)
  append(card, header, details)
  return card
}

function renderSettings(controller: TeamsConsoleController, state: ConsoleState, t: Record<MessageKey, string>): HTMLElement {
  const value = element('div')
  const projection = state.projection
  if (projection === null) return value
  const toolbar = element('div', 'teams-config-toolbar')
  const agentField = element('label', 'teams-field')
  const agentTitle = element('span')
  agentTitle.textContent = t.selectAgent
  const select = element('select', 'teams-select')
  const placeholder = element('option')
  placeholder.value = ''
  placeholder.textContent = t.selectAgent
  placeholder.selected = state.selectedAgentId === undefined
  select.append(placeholder)
  for (const agent of projection.agents) {
    const option = element('option')
    option.value = agent.agentId
    option.textContent = agent.label
    option.selected = state.selectedAgentId === agent.agentId
    select.append(option)
  }
  select.addEventListener('change', () => { if (select.value.length > 0) controller.selectAgent(select.value) })
  append(agentField, agentTitle, select)
  append(toolbar, agentField, button(t.addProvider, 'teams-button-primary', () => { controller.beginAddProvider() }, actionDisabled(state)))
  append(value, renderViewHeader(t.settings, undefined), toolbar)

  const agentId = state.selectedAgentId
  if (agentId === undefined) {
    append(value, emptyState(t.selectAgent))
    return value
  }
  const config = projectConfig(projection, agentId)
  if (config === undefined) {
    append(value, emptyState(t.noAgentConfig))
    return value
  }
  const revisions = element('div', 'teams-revision-row')
  const accepted = element('span', 'teams-revision')
  append(accepted, `${t.acceptedRevision}: `, element('strong'))
  ;(accepted.lastChild as HTMLElement).textContent = String(config.acceptedRevision)
  const effective = element('span', 'teams-revision')
  append(effective, `${t.effectiveRevision}: `, element('strong'))
  ;(effective.lastChild as HTMLElement).textContent = config.effectiveRevision === undefined ? t.notApplied : String(config.effectiveRevision)
  append(revisions, accepted, effective)
  append(value, revisions)
  if (config.error !== undefined) {
    const error = element('div', 'teams-error-panel')
    error.textContent = `${config.error.code}: ${config.error.message}`
    append(value, error)
  }
  if (state.providerFormOpen) {
    append(value, renderProviderForm(controller, state, agentId, t))
  }
  if (config.providers.length === 0) {
    append(value, emptyState(t.addProvider))
  } else {
    const providers = element('div', 'teams-provider-list')
    const agent = projection.agents.find(candidate => candidate.agentId === agentId)
    for (const provider of config.providers) append(providers, renderProviderCard(controller, state, agentId, provider, agent?.providerId === provider.id ? agent.modelId : undefined, t))
    append(value, providers)
  }
  const footer = element('div', 'teams-footer-row')
  append(footer, button(t.applyConfig, 'teams-button-primary', async () => { await controller.applyConfig(agentId) }, actionDisabled(state)))
  append(value, footer)
  return value
}

function drawerTitle(drawer: DrawerState, state: ConsoleState, t: Record<MessageKey, string>): { readonly title: string; readonly subtitle: string } {
  if (drawer.kind === 'settings') return { title: t.settings, subtitle: t.providerConfig }
  if (drawer.kind === 'session') return { title: state.projection?.sessions.find(session => session.sessionId === drawer.sessionId)?.title ?? t.sessionUntitled, subtitle: `${agentName(state.projection, drawer.agentId, t)} · ${drawer.sessionId}` }
  return { title: agentName(state.projection, drawer.agentId, t), subtitle: state.projection?.agents.find(agent => agent.agentId === drawer.agentId)?.machineId ?? drawer.agentId }
}

function renderDrawer(controller: TeamsConsoleController, state: ConsoleState, t: Record<MessageKey, string>): HTMLElement | null {
  const drawer = state.drawer
  if (drawer === null) return null
  const layer = element('div', 'teams-drawer-layer')
  const value = element('section', `teams-drawer ${state.drawerExpanded ? 'is-expanded' : ''}`)
  value.setAttribute('role', 'dialog')
  value.setAttribute('aria-modal', 'true')
  value.setAttribute('aria-label', drawerTitle(drawer, state, t).title)
  const header = element('header', 'teams-drawer-header')
  header.tabIndex = 0
  const grip = element('span', 'teams-drawer-grip')
  grip.setAttribute('aria-hidden', 'true')
  grip.tabIndex = 0
  const titleGroup = element('div', 'teams-drawer-heading')
  const title = element('strong')
  title.textContent = drawerTitle(drawer, state, t).title
  const subtitle = element('span')
  subtitle.textContent = drawerTitle(drawer, state, t).subtitle
  append(titleGroup, title, subtitle)
  const actions = element('div', 'teams-header-actions')
  if (state.drawerStack.length > 1) {
    append(actions, button(t.back, 'teams-button-secondary', () => { controller.closeDrawer() }, false))
  }
  append(actions,
    button(state.drawerExpanded ? t.collapse : t.expand, 'teams-button-secondary', () => { controller.toggleDrawerExpanded() }, actionDisabled(state)),
    button(t.close, 'teams-button-secondary', () => { controller.closeDrawer() }, false),
  )
  append(header, grip, titleGroup, actions)
  let startY: number | null = null
  grip.addEventListener('pointerdown', event => { startY = event.clientY; grip.setPointerCapture(event.pointerId) })
  grip.addEventListener('pointerup', event => {
    if (startY === null) return
    const delta = event.clientY - startY
    startY = null
    if (delta < -48) controller.toggleDrawerExpanded()
    if (delta > 48) controller.closeDrawer()
  })
  header.addEventListener('keydown', event => {
    if (event.key === 'ArrowUp') { event.preventDefault(); controller.toggleDrawerExpanded() }
    if (event.key === 'ArrowDown') { event.preventDefault(); controller.closeDrawer() }
  })
  const body = element('div', 'teams-drawer-body')
  if (drawer.kind === 'agent') append(body, renderAgentDetail(controller, state, drawer.agentId, t))
  if (drawer.kind === 'session') append(body, renderSessionDrawer(controller, state, drawer.agentId, drawer.sessionId, t))
  if (drawer.kind === 'settings') append(body, renderSettings(controller, state, t))
  append(value, header, body)
  append(layer, value)
  return layer
}

function renderStatus(state: ConsoleState, t: Record<MessageKey, string>): HTMLElement {
  const status = element('div', `teams-live-region ${state.error === null ? '' : 'is-error'}`)
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', state.error === null ? 'polite' : 'assertive')
  status.textContent = state.error ?? state.notice ?? (state.busy === null ? '' : `${state.busy}…`)
  if (state.status === 'loading' && state.projection === null) status.textContent = t.loading
  return status
}

export function renderConsole(root: HTMLElement, controller: TeamsConsoleController, options: RenderOptions = {}): void {
  const state = controller.getSnapshot()
  const t = messages(state.locale)
  root.className = 'teams-root'
  root.replaceChildren()
  if (!state.open) {
    append(root, button(t.brand, 'teams-launch', () => { controller.openConsole() }, false, 'console:launch'))
    return
  }

  const overlay = element('div', 'teams-overlay')
  const backdrop = element('div', 'teams-backdrop')
  backdrop.addEventListener('click', () => { controller.closeConsole() })
  const panel = element('section', `teams-panel ${state.drawerExpanded ? 'is-expanded' : ''}`)
  panel.setAttribute('aria-label', t.brand)
  const header = element('header', 'teams-header')
  const brand = element('div', 'teams-brand')
  const brandName = element('strong')
  brandName.textContent = t.brand
  append(brand, brandName)
  const headerActions = element('div', 'teams-header-actions')
  append(headerActions,
    button(state.locale === 'en' ? '中文' : 'EN', 'teams-icon-button', () => { controller.setLocale(state.locale === 'en' ? 'zh' : 'en') }, actionDisabled(state)),
    button(t.refresh, 'teams-button-secondary', async () => { await controller.refresh() }, actionDisabled(state)),
    button(t.settings, 'teams-button-secondary', () => { controller.openSettings() }, actionDisabled(state), 'console:settings'),
    button(t.close, 'teams-button-secondary', () => { controller.closeConsole() }),
  )
  append(header, brand, headerActions)

  const tabs = element('nav', 'teams-tabs')
  tabs.setAttribute('aria-label', t.brand)
  for (const entry of entries) {
    const tab = button(t[entry], `teams-tab ${state.entry === entry ? 'is-active' : ''}`, () => { controller.selectEntry(entry) }, actionDisabled(state))
    tab.setAttribute('aria-current', state.entry === entry ? 'page' : 'false')
    append(tabs, tab)
  }

  const content = element('main', 'teams-content')
  if (state.status === 'loading' && state.projection === null) {
    append(content, element('div', 'teams-loading'))
    ;(content.firstChild as HTMLElement).textContent = t.loading
  } else if (state.projection === null && state.error !== null) {
    append(content, errorState(state.error, async () => { await controller.refresh() }, t))
  } else if (state.projection !== null) {
    if (state.entry === 'topology') append(content, renderTopology(controller, state, t))
    if (state.entry === 'conversations') append(content, renderConversations(controller, state, t))
    if (state.entry === 'notifications') append(content, renderNotifications(controller, state, t))
    if (state.entry === 'search') append(content, renderSearch(controller, state, t, root))
    if (state.entry === 'memory') append(content, renderMemory(t))
  }
  const drawer = renderDrawer(controller, state, t)
  append(panel, header, tabs, content, renderStatus(state, t), drawer)
  append(overlay, backdrop, panel)
  append(root, overlay)
  if (options.fixtureLabel !== undefined) {
    const flag = element('div', 'teams-fixture-label')
    flag.textContent = options.fixtureLabel
    append(root, flag)
  }
}
