import { createHash } from 'node:crypto'
import type { AgentWork, CapabilityDeclaration, JsonValue, ResourceAllocation, ServiceErrorCode, WorkRequest } from '../control-protocol/agent-services.ts'
import type { RequestCompletion } from '../agent/work-resource.ts'
import { createBrowserCliAdapter, type BrowserCliAdapter } from '../cli-adapter/browser-cli.ts'
import { createReadOnlySearchCliAdapter } from '../cli-adapter/search-cli.ts'
import { parseCliRequest } from '../cli-adapter/cli.ts'
import { CliAdapterError, type CliRequest } from '../cli-adapter/contracts.ts'
import { cliOperationDeclarations } from '../cli-adapter/operation-declarations.ts'
import type { WorkExecutor } from './work-host.ts'

export interface CliWorkExecutorOptions {
  readonly camoExecutable: string
  readonly searchExecutable: string
  readonly searchRoot: string
  readonly profilePrefix: string
}
export interface CliWorkExecutor extends WorkExecutor {
  readonly capabilities: readonly CapabilityDeclaration[]
}

type ManagedBrowserState = {
  readonly adapter: BrowserCliAdapter
  contextId?: string
  status: 'possible' | 'active' | 'destroyed'
}
type BrowserState = ManagedBrowserState | { readonly status: 'not-created' }

/** Adapter ownership is per Work; capacity and permission remain in the provider ledger. */
export function createCliWorkExecutor(input: CliWorkExecutorOptions): CliWorkExecutor {
  const options = { ...input }
  if (!/^teams-[A-Za-z0-9._-]+$/.test(options.profilePrefix)) throw new Error('CLI executor requires an owned teams- profile prefix')
  const search = createReadOnlySearchCliAdapter({ root: options.searchRoot, executable: options.searchExecutable })
  const browsers = new Map<string, BrowserState>()
  const capabilities: readonly CapabilityDeclaration[] = [
    { capabilityId: 'browser', version: '1', operations: structuredClone([
      cliOperationDeclarations['context.create'], cliOperationDeclarations.navigate,
      cliOperationDeclarations.snapshot, cliOperationDeclarations['context.destroy']]),
      resources: [{ resourceId: 'browser-context', capacity: 2, unit: 'context', sharing: 'shared', allocationScope: 'work' },
        { resourceId: 'browser-slot', capacity: 2, unit: 'slot', sharing: 'shared', allocationScope: 'request' }] },
    { capabilityId: 'file-search', version: '1', operations: [structuredClone(cliOperationDeclarations.search)],
      resources: [{ resourceId: 'search-slot', capacity: 2, unit: 'slot', sharing: 'shared', allocationScope: 'request' }] },
  ]
  const failed = (code: ServiceErrorCode, message: string): RequestCompletion => ({ outcome: 'failed', error: { code, message } })
  const hasUnreleasedBrowserContext = (allocations: readonly ResourceAllocation[]): boolean => allocations.some(allocation =>
    allocation.resourceId === 'browser-context' && allocation.scope === 'work' && allocation.state !== 'released')
  const browserFor = (work: AgentWork): ManagedBrowserState => {
    const current = browsers.get(work.workId)
    if (current !== undefined && current.status !== 'not-created') return current
    const suffix = createHash('sha256').update(JSON.stringify([work.providerAgentId, work.workId])).digest('hex')
    const created: ManagedBrowserState = {
      adapter: createBrowserCliAdapter({ executable: options.camoExecutable, profile: `${options.profilePrefix}-${suffix}` }),
      status: 'possible',
    }
    browsers.set(work.workId, created)
    return created
  }
  const parseInput = (work: AgentWork, request: WorkRequest): CliRequest => {
    if (request.control.workId !== work.workId || work.capabilityVersion !== '1' ||
      !capabilities.some(capability => capability.capabilityId === work.capabilityId && capability.operations.some(item => item.operation === request.control.operation))) {
      throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'operation is not declared by this Work capability' })
    }
    const payload = request.payload
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload) || Object.hasOwn(payload, 'operation')) {
      throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'CLI arguments must be an object; operation is supplied by Work control' })
    }
    return parseCliRequest({ ...payload, operation: request.control.operation })
  }
  return {
    capabilities,
    execute: async (work, request, allocations) => {
      let parsed: CliRequest
      try { parsed = parseInput(work, request) }
      catch (error) {
        if (work.capabilityId === 'browser' && !hasUnreleasedBrowserContext(allocations) && !browsers.has(work.workId)) {
          browsers.set(work.workId, { status: 'not-created' })
        }
        return failed('INVALID_INPUT', error instanceof Error ? error.message : 'invalid CLI request')
      }
      try {
        let result: unknown
        if (parsed.operation === 'search') result = await search.search(parsed)
        else {
          const browser = browserFor(work)
          if (browser.status === 'destroyed') browser.status = 'possible'
          if (parsed.operation === 'context.create') {
            try {
              const created = await browser.adapter.contextCreate(parsed)
              browser.contextId = created.contextId
              browser.status = 'active'
              result = created
            } catch (error) {
              if (error instanceof CliAdapterError && error.error.contextId) browser.contextId = error.error.contextId
              throw error
            }
          } else if (parsed.operation === 'navigate') {
            result = await browser.adapter.navigate(parsed)
            browser.status = 'active'
          } else if (parsed.operation === 'snapshot') {
            result = await browser.adapter.snapshot(parsed)
            browser.status = 'active'
          } else {
            result = await browser.adapter.contextDestroy(parsed)
            browser.contextId = undefined
            browser.status = 'destroyed'
          }
        }
        return { outcome: 'succeeded', payload: result as JsonValue }
      } catch (error) {
        if (error instanceof CliAdapterError) {
          const execution = { kind: 'cli' as const, ...error.error }
          if (error.error.code === 'INVALID_INPUT' || error.error.code === 'NOT_FOUND' || error.error.code === 'CONFLICT') {
            return { outcome: 'failed', error: { code: error.error.code, message: error.message, execution } }
          }
          if (parsed.operation === 'search' && error.error.exitCode !== undefined) {
            return { outcome: 'failed', error: { code: 'UPSTREAM_ERROR', message: error.message, execution } }
          }
          return { outcome: 'unknown', error: { code: 'RESULT_UNKNOWN', message: error.message, execution } }
        }
        // A Camo command failure may leave its browser running. Keep the Work unknown.
        throw error
      }
    },
    destroy: async (work, allocations: readonly ResourceAllocation[]) => {
      const browser = browsers.get(work.workId)
      const hasBrowserContext = hasUnreleasedBrowserContext(allocations)
      if (browser === undefined) {
        if (hasBrowserContext) {
          throw new CliAdapterError({ code: 'UNAVAILABLE', message: 'browser resource destruction is unconfirmed after local owner loss' })
        }
        return { destroyed: true }
      }
      if (browser.status === 'not-created' || browser.status === 'destroyed') return { destroyed: true }
      if (browser.contextId === undefined) {
        if (hasBrowserContext) {
          throw new CliAdapterError({ code: 'UNAVAILABLE', message: 'browser resource destruction is unconfirmed' })
        }
        browser.status = 'destroyed'
        return { destroyed: true }
      }
      await browser.adapter.contextDestroy({ operation: 'context.destroy', contextId: browser.contextId })
      browser.contextId = undefined
      browser.status = 'destroyed'
      return { destroyed: true }
    },
  }
}
