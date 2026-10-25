import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

/**
 * The grant and assignee path driven in a real DOM by the shipped controller.
 *
 * The page builds the real TeamsConsoleController over a scripted group port, renders the
 * real console with the real renderer, then clicks the controls. Every assertion therefore
 * reads either the DOM the modules built or the frame the controller actually sent.
 */

const srcRoot = join(import.meta.dirname, '../src')

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
  if (executable === undefined) throw new Error('A Chrome/Chromium executable is required for the grant DOM test')
  return executable
}

const script = [
  classicModule('client/protocol.ts'),
  classicModule('client/locale.ts'),
  classicModule('state/model.ts'),
  classicModule('state/group-workspace.ts'),
  classicModule('state/drafts.ts'),
  classicModule('state/observation.ts'),
  classicModule('components/dom.ts'),
  classicModule('components/page-networking.ts'),
  classicModule('components/page-groups.ts'),
  classicModule('components/render.ts'),
  classicModule('state/controller.ts'),
].join('\n')

if (/(^|\n)\s*(import|export)\b/.test(script)) throw new Error('classic module bundling left module syntax behind')

const page = (actor: string) => `<!doctype html>
<html><body>
  <div id="root"></div>
  <script>
${script}
    const projection = {
      version: 1,
      agents: [
        { kind: 'runtime', agentId: 'agent-a', label: 'Agent A', machineId: 'M1', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current' },
        { kind: 'runtime', agentId: 'agent-b', label: 'Agent B', machineId: 'M1', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current' },
        { kind: 'runtime', agentId: 'agent-c', label: 'Agent C', machineId: 'M1', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current' },
      ],
      sessions: [], notifications: [], configs: [],
    }
    const group = {
      groupId: 'g1', name: 'Alpha', ownerAgentId: 'agent-a', createdAt: '2026-10-20T00:00:00.000Z',
      members: [
        { agentId: 'agent-a', role: 'master', mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] },
        { agentId: 'agent-b', role: 'peer', mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] },
        { agentId: 'agent-c', role: 'peer', mastersOf: [], intervals: [{ joinedAt: '2026-10-20T00:00:00.000Z' }] },
      ],
    }
    const sent = []
    const groupPort = {
      requestGroup: async (agentId, frame) => {
        sent.push({ agentId, frame })
        if (frame.kind === 'group.list') return { kind: 'reply', reply: { kind: 'group.list', requestId: frame.requestId, groups: [group] } }
        if (frame.kind === 'group.grant') {
          const widened = group.members.map(member => member.agentId === frame.agentId
            ? { ...member, mastersOf: [...frame.mastersOf] }
            : member)
          group.members = widened
          return { kind: 'reply', reply: { kind: 'group.member', requestId: frame.requestId, group: { ...group, members: widened } } }
        }
        if (frame.kind === 'message.page') return { kind: 'reply', reply: { kind: 'message.page', requestId: frame.requestId, messages: [], revision: 1, hasMore: false } }
        if (frame.kind === 'action.list') return { kind: 'reply', reply: { kind: 'action.list', requestId: frame.requestId, actions: [] } }
        return { kind: 'refused', code: 'UNSUPPORTED_OPERATION', message: 'unexpected frame ' + frame.kind }
      },
    }
    // The console renders the live page layout only for the live client contract, so the
    // page provides the projection subscription and history reads the real client would.
    const base = {
      readProjection: async () => projection,
      command: async () => ({ ok: true, kind: 'connection.connect' }),
      sendSession: async () => ({ ok: true }),
      readHistory: async () => ({ entries: [], nextCursor: undefined }),
      subscribeProjection: options => { options.onSnapshot({ projection, observation: 'live', health: { state: 'live' } }); return () => {} },
      requestGroup: groupPort.requestGroup,
    }
    const controller = new TeamsConsoleController(base, { initialPage: 'groups' })
    const root = document.getElementById('root')
    const mark = (name, value) => { document.body.dataset[name] = String(value) }
    const rerender = () => {
      try { root.textContent = ''; renderConsole(root, controller) } catch (error) { document.body.dataset.renderError = String(error && error.message || error) }
    }

    ;(async () => {
      await controller.refresh()
      controller.openConsole()
      controller.selectPage('groups')
      // Several agents are declared, so the operator chooses the acting identity first.
      controller.setGroupActor('${actor}')
      await controller.loadGroups()
      rerender()

      const buttons = [...root.querySelectorAll('[data-group-grant]')].map(node => node.dataset.groupGrant)
      mark('grantButtons', buttons.join(','))
      mark('grantButtonsVisible', buttons.length)

      const grantToB = root.querySelector('[data-group-grant="agent-b"]')
      if (grantToB !== null) { grantToB.click(); await Promise.resolve(); await Promise.resolve(); rerender() }

      const grant = sent.filter(entry => entry.frame.kind === 'group.grant').pop()
      mark('grantSent', grant === undefined ? 'none' : JSON.stringify(grant.frame))
      mark('grantAgentId', grant === undefined ? 'none' : grant.agentId)
      mark('grantButtonsAfter', [...root.querySelectorAll('[data-group-grant]')].map(node => node.dataset.groupGrant).join(','))
      const after = controller.getSnapshot().group
      mark('grantOutcomeKind', after.outcome.kind)
      mark('grantListStatus', after.listStatus)
      mark('grantOwnerEdge', after.groups.map(g => g.members.map(m => m.agentId + ':' + m.mastersOf.join('+')).join(';')).join('|'))
      mark('renderError', String(document.body.dataset.renderError ?? 'none'))

      const assignee = root.querySelector('[data-group-input="action-assignee"]')
      mark('assigneeTag', assignee === null ? 'none' : assignee.tagName)
      mark('assigneeOptions', assignee === null ? '' : [...assignee.options].map(option => option.value).join(','))
      mark('assigneeDisabled', assignee === null ? 'none' : String(assignee.disabled))

      const inviteAgent = root.querySelector('[data-group-input="invite-agent"]')
      mark('inviteAgentTag', inviteAgent === null ? 'none' : inviteAgent.tagName)
      mark('inviteAgentOptions', inviteAgent === null ? '' : [...inviteAgent.options].map(option => option.value).join(','))
      const inviteRole = root.querySelector('[data-group-input="invite-role"]')
      mark('inviteRoleTag', inviteRole === null ? 'none' : inviteRole.tagName)
      mark('inviteRoleOptions', inviteRole === null ? '' : [...inviteRole.options].map(option => option.value).join(','))
      mark('done', 'true')
    })()
  </script>
</body></html>`

function runChrome(file: string): string {
  const profileDirectory = mkdtempSync(join(tmpdir(), 'teams-console-grant-profile-'))
  try {
    return execFileSync(chromeExecutable(), [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${profileDirectory}`,
      '--dump-dom',
      pathToFileURL(file).toString(),
    ], { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] })
  } finally {
    rmSync(profileDirectory, { recursive: true, force: true })
  }
}

function measure(actor: string): Record<string, string> {
  const directory = mkdtempSync(join(tmpdir(), 'teams-console-grant-'))
  try {
    const file = join(directory, 'grant.html')
    writeFileSync(file, page(actor))
    const output = runChrome(file)

    const attributes = /<body([^>]*)>/.exec(output)?.[1] ?? ''
    const read = (name: string): string => (new RegExp(`${name}="([^"]*)"`).exec(attributes)?.[1] ?? '')
      .replaceAll('&quot;', '"')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
    return {
      done: read('data-done'),
      grantButtons: read('data-grant-buttons'),
      grantSent: read('data-grant-sent'),
      grantAgentId: read('data-grant-agent-id'),
      grantButtonsAfter: read('data-grant-buttons-after'),
      grantListStatus: read('data-grant-list-status'),
      grantOwnerEdge: read('data-grant-owner-edge'),
      renderError: read('data-render-error'),
      grantOutcomeKind: read('data-grant-outcome-kind'),
      assigneeTag: read('data-assignee-tag'),
      assigneeOptions: read('data-assignee-options'),
      assigneeDisabled: read('data-assignee-disabled'),
      inviteAgentTag: read('data-invite-agent-tag'),
      inviteAgentOptions: read('data-invite-agent-options'),
      inviteRoleTag: read('data-invite-role-tag'),
      inviteRoleOptions: read('data-invite-role-options'),
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('command edge grant through the real console', () => {
  it('lets the owner grant an edge and sends the widened group.grant frame', { timeout: 40_000 }, () => {
    const owner = measure('agent-a')
    expect(owner.done).toBe('true')
    // The owner sees one button per active member it does not command yet.
    expect(owner.grantButtons).toBe('agent-b,agent-c')
    const frame = JSON.parse(owner.grantSent) as { kind: string; groupId: string; agentId: string; role: string; mastersOf: string[] }
    expect(frame.kind).toBe('group.grant')
    expect(frame.groupId).toBe('g1')
    // The edge is stored on the acting owner, and the frame re-states the owner identity.
    expect(frame.agentId).toBe('agent-a')
    expect(frame.role).toBe('master')
    expect(frame.mastersOf).toEqual(['agent-b'])
    expect(owner.grantAgentId).toBe('agent-a')
    // The owner reply (group.member) updates the group, so the granted member's button goes away.
    expect(owner.grantButtonsAfter).toBe('agent-c')
    expect(owner.grantListStatus).toBe('ready')
    // The owner reply carries the updated membership, and the edge sits on the owner itself.
    expect(owner.grantOwnerEdge).toBe('agent-a:agent-b;agent-b:;agent-c:')
    expect(owner.grantOutcomeKind).toBe('succeeded')
    expect(owner.renderError).toBe('none')

    // The action target is now a closed choice over the granted members only.
    expect(owner.assigneeTag).toBe('SELECT')
    expect(owner.assigneeOptions).toBe('agent-b')
    // The granted member is a real choice now, so the control is usable.
    expect(owner.assigneeDisabled).toBe('false')

    // The invitation form offers declared agents that are not already members.
    expect(owner.inviteAgentTag).toBe('SELECT')
    expect(owner.inviteAgentOptions).toBe('')
    expect(owner.inviteRoleTag).toBe('SELECT')
    expect(owner.inviteRoleOptions).toBe('peer,master')
  })

  it('shows no grant control to an actor that is not the group owner', { timeout: 40_000 }, () => {
    // agent-a owns the group; the operator acts as agent-b, so no owner control may appear.
    const peer = measure('agent-b')
    expect(peer.done).toBe('true')
    expect(peer.grantButtons).toBe('')
    expect(peer.grantSent).toBe('none')
    // Without an edge the action form must not invite a target that is bound to be refused.
    expect(peer.assigneeTag).toBe('SELECT')
    expect(peer.assigneeOptions).toBe('')
    expect(peer.assigneeDisabled).toBe('true')
  })
})
