import { describe, expect, it } from 'vitest'
import { advanceRuntimeLifecycle, startDaemonRuntime, startDaemonRuntimeWithCapability, stopDaemonRuntime } from './daemon-runtime.ts'
import { publishRuntimeCapabilities } from './capability-publication.ts'

describe('Teams runtime lifecycle', () => {
  it('requires admission and config sync before ready', () => {
    let state = startDaemonRuntime({ endpoint: 'https://hub.test', authMode: 'none' })
    state = advanceRuntimeLifecycle(state, 'admitted')
    state = advanceRuntimeLifecycle(state, 'config-synced', 7)
    state = advanceRuntimeLifecycle(state, 'ready')
    expect(state.configRevision).toBe(7)
    expect(stopDaemonRuntime(state).lifecycle).toBe('stopped')
  })

  it('rejects skipped lifecycle stages and premature stop', () => {
    const state = startDaemonRuntime({ endpoint: 'https://hub.test', authMode: 'none' })
    expect(() => advanceRuntimeLifecycle(state, 'ready')).toThrow(/invalid lifecycle/)
    expect(() => stopDaemonRuntime(state)).toThrow(/stop requires ready/)
  })

  it('orchestrates link, admission, config sync, and ready as one startup', () => {
    const state = startDaemonRuntime(
      { endpoint: 'https://hub.test', authMode: 'shared-token', credentialRef: 'cred:hub' },
      { machineId: 'machine-a', authMode: 'shared-token', configuredCredential: 'opaque', presentedCredential: 'opaque' },
      { revision: 9, agents: {} },
    )
    expect(state).toMatchObject({ lifecycle: 'ready', configRevision: 9, admission: { admitted: true, permission: 'granted' } })
  })

  it('does not publish ready when admission is denied', () => {
    expect(() => startDaemonRuntime(
      { endpoint: 'https://hub.test', authMode: 'shared-token', credentialRef: 'cred:hub' },
      { machineId: 'machine-a', authMode: 'shared-token', configuredCredential: 'opaque', presentedCredential: 'wrong' },
      { revision: 9, agents: {} },
    )).toThrow(/admission denied/)
  })

  it('publishes capabilities only after the composed startup reaches ready', () => {
    const state = startDaemonRuntime(
      { endpoint: 'https://hub.test', authMode: 'none' },
      { machineId: 'machine-a', authMode: 'none' },
      { revision: 1, agents: {} },
    )
    expect(publishRuntimeCapabilities(state, 'machine-a', 'planner')).toMatchObject({
      machineId: 'machine-a', agentId: 'planner', capabilities: ['observe'], runtimeGeneration: 1,
    })
  })

  it('rejects capability publication before admission and ready', () => {
    const state = startDaemonRuntime({ endpoint: 'https://hub.test', authMode: 'none' })
    expect(() => publishRuntimeCapabilities(state, 'machine-a', 'planner')).toThrow(/admitted ready/)
  })

  it('returns the capability projection from the complete startup entrypoint', () => {
    expect(startDaemonRuntimeWithCapability(
      { endpoint: 'https://hub.test', authMode: 'none' },
      { machineId: 'machine-a', authMode: 'none' },
      { revision: 2, agents: {} },
      'machine-a',
      'planner',
    )).toMatchObject({ machineId: 'machine-a', agentId: 'planner', runtimeGeneration: 1 })
  })
})
