#!/usr/bin/env node

// Negative fixture: emits malformed known-terminal frames, wrong final identity,
// or a duplicate terminal frame over the real runner stdio port. The Node host
// must convert each case into one failed HOST_PROTOCOL ProjectExecutionReceipt
// instead of rejecting or treating a later terminal as success.

import { writeFileSync } from 'node:fs'

const kind = process.env.TEAMS_D3_U4_MALFORMED_FINAL ?? 'execution-result-missing-compiled'
const pidFile = process.env.TEAMS_D3_U4_PID_FILE
if (pidFile) writeFileSync(pidFile, `${process.pid}\n`)

const validResult = {
  type: 'execution.result',
  identity: {
    project_id: 'agentteams-d3-u4-work',
    graph_id: 'agentteams.agent-work',
    graph_version: '2',
    execution_id: 'exec-bad-final',
    attempt_id: '1',
  },
  compiled: {
    id: 'agentteams.agent-work',
    version: '2',
    node_ids: ['resolve-service', 'open-link', 'admit-work', 'request-work', 'settle-work'],
    input_arcs: ['work.intent'],
    output_arcs: ['work.receipt'],
  },
  outputs: {
    'work.receipt': {
      id: 'work.receipt',
      version: 1,
      schema: 'Object',
      payload: {
        control: {
          workId: 'work-bad-final',
          requestId: 'req-bad-final',
          targetAgentId: 'provider',
          capabilityId: 'file-search',
          capabilityVersion: '1',
          operation: 'search',
          serviceSelection: 'endpoint',
          targetGeneration: 1,
          requestState: 'succeeded',
          workClosure: 'closed',
        },
        business: { query: 'fixture marker' },
      },
    },
  },
  journal: [
    { kind: 'node_scheduled', node_id: 'resolve-service' },
    { kind: 'node_completed', node_id: 'resolve-service' },
    { kind: 'node_scheduled', node_id: 'open-link' },
    { kind: 'node_completed', node_id: 'open-link' },
    { kind: 'node_scheduled', node_id: 'admit-work' },
    { kind: 'node_completed', node_id: 'admit-work' },
    { kind: 'node_scheduled', node_id: 'request-work' },
    { kind: 'node_completed', node_id: 'request-work' },
    { kind: 'node_scheduled', node_id: 'settle-work' },
    { kind: 'node_completed', node_id: 'settle-work' },
  ],
}

const frames = {
  'valid-only': [validResult],
  'execution-result-missing-compiled': [{ type: 'execution.result', identity: validResult.identity, outputs: {}, journal: [] }],
  'execution-result-missing-identity': [{ type: 'execution.result', compiled: validResult.compiled, outputs: {}, journal: [] }],
  'execution-result-missing-journal': [{ type: 'execution.result', identity: validResult.identity, compiled: validResult.compiled, outputs: {} }],
  'execution-result-bad-identity': [{ ...validResult, identity: { ...validResult.identity, execution_id: 'wrong-execution' } }],
  'duplicate-final': [
    validResult,
    { type: 'execution.failure', kind: 'operator', message: 'second terminal', journal: [] },
  ],
  'malformed-after-valid-result': [
    validResult,
    { type: 'not-a-runner-frame' },
  ],
  'host-call-after-valid-result': [
    validResult,
    {
      type: 'host.call',
      control: {
        operator: 'teams.resolve-peer-service',
        node_id: 'resolve-service',
        request_id: `${validResult.identity.execution_id}/resolve-service/${validResult.identity.attempt_id}`,
        operation: 'agentWork.findProvider',
        identity: validResult.identity,
        args: {
          providerAgentId: 'provider',
          capabilityId: 'file-search',
          capabilityVersion: '1',
          operation: 'search',
          serviceSelection: 'endpoint',
        },
      },
    },
  ],
}

for (const frame of frames[kind] ?? frames['execution-result-missing-compiled']) {
  process.stdout.write(`${JSON.stringify(frame)}\n`)
}

// The host closes stdin after the first terminal frame, or kills this process
// when it rejects a post-terminal frame. Keep the process alive until either
// action happens so a missing host action fails the bounded test.
process.stdin.resume()
process.stdin.on('end', () => process.exit(0))
