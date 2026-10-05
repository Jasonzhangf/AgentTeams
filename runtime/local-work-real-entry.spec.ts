import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import type { AgentWorkClient, AgentWorkTarget } from './agent-work-client.ts'
import { buildRunner } from './dagpipe/build.mjs'
import { runWorkExecution, type ProjectExecutionReceipt, type WorkExecutionRequest } from './dagpipe/host.ts'

const repoRoot = resolve(import.meta.dirname, '..')
const agentWorkGraph = join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'agent-work.graph.json')
const workQueryGraph = join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-query.graph.json')
const projectId = 'agentteams-local-work'

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function fakeWorkClient(input: {
  readonly providerAgentId: string
  readonly generation: number
  readonly business: string
  readonly calls: string[]
}): AgentWorkClient {
  const target: AgentWorkTarget = {
    providerAgentId: input.providerAgentId,
    generation: input.generation,
    capabilityId: 'file-search',
    capabilityVersion: '1',
    operation: 'search',
    serviceSelection: 'endpoint',
  }
  return {
    findProvider: async () => {
      input.calls.push('findProvider')
      return target
    },
    open: async () => {
      input.calls.push('open')
      return {
        propose: async proposal => {
          input.calls.push('propose')
          return {
            workId: proposal.workId,
            consumerAgentId: 'receiver',
            providerAgentId: input.providerAgentId,
            capabilityId: proposal.capabilityId,
            capabilityVersion: proposal.capabilityVersion,
            policyRevision: proposal.policyRevision,
            state: 'accepted',
            createdAt: '2026-10-05T00:00:00.000Z',
            updatedAt: '2026-10-05T00:00:00.000Z',
          }
        },
        request: async request => {
          input.calls.push('request')
          return {
            control: {
              workId: request.workId,
              requestId: request.requestId,
              state: 'succeeded',
              targetGeneration: input.generation,
            },
            payload: { echo: input.business, requestId: request.requestId },
          }
        },
        get: async (workId, requestId) => {
          input.calls.push('get')
          return {
            control: {
              workId,
              requestId,
              state: 'succeeded',
              targetGeneration: input.generation,
            },
            payload: { echo: input.business, requestId },
          }
        },
        close: async workId => {
          input.calls.push('close')
          return {
            workId,
            consumerAgentId: 'receiver',
            providerAgentId: input.providerAgentId,
            capabilityId: target.capabilityId,
            capabilityVersion: target.capabilityVersion,
            policyRevision: 1,
            state: 'closed',
            createdAt: '2026-10-05T00:00:00.000Z',
            updatedAt: '2026-10-05T00:00:00.000Z',
          }
        },
        dispose: async () => { input.calls.push('dispose') },
        closed: Promise.resolve(new Error('fake channel closed')),
      }
    },
    dispose: async () => { input.calls.push('dispose') },
  }
}

it('keeps public Work submit identity through the real runner and queries without replay', async () => {
  const built = await buildRunner()
  const calls: string[] = []
  const workId = 'work-4b6c377-real-entry'
  const requestId = 'request-4b6c377-real-entry'
  const business = 'needle-real-entry'
  const client = fakeWorkClient({ providerAgentId: 'provider-4b6c377', generation: 7, business, calls })
  const base = {
    runnerPath: built.runnerPath,
    projectId,
    executionId: 'execution-4b6c377-submit',
    attemptId: 'attempt-4b6c377',
  } satisfies Omit<WorkExecutionRequest, 'graphPath' | 'intent'>
  const submitIntent = {
    control: {
      receiverAgentId: 'receiver',
      targetAgentId: 'provider-4b6c377',
      capabilityId: 'file-search',
      capabilityVersion: '1',
      operation: 'search',
      workId,
      requestId,
      policyRevision: 1,
      demands: [{ resourceId: 'search-slot', amount: 1 }],
    },
    business: { query: business },
  }

  const submitted = await runWorkExecution(client, { ...base, graphPath: agentWorkGraph, intent: submitIntent })
  expect(submitted.status).toBe('completed')
  expect(submitted.control).toMatchObject({
    workId,
    requestId,
    providerAgentId: 'provider-4b6c377',
    targetGeneration: 7,
    capabilityId: 'file-search',
    capabilityVersion: '1',
    requestState: 'succeeded',
    workClosure: 'closed',
  })
  expect(submitted.business).toEqual({ echo: business, requestId })
  expect(calls).toEqual(['findProvider', 'open', 'propose', 'request', 'close', 'dispose'])

  const queryCallsStart = calls.length
  const observed = await runWorkExecution(client, {
    ...base,
    executionId: 'execution-4b6c377-query',
    graphPath: workQueryGraph,
    intent: {
      control: {
        receiverAgentId: 'receiver',
        targetAgentId: 'provider-4b6c377',
        capabilityId: 'file-search',
        capabilityVersion: '1',
        operation: 'search',
        workId,
        requestId,
      },
    },
  })
  expect(observed.status).toBe('completed')
  expect(observed.control).toMatchObject({ workId, requestId, observed: true })
  expect(observed.business).toEqual({ echo: business, requestId })
  expect(calls.slice(queryCallsStart)).toEqual(['findProvider', 'open', 'get', 'dispose'])

  const receipt: ProjectExecutionReceipt = observed
  expect(receipt.control.requestState).toBe('succeeded')
  expect(sha256(JSON.stringify({ submit: submitted.business, query: observed.business }))).toBe(
    sha256(JSON.stringify({ submit: { echo: business, requestId }, query: { echo: business, requestId } })),
  )
}, 90_000)
