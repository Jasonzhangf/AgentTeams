import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const entrySource = readFileSync(resolve(import.meta.dirname, '..', 'static', 'console-entry.js'), 'utf8')

// The entry imports bare module specifiers from the served browser bundle. Replace that one
// specifier with a recording stub so the real entry file runs and its call order is observable.
const stubSource = `
export const calls = {
  live: 0,
  group: 0,
  withGroup: 0,
  mount: 0,
  liveArgs: undefined,
  groupArgs: undefined,
  composedArgs: undefined,
  mountArgs: undefined,
  liveClient: undefined,
  sender: undefined,
}
const sender = { requestGroup: async () => ({ kind: 'transport', message: 'stub' }) }
export function createLiveConsoleHttpClient(...args) {
  calls.live += 1
  calls.liveArgs = args
  calls.liveClient = { kind: 'live', readProjection: async () => ({}), command: async () => ({ ok: true }), sendSession: async () => ({ ok: true }) }
  return calls.liveClient
}
export function createGroupRequestClient(...args) {
  calls.group += 1
  calls.groupArgs = args
  calls.sender = sender
  return sender
}
export function withGroupRequests(client, group) {
  calls.withGroup += 1
  calls.composedArgs = [client, group]
  return { ...client, requestGroup: group.requestGroup }
}
export function mountTeamsConsole(root, client, options) {
  calls.mount += 1
  calls.mountArgs = { root, client, options }
  return { destroy() {} }
}
export function createSessionStorageDrafts(storage) {
  return { storage }
}
`

let tempDir: string | undefined

afterEach(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

it('mounts the real entry with the live client composed with the same-origin group port', async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'console-entry-'))
  const stubPath = join(tempDir, 'browser-stub.mjs')
  writeFileSync(stubPath, stubSource)
  const rewritten = entrySource.replace(
    /from ['"]\/ui\/browser\.js['"]/,
    `from ${JSON.stringify(pathToFileURL(stubPath).href)}`,
  )
  expect(rewritten).not.toBe(entrySource)
  const entryPath = join(tempDir, 'console-entry.mjs')
  writeFileSync(entryPath, rewritten)

  const root = { id: 'app-root' }
  Object.defineProperty(globalThis, 'document', {
    value: { getElementById: (id: string) => (id === 'app' ? root : null) },
    configurable: true,
  })
  try {
    const stub = await import(pathToFileURL(stubPath).href) as {
      readonly calls: {
        live: number
        group: number
        withGroup: number
        mount: number
        groupArgs: unknown[]
        composedArgs?: [object, { requestGroup: unknown }]
        mountArgs?: { root: unknown; client: Record<string, unknown>; options: Record<string, unknown> }
        liveClient?: object
        sender?: { requestGroup: unknown }
      }
    }
    await import(pathToFileURL(entryPath).href)

    const { calls } = stub
    expect(calls.live).toBe(1)
    expect(calls.group).toBe(1)
    expect(calls.withGroup).toBe(1)
    expect(calls.mount).toBe(1)
    // Same-origin default: the entry must not override the endpoint path or base URL.
    expect(calls.groupArgs).toEqual([])
    expect(calls.composedArgs?.[0]).toBe(calls.liveClient)
    expect(calls.composedArgs?.[1]).toBe(calls.sender)

    const mounted = calls.mountArgs
    expect(mounted?.root).toBe(root)
    expect(mounted?.client).not.toBe(calls.liveClient)
    expect(mounted?.client.requestGroup).toBe(calls.sender?.requestGroup)
    expect(mounted?.options.initialOpen).toBe(true)
    expect(mounted?.options.locale).toBe('zh')
    expect('persistence' in (mounted?.options ?? {})).toBe(true)
  } finally {
    delete (globalThis as { document?: unknown }).document
  }
})
