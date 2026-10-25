import { describe, expect, it, onTestFinished } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { teamsStyles } from '../src/styles.ts'

const srcRoot = join(import.meta.dirname, '../src')

/**
 * Render the shipped group workspace in a real DOM. The modules are transpiled to a classic
 * script and executed by Chrome, so the assertions read the DOM the modules actually build
 * rather than source text. The stable markers here are the ones a browser replay drives.
 */
function classicModule(file: string): string {
  const output = transpileModule(readFileSync(join(srcRoot, file), 'utf8'), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText
  return output
    .split('\n')
    .filter(line => !/^\s*import\b/.test(line))
    .filter(line => !/^\s*export\s*\{/.test(line))
    .map(line => line.replace(/^export\s+(?=(?:function|const|let|var|class)\b)/, ''))
    .join('\n')
    .replaceAll('import.meta.url', 'location.href')
}

function chromeExecutable(): string {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  const executable = candidates.find(candidate => candidate !== undefined && existsSync(candidate))
  if (executable === undefined) throw new Error('A Chrome/Chromium executable is required for the group DOM render test')
  return executable
}

const script = [
  classicModule('client/locale.ts'),
  classicModule('state/model.ts'),
  classicModule('client/protocol.ts'),
  classicModule('state/group-workspace.ts'),
  classicModule('components/dom.ts'),
  classicModule('components/page-groups.ts'),
  classicModule('components/render.ts'),
].join('\n')

if (/(^|\n)\s*(import|export)\b/.test(script)) throw new Error('classic module bundling left module syntax behind')

const group = {
  groupId: 'g1',
  name: 'Alpha',
  ownerAgentId: 'agent-a',
  createdAt: '2026-10-20T00:00:00.000Z',
  members: [{ agentId: 'agent-a', role: 'master', mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] }],
}

const message = {
  messageId: 'm1', commitId: 'c1', sequence: 1, groupId: 'g1', fromAgentId: 'agent-a',
  targetAgentIds: ['agent-a'], replyRequired: false, body: 'hello group', sentAt: '2026-10-20T00:00:01.000Z',
}

const issueSession = {
  sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1',
  initiatorAgentId: 'agent-a', state: 'open', openedAt: '2026-10-20T00:00:00.000Z', lastOpSeq: 1,
}

const projection = {
  version: 1,
  agents: [
    { kind: 'runtime', agentId: 'agent-a', label: 'Agent A', machineId: 'M1', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current' },
    { kind: 'runtime', agentId: 'agent-b', label: 'Agent B', machineId: 'M1', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current' },
  ],
  sessions: [],
  notifications: [],
  configs: [],
}

function groupState(overrides: Record<string, unknown> = {}) {
  const base = {
    access: { kind: 'ready' },
    listStatus: 'ready',
    groups: [group],
    selectedGroupId: 'g1',
    invitations: [],
    messageStatus: 'ready',
    messages: [message],
    messageHasMore: false,
    issue: null,
    issueStatus: 'idle',
    issues: [],
    issueListStatus: 'idle',
    actions: [],
    actionStatus: 'empty',
    composer: '',
    manageOpen: false,
    actors: ['agent-a'],
    actorId: 'agent-a',
    mutation: null,
    retryable: null,
    commits: {},
    outcome: { kind: 'idle' },
    confirm: null,
  }
  return { ...base, ...overrides }
}

function state(groupOverrides: Record<string, unknown> = {}, stateOverrides: Record<string, unknown> = {}) {
  return {
    open: true,
    page: 'groups',
    live: true,
    entry: 'topology',
    drawer: null,
    drawerStack: [],
    drawerExpanded: false,
    projection,
    status: 'ready',
    error: null,
    notice: null,
    busy: null,
    query: '',
    locale: 'en',
    selectedAgentId: undefined,
    selectedSessionId: undefined,
    providerFormOpen: false,
    editingProviderId: undefined,
    providerDraft: { id: '', label: '', protocol: 'openai-chat', apiBaseUrl: '', enabled: true, authKind: 'none', credentialRef: '' },
    refusedError: null,
    cancelState: 'idle',
    observation: { projection, observation: 'live', health: { state: 'live' } },
    messageDraft: '',
    membershipDraft: [],
    history: null,
    historyStatus: 'idle',
    historyError: null,
    lastFocusKey: undefined,
    groupCapable: true,
    group: groupState(groupOverrides),
    ...stateOverrides,
  }
}

const actionsState = state({
  issue: issueSession,
  issueStatus: 'ready',
  issues: [issueSession],
  issueListStatus: 'ready',
  actions: [
    { actionId: 'a-old', commitId: 'commit-old', sessionId: 's1', kind: 'reply', initiatorAgentId: 'agent-a', assigneeAgentId: 'agent-b', reason: 'old work', expectedResult: 'x', replyRequired: false, state: 'accepted', createdAt: '2026-10-20T00:00:00.000Z' },
    { actionId: 'a-new', commitId: 'commit-new', sessionId: 's1', kind: 'reply', initiatorAgentId: 'agent-a', assigneeAgentId: 'agent-b', reason: 'new work', expectedResult: 'x', replyRequired: false, state: 'completed', createdAt: '2026-10-20T00:00:01.000Z' },
  ],
})

const controllerScript = `
  const calls = { actor: [], select: [], send: [], retry: [], confirm: [], openIssue: [] }
  const controller = {
    getSnapshot: () => STATE,
    setGroupActor(id) { calls.actor.push(id) },
    selectGroup(id) { calls.select.push(id) },
    sendGroupMessage() { calls.send.push('send') },
    refreshGroup() { calls.retry.push('refresh') },
    retryGroupMutation() { calls.retry.push('retry') },
    confirmPendingGroupAction() { calls.confirm.push('confirm') },
    cancelPendingGroupAction() { calls.confirm.push('cancel') },
    openIssue(id) { calls.openIssue.push(id) },
    setGroupComposer() {}, createGroup() {}, inviteMember() {}, createIssue() {}, closeIssue() {},
    reopenIssue() {}, createAction() {}, submitAction() {}, refuseAction() {}, reportAction() {},
    setLocale() {}, openConsole() {}, closeConsole() {}, selectPage() {}, openAgent() {}, openSession() {},
    closeDrawer() {}, toggleDrawerExpanded() {}, selectNetworkMember() {}, removeNetworkMember() {},
    applyMembership() {}, connectAgent() {}, loadHistory() {}, retryHistory() {}, sendSession() {},
    cancelSession() {}, replyPermission() {}, acknowledge() {}, createSessionCommand() {}, openSessionCommand() {},
    refresh() {}, selectSession() {}, applyConfig() {}, bindModel() {}, saveProvider() {}, openProviderForm() {},
    closeProviderForm() {}, editProvider() {}, refreshModels() {}, setQuery() {},
  }
`

const page = `<!doctype html>
<html><body>
  <div id="live"></div>
  <div id="multi"></div>
  <div id="single"></div>
  <div id="none"></div>
  <div id="not-configured"></div>
  <div id="unreachable"></div>
  <div id="empty"></div>
  <div id="loading"></div>
  <div id="refused"></div>
  <div id="unknown"></div>
  <div id="confirm"></div>
  <div id="actions"></div>
  <div id="noissue"></div>
  <div id="issuelist"></div>
  <div id="issueempty"></div>
  <div id="issuerefused"></div>
  <div id="foreign"></div>
  <script>
${script}
${controllerScript}
    const render = (id, next) => {
      STATE = next
      renderConsole(document.getElementById(id), controller)
      return document.getElementById(id)
    }
    // 1. Live workspace.
    const live = render('live', ${JSON.stringify(state())})
    // 2. Two actors and no choice yet: the actor control must be reachable on this screen.
    const multi = render('multi', ${JSON.stringify(state({ actors: ['agent-a', 'agent-b'], actorId: undefined, groups: [], listStatus: 'idle', messages: [], messageStatus: 'idle' }))})
    // 3. A single actor is chosen automatically and shows no forced choice.
    const single = render('single', ${JSON.stringify(state({ actors: ['agent-a'], actorId: 'agent-a' }))})
    // 4. No eligible actor: a typed not-configured state with every action disabled.
    const none = render('none', ${JSON.stringify(state({ actors: [], actorId: undefined, groups: [], listStatus: 'idle', messages: [], messageStatus: 'idle' }))})
    const notConfigured = render('not-configured', ${JSON.stringify(state({ access: { kind: 'not-configured', message: 'the group owner is not bound to this control daemon' } }))})
    const unreachable = render('unreachable', ${JSON.stringify(state({ access: { kind: 'unreachable', message: 'the group endpoint did not answer' } }))})
    // 7. An empty owner answer is not a failure.
    const empty = render('empty', ${JSON.stringify(state({ groups: [], selectedGroupId: undefined, listStatus: 'empty', messages: [], messageStatus: 'idle' }))})
    const loading = render('loading', ${JSON.stringify(state({ groups: [], selectedGroupId: undefined, listStatus: 'loading', messages: [], messageStatus: 'idle' }))})
    // 9. A refused owner answer and an unknown mutation both stay visibly not-successful.
    const refused = render('refused', ${JSON.stringify(state({ listStatus: 'refused', groups: [], selectedGroupId: undefined, messages: [], messageStatus: 'idle', outcome: { kind: 'refused', code: 'FORBIDDEN', message: 'not declared' } }))})
    const unknown = render('unknown', ${JSON.stringify(state({ messageStatus: 'unknown', outcome: { kind: 'unknown', frame: 'message.send', code: 'RESULT_UNKNOWN', message: 'no answer' }, retryable: { intentKey: 'message.send:g1:hi', requestId: 'req-1', commitId: 'commit-1', frame: { kind: 'message.send', requestId: 'req-1', commitId: 'commit-1', groupId: 'g1', targetAgentIds: ['agent-a'], replyRequired: false, body: 'hi' } } }))})
    // 10. A parked critical action names its target before anything is sent.
    const confirm = render('confirm', ${JSON.stringify(state({ confirm: { intentKey: 'issue.close:s1', requestId: 'req-2', commitId: 'commit-2', frame: { kind: 'issue.close', requestId: 'req-2', commitId: 'commit-2', sessionId: 's1', reason: 'done', conclusion: 'closed' } } }))})

    const html = id => document.getElementById(id).outerHTML
    const attr = (root, name) => root.querySelector('[' + name + ']')?.getAttribute(name) ?? null

    document.body.dataset.workspaceMarker = String(attr(live, 'data-group-workspace') === 'true')
    document.body.dataset.listStateMarker = String(attr(live, 'data-group-list-state') === 'ready')
    document.body.dataset.itemMarkers = String(live.querySelectorAll('[data-group-item="g1"]').length > 0)
    document.body.dataset.messagesMarker = String(attr(live, 'data-group-messages') === 'true')
    document.body.dataset.composerMarker = String(attr(live, 'data-group-composer') === 'true')
    document.body.dataset.outcomeMarker = String(attr(live, 'data-group-outcome') === 'idle')
    document.body.dataset.accessReady = String(attr(live, 'data-group-access') === 'ready')
    document.body.dataset.messageRendered = String(live.querySelectorAll('[data-group-message="m1"]').length === 1)

    // The reported dead end: two actors, none chosen, and no way to choose inside the page.
    const multiSelect = multi.querySelector('[data-group-actor-select]')
    document.body.dataset.multiActorSelectReachable = String(multiSelect !== null)
    document.body.dataset.multiActorOptions = String(
      multiSelect !== null && [...multiSelect.options].map(option => option.value).join(',') === 'agent-a,agent-b')
    document.body.dataset.multiActorPending = String(attr(multi, 'data-group-actor-pending') === 'true')
    document.body.dataset.multiActorNotCalledNotConfigured = String(attr(multi, 'data-group-access') !== 'not-configured')
    // Choosing an actor must drive the controller, which loads the real group list.
    if (multiSelect !== null) {
      multiSelect.value = 'agent-b'
      multiSelect.dispatchEvent(new Event('change', { bubbles: true }))
    }
    document.body.dataset.multiActorChangeReported = String(calls.actor.join(',') === 'agent-b')

    document.body.dataset.singleActorAutoSelected = String(
      attr(single, 'data-group-actor') === 'agent-a' && single.querySelector('[data-group-actor-select]') === null)

    const noneSelect = none.querySelector('[data-group-actor-select]')
    // The no-actor screen renders no operable control at all: nothing can be sent.
    const noneDisabled = [...none.querySelectorAll('button')]
      .filter(button => button.hasAttribute('data-group-send') || button.hasAttribute('data-group-invite-action') || button.hasAttribute('data-group-issue-action'))
      .every(button => button.disabled === true)
    document.body.dataset.noActorNotConfigured = String(attr(none, 'data-group-access') === 'not-configured')
    document.body.dataset.noActorNoSelect = String(noneSelect === null)
    // Nothing is rendered to send with, so "no action" is the whole surface.
    document.body.dataset.noActorNoComposer = String(none.querySelector('[data-group-composer]') === null)
    document.body.dataset.noActorActionsDisabled = String(noneDisabled)

    document.body.dataset.notConfiguredSeparate = String(
      attr(notConfigured, 'data-group-access') === 'not-configured'
      && notConfigured.querySelector('[data-group-error-code]')?.getAttribute('data-group-error-code') === 'GROUP_ENDPOINT_NOT_CONFIGURED')
    document.body.dataset.unreachableSeparate = String(
      attr(unreachable, 'data-group-access') === 'unreachable'
      && unreachable.querySelector('[data-group-error-code]')?.getAttribute('data-group-error-code') === 'GROUP_ENDPOINT_UNREACHABLE')

    document.body.dataset.emptyMarker = String(attr(empty, 'data-group-phase') === 'empty')
    document.body.dataset.loadingMarker = String(attr(loading, 'data-group-phase') === 'loading')
    document.body.dataset.refusedMarker = String(attr(refused, 'data-group-phase') === 'refused')
    document.body.dataset.unknownMarker = String(attr(unknown, 'data-group-outcome') === 'unknown')
    document.body.dataset.unknownNotSucceeded = String(!html('unknown').includes('data-group-outcome="succeeded"'))
    document.body.dataset.unknownRetryable = String(attr(unknown, 'data-group-retry') === 'true')

    const confirmTarget = confirm.querySelector('[data-group-confirm-target]')?.getAttribute('data-group-confirm-target') ?? ''
    document.body.dataset.confirmMarker = String(attr(confirm, 'data-group-confirm') === 'issue.close')
    document.body.dataset.confirmNamesTarget = String(confirmTarget.includes('issue.close:s1'))
    document.body.dataset.confirmHasAccept = String(attr(confirm, 'data-group-confirm-accept') === 'true')
    document.body.dataset.confirmHasCancel = String(attr(confirm, 'data-group-confirm-cancel') === 'true')

    // 11. Two actions for one agent: the finished one may never hide the unfinished one.
    const actions = render('actions', ${JSON.stringify(actionsState)})
    const topLevelItems = [...actions.querySelectorAll('[data-group-action]')]
      .filter(item => !item.closest('[data-group-action-finished]'))
    document.body.dataset.actionUnfinishedCount = String(attr(actions, 'data-group-action-unfinished') === '1')
    document.body.dataset.actionTotalCount = String(attr(actions, 'data-group-action-total') === '2')
    // The older unfinished action stays in the visible list, not inside the folded section.
    document.body.dataset.actionUnfinishedVisible = String(
      topLevelItems.some(item => item.getAttribute('data-group-action') === 'a-old'))
    document.body.dataset.actionFinishedFolded = String(
      attr(actions, 'data-group-action-finished') === '1'
      && actions.querySelector('[data-group-action="a-new"]')?.closest('details[data-group-action-finished]') !== null)
    // Identifiers are diagnostics only: the task surface must not carry them.
    const actionHead = actions.querySelector('[data-group-action="a-old"] .teams-group-action-head')?.textContent ?? ''
    document.body.dataset.actionHeadHasNoIds = String(!actionHead.includes('a-old') && !actionHead.includes('commit-old'))
    document.body.dataset.actionDiagnosticsCarryIds = String(
      actions.querySelector('[data-group-action-id="a-old"]') !== null
      && actions.querySelector('[data-group-action-commit="commit-old"]') !== null)

    // 12. No issue: the panel states the missing step and shows no group-wide action list.
    const noissue = render('noissue', ${JSON.stringify(state({ issue: null, issueStatus: 'idle', actions: [], actionStatus: 'empty' }))})
    document.body.dataset.actionNoIssueHint = String(attr(noissue, 'data-group-action-no-issue') === 'true')
    document.body.dataset.actionNoIssueNoList = String(noissue.querySelector('[data-group-action]') === null)

    // 13. The group's own issue list opens an issue already owned by the group.
    const issuelist = render('issuelist', ${JSON.stringify(state({ issue: null, issueStatus: 'idle', issues: [issueSession], issueListStatus: 'ready', actions: [], actionStatus: 'empty' }))})
    document.body.dataset.issueListMarker = String(attr(issuelist, 'data-group-issue-list') === 'true')
    document.body.dataset.issueListState = String(attr(issuelist, 'data-group-issue-list-state') === 'ready')
    document.body.dataset.issueListItem = String(issuelist.querySelector('[data-group-issue-item="s1"]') !== null)
    document.body.dataset.issueListOpen = String(issuelist.querySelector('[data-group-issue-open="s1"]') !== null)
    const issueOpenButton = issuelist.querySelector('[data-group-issue-open="s1"]')
    if (issueOpenButton !== null) issueOpenButton.click()
    document.body.dataset.issueOpenCalled = String(calls.openIssue.join(',') === 's1')
    document.body.dataset.issueListLabelCarriesId = String(
      (issuelist.querySelector('[data-group-issue-item="s1"] .teams-group-issue-label')?.textContent ?? '').includes('p1/i1'))
    document.body.dataset.issueCreateFormStillPresent = String(issuelist.querySelector('[data-group-issue-action="create"]') !== null)

    // 14. An empty issue list keeps the create form and states the empty section.
    const issueempty = render('issueempty', ${JSON.stringify(state({ issue: null, issueStatus: 'idle', issues: [], issueListStatus: 'empty', actions: [], actionStatus: 'empty' }))})
    document.body.dataset.issueListEmptyMarker = String(attr(issueempty, 'data-group-issue-empty') === 'true')
    document.body.dataset.issueListEmptyState = String(attr(issueempty, 'data-group-issue-list-state') === 'empty')
    document.body.dataset.issueListEmptyNoItems = String(issueempty.querySelector('[data-group-issue-item]') === null)
    document.body.dataset.issueListEmptyCreateForm = String(issueempty.querySelector('[data-group-issue-action="create"]') !== null)

    // 15. A refused issue list shows its own hint and does not hide the create form.
    const issuerefused = render('issuerefused', ${JSON.stringify(state({ issue: null, issueStatus: 'idle', issues: [], issueListStatus: 'refused', actions: [], actionStatus: 'empty' }))})
    document.body.dataset.issueListRefusedError = String(issuerefused.querySelector('[data-group-issue-list-error]') !== null)
    document.body.dataset.issueListRefusedState = String(attr(issuerefused, 'data-group-issue-list-state') === 'refused')
    document.body.dataset.issueListRefusedCreateForm = String(issuerefused.querySelector('[data-group-issue-action="create"]') !== null)

    // 16. A parked result owned by another context offers no retry control here.
    const foreign = render('foreign', ${JSON.stringify(state({
      issue: issueSession,
      issueStatus: 'ready',
      outcome: { kind: 'unknown', frame: 'action.submit', code: 'RESULT_UNKNOWN', message: 'kept by another context' },
      retryable: {
        intentKey: 'action.submit:a1',
        requestId: 'req-foreign',
        commitId: 'commit-foreign',
        context: { actorId: 'agent-b', groupId: 'g1' },
        frame: { kind: 'action.submit', requestId: 'req-foreign', resultCommitId: 'commit-foreign', actionId: 'a1', resultBody: 'done' },
      },
    }))})
    document.body.dataset.foreignContextNoRetry = String(foreign.querySelector('[data-group-retry]') === null)
  </script>
</body></html>`

function runChrome(file: string, windowSize?: string, extraFlags: readonly string[] = []): string {
  const profileDirectory = mkdtempSync(join(tmpdir(), 'teams-console-groups-profile-'))
  try {
    return execFileSync(chromeExecutable(), [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      ...(windowSize === undefined ? [] : [`--window-size=${windowSize}`]),
      ...extraFlags,
      `--user-data-dir=${profileDirectory}`,
      '--dump-dom',
      pathToFileURL(file).toString(),
    ], { encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'ignore'] })
  } finally {
    rmSync(profileDirectory, { recursive: true, force: true })
  }
}

/**
 * A live workspace measured in the browser. The shipped stylesheet is injected into the same
 * document, so the numbers come from real layout, not from the stylesheet text.
 */
const layoutPage = `<!doctype html>
<html><head><style></style></head><body>
  <div id="frame" style="width:390px;overflow:hidden;position:relative"><div id="root" class="teams-root"></div></div>
  <script>
${script}
${controllerScript}
    // The shipped panel is a fixed full-viewport overlay. Confining it to the 390px frame
    // makes the mobile layout measurable at its real width; no other rule is overridden.
    document.querySelector('style').textContent =
      ${JSON.stringify(teamsStyles)} + '#frame .teams-overlay { position: absolute; inset: 0; }'
    STATE = ${JSON.stringify(state({ actions: [{ actionId: 'a1', sessionId: 's1', kind: 'reply', assigneeAgentId: 'agent-a-very-long-identifier', reason: 'A reason long enough to wrap inside the narrow column without widening the page body.', state: 'accepted', expectedResult: 'x', replyRequired: false, createdAt: '2026-10-20T00:00:00.000Z' }], messageStatus: 'ready' }))}
    renderConsole(document.getElementById('root'), controller)
    const root = document.getElementById('root')
    const frame = document.getElementById('frame')
    const frameWidth = frame.getBoundingClientRect().width
    const composer = root.querySelector('[data-group-composer]')
    const composerRect = composer === null ? null : composer.getBoundingClientRect()
    // Overflow is measured against the narrow frame the workspace was given, so a wide
    // desktop window cannot hide a mobile layout that spills sideways.
    document.body.dataset.frameWidth = String(Math.round(frameWidth))
    document.body.dataset.documentScrollWidth = String(document.documentElement.scrollWidth)
    document.body.dataset.documentViewportWidth = String(document.documentElement.clientWidth)
    document.body.dataset.noHorizontalOverflow = String(
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
      && frame.scrollWidth <= Math.ceil(frameWidth) + 1)
    document.body.dataset.composerPresent = String(composer !== null)
    document.body.dataset.composerInputVisible = String(
      composer !== null
      && composerRect !== null
      && composerRect.width > 0
      && composerRect.height > 0
      && composerRect.right <= Math.ceil(frameWidth) + 1
      && composerRect.left >= -1)
    const longBody = root.querySelector('[data-group-message="m1"] .teams-group-message-body')
    document.body.dataset.messageWraps = String(longBody !== null && longBody.getBoundingClientRect().width <= Math.ceil(frameWidth) + 1)
    const list = root.querySelector('[data-group-list]')
    const detail = root.querySelector('[data-group-detail]')
    document.body.dataset.desktopTwoColumn = String(
      list !== null && detail !== null
      && list.getBoundingClientRect().right <= detail.getBoundingClientRect().left + 1)
  </script>
</body></html>`

function measureLayout(windowSize: string, extraFlags: readonly string[] = []): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'teams-console-groups-layout-'))
  try {
    const file = join(directory, 'layout.html')
    writeFileSync(file, layoutPage)
    const output = runChrome(file, windowSize, extraFlags)
    const match = /<body([^>]*)>/.exec(output)
    const attributes = match?.[1] ?? ''
    const read = (name: string): string => new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1] ?? ''
    return {
      frameWidth: read('data-frame-width'),
      documentViewportWidth: read('data-document-viewport-width'),
      documentScrollWidth: read('data-document-scroll-width'),
      noHorizontalOverflow: read('data-no-horizontal-overflow'),
      composerPresent: read('data-composer-present'),
      composerInputVisible: read('data-composer-input-visible'),
      messageWraps: read('data-message-wraps'),
      desktopTwoColumn: read('data-desktop-two-column'),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * A real full-page mobile load. The shipped overlay is fixed to the viewport and nothing is
 * confined to a frame, so the composer rect is measured against the actual window the owner
 * checks: visible before any scroll and never below `window.innerHeight`.
 */
const fullMobilePage = `<!doctype html>
<html><head><style></style></head><body>
  <div id="root" class="teams-root"></div>
  <script>
${script}
${controllerScript}
    document.querySelector('style').textContent = ${JSON.stringify(teamsStyles)}
    STATE = ${JSON.stringify(state({ messages: Array.from({ length: 8 }, (_, index) => ({
      messageId: `m${index}`,
      commitId: `c${index}`,
      sequence: index + 1,
      groupId: 'g1',
      fromAgentId: 'agent-a',
      targetAgentIds: [],
      replyRequired: false,
      body: 'A long message body that keeps the detail tall enough for the composer to need a fixed bottom position at a narrow viewport width. '.repeat(3),
      sentAt: `2026-10-20T00:00:0${index}.000Z`,
    })), messageStatus: 'ready', issue: issueSession, issues: [issueSession], issueListStatus: 'ready', actions: [{ actionId: 'a1', commitId: 'c1', sessionId: 's1', initiatorAgentId: 'agent-a', assigneeAgentId: 'agent-a', kind: 'reply', reason: 'review', expectedResult: 'answer', replyRequired: false, state: 'pending', createdAt: '2026-10-20T00:00:00.000Z' }], actionStatus: 'ready' }))}
    renderConsole(document.getElementById('root'), controller)
    const input = document.querySelector('[data-group-composer-input]')
    const rect = input === null ? null : input.getBoundingClientRect()
    const groupSelect = document.querySelector('[data-group-mobile-group]')
    const issueSelect = document.querySelector('[data-group-mobile-issue]')
    const messagesNode = document.querySelector('[data-group-messages]')
    const messagesRect = messagesNode === null ? null : messagesNode.getBoundingClientRect()
    document.body.dataset.viewportWidth = String(window.innerWidth)
    document.body.dataset.scrollOverflow = String(document.documentElement.scrollWidth - window.innerWidth)
    document.body.dataset.composerVisible = String(
      rect !== null && rect.width > 0 && rect.height > 0 && rect.bottom <= window.innerHeight + 1)
    document.body.dataset.groupOptions = groupSelect === null ? '' : [...groupSelect.options].map(option => option.value).join(',')
    document.body.dataset.issueOptions = issueSelect === null ? '' : [...issueSelect.options].map(option => option.value).join(',')
    document.body.dataset.messagesVisible = String(
      messagesRect !== null && messagesRect.top < window.innerHeight && messagesRect.bottom > 0)
  </script>
</body></html>`

function measureFullMobile(windowSize: string): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'teams-console-groups-mobile-'))
  try {
    const file = join(directory, 'mobile.html')
    writeFileSync(file, fullMobilePage)
    const output = runChrome(file, windowSize)
    const match = /<body([^>]*)>/.exec(output)
    const attributes = match?.[1] ?? ''
    const read = (name: string): string => new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1] ?? ''
    return {
      viewportWidth: read('data-viewport-width'),
      scrollOverflow: read('data-scroll-overflow'),
      composerVisible: read('data-composer-visible'),
      groupOptions: read('data-group-options'),
      issueOptions: read('data-issue-options'),
      messagesVisible: read('data-messages-visible'),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

/**
 * The member area renders invitation rows from the validated owner reply and drops the
 * invitation row once the owner's list proves the invited agent is an active member.
 */
const invitationPage = `<!doctype html>
<html><body>
  <div id="invited"></div>
  <div id="joined"></div>
  <div id="declined"></div>
  <script>
${script}
${controllerScript}
    const render = (id, next) => {
      STATE = next
      renderConsole(document.getElementById(id), controller)
      return document.getElementById(id)
    }
    const invited = render('invited', ${JSON.stringify(state({ invitations: [{ groupId: 'g1', agentId: 'agent-b', role: 'peer', mastersOf: [], invitedByAgentId: 'agent-a', state: 'pending', createdAt: '2026-10-20T00:00:00.000Z' }] }))})
    const joined = render('joined', ${JSON.stringify(state({ invitations: [{ groupId: 'g1', agentId: 'agent-b', role: 'peer', mastersOf: [], invitedByAgentId: 'agent-a', state: 'pending', createdAt: '2026-10-20T00:00:00.000Z' }], groups: [{ ...group, members: [...group.members, { agentId: 'agent-b', role: 'peer', mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:01:00.000Z' }] }] }] }))})
    const declined = render('declined', ${JSON.stringify(state({ invitations: [{ groupId: 'g1', agentId: 'agent-b', role: 'peer', mastersOf: [], invitedByAgentId: 'agent-a', state: 'declined', createdAt: '2026-10-20T00:00:00.000Z' }] }))})
    document.body.dataset.invitationPending = String(
      invited.querySelector('[data-group-invitation="agent-b"]')?.getAttribute('data-group-invitation-state') === 'pending')
    document.body.dataset.invitationPendingNoMember = String(
      invited.querySelector('[data-group-member="agent-b"]') === null)
    document.body.dataset.invitationJoinedMember = String(
      joined.querySelector('[data-group-member="agent-b"]') !== null)
    document.body.dataset.invitationJoinedHidden = String(
      joined.querySelector('[data-group-invitation="agent-b"]') === null)
    document.body.dataset.invitationDeclined = String(
      declined.querySelector('[data-group-invitation="agent-b"]')?.getAttribute('data-group-invitation-state') === 'declined')
  </script>
</body></html>`

describe('group workspace DOM contract in a real DOM', () => {
  it('keeps a narrow 390px viewport free of horizontal overflow with a visible composer', { timeout: 30_000 }, () => {
    const narrow = measureLayout('390,844')
    // The media query breakpoint engages at this width, so this is the real mobile layout.
    expect(Number(narrow.frameWidth)).toBe(390)
    expect(narrow.composerPresent).toBe('true')
    expect(narrow.composerInputVisible).toBe('true')
    expect(narrow.messageWraps).toBe('true')
    expect(narrow.noHorizontalOverflow).toBe('true')
  })

  it('keeps a desktop viewport free of horizontal overflow', { timeout: 30_000 }, () => {
    const desktop = measureLayout('1280,900')
    expect(desktop.composerInputVisible).toBe('true')
    expect(desktop.noHorizontalOverflow).toBe('true')
    expect(desktop.desktopTwoColumn).toBe('true')
    expect(Number(desktop.documentViewportWidth)).toBeGreaterThan(390)
  })

  it('shows the composer above the fold on a real 390x844 full-page load without scrolling', { timeout: 30_000 }, () => {
    const mobile = measureFullMobile('390,844')
    // Headless Chrome clamps the requested 390px window to a 500px minimum, so accept the
    // actual narrow viewport while the load still uses `--window-size=390,844`.
    expect(Number(mobile.viewportWidth)).toBeLessThanOrEqual(780)
    expect(mobile.composerVisible).toBe('true')
    expect(Number(mobile.scrollOverflow)).toBeLessThanOrEqual(0)
    expect(mobile.groupOptions).toBe('g1')
    expect(mobile.issueOptions).toBe('s1')
    expect(mobile.messagesVisible).toBe('true')
  })

  it('renders a pending invitation without a member and hides it once the member joined', { timeout: 30_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'teams-console-invitation-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const file = join(directory, 'invitation.html')
    writeFileSync(file, invitationPage)
    const output = runChrome(file)
    for (const marker of [
      'data-invitation-pending',
      'data-invitation-pending-no-member',
      'data-invitation-joined-member',
      'data-invitation-joined-hidden',
      'data-invitation-declined',
    ]) {
      expect(output, marker).toContain(`${marker}="true"`)
    }
  })

  it('renders every group phase and keeps the actor choice reachable', { timeout: 30_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'teams-console-groups-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const file = join(directory, 'groups.html')
    writeFileSync(file, page)
    const output = runChrome(file)
    for (const marker of [
      'data-workspace-marker',
      'data-list-state-marker',
      'data-item-markers',
      'data-messages-marker',
      'data-composer-marker',
      'data-outcome-marker',
      'data-access-ready',
      'data-message-rendered',
      'data-multi-actor-select-reachable',
      'data-multi-actor-options',
      'data-multi-actor-pending',
      'data-multi-actor-not-called-not-configured',
      'data-multi-actor-change-reported',
      'data-single-actor-auto-selected',
      'data-no-actor-not-configured',
      'data-no-actor-no-select',
      'data-no-actor-no-composer',
      'data-no-actor-actions-disabled',
      'data-not-configured-separate',
      'data-unreachable-separate',
      'data-empty-marker',
      'data-loading-marker',
      'data-refused-marker',
      'data-unknown-marker',
      'data-unknown-not-succeeded',
      'data-unknown-retryable',
      'data-confirm-marker',
      'data-confirm-names-target',
      'data-confirm-has-accept',
      'data-confirm-has-cancel',
      'data-action-unfinished-count',
      'data-action-total-count',
      'data-action-unfinished-visible',
      'data-action-finished-folded',
      'data-action-head-has-no-ids',
      'data-action-diagnostics-carry-ids',
      'data-action-no-issue-hint',
      'data-action-no-issue-no-list',
      'data-issue-list-marker',
      'data-issue-list-state',
      'data-issue-list-item',
      'data-issue-list-open',
      'data-issue-open-called',
      'data-issue-list-label-carries-id',
      'data-issue-create-form-still-present',
      'data-issue-list-empty-marker',
      'data-issue-list-empty-state',
      'data-issue-list-empty-no-items',
      'data-issue-list-empty-create-form',
      'data-issue-list-refused-error',
      'data-issue-list-refused-state',
      'data-issue-list-refused-create-form',
      'data-foreign-context-no-retry',
    ]) {
      expect(output, marker).toContain(`${marker}="true"`)
    }
  })
})
