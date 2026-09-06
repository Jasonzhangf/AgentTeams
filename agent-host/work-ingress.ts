import type { AuthenticatedAgent, ServiceError } from '../control-protocol/agent-services.ts'
import type { WorkWireReply, WorkWireRequest } from '../control-protocol/work-wire.ts'
import { isWorkServiceError } from '../agent/work-resource.ts'
import { WorkHostError, type WorkHost } from './work-host.ts'

/** Runtime binds an authenticated grant participant once; requests cannot replace it. */
export function createWorkIngress(host: WorkHost, peer: AuthenticatedAgent): (request: WorkWireRequest) => Promise<WorkWireReply> {
  const consumer = structuredClone(peer)
  return async request => {
    const { correlationId } = request
    try {
      if (request.kind === 'work.propose') return { kind: 'work.state', correlationId, work: host.propose(consumer, request.proposal) }
      if (request.kind === 'work.close') return { kind: 'work.state', correlationId, work: await host.close(consumer, request.workId) }
      const record = request.kind === 'work.get' ? host.get(consumer, request.workId, request.requestId)
        : await host.request(consumer, { control: request.control, payload: request.payload })
      return { kind: 'work.result', correlationId, control: { workId: record.control.workId, requestId: record.control.requestId,
        state: record.state, ...(record.error ? { error: record.error } : {}) }, ...(record.response === undefined ? {} : { payload: record.response }) }
    } catch (cause) {
      const error: ServiceError = isWorkServiceError(cause) ? cause.error
        : cause instanceof WorkHostError ? { code: cause.code, message: cause.message }
          : { code: 'RESULT_UNKNOWN', message: cause instanceof Error ? cause.message : 'provider result is unconfirmed' }
      return { kind: 'work.error', correlationId, error }
    }
  }
}
