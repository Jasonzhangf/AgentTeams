#!/usr/bin/env node
// TEST PEER — a controllable ACP JSON-RPC child used only by D01 transport
// tests. It proves the stdio frame boundary, bidirectional request/response,
// notifications, protocol faults, timeout, and process exit. It is NOT an
// engine, NOT engine inference, and NOT installed-delivery evidence.
//
// Usage: node test-peer.mjs [mode]
//   acp       default ACP-like engine (initialize / session/new / session/prompt)
//   echo      echo each request method and params back as the result
//   callback  answer a prompt only after a client reply to a permission callback
//   silent    consume stdin and never write a frame (read-timeout probe)
//   crash     exit 3 before reading anything (start-failure probe)
//   malformed write one non-JSON line (protocol-fault probe)
//   oversize  write one line longer than any configured frame bound
//   incomplete write a partial frame without a newline, then exit
import { createInterface } from 'node:readline'

const mode = process.argv[2] ?? 'acp'

if (mode === 'crash') process.exit(3)

const out = process.stdout
const write = frame => { out.write(`${JSON.stringify(frame)}\n`) }

if (mode === 'malformed') {
  out.write('this-is-not-json\n')
} else if (mode === 'oversize') {
  out.write(`${'x'.repeat(1024 * 1024)}\n`)
} else if (mode === 'incomplete') {
  out.write('{"jsonrpc":"2.0","id":1,"result":{')
  process.exit(0)
}

let sessionCounter = 0
let callbackCounter = 0
const pendingCallbacks = new Map()

const rl = createInterface({ input: process.stdin })
rl.on('line', line => {
  if (line.length === 0) return
  let frame
  try {
    frame = JSON.parse(line)
  } catch {
    return
  }
  if (frame === null || typeof frame !== 'object') return

  if (typeof frame.method === 'string' && Object.hasOwn(frame, 'id')) {
    handleRequest(frame)
    return
  }
  if (typeof frame.method === 'string') return
  if (Object.hasOwn(frame, 'id')) {
    const resolve = pendingCallbacks.get(String(frame.id))
    if (resolve !== undefined) {
      pendingCallbacks.delete(String(frame.id))
      resolve(frame)
    }
  }
})

function handleRequest(frame) {
  const id = frame.id
  if (mode === 'silent') return
  if (frame.method === 'test/exit') {
    // Deterministic clean child exit for the EOF/cleanup probe.
    process.exit(0)
  }
  if (frame.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          promptCapabilities: { image: true, audio: false },
          sessionCapabilities: { load: true },
        },
      },
    })
    return
  }
  if (frame.method === 'session/new') {
    sessionCounter += 1
    write({ jsonrpc: '2.0', id, result: { sessionId: `test-peer-session-${sessionCounter}` } })
    return
  }
  if (frame.method === 'session/prompt') {
    const sessionId = frame.params?.sessionId
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } },
    })
    if (mode === 'callback') {
      callbackCounter += 1
      const callbackId = `peer-callback-${callbackCounter}`
      pendingCallbacks.set(callbackId, response => {
        write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn', callback: response.error ?? response.result } })
      })
      write({
        jsonrpc: '2.0',
        id: callbackId,
        method: 'session/request_permission',
        params: { sessionId, options: [{ optionId: 'allow', name: 'Allow' }, { optionId: 'reject', name: 'Reject' }] },
      })
      return
    }
    write({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } })
    return
  }
  if (mode === 'echo') {
    write({ jsonrpc: '2.0', id, result: { method: frame.method, params: frame.params ?? null } })
    return
  }
  write({ jsonrpc: '2.0', id, error: { code: -32601, message: `test peer does not implement ${frame.method}` } })
}

if (mode === 'oversize' || mode === 'malformed' || mode === 'incomplete') {
  // Fault probes finish on their own; keep stdin open only long enough to flush.
  setTimeout(() => process.exit(0), 200)
}
