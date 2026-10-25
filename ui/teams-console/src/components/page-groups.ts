import type { ConsoleState, TeamsConsoleController } from '../state/controller.ts'
import type { MessageKey } from '../client/locale.ts'
import type { GroupWorkspaceState } from '../state/group-workspace.ts'
import { effectiveAccess, groupPhase } from '../state/group-workspace.ts'
import { append, button, element } from './dom.ts'

/**
 * Group workspace view.
 *
 * Every element here renders only typed state. The phase marker
 * (`data-group-phase`) and the access marker (`data-group-access`) are the stable
 * contract for the browser acceptance replay: "not configured" and "unreachable"
 * stay separate, and an unknown owner outcome never looks like success.
 */


function inputField(labelText: string, marker: string, placeholder?: string): HTMLElement {
  const field = element('label', 'teams-group-field')
  const caption = element('span', 'teams-group-label')
  caption.textContent = labelText
  const input = element('input', 'teams-input')
  input.type = 'text'
  input.dataset.groupInput = marker
  if (placeholder !== undefined) input.placeholder = placeholder
  append(field, caption, input)
  return field
}

function textField(labelText: string, marker: string): HTMLElement {
  const field = element('label', 'teams-group-field')
  const caption = element('span', 'teams-group-label')
  caption.textContent = labelText
  const area = element('textarea', 'teams-textarea')
  area.rows = 3
  area.dataset.groupInput = marker
  append(field, caption, area)
  return field
}

function valueOf(root: HTMLElement, marker: string): string {
  const node = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-group-input="${marker}"]`)
  return node === null ? '' : node.value
}

function groupStateBadge(state: GroupWorkspaceState, t: Record<MessageKey, string>): HTMLElement {
  const phase = groupPhase(state)
  const badge = element('span', `teams-status-pill teams-group-phase is-${phase}`)
  badge.dataset.groupPhase = phase
  badge.dataset.groupAccess = effectiveAccess(state)
  // No eligible agent is a configuration statement, not a request for a choice.
  const noActor = state.actors.length === 0
  const choosingActor = state.actors.length > 1 && state.actorId === undefined
  badge.textContent = noActor
    ? t.groupNotConfigured
    : phase === 'live'
      ? t.groupPhaseLive
      : choosingActor
        ? t.groupChooseActor
        : phase === 'loading' || phase === 'idle'
          ? t.groupPhaseLoading
      : phase === 'empty'
        ? t.groupPhaseEmpty
        : phase === 'refused'
          ? t.groupRefused
          : phase === 'unknown'
            ? t.groupUnknown
            : effectiveAccess(state) === 'not-configured'
              ? t.groupNotConfigured
              : effectiveAccess(state) === 'unreachable'
                ? t.groupUnreachable
                : t.groupFailed
  return badge
}

function renderAccessFailure(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const access = effectiveAccess(state)
  const panel = element('div', 'teams-error-panel')
  panel.dataset.groupError = 'access'
  panel.dataset.groupErrorCode = access === 'not-configured' ? 'GROUP_ENDPOINT_NOT_CONFIGURED' : 'GROUP_ENDPOINT_UNREACHABLE'
  panel.dataset.groupAccessDetail = state.actors.length === 0 ? 'no-actor' : 'endpoint'
  const title = element('strong')
  title.textContent = access === 'not-configured' ? t.groupNotConfigured : t.groupUnreachable
  const detail = element('span')
  detail.textContent = state.actors.length === 0
    ? t.groupNoActor
    : state.access.kind === 'ready' ? t.groupNotConfigured : state.access.message
  append(panel, title, detail, button(t.groupRetry, 'teams-button-secondary', async () => { await controller.refreshGroup() }))
  return panel
}

/**
 * The actor is the agent this Console speaks as. One candidate is chosen automatically,
 * several candidates require an explicit visible choice, and none disables every action.
 */
function renderActorBar(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const bar = element('div', 'teams-group-actor')
  bar.dataset.groupActor = state.actorId ?? ''
  bar.dataset.groupActorCount = String(state.actors.length)
  const label = element('span', 'teams-group-label')
  label.textContent = t.groupActor
  append(bar, label)
  if (state.actors.length > 1) {
    const select = element('select', 'teams-select')
    select.dataset.groupActorSelect = 'true'
    for (const actor of state.actors) {
      const option = element('option')
      option.value = actor
      option.textContent = actor
      if (actor === state.actorId) option.selected = true
      append(select, option)
    }
    select.addEventListener('change', () => { controller.setGroupActor(select.value) })
    append(bar, select)
  } else if (state.actors.length === 1) {
    const only = element('span', 'teams-group-actor-name')
    only.dataset.groupActorName = state.actors[0] ?? ''
    only.textContent = state.actors[0] ?? ''
    append(bar, only)
  } else {
    const none = element('span', 'teams-group-actor-name')
    none.dataset.groupActorName = ''
    none.textContent = t.groupNoActor
    append(bar, none)
  }
  return bar
}

function renderGroupList(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const column = element('div', 'teams-group-column')
  column.dataset.groupList = 'true'
  const title = element('h2', 'teams-group-heading')
  title.textContent = t.groupList
  const list = element('ul', 'teams-group-list')
  for (const group of state.groups) {
    const item = element('li')
    const selected = group.groupId === state.selectedGroupId
    const row = button(group.name, `teams-group-row ${selected ? 'is-active' : ''}`, async () => { await controller.selectGroup(group.groupId) }, state.mutation !== null, `group:${group.groupId}`)
    row.dataset.groupItem = group.groupId
    row.dataset.groupSelected = String(selected)
    row.dataset.groupName = group.name
    row.setAttribute('aria-current', selected ? 'true' : 'false')
    append(item, row)
    const meta = element('span', 'teams-group-meta')
    meta.dataset.groupMemberCount = String(group.members.length)
    meta.textContent = `${group.members.length} ${t.groupMembers}`
    append(item, meta)
    append(list, item)
  }
  append(column, title, list)

  const createForm = element('div', 'teams-group-create')
  createForm.dataset.groupCreate = 'true'
  append(createForm, inputField(t.groupName, 'group-create-name'))
  append(createForm, button(t.groupCreate, 'teams-button-primary', async () => {
    const name = valueOf(createForm, 'group-create-name')
    await controller.createGroup(name)
  }, state.mutation !== null))
  append(column, createForm)
  return column
}

function renderMessages(state: GroupWorkspaceState, t: Record<MessageKey, string>): HTMLElement {
  const section = element('section', 'teams-group-messages')
  section.dataset.groupMessages = 'true'
  const title = element('h2', 'teams-group-heading')
  title.textContent = t.groupMessages
  append(section, title)
  if (state.messages.length === 0) {
    const empty = element('p', 'teams-group-empty')
    empty.dataset.groupMessagesEmpty = 'true'
    empty.textContent = t.groupNoMessages
    append(section, empty)
    return section
  }
  const list = element('ol', 'teams-group-message-items')
  for (const message of state.messages) {
    const item = element('li', 'teams-group-message')
    item.dataset.groupMessage = message.messageId
    item.dataset.groupMessageSequence = String(message.sequence)
    item.dataset.groupMessageFrom = message.fromAgentId
    item.dataset.groupMessageReplyRequired = String(message.replyRequired)
    const author = element('span', 'teams-group-message-author')
    author.textContent = message.fromAgentId
    const body = element('p', 'teams-group-message-body')
    body.textContent = message.body
    append(item, author, body)
    append(list, item)
  }
  append(section, list)
  return section
}

function renderComposer(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const section = element('section', 'teams-group-composer')
  section.dataset.groupComposer = 'true'
  const area = element('textarea', 'teams-textarea teams-group-composer-input')
  area.rows = 3
  area.dataset.groupComposerInput = 'true'
  area.placeholder = t.groupComposer
  area.value = state.composer
  area.addEventListener('input', () => { controller.setGroupComposer(area.value) })
  const disabled = state.mutation !== null || state.selectedGroupId === undefined
  const send = button(t.groupSend, 'teams-button-primary', async () => { await controller.sendGroupMessage() }, disabled, 'group:send')
  send.dataset.groupSend = 'true'
  append(section, area, send)
  return section
}

function renderIssuePanel(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const section = element('section', 'teams-group-issue')
  section.dataset.groupIssuePanel = 'true'
  const issue = state.issue
  section.dataset.groupIssueState = issue === null ? 'none' : issue.state
  const title = element('h2', 'teams-group-heading')
  title.textContent = t.groupIssue
  append(section, title)
  const disabled = state.mutation !== null
  if (issue === null) {
    const empty = element('p', 'teams-group-empty')
    empty.dataset.groupIssueEmpty = 'true'
    empty.textContent = t.groupIssueNone
    append(section, empty)
    const form = element('div', 'teams-group-form')
    append(form,
      inputField(t.groupIssueTitle, 'issue-title'),
      textField(t.groupIssueBody, 'issue-body'),
      inputField(t.groupIssueProject, 'issue-project'),
    )
    const create = button(t.groupIssueCreate, 'teams-button-primary', async () => {
      await controller.createIssue(valueOf(form, 'issue-title'), valueOf(form, 'issue-body'), valueOf(form, 'issue-project'))
    }, disabled)
    create.dataset.groupIssueAction = 'create'
    append(form, create)
    append(section, form)
    return section
  }
  const summary = element('p', 'teams-group-issue-summary')
  summary.dataset.groupIssueSession = issue.sessionId
  summary.dataset.groupIssueStateToken = issue.state
  summary.textContent = `${issue.sessionId} · ${issue.state} · ${issue.vikunjaProjectId}/${issue.vikunjaIssueId}`
  append(section, summary)
  const form = element('div', 'teams-group-form')
  append(form, inputField(t.groupIssueReason, 'issue-reason'), inputField(t.groupIssueConclusion, 'issue-conclusion'))
  const close = button(t.groupIssueClose, 'teams-button-secondary', async () => {
    await controller.closeIssue(valueOf(form, 'issue-reason'), valueOf(form, 'issue-conclusion'))
  }, disabled || issue.state !== 'open')
  close.dataset.groupIssueAction = 'close'
  const reopen = button(t.groupIssueReopen, 'teams-button-secondary', async () => {
    await controller.reopenIssue(valueOf(form, 'issue-reason'))
  }, disabled || issue.state !== 'closed')
  reopen.dataset.groupIssueAction = 'reopen'
  append(form, close, reopen)
  append(section, form)
  return section
}

function renderActionPanel(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const section = element('section', 'teams-group-actions')
  section.dataset.groupActionList = 'true'
  const title = element('h2', 'teams-group-heading')
  title.textContent = t.groupActions
  append(section, title)
  const disabled = state.mutation !== null
  if (state.actions.length === 0) {
    const empty = element('p', 'teams-group-empty')
    empty.dataset.groupActionsEmpty = 'true'
    empty.textContent = t.groupActionsNone
    append(section, empty)
  }
  const list = element('ul', 'teams-group-action-items')
  for (const action of state.actions) {
    const item = element('li', 'teams-group-action')
    item.dataset.groupAction = action.actionId
    item.dataset.groupActionState = action.state
    item.dataset.groupActionAssignee = action.assigneeAgentId
    item.dataset.groupActionKind = action.kind
    const head = element('p', 'teams-group-action-head')
    head.textContent = `${action.kind} · ${action.assigneeAgentId} · ${action.state}`
    const reason = element('p', 'teams-group-action-reason')
    reason.textContent = action.reason
    append(item, head, reason)
    const row = element('div', 'teams-group-action-row')
    const result = element('input', 'teams-input')
    result.type = 'text'
    result.dataset.groupInput = `action-result-${action.actionId}`
    const submit = button(t.groupActionSubmit, 'teams-button-secondary', async () => {
      await controller.submitAction(action.actionId, result.value)
    }, disabled || !(action.state === 'pending' || action.state === 'accepted' || action.state === 'in_progress'))
    submit.dataset.groupActionVerb = 'submit'
    const reasonInput = element('input', 'teams-input')
    reasonInput.type = 'text'
    reasonInput.dataset.groupInput = `action-reason-${action.actionId}`
    const refuse = button(t.groupActionRefuse, 'teams-button-secondary', async () => {
      await controller.refuseAction(action.actionId, reasonInput.value)
    }, disabled || !(action.state === 'pending' || action.state === 'accepted'))
    refuse.dataset.groupActionVerb = 'refuse'
    const blocked = button(t.groupActionReport, 'teams-button-secondary', async () => {
      await controller.reportAction(action.actionId, 'blocked', reasonInput.value)
    }, disabled || !(action.state === 'accepted' || action.state === 'in_progress'))
    blocked.dataset.groupActionVerb = 'report'
    append(row, result, submit, reasonInput, refuse, blocked)
    append(item, row)
    append(list, item)
  }
  append(section, list)
  const form = element('div', 'teams-group-form')
  append(form, inputField(t.groupActionAssignee, 'action-assignee'), inputField(t.groupActionReason, 'action-reason'), inputField(t.groupActionResult, 'action-expected'))
  const create = button(t.groupActionCreate, 'teams-button-primary', async () => {
    await controller.createAction(valueOf(form, 'action-assignee'), valueOf(form, 'action-reason'), valueOf(form, 'action-expected'))
  }, disabled || state.issue === null)
  create.dataset.groupActionCreate = 'true'
  append(form, create)
  append(section, form)
  return section
}

function renderInvite(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const section = element('section', 'teams-group-invite')
  section.dataset.groupInvite = 'true'
  const selected = state.groups.find(group => group.groupId === state.selectedGroupId)
  if (selected !== undefined) {
    const members = element('ul', 'teams-group-members')
    members.dataset.groupMemberList = selected.groupId
    for (const member of selected.members) {
      const item = element('li')
      item.dataset.groupMember = member.agentId
      item.dataset.groupMemberRole = member.role
      item.textContent = `${member.agentId} · ${member.role}`
      append(members, item)
    }
    append(section, members)
  }
  const form = element('div', 'teams-group-form')
  append(form, inputField(t.groupInviteAgent, 'invite-agent'), inputField(t.groupInviteRole, 'invite-role'))
  const invite = button(t.groupInvite, 'teams-button-secondary', async () => {
    const groupId = state.selectedGroupId
    if (groupId === undefined) return
    const role = valueOf(form, 'invite-role').trim() === 'master' ? 'master' : 'peer'
    await controller.inviteMember(groupId, valueOf(form, 'invite-agent'), role)
  }, state.mutation !== null || state.selectedGroupId === undefined)
  invite.dataset.groupInviteAction = 'true'
  append(form, invite)
  append(section, form)
  return section
}

function renderOutcome(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const outcome = state.outcome
  const panel = element('div', 'teams-group-outcome')
  panel.dataset.groupOutcome = outcome.kind
  panel.setAttribute('role', 'status')
  panel.setAttribute('aria-live', outcome.kind === 'refused' || outcome.kind === 'failed' ? 'assertive' : 'polite')
  if (outcome.code !== undefined) panel.dataset.groupErrorCode = outcome.code
  const label = outcome.kind === 'pending'
    ? t.groupOutcomePending
    : outcome.kind === 'succeeded'
      ? t.groupOutcomeSucceeded
      : outcome.kind === 'refused'
        ? `${t.groupRefused} ${outcome.code ?? ''}`.trim()
        : outcome.kind === 'unknown'
          ? t.groupUnknown
          : outcome.kind === 'failed'
            ? t.groupFailed
            : t.groupOutcomeIdle
  panel.textContent = outcome.message === undefined ? label : `${label} — ${outcome.message}`
  if (outcome.kind === 'unknown' || (outcome.kind === 'failed' && state.retryable !== null)) {
    const retry = button(t.groupRetry, 'teams-button-secondary', async () => { await controller.retryGroupMutation() })
    retry.dataset.groupRetry = 'true'
    append(panel, retry)
  }
  return panel
}

function renderConfirm(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement | null {
  const confirm = state.confirm
  if (confirm === null) return null
  const panel = element('div', 'teams-group-confirm')
  panel.dataset.groupConfirm = confirm.frame.kind
  panel.setAttribute('role', 'alertdialog')
  panel.setAttribute('aria-label', t.groupConfirm)
  const title = element('strong')
  title.textContent = t.groupConfirm
  const target = element('p')
  target.dataset.groupConfirmTarget = confirm.intentKey
  target.textContent = `${t.groupTarget}: ${confirm.intentKey}`
  const accept = button(t.groupConfirmAccept, 'teams-button-primary', async () => { await controller.confirmPendingGroupAction() })
  accept.dataset.groupConfirmAccept = 'true'
  const cancel = button(t.groupConfirmCancel, 'teams-button-secondary', () => { controller.cancelPendingGroupAction() })
  cancel.dataset.groupConfirmCancel = 'true'
  append(panel, title, target, accept, cancel)
  return panel
}

export function renderGroups(controller: TeamsConsoleController, state: ConsoleState, t: Record<MessageKey, string>): HTMLElement {
  const group = state.group
  const root = element('section', 'teams-groups')
  root.dataset.groupWorkspace = 'true'
  root.dataset.groupPhase = groupPhase(group)
  root.dataset.groupListState = group.listStatus
  root.dataset.groupAccess = effectiveAccess(group)
  root.dataset.groupActorCount = String(group.actors.length)
  append(root, groupStateBadge(group, t))

  // The actor bar renders before any failure branch. With several eligible agents and no
  // choice yet it is the only control that can unblock the workspace, so it must never be
  // hidden behind a "not configured" panel.
  if (group.actors.length > 0) append(root, renderActorBar(group, controller, t))

  if (group.actors.length === 0) {
    append(root, renderAccessFailure(group, controller, t))
    const confirm = renderConfirm(group, controller, t)
    if (confirm !== null) append(root, confirm)
    return root
  }

  if (group.actorId === undefined) {
    // Several candidates, none chosen: no request is sent and the UI asks for the one
    // fact it cannot derive.
    const pending = element('div', 'teams-group-actor-pending')
    pending.dataset.groupActorPending = 'true'
    const hint = element('p')
    hint.textContent = t.groupChooseActorHint
    append(pending, hint)
    append(root, pending)
    const confirm = renderConfirm(group, controller, t)
    if (confirm !== null) append(root, confirm)
    return root
  }

  if (group.access.kind !== 'ready') {
    append(root, renderAccessFailure(group, controller, t))
    const confirm = renderConfirm(group, controller, t)
    if (confirm !== null) append(root, confirm)
    return root
  }

  if (groupPhase(group) === 'loading' || groupPhase(group) === 'idle') {
    const loading = element('div', 'teams-loading')
    loading.dataset.groupLoading = 'true'
    loading.textContent = t.groupPhaseLoading
    append(root, loading)
    return root
  }

  if (groupPhase(group) === 'empty') {
    const empty = element('div', 'teams-empty')
    empty.dataset.groupEmpty = 'true'
    empty.textContent = t.groupPhaseEmpty
    append(root, empty, renderGroupList(group, controller, t))
    return root
  }

  const layout = element('div', 'teams-group-layout')
  append(layout, renderGroupList(group, controller, t))

  const detail = element('div', 'teams-group-detail')
  detail.dataset.groupDetail = 'true'
  const selected = group.groups.find(candidate => candidate.groupId === group.selectedGroupId)
  const header = element('header', 'teams-group-detail-header')
  header.dataset.groupSelectedId = group.selectedGroupId ?? ''
  const name = element('h2', 'teams-group-heading')
  name.textContent = selected?.name ?? group.selectedGroupId ?? ''
  append(header, name, renderOutcome(group, controller, t))
  append(detail, header)
  append(detail, renderMessages(group, t))
  append(detail, renderComposer(group, controller, t))
  append(detail, renderIssuePanel(group, controller, t))
  append(detail, renderActionPanel(group, controller, t))
  append(detail, renderInvite(group, controller, t))
  append(layout, detail)
  append(root, layout)

  const phase = groupPhase(group)
  if (phase === 'refused' || phase === 'failed' || phase === 'unknown') {
    const failure = element('div', 'teams-error-panel')
    failure.dataset.groupError = phase
    failure.dataset.groupErrorCode = group.error?.code ?? group.outcome.code ?? (phase === 'unknown' ? 'RESULT_UNKNOWN' : 'GROUP_FAILED')
    const message = group.error?.message ?? (phase === 'unknown' ? t.groupUnknown : phase === 'refused' ? t.groupRefused : t.groupFailed)
    const detailNode = element('span')
    detailNode.textContent = message
    append(failure, detailNode, button(t.groupRetry, 'teams-button-secondary', async () => { await controller.refreshGroup() }))
    append(root, failure)
  }

  const confirm = renderConfirm(group, controller, t)
  if (confirm !== null) append(root, confirm)
  return root
}
