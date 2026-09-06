import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createOpenCodeLaunchConfig } from '../opencode-adapter/src/managed-config.ts'
import { startManagedOpenCode } from './managed-opencode.ts'

it('sends one real OpenCode Session request through the selected managed provider', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-managed-session-'))
  const provider = createServer((request, response) => {
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { response.writeHead(404); response.end(); return }
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const input = JSON.parse(body) as { model?: string; messages?: readonly { content?: string }[] }
      if (body.includes('"stream":true')) {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-teams', object: 'chat.completion.chunk', created: 1, model: input.model,
          choices: [{ index: 0, delta: { role: 'assistant', content: 'managed-provider-ok' }, finish_reason: null }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ id: 'chatcmpl-teams', object: 'chat.completion.chunk', created: 1, model: input.model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`)
        response.end('data: [DONE]\n\n')
      } else {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id: 'chatcmpl-teams', object: 'chat.completion', created: 1, model: input.model,
          choices: [{ index: 0, message: { role: 'assistant', content: 'managed-provider-ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
      }
    })
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const port = (provider.address() as { port: number }).port
  try {
    const compiled = { agentId: 'llm-agent', acceptedRevision: 4, primary: { provider: 'probe', model: 'probe-model', protocol: 'openai-chat' as const,
      baseUrl: `http://127.0.0.1:${port}/v1` } }
    const launch = createOpenCodeLaunchConfig(compiled)
    const managed = await startManagedOpenCode({ executable: '/Users/fanzhang/.opencode/bin/opencode', directory: join(directory, 'opencode'),
      port: await availablePort(), startupTimeoutMs: 10000, stopTimeoutMs: 3000, compiled, resolveCredential: async () => { throw new Error('no credential') } })
    try {
      const headers = { authorization: managed.authorization, 'content-type': 'application/json' }
      const sessionResponse = await fetch(`${managed.url}/session`, { method: 'POST', headers, body: JSON.stringify({ title: 'Teams probe' }), signal: AbortSignal.timeout(5000) })
      expect(sessionResponse.ok).toBe(true)
      const session = await sessionResponse.json() as { id?: string }
      expect(typeof session.id).toBe('string')
      const messageResponse = await fetch(`${managed.url}/session/${session.id}/message`, { method: 'POST', headers,
        body: JSON.stringify({ parts: [{ type: 'text', text: 'probe request' }], model: { providerID: compiled.primary.provider, modelID: compiled.primary.model } }), signal: AbortSignal.timeout(10000) })
      expect(messageResponse.ok).toBe(true)
      const message = await messageResponse.json() as { parts?: readonly { type?: string; text?: string }[] }
      expect(message.parts?.some(part => part.type === 'text' && part.text?.includes('managed-provider-ok'))).toBe(true)
      expect(launch.config.model).toBe('probe/probe-model')
    } finally { await managed.stop() }
  } finally { await new Promise<void>(resolve => provider.close(() => resolve())); await rm(directory, { recursive: true }) }
}, 30000)

async function availablePort(): Promise<number> {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening')
  const address = listener.address(); if (!address || typeof address === 'string') throw new Error('port missing')
  await new Promise<void>(resolve => listener.close(() => resolve())); return address.port
}
