import { createPrivateKey, X509Certificate } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { agentteamsCommand, DEFAULT_CONFIG_TEXT } from './agentteams.mjs'
import { readLocalInternalConfig, readLocalInternalWorkControl, writeLocalInternalLauncherState, writeLocalInternalWorkControl } from '../runtime/local-config.ts'
import type { LocalWorkControlRequest } from '../runtime/local-work-control.ts'
import { sendLocalWorkControlRequest } from '../runtime/local-work-control.ts'

const cliEntry = fileURLToPath(new URL('./agentteams.mjs', import.meta.url))
const rootDirectory = fileURLToPath(new URL('../', import.meta.url))
const execFileAsync = promisify(execFile)

async function initializeWorkCommandHome() {
  const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-work-'))
  const directory = join(home, '.agentteams')
  const configPath = join(directory, 'config.toml')
  const internalPath = join(directory, 'internal.toml')
  const generation = 7
  const startToken = 'work-command-token'
  const socketPath = join(directory, '.internal', 'work-control.sock')
  const receiverConfig = JSON.stringify({
    version: 1,
    endpoint: {
      role: 'receiver',
      connect: {
        targetAgentId: 'provider',
        capabilityId: 'file-search',
        capabilityVersion: '1',
        operation: 'search',
        demands: [{ resourceId: 'search-slot', amount: 1 }],
      },
      services: [],
    },
  })
  await mkdir(directory, { recursive: true })
  await writeFile(configPath, 'version = 3\n')
  await writeFile(internalPath, `version = 2

[launcher]
pid = 7101
generation = ${generation}
startToken = ${JSON.stringify(startToken)}
state = "running"

[daemon."receiver"]
enabled = true
role = "receiver"
config = ${JSON.stringify(receiverConfig)}
`)
  await writeLocalInternalWorkControl(internalPath, { socketPath, launcherGeneration: generation, launcherStartToken: startToken })
  return { home, configPath, internalPath, generation, startToken, socketPath }
}

function workCommandRuntime(frames: LocalWorkControlRequest[], statusGeneration = 7, capabilities?: readonly unknown[]) {
  return {
    localConfig: { readLocalInternalConfig, readLocalInternalWorkControl },
    statusLocalProcess: async () => ({
      state: 'running',
      generation: 7,
      endpoints: [{ agentId: 'provider', role: 'provider', presence: 'online', generation: statusGeneration, ...(capabilities === undefined ? {} : { capabilities }) }],
    }),
    localWorkControl: {
      sendLocalWorkControlRequest: async ({ frame }: { frame: LocalWorkControlRequest }) => {
        frames.push(frame)
        return {
          kind: 'work.result',
          requestId: frame.requestId,
          receipt: {
            status: 'completed',
            control: {
              projectId: 'agentteams-local-work',
              graphId: 'agentteams.test',
              graphVersion: '1',
              executionId: frame.control.executionId,
              attemptId: frame.control.attemptId,
              workId: frame.control.workId,
              requestId: frame.control.requestId,
            },
            ...('business' in frame ? { business: frame.business } : {}),
            cleanup: { channelsOpened: 0, channelsDisposed: 0 },
            evidence: {
              execution: 'completed',
              graphId: 'agentteams.test',
              graphVersion: '1',
              nodeSchedule: [],
              nodeCompletion: [],
              hostOperations: [],
            },
          },
        }
      },
    },
  }
}

describe('agentteams CLI', () => {
  beforeAll(async () => {
    await execFileAsync('pnpm', ['build:runtime'], {
      cwd: rootDirectory,
      env: process.env,
    })
  }, 60_000)

  it('init writes v3 user intent, runtime-owned TLS and internal v2 state, then refuses to overwrite it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-init-'))
    try {
      const output = await agentteamsCommand(['init'], { home })
      const configPath = join(home, '.agentteams', 'config.toml')
      expect(output).toContain(configPath)
      const text = await readFile(configPath, 'utf8')
      expect(text).toContain('version = 3')
      expect(text).toContain('[bridge]')
      expect(text).toContain('[agents.provider]')
      expect(text).toContain('[agents.receiver.connect]')
      expect(text).not.toContain('relay.json')
      expect(text).not.toContain('workId')
      expect(text).not.toContain('requestId')
      expect(text).not.toContain('payload')
      await expect(readFile(join(home, '.agentteams', 'relay.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      const tlsDirectory = join(home, '.agentteams', '.internal', 'tls')
      const keyText = await readFile(join(tlsDirectory, 'relay-key.pem'), 'utf8')
      const certText = await readFile(join(tlsDirectory, 'relay-cert.pem'), 'utf8')
      expect(() => createPrivateKey(keyText)).not.toThrow()
      expect(new X509Certificate(certText).subject).toContain('localhost')
      expect((await stat(join(tlsDirectory, 'relay-key.pem'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(tlsDirectory, 'relay-cert.pem'))).mode & 0o777).toBe(0o600)
      const internalText = await readFile(join(home, '.agentteams', 'internal.toml'), 'utf8')
      expect(internalText).toContain('version = 2')
      expect(internalText).toContain('sourceRevision = 1')
      expect(internalText).toContain('sourceHash = "sha256:')
      expect(internalText).toContain('[relay]')
      expect(internalText).toContain('[daemon."provider"]')
      expect(internalText).toContain('[configRuntime.accepted]')
      expect(internalText).toContain('[configRuntime.effective]')
      expect(internalText).toContain('[configRuntime.catalogs]')
      expect(internalText).toContain('AGENTTEAMS_PROVIDER_AUTH')
      expect(internalText).toContain('AGENTTEAMS_RECEIVER_AUTH')
      expect(internalText).toContain('projectionPath')
      await writeFile(configPath, 'sentinel\n', { flag: 'w' })
      await expect(agentteamsCommand(['init'], { home })).rejects.toThrow(/already exists/i)
      expect(await readFile(configPath, 'utf8')).toBe('sentinel\n')
      expect(await readFile(join(tlsDirectory, 'relay-key.pem'), 'utf8')).toBe(keyText)
      expect(await readFile(join(tlsDirectory, 'relay-cert.pem'), 'utf8')).toBe(certText)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('fails init explicitly before creating config when local bridge TLS material is incomplete', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-init-tls-'))
    try {
      const directory = join(home, '.agentteams')
      const tlsDirectory = join(directory, '.internal', 'tls')
      await mkdir(tlsDirectory, { recursive: true, mode: 0o700 })
      await writeFile(join(tlsDirectory, 'relay-key.pem'), 'sentinel\n', { flag: 'w', encoding: 'utf8', mode: 0o600 })
      await expect(agentteamsCommand(['init'], { home })).rejects.toThrow(/TLS material is incomplete/i)
      expect(await readFile(join(tlsDirectory, 'relay-key.pem'), 'utf8')).toBe('sentinel\n')
      await expect(readFile(join(directory, 'config.toml'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(readFile(join(directory, 'relay.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not overwrite a config created by a concurrent init', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-init-race-'))
    try {
      const configPath = join(home, '.agentteams', 'config.toml')
      const results = await Promise.allSettled([
        agentteamsCommand(['init'], { home, configText: DEFAULT_CONFIG_TEXT.replace('version = 3', '# winner = "a"\nversion = 3') }),
        agentteamsCommand(['init'], { home, configText: DEFAULT_CONFIG_TEXT.replace('version = 3', '# winner = "b"\nversion = 3') }),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      const rejected = results.find(result => result.status === 'rejected')
      expect(rejected?.status === 'rejected' ? rejected.reason.message : '').toMatch(/already exists/i)
      const text = await readFile(configPath, 'utf8')
      expect([text.includes('winner = "a"'), text.includes('winner = "b"')].filter(Boolean)).toHaveLength(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not create or overwrite an editable relay config', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-init-relay-'))
    try {
      const directory = join(home, '.agentteams')
      await mkdir(directory, { recursive: true })
      const relaySentinel = `${JSON.stringify({ version: 1, listen: { host: '127.0.0.1', port: 48010 }, sentinel: true })}\n`
      await writeFile(join(directory, 'relay.json'), relaySentinel, { flag: 'w', encoding: 'utf8' })
      await agentteamsCommand(['init'], { home })
      expect(await readFile(join(directory, 'relay.json'), 'utf8')).toBe(relaySentinel)
      expect(await readFile(join(directory, 'config.toml'), 'utf8')).toContain('version = 3')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('routes start/status/stop arguments to the runtime local launcher owner', async () => {
    const calls = []
    const configPath = '/tmp/agentteams-cli-config.toml'
    const runtime = {
      startLocalProcess: async (path, options) => {
        calls.push({ kind: 'start', path, options })
        return { configPath: path, internalPath: '/tmp/internal.toml', pid: 12, generation: 6, state: 'running' }
      },
      statusLocalProcess: async path => {
        calls.push({ kind: 'status', path })
        return { configPath: path, internalPath: '/tmp/internal.toml', pid: 12, generation: 6, state: 'running' }
      },
      stopLocalProcess: async (path, generation) => {
        calls.push({ kind: 'stop', path, generation })
        return { configPath: path, internalPath: '/tmp/internal.toml', generation, state: 'stopped' }
      },
    }

    const env = {}
    expect(await agentteamsCommand(['start', '--config', configPath], { runtime, env })).toContain('state=running generation=6')
    expect(await agentteamsCommand(['status', '--config', configPath], { runtime })).toContain('state=running')
    expect(await agentteamsCommand(['stop', '--config', configPath, '--generation', '3'], { runtime })).toContain('state=stopped')

    expect(calls.map(call => [call.kind, call.path, call.generation])).toEqual([
      ['start', configPath, undefined],
      ['status', configPath, undefined],
      ['stop', configPath, 3],
    ])
    expect(calls[0].options.env).toMatchObject({ AGENTTEAMS_PROVIDER_AUTH: 'local-provider', AGENTTEAMS_RECEIVER_AUTH: 'local-receiver' })
    expect(calls[0].options.relayEntry).toMatch(/relay-process\.js$/)
    expect(calls[0].options.agentEntry).toMatch(/agent-process\.js$/)
  })

  it('builds service-only public Work frames with explicit receiver and fresh identities', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    const runtime = workCommandRuntime(frames)
    try {
      await agentteamsCommand(['work', 'submit', '--config', context.configPath, '--receiver', 'receiver', '--payload', '{"query":"needle"}'], { runtime })
      await agentteamsCommand(['work', 'submit', '--config', context.configPath, '--receiver', 'receiver', '--payload', '{"query":"needle"}'], { runtime })
      await agentteamsCommand(['work', 'query', '--config', context.configPath, '--receiver', 'receiver', '--work-id', 'work-original', '--request-id', 'request-original'], { runtime })
      await agentteamsCommand(['work', 'query', '--config', context.configPath, '--receiver', 'receiver', '--service-selection', 'capability', '--work-id', 'work-original', '--request-id', 'request-original', '--provider', 'provider', '--provider-generation', '7', '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search', '--link-generation', '8'], { runtime })
      await agentteamsCommand(['work', 'open', '--config', context.configPath, '--receiver', 'receiver', '--provider', 'provider', '--provider-generation', '7', '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search', '--demands', '[{"resourceId":"search-slot","amount":1}]', '--payload', 'null'], { runtime })
      await agentteamsCommand(['work', 'request', '--config', context.configPath, '--receiver', 'receiver', '--work-id', 'work-1', '--provider', 'provider', '--provider-generation', '7', '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search', '--demands', '[{"resourceId":"search-slot","amount":1}]', '--payload', '{"contextId":"ctx"}'], { runtime })
      await agentteamsCommand(['work', 'close', '--config', context.configPath, '--receiver', 'receiver', '--work-id', 'work-1', '--provider', 'provider', '--provider-generation', '7', '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search'], { runtime })

      expect(frames.map(frame => frame.kind)).toEqual([
        'work.submit', 'work.submit', 'work.query', 'work.query', 'work.open', 'work.request', 'work.close',
      ])
      const [firstSubmit, secondSubmit, endpointQuery, capabilityQuery, open, request, close] = frames
      expect(firstSubmit!.control).toMatchObject({ receiverAgentId: 'receiver', expectedLauncherGeneration: 7, startToken: context.startToken })
      expect(firstSubmit!.control.workId).not.toBe(secondSubmit!.control.workId)
      expect(firstSubmit!.requestId).not.toBe(secondSubmit!.requestId)
      expect(firstSubmit).toMatchObject({ business: { query: 'needle' } })
      expect(endpointQuery).toMatchObject({ control: { serviceSelection: 'endpoint', workId: 'work-original', requestId: 'request-original' } })
      expect(capabilityQuery).toMatchObject({
        control: {
          serviceSelection: 'capability', workId: 'work-original', requestId: 'request-original',
          targetAgentId: 'provider', targetGeneration: 7, linkGeneration: 8,
          capabilityId: 'file-search', capabilityVersion: '1', operation: 'search',
        },
      })
      expect(open).toMatchObject({
        control: { targetAgentId: 'provider', targetGeneration: 7, capabilityId: 'file-search', capabilityVersion: '1', operation: 'search' },
        business: null,
      })
      expect(request).toMatchObject({ control: { workId: 'work-1', targetAgentId: 'provider', targetGeneration: 7 }, business: { contextId: 'ctx' } })
      expect(close).toMatchObject({ control: { workId: 'work-1', targetAgentId: 'provider', targetGeneration: 7, operation: 'search' } })
      expect(close).not.toHaveProperty('business')
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('retains an arbitrary JSON payload without rewriting it', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    try {
      await agentteamsCommand(['work', 'submit', '--config', context.configPath, '--receiver', 'receiver', '--payload', '[1,{"nested":true}]'], { runtime: workCommandRuntime(frames) })
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ business: [1, { nested: true }] })
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('requires explicit demands and sends no frame when the selected capability declares a resource', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    const runtime = workCommandRuntime(frames, 7, [
      { capabilityId: 'file-search', version: '1', operations: ['search'], resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }] },
    ])
    try {
      await expect(agentteamsCommand(['work', 'open', '--config', context.configPath, '--receiver', 'receiver', '--provider', 'provider', '--provider-generation', '7', '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search', '--payload', 'null'], { runtime }))
        .rejects.toThrow(/requires --demands for search-slot/)
      await expect(agentteamsCommand(['work', 'request', '--config', context.configPath, '--receiver', 'receiver', '--work-id', 'work-1', '--provider', 'provider', '--provider-generation', '7', '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search', '--payload', 'null'], { runtime }))
        .rejects.toThrow(/requires --demands for search-slot/)
      expect(frames).toHaveLength(0)
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('sends the exact empty demand set only for a capability that declares no resource', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    const runtime = workCommandRuntime(frames, 7, [
      { capabilityId: 'file-search', version: '1', operations: ['search'], resources: [] },
    ])
    try {
      await agentteamsCommand(['work', 'open', '--config', context.configPath, '--receiver', 'receiver', '--provider', 'provider', '--provider-generation', '7', '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search', '--payload', 'null'], { runtime })
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ kind: 'work.open', control: { demands: [] } })
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('fixes the open target generation from the typed status projection before dispatch', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    try {
      await agentteamsCommand(['work', 'open', '--config', context.configPath, '--receiver', 'receiver',
        '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search',
        '--demands', '[{"resourceId":"search-slot","amount":1}]', '--payload', '{"query":"needle"}'], { runtime: workCommandRuntime(frames, 11) })
      expect(frames).toHaveLength(1)
      expect(frames[0]).toMatchObject({ kind: 'work.open', control: {
        targetAgentId: 'provider', targetGeneration: 11, capabilityId: 'file-search', capabilityVersion: '1', operation: 'search',
      } })
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('refuses an open with neither an explicit generation nor a published provider projection', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    const runtime = workCommandRuntime(frames)
    runtime.statusLocalProcess = async () => ({ state: 'running', generation: 7, endpoints: [] })
    try {
      const failure = await agentteamsCommand(['work', 'open', '--config', context.configPath, '--receiver', 'receiver',
        '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search', '--payload', '{}'], { runtime })
        .catch((error: Error) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).toContain('work open requires --provider-generation or a published status projection for provider provider')
      expect(frames).toHaveLength(0)
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('requires the original explicit binding for request and close even when connect declares it', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    const runtime = workCommandRuntime(frames)
    // The receiver's connect intent declares provider/file-search/1/search, so a
    // connect-derived binding would silently succeed here. request/close must not
    // fall back to it.
    const bindings: Array<[string, string]> = [
      ['--provider', 'provider'],
      ['--provider-generation', '7'],
      ['--capability-id', 'file-search'],
      ['--capability-version', '1'],
      ['--operation', 'search'],
    ]
    try {
      for (const subcommand of ['request', 'close']) {
        for (const omitted of bindings) {
          const argv = ['work', subcommand, '--config', context.configPath, '--receiver', 'receiver', '--work-id', 'work-1']
          for (const [flag, value] of bindings) {
            if (flag === omitted[0]) continue
            argv.push(flag, value)
          }
          const failure = await agentteamsCommand(argv, { runtime }).catch((error: Error) => error)
          expect(failure, `${subcommand} without ${omitted[0]} must fail`).toBeInstanceOf(Error)
          expect(failure.message).toContain(`${omitted[0]} is required for work ${subcommand}`)
        }
      }
      expect(frames).toHaveLength(0)
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('keeps request and close on an explicit provider generation', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    const runtime = workCommandRuntime(frames)
    try {
      for (const subcommand of ['request', 'close']) {
        const failure = await agentteamsCommand(['work', subcommand, '--config', context.configPath, '--receiver', 'receiver',
          '--work-id', 'work-1', '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search'], { runtime })
          .catch((error: Error) => error)
        expect(failure).toBeInstanceOf(Error)
        expect(failure.message).toContain('is required')
        expect(failure.message).not.toContain(context.configPath)
      }
      expect(frames).toHaveLength(0)
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('preserves the generated identity and fixed binding when the local dispatch is unconfirmed', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    const runtime = workCommandRuntime(frames)
    runtime.localWorkControl.sendLocalWorkControlRequest = async ({ frame }: { frame: LocalWorkControlRequest }) => {
      frames.push(frame)
      throw new Error('local Work control socket is unavailable: connection reset')
    }
    try {
      for (const subcommand of ['open', 'request', 'close']) {
        const failure = await agentteamsCommand(['work', subcommand, '--config', context.configPath, '--receiver', 'receiver',
          '--work-id', 'work-1', '--provider', 'provider', '--provider-generation', '7',
          '--capability-id', 'file-search', '--capability-version', '1', '--operation', 'search',
          ...(subcommand === 'close' ? [] : ['--demands', '[{"resourceId":"search-slot","amount":1}]', '--payload', '{}'])], { runtime })
          .catch((error: Error) => error)
        expect(failure, `${subcommand} must fail`).toBeInstanceOf(Error)
        const receipt = JSON.parse(failure.message)
        const frame = frames.at(-1)!
        expect(receipt.status).toBe('failed')
        expect(receipt.control.deliveryState).toBe('unconfirmed')
        expect(receipt.control.error.code).toBe('LOCAL_CONTROL_UNAVAILABLE')
        expect(receipt.control.workId).toBe(frame.control.workId)
        expect(receipt.control.requestId).toBe(frame.control.requestId)
        expect(receipt.control.executionId).toBe(frame.control.executionId)
        expect(receipt.control.attemptId).toBe(frame.control.attemptId)
        expect(receipt.control.providerAgentId).toBe('provider')
        expect(receipt.control.targetGeneration).toBe(7)
        expect(receipt.control.capabilityId).toBe('file-search')
        expect(receipt.control.capabilityVersion).toBe('1')
        expect(receipt.control.operation).toBe('search')
      }
      expect(frames).toHaveLength(3)
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('preserves the generated identity and fixed binding on a receiver error reply', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    const runtime = workCommandRuntime(frames)
    let code = 'HOST_PROTOCOL'
    runtime.localWorkControl.sendLocalWorkControlRequest = async ({ frame }: { frame: LocalWorkControlRequest }) => {
      frames.push(frame)
      return { kind: 'work.error', requestId: frame.requestId, error: { code, message: `reply rejected with ${code}` } }
    }
    try {
      const confirm = async (expectedDeliveryState: string | undefined) => {
        const failure = await agentteamsCommand(['work', 'open', '--config', context.configPath, '--receiver', 'receiver',
          '--provider', 'provider', '--provider-generation', '7', '--capability-id', 'file-search',
          '--capability-version', '1', '--operation', 'search', '--demands', '[{"resourceId":"search-slot","amount":1}]', '--payload', '{}'], { runtime })
          .catch((error: Error) => error)
        const receipt = JSON.parse(failure.message)
        const frame = frames.at(-1)!
        expect(receipt.status).toBe('failed')
        expect(receipt.control.deliveryState).toBe(expectedDeliveryState)
        expect(receipt.control.error.code).toBe(code)
        expect(receipt.control.workId).toBe(frame.control.workId)
        expect(receipt.control.providerAgentId).toBe('provider')
        expect(receipt.control.targetGeneration).toBe(7)
        expect(receipt.control.capabilityId).toBe('file-search')
        expect(receipt.control.operation).toBe('search')
      }
      await confirm('unconfirmed')
      code = 'STALE_GENERATION'
      await confirm(undefined)
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('sends Work requests from the public CLI through the local control socket client', async () => {
    const context = await initializeWorkCommandHome()
    try {
      const failure = await agentteamsCommand(['work', 'submit', '--config', context.configPath, '--receiver', 'receiver', '--payload', '{"query":"socket"}'], {
        runtime: {
          localConfig: { readLocalInternalConfig, readLocalInternalWorkControl },
          localWorkControl: { sendLocalWorkControlRequest },
          startLocalProcess: undefined,
        },
      }).catch(error => error as Error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).toContain('local Work control socket is unavailable')
      expect(failure.message).toContain(context.socketPath)
    } finally { await rm(context.home, { recursive: true, force: true }) }
  })

  it('reports a failed Work receipt as an error while preserving its complete identity', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    const runtime = workCommandRuntime(frames)
    const send = runtime.localWorkControl.sendLocalWorkControlRequest
    let failedReceipt: unknown
    runtime.localWorkControl.sendLocalWorkControlRequest = async input => {
      const reply = await send(input)
      failedReceipt = { ...reply.receipt, status: 'failed', control: {
        ...reply.receipt.control,
        error: { code: 'DAGPIPE_RUNNER_MISSING', message: 'installed runner is absent' },
      } }
      return { ...reply, receipt: failedReceipt } as typeof reply
    }
    try {
      const command = agentteamsCommand(['work', 'submit', '--config', context.configPath,
        '--receiver', 'receiver', '--work-id', 'failed-work', '--request-id', 'failed-request',
        '--payload', '{}'], { runtime })
      const failure = await command.catch((error: Error) => error)
      expect(failure).toBeInstanceOf(Error)
      expect(failure.message).toBe(JSON.stringify(failedReceipt))
      expect(frames).toHaveLength(1)
      expect(JSON.parse(failure.message)).toMatchObject({ status: 'failed',
        control: { workId: 'failed-work', requestId: 'failed-request',
          executionId: frames[0].control.executionId, attemptId: frames[0].control.attemptId } })
    } finally { await rm(context.home, { recursive: true, force: true }) }
  })

  it('rejects malformed Work inputs and config before dispatch', async () => {
    const context = await initializeWorkCommandHome()
    const frames: LocalWorkControlRequest[] = []
    const runtime = workCommandRuntime(frames)
    try {
      await expect(agentteamsCommand(['work', 'submit', '--config', context.configPath, '--receiver', 'receiver', '--payload', '{'], { runtime })).rejects.toThrow(/--payload must be valid JSON/)
      await expect(agentteamsCommand(['work', 'submit', '--config', context.configPath, '--receiver', 'receiver'], { runtime })).rejects.toThrow(/--payload is required/)
      await expect(agentteamsCommand(['work', 'query', '--config', context.configPath, '--receiver', 'receiver', '--work-id', 'work-1'], { runtime })).rejects.toThrow(/work query requires --work-id and --request-id/)
      await expect(agentteamsCommand(['work', 'submit', '--config', context.configPath, '--receiver', 'missing', '--payload', '{}'], { runtime })).rejects.toThrow(/receiver missing is not an available Work receiver/)
      await expect(agentteamsCommand(['work', 'submit', '--config', join(context.home, 'missing.toml'), '--receiver', 'receiver', '--payload', '{}'], { runtime })).rejects.toThrow(/local Work control is unavailable/)
      expect(frames).toEqual([])

      await writeLocalInternalLauncherState(context.internalPath, { pid: 7102, generation: 8, startToken: 'replacement-token', state: 'running' })
      await expect(agentteamsCommand(['work', 'submit', '--config', context.configPath, '--receiver', 'receiver', '--payload', '{}'], { runtime })).rejects.toThrow(/workControl.launcherGeneration must exactly match launcher.generation/)
      expect(frames).toEqual([])
    } finally {
      await rm(context.home, { recursive: true, force: true })
    }
  })

  it('formats the authoritative endpoint status projection without reconstructing it from config', async () => {
    const status = {
      configPath: '/tmp/agentteams-cli-config.toml',
      internalPath: '/tmp/internal.toml',
      pid: 12,
      generation: 6,
      state: 'running',
      endpoints: [
        {
          agentId: 'provider',
          identity: { hostId: 'local', machineId: 'agentteams', agentId: 'provider', accountId: 'local', agentKind: 'custom', label: 'Provider' },
          role: 'provider',
          presence: 'online',
          state: 'online',
          generation: 1,
          capabilities: [
            { capabilityId: 'file-search', version: '1', operations: ['search'], resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot' }] },
            { capabilityId: 'browser', version: '1', operations: ['navigate'], resources: [{ resourceId: 'browser-context', capacity: 1, unit: 'context' }] },
          ],
        },
        {
          agentId: 'receiver',
          identity: { hostId: 'local', machineId: 'agentteams', agentId: 'receiver', accountId: 'local', agentKind: 'custom', label: 'Receiver' },
          role: 'receiver',
          presence: 'offline',
          state: 'stopped',
          generation: 1,
          capabilities: [],
        },
      ],
    }
    const runtime = {
      statusLocalProcess: async () => status,
    }

    const output = await agentteamsCommand(['status', '--config', status.configPath], { runtime })
    expect(output).toContain('status state=running generation=6')
    expect(output).toContain('endpoint=provider identity=local/agentteams/provider/local/custom/Provider role=provider presence=online generation=1')
    expect(output).toContain('capabilities=file-search@1:search[search-slot:2:slot],browser@1:navigate[browser-context:1:context]')
    expect(output).toContain('endpoint=receiver identity=local/agentteams/receiver/local/custom/Receiver role=receiver presence=offline generation=1')
    expect(output).toContain('capabilities=-')
  })

  it('shows missing and malformed endpoint projections explicitly', async () => {
    const configPath = '/tmp/agentteams-cli-config.toml'
    const missing = await agentteamsCommand(['status', '--config', configPath], {
      runtime: {
        statusLocalProcess: async () => ({ configPath, internalPath: '/tmp/internal.toml', generation: 0, state: 'stopped' }),
      },
    })
    expect(missing).toContain('endpoints=missing')

    const malformed = await agentteamsCommand(['status', '--config', configPath], {
      runtime: {
        statusLocalProcess: async () => ({
          configPath,
          internalPath: '/tmp/internal.toml',
          generation: 1,
          state: 'running',
          endpoints: [{ agentId: 'provider', role: 'provider', presence: 'online' }],
        }),
      },
    })
    expect(malformed).toContain('endpoint=provider projection=malformed')
  })

  it('direct node entry avoids source TS parameter properties and writes internal v2 from built runtime artifacts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-entry-'))
    const runCli = async (...args: string[]) => await execFileAsync(process.execPath, [cliEntry, ...args], {
      cwd: rootDirectory,
      env: { ...process.env, HOME: home },
    })
    try {
      const result = await runCli('init')
      expect(result.stdout).toContain('initialized')
      const internalText = await readFile(join(home, '.agentteams', 'internal.toml'), 'utf8')
      expect(internalText).toContain('version = 2')
      expect(internalText).toContain('[relay]')
      expect((await runCli('status')).stdout).toContain('status state=stopped generation=0')
      await expect(runCli('init')).rejects.toThrow(/already exists/i)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 60_000)

  it('surfaces explicit parsing and runtime errors', async () => {
    await expect(agentteamsCommand([])).rejects.toThrow(/usage:/i)
    await expect(agentteamsCommand(['unknown'])).rejects.toThrow(/unknown command/i)
    await expect(agentteamsCommand(['start', '--config'])).rejects.toThrow(/--config requires/i)
    await expect(agentteamsCommand(['stop', '--generation', 'abc', '--config', '/tmp/x.toml'], {
      runtime: { stopLocalProcess: async () => ({}) },
    })).rejects.toThrow(/generation must be/i)
    await expect(agentteamsCommand(['status', '--config', '/tmp/missing.toml'], {
      runtime: {
        statusLocalProcess: async () => {
          throw new Error('local config cannot be read: /tmp/missing.toml')
        },
      },
    })).rejects.toThrow(/local config cannot be read/i)
  })
})
