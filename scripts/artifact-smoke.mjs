import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const artifact = resolve(root, 'generated', 'modules', 'teams-source', 'lib')
const receiptPath = resolve(root, 'generated', 'modules', 'teams-source', 'package-receipt.json')

function assertSame(sourcePath, artifactPath = sourcePath) {
  assert.deepEqual(
    readFileSync(resolve(root, sourcePath)),
    readFileSync(resolve(artifact, artifactPath)),
    `packaged bytes differ: ${artifactPath}`,
  )
}

assert.ok(existsSync(artifact), 'staged package root is missing')
const rootPackage = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const packageJson = JSON.parse(readFileSync(resolve(artifact, 'package.json'), 'utf8'))
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
assert.equal(packageJson.name, 'agentteams')
assert.equal(packageJson.version, rootPackage.version)
assert.deepEqual(packageJson.files, rootPackage.files)
assert.deepEqual(packageJson.dependencies, rootPackage.dependencies)
assert.equal(receipt.mode, 'base')
assert.equal(receipt.release_eligible, false)
assert.equal(receipt.version, rootPackage.version)
assert.equal(existsSync(resolve(artifact, 'runtime', 'package.json')), false)
assert.equal(existsSync(resolve(artifact, 'static', 'console.html')), false)
assert.equal(existsSync(resolve(artifact, 'ui', 'index.js')), false)

for (const relativePath of [
  'cli/agentteams.mjs',
  'generated/runtime-lib/runtime/local-process.js',
  'console-host/lib/index.mjs',
  'console-host/static/console.html',
  'console-host/static/console-entry.js',
]) {
  assertSame(relativePath)
}
for (const relativePath of ['index.js', 'browser.js', 'client/render.js']) {
  assertSame(`ui/teams-console/lib/${relativePath}`, `ui/teams-console/${relativePath}`)
}
assertSame('ui/teams-console/assets/agentbrowser-icon.jpg')

const { createConsoleServer, createConsoleAuthorization } = await import(
  pathToFileURL(resolve(artifact, 'console-host', 'lib', 'index.mjs')).href
)
const consoleUi = await import(pathToFileURL(resolve(artifact, 'ui', 'teams-console', 'index.js')).href)
const browserUi = await import(pathToFileURL(resolve(artifact, 'ui', 'teams-console', 'browser.js')).href)
assert.equal(typeof consoleUi.createConsoleHttpClient, 'function')
assert.equal(typeof browserUi.mountTeamsConsole, 'function')

let received
const client = {
  readProjection: async () => ({ version: 1, agents: [], sessions: [], configs: [], notifications: [] }),
  command: async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'smoke owner denial' } }),
  sendSession: async (target, payload) => {
    received = { target, payload }
    return { ok: true }
  },
}
let authorize
const server = createConsoleServer({
  staticRoot: resolve(artifact, 'console-host', 'static'),
  uiRoot: resolve(artifact, 'ui', 'teams-console'),
  authenticationChallenge: 'Basic realm="AgentTeams", charset="UTF-8"',
  authorize: request => authorize ? authorize(request) : undefined,
})
await new Promise((resolvePromise, reject) => server.listen(0, '127.0.0.1', error => error ? reject(error) : resolvePromise()))
try {
  const origin = `http://127.0.0.1:${server.address().port}`
  authorize = createConsoleAuthorization({
    username: 'artifact-user',
    password: 'artifact-pass',
    origin,
    client,
  })
  const authorization = `Basic ${Buffer.from('artifact-user:artifact-pass').toString('base64')}`
  const unauthorized = await fetch(origin)
  assert.equal(unauthorized.status, 401)
  assert.match(unauthorized.headers.get('www-authenticate') ?? '', /Basic/)

  const headers = { authorization, 'content-type': 'application/json' }
  const page = await fetch(origin, { headers })
  assert.equal(page.status, 200)
  assert.equal(await page.text(), readFileSync(resolve(artifact, 'console-host', 'static', 'console.html'), 'utf8'))
  assert.equal((await fetch(`${origin}/console-entry.js`, { headers })).status, 200)
  assert.equal((await fetch(`${origin}/ui/browser.js`, { headers })).status, 200)
  assert.equal((await fetch(`${origin}/ui/assets/agentbrowser-icon.jpg`, { headers })).status, 200)
  assert.equal((await fetch(origin, { headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).status, 401)
  for (const path of ['/api/action', '/api/agent-message', '/api/relation', '/api/projection']) {
    assert.equal((await fetch(origin + path, { headers })).status, 404)
  }
  const command = await fetch(`${origin}/api/v1/command`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'config.apply', agentId: 'a' }),
  })
  assert.deepEqual(await command.json(), { ok: false, error: { code: 'FORBIDDEN', message: 'smoke owner denial' } })
  const payload = [{ config: { route: ['a', null], token: 'business' }, command: 'business' }]
  const session = await fetch(`${origin}/api/v1/session-message?agentId=a&sessionId=s`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  })
  assert.equal(session.status, 200)
  assert.deepEqual(received, { target: { agentId: 'a', sessionId: 's' }, payload })
  console.log('Packaged Console smoke passed: one staged pack root, actual Basic auth, static/UI bytes, and owner-denied API. No provider or cross-device claim.')
} finally {
  server.closeAllConnections?.()
  await new Promise(resolvePromise => server.close(resolvePromise))
}
