import type { AgentWork, AuthenticatedAgent, ServiceErrorCode, WorkProposal, WorkRequest } from '../control-protocol/agent-services.ts'
import {
  closeWork, completeRequest, confirmWorkDestroyed, createTrustedWorkAuthority,
  getRequest, proposeWork, requestWork,
  type ProviderWorkPolicy, type RequestCompletion, type WorkLedger, type WorkRequestRecord,
} from '../agent/work-resource.ts'

/** Local adapter port. Terminal outcomes require actual execution completion. */
export interface WorkExecutor {
  execute(work: AgentWork, request: WorkRequest): Promise<RequestCompletion>
  /** Resolve only after this Work's resources have actually been destroyed. */
  destroy(work: AgentWork): Promise<{ readonly destroyed: true }>
}
export interface WorkHostOptions {
  readonly ledger: WorkLedger
  readonly policy: () => ProviderWorkPolicy
  readonly executor: WorkExecutor
}
export interface WorkHost {
  propose(consumer: AuthenticatedAgent, proposal: WorkProposal): AgentWork
  request(consumer: AuthenticatedAgent, input: WorkRequest): Promise<WorkRequestRecord>
  get(consumer: AuthenticatedAgent, workId: string, requestId: string): WorkRequestRecord
  close(consumer: AuthenticatedAgent, workId: string): Promise<AgentWork>
}
export class WorkHostError extends Error {
  constructor(readonly code: ServiceErrorCode, message: string) { super(`${code}: ${message}`) }
}

/** Composes execution with the Agent-owned ledger; no second allocation owner. */
export function createWorkHost({ ledger, policy, executor }: WorkHostOptions): WorkHost {
  const authority = createTrustedWorkAuthority()
  const executions = new Map<string, { workId: string; result: Promise<WorkRequestRecord> }>()
  const closings = new Map<string, Promise<AgentWork>>()
  const authorizedWork = (consumer: AuthenticatedAgent, workId: string): AgentWork => {
    const work = ledger.snapshot.works.find(work => work.workId === workId)
    if (!work || consumer.accountId !== ledger.provider.accountId || consumer.scopeId !== ledger.provider.scopeId ||
      consumer.agentId !== work.consumerAgentId) throw new WorkHostError('FORBIDDEN', 'Work is not owned by this authenticated consumer')
    return work
  }
  return {
    propose: (consumer, proposal) => structuredClone(proposeWork(ledger, consumer, proposal, policy())),
    get: (consumer, workId, requestId) => {
      authorizedWork(consumer, workId)
      return structuredClone(getRequest(ledger, workId, requestId))
    },
    request: async (consumer, input) => {
      const admitted = requestWork(ledger, { authenticatedConsumer: consumer, request: input, policy: policy() })
      if (!admitted.executionAllowed) return structuredClone(admitted.request)
      const workId = admitted.request.control.workId
      const requestId = admitted.request.control.requestId
      const work = structuredClone(authorizedWork(consumer, workId))
      const request: WorkRequest = structuredClone({ control: admitted.request.control, payload: admitted.request.payload })
      const key = JSON.stringify([workId, requestId])
      const result = (async () => {
        let completion: RequestCompletion
        try { completion = await executor.execute(work, request) }
        catch (cause) {
          // An exception is not proof that an external side effect stopped.
          completion = { outcome: 'unknown', error: { code: 'RESULT_UNKNOWN',
            message: cause instanceof Error ? cause.message : 'local executor completion is unconfirmed' } }
        }
        return structuredClone(completeRequest(ledger, authority, workId, requestId, completion))
      })().finally(() => { executions.delete(key) })
      executions.set(key, { workId, result })
      return result
    },
    close: async (consumer, workId) => {
      authorizedWork(consumer, workId)
      const work = closeWork(ledger, consumer, workId)
      if (work.state === 'closed' || work.state === 'rejected') return structuredClone(work)
      const existing = closings.get(workId)
      if (existing) return structuredClone(await existing)
      const closing = (async () => {
        await Promise.all([...executions.values()].filter(item => item.workId === workId).map(item => item.result))
        const requests = ledger.snapshot.requests.filter(request => request.control.workId === workId)
        if (requests.some(request => request.state === 'unknown')) throw new WorkHostError('RESULT_UNKNOWN', 'Work execution must be reconciled before destruction')
        if (requests.some(request => request.state === 'running' || request.state === 'cancel_requested')) {
          throw new WorkHostError('RESULT_UNKNOWN', 'persisted execution has no local completion proof')
        }
        const confirmation = await executor.destroy(structuredClone(work))
        if (confirmation?.destroyed !== true) throw new WorkHostError('RESULT_UNKNOWN', 'resource destruction is unconfirmed')
        return structuredClone(confirmWorkDestroyed(ledger, authority, workId))
      })().finally(() => { closings.delete(workId) })
      closings.set(workId, closing)
      return structuredClone(await closing)
    },
  }
}
