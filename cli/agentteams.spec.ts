import { createPrivateKey, X509Certificate } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { beforeAll, describe, expect, it } from 'vitest'
import { agentteamsCommand, DEFAULT_CONFIG_TEXT } from './agentteams.mjs'

const cliEntry = fileURLToPath(new URL('./agentteams.mjs', import.meta.url))
const rootDirectory = fileURLToPath(new URL('../', import.meta.url))
const execFileAsync = promisify(execFile)

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

  it('rejects the public bare work command before any launcher, socket or provider side effect', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-work-blocked-'))
    const configPath = '/tmp/agentteams-cli-work-blocked.toml'
    const env = {}
    const sideEffects: Array<readonly [string, unknown, unknown]> = []
    const runtime = {
      runLocalConfiguredWork: async (path, callEnv, options) => {
        sideEffects.push(['runLocalConfiguredWork', [path, callEnv, options], undefined])
        return { configPath: path, agentId: 'receiver', workId: 'configured-search', requestId: 'configured-search-1', state: 'succeeded' }
      },
    }
    await expect(agentteamsCommand(['work', '--config', configPath], { runtime, env })).rejects.toThrow(
      /work is not implemented yet: no public new-request entry exists/u,
    )
    expect(sideEffects).toEqual([])
    await rm(home, { recursive: true, force: true })
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

  it('rejects the real outside-cwd public bare work entry with a nonzero exit and no launcher', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-work-entry-home-'))
    const cwd = await mkdtemp(join(tmpdir(), 'agentteams-cli-work-entry-cwd-'))
    const before = existsSync(join(home, '.agentteams')) ? readdirSync(join(home, '.agentteams')) : []
    let code: number | undefined
    let stderr = ''
    try {
      try {
        await execFileAsync(process.execPath, [cliEntry, 'work'], {
          cwd,
          env: { ...process.env, HOME: home },
        })
      } catch (error) {
        const failure = error as { code?: number; stderr?: string }
        code = failure.code
        stderr = failure.stderr ?? ''
      }
      expect(code).not.toBe(0)
      expect(stderr).toContain('work is not implemented yet: no public new-request entry exists')
      expect(stderr).toContain('U4 local-work seam')
      const after = existsSync(join(home, '.agentteams')) ? readdirSync(join(home, '.agentteams')) : []
      expect(after).toEqual(before)
    } finally {
      await rm(home, { recursive: true, force: true })
      await rm(cwd, { recursive: true, force: true })
    }
  }, 30_000)

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
