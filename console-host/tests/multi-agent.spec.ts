import { describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { dispatchConsoleHostAction, projectConsoleHost } from '../src/index.ts'

function upstreamServer(handler: (requestUrl: string) => unknown): Promise<{ port: number, close: () => Promise<void> }> {
  return new Promise((resolveServer, reject) => {
    const server = createServer((request, response) => {
      const url = request.url ?? '/'
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(handler(url)))
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('upstream address missing'))
        return
      }
      resolveServer({
        port: address.port,
        close: () => new Promise<void>(resolve => server.close(() => { resolve() })),
      })
    })
  })
}

describe('Teams Console Host multi-agent aggregator', () => {
  it('aggregates sessions and notifications from multiple agent endpoints', async () => {
    const alpha = await upstreamServer(url => url === '/permission'
      ? [{ id: 'per_alpha', sessionID: 'ses_alpha' }]
      : [{ id: 'ses_alpha', title: 'Alpha session' }])
    const beta = await upstreamServer(url => url === '/permission'
      ? [{ id: 'per_beta', sessionID: 'ses_beta' }]
      : [{ id: 'ses_beta', title: 'Beta session' }])
    const projection = await projectConsoleHost({
      agents: [
        { agentId: 'agent-alpha', machineId: 'machine-alpha', label: 'Alpha', openCodeUrl: `http://127.0.0.1:${alpha.port}` },
        { agentId: 'agent-beta', machineId: 'machine-beta', label: 'Beta', openCodeUrl: `http://127.0.0.1:${beta.port}` },
      ],
      staticRoot: '.',
    })
    expect(projection.agents.map(agent => agent.agentId)).toEqual(['agent-alpha', 'agent-beta'])
    expect(projection.sessions.map(session => session.agentId)).toEqual(['agent-alpha', 'agent-beta'])
    expect(projection.notifications.map(notification => notification.agentId)).toEqual(['agent-alpha', 'agent-beta'])
    await alpha.close()
    await beta.close()
  })

  it('routes an action to the agent that owns the session', async () => {
    const alpha = await upstreamServer(() => [])
    const beta = await upstreamServer(url => url === '/permission/yes'
      ? { ok: true }
      : url === '/session/ses_beta/prompt_async'
        ? { ok: true }
        : [])
    await expectDispatch(dispatchConsoleHostAction, {
      agents: [
        { agentId: 'agent-alpha', machineId: 'machine-alpha', label: 'Alpha', openCodeUrl: `http://127.0.0.1:${alpha.port}` },
        { agentId: 'agent-beta', machineId: 'machine-beta', label: 'Beta', openCodeUrl: `http://127.0.0.1:${beta.port}` },
      ],
      staticRoot: '.',
    }, { kind: 'reply-permission', agentId: 'agent-beta', sessionId: 'ses_beta', permissionId: 'per_beta', response: 'once' })
    await alpha.close()
    await beta.close()
  })

  it('rejects actions addressed to an unknown agent', async () => {
    await expectDispatch(dispatchConsoleHostAction, {
      agents: [],
      staticRoot: '.',
    }, { kind: 'send-message', agentId: 'ghost', sessionId: 'ses_ghost', text: 'hi' }).then(
      () => { throw new Error('expected dispatch to fail') },
      (error: unknown) => { expect(String(error)).toMatch(/agent/) },
    )
  })
})

async function expectDispatch(
  dispatch: typeof dispatchConsoleHostAction,
  options: Parameters<typeof dispatchConsoleHostAction>[0],
  action: Parameters<typeof dispatchConsoleHostAction>[1],
): Promise<void> {
  try {
    await dispatch(options, action)
  } catch (error) {
    throw error
  }
}
