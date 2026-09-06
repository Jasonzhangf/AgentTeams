import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createConsoleServer } from '../src/server.ts'

it('serves the independent UI and authenticated API without exposing arbitrary files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-console-server-'))
  await mkdir(join(directory, 'ui'))
  await writeFile(join(directory, 'ui', 'browser.js'), 'export const live = true')
  await writeFile(join(directory, 'console.html'), '<main>Teams Console</main>')
  await writeFile(join(directory, 'console-entry.js'), 'import "/ui/browser.js"')
  await writeFile(join(directory, 'private.txt'), 'not public')
  const server = createConsoleServer({ staticRoot: directory, uiRoot: join(directory, 'ui'),
    authorize: async request => request.headers.authorization === 'test' ? {
      readProjection: async () => ({ version: 1, agents: [], sessions: [], notifications: [], configs: [] }),
      command: async () => ({ ok: false, error: { code: 'FORBIDDEN', message: 'owner denied' } }),
      sendSession: async () => ({ ok: false, error: { code: 'UNSUPPORTED_OPERATION', message: 'no Session' } }),
    } : undefined,
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    expect((await fetch(base)).status).toBe(401)
    const get = (path: string) => fetch(base + path, { headers: { authorization: 'test' } })
    expect(await (await get('/')).text()).toContain('Teams Console')
    const script = await get('/ui/browser.js')
    expect(script.headers.get('content-type')).toContain('javascript')
    expect(await script.text()).toBe('export const live = true')
    expect((await get('/private.txt')).status).toBe(404)
    expect((await get('/ui/%2e%2e%2fprivate.txt')).status).toBe(404)
    expect(await (await get('/api/v1/projection')).json()).toMatchObject({ version: 1 })
    expect((await get('/api/action')).status).toBe(404)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(directory, { recursive: true })
  }
})
