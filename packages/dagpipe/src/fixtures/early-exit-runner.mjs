#!/usr/bin/env node

// Negative fixture: emits one valid host.call, records its PID, and exits before
// reading the host response. This exercises the host's stdin error path without
// mocking Work, network or ledger behavior.

import { writeFileSync } from 'node:fs'

const pidFile = process.env.TEAMS_D3_U4_PID_FILE
if (pidFile) writeFileSync(pidFile, `${process.pid}\n`)

process.stdout.write(`${JSON.stringify({
  type: 'host.call',
  control: {
    request_id: 'exec-early-exit/resolve-service/1',
    operation: 'agentWork.findProvider',
    operator: 'teams.resolve-peer-service',
    node_id: 'resolve-service',
    identity: {
      project_id: 'agentteams-d3-u4-work',
      graph_id: 'agentteams.agent-work',
      graph_version: '2',
      execution_id: 'exec-early-exit',
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
process.exit(0)
