import { describe, expect, it, onTestFinished } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const clientRoot = join(import.meta.dirname, '../src/client')

/**
 * Render the real D07 four-page console in a real DOM. The client modules are transpiled to a
 * classic script so Chrome can execute them from a local page without a module loader, and the
 * state is a real `renderConsole` snapshot rather than a parsed string. No source text is
 * asserted, only the DOM the modules build: the frozen section 5 marker contract.
 */
function classicModule(file: string): string {
  const output = transpileModule(readFileSync(join(clientRoot, file), 'utf8'), {
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
  if (executable === undefined) throw new Error('A Chrome/Chromium executable is required for the D07 DOM contract render test')
  return executable
}

const script = [
  classicModule('locale.ts'),
  classicModule('model.ts'),
  classicModule('drafts.ts'),
  classicModule('protocol.ts'),
  classicModule('render.ts'),
].join('\n')

if (/(^|\n)\s*(import|export)\b/.test(script)) throw new Error('classic module bundling left module syntax behind')

/** One real owner projection carrying every field the four D07 pages read. */
const projection = {
  version: 1,
  agents: [
    { kind: 'runtime', agentId: 'planner', label: 'Planner', machineId: 'M1', generation: 3, presence: 'online',
      capabilities: ['session'], capabilityDetails: [{ capabilityId: 'session', version: '1', operations: ['create'],
        resources: [{ resourceId: 'session-slot', capacity: 2, unit: 'concurrent' }] }],
      engine: 'opencode', lastSeenAt: '2026-10-11T00:00:00.000Z', sessionCapable: true,
      sessionAvailability: 'current', currentSessionId: 's1', providerId: 'p', modelId: 'm1', sessionEffectiveRevision: 2 },
    { kind: 'directory', agentId: 'gone', label: 'Gone', machineId: 'M2', presence: 'offline',
      capabilities: ['session'], engine: 'dsh', lastSeenAt: '2026-10-01T00:00:00.000Z' },
  ],
  sessions: [{ agentId: 'planner', sessionId: 's1', title: 'Session one' }],
  notifications: [{ agentId: 'planner', notificationId: 'n1', sessionId: 's1', kind: 'permission', state: 'pending',
    title: 'Approve the tool call', permissionId: 'p1', priority: 'high', occurredAt: 'owner-time' }],
  configs: [{ agentId: 'planner', acceptedRevision: 2, providers: [] }],
  connections: [{ status: { version: 1, remoteAgentId: 'planner', state: 'ready', targetGeneration: 3,
    observedAt: '2026-10-11T00:00:00.000Z', connectionId: 'c1', role: 'master' }, halfOpen: false, localRole: 'peer' }],
  relations: [{ agentId: 'planner', consumerAgentId: 'consumer', providerAgentId: 'planner',
    capabilityId: 'session', capabilityVersion: '1', relationPermission: 'granted' }],
  sessionEvents: [
    { eventId: 'e1', agentId: 'planner', sessionId: 's1', kind: 'message', state: 'completed', messageId: 'm1', role: 'user' },
    { eventId: 'e2', agentId: 'planner', sessionId: 's1', kind: 'permission', state: 'pending', permissionId: 'p1',
      messageId: 'm1', title: 'Approve the tool call', metadata: {},
      options: [
        { optionId: 'once', name: 'Allow once', kind: 'once' },
        { optionId: 'always', name: 'Always allow', kind: 'always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject' },
      ] },
    { eventId: 'e3', agentId: 'planner', sessionId: 's1', kind: 'permission', state: 'pending', permissionId: 'p2',
      messageId: 'm1', title: 'No choices offered', metadata: {} },
    { eventId: 'e4', agentId: 'planner', sessionId: 's1', kind: 'final', state: 'completed', messageId: 'm1' },
  ],
}

const historyPage = {
  records: [
    { recordId: 'r1', sequence: 7, occurredAt: '2026-10-11T00:00:07.000Z', agentId: 'peer-a', kind: 'connection',
      event: 'connection.negotiated', connectionId: 'c1', outcome: 'completed' },
    { recordId: 'r2', sequence: 3, occurredAt: '2026-10-11T00:00:03.000Z', agentId: 'gone', kind: 'connection',
      event: 'channel.closed', outcome: 'failed' },
  ],
  nextBeforeSequence: 3,
}

function state(overrides = {}) {
  return {
    open: true,
    page: 'discovery',
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
    selectedAgentId: 'planner',
    selectedSessionId: 's1',
    providerFormOpen: false,
    editingProviderId: undefined,
    providerDraft: { id: '', label: '', protocol: 'openai-chat', apiBaseUrl: '', enabled: true, authKind: 'none', credentialRef: '' },
    refusedError: null,
    cancelState: 'idle',
    observation: { projection, observation: 'live', health: { state: 'live' } },
    messageDraft: 'drafted message',
    membershipDraft: [{ agentId: 'planner', role: 'master' }, { agentId: 'gone', role: 'peer' }],
    history: null,
    historyStatus: 'ready',
    historyError: null,
    lastFocusKey: undefined,
    ...overrides,
  }
}

const controllerScript = `
    const controller = {
      getSnapshot: () => STATE,
      setLocale() {}, openConsole() {}, closeConsole() {}, selectPage() {}, openAgent() {}, openSession() {},
      closeDrawer() {}, toggleDrawerExpanded() {}, selectNetworkMember() {}, removeNetworkMember() {},
      applyMembership() {}, connectAgent() {}, loadHistory() {}, retryHistory() {}, sendSession() {},
      cancelSession() {}, replyPermission() {}, acknowledge() {}, createSessionCommand() {}, openSessionCommand() {},
      refresh() {}, selectSession() {}, applyConfig() {}, bindModel() {}, saveProvider() {}, openProviderForm() {},
      closeProviderForm() {}, editProvider() {}, refreshModels() {}, setQuery() {},
    }
`

/** Render all four pages into one document. Chrome dumps the resulting DOM. */
const contractScript = `<!doctype html>
<html><body>
  <div id="root"></div>
  <div id="root-refused"></div>
  <div id="root-networking"></div>
  <div id="root-interaction"></div>
  <div id="root-history"></div>
  <div id="root-cancel-requested"></div>
  <div id="root-cancel-confirmed"></div>
  <div id="root-cancel-unknown"></div>
  <script>
${script}
${controllerScript}
    STATE = ${JSON.stringify(state({ page: 'discovery' }))}
    renderConsole(document.getElementById('root'), controller)
    STATE = ${JSON.stringify(state({ page: 'discovery', refusedError: { code: 'UNSUPPORTED_OPERATION', message: 'a network command channel is not declared' } }))}
    renderConsole(document.getElementById('root-refused'), controller)
    STATE = ${JSON.stringify(state({ page: 'networking' }))}
    renderConsole(document.getElementById('root-networking'), controller)
    STATE = ${JSON.stringify(state({ page: 'interaction' }))}
    renderConsole(document.getElementById('root-interaction'), controller)
    STATE = ${JSON.stringify(state({ page: 'history', history: historyPage, historyStatus: 'ready' }))}
    renderConsole(document.getElementById('root-history'), controller)
    STATE = ${JSON.stringify(state({ page: 'interaction', cancelState: 'requested' }))}
    renderConsole(document.getElementById('root-cancel-requested'), controller)
    STATE = ${JSON.stringify(state({ page: 'interaction', cancelState: 'confirmed' }))}
    renderConsole(document.getElementById('root-cancel-confirmed'), controller)
    STATE = ${JSON.stringify(state({ page: 'interaction', cancelState: 'unknown' }))}
    renderConsole(document.getElementById('root-cancel-unknown'), controller)
    const roots = ['root', 'root-refused', 'root-networking', 'root-interaction', 'root-history']
    const combined = roots.map(id => document.getElementById(id).outerHTML).join('\\n')
    const pages = [...combined.matchAll(/data-team-page="(discovery|networking|interaction|history)"/g)].map(match => match[1])
    document.body.dataset.fourPages = String(new Set(pages).size === 4)
    document.body.dataset.viewMarkers = String([...combined.matchAll(/data-team-page-view="/g)].length === 5)
    const pageViewValues = [...combined.matchAll(/data-team-page-view="([^"]*)"/g)].map(match => match[1])
    document.body.dataset.pageViewValues = String(pageViewValues.join(',') === 'discovery,discovery,networking,interaction,history')
    document.body.dataset.bands = String([...combined.matchAll(/data-team-band="/g)].length >= 4)
    document.body.dataset.bandTokens = String([...combined.matchAll(/data-band-state="/g)].length >= 4)
    document.body.dataset.observationMarker = String(combined.includes('data-team-observation="live"'))
    document.body.dataset.agentRow = String(combined.includes('data-agent-id="planner"') && combined.includes('data-presence="online"'))
    document.body.dataset.engineField = String(combined.includes('data-engine="opencode"'))
    document.body.dataset.lastSeen = String(combined.includes('data-last-seen="2026-10-01'))
    document.body.dataset.connectionRow = String(combined.includes('data-connection-id="c1"') && combined.includes('data-connection-state="ready"'))
    document.body.dataset.offlineRow = String(combined.includes('data-agent-id="gone"') && combined.includes('data-presence="offline"'))
    document.body.dataset.refused = String(combined.includes('data-team-refused="true"') && combined.includes('data-team-error-code="UNSUPPORTED_OPERATION"'))
    document.body.dataset.draftAccepted = String(combined.includes('data-team-draft="true"') && combined.includes('data-team-accepted="true"') && combined.includes('data-team-role-draft="master"') && combined.includes('data-team-role-accepted="granted"'))
    document.body.dataset.permissionChoices = String(combined.includes('data-permission-option="once"') && combined.includes('data-permission-option="always"') && combined.includes('data-permission-option="reject"'))
    document.body.dataset.permissionKind = String(combined.includes('data-permission-kind="always"'))
    document.body.dataset.cancelIdle = String(combined.includes('data-team-cancel="idle"'))
    // D07 item 4 asks for "cancel requested vs actual terminal state": the same interaction view
    // must carry every non-idle cancelState, so a regression to a constant idle cannot pass.
    const cancelRoots = ['root-interaction', 'root-cancel-requested', 'root-cancel-confirmed', 'root-cancel-unknown']
    const cancelCombined = cancelRoots.map(id => document.getElementById(id).outerHTML).join('\\n')
    document.body.dataset.cancelStates = String(['idle', 'requested', 'confirmed', 'unknown'].every(cancelState => cancelCombined.includes('data-team-cancel="' + cancelState + '"')))
    document.body.dataset.historyPagination = String(combined.includes('data-history-prev') && combined.includes('data-history-count="2"') && combined.includes('data-enabled="true"'))
    document.body.dataset.historyDetail = String(combined.includes('data-history-record="r1"') && combined.includes('data-history-record="r2"'))
    document.body.dataset.historyOrder = String(combined.indexOf('data-history-record="r1"') < combined.indexOf('data-history-record="r2"'))
  </script>
</body></html>`

/**
 * The notification negative contract: a pending permission notification whose engine
 * `sessionEvents` entry offers no options — or whose event is missing or already resolved —
 * must get no approval button. Only `acknowledge` is available, and an explicit hint explains
 * that the engine callback offered no choices.
 */
const notificationNegativeScript = `<!doctype html>
<html><body>
  <div id="root-no-options"></div>
  <div id="root-empty-options"></div>
  <div id="root-resolved"></div>
  <div id="root-event-absent"></div>
  <div id="root-no-permission-id"></div>
  <div id="root-offered"></div>
  <script>
${script}
${controllerScript}
    const projection = ${JSON.stringify(projection)}
    const baseNotification = ${JSON.stringify(state({ live: false, entry: 'notifications', projection }))}
    // Each case replaces the matching pending engine event with one specific defect, so the
    // notification itself never changes and only the engine option set varies.
    const withEvent = (mutate) => {
      const next = JSON.parse(JSON.stringify(projection))
      next.sessionEvents = next.sessionEvents.filter(event => event.eventId !== 'e2')
      const event = { eventId: 'e2', agentId: 'planner', sessionId: 's1', kind: 'permission',
        state: 'pending', permissionId: 'p1', messageId: 'm1', title: 'Approve the tool call', metadata: {} }
      mutate(event)
      next.sessionEvents.push(event)
      return next
    }
    const render = (id, nextProjection, notificationOverride) => {
      const withNotifications = notificationOverride === undefined
        ? nextProjection
        : { ...nextProjection, notifications: notificationOverride }
      STATE = { ...baseNotification, projection: withNotifications }
      renderConsole(document.getElementById(id), controller)
      return document.getElementById(id).outerHTML
    }
    // 1. The matching pending engine event exists but carried no option set at all.
    const noOptions = render('root-no-options', withEvent(() => {}))
    // 2. The matching pending engine event exists but offered an empty option set.
    const emptySet = render('root-empty-options', withEvent(event => { event.options = [] }))
    // 3. The matching engine event is genuinely resolved but the projection still carries the
    //    engine's old option list. Only the pending-state check keeps that stale set from being
    //    offered again, so this case fails if the check is dropped.
    const resolved = render('root-resolved', withEvent(event => {
      event.state = 'resolved'
      event.decision = 'once'
      event.options = [
        { optionId: 'once', name: 'Allow once', kind: 'once' },
        { optionId: 'always', name: 'Always allow', kind: 'always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject' },
      ]
    }))
    // 4. No matching engine event exists at all.
    const absent = render('root-event-absent', (() => {
      const next = JSON.parse(JSON.stringify(projection))
      next.sessionEvents = next.sessionEvents.filter(event => event.eventId !== 'e2')
      return next
    })())
    // 5. The frozen notification DTO omitted permissionId, so no engine event can be matched.
    const noPermissionId = render('root-no-permission-id', projection, [{
      agentId: 'planner', notificationId: 'n1', sessionId: 's1', kind: 'permission', state: 'pending',
      title: 'Approve the tool call', priority: 'high', occurredAt: '2026-10-01T00:00:00.000Z',
    }])
    // 6. The control: the untouched option-bearing event still offers exactly its own choices.
    const offered = render('root-offered', projection)
    const approvalButtons = html => [...html.matchAll(/data-permission-option="/g)].length
    const hasHint = html => html.includes('data-permission-options-unavailable="true"')
    document.body.dataset.noOptionsNoApproval = String(approvalButtons(noOptions) === 0)
    document.body.dataset.noOptionsHint = String(hasHint(noOptions))
    document.body.dataset.emptyOptionsNoApproval = String(approvalButtons(emptySet) === 0)
    document.body.dataset.emptyOptionsHint = String(hasHint(emptySet))
    document.body.dataset.resolvedEventNoApproval = String(approvalButtons(resolved) === 0)
    document.body.dataset.resolvedEventHint = String(hasHint(resolved))
    document.body.dataset.eventAbsentNoApproval = String(approvalButtons(absent) === 0)
    document.body.dataset.eventAbsentHint = String(hasHint(absent))
    document.body.dataset.noPermissionIdNoApproval = String(approvalButtons(noPermissionId) === 0)
    document.body.dataset.noPermissionIdHint = String(hasHint(noPermissionId))
    document.body.dataset.controlOffersButtons = String(approvalButtons(offered) === 3)
    document.body.dataset.controlOffersExactKinds = String(
      offered.includes('data-permission-kind="once"') && offered.includes('data-permission-kind="always"')
      && offered.includes('data-permission-kind="reject"'))
    document.body.dataset.notificationStillAcknowledgable = String(
      (noOptions.match(/Acknowledge|确认/g) ?? []).length > 0)
  </script>
</body></html>`

/** The negative contract: no fabricated permission choices, a stale owner band, and an
 *  honestly refused history surface. */
const negativeScript = `<!doctype html>
<html><body>
  <div id="root"></div>
  <div id="root-stale"></div>
  <div id="root-refused-history"></div>
  <script>
${script}
${controllerScript}
    STATE = ${JSON.stringify(state({ page: 'interaction' }))}
    renderConsole(document.getElementById('root'), controller)
    const interaction = document.getElementById('root').outerHTML
    const offeredOptions = [...interaction.matchAll(/data-permission-option="/g)].length
    STATE = ${JSON.stringify(state({ page: 'discovery', observation: { projection: null, observation: 'stale', health: { state: 'lost', reason: 'retry-exhausted', detail: 'the owner stream ended' } } }))}
    renderConsole(document.getElementById('root-stale'), controller)
    const stale = document.getElementById('root-stale').outerHTML
    STATE = ${JSON.stringify(state({ page: 'history', history: null, historyStatus: 'refused', historyError: { code: 'INVALID_ACP_FRAME', message: 'the owner refused a request history kind' } }))}
    renderConsole(document.getElementById('root-refused-history'), controller)
    document.body.dataset.exactOfferedOptions = String(offeredOptions === 3)
    document.body.dataset.staleMarker = String(stale.includes('data-team-observation="stale"'))
    document.body.dataset.staleBand = String(stale.includes('data-band-state="lost"') || stale.includes('data-band-state="unknown"'))
    // The whole-document dump echoes this page's own <script>, so a substring probe cannot tell the
    // rendered marker from the script source. Read the parsed element's attributes instead.
    const refusedElement = document.getElementById('root-refused-history').querySelector('[data-history-refused]')
    document.body.dataset.historyRefusedMarker = String(refusedElement !== null && refusedElement.getAttribute('data-history-refused') === 'true')
    document.body.dataset.historyErrorCode = String(refusedElement !== null && refusedElement.getAttribute('data-team-error-code') === 'INVALID_ACP_FRAME')
  </script>
</body></html>`

function runChrome(page: string): string {
  // Every launch gets its own throw-away profile. Concurrent headless Chrome
  // instances otherwise contend on the shared default profile's SingletonLock
  // and abort, which makes the parallel suite flaky rather than failing.
  const profileDirectory = mkdtempSync(join(tmpdir(), 'teams-console-d07-profile-'))
  try {
    return execFileSync(chromeExecutable(), [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${profileDirectory}`,
      '--dump-dom',
      pathToFileURL(page).toString(),
    ], { encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'ignore'] })
  } finally {
    rmSync(profileDirectory, { recursive: true, force: true })
  }
}

describe('D07 four-page DOM contract in a real DOM', () => {
  it('renders the four pages, owner bands, permissions and history without inventing state', { timeout: 30_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'teams-console-d07-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const page = join(directory, 'contract.html')
    writeFileSync(page, contractScript)
    const output = runChrome(page)
    expect(output).toContain('data-four-pages="true"')
    expect(output).toContain('data-view-markers="true"')
    // The marker count alone is value-blind; this also binds each page's data-team-page-view value.
    expect(output).toContain('data-page-view-values="true"')
    expect(output).toContain('data-bands="true"')
    expect(output).toContain('data-band-tokens="true"')
    expect(output).toContain('data-observation-marker="true"')
    expect(output).toContain('data-agent-row="true"')
    expect(output).toContain('data-engine-field="true"')
    expect(output).toContain('data-last-seen="true"')
    expect(output).toContain('data-connection-row="true"')
    expect(output).toContain('data-offline-row="true"')
    expect(output).toContain('data-refused="true"')
    expect(output).toContain('data-draft-accepted="true"')
    expect(output).toContain('data-permission-choices="true"')
    expect(output).toContain('data-permission-kind="true"')
    expect(output).toContain('data-cancel-idle="true"')
    expect(output).toContain('data-cancel-states="true"')
    expect(output).toContain('data-history-pagination="true"')
    expect(output).toContain('data-history-detail="true"')
    expect(output).toContain('data-history-order="true"')
  })

  it('offers no fabricated permission choice and degrades the observation band when the owner is lost', { timeout: 30_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'teams-console-d07-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const page = join(directory, 'negative.html')
    writeFileSync(page, negativeScript)
    const output = runChrome(page)
    expect(output).toContain('data-exact-offered-options="true"')
    expect(output).toContain('data-stale-marker="true"')
    expect(output).toContain('data-stale-band="true"')
    // Assert the parsed element's attributes, not a substring of the whole dumped document:
    // --dump-dom echoes the page's inline <script>, which also contains this marker text.
    expect(output).toContain('data-history-refused-marker="true"')
    expect(output).toContain('data-history-error-code="true"')
  })

  it('offers no approval button to a permission notification whose engine event offered no choices', { timeout: 30_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), 'teams-console-d07-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const page = join(directory, 'notification-negative.html')
    writeFileSync(page, notificationNegativeScript)
    const output = runChrome(page)
    expect(output).toContain('data-no-options-no-approval="true"')
    expect(output).toContain('data-no-options-hint="true"')
    expect(output).toContain('data-empty-options-no-approval="true"')
    expect(output).toContain('data-empty-options-hint="true"')
    expect(output).toContain('data-resolved-event-no-approval="true"')
    expect(output).toContain('data-resolved-event-hint="true"')
    expect(output).toContain('data-event-absent-no-approval="true"')
    expect(output).toContain('data-event-absent-hint="true"')
    expect(output).toContain('data-no-permission-id-no-approval="true"')
    expect(output).toContain('data-no-permission-id-hint="true"')
    expect(output).toContain('data-control-offers-buttons="true"')
    expect(output).toContain('data-control-offers-exact-kinds="true"')
    expect(output).toContain('data-notification-still-acknowledgable="true"')
  })
})
