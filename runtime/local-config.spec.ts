import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { defaultLocalConfigPath, loadLocalConfig, writeLocalConfig } from './local-config.ts'

it('loads a persisted TOML launcher config and resolves paths relative to the file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-local-config-'))
  const path = join(directory, '.agentteams', 'config.toml')
  try {
    await writeLocalConfig(path, `version = 1

[relay]
config = "relay.json"
enabled = true

[daemons.browser]
config = "daemons/browser.json"
enabled = true

[daemons.worker]
config = "daemons/worker.json"
enabled = false
`)
    const loaded = await loadLocalConfig(path)
    expect(loaded).toEqual({
      version: 1,
      configPath: path,
      relay: { enabled: true, configPath: join(directory, '.agentteams', 'relay.json') },
      daemons: [
        { id: 'browser', enabled: true, configPath: join(directory, '.agentteams', 'daemons/browser.json') },
        { id: 'worker', enabled: false, configPath: join(directory, '.agentteams', 'daemons/worker.json') },
      ],
    })
    expect(await readFile(path, 'utf8')).toContain('[daemons.browser]')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('uses ~/.agentteams/config.toml as the stable default without creating it during read', () => {
  expect(defaultLocalConfigPath('/tmp/teams-home')).toBe('/tmp/teams-home/.agentteams/config.toml')
})

it('rejects a launcher config with no enabled daemon or unknown fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-local-config-invalid-'))
  const path = join(directory, 'config.toml')
  try {
    await writeLocalConfig(path, 'version = 1\nunknown = true\n[relay]\nconfig = "relay.json"\n[daemons.one]\nconfig = "one.json"\nenabled = false\n')
    await expect(loadLocalConfig(path)).rejects.toThrow(/unknown|enabled daemon/i)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

it('rejects the reserved relay daemon id before process planning can overwrite ownership', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'teams-local-config-reserved-'))
  const path = join(directory, 'config.toml')
  try {
    await writeLocalConfig(path, 'version = 1\n[relay]\nconfig = "relay.json"\n[daemons.relay]\nconfig = "relay-agent.json"\n')
    await expect(loadLocalConfig(path)).rejects.toThrow(/reserved.*Relay/i)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
