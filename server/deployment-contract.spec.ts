import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const deployDirectory = resolve(import.meta.dirname, 'deploy')

async function readDeployFile(name: string): Promise<string> {
  return readFile(resolve(deployDirectory, name), 'utf8')
}

describe('N1 relay deployment contract', () => {
  it('declares the existing relay process entrypoint and signal lifecycle', async () => {
    const unit = await readDeployFile('agentteams-relay.service')

    expect(unit).toContain('WorkingDirectory=/opt/agentteams')
    expect(unit).toContain('EnvironmentFile=/etc/agentteams/relay.env')
    expect(unit).toContain(
      'ExecStart=/usr/bin/node /opt/agentteams/runtime/server/relay-process.js --config /etc/agentteams/relay.json',
    )
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('KillSignal=SIGTERM')
    expect(unit).toContain('TimeoutStopSec=30s')
  })

  it('binds the service to the compiled artifact staging contract', async () => {
    const unit = await readDeployFile('agentteams-relay.service')
    const installer = await readDeployFile('install-relay.sh')

    expect(unit).toContain('/opt/agentteams/runtime/server/relay-process.js')
    expect(unit).not.toContain('/opt/agentteams/server/relay-process.ts')
    expect(installer).toContain('runtime/server/relay-process.js')
    expect(installer).toContain('pnpm install --prod --ignore-scripts')
  })

  it('keeps the example config strict and free of credential values', async () => {
    const configText = await readDeployFile('relay.example.json')
    const config = JSON.parse(configText) as Record<string, unknown>
    const credentials = config.credentials as Array<Record<string, unknown>>
    const tls = config.tls as Record<string, unknown>
    const credential = credentials[0]

    expect(Object.keys(config).sort()).toEqual(['credentials', 'limits', 'listen', 'tls', 'version'])
    expect(config.version).toBe(1)
    expect(tls).toEqual({
      keyFile: '/etc/agentteams/tls/relay-key.pem',
      certFile: '/etc/agentteams/tls/relay-cert.pem',
    })
    expect(credential).toEqual({
      credentialEnv: 'TEAMS_RELAY_AGENT_A',
      identity: {
        accountId: 'example-account',
        scopeId: 'example-scope',
        agentId: 'example-agent-a',
      },
    })
    expect(configText).not.toMatch(/Bearer\s+[A-Za-z0-9._~-]{8,}/)
  })

  it('binds the example credential name to the EnvironmentFile example', async () => {
    const configText = await readDeployFile('relay.example.json')
    const environmentText = await readDeployFile('relay.env.example')

    expect(configText).toContain('"credentialEnv": "TEAMS_RELAY_AGENT_A"')
    expect(environmentText).toContain('TEAMS_RELAY_AGENT_A=Bearer REPLACE_WITH_AGENT_CREDENTIAL')
    expect(environmentText).toContain('exact HTTP Authorization header')
  })
})
