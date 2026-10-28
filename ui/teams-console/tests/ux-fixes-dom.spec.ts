import { describe, expect, it, onTestFinished } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { TeamsConsoleController } from '../src/state/controller.ts'
import { withGroupRequests, type GroupRequestSender } from '../src/client/group-client.ts'
import type { GroupWireRequest } from '../../../packages/shared/src/group-wire.ts'

function chromeExecutable(): string {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ].filter((value): value is string => Boolean(value))
  const found = candidates.find(candidate => existsSync(candidate))
  if (found === undefined) {
    throw new Error('Real-DOM UX test requires Google Chrome or Chromium.')
  }
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
  classicModule('components/render.ts'),
].join('\n')

function runChrome(file: string): string {
  const profileDirectory = mkdtempSync(join(tmpdir(), 'teams-console-ux-profile-'))
  try {
    return execFileSync(chromeExecutable(), [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${profileDirectory}`,
      '--dump-dom',
      pathToFileURL(file).toString(),
    ], { encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'ignore'] })
  } finally {
    rmSync(profileDirectory, { recursive: true, force: true })
  }
}

describe('WebUI UX fixes: controller & real-DOM regression', () => {
  it('supports removeNetworkMember, disconnectAgent, and default vikunjaProjectId in TeamsConsoleController', async () => {
    const commands: unknown[] = []
    const groupFrames: GroupWireRequest[] = []
    const sender: GroupRequestSender = {
      requestGroup: async (_agentId, frame) => {
        groupFrames.push(frame)
        if (frame.kind === 'group.list') {
          return {
            kind: 'reply',
            reply: {
              kind: 'group.list',
              requestId: frame.requestId,
              groups: [{
                groupId: 'g1',
                name: 'Alpha',
                ownerAgentId: 'agent-a',
                createdAt: '2026-10-20T00:00:00.000Z',
                members: [{ agentId: 'agent-a', role: 'master', mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] }],
              }],
            },
          }
        }
        if (frame.kind === 'issue.create') {
          return {
            kind: 'reply',
            reply: {
              kind: 'issue.session',
              requestId: frame.requestId,
              session: {
                sessionId: 's-new',
                groupId: frame.groupId,
                vikunjaProjectId: frame.vikunjaProjectId,
                vikunjaIssueId: 'i-new',
                initiatorAgentId: 'agent-a',
                state: 'open',
                openedAt: '2026-10-20T00:00:00.000Z',
                lastOpSeq: 1,
              },
            },
          }
        }
        if (frame.kind === 'issue.list') {
          return { kind: 'reply', reply: { kind: 'issue.list', requestId: frame.requestId, sessions: [] } }
        }
        if (frame.kind === 'action.list') {
          return { kind: 'reply', reply: { kind: 'action.list', requestId: frame.requestId, actions: [] } }
        }
        return { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
      },
    }

    const baseClient = {
      readProjection: async () => ({
        version: 1 as const,
        agents: [
          { kind: 'runtime' as const, agentId: 'agent-a', label: 'Agent A', machineId: 'M1', presence: 'online' as const, capabilities: ['session'], sessionCapable: true as const, sessionAvailability: 'current' as const },
          { kind: 'runtime' as const, agentId: 'agent-b', label: 'Agent B', machineId: 'M1', presence: 'online' as const, capabilities: ['session'], sessionCapable: true as const, sessionAvailability: 'current' as const },
        ],
        sessions: [],
        notifications: [],
        configs: [],
      }),
      command: async (cmd: unknown) => {
        commands.push(cmd)
        return { ok: true as const, kind: 'connection.disconnect' as const }
      },
      sendSession: async () => ({ ok: true as const }),
    }

    const controller = new TeamsConsoleController(withGroupRequests(baseClient, sender) as never, { initialPage: 'groups' })
    await controller.refresh()
    controller.setGroupActor('agent-a')
    await controller.loadGroups()

    // UX-03: select and remove draft member
    controller.selectNetworkMember('agent-a', 'master')
    controller.selectNetworkMember('agent-b', 'peer')
    expect(controller.getSnapshot().membershipDraft).toEqual([
      { agentId: 'agent-a', role: 'master' },
      { agentId: 'agent-b', role: 'peer' },
    ])
    controller.removeNetworkMember('agent-b')
    expect(controller.getSnapshot().membershipDraft).toEqual([
      { agentId: 'agent-a', role: 'master' },
    ])

    // UX-03: disconnectAgent command
    expect(await controller.disconnectAgent('agent-a')).toBe(true)
    expect(commands).toContainEqual({ kind: 'connection.disconnect', agentId: 'agent-a' })

    // UX-04: createIssue with blank vikunjaProjectId defaults to group project/id
    expect(await controller.createIssue('Title without project ID', 'Body text', '')).toBe(true)
    const createFrame = groupFrames.find(frame => frame.kind === 'issue.create')
    expect(createFrame).toBeDefined()
    if (createFrame?.kind === 'issue.create') {
      expect(createFrame.vikunjaProjectId).toBe('g1')
    }
  })

  it('preserves focus, selection range, scrollTop, and uncontrolled inputs across re-renders and supports session switching & draft removal in Chrome DOM', { timeout: 30_000 }, () => {
    const projection = {
      version: 1,
      agents: [
        { kind: 'runtime', agentId: 'planner', label: 'Planner', engine: 'opencode', machineId: 'M1', presence: 'online', generation: 4, capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current', currentSessionId: 's1' },
        { kind: 'runtime', agentId: 'worker', label: 'Worker', engine: 'opencode', machineId: 'M1', presence: 'online', generation: 4, capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current', currentSessionId: 's2' },
      ],
      sessions: [
        { sessionId: 's1', agentId: 'planner', title: 'Planner session', status: 'active', updatedAt: '2026-10-01T00:00:00.000Z' },
        { sessionId: 's2', agentId: 'worker', title: 'Worker session', status: 'active', updatedAt: '2026-10-01T00:01:00.000Z' },
      ],
      sessionEvents: [],
      notifications: [
        { agentId: 'planner', notificationId: 'n-pending', sessionId: 's1', kind: 'notice', state: 'pending', title: 'Build finished', priority: 'normal', occurredAt: '2026-10-01T00:00:00.000Z' },
      ],
      configs: [],
      connections: [
        { localRole: 'master', status: { connectionId: 'c1', remoteAgentId: 'planner', state: 'ready', role: 'master' } },
      ],
      relations: [],
    }

    const baseGroupState = {
      access: { kind: 'ready' },
      actors: ['planner'],
      actorId: 'planner',
      groups: [{
        groupId: 'g1',
        name: 'Alpha',
        ownerAgentId: 'planner',
        createdAt: '2026-10-20T00:00:00.000Z',
        members: [{ agentId: 'planner', role: 'master', mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] }],
      }],
      selectedGroupId: 'g1',
      listStatus: 'ready',
      invitations: [],
      messages: [],
      messageRevision: 1,
      messagesHasMore: false,
      messageStatus: 'ready',
      composer: 'Hello world',
      issue: null,
      issueStatus: 'idle',
      issues: [],
      issueListStatus: 'empty',
      actions: [],
      actionStatus: 'empty',
      stopReport: null,
      mutation: null,
      outcome: { kind: 'idle' },
      confirm: null,
      retryable: null,
      retryables: {},
      error: null,
      readError: null,
      manageOpen: true,
    }

    const baseState = {
      open: true,
      live: true,
      page: 'groups',
      entry: 'topology',
      locale: 'en',
      status: 'ready',
      projection,
      observation: { projection, observation: 'live', health: { state: 'live' } },
      drawer: null,
      drawerStack: [],
      drawerExpanded: false,
      selectedAgentId: 'planner',
      selectedSessionId: 's1',
      providerFormOpen: false,
      providerDraft: { id: '', label: '', protocol: 'openai-chat', apiBaseUrl: '', enabled: true, authKind: 'none', credentialRef: '' },
      membershipDraft: [{ agentId: 'planner', role: 'master' }],
      messageDraft: '',
      cancelState: 'idle',
      history: null,
      historyStatus: 'idle',
      historyError: null,
      refusedError: null,
      query: '',
      busy: null,
      error: null,
      notice: null,
      groupCapable: true,
      group: baseGroupState,
    }

    const htmlPage = `<!doctype html>
<html><body>
  <div id="root" class="teams-root"></div>
  <script>
${script}
    let STATE = ${JSON.stringify(baseState)}
    const calls = { removed: [], disconnected: [], selectedSessions: [], acked: [], createdIssues: [] }
    let createIssueOk = false
    const controller = {
      getSnapshot: () => STATE,
      setGroupComposer(val) { STATE = { ...STATE, group: { ...STATE.group, composer: val } } },
      setMessageDraft(val) { STATE = { ...STATE, messageDraft: val } },
      removeNetworkMember(id) { calls.removed.push(id) },
      async disconnectAgent(id) { calls.disconnected.push(id); return true },
      selectAgent(id) { STATE = { ...STATE, selectedAgentId: id } },
      selectSessionSessionId(id) { calls.selectedSessions.push(id); STATE = { ...STATE, selectedSessionId: id } },
      async acknowledge(nid) { calls.acked.push(nid); return true },
      async createIssue(title, body, proj) {
        calls.createdIssues.push({ title, body, proj })
        return createIssueOk
      },
    }

    const root = document.getElementById('root')
    renderConsole(root, controller)

    // 1. UX-01: Focus & selection range in group:composer + uncontrolled input preservation
    const composer = root.querySelector('[data-focus-key="group:composer"]')
    composer.focus()
    composer.setSelectionRange(2, 5)
    const issueTitle = root.querySelector('[data-group-input="issue-title"]')
    const issueBody = root.querySelector('[data-group-input="issue-body"]')
    issueTitle.value = 'Draft issue title'
    issueBody.value = 'Draft issue body'

    // Trigger a background re-render (simulating 4s poll / SSE snapshot)
    renderConsole(root, controller)
    const composerAfter = root.querySelector('[data-focus-key="group:composer"]')
    const issueTitleAfter = root.querySelector('[data-group-input="issue-title"]')
    const issueBodyAfter = root.querySelector('[data-group-input="issue-body"]')
    document.body.dataset.composerFocused = String(document.activeElement === composerAfter)
    document.body.dataset.composerSelStart = String(composerAfter.selectionStart)
    document.body.dataset.composerSelEnd = String(composerAfter.selectionEnd)
    document.body.dataset.uncontrolledPreserved = String(
      issueTitleAfter.value === 'Draft issue title' && issueBodyAfter.value === 'Draft issue body'
    )

    // Submitting when controller returns false keeps the input text; submitting when true clears it
    ;(async () => {
      root.querySelector('[data-group-issue-action="create"]').click()
      await Promise.resolve()
      document.body.dataset.keptOnFailure = String(
        root.querySelector('[data-group-input="issue-title"]').value === 'Draft issue title'
      )
      createIssueOk = true
      root.querySelector('[data-group-issue-action="create"]').click()
      await Promise.resolve()
      document.body.dataset.clearedOnSuccess = String(
        root.querySelector('[data-group-input="issue-title"]').value === ''
      )

      // 2. UX-03: Discovery live state bands & disconnect button
      STATE = { ...STATE, page: 'discovery' }
      renderConsole(root, controller)
      const regBand = root.querySelector('[data-team-band="registration"] [data-band-state]')?.getAttribute('data-band-state')
      const connBand = root.querySelector('[data-team-band="connection"] [data-band-state]')?.getAttribute('data-band-state')
      document.body.dataset.liveBands = String(regBand === 'online' && connBand === 'ready')
      const disconnectBtn = root.querySelector('[data-agent-disconnect="planner"]')
      disconnectBtn?.click()
      await Promise.resolve()
      document.body.dataset.disconnectCalled = String(calls.disconnected.join(',') === 'planner')

      // 3. UX-03: Networking draft member remove button
      STATE = { ...STATE, page: 'networking' }
      renderConsole(root, controller)
      const removeBtn = root.querySelector('[data-team-draft-remove="planner"]')
      removeBtn?.click()
      document.body.dataset.draftRemoveCalled = String(calls.removed.join(',') === 'planner')

      // 4. UX-02: Interaction multi-session switching & pending notification acknowledge
      STATE = { ...STATE, page: 'interaction' }
      renderConsole(root, controller)
      const selectS2 = root.querySelector('[data-session-select="s2"]')
      selectS2?.click()
      renderConsole(root, controller)
      const s2Current = root.querySelector('[data-session-select="s2"]')?.getAttribute('aria-current')
      document.body.dataset.sessionSwitched = String(calls.selectedSessions.includes('s2') && s2Current === 'true')
      const ackBtn = root.querySelector('[data-notification-ack="n-pending"]')
      ackBtn?.click()
      await Promise.resolve()
      document.body.dataset.notificationAcked = String(calls.acked.includes('n-pending'))
    })()
  </script>
</body></html>`

    const directory = mkdtempSync(join(tmpdir(), 'teams-console-ux-fixes-'))
    onTestFinished(() => { rmSync(directory, { recursive: true, force: true }) })
    const file = join(directory, 'ux-fixes.html')
    writeFileSync(file, htmlPage)
    const output = runChrome(file)
    expect(output).toContain('data-composer-focused="true"')
    expect(output).toContain('data-composer-sel-start="2"')
    expect(output).toContain('data-composer-sel-end="5"')
    expect(output).toContain('data-uncontrolled-preserved="true"')
    expect(output).toContain('data-kept-on-failure="true"')
    expect(output).toContain('data-cleared-on-success="true"')
    expect(output).toContain('data-live-bands="true"')
    expect(output).toContain('data-disconnect-called="true"')
    expect(output).toContain('data-draft-remove-called="true"')
    expect(output).toContain('data-session-switched="true"')
    expect(output).toContain('data-notification-acked="true"')
  })
})
