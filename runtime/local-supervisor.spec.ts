import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createLocalSupervisor } from './local-supervisor.ts'
import { planLocalProcesses } from './local-supervisor.ts'
import type { LocalConfig } from './local-config.ts'

it('plans relay first, then only enabled independent daemons', () => {
  const config: LocalConfig = {
    version: 1,
    configPath: '/tmp/.agentteams/config.toml',
    relay: { enabled: true, configPath: '/tmp/.agentteams/relay.json' },
    daemons: [
      { id: 'browser', enabled: true, configPath: '/tmp/.agentteams/browser.json' },
      { id: 'disabled', enabled: false, configPath: '/tmp/.agentteams/disabled.json' },
      { id: 'worker', enabled: true, configPath: '/tmp/.agentteams/worker.json' },
    ],
  }
  expect(planLocalProcesses(config, { relayEntry: '/runtime/relay-process.js', agentEntry: '/runtime/agent-process.js', nodeExecutable: '/node' })).toEqual([
    { id: 'relay', kind: 'relay', entry: '/runtime/relay-process.js', args: ['--config', '/tmp/.agentteams/relay.json'] },
    { id: 'browser', kind: 'agent', entry: '/runtime/agent-process.js', args: ['--config', '/tmp/.agentteams/browser.json'] },
    { id: 'worker', kind: 'agent', entry: '/runtime/agent-process.js', args: ['--config', '/tmp/.agentteams/worker.json'] },
  ])
})

function config(root: string): LocalConfig {
  return {
    version: 1,
    configPath: join(root, 'config.toml'),
    relay: { enabled: true, configPath: join(root, 'relay.json') },
    daemons: [
      { id: 'browser', enabled: true, configPath: join(root, 'browser.json') },
      { id: 'disabled', enabled: false, configPath: join(root, 'disabled.json') },
      { id: 'worker', enabled: true, configPath: join(root, 'worker.json') },
    ],
  }
}

it('starts relay before enabled daemons and stops the owned children reentrantly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-supervisor-'))
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.send?.({kind:'daemon.registered'}); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    const supervisor = createLocalSupervisor(config(root), { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 2000, stopTimeoutMs: 2000 })
    await supervisor.start()
    expect(supervisor.state()).toBe('running')
    await Promise.all([supervisor.start(), supervisor.start()])
    await Promise.all([supervisor.stop(), supervisor.stop()])
    expect(supervisor.state()).toBe('stopped')
    await supervisor.start()
    expect(supervisor.state()).toBe('running')
    await supervisor.stop()
    expect(supervisor.state()).toBe('stopped')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('reports startup failure after cleaning only children it started', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-supervisor-fail-'))
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.stderr.write('agent failed\\n'); process.exit(3)\n")
    const supervisor = createLocalSupervisor(config(root), { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 2000, stopTimeoutMs: 2000 })
    await expect(supervisor.start()).rejects.toThrow(/exited before readiness/)
    expect(supervisor.state()).toBe('stopped')
    await supervisor.stop()
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('does not report running when a child exits immediately after readiness', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-supervisor-exit-'))
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setInterval(() => {}, 1000); process.once('SIGTERM', () => process.exit(0))\n")
    await writeFile(agent, "process.send?.({kind:'daemon.registered'}); setTimeout(() => process.exit(3), 50)\n")
    const supervisor = createLocalSupervisor(config(root), { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 2000, stopTimeoutMs: 2000 })
    await expect(supervisor.start()).rejects.toThrow(/exited unexpectedly|exited during startup/)
    expect(supervisor.state()).toBe('stopped')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('rejects startup when an earlier ready child exits during a later child startup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'teams-local-supervisor-startup-exit-'))
  try {
    const relay = join(root, 'relay.mjs')
    const agent = join(root, 'agent.mjs')
    await writeFile(relay, "console.log('relay listening wss://127.0.0.1:1'); setTimeout(() => process.exit(3), 20)\n")
    await writeFile(agent, "setTimeout(() => process.send?.({kind:'daemon.registered'}), 100); process.once('SIGTERM', () => process.exit(0))\n")
    const supervisor = createLocalSupervisor(config(root), { relayEntry: relay, agentEntry: agent, startupTimeoutMs: 1000, stopTimeoutMs: 1000 })
    await expect(supervisor.start()).rejects.toThrow(/exited unexpectedly|failed during startup/)
    expect(supervisor.state()).toBe('stopped')
  } finally { await rm(root, { recursive: true, force: true }) }
})
