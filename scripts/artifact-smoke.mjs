import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const artifact = resolve(root, 'generated/modules/teams-source/lib')
assert.deepEqual(readFileSync(resolve(root, 'console-host/lib/index.mjs')), readFileSync(resolve(artifact, 'console-host/index.mjs')))
assert.deepEqual(readFileSync(resolve(root, 'opencode-adapter/lib/index.mjs')), readFileSync(resolve(artifact, 'opencode-adapter/index.mjs')))
assert.deepEqual(readFileSync(resolve(root, 'ui/teams-console/lib/index.js')), readFileSync(resolve(artifact, 'ui/index.js')))
assert.deepEqual(readFileSync(resolve(root, 'ui/teams-console/assets/agentbrowser-icon.jpg')), readFileSync(resolve(artifact, 'ui/assets/agentbrowser-icon.jpg')))
const { createConsoleServer } = await import(pathToFileURL(resolve(artifact, 'console-host/index.mjs')).href)
const consoleUi = await import(pathToFileURL(resolve(artifact, 'ui/index.js')).href)
const browserUi = await import(pathToFileURL(resolve(artifact, 'ui/browser.js')).href)
assert.equal(typeof consoleUi.createConsoleHttpClient, 'function')
assert.equal(typeof browserUi.mountTeamsConsole, 'function')
let received
const client = {
  readProjection: async () => ({ version: 1, agents: [], sessions: [], configs: [], notifications: [] }),
  command: async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'smoke owner denial' } }),
  sendSession: async (target, payload) => { received = { target, payload }; return { ok: true } },
}
const server = createConsoleServer({ staticRoot: resolve(artifact, 'static'), uiRoot: resolve(artifact, 'ui'),
  authorize: async request => request.headers.authorization === 'smoke-only' ? client : undefined })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
try {
  const base = `http://127.0.0.1:${server.address().port}`
  assert.equal((await fetch(base)).status, 401)
  const headers = { authorization: 'smoke-only', 'content-type': 'application/json' }
  const page = await fetch(base, { headers })
  assert.equal(page.status, 200)
  assert.equal(await page.text(), readFileSync(resolve(artifact, 'static/console.html'), 'utf8'))
  assert.equal((await fetch(`${base}/ui/browser.js`, { headers })).status, 200)
  for (const path of ['/api/action', '/api/agent-message', '/api/relation', '/api/projection']) {
    assert.equal((await fetch(base + path, { headers })).status, 404)
  }
  const command = await fetch(`${base}/api/v1/command`, { method: 'POST', headers, body: JSON.stringify({ kind: 'config.apply', agentId: 'a' }) })
  assert.deepEqual(await command.json(), { ok: false, error: { code: 'FORBIDDEN', message: 'smoke owner denial' } })
  const payload = [{ config: { route: ['a', null], token: 'business' }, command: 'business' }]
  const session = await fetch(`${base}/api/v1/session-message?agentId=a&sessionId=s`, { method: 'POST', headers, body: JSON.stringify(payload) })
  assert.equal(session.status, 200)
  assert.deepEqual(received, { target: { agentId: 'a', sessionId: 's' }, payload })
  console.log('Packaged Console smoke passed: authenticated UI/API, legacy routes absent, owner denial and exact Session JSON. No provider or cross-device claim.')
} finally { await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
