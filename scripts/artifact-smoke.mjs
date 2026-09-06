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
const agents = ['source', 'target'].map(agentId => ({ agentId, machineId: 'local', label: agentId, openCodeUrl: 'http://127.0.0.1:1' }))
const server = await startConsoleHost({ agents, staticRoot: resolve(artifact, 'static'), port: 0 })
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
  const message = { kind: 'notify', correlationId: 'c', payload: { results: [{ config: { token: 'business', route: ['a', null] } }] } }
  const postMessage = async message => {
    const response = await fetch(`${base}/api/agent-message`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageId: 'm', relationId: 'missing', fromAgentId: 'source', toAgentId: 'target', message }),
    })
    assert.equal(response.status, 500)
    return (await response.json()).error
  }
  // Deliberately stop at missing relation: prove protocol ingress, not execution.
  assert.match(await postMessage(message), /relation missing does not exist/)
  assert.match(await postMessage({ ...message, targetGeneration: 7 }), /unsupported field targetGeneration/)
  console.log('Compiled Console HTTP smoke passed: health, exact static artifact, invalid action, JSON payload ingress and misplaced control rejection. No provider or cross-device claim.')
} finally {
  await new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose()))
}
