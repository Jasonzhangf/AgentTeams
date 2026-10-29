import { describe, expect, it, onTestFinished } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { TeamsConsoleController } from '../src/state/controller.ts'
import { createFixtureClient } from '../src/fixture.ts'

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
  const profileDirectory = mkdtempSync(join(tmpdir(), 'teams-console-mf-profile-'))
  try {
    return execFileSync(chromeExecutable(), [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      ...(windowSize === undefined ? [] : [`--window-size=${windowSize}`]),
      `--user-data-dir=${profileDirectory}`,
      '--dump-dom',
      pathToFileURL(file).toString(),
    ], { encoding: 'utf8', timeout: 40_000, stdio: ['ignore', 'pipe', 'ignore'] })
  } finally {
    rmSync(profileDirectory, { recursive: true, force: true })
  }
}

const planner = {
  kind: 'runtime', agentId: 'planner', label: 'Planner', machineId: 'M1', presence: 'online',
  capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current', currentSessionId: 's1',
}

const eventTimeline = [
  { eventId: 'e1', agentId: 'planner', sessionId: 's1', kind: 'message', state: 'completed', messageId: 'm1', role: 'user', occurredAt: '2026-10-01T00:00:00.000Z' },
  { eventId: 'e2', agentId: 'planner', sessionId: 's1', kind: 'part', state: 'completed', messageId: 'm2', partId: 'p1', partType: 'text', text: 'hello', occurredAt: '2026-10-01T00:00:01.000Z' },
  { eventId: 'e3', agentId: 'planner', sessionId: 's1', kind: 'tool', state: 'completed', messageId: 'm2', partId: 'p2', callId: 'c1', tool: 'read', input: { path: 'a' }, output: 'a', title: 'Read a', metadata: {}, occurredAt: '2026-10-01T00:00:02.000Z' },
  { eventId: 'e4', agentId: 'planner', sessionId: 's1', kind: 'permission', state: 'pending', permissionId: 'perm-1', messageId: 'm2', title: 'Apply runtime boundary', metadata: {}, occurredAt: '2026-10-01T00:00:03.000Z' },
  { eventId: 'e5', agentId: 'planner', sessionId: 's1', kind: 'permission', state: 'resolved', permissionId: 'perm-2', decision: 'once', occurredAt: '2026-10-01T00:00:04.000Z' },
  { eventId: 'e6', agentId: 'planner', sessionId: 's1', kind: 'final', state: 'completed', messageId: 'm2', finish: 'end_turn', occurredAt: '2026-10-01T00:00:05.000Z' },
  { eventId: 'e7', agentId: 'planner', sessionId: 's1', kind: 'error', state: 'failed', error: { name: 'APIError', data: { message: 'boom' } }, correlation: { kind: 'session', sessionId: 's1' }, occurredAt: '2026-10-01T00:00:06.000Z' },
  { eventId: 'e8', agentId: 'planner', sessionId: 's1', kind: 'cancel', state: 'unknown', reason: 'abort-rejected', occurredAt: '2026-10-01T00:00:07.000Z' },
]

// The page renders the zh timeline, so the permission decision prefix is the zh copy while
// the engine-provided title and decision stay verbatim.
const timelineTitles = [
  'user', 'text', 'read', 'Apply runtime boundary', '权限 once', 'end_turn', 'APIError', 'abort-rejected',
]

function interactionProjection(): Record<string, unknown> {
  return {
    version: 1,
    agents: [planner],
    sessions: [{ sessionId: 's1', agentId: 'planner', title: 'Planner session', status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' }],
    sessionEvents: eventTimeline,
    notifications: [{ agentId: 'planner', notificationId: 'n-pending', sessionId: 's1', kind: 'notice', state: 'pending', title: 'Build finished', priority: 'normal', occurredAt: '2026-10-01T00:00:00.000Z' }],
    configs: [], connections: [], relations: [],
  }
}

function discoveryProjection(): Record<string, unknown> {
  return {
    version: 1,
    agents: [planner, { ...planner, agentId: 'worker-agent-with-a-long-identifier', label: 'Worker Agent With A Long Label' }],
    sessions: [], sessionEvents: [], notifications: [], configs: [], relations: [],
    connections: [{ localRole: 'master', status: { connectionId: 'c1', remoteAgentId: 'planner', state: 'ready', role: 'master' } }],
  }
}

function baseState(overrides: Record<string, unknown>): Record<string, unknown> {
  const projection = (overrides.projection ?? interactionProjection()) as Record<string, unknown>
  return {
    open: true, live: true, page: 'interaction', entry: 'topology', locale: 'en', status: 'ready',
    projection, observation: { projection, observation: 'live', health: { state: 'live' } },
    drawer: null, drawerStack: [], drawerExpanded: false,
    selectedAgentId: 'planner', selectedSessionId: 's1', providerFormOpen: false,
    providerDraft: { id: '', label: '', protocol: 'openai-chat', apiBaseUrl: '', enabled: true, authKind: 'none', credentialRef: '' },
    membershipDraft: [], messageDraft: '', cancelState: 'idle', history: null, historyStatus: 'idle', historyError: null,
    refusedError: null, query: '', busy: null, error: null, notice: null, groupCapable: true, group: null,
    ...overrides,
  }
}

describe('WebUI mobile UX M-F1/M-F2/M-F3 real-DOM regression', () => {
  it('localizes the status receipt without JSON in zh and en, and titles every timeline event once', { timeout: 40_000 }, async () => {
    const controller = new TeamsConsoleController(createFixtureClient())
    await controller.refresh()
    await expect(controller.sendSession('planner', 'planner-current', { text: 'hello' })).resolves.toBe(true)
    const notice = controller.getSnapshot().notice ?? ''
    expect(notice).toBe('Send message: accepted by Agent')
    expect(notice).not.toContain('{')
    expect(notice).not.toContain('acceptedRevision')

    const zh = baseState({ locale: 'zh', notice })
    const en = baseState({ locale: 'en', notice })
    const page = `<!doctype html>
<html><head><style>html,body{margin:0;padding:0}</style></head><body>
  <div id="zh" class="teams-root"></div>
  <div id="en" class="teams-root"></div>
  <script>
${script}
document.querySelector('style').textContent += teamsStyles
window.addEventListener('error', e => { document.body.dataset.jsError = String(e.message) })
const S = ${JSON.stringify({ zh, en, timelineTitles })}
const zhRoot = document.getElementById('zh')
const enRoot = document.getElementById('en')
renderConsole(zhRoot, { getSnapshot: () => S.zh, selectAgent() {}, selectSessionSessionId() {} })
renderConsole(enRoot, { getSnapshot: () => S.en, selectAgent() {}, selectSessionSessionId() {} })
const zhLive = zhRoot.querySelector('.teams-live-region')
const enLive = enRoot.querySelector('.teams-live-region')
document.body.dataset.zhNoticeLocalized = String(zhLive !== null && zhLive.textContent === '发送消息：已由 Agent 受理')
document.body.dataset.enNoticeKept = String(enLive !== null && enLive.textContent === 'Send message: accepted by Agent')
document.body.dataset.zhNoJson = String(zhLive !== null && !(zhLive.textContent ?? '').includes('{') && !(zhLive.textContent ?? '').includes('acceptedRevision'))
document.body.dataset.enNoJson = String(enLive !== null && !(enLive.textContent ?? '').includes('{') && !(enLive.textContent ?? '').includes('acceptedRevision'))
const items = [...zhRoot.querySelectorAll('.teams-session-event')]
const titles = items.map(li => li.querySelector('.teams-session-event-header strong')?.textContent ?? '')
const stateCounts = items.map(li => {
  const header = li.querySelector('.teams-session-event-header')
  const state = header?.querySelector('.teams-status-pill')?.textContent ?? ''
  const text = header?.textContent ?? ''
  return state === '' ? 0 : text.split(state).length - 1
})
document.body.dataset.timelineTitles = JSON.stringify(titles)
document.body.dataset.timelineStateCounts = JSON.stringify(stateCounts)
document.body.dataset.timelineTitlesMatch = String(JSON.stringify(titles) === JSON.stringify(S.timelineTitles))
document.body.dataset.timelineSingleStateEach = String(stateCounts.length === S.timelineTitles.length && stateCounts.every(count => count === 1))
  </script>
</body></html>`

    const directory = mkdtempSync(join(tmpdir(), 'teams-console-mf12-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const file = join(directory, 'mf12.html')
    writeFileSync(file, page)
    const output = runChrome(file)
    for (const flag of ['zh-notice-localized', 'en-notice-kept', 'zh-no-json', 'en-no-json', 'timeline-titles-match', 'timeline-single-state-each']) {
      expect(output, flag).toContain(`data-${flag}="true"`)
    }
    expect(output).not.toContain('data-js-error')
  })

  it('fills the 390x844 viewport, keeps the drawer title readable, and keeps the acknowledgement inside its row', { timeout: 40_000 }, () => {
    const interaction = baseState({})
    const discovery = baseState({ page: 'discovery', projection: discoveryProjection(), selectedSessionId: undefined })
    const drawer = baseState({ page: 'discovery', projection: discoveryProjection(), drawer: { kind: 'agent', agentId: 'planner' }, drawerStack: [{ kind: 'agent', agentId: 'planner' }] })
    const page = `<!doctype html>
<html><head><meta name="viewport" content="width=390, initial-scale=1"><style>html,body{margin:0;padding:0}</style></head><body>
  <div id="interaction" class="teams-root"></div>
  <div id="discovery" class="teams-root"></div>
  <div id="drawn" class="teams-root"></div>
  <script>
${script}
document.querySelector('style').textContent += teamsStyles
window.addEventListener('error', e => { document.body.dataset.jsError = String(e.message) })
const S = ${JSON.stringify({ interaction, discovery, drawer })}
const root = document.getElementById('interaction')
renderConsole(root, { getSnapshot: () => S.interaction, selectAgent() {}, selectSessionSessionId() {}, async acknowledge() { return true } })
renderConsole(document.getElementById('discovery'), { getSnapshot: () => S.discovery, connectAgent: async () => true, openAgent() {}, openSettings() {} })
renderConsole(document.getElementById('drawn'), { getSnapshot: () => S.drawer, closeDrawer() {}, toggleDrawerExpanded() {}, connectAgent: async () => true, openAgent() {}, openSettings() {} })
const panel = root.querySelector('.teams-panel')
const panelRect = panel?.getBoundingClientRect()
document.body.dataset.panelTopZero = String(panelRect !== undefined && Math.round(panelRect.top) === 0)
document.body.dataset.panelFillsViewport = String(panelRect !== undefined && Math.abs(panelRect.bottom - window.innerHeight) <= 1 && Math.abs(panelRect.width - window.innerWidth) <= 1)
const ack = root.querySelector('[data-notification-ack="n-pending"]')
document.body.dataset.ackInRow = String(ack !== null && ack.closest('li') === root.querySelector('[data-notification-id="n-pending"]') && ack.closest('li')?.classList.contains('teams-list-item') === true)
document.body.dataset.noHorizontalOverflow = String(document.documentElement.scrollWidth <= window.innerWidth + 1 && root.scrollWidth <= window.innerWidth + 1)
const drawerHeadingEl = document.querySelector('#drawn .teams-drawer .teams-drawer-heading strong')
document.body.dataset.drawerHeadingWidth = String(drawerHeadingEl ? Math.round(drawerHeadingEl.getBoundingClientRect().width) : -1)
const drawerBox = document.querySelector('#drawn .teams-drawer')
const drawerRect = drawerBox?.getBoundingClientRect()
const tabs = document.querySelector('#drawn .teams-tabs')
const tabsBottom = tabs === null ? 2e9 : tabs.getBoundingClientRect().bottom
document.body.dataset.drawerInsideViewport = String(drawerRect !== undefined && drawerRect.top >= 0 && drawerRect.bottom <= window.innerHeight + 1)
document.body.dataset.drawerNotOverTabs = String(drawerRect !== undefined && drawerRect.top >= tabsBottom)
const layer = document.querySelector('#drawn .teams-drawer-layer')
const layerStyle = layer === null ? null : getComputedStyle(layer)
document.body.dataset.drawerMask = String(layerStyle !== null && layerStyle.backgroundColor !== 'rgba(0, 0, 0, 0)' && Number(layerStyle.zIndex) >= 20)
const teamList = document.querySelector('#discovery .teams-team-list')
const teamStyle = teamList === null ? null : getComputedStyle(teamList)
document.body.dataset.teamListReset = String(teamStyle !== null && teamStyle.listStyleType === 'none' && teamStyle.paddingLeft === '0px' && teamStyle.marginLeft === '0px')
const firstCard = document.querySelector('#discovery .teams-team-list > li')
const cardStyle = firstCard === null ? null : getComputedStyle(firstCard)
document.body.dataset.teamCardBordered = String(cardStyle !== null && cardStyle.borderTopWidth !== '0px' && cardStyle.borderTopLeftRadius !== '0px')
document.body.dataset.discoveryNoOverflow = String(document.getElementById('discovery').scrollWidth <= window.innerWidth + 1)
  </script>
</body></html>`

    const directory = mkdtempSync(join(tmpdir(), 'teams-console-mf3-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const file = join(directory, 'mf3.html')
    writeFileSync(file, page)
    const output = runChrome(file, '390,844')
    for (const flag of ['panel-top-zero', 'panel-fills-viewport', 'ack-in-row', 'no-horizontal-overflow', 'drawer-inside-viewport', 'drawer-not-over-tabs', 'drawer-mask', 'team-list-reset', 'team-card-bordered', 'discovery-no-overflow']) {
      expect(output, flag).toContain(`data-${flag}="true"`)
    }
    expect(output).not.toContain('data-js-error')
    const width = Number(/data-drawer-heading-width="(-?\d+)"/.exec(output)?.[1] ?? '-1')
    expect(width).toBeGreaterThanOrEqual(160)
  })
})
