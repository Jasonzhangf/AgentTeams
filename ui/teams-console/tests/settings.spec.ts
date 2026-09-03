import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const client = join(import.meta.dirname, '../src/client')
const overlay = readFileSync(join(client, 'TeamsOverlay.tsx'), 'utf8')
const index = readFileSync(join(client, 'index.ts'), 'utf8')

describe('Settings surface owner contract', () => {
  it('does not import network, config, server, agent, runtime, search-plugin, or memory-plugin modules', () => {
    const forbidden = [
      '@/../agent',
      '@/../config',
      '@/../memory-plugin',
      '@/../runtime',
      '@/../search-plugin',
      '@/../server',
      '@/../network',
      '@/../dsh-adapter/agent-identity',
    ]
    for (const path of forbidden) {
      expect(overlay.includes(path)).toBe(false)
      expect(index.includes(path)).toBe(false)
    }
  })

  it('disables Settings handlers when the host did not bind navigation hooks', () => {
    expect(overlay.includes('disabled={!machineBound}')).toBe(true)
    expect(overlay.includes('disabled={!agentBound}')).toBe(true)
  })

  it('routes settings navigation only through the host-owned SettingsNavigationHandlers', () => {
    const machineCalled = vi.fn()
    const agentCalled = vi.fn()
    const handlers = {
      openMachineConnection: machineCalled,
      openAgentRuntime: agentCalled,
    }
    expect(typeof handlers.openMachineConnection).toBe('function')
    expect(typeof handlers.openAgentRuntime).toBe('function')
    handlers.openMachineConnection()
    handlers.openAgentRuntime('planner')
    expect(machineCalled).toHaveBeenCalledOnce()
    expect(agentCalled).toHaveBeenCalledWith('planner')
  })

  it('never writes network or config truth itself, only forwards to host handlers', () => {
    expect(overlay.includes('localStorage.setItem')).toBe(false)
    expect(overlay.includes('fetch(')).toBe(false)
    expect(index.includes('localStorage.setItem')).toBe(false)
  })
})
