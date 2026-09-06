import { expect, it } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { createConsoleAuthorization } from '../src/auth.ts'

it('requires exact credentials and rejects cross-site browser requests', async () => {
  const client = { readProjection: async () => ({ version: 1 as const, agents: [], sessions: [], configs: [], notifications: [] }), command: async () => ({ ok: true as const }), sendSession: async () => ({ ok: true as const }) }
  const authorize = createConsoleAuthorization({ username: 'operator', password: 'secret-value', origin: 'https://console.example', client })
  const request = (headers: IncomingMessage['headers']) => ({ headers }) as IncomingMessage
  const authorization = `Basic ${Buffer.from('operator:secret-value').toString('base64')}`
  expect(await authorize(request({ authorization }))).toBe(client)
  expect(await authorize(request({ authorization, origin: 'https://console.example', 'sec-fetch-site': 'same-origin' }))).toBe(client)
  for (const headers of [{}, { authorization: 'Basic invalid' }, { authorization: `Basic ${Buffer.from('operator:wrong').toString('base64')}` },
    { authorization, origin: 'https://attacker.example' }, { authorization, 'sec-fetch-site': 'cross-site' },
    { authorization, 'sec-fetch-site': 'same-site' }]) {
    expect(await authorize(request(headers))).toBeUndefined()
  }
  expect(() => createConsoleAuthorization({ username: 'a:b', password: 'secret', origin: 'https://console.example', client })).toThrow()
  expect(() => createConsoleAuthorization({ username: 'a', password: '', origin: 'https://console.example', client })).toThrow()
})
