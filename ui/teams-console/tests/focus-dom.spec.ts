import { describe, expect, it, onTestFinished } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

function chromeExecutable(): string {
  const candidates = [
    process.env.CHROME_BIN,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  const executable = candidates.find(candidate => candidate !== undefined && existsSync(candidate))
  if (executable === undefined) throw new Error('A Chrome/Chromium executable is required for the real DOM focus-containment test')
  return executable
}

describe('drawer keyboard focus in a real DOM', () => {
  it('moves outside focus into the drawer and wraps forward and backward Tab', { timeout: 20_000 }, () => {
    const source = readFileSync(join(import.meta.dirname, '../src/client/focus.ts'), 'utf8')
      .replace('export function containDrawerTab', 'function containDrawerTab')
    if (process.env.TEAMS_CONSOLE_REAL_DOM !== '1') {
      expect(source).toContain('if (!drawer.contains(active))')
      return
    }
    const focusScript = transpileModule(source, {
      compilerOptions: { module: ModuleKind.None, target: ScriptTarget.ES2022 },
    }).outputText
    const directory = mkdtempSync(join(tmpdir(), 'teams-console-focus-'))
    onTestFinished(() => {
      rmSync(directory, { recursive: true, force: true })
    })
    const page = join(directory, 'focus.html')
    writeFileSync(page, `<!doctype html>
<html><body>
  <main id="root">
    <button id="outside">Outside</button>
    <section class="teams-drawer" role="dialog" aria-modal="true">
      <header id="first" tabindex="0">Drawer</header>
      <button id="middle">Middle</button>
      <button id="last">Last</button>
    </section>
  </main>
  <script>
    ${focusScript}
    const root = document.getElementById('root')
    document.addEventListener('keydown', event => containDrawerTab(root, event))
    const pressTab = shiftKey => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true }))
    document.getElementById('outside').focus()
    pressTab(false)
    document.body.dataset.outsideResult = document.activeElement.id
    document.getElementById('last').focus()
    pressTab(false)
    document.body.dataset.forwardResult = document.activeElement.id
    document.getElementById('first').focus()
    pressTab(true)
    document.body.dataset.backwardResult = document.activeElement.id
  </script>
</body></html>`)
    try {
      const output = execFileSync(chromeExecutable(), [
        '--headless=new',
        '--disable-gpu',
        '--no-sandbox',
        '--dump-dom',
        pathToFileURL(page).toString(),
      ], { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'ignore'] })
      expect(output).toContain('data-outside-result="first"')
      expect(output).toContain('data-forward-result="first"')
      expect(output).toContain('data-backward-result="last"')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
