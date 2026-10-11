import { describe, expect, it } from 'vitest'
import { parseAcpFault, parseAcpFrame } from './acp.ts'

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

describe('ACP JSON-RPC envelope', () => {
  it('preserves legal extensions, params, results, and _meta without coercion', () => {
    const request = {
      jsonrpc: '2.0',
      id: 'request-1',
      method: 'session/prompt',
      params: { prompt: [{ type: 'text', text: 'hello' }], nested: { keep: [1, null, true] } },
      _meta: { trace: 'trace-1' },
      extension: { vendor: { enabled: true } },
    }
    const notification = { jsonrpc: '2.0', method: 'session/update', params: { update: { kind: 'x' } } }
    const response = { jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: '你好' }] }, _meta: { done: true } }

    expect(parseAcpFrame(request)).toBe(request)
    expect(parseAcpFrame(notification)).toBe(notification)
    expect(parseAcpFrame(response)).toBe(response)
  })

  it('rejects malformed structural envelopes and lossy identifiers', () => {
    const invalid: readonly unknown[] = [
      [ { jsonrpc: '2.0', id: 1, method: 'x' } ],
      { jsonrpc: '2.0', id: null, method: 'x' },
      { jsonrpc: '2.0', id: 1.5, method: 'x' },
      { jsonrpc: '2.0', id: Number.MAX_SAFE_INTEGER + 1, method: 'x' },
      { jsonrpc: '1.0', id: 1, method: 'x' },
      { jsonrpc: '2.0', id: 1, method: 'x', result: null },
      { jsonrpc: '2.0', id: 1 },
      { jsonrpc: '2.0', id: 1, result: null, error: { code: 1, message: 'x' } },
      { jsonrpc: '2.0', id: 1, error: { code: 1.5, message: 'x' } },
      { jsonrpc: '2.0', id: 1, error: { code: 1, message: '' } },
      { jsonrpc: '2.0', id: 1, method: 'x', params: 1 },
    ]
    for (const frame of invalid) {
      expect(failure(() => parseAcpFrame(frame))).toMatchObject({ code: 'INVALID_ACP_FRAME' })
    }
  })

  it('keeps the closed fault code set, including conflict and forbidden', () => {
    expect(parseAcpFault({ code: 'CONFLICT', message: 'already owned' })).toEqual({
      code: 'CONFLICT',
      message: 'already owned',
    })
    expect(parseAcpFault({ code: 'FORBIDDEN', message: 'admission denied', detail: { source: 'policy' } })).toEqual({
      code: 'FORBIDDEN',
      message: 'admission denied',
      detail: { source: 'policy' },
    })
    expect(failure(() => parseAcpFault({ code: 'MADE_UP', message: 'no' }))).toMatchObject({
      code: 'INVALID_ACP_FRAME',
    })
  })
})
