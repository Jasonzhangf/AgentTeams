import { describe, expect, it, onTestFinished } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

function chromeExecutable(): string {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter((value): value is string => Boolean(value))
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) throw new Error('Real-DOM test requires a Chrome/Chromium executable (set CHROME_PATH or CHROME_BIN).')
  return found
}

function classicModule(relativePath: string): string {
  const source = readFileSync(join(import.meta.dirname, '..', 'src', relativePath), 'utf8')
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText
  return output
    .split('\n')
    .filter(line => !/^\s*import\b/.test(line))
    .filter(line => !/^\s*export\s*\{/.test(line))
    .map(line => line.replace(/^export\s+(?=(?:function|const|let|var|class)\b)/, ''))
    .join('\n')
    .replaceAll('import.meta.url', 'location.href')
}

const script = [
  classicModule('client/locale.ts'),
  classicModule('state/model.ts'),
  classicModule('state/group-workspace.ts'),
  classicModule('components/dom.ts'),
  classicModule('components/page-groups.ts'),
  classicModule('styles.ts'),
  classicModule('components/render.ts'),
].join('\n')

function runChrome(file: string, windowSize?: string): string {
  const profileDirectory = mkdtempSync(join(tmpdir(), 'teams-console-settings-profile-'))
  try {
    return execFileSync(chromeExecutable(), [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      ...(windowSize === undefined ? [] : [`--window-size=${windowSize}`]),
      `--user-data-dir=${profileDirectory}`,
      '--dump-dom',
      pathToFileURL(file).toString(),
    ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] })
  } finally {
    rmSync(profileDirectory, { recursive: true, force: true })
  }
}

const baseGroup = {
  groupId: 'g1', name: 'Alpha', ownerAgentId: 'agent-a', createdAt: '2026-10-20T00:00:00.000Z',
  members: [
    { agentId: 'agent-a', role: 'master', mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] },
    { agentId: 'agent-b', role: 'peer', mastersOf: ['agent-a'], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] },
  ],
}
const openIssue = {
  sessionId: 's1', groupId: 'g1', vikunjaProjectId: 'p1', vikunjaIssueId: 'i1',
  initiatorAgentId: 'agent-a', state: 'open', openedAt: '2026-10-20T00:00:00.000Z', lastOpSeq: 1,
}

describe('WebUI UX F1/F2/F3/F4 real-DOM regression', () => {
  it('preserves provider input focus and draft, renders configs binding/uncertain/degrade, relation cards, collapsed advanced action fields, and a non-leaking in-place confirm', { timeout: 40_000 }, () => {
    const page = `<!doctype html>
<html><head><style>html,body{margin:0;padding:0}</style></head><body>
  <div id="settings" class="teams-root"></div>
  <div id="degrade" class="teams-root"></div>
  <div id="rowmissing" class="teams-root"></div>
  <div id="network" class="teams-root"></div>
  <div id="groups" class="teams-root"></div>
  <script>
${script}
document.querySelector('style').textContent += teamsStyles
window.addEventListener('error', e => { document.body.dataset.jsError = document.body.dataset.jsError ? (document.body.dataset.jsError + ' | ' + e.message) : String(e.message) })

const settingsProjection = {
  version: 1,
  agents: [{ kind: 'runtime', agentId: 'planner', label: 'Planner', machineId: 'M1', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current' }],
  sessions: [], notifications: [], sessionEvents: [], works: [], relations: [], connections: [],
  configs: [{
    agentId: 'planner', acceptedRevision: 2, effectiveRevision: 2, applyState: 'uncertain',
    acceptedBinding: { primary: { providerInstanceId: 'rcc-4444', modelId: 'gpt-5.5' }, backup: { providerInstanceId: 'rcc-4444', modelId: 'kk.glm-5.3-flash' } },
    providers: [{ id: 'rcc-4444', label: 'Local RCC 4444', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:4444/v1', enabled: true, authKind: 'none', catalogState: 'ready', models: [{ id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'kk.glm-5.3-flash', label: 'GLM 5.3 Flash' }] }],
  }],
}

function baseState(overrides) {
  return Object.assign({
    open: true, live: true, page: 'networking', entry: 'topology', locale: 'en', status: 'ready',
    projection: settingsProjection, observation: { projection: settingsProjection, observation: 'live', health: { state: 'live' } },
    drawer: null, drawerStack: [], drawerExpanded: false, selectedAgentId: 'planner', selectedSessionId: 's1',
    providerFormOpen: false,
    providerDraft: { id: '', label: '', protocol: 'openai-chat', apiBaseUrl: '', enabled: true, authKind: 'none', credentialRef: '' },
    membershipDraft: [], messageDraft: '', cancelState: 'idle', history: null, historyStatus: 'idle', historyError: null,
    refusedError: null, query: '', busy: null, error: null, notice: null, groupCapable: true, group: null,
  }, overrides)
}

// ---- F1 + F4: Settings provider inputs, acceptedBinding, applyState, and empty-config degrade ----
let settingsState = baseState({ drawer: { kind: 'settings', agentId: 'planner' }, drawerStack: [{ kind: 'settings', agentId: 'planner' }], providerFormOpen: true })
const rootSettings = document.getElementById('settings')
const settingsController = {
  getSnapshot: () => settingsState,
  setProviderDraft(key, value) { settingsState = { ...settingsState, providerDraft: { ...settingsState.providerDraft, [key]: value } } },
  setProviderAuthKind() {}, beginAddProvider() {}, editProvider() {}, refreshModels: async () => true,
  bindModel: async () => true, applyConfig: async () => true, putProvider: async () => true, closeProviderForm() {}, closeDrawer() {}, toggleDrawerExpanded() {},
}
renderConsole(rootSettings, settingsController)
const providerField = rootSettings.querySelector('[data-focus-key="provider:label"]')
providerField.focus()
providerField.value = 'Draft provider label'
providerField.dispatchEvent(new Event('input', { bubbles: true }))
providerField.setSelectionRange(3, 8)
renderConsole(rootSettings, settingsController)
const providerAfter = rootSettings.querySelector('[data-focus-key="provider:label"]')
document.body.dataset.providerValueKept = String(providerAfter.value === 'Draft provider label')
document.body.dataset.providerFocusedKept = String(document.activeElement === providerAfter)
document.body.dataset.providerSelKept = String(providerAfter.selectionStart === 3 && providerAfter.selectionEnd === 8)
document.body.dataset.providerModelVisible = String([...rootSettings.querySelectorAll('article.teams-provider-card select.teams-select option')].some(option => option.value === 'gpt-5.5'))
const bindingRow = rootSettings.querySelector('[data-config-binding="true"]')
document.body.dataset.bindingPrimary = String((bindingRow?.textContent ?? '').includes('rcc-4444/gpt-5.5'))
document.body.dataset.bindingBackup = String((bindingRow?.textContent ?? '').includes('kk.glm-5.3-flash'))
document.body.dataset.applyUncertain = String((rootSettings.textContent ?? '').includes('may not be active'))

const degradeProjection = { ...settingsProjection, configs: [] }
const degradeRoot = document.getElementById('degrade')
renderConsole(degradeRoot, { getSnapshot: () => baseState({ drawer: { kind: 'settings', agentId: 'planner' }, drawerStack: [{ kind: 'settings', agentId: 'planner' }], projection: degradeProjection, observation: { projection: degradeProjection, observation: 'live', health: { state: 'live' } } }) })
document.body.dataset.configDegraded = String(degradeRoot.querySelector('[data-config-unavailable="true"]') !== null)
// A host that projects other Agents but no row for this one keeps the narrower wording.
const rowMissingProjection = { ...settingsProjection, configs: [{ ...settingsProjection.configs[0], agentId: 'other' }] }
const rowMissingRoot = document.getElementById('rowmissing')
renderConsole(rowMissingRoot, { getSnapshot: () => baseState({ drawer: { kind: 'settings', agentId: 'planner' }, drawerStack: [{ kind: 'settings', agentId: 'planner' }], projection: rowMissingProjection, observation: { projection: rowMissingProjection, observation: 'live', health: { state: 'live' } } }) })
document.body.dataset.rowMissingWording = String((rowMissingRoot.querySelector('[data-config-unavailable="true"]')?.textContent ?? '') === 'This Agent has no projected configuration.')

// ---- F2: networking relation cards + removable draft member (no new backend action) ----
const netProjection = {
  version: 1,
  agents: [
    { kind: 'runtime', agentId: 'planner', label: 'Planner', machineId: 'M1', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current' },
    { kind: 'runtime', agentId: 'worker', label: 'Worker', machineId: 'M1', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current' },
  ],
  sessions: [], notifications: [], configs: [], sessionEvents: [], connections: [],
  relations: [{ agentId: 'planner', providerAgentId: 'planner', consumerAgentId: 'worker', capabilityId: 'session', capabilityVersion: 1, relationPermission: 'granted' }],
}
const netRoot = document.getElementById('network')
renderConsole(netRoot, { getSnapshot: () => baseState({ page: 'networking', projection: netProjection, membershipDraft: [{ agentId: 'worker', role: 'peer' }] }) })
const relationCard = netRoot.querySelector('.teams-relation-card')
document.body.dataset.relationCard = String(relationCard !== null
  && (relationCard.textContent ?? '').includes('Planner → Worker')
  && (relationCard.textContent ?? '').includes('session@1')
  && netRoot.querySelector('[data-team-role-accepted="granted"]') !== null)
document.body.dataset.draftRemoveButton = String(netRoot.querySelector('[data-team-draft-remove="worker"]') !== null)

// ---- F3: collapsed advanced action fields, terminal actions hide controls, in-place confirm ----
const actions = [
  { actionId: 'apend', commitId: 'c-pend', sessionId: 's1', initiatorAgentId: 'agent-b', assigneeAgentId: 'agent-a', kind: 'reply', reason: 'please review', expectedResult: 'answer', replyRequired: true, state: 'pending', createdAt: '2026-10-20T00:00:00.000Z' },
  { actionId: 'afin', commitId: 'c-fin', sessionId: 's1', initiatorAgentId: 'agent-a', assigneeAgentId: 'agent-a', kind: 'reply', reason: 'done', expectedResult: 'answer', replyRequired: false, state: 'completed', createdAt: '2026-10-20T00:00:00.000Z' },
]
const groupState = {
  access: { kind: 'ready' }, listStatus: 'ready', groups: [${JSON.stringify(baseGroup)}], selectedGroupId: 'g1', invitations: [],
  messageStatus: 'ready', messages: [], messageHasMore: false,
  issue: ${JSON.stringify(openIssue)}, issueStatus: 'ready', issues: [${JSON.stringify(openIssue)}], issueListStatus: 'ready',
  actions, actionStatus: 'ready', composer: '', manageOpen: false, actors: ['agent-a', 'agent-b'], actorId: 'agent-a',
  mutation: null, retryable: null, commits: {}, outcome: { kind: 'idle' },
  confirm: { intentKey: 'issue.close:s1', requestId: 'req-2', commitId: 'commit-2', frame: { kind: 'issue.close', requestId: 'req-2', commitId: 'commit-2', sessionId: 's1', reason: 'done', conclusion: 'closed' } },
  stopReport: null, readError: null,
}
const groupsRoot = document.getElementById('groups')
renderConsole(groupsRoot, { getSnapshot: () => baseState({ page: 'groups', projection: settingsProjection, group: groupState }), confirmPendingGroupAction: async () => true, cancelPendingGroupAction() {}, closeDrawer() {}, toggleDrawerExpanded() {} })
const pend = groupsRoot.querySelector('[data-group-action="apend"]')
const fin = groupsRoot.querySelector('[data-group-action="afin"]')
const advanced = pend?.querySelector('details.teams-group-action-advanced')
document.body.dataset.pendingRowVisible = String(pend?.querySelector('.teams-group-action-row [data-group-action-verb="submit"]') !== null)
document.body.dataset.advancedCollapsed = String(advanced !== null && advanced.open === false)
document.body.dataset.advancedHoldsReport = String(advanced?.querySelector('[data-group-action-verb="report-blocked"]') !== null)
document.body.dataset.reportMarkerKept = String(pend?.getAttribute('data-group-action-report-permitted') === 'true')
document.body.dataset.terminalHidesRow = String(fin !== null && fin.querySelector('.teams-group-action-row') === null && fin.querySelector('[data-group-action-verb]') === null)
const confirmPanel = groupsRoot.querySelector('[data-group-confirm="issue.close"]')
const confirmStyle = confirmPanel === null ? null : getComputedStyle(confirmPanel)
document.body.dataset.confirmMaxHeight = String(confirmStyle !== null && confirmStyle.maxHeight !== 'none' && confirmStyle.overflowY === 'auto')
document.body.dataset.confirmHidesIntent = String(confirmPanel !== null && !(confirmPanel.textContent ?? '').includes('issue.close:s1'))
document.body.dataset.confirmKeepsMarker = String(confirmPanel?.querySelector('[data-group-confirm-target]')?.getAttribute('data-group-confirm-target') === 'issue.close:s1')
  </script>
</body></html>`

    const directory = mkdtempSync(join(tmpdir(), 'teams-console-ux-f1f4-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const file = join(directory, 'f1f4.html')
    writeFileSync(file, page)
    const output = runChrome(file)
    for (const flag of [
      'provider-value-kept', 'provider-focused-kept', 'provider-sel-kept', 'provider-model-visible',
      'binding-primary', 'binding-backup', 'apply-uncertain', 'config-degraded', 'row-missing-wording',
      'relation-card', 'draft-remove-button',
      'pending-row-visible', 'advanced-collapsed', 'advanced-holds-report', 'report-marker-kept',
      'terminal-hides-row', 'confirm-max-height', 'confirm-hides-intent', 'confirm-keeps-marker',
    ]) {
      expect(output, flag).toContain(`data-${flag}="true"`)
    }
  })

  it('keeps a 390x844 mobile interaction view within the viewport with an in-list ack button and a single trailing timeline state', { timeout: 40_000 }, () => {
    const events = Array.from({ length: 24 }, (_, index) => ({
      kind: 'message', agentId: 'planner', sessionId: 's1', messageId: `m${index}`,
      role: 'user', state: 'completed', occurredAt: `2026-10-01T00:00:0${index % 10}.000Z`,
    }))
    const projection = {
      version: 1,
      agents: [{ kind: 'runtime', agentId: 'planner', label: 'Planner', machineId: 'M1', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current', currentSessionId: 's1' }],
      sessions: [{ sessionId: 's1', agentId: 'planner', title: 'Planner session', status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' }],
      sessionEvents: events,
      notifications: [{ agentId: 'planner', notificationId: 'n-pending', sessionId: 's1', kind: 'notice', state: 'pending', title: 'Build finished', priority: 'normal', occurredAt: '2026-10-01T00:00:00.000Z' }],
      configs: [], connections: [], relations: [],
    }
    const makeState = (eventsOverride: readonly unknown[]) => ({
      open: true, live: true, page: 'interaction', entry: 'topology', locale: 'en', status: 'ready',
      projection: { ...projection, sessionEvents: eventsOverride },
      observation: { projection: { ...projection, sessionEvents: eventsOverride }, observation: 'live', health: { state: 'live' } },
      drawer: null, drawerStack: [], drawerExpanded: false,
      selectedAgentId: 'planner', selectedSessionId: 's1', providerFormOpen: false,
      providerDraft: { id: '', label: '', protocol: 'openai-chat', apiBaseUrl: '', enabled: true, authKind: 'none', credentialRef: '' },
      membershipDraft: [], messageDraft: '', cancelState: 'idle', history: null, historyStatus: 'idle', historyError: null,
      refusedError: null, query: '', busy: null, error: null, notice: null, groupCapable: true, group: null,
    })
    const tallState = makeState(events)
    const shortState = makeState([])
    const drawerState = { ...tallState, drawer: { kind: 'session', agentId: 'planner', sessionId: 's1' }, drawerStack: [{ kind: 'session', agentId: 'planner', sessionId: 's1' }] }
    const page = `<!doctype html>
<html><head><meta name="viewport" content="width=390, initial-scale=1"><style>html,body{margin:0;padding:0}</style></head><body>
  <div id="main" class="teams-root"></div>
  <div id="short" class="teams-root"></div>
  <div id="drawn" class="teams-root"></div>
  <script>
${script}
document.querySelector('style').textContent += teamsStyles
window.addEventListener('error', e => { document.body.dataset.jsError = String(e.message) })
const S = ${JSON.stringify({ tall: tallState, short: shortState, drawn: drawerState })}
const root = document.getElementById('main')
renderConsole(root, { getSnapshot: () => S.tall })
renderConsole(document.getElementById('short'), { getSnapshot: () => S.short })
renderConsole(document.getElementById('drawn'), { getSnapshot: () => S.drawn })
const panel = root.querySelector('.teams-panel')
const shortPanel = document.querySelector('#short .teams-panel')
const drawerHeading = document.querySelector('#drawn .teams-drawer .teams-drawer-heading strong')
const ack = root.querySelector('[data-notification-ack="n-pending"]')
const eventTitle = root.querySelector('.teams-session-event .teams-session-event-header strong')
document.body.dataset.panelTop = String(panel ? Math.round(panel.getBoundingClientRect().top) : -1)
document.body.dataset.panelInView = String(panel !== null && panel.getBoundingClientRect().top >= 0 && panel.getBoundingClientRect().bottom <= window.innerHeight + 1)
document.body.dataset.ackInRow = String(ack !== null && ack.closest('li') !== null && ack.closest('li') === root.querySelector('[data-notification-id="n-pending"]'))
document.body.dataset.noHorizontalOverflow = String(document.documentElement.scrollWidth <= window.innerWidth + 1)
document.body.dataset.timelineSingleState = String(eventTitle !== null && eventTitle.textContent === 'user completed')
document.body.dataset.drawerHeadingW = String(drawerHeading ? Math.round(drawerHeading.getBoundingClientRect().width) : -1)
document.body.dataset.shortPanelTop = String(shortPanel ? Math.round(shortPanel.getBoundingClientRect().top) : -1)
  </script>
</body></html>`

    const directory = mkdtempSync(join(tmpdir(), 'teams-console-mobile-390-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const file = join(directory, 'mobile.html')
    writeFileSync(file, page)
    const output = runChrome(file, '390,844')
    expect(output, 'top gap with full content').toContain('data-panel-top="0"')
    for (const flag of ['panel-in-view', 'ack-in-row', 'no-horizontal-overflow', 'timeline-single-state']) {
      expect(output, flag).toContain(`data-${flag}="true"`)
    }
    // Recorded (not asserted green): mobile-ux-findings F3 draws an unused top gap for short
    // content and squeezes the drawer heading. Those are out of this task's David scope; the
    // measured values are preserved here and reported as gaps rather than silently fixed.
    const headingWidth = Number(/data-drawer-heading-w="(-?\d+)"/.exec(output)?.[1] ?? '-1')
    const shortTop = Number(/data-short-panel-top="(-?\d+)"/.exec(output)?.[1] ?? '-1')
    expect(headingWidth).toBeGreaterThan(0)
    expect(shortTop).toBeGreaterThanOrEqual(0)
  })
})
