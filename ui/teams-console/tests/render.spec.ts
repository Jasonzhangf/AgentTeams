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

describe('config settings read-only in a real DOM', () => {
  it('renders the settings drawer read-only with a projected binding and no write buttons', { timeout: 30_000 }, () => {
    const script = [classicModule('client/locale.ts'), classicModule('state/model.ts'), classicModule('state/group-workspace.ts'), classicModule('components/dom.ts'), classicModule('components/page-groups.ts'), classicModule('components/render.ts')].join('\n')
    if (/(^|\n)\s*(import|export)\b/.test(script)) throw new Error('classic module bundling left module syntax behind')
    const directory = mkdtempSync(join(tmpdir(), 'teams-console-config-readonly-'))
    onTestFinished(() => {
      rmSync(directory, { recursive: true, force: true })
    })
    const page = join(directory, 'config-readonly.html')
    const readOnlyScript = `<!doctype html>
<html><body>
  <div id="root"></div>
  <script>
${script}
    const projection = { version: 1, agents: [{ kind: 'runtime', agentId: 'provider', label: 'Provider',
      machineId: 'M1', presence: 'online', capabilities: ['session'], sessionCapable: true, sessionAvailability: 'current' }],
      sessions: [], notifications: [], configs: [{ agentId: 'provider', acceptedRevision: 7, effectiveRevision: 6,
        acceptedBinding: { primary: { providerInstanceId: 'rcc', modelId: 'deepseek-v4' },
          backup: { providerInstanceId: 'rcc', modelId: 'deepseek-v4-reasoner' } },
        providers: [{
        id: 'p', label: 'Provider', protocol: 'openai-chat', apiBaseUrl: 'http://127.0.0.1:1/v1', enabled: true,
        authKind: 'none', catalogState: 'ready',
        models: [{ id: 'deepseek-v4', label: 'DeepSeek V4' }, { id: 'deepseek-v4-reasoner', label: 'DeepSeek V4 Reasoner' }],
      }] }] }
    let state = { open: true, entry: 'topology', drawer: { kind: 'settings', agentId: 'provider' },
      drawerStack: [{ kind: 'settings', agentId: 'provider' }], drawerExpanded: false, projection,
      status: 'ready', error: null, notice: null, busy: null, query: '', locale: 'en',
      selectedAgentId: 'provider' }
    const root = document.getElementById('root')
    const controller = { getSnapshot: () => state }
    renderConsole(root, controller)
    const body = root.querySelector('.teams-drawer-body')
    document.body.dataset.configReadonly = String(body.querySelector('[data-config-readonly="true"]') !== null)
    document.body.dataset.settingsBodyButtons = String(body.querySelectorAll('button').length)
    const binding = body.querySelector('[data-config-binding="true"]')
    document.body.dataset.bindingPrimary = String((binding?.textContent ?? '').includes('rcc/deepseek-v4'))
    document.body.dataset.bindingBackup = String((binding?.textContent ?? '').includes('deepseek-v4-reasoner'))
    const revisions = body.querySelector('.teams-revision-row')
    document.body.dataset.revisions = String((revisions?.textContent ?? '').includes('7') && (revisions?.textContent ?? '').includes('6'))
    document.body.dataset.modelReadonly = String(body.querySelector('[data-provider-model="deepseek-v4"]') !== null)
    document.body.dataset.noWriteForm = String(body.querySelector('.teams-config-form') === null
      && body.querySelector('.teams-model-row') === null
      && body.querySelector('article.teams-provider-card .teams-provider-actions') === null)
  </script>
</body></html>`
    writeFileSync(page, readOnlyScript)
    const output = runChrome(page, 20_000)
    expect(output).toContain('data-config-readonly="true"')
    expect(output).toContain('data-settings-body-buttons="0"')
    expect(output).toContain('data-binding-primary="true"')
    expect(output).toContain('data-binding-backup="true"')
    expect(output).toContain('data-revisions="true"')
    expect(output).toContain('data-model-readonly="true"')
    expect(output).toContain('data-no-write-form="true"')
  })
})
