#!/usr/bin/env node

// Negative fixture: emits one `host.call` whose control.request_id does not
// match `<execution>/<node>/<attempt>`. A real child process over the real stdio
// port exercises the Node host's control-correlation rejection without mocking
// any Work, network or ledger behavior.

import { createInterface } from 'node:readline'

let final = { type: 'execution.failure', message: 'host accepted a bad correlation' }
const timeout = setTimeout(() => {
  process.stdout.write(`${JSON.stringify({ type: 'execution.failure', message: 'host did not answer the bad correlation' })}\n`)
  process.exit(0)
}, 5_000)
timeout.unref()

process.stdout.write(`${JSON.stringify({
  type: 'host.call',
  control: {
    request_id: 'wrong-correlation',
    operation: 'agentWork.findProvider',
    operator: 'teams.resolve-peer-service',
    node_id: 'resolve-service',
    identity: {
      project_id: 'agentteams-d3-u4-work',
      graph_id: 'agentteams.agent-work',
      graph_version: '2',
      execution_id: 'exec-bad-correlation',
      attempt_id: '1',
    },
    args: {
      capabilityId: 'file-search',
      capabilityVersion: '1',
      operation: 'search',
      providerAgentId: 'provider',
    },
  },
})}\n`)

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const line of lines) {
  if (!line.trim()) continue
  const frame = JSON.parse(line)
  if (frame.type === 'host.error') {
    final = { type: 'execution.failure', message: `host rejected correlation: ${frame.control?.error?.message ?? ''}` }
  }
  break
}
clearTimeout(timeout)
process.stdout.write(`${JSON.stringify(final)}\n`)
