import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startConsoleHost } from '../console-host/lib/index.mjs'

const root = resolve(import.meta.dirname, '..')
const artifact = resolve(root, 'generated/modules/teams-source/lib')
// Execute the compiled library in its installed dependency context, after
// checking byte identity with the packaged artifact. This is not deployment.
assert.deepEqual(readFileSync(resolve(root, 'console-host/lib/index.mjs')), readFileSync(resolve(artifact, 'console-host/index.mjs')))
assert.deepEqual(readFileSync(resolve(root, 'opencode-adapter/lib/index.mjs')), readFileSync(resolve(artifact, 'opencode-adapter/index.mjs')))
const server = await startConsoleHost({ agents: [], staticRoot: resolve(artifact, 'static'), port: 0 })
try {
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const health = await fetch(`${base}/health`)
  assert.equal(health.status, 200)
  assert.deepEqual(await health.json(), { ok: true })
  const page = await fetch(base)
  assert.equal(page.status, 200)
  assert.equal(await page.text(), readFileSync(resolve(artifact, 'static/index.html'), 'utf8'))
  const invalid = await fetch(`${base}/api/action`, { method: 'POST', body: '{}' })
  assert.equal(invalid.status, 500)
  assert.equal(typeof (await invalid.json()).error, 'string')
  console.log('Compiled Console HTTP smoke passed: health, exact static artifact, invalid action rejection. No provider or cross-device claim.')
} finally {
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
}
