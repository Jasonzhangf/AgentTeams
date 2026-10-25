import { describe, expect, it, onTestFinished } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

const srcRoot = join(import.meta.dirname, '../src')

/**
 * Render the real `render.ts`/`model.ts`/`locale.ts` modules in a browser. The modules are
 * transpiled to a classic script so Chrome can execute them from a local page without a
 * module loader; no source text is asserted, only the DOM the modules build.
 */
function classicModule(file: string): string {
  const output = transpileModule(readFileSync(join(srcRoot, file), 'utf8'), {
    compilerOptions: { module: ModuleKind.ESNext, target: ScriptTarget.ES2022 },
  }).outputText
  return output
    .split('\n')
    .filter(line => !/^\s*import\b/.test(line))
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
  if (executable === undefined) throw new Error('A Chrome/Chromium executable is required for the real DOM capability render test')
  return executable
}

/**
 * Dump the DOM of one local page with a dedicated throw-away Chrome profile.
 * Concurrent headless instances otherwise contend on the default profile's
 * SingletonLock and abort, so the parallel regression needs one profile per
 * launch. The profile is removed again in the same call.
 */
function runChrome(page: string, timeoutMs: number): string {
  const profileDirectory = mkdtempSync(join(tmpdir(), 'teams-console-render-profile-'))
  try {
    return execFileSync(chromeExecutable(), [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${profileDirectory}`,
      '--dump-dom',
      pathToFileURL(page).toString(),
    ], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] })
  } finally {
    rmSync(profileDirectory, { recursive: true, force: true })
  }
}

const pageScript = (script: string): string => `<!doctype html>
<html><body>
  <div id="card-root"></div>
  <div id="drawer-root"></div>
  <div id="absent-root"></div>
  <script>
${script}
    const provider = { kind: 'runtime', agentId: 'provider', label: 'Provider', machineId: 'M1', presence: 'online',
      capabilities: ['file-search'],
      capabilityDetails: [{ capabilityId: 'file-search', version: '3', operations: ['search', 'index'],
        resources: [{ resourceId: 'search-slot', capacity: 4, unit: 'context' }] }],
      sessionCapable: false, sessionAvailability: 'not-applicable' }
    const plain = { kind: 'runtime', agentId: 'plain', label: 'Plain', machineId: 'M2', presence: 'online',
      capabilities: ['legacy'], sessionCapable: false, sessionAvailability: 'not-applicable' }
    const projection = { version: 1, agents: [provider, plain], sessions: [], notifications: [], configs: [] }
    const state = { open: true, entry: 'topology', drawer: null, drawerStack: [], drawerExpanded: false, projection,
      status: 'ready', error: null, notice: null, busy: null, query: '', locale: 'en', selectedAgentId: undefined,
      providerFormOpen: false, editingProviderId: undefined,
      providerDraft: { id: '', label: '', protocol: 'openai-chat', apiBaseUrl: '', enabled: true, authKind: 'none', credentialRef: '' } }
    const controller = snapshot => ({ getSnapshot: () => snapshot })
    const cardRoot = document.getElementById('card-root')
    const drawerRoot = document.getElementById('drawer-root')
    const absentRoot = document.getElementById('absent-root')
    renderConsole(cardRoot, controller({ ...state, projection: { ...projection, agents: [provider] } }))
    renderConsole(drawerRoot, controller({ ...state, drawer: { kind: 'agent', agentId: 'provider' }, drawerStack: [{ kind: 'agent', agentId: 'provider' }] }))
    renderConsole(absentRoot, controller({ ...state, projection: { ...projection, agents: [plain] } }))
    const card = cardRoot.textContent
    const drawer = drawerRoot.textContent
    const absent = absentRoot.textContent
    document.body.dataset.cardDetail = String(card.includes('file-search') && card.includes('search') && card.includes('index')
      && card.includes('search-slot') && card.includes('4') && card.includes('context') && card.includes('Declared capacity'))
    document.body.dataset.drawerDetail = String(drawer.includes('file-search') && drawer.includes('3')
      && drawer.includes('search-slot') && drawer.includes('Declared capacity'))
    document.body.dataset.absentUnavailable = String(absent.includes('Service and resource detail is unavailable.'))
    document.body.dataset.absentNoCapacity = String(!absent.includes('Declared capacity') && !absent.includes('search-slot'))
    document.body.dataset.cardNoUnavailable = String(!card.includes('Service and resource detail is unavailable.'))
  </script>
</body></html>`

describe('declared capability rendering in a real DOM', () => {
  it('renders declared services and resources and an explicit unavailable state', { timeout: 30_000 }, () => {
    const script = [classicModule('client/locale.ts'), classicModule('state/model.ts'), classicModule('state/group-workspace.ts'), classicModule('components/dom.ts'), classicModule('components/page-groups.ts'), classicModule('components/render.ts')].join('\n')
    if (/(^|\n)\s*(import|export)\b/.test(script)) throw new Error('classic module bundling left module syntax behind')
    const directory = mkdtempSync(join(tmpdir(), 'teams-console-render-'))
    onTestFinished(() => {
      rmSync(directory, { recursive: true, force: true })
    })
    const page = join(directory, 'render.html')
    writeFileSync(page, pageScript(script))
    const output = runChrome(page, 20_000)
    expect(output).toContain('data-card-detail="true"')
    expect(output).toContain('data-drawer-detail="true"')
    expect(output).toContain('data-absent-unavailable="true"')
    expect(output).toContain('data-absent-no-capacity="true"')
    expect(output).toContain('data-card-no-unavailable="true"')
  })
})

describe('BB09 refresh completion in a real DOM', () => {
  it('keeps the busy window distinct from completion and enables bind after reselection', { timeout: 30_000 }, () => {
    const script = [classicModule('client/locale.ts'), classicModule('state/model.ts'), classicModule('state/group-workspace.ts'), classicModule('components/dom.ts'), classicModule('components/page-groups.ts'), classicModule('components/render.ts')].join('\n')
    if (/(^|\n)\s*(import|export)\b/.test(script)) throw new Error('classic module bundling left module syntax behind')
    const directory = mkdtempSync(join(tmpdir(), 'teams-console-busy-window-'))
    onTestFinished(() => {
      rmSync(directory, { recursive: true, force: true })
    })
    const page = join(directory, 'busy-window.html')
    const busyWindowScript = `<!doctype html>
<html><body>
  <div id="root"></div>
  <script>
${script}
    const projection = { version: 1, agents: [{ kind: 'runtime', agentId: 'provider', label: 'Provider',
      machineId: 'M1', presence: 'online', capabilities: [], sessionCapable: false, sessionAvailability: 'no-current' }],
      sessions: [], notifications: [], configs: [{ agentId: 'provider', acceptedRevision: 1, providers: [{
        id: 'p', label: 'Provider', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true,
        authKind: 'none', catalogState: 'ready', models: [{ id: 'bb-console-model', label: 'BB Console Model' }],
      }] }] }
    let state = { open: true, entry: 'topology', drawer: { kind: 'settings', agentId: 'provider' },
      drawerStack: [{ kind: 'settings', agentId: 'provider' }], drawerExpanded: false, projection,
      status: 'ready', error: null, notice: null, busy: 'Refresh models', query: '', locale: 'en',
      selectedAgentId: 'provider', providerFormOpen: false, editingProviderId: undefined,
      providerDraft: { id: '', label: '', protocol: 'openai-chat', apiBaseUrl: '', enabled: true, authKind: 'none', credentialRef: '' } }
    const root = document.getElementById('root')
    const controller = { getSnapshot: () => state }
    renderConsole(root, controller)
    const modelSelect = () => document.querySelector('article.teams-provider-card select.teams-select')
    const bindButton = () => document.querySelector('article.teams-provider-card .teams-model-row .teams-button-primary')
    document.body.dataset.modelVisibleBusy = String([...modelSelect().options].some(option => option.value === 'bb-console-model'))
    // Select the model through the real change event before reading the disabled state, so the
    // "no model selected" disjunct is already false and the busy window is the only reason the
    // bind button can still be disabled.
    modelSelect().value = 'bb-console-model'
    modelSelect().dispatchEvent(new Event('change', { bubbles: true }))
    document.body.dataset.bindDisabledBusy = String(bindButton().disabled)
    state = { ...state, busy: null, notice: 'Refresh models: accepted by Agent' }
    renderConsole(root, controller)
    document.body.dataset.selectResetAfterComplete = String(modelSelect().value === '')
    document.body.dataset.bindDisabledAfterComplete = String(bindButton().disabled)
    modelSelect().value = 'bb-console-model'
    modelSelect().dispatchEvent(new Event('change', { bubbles: true }))
    document.body.dataset.bindEnabledAfterReselect = String(bindButton().disabled === false)
    // The change listener is not the only place that binds the busy window. Re-render with the
    // owner's binding in place, so actionDisabled alone decides the paint-time disabled state
    // and the "no model selected" disjunct is already false there too.
    const boundProjection = { ...projection, agents: [{ ...projection.agents[0], providerId: 'p', modelId: 'bb-console-model' }] }
    state = { ...state, busy: 'Refresh models', projection: boundProjection }
    renderConsole(root, controller)
    document.body.dataset.bindDisabledBusyBound = String(bindButton().disabled)
  </script>
</body></html>`
    writeFileSync(page, busyWindowScript)
    const output = runChrome(page, 20_000)
    expect(output).toContain('data-model-visible-busy="true"')
    expect(output).toContain('data-bind-disabled-busy="true"')
    expect(output).toContain('data-bind-disabled-busy-bound="true"')
    expect(output).toContain('data-select-reset-after-complete="true"')
    expect(output).toContain('data-bind-disabled-after-complete="true"')
    expect(output).toContain('data-bind-enabled-after-reselect="true"')
  })
})
