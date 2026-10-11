import { describe, expect, it } from 'vitest'
import type { AcpFrame } from '../control-protocol/acp.ts'
import { assertAcpAllowed, extractAcpCapabilities, resolveAcpPolicy } from './acp-policy.ts'

const initialize: AcpFrame = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: 1,
    agentCapabilities: {
      promptCapabilities: { image: true, audio: false },
      mcpCapabilities: { http: true, sse: false },
      sessionCapabilities: { resume: true, load: false },
    },
  },
}

const optional = ['method:session/load', 'method:session/resume', 'callback:session/request_permission']

// Genuine isolated DSH initialize result (probe/summary-dsh.json): object markers.
const dshInitialize: AcpFrame = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: 1,
    agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
    agentCapabilities: {
      mcpCapabilities: { http: true },
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      sessionCapabilities: { close: {}, list: {}, resume: {} },
    },
    authMethods: [],
  },
}

// Genuine isolated OpenCode initialize result (probe/summary-opencode.json).
const openCodeInitialize: AcpFrame = {
  jsonrpc: '2.0',
  id: 1,
  result: {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      mcpCapabilities: { http: true, sse: true },
      promptCapabilities: { embeddedContext: true, image: true },
      sessionCapabilities: { close: {}, fork: {}, list: {}, resume: {} },
    },
    authMethods: [{ id: 'opencode-login', name: 'Login with opencode' }],
  },
}

function failure(run: () => unknown): unknown {
  let error: unknown
  try {
    run()
  } catch (caught) {
    error = caught
  }
  expect(error).toBeDefined()
  return error
}

function snapshot(input: {
  readonly supported?: readonly string[]
  readonly blacklist?: readonly string[]
  readonly required?: readonly string[]
  readonly enforceablePolicies?: readonly string[]
}) {
  return resolveAcpPolicy({
    intent: {
      enabled: true,
      required: input.required ?? [],
      blacklist: input.blacklist ?? [],
      clientCapabilities: [],
      callbackExecutor: 'controller',
    },
    engineInstanceId: 'engine-1',
    supported: input.supported ?? [...extractAcpCapabilities(initialize), ...optional],
    enforceablePolicies: input.enforceablePolicies ?? [],
  })
}

describe('ACP policy vocabulary', () => {
  it('extracts only true capabilities from a real initialize result plus adapter declarations', () => {
    const supported = extractAcpCapabilities(initialize, ['method:session/close'])
    expect(supported).toContain('acp')
    expect(supported).toContain('method:initialize')
    expect(supported).toContain('method:session/new')
    expect(supported).toContain('method:session/prompt')
    expect(supported).toContain('method:session/cancel')
    expect(supported).toContain('method:session/update')
    expect(supported).toContain('method:session/close')
    expect(supported).toContain('capability:/promptCapabilities/image')
    expect(supported).toContain('capability:/mcpCapabilities/http')
    expect(supported).toContain('capability:/sessionCapabilities/resume')
    expect(supported).not.toContain('capability:/promptCapabilities/audio')
    expect(supported).not.toContain('capability:/mcpCapabilities/sse')
    expect(supported).not.toContain('capability:/sessionCapabilities/load')
  })

  it('recognizes genuine DSH empty-object markers and maps their optional methods', () => {
    const supported = extractAcpCapabilities(dshInitialize)
    for (const key of [
      'acp',
      'method:initialize',
      'method:session/new',
      'method:session/prompt',
      'method:session/cancel',
      'method:session/update',
      'capability:/mcpCapabilities/http',
      'capability:/sessionCapabilities/close',
      'capability:/sessionCapabilities/list',
      'capability:/sessionCapabilities/resume',
      'method:session/close',
      'method:session/list',
      'method:session/resume',
    ]) {
      expect(supported).toContain(key)
    }
    for (const key of [
      'capability:/promptCapabilities/image',
      'capability:/promptCapabilities/audio',
      'capability:/promptCapabilities/embeddedContext',
      'capability:/sessionCapabilities/fork',
      'method:session/fork',
    ]) {
      expect(supported).not.toContain(key)
    }
  })

  it('never turns empty capability group containers into capabilities', () => {
    const emptyGroups: AcpFrame = {
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: { sessionCapabilities: {}, promptCapabilities: {}, mcpCapabilities: {} },
      },
    }
    const supported = extractAcpCapabilities(emptyGroups)
    expect(supported).toEqual([
      'acp',
      'method:initialize',
      'method:session/new',
      'method:session/prompt',
      'method:session/cancel',
      'method:session/update',
    ])
    expect(supported.some(key => key.startsWith('capability:/'))).toBe(false)
  })

  it('maps OpenCode fork and loadSession markers from the real initialize shape', () => {
    const supported = extractAcpCapabilities(openCodeInitialize)
    expect(supported).toContain('capability:/sessionCapabilities/fork')
    expect(supported).toContain('method:session/fork')
    expect(supported).toContain('capability:/loadSession')
    expect(supported).toContain('capability:/promptCapabilities/image')
    expect(supported).toContain('capability:/mcpCapabilities/sse')
  })

  it('normalizes bare adapter method names before classification', () => {
    expect(extractAcpCapabilities(dshInitialize, ['session/close', 'method:session/resume'])).toEqual(
      extractAcpCapabilities(dshInitialize, ['method:session/close', 'method:session/resume']),
    )
  })

  it('removes only supported blacklist keys and records them as denied', () => {
    const policy = snapshot({
      blacklist: ['capability:/promptCapabilities/image', 'method:session/load'],
      enforceablePolicies: ['capability:/promptCapabilities/image', 'method:session/load'],
    })
    expect(policy.effective).not.toContain('capability:/promptCapabilities/image')
    expect(policy.effective).not.toContain('method:session/load')
    expect(policy.denied).toEqual(expect.arrayContaining(['capability:/promptCapabilities/image', 'method:session/load']))
  })

  it('rejects unknown or unenforceable blacklist keys as UNSUPPORTED_POLICY', () => {
    expect(failure(() => snapshot({ blacklist: ['wildcard:*'], enforceablePolicies: ['wildcard:*'] }))).toMatchObject({
      code: 'UNSUPPORTED_POLICY',
    })
    expect(failure(() => snapshot({
      blacklist: ['internal-tool:opencode:bash'],
      enforceablePolicies: [],
    }))).toMatchObject({ code: 'UNSUPPORTED_POLICY' })
    expect(failure(() => snapshot({
      blacklist: ['method:session/load'],
      enforceablePolicies: [],
    }))).toMatchObject({ code: 'UNSUPPORTED_POLICY' })
  })

  it('rejects unsupported required capabilities and required-path blacklists', () => {
    expect(failure(() => snapshot({
      required: ['capability:/promptCapabilities/audio'],
    }))).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    expect(failure(() => snapshot({
      blacklist: ['method:session/prompt'],
      enforceablePolicies: ['method:session/prompt'],
    }))).toMatchObject({ code: 'UNSUPPORTED_POLICY' })
    expect(failure(() => snapshot({
      blacklist: ['acp'],
      enforceablePolicies: ['acp'],
    }))).toMatchObject({ code: 'UNSUPPORTED_POLICY' })
  })

  it('publishes an empty effective set when ACP is disabled', () => {
    const policy = resolveAcpPolicy({
      intent: { enabled: false, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' },
      engineInstanceId: 'engine-1',
      supported: extractAcpCapabilities(initialize),
      enforceablePolicies: [],
    })
    expect(policy.effective).toEqual([])
    expect(policy.denied).toEqual([])
  })
})

describe('ACP policy enforcement', () => {
  const allowed = snapshot({})
  const baseOnly = snapshot({ supported: extractAcpCapabilities(initialize) })
  const imageDenied = snapshot({
    blacklist: ['capability:/promptCapabilities/image'],
    enforceablePolicies: ['capability:/promptCapabilities/image'],
  })
  const callbackDenied = snapshot({
    blacklist: ['callback:session/request_permission'],
    enforceablePolicies: ['callback:session/request_permission'],
  })

  it('allows a text prompt and denies a blacklisted modality before dispatch', () => {
    expect(() => assertAcpAllowed({
      policy: allowed,
      direction: 'to-engine',
      frame: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'text', text: 'ok' }] } },
    })).not.toThrow()
    expect(failure(() => assertAcpAllowed({
      policy: imageDenied,
      direction: 'to-engine',
      frame: { jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { prompt: [{ type: 'image', data: 'x' }] } },
    }))).toMatchObject({ code: 'CAPABILITY_DENIED' })
  })

  it('rejects unsupported modalities, MCP transports, methods, and callbacks', () => {
    expect(failure(() => assertAcpAllowed({
      policy: allowed,
      direction: 'to-engine',
      frame: { jsonrpc: '2.0', id: 1, method: 'session/prompt', params: { prompt: [{ type: 'audio', data: 'x' }] } },
    }))).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    expect(failure(() => assertAcpAllowed({
      policy: allowed,
      direction: 'to-engine',
      frame: { jsonrpc: '2.0', id: 1, method: 'session/new', params: { mcpServers: [{ type: 'sse', url: 'x' }] } },
    }))).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    expect(failure(() => assertAcpAllowed({
      policy: baseOnly,
      direction: 'to-engine',
      frame: { jsonrpc: '2.0', id: 1, method: 'session/load', params: {} },
    }))).toMatchObject({ code: 'UNSUPPORTED_METHOD' })
    expect(failure(() => assertAcpAllowed({
      policy: callbackDenied,
      direction: 'from-engine',
      frame: { jsonrpc: '2.0', id: 3, method: 'session/request_permission', params: {} },
    }))).toMatchObject({ code: 'CAPABILITY_DENIED' })
    expect(failure(() => assertAcpAllowed({
      policy: allowed,
      direction: 'from-engine',
      frame: { jsonrpc: '2.0', id: 3, method: 'terminal/create', params: {} },
    }))).toMatchObject({ code: 'UNSUPPORTED_METHOD' })
  })

  it('enforces declared client capabilities during initialize', () => {
    const clientPolicy = resolveAcpPolicy({
      intent: { enabled: true, required: [], blacklist: [], clientCapabilities: [], callbackExecutor: 'controller' },
      engineInstanceId: 'engine-1',
      supported: [...extractAcpCapabilities(initialize), 'client-capability:/fs/readTextFile'],
      enforceablePolicies: [],
    })
    expect(() => assertAcpAllowed({
      policy: clientPolicy,
      direction: 'to-engine',
      frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientCapabilities: { fs: { readTextFile: true } } } },
    })).not.toThrow()
    expect(failure(() => assertAcpAllowed({
      policy: clientPolicy,
      direction: 'to-engine',
      frame: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientCapabilities: { terminal: true } } },
    }))).toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
  })
})
