import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sourceRoot = join(import.meta.dirname, '../src')
const sourceFiles = [
  'client/api.ts', 'client/controller.ts', 'client/focus.ts', 'client/index.ts', 'client/model.ts', 'client/protocol.ts', 'client/render.ts', 'client/styles.ts', 'fixture.ts', 'index.ts',
]

describe('independent UI boundary', () => {
  it('has no DSH, Cordis, deepseek-harness, or parent runtime imports', () => {
    const source = sourceFiles.map(file => readFileSync(join(sourceRoot, file), 'utf8')).join('\n')
    expect(source).not.toMatch(/@deepseek-ai\/dsh|@deepseek-ai\/cordis|deepseek-harness|from ['"]\.\.\/\.\.\/\.\.(agent|config|network|server|runtime)/)
  })

  it('uses the injected client and keeps Session payload separate from control target', () => {
    const index = readFileSync(join(sourceRoot, 'client/index.ts'), 'utf8')
    const api = readFileSync(join(sourceRoot, 'client/api.ts'), 'utf8')
    const render = readFileSync(join(sourceRoot, 'client/render.ts'), 'utf8')
    expect(index).toContain('client: ConsoleClientV1')
    expect(api).toContain('/api/v1/projection')
    expect(api).toContain('/api/v1/command')
    expect(api).toContain('/api/v1/session-message')
    expect(render).toContain('const payload: JsonValue = { text: textarea.value }')
    expect(render).not.toContain('session.history')
    expect(render).not.toContain('session.metadata')
  })

  it('keeps credential values and local persistence out of the UI source', () => {
    const source = sourceFiles.map(file => readFileSync(join(sourceRoot, file), 'utf8')).join('\n').toLowerCase()
    expect(source).not.toContain('localstorage')
    expect(source).not.toContain('password')
    expect(source).not.toContain('api_key')
    expect(source).toContain('credentialref')
  })

  it('renders only explicitly projected Agent actions and omits implementation copy', () => {
    const render = readFileSync(join(sourceRoot, 'client/render.ts'), 'utf8')
    expect(render).toContain("projection.configs.some(config => config.agentId === agent.agentId)")
    expect(render).toContain('if (current !== undefined && sessionExists)')
    expect(render).not.toContain('Host-owned Agent presence and current-session bindings.')
    expect(render).not.toContain('Projection in, control actions out.')
  })

  it('renders owner-projected Session activity without creating a UI transcript ledger', () => {
    const protocol = readFileSync(join(sourceRoot, 'client/protocol.ts'), 'utf8')
    const canonicalProtocol = readFileSync(join(sourceRoot, '../../../control-protocol/console-api.ts'), 'utf8')
    const controller = readFileSync(join(sourceRoot, 'client/controller.ts'), 'utf8')
    const render = readFileSync(join(sourceRoot, 'client/render.ts'), 'utf8')
    expect(canonicalProtocol).toContain('readonly sessionEvents?')
    expect(protocol).not.toContain('interface ConsoleProjectionV1')
    expect(render).toContain('projectSessionFlow(state.projection, agentId, sessionId)')
    expect(controller).not.toMatch(/sessionEvents\s*:/)
    expect(controller).not.toMatch(/transcript|session\.history/)
  })

  it('uses one semantic drawer tree with layout-only desktop and mobile variants', () => {
    const controller = readFileSync(join(sourceRoot, 'client/controller.ts'), 'utf8')
    const index = readFileSync(join(sourceRoot, 'client/index.ts'), 'utf8')
    const render = readFileSync(join(sourceRoot, 'client/render.ts'), 'utf8')
    const styles = readFileSync(join(sourceRoot, 'client/styles.ts'), 'utf8')
    expect(controller).toContain('readonly drawerStack: readonly DrawerState[]')
    expect(index).toContain('restoreFocus(drawerFocusKey)')
    expect(index).toContain("event.key === 'Tab'")
    expect(index).toContain("querySelector<HTMLElement>('.teams-drawer-header')?.focus()")
    expect(index).toContain('containDrawerTab(root, event)')
    expect(render.match(/function renderDrawer/g)).toHaveLength(1)
    expect(render).toContain('panel.inert = true')
    expect(render).toContain("panel.setAttribute('aria-hidden', 'true')")
    expect(styles).toContain('@media (max-width: 780px)')
    expect(styles).toContain('.teams-drawer.is-expanded')
  })

  it('fails an interactive notification with no existing Session target visibly', () => {
    const render = readFileSync(join(sourceRoot, 'client/render.ts'), 'utf8')
    expect(render).toContain('sessionTargetExists')
    expect(render).toContain('t.invalidNotificationTarget')
  })
})
