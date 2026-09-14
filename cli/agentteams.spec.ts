import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { agentteamsCommand, DEFAULT_RELAY_CONFIG_TEXT } from './agentteams.mjs'

describe('agentteams CLI', () => {
  it('init writes the default user config and refuses to overwrite it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-init-'))
    try {
      const output = await agentteamsCommand(['init'], { home })
      const configPath = join(home, '.agentteams', 'config.toml')
      expect(output).toContain(configPath)
      const text = await readFile(configPath, 'utf8')
      expect(text).toContain('version = 2')
      expect(text).toContain('[endpoints.provider]')
      expect(text).toContain('[endpoints.receiver.connect]')
      const relayText = await readFile(join(home, '.agentteams', 'relay.json'), 'utf8')
      expect(relayText).toBe(DEFAULT_RELAY_CONFIG_TEXT)
      expect(relayText).not.toContain('pid')
      expect(relayText).not.toContain('internal.toml')
      await writeFile(configPath, 'sentinel\n', { flag: 'w' })
      await expect(agentteamsCommand(['init'], { home })).rejects.toThrow(/already exists/i)
      expect(await readFile(configPath, 'utf8')).toBe('sentinel\n')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not overwrite a config created by a concurrent init', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-init-race-'))
    try {
      const configPath = join(home, '.agentteams', 'config.toml')
      const results = await Promise.allSettled([
        agentteamsCommand(['init'], { home, configText: 'winner = "a"\n' }),
        agentteamsCommand(['init'], { home, configText: 'winner = "b"\n' }),
      ])
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
      const rejected = results.find(result => result.status === 'rejected')
      expect(rejected?.status === 'rejected' ? rejected.reason.message : '').toMatch(/already exists/i)
      expect(['winner = "a"\n', 'winner = "b"\n']).toContain(await readFile(configPath, 'utf8'))
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not overwrite a relay config that already exists', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agentteams-cli-init-relay-'))
    try {
      const directory = join(home, '.agentteams')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'relay.json'), 'sentinel\n', { flag: 'w', encoding: 'utf8' })
      await agentteamsCommand(['init'], { home })
      expect(await readFile(join(directory, 'relay.json'), 'utf8')).toBe('sentinel\n')
      expect(await readFile(join(directory, 'config.toml'), 'utf8')).toContain('version = 2')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('routes start/status/work/stop arguments to the runtime local launcher owner', async () => {
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
      runLocalConfiguredWork: async (path, env, options) => {
        calls.push({ kind: 'work', path, env, options })
        return { configPath: path, agentId: 'receiver', workId: 'configured-search', requestId: 'configured-search-1', state: 'succeeded' }
      },
    }

    const env = {}
    expect(await agentteamsCommand(['start', '--config', configPath], { runtime, env })).toContain('state=running generation=6')
    expect(await agentteamsCommand(['status', '--config', configPath], { runtime })).toContain('state=running')
    expect(await agentteamsCommand(['stop', '--config', configPath, '--generation', '3'], { runtime })).toContain('state=stopped')
    expect(await agentteamsCommand(['work', '--config', configPath], { runtime, env })).toContain('agent=receiver work=configured-search')

    expect(calls.map(call => [call.kind, call.path, call.generation])).toEqual([
      ['start', configPath, undefined],
      ['status', configPath, undefined],
      ['stop', configPath, 3],
      ['work', configPath, undefined],
    ])
    expect(calls[0].options.env).toMatchObject({ AGENTTEAMS_PROVIDER_AUTH: 'local-provider', AGENTTEAMS_RECEIVER_AUTH: 'local-receiver' })
    expect(calls[0].options.relayEntry).toMatch(/relay-process\.ts$/)
    expect(calls[0].options.agentEntry).toMatch(/agent-process\.ts$/)
    expect(calls[3].env).toMatchObject({ AGENTTEAMS_PROVIDER_AUTH: 'local-provider', AGENTTEAMS_RECEIVER_AUTH: 'local-receiver' })
    expect(calls[3].options.relayEntry).toMatch(/relay-process\.ts$/)
    expect(calls[3].options.agentEntry).toMatch(/agent-process\.ts$/)
    expect(calls[0].options.relayEntry).toBe(calls[3].options.relayEntry)
    expect(calls[0].options.agentEntry).toBe(calls[3].options.agentEntry)
  })

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
