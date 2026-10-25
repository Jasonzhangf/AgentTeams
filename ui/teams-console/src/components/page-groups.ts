import type { ConsoleState, TeamsConsoleController } from '../state/controller.ts'
import type { MessageKey } from '../client/locale.ts'
import type { GroupWorkspaceState } from '../state/group-workspace.ts'
import type { Action, CloseReportEntry } from '../../../../packages/shared/src/group-wire.ts'
import { assignableMembers, canRefuseAction, canReportAction, effectiveAccess, grantTargets, groupPhase, invitableAgents, visibleRetryable } from '../state/group-workspace.ts'
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
  const node = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-group-input="${marker}"]`)
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

/**
 * Narrow-screen switchers. Both selects drive the same controller paths as the desktop
 * list; they never keep a second navigation ledger.
 */
function renderMobileSwitchers(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const bar = element('div', 'teams-group-mobile')
  bar.dataset.groupMobile = 'true'
  const groupField = element('label', 'teams-group-mobile-field')
  const groupLabel = element('span', 'teams-group-label')
  groupLabel.textContent = t.groupList
  const groupSelect = element('select', 'teams-select')
  groupSelect.dataset.groupMobileGroup = 'true'
  groupSelect.setAttribute('aria-label', t.groupList)
  for (const group of state.groups) {
    const option = element('option')
    option.value = group.groupId
    option.textContent = group.name
    if (group.groupId === state.selectedGroupId) option.selected = true
    append(groupSelect, option)
  }
  groupSelect.addEventListener('change', () => { void controller.selectGroup(groupSelect.value) })
  append(groupField, groupLabel, groupSelect)
  append(bar, groupField)

  const issueField = element('label', 'teams-group-mobile-field')
  const issueLabel = element('span', 'teams-group-label')
  issueLabel.textContent = t.groupIssue
  const issueSelect = element('select', 'teams-select')
  issueSelect.dataset.groupMobileIssue = 'true'
  issueSelect.setAttribute('aria-label', t.groupIssue)
  // Every option value is a real `sessionId`; the open issue stays in the list even while
  // the issue list itself is still being read, so the control never shows a fake entry.
  const sessions = state.issue !== null && !state.issues.some(session => session.sessionId === state.issue!.sessionId)
    ? [...state.issues, state.issue]
    : state.issues
  for (const session of sessions) {
    const option = element('option')
    option.value = session.sessionId
    option.textContent = `${session.state} · ${session.vikunjaProjectId}/${session.vikunjaIssueId}`
    if (state.issue?.sessionId === session.sessionId) option.selected = true
    append(issueSelect, option)
  }
  issueSelect.disabled = sessions.length === 0 || state.mutation !== null
  issueSelect.addEventListener('change', () => { void controller.openIssue(issueSelect.value) })
  append(issueField, issueLabel, issueSelect)
  append(bar, issueField)
  return bar
}

function renderMobileManage(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const details = element('details', 'teams-group-manage')
  details.dataset.groupManagePanel = 'true'
  if (state.manageOpen) details.open = true
  const summary = element('summary')
  summary.textContent = t.groupManage
  summary.dataset.groupManageToggle = 'true'
  summary.addEventListener('toggle', () => { controller.toggleGroupManageOpen(details.open) })
  append(details, summary, renderGroupList(state, controller, t), renderIssuePanel(state, controller, t), renderActionPanel(state, controller, t), renderInvite(state, controller, t))
  return details
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
  area.dataset.focusKey = 'group:composer'
  area.placeholder = t.groupComposer
  area.value = state.composer
  area.addEventListener('input', () => { controller.setGroupComposer(area.value) })
  const disabled = state.mutation !== null || state.selectedGroupId === undefined
  const send = button(t.groupSend, 'teams-button-primary', async () => { await controller.sendGroupMessage() }, disabled, 'group:send')
  send.dataset.groupSend = 'true'
  append(section, area, send)
  return section
}

function renderIssueList(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const list = element('div', 'teams-group-issue-list')
  list.dataset.groupIssueList = 'true'
  list.dataset.groupIssueListState = state.issueListStatus
  const heading = element('h3', 'teams-group-heading')
  heading.textContent = t.groupIssueList
  append(list, heading)
  if (state.issueListStatus === 'refused' || state.issueListStatus === 'unknown' || state.issueListStatus === 'failed') {
    const error = element('p', 'teams-group-empty')
    error.dataset.groupIssueListError = 'true'
    error.textContent = t.groupIssueListHint
    append(list, error)
    return list
  }
  if (state.issueListStatus === 'empty') {
    const empty = element('p', 'teams-group-empty')
    empty.dataset.groupIssueEmpty = 'true'
    empty.textContent = t.groupIssueListEmpty
    append(list, empty)
    return list
  }
  for (const session of state.issues) {
    const row = element('div', 'teams-group-issue-row')
    row.dataset.groupIssueItem = session.sessionId
    const label = element('span', 'teams-group-issue-label')
    label.textContent = `${session.state} · ${session.vikunjaProjectId}/${session.vikunjaIssueId}`
    const open = button(t.groupIssueOpen, 'teams-button-secondary', async () => {
      await controller.openIssue(session.sessionId)
    }, state.mutation !== null)
    open.dataset.groupIssueOpen = session.sessionId
    append(row, label, open)
    append(list, row)
  }
  return list
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
    // The group's own issues come first. The create form stays available whether the list
    // is empty, refused or unreadable; the panel never asks for a Vikunja or session id.
    append(section, renderIssueList(state, controller, t))
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
  // The session id stays a stable selector and query target, never visible chrome. The
  // human-readable state and Vikunja reference are what the operator needs here.
  summary.textContent = `${issue.state} · ${issue.vikunjaProjectId}/${issue.vikunjaIssueId}`
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

/** An action that has not reached a terminal state yet must never be hidden by a newer one. */
function unfinishedAction(state: Action['state']): boolean {
  return state === 'pending'
    || state === 'accepted'
    || state === 'in_progress'
    || state === 'blocked'
    || state === 'cancel_requested'
    || state === 'unknown'
}

const unstoppedStateLabel: Record<CloseReportEntry['state'], MessageKey> = {
  pending: 'groupStopPending',
  accepted: 'groupStopAccepted',
  in_progress: 'groupStopInProgress',
  cancel_requested: 'groupStopCancelRequested',
  blocked: 'groupStopBlocked',
  failed: 'groupStopFailed',
  completed: 'groupStopCompleted',
  refused: 'groupStopRefused',
  cancelled: 'groupStopCancelled',
  unknown: 'groupStopUnknown',
}

/**
 * Every unfinished action is affected by a close, including queued ones the contract will
 * cancel. The reply's `unstopped` list is narrower: it names only stops the owner could not
 * confirm, so the confirmation is derived from actions and the post-close report is not.
 */
function closeAffectedActions(state: GroupWorkspaceState): readonly Action[] {
  return state.actions.filter(action => unfinishedAction(action.state))
}

function renderUnstoppedItem(entry: CloseReportEntry, t: Record<MessageKey, string>): HTMLElement {
  const item = element('li', 'teams-group-unstopped')
  item.dataset.groupUnstoppedItem = entry.actionId
  item.dataset.groupUnstoppedState = entry.state
  item.dataset.groupUnstoppedAssignee = entry.assigneeAgentId
  const summary = element('p', 'teams-group-unstopped-head')
  summary.textContent = `${entry.assigneeAgentId} · ${t[unstoppedStateLabel[entry.state]]}`
  const actionId = element('p', 'teams-group-unstopped-id')
  actionId.textContent = entry.actionId
  append(item, summary, actionId)
  return item
}

/**
 * The same marker for both lists, so the report is one place in the DOM. The confirmation
 * entry carries real action rows; the post-close entry carries the close reply's own stop
 * facts, which are never replaced by the owner's action state after the refresh.
 */
function renderUnstoppedItems(entries: readonly CloseReportEntry[], t: Record<MessageKey, string>): HTMLElement {
  const rows = element('ul', 'teams-group-unstopped-items')
  for (const entry of entries) append(rows, renderUnstoppedItem(entry, t))
  return rows
}

function renderUnstoppedList(entries: readonly CloseReportEntry[], label: string, context: 'confirm' | 'closed', t: Record<MessageKey, string>): HTMLElement {
  const list = element('div', 'teams-group-unstopped-list')
  list.dataset.groupUnstoppedList = 'true'
  list.dataset.groupUnstoppedCount = String(entries.length)
  list.dataset.groupUnstoppedContext = context
  const title = element('strong', 'teams-group-unstopped-title')
  title.textContent = label
  append(list, title, renderUnstoppedItems(entries, t))
  return list
}

/**
 * `Action.refusal` is owned by the shared wire contract. The parallel backend branch adds
 * it to `Action`; this UI branch reads the same typed field without rebuilding it from
 * error text or keeping a second refusal ledger.
 */
interface ActionRefusalView {
  readonly reason: string
  readonly refusedAt: string
}

function refusalOf(action: Action): ActionRefusalView | undefined {
  const refusal = (action as Action & { readonly refusal?: ActionRefusalView }).refusal
  if (refusal === undefined) return undefined
  if (typeof refusal.reason !== 'string' || typeof refusal.refusedAt !== 'string') return undefined
  return refusal
}

function evidenceText(evidence: unknown): string {
  return typeof evidence === 'string' ? evidence : JSON.stringify(evidence)
}

function renderActionReport(action: Action, t: Record<MessageKey, string>): HTMLElement | null {
  const report = action.report
  if (report === undefined) return null
  const box = element('div', 'teams-group-action-report')
  box.dataset.groupActionReport = action.actionId
  box.dataset.groupActionReportKind = report.report
  box.dataset.groupActionReportedAt = report.reportedAt
  const kind = element('strong', 'teams-group-action-report-kind')
  kind.textContent = `${t.groupActionReportKind} · ${report.report === 'blocked' ? t.groupStopBlocked : t.groupStopFailed}`
  const reason = element('p', 'teams-group-action-report-reason')
  reason.dataset.groupActionReportReason = report.reason
  reason.textContent = `${t.groupActionReportReason} · ${report.reason}`
  append(box, kind, reason)
  if (report.evidence !== undefined) {
    const evidence = element('p', 'teams-group-action-report-evidence')
    evidence.dataset.groupActionReportEvidence = evidenceText(report.evidence)
    evidence.textContent = `${t.groupActionReportEvidence} · ${evidenceText(report.evidence)}`
    append(box, evidence)
  }
  return box
}

function renderActionRefusal(action: Action, t: Record<MessageKey, string>): HTMLElement | null {
  const refusal = refusalOf(action)
  if (refusal === undefined) return null
  const box = element('div', 'teams-group-action-refusal')
  box.dataset.groupActionRefusal = action.actionId
  const reason = element('p', 'teams-group-action-refusal-reason')
  reason.dataset.groupActionRefusalReason = refusal.reason
  reason.textContent = `${t.groupActionRefusalReason} · ${refusal.reason}`
  const at = element('p', 'teams-group-action-refusal-at')
  at.dataset.groupActionRefusedAt = refusal.refusedAt
  at.textContent = `${t.groupActionRefusedAt} · ${refusal.refusedAt}`
  append(box, reason, at)
  return box
}

function renderActionItem(
  action: Action,
  group: GroupWorkspaceState['groups'][number] | undefined,
  actorId: string | undefined,
  controller: TeamsConsoleController,
  disabled: boolean,
  t: Record<MessageKey, string>,
): HTMLElement {
  const item = element('li', 'teams-group-action')
  item.dataset.groupAction = action.actionId
  item.dataset.groupActionState = action.state
  item.dataset.groupActionAssignee = action.assigneeAgentId
  item.dataset.groupActionInitiator = action.initiatorAgentId
  item.dataset.groupActionKind = action.kind
  item.dataset.groupActionUnfinished = String(unfinishedAction(action.state))
  const head = element('p', 'teams-group-action-head')
  head.textContent = `${action.kind} · ${action.assigneeAgentId} · ${action.state}`
  const reason = element('p', 'teams-group-action-reason')
  reason.textContent = action.reason
  append(item, head, reason)
  const report = renderActionReport(action, t)
  if (report !== null) append(item, report)
  const refusal = renderActionRefusal(action, t)
  if (refusal !== null) append(item, refusal)
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
  const evidenceInput = element('input', 'teams-input')
  evidenceInput.type = 'text'
  evidenceInput.dataset.groupInput = `action-evidence-${action.actionId}`
  const mayRefuse = canRefuseAction(group, action, actorId)
  item.dataset.groupActionRefusePermitted = String(mayRefuse)
  const refuse = button(t.groupActionRefuse, 'teams-button-secondary', async () => {
    await controller.refuseAction(action.actionId, reasonInput.value)
  }, disabled || !mayRefuse)
  refuse.dataset.groupActionVerb = 'refuse'
  const mayReport = canReportAction(group, action, actorId)
  item.dataset.groupActionReportPermitted = String(mayReport)
  const blocked = button(t.groupActionReportBlocked, 'teams-button-secondary', async () => {
    await controller.reportAction(action.actionId, 'blocked', reasonInput.value, evidenceInput.value)
  }, disabled || !mayReport)
  blocked.dataset.groupActionVerb = 'report-blocked'
  const failed = button(t.groupActionReportFailed, 'teams-button-secondary', async () => {
    await controller.reportAction(action.actionId, 'failed', reasonInput.value, evidenceInput.value)
  }, disabled || !mayReport)
  failed.dataset.groupActionVerb = 'report-failed'
  append(row, result, submit, reasonInput, evidenceInput, refuse, blocked, failed)
  append(item, row)
  // Action and commit ids are diagnostics, not part of the task the user performs.
  const diagnostics = element('details', 'teams-group-action-diagnostics')
  diagnostics.dataset.groupActionDiagnostics = action.actionId
  const diagnosticsTitle = element('summary')
  diagnosticsTitle.textContent = t.groupActionDiagnostics
  const actionIdLine = element('p')
  actionIdLine.dataset.groupActionId = action.actionId
  actionIdLine.textContent = `actionId ${action.actionId}`
  const commitLine = element('p')
  commitLine.dataset.groupActionCommit = action.commitId
  commitLine.textContent = `commitId ${action.commitId}`
  // Internal ids are diagnostics only; the issue the action belongs to is shown through the
  // issue panel's Vikunja reference, never as a second visible session id here.
  append(diagnostics, diagnosticsTitle, actionIdLine, commitLine)
  append(item, diagnostics)
  return item
}

function renderActionPanel(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const section = element('section', 'teams-group-actions')
  section.dataset.groupActionList = 'true'
  const group = state.groups.find(entry => entry.groupId === state.selectedGroupId)
  const title = element('h2', 'teams-group-heading')
  title.textContent = t.groupActions
  append(section, title)
  const disabled = state.mutation !== null
  const readError = state.readError?.section === 'actions' ? state.readError : undefined
  if (readError !== undefined) {
    // A failed action read reports itself here and leaves any write result untouched.
    const hint = element('p', 'teams-group-hint')
    hint.dataset.groupReadError = 'actions'
    hint.dataset.groupReadErrorCode = readError.code
    hint.textContent = `${t.groupReadFailed} — ${readError.message}`
    append(section, hint)
  }
  if (state.issue === null) {
    // Work belongs to an issue. Without one the panel states the missing step instead of
    // presenting a group-wide action list as this issue's work.
    const hint = element('p', 'teams-group-hint')
    hint.dataset.groupActionNoIssue = 'true'
    hint.textContent = `${t.groupActionNoIssue} — ${t.groupActionNoIssueHint}`
    append(section, hint)
    return section
  }
  const unfinished = state.actions.filter(action => unfinishedAction(action.state))
  const finished = state.actions.filter(action => !unfinishedAction(action.state))
  const summary = element('p', 'teams-group-hint')
  summary.dataset.groupActionUnfinished = String(unfinished.length)
  summary.dataset.groupActionTotal = String(state.actions.length)
  summary.textContent = `${t.groupActionUnfinished} ${unfinished.length} / ${state.actions.length}`
  append(section, summary)
  if (state.actions.length === 0) {
    const empty = element('p', 'teams-group-empty')
    empty.dataset.groupActionsEmpty = 'true'
    empty.textContent = t.groupActionsNone
    append(section, empty)
  }
  const list = element('ul', 'teams-group-action-items')
  for (const action of unfinished) append(list, renderActionItem(action, group, state.actorId, controller, disabled, t))
  append(section, list)
  if (finished.length > 0) {
    // Completed work folds away, but it can never take an unfinished action down with it.
    const details = element('details', 'teams-group-action-finished')
    details.dataset.groupActionFinished = String(finished.length)
    const summaryNode = element('summary')
    summaryNode.textContent = `${t.groupActionFinished} ${finished.length}`
    const finishedList = element('ul', 'teams-group-action-items')
    for (const action of finished) append(finishedList, renderActionItem(action, group, state.actorId, controller, disabled, t))
    append(details, summaryNode, finishedList)
    append(section, details)
  }
  // An action is only admissible where the actor already holds a command/request edge, so the
  // target is chosen from that set and never typed by hand.
  const assignable = assignableMembers(group, state.actorId)
  const form = element('div', 'teams-group-form')
  const assigneeField = element('label', 'teams-group-field')
  const assigneeLabel = element('span', 'teams-group-label')
  assigneeLabel.textContent = t.groupActionAssignee
  const assignee = element('select', 'teams-select')
  assignee.dataset.groupInput = 'action-assignee'
  assignee.dataset.groupActionAssignable = String(assignable.length)
  if (assignable.length === 0) {
    assignee.disabled = true
    const none = element('option')
    none.value = ''
    none.textContent = t.groupActionAssigneeEmpty
    append(assignee, none)
    const hint = element('p', 'teams-group-hint')
    hint.dataset.groupActionAssigneeEmpty = 'true'
    hint.textContent = t.groupActionAssigneeEmptyHint
    append(assigneeField, assigneeLabel, assignee, hint)
  } else {
    assignee.disabled = disabled
    for (const agentId of assignable) {
      const option = element('option')
      option.value = agentId
      option.textContent = agentId
      append(assignee, option)
    }
    append(assigneeField, assigneeLabel, assignee)
  }
  append(form, assigneeField, inputField(t.groupActionReason, 'action-reason'), inputField(t.groupActionResult, 'action-expected'))
  const create = button(t.groupActionCreate, 'teams-button-primary', async () => {
    await controller.createAction(assignee.value, valueOf(form, 'action-reason'), valueOf(form, 'action-expected'))
  }, disabled || state.issue === null || assignable.length === 0)
  create.dataset.groupActionCreate = 'true'
  append(form, create)
  append(section, form)
  return section
}

function renderInvite(state: GroupWorkspaceState, controller: TeamsConsoleController, t: Record<MessageKey, string>): HTMLElement {
  const section = element('section', 'teams-group-invite')
  section.dataset.groupInvite = 'true'
  const selected = state.groups.find(group => group.groupId === state.selectedGroupId)
  const invitationLabel: Record<string, MessageKey> = {
    pending: 'groupInvitationPending',
    accepted: 'groupInvitationAccepted',
    declined: 'groupInvitationDeclined',
    revoked: 'groupInvitationRevoked',
  }
  const invitationRows = state.invitations.filter(invitation =>
    !(selected?.members.some(member => member.agentId === invitation.agentId) ?? false))
  if (invitationRows.length > 0) {
    const invitationList = element('ul', 'teams-group-invitations')
    invitationList.dataset.groupInvitationList = 'true'
    for (const invitation of invitationRows) {
      const item = element('li')
      item.dataset.groupInvitation = invitation.agentId
      item.dataset.groupInvitationState = invitation.state
      const caption = element('span')
      caption.textContent = `${invitation.agentId} · ${invitation.role} · ${t[invitationLabel[invitation.state] ?? 'groupInvitationPending']}`
      append(item, caption)
      append(invitationList, item)
    }
    append(section, invitationList)
  }
  if (selected !== undefined) {
    const members = element('ul', 'teams-group-members')
    members.dataset.groupMemberList = selected.groupId
    const targets = new Set(grantTargets(selected, state.actorId ?? ''))
    for (const member of selected.members) {
      const item = element('li')
      item.dataset.groupMember = member.agentId
      item.dataset.groupMemberRole = member.role
      const caption = element('span')
      caption.textContent = `${member.agentId} · ${member.role}`
      append(item, caption)
      // Only the owner may widen an edge, and only to a member not already commandable.
      if (targets.has(member.agentId)) {
        const grant = button(t.groupGrant, 'teams-button-secondary', async () => { await controller.grantCommand(member.agentId) }, state.mutation !== null)
        grant.dataset.groupGrant = member.agentId
        grant.dataset.focusKey = `group:grant:${member.agentId}`
        append(item, grant)
      }
      append(members, item)
    }
    append(section, members)
  }
  // Both fields are closed choices: the invitee comes from the declared agents that are not
  // already members, and the role from the two roles the wire accepts. Nothing is typed blind.
  const candidates = invitableAgents(state.actors, selected)
  const form = element('div', 'teams-group-form')
  const agentField = element('label', 'teams-group-field')
  const agentLabel = element('span', 'teams-group-label')
  agentLabel.textContent = t.groupInviteAgent
  const agentSelect = element('select', 'teams-select')
  agentSelect.dataset.groupInput = 'invite-agent'
  agentSelect.dataset.groupInviteCandidates = String(candidates.length)
  if (candidates.length === 0) {
    agentSelect.disabled = true
    const none = element('option')
    none.value = ''
    none.textContent = t.groupInviteAgentEmpty
    append(agentSelect, none)
  } else {
    for (const agentId of candidates) {
      const option = element('option')
      option.value = agentId
      option.textContent = agentId
      append(agentSelect, option)
    }
  }
  append(agentField, agentLabel, agentSelect)

  const roleField = element('label', 'teams-group-field')
  const roleLabel = element('span', 'teams-group-label')
  roleLabel.textContent = t.groupInviteRole
  const roleSelect = element('select', 'teams-select')
  roleSelect.dataset.groupInput = 'invite-role'
  for (const role of ['peer', 'master'] as const) {
    const option = element('option')
    option.value = role
    option.textContent = role
    append(roleSelect, option)
  }
  append(roleField, roleLabel, roleSelect)
  append(form, agentField, roleField)

  const invite = button(t.groupInvite, 'teams-button-secondary', async () => {
    const groupId = state.selectedGroupId
    if (groupId === undefined) return
    const role = valueOf(form, 'invite-role').trim() === 'master' ? 'master' : 'peer'
    await controller.inviteMember(groupId, valueOf(form, 'invite-agent'), role)
  }, state.mutation !== null || state.selectedGroupId === undefined || candidates.length === 0)
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
  // A result parked under another context offers no retry here.
  if ((outcome.kind === 'unknown' || outcome.kind === 'failed') && visibleRetryable(state) !== null) {
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
  append(panel, title, target)
  if (confirm.frame.kind === 'issue.close') {
    const affected = closeAffectedActions(state)
    if (affected.length > 0) {
      append(panel, renderUnstoppedList(affected.map(action => ({
        actionId: action.actionId,
        assigneeAgentId: action.assigneeAgentId,
        state: action.state,
      })), t.groupCloseImpact, 'confirm', t))
    }
  }
  const accept = button(t.groupConfirmAccept, 'teams-button-primary', async () => { await controller.confirmPendingGroupAction() })
  accept.dataset.groupConfirmAccept = 'true'
  const cancel = button(t.groupConfirmCancel, 'teams-button-secondary', () => { controller.cancelPendingGroupAction() })
  cancel.dataset.groupConfirmCancel = 'true'
  append(panel, accept, cancel)
  return panel
}

function renderPostCloseReport(state: GroupWorkspaceState, t: Record<MessageKey, string>): HTMLElement | null {
  const report = state.stopReport
  if (report === null) return null
  return renderUnstoppedList(report.entries, t.groupStopReport, 'closed', t)
}

export function renderGroups(controller: TeamsConsoleController, state: ConsoleState, t: Record<MessageKey, string>): HTMLElement {
  const group = state.group
  const narrow = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(max-width: 780px)').matches
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
    if (narrow) {
      append(root, renderMobileSwitchers(group, controller, t))
      append(root, renderMobileManage(group, controller, t))
    }
    const empty = element('div', 'teams-empty')
    empty.dataset.groupEmpty = 'true'
    empty.textContent = t.groupPhaseEmpty
    append(root, empty)
    if (!narrow) append(root, renderGroupList(group, controller, t))
    return root
  }

  const layout = element('div', 'teams-group-layout')
  if (!narrow) append(layout, renderGroupList(group, controller, t))
  if (narrow) append(layout, renderMobileSwitchers(group, controller, t))
  if (narrow) append(layout, renderMobileManage(group, controller, t))

  const detail = element('div', 'teams-group-detail')
  detail.dataset.groupDetail = 'true'
  const selected = group.groups.find(candidate => candidate.groupId === group.selectedGroupId)
  const header = element('header', 'teams-group-detail-header')
  header.dataset.groupSelectedId = group.selectedGroupId ?? ''
  const name = element('h2', 'teams-group-heading')
  name.textContent = selected?.name ?? group.selectedGroupId ?? ''
  append(header, name, renderOutcome(group, controller, t))
  // The stop facts belong to the successful close, so they render beside its outcome and
  // survive the owner's action refresh that follows it.
  if (group.outcome.kind === 'succeeded' && group.outcome.frame === 'issue.close') {
    const report = renderPostCloseReport(group, t)
    if (report !== null) append(header, report)
  }
  append(detail, header)
  append(detail, renderMessages(group, t))
  append(detail, renderComposer(group, controller, t))
  if (!narrow) {
    append(detail, renderIssuePanel(group, controller, t))
    append(detail, renderActionPanel(group, controller, t))
    append(detail, renderInvite(group, controller, t))
  }
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
