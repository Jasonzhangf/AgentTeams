import { describe, expect, it } from 'vitest'
import type { FixedProcessResult, FixedProcessRunner, FixedProcessSpec } from './fixed-process.ts'
import { createBrowserCliAdapter } from './browser-cli.ts'
import { CliAdapterError } from './contracts.ts'

function result(stdout: string, exitCode = 0, stderr = ''): FixedProcessResult {
  return { exitCode, signal: null, timedOut: false, stdout, stderr }
}

function scriptedRunner(results: readonly FixedProcessResult[]): { readonly calls: FixedProcessSpec[]; readonly runner: FixedProcessRunner } {
  const calls: FixedProcessSpec[] = []
  let index = 0
  return {
    calls,
    runner: async spec => {
      calls.push(spec)
      const next = results[index++]
      if (next === undefined) throw new Error(`unexpected process call ${index}`)
      return next
    },
  }
}

describe('Camo browser CLI adapter', () => {
  it('serializes concurrent context creation before claiming one profile', async () => {
    let releaseStart!: () => void
    const startReleased = new Promise<void>(resolve => {
      releaseStart = resolve
    })
    const calls: FixedProcessSpec[] = []
    const runner: FixedProcessRunner = async spec => {
      calls.push(spec)
      if (spec.argv[0] === 'daemon') {
        return result(JSON.stringify({ kind: 'result', cmd: 'daemon', result: { status: 'already_running' } }))
      }
      if (spec.argv[0] === 'start') {
        await startReleased
        return result(JSON.stringify({ cmd: 'start', sessionId: 'camoufox-test', profile: 'teams-test', headless: true }))
      }
      throw new Error(`unexpected process call ${spec.argv.join(' ')}`)
    }
    const adapter = createBrowserCliAdapter({ executable: '/opt/homebrew/bin/camo', profile: 'teams-test', runner })

    const first = adapter.contextCreate({ operation: 'context.create' })
    const second = adapter.contextCreate({ operation: 'context.create' })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(calls.map(call => call.argv)).toEqual([
      ['daemon', 'start', '--profile', 'teams-test'],
      ['start', '--profile', 'teams-test', '--headless'],
    ])

    releaseStart()
    const results = await Promise.allSettled([first, second])
    expect(results.filter(resultValue => resultValue.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(resultValue => resultValue.status === 'rejected')).toHaveLength(1)
    expect(results.find(resultValue => resultValue.status === 'rejected')).toMatchObject({
      reason: { error: { code: 'CONFLICT' } },
    })
    expect(calls).toHaveLength(2)
  })

  it('serializes navigation and destruction for one context', async () => {
    let releaseNavigate!: () => void
    const navigateReleased = new Promise<void>(resolve => {
      releaseNavigate = resolve
    })
    const calls: FixedProcessSpec[] = []
    const runner: FixedProcessRunner = async spec => {
      calls.push(spec)
      if (spec.argv[0] === 'daemon') {
        return result(JSON.stringify({ kind: 'result', cmd: 'daemon', result: { status: 'already_running' } }))
      }
      if (spec.argv[0] === 'start') {
        return result(JSON.stringify({ cmd: 'start', sessionId: 'camoufox-test', profile: 'teams-test', headless: true }))
      }
      if (spec.argv[0] === 'goto') {
        await navigateReleased
        return result(JSON.stringify({ cmd: 'goto', profile: 'teams-test', url: 'https://example.com', navigated: true }))
      }
      if (spec.argv[0] === 'stop') {
        return result(JSON.stringify({ cmd: 'stop', profile: 'teams-test', state: 'stopped' }))
      }
      throw new Error(`unexpected process call ${spec.argv.join(' ')}`)
    }
    const adapter = createBrowserCliAdapter({ executable: '/opt/homebrew/bin/camo', profile: 'teams-test', runner })
    const created = await adapter.contextCreate({ operation: 'context.create' })

    const navigated = adapter.navigate({ operation: 'navigate', contextId: created.contextId, url: 'https://example.com' })
    const destroyed = adapter.contextDestroy({ operation: 'context.destroy', contextId: created.contextId })
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(calls.map(call => call.argv)).toEqual([
      ['daemon', 'start', '--profile', 'teams-test'],
      ['start', '--profile', 'teams-test', '--headless'],
      ['goto', 'https://example.com', '--profile', 'teams-test', '--waitUntil', 'domcontentloaded'],
    ])

    releaseNavigate()
    await expect(navigated).resolves.toMatchObject({ navigated: true })
    await expect(destroyed).resolves.toMatchObject({ state: 'stopped' })
    expect(calls.at(-1)?.argv).toEqual(['stop', '--profile', 'teams-test'])
  })

  it('uses fixed JSON CLI commands and reuses one context across navigation and snapshots', async () => {
    const scripted = scriptedRunner([
      result(JSON.stringify({ kind: 'result', cmd: 'daemon', result: { status: 'already_running' } })),
      result(JSON.stringify({ cmd: 'start', sessionId: 'camoufox-test', profile: 'teams-test', headless: true })),
      result(JSON.stringify({ cmd: 'goto', profile: 'teams-test', url: 'https://example.com', navigated: true })),
      result(JSON.stringify({ cmd: 'snapshot', profile: 'teams-test', data: { url: 'https://example.com/', htmlLength: 14, html: '<h1>Example</h1>' } })),
      result(JSON.stringify({ cmd: 'stop', profile: 'teams-test', state: 'stopped' })),
    ])
    const adapter = createBrowserCliAdapter({
      executable: '/opt/homebrew/bin/camo',
      profile: 'teams-test',
      headless: true,
      runner: scripted.runner,
    })

    const created = await adapter.contextCreate({ operation: 'context.create' })
    const navigated = await adapter.navigate({ operation: 'navigate', contextId: created.contextId, url: 'https://example.com' })
    const snapshot = await adapter.snapshot({ operation: 'snapshot', contextId: created.contextId })
    const destroyed = await adapter.contextDestroy({ operation: 'context.destroy', contextId: created.contextId })

    expect(navigated).toMatchObject({ contextId: created.contextId, url: 'https://example.com', navigated: true })
    expect(snapshot).toMatchObject({ contextId: created.contextId, url: 'https://example.com/', html: '<h1>Example</h1>' })
    expect(destroyed).toMatchObject({ contextId: created.contextId, profile: 'teams-test', state: 'stopped' })
    expect(scripted.calls.map(call => call.argv)).toEqual([
      ['daemon', 'start', '--profile', 'teams-test'],
      ['start', '--profile', 'teams-test', '--headless'],
      ['goto', 'https://example.com', '--profile', 'teams-test', '--waitUntil', 'domcontentloaded'],
      ['snapshot', '--format', 'json', '--profile', 'teams-test'],
      ['stop', '--profile', 'teams-test'],
    ])
    expect(scripted.calls.every(call => call.shell === false)).toBe(true)
    expect(scripted.calls.every(call => call.stdin === undefined)).toBe(true)
  })

  it('keeps the context live when destruction is not confirmed', async () => {
    const scripted = scriptedRunner([
      result(JSON.stringify({ kind: 'result', cmd: 'daemon', result: { status: 'started' } })),
      result(JSON.stringify({ cmd: 'start', sessionId: 'camoufox-test', profile: 'teams-test', headless: true })),
      result('', 17, 'E_STATE_LOCKED'),
      result(JSON.stringify({ cmd: 'goto', profile: 'teams-test', url: 'https://example.com', navigated: true })),
    ])
    const adapter = createBrowserCliAdapter({ executable: '/opt/homebrew/bin/camo', profile: 'teams-test', runner: scripted.runner })
    const created = await adapter.contextCreate({ operation: 'context.create' })

    await expect(adapter.contextDestroy({ operation: 'context.destroy', contextId: created.contextId })).rejects.toMatchObject({
      error: { code: 'PROCESS_ERROR', exitCode: 17, stderr: 'E_STATE_LOCKED' },
    } satisfies Partial<CliAdapterError>)
    await expect(adapter.navigate({ operation: 'navigate', contextId: created.contextId, url: 'https://example.com' })).resolves.toMatchObject({ navigated: true })
  })

  it('retains a recoverable owner after context startup protocol failure', async () => {
    const scripted = scriptedRunner([
      result(JSON.stringify({ kind: 'result', cmd: 'daemon', result: { status: 'started' } })),
      result('{"cmd":"start"}'),
      result(JSON.stringify({ cmd: 'stop', profile: 'teams-test', state: 'stopped' })),
    ])
    const adapter = createBrowserCliAdapter({ executable: '/opt/homebrew/bin/camo', profile: 'teams-test', runner: scripted.runner })

    let failure: unknown
    try {
      await adapter.contextCreate({ operation: 'context.create' })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      error: { code: 'PROTOCOL_ERROR', contextId: expect.any(String) },
    })
    const contextId = (failure as CliAdapterError).error.contextId
    expect(contextId).toEqual(expect.any(String))
    await expect(adapter.contextCreate({ operation: 'context.create' })).rejects.toMatchObject({
      error: { code: 'CONFLICT', contextId },
    })
    await expect(adapter.contextDestroy({ operation: 'context.destroy', contextId: contextId as string })).resolves.toMatchObject({
      contextId,
      profile: 'teams-test',
      state: 'stopped',
    })
    expect(scripted.calls.map(call => call.argv)).toEqual([
      ['daemon', 'start', '--profile', 'teams-test'],
      ['start', '--profile', 'teams-test', '--headless'],
      ['stop', '--profile', 'teams-test'],
    ])
  })

  it('rejects invalid URLs and unknown context ids before spawning a process', async () => {
    const scripted = scriptedRunner([])
    const adapter = createBrowserCliAdapter({ executable: '/opt/homebrew/bin/camo', profile: 'teams-test', runner: scripted.runner })
    await expect(adapter.navigate({ operation: 'navigate', contextId: 'missing', url: 'file:///tmp/secret' })).rejects.toMatchObject({ error: { code: 'NOT_FOUND' } })
    await expect(adapter.contextCreate({ operation: 'context.create', initialUrl: 'file:///tmp/secret' })).rejects.toMatchObject({ error: { code: 'INVALID_INPUT' } })
    expect(scripted.calls).toHaveLength(0)
  })
})
