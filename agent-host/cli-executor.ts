import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { AgentWork, CapabilityDeclaration, JsonValue, ResourceAllocation, ServiceErrorCode, WorkRequest } from '../control-protocol/agent-services.ts'
import type { RequestCompletion } from '../agent/work-resource.ts'
import { createBrowserCliAdapter, type BrowserCliAdapter } from '../cli-adapter/browser-cli.ts'
import { createReadOnlySearchCliAdapter } from '../cli-adapter/search-cli.ts'
import { parseCliRequest } from '../cli-adapter/cli.ts'
import { CliAdapterError, type CliRequest } from '../cli-adapter/contracts.ts'
import { cliOperationDeclarations } from '../cli-adapter/operation-declarations.ts'
import type { LocalServiceIntent } from '../runtime/local-config.ts'
import type { WorkExecutor } from './work-host.ts'

export interface CliWorkExecutorOptions {
  readonly services: readonly LocalServiceIntent[]
  readonly camoExecutable?: string
  readonly searchExecutable?: string
  readonly searchRoot?: string
  readonly profilePrefix?: string
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

type ServiceAdapterMetadata = {
  readonly operations: readonly string[]
  readonly resources: Readonly<Record<string, { readonly unit: 'slot' | 'context'; readonly sharing: 'exclusive' | 'shared'; readonly allocationScope: 'request' | 'work' }>>
}

const serviceAdapterMetadata: Readonly<Record<string, ServiceAdapterMetadata>> = {
  browser: {
    operations: ['context.create', 'navigate', 'snapshot', 'context.destroy'],
    resources: {
      'browser-context': { unit: 'context', sharing: 'shared', allocationScope: 'work' },
      'browser-slot': { unit: 'slot', sharing: 'shared', allocationScope: 'request' },
    },
  },
  'file-search': {
    operations: ['search'],
    resources: {
      'search-slot': { unit: 'slot', sharing: 'shared', allocationScope: 'request' },
    },
  },
}

export class CliWorkExecutorConfigError extends Error {
  constructor(readonly code: 'INVALID_INPUT' | 'UNSUPPORTED_OPERATION', message: string) {
    super(`${code}: ${message}`)
    this.name = 'CliWorkExecutorConfigError'
  }
}

function invalid(message: string): never {
  throw new CliWorkExecutorConfigError('INVALID_INPUT', message)
}

function unsupported(message: string): never {
  throw new CliWorkExecutorConfigError('UNSUPPORTED_OPERATION', message)
}

function executablePath(value: string | undefined, label: string): string {
  if (value === undefined || !isAbsolute(value)) invalid(`${label} must be an absolute executable path`)
  try {
    const stat = lstatSync(value)
    if (!stat.isFile() && !stat.isSymbolicLink()) invalid(`${label} must reference an executable file`)
    realpathSync(value)
  } catch (error) {
    if (error instanceof CliWorkExecutorConfigError) throw error
    invalid(`${label} cannot be inspected: ${error instanceof Error ? error.message : String(error)}`)
  }
  return value
}

function searchRootPath(value: string | undefined): string {
  if (value === undefined || !isAbsolute(value)) invalid('searchRoot must be an absolute directory')
  let stat
  try {
    stat = lstatSync(value)
  } catch (error) {
    invalid(`searchRoot cannot be inspected: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) invalid('searchRoot must be a real directory, not a symlink')
  return value
}

function compileServices(services: readonly LocalServiceIntent[], options: CliWorkExecutorOptions): readonly {
  readonly intent: LocalServiceIntent
  readonly declaration: CapabilityDeclaration
}[] {
  if (!Array.isArray(services)) invalid('services must be an array')
  const seenServices = new Set<string>()
  return services.map((service: LocalServiceIntent, index: number) => {
    const label = `services[${index}]`
    if (typeof service !== 'object' || service === null || Array.isArray(service)) invalid(`${label} must be an object`)
    if (typeof service.capabilityId !== 'string' || service.capabilityId.length === 0) invalid(`${label}.capabilityId is required`)
    if (seenServices.has(service.capabilityId)) invalid(`duplicate service ${service.capabilityId}`)
    seenServices.add(service.capabilityId)
    const adapter = serviceAdapterMetadata[service.capabilityId]
    if (adapter === undefined) unsupported(`unknown service adapter ${service.capabilityId}`)
    if (service.version !== '1') unsupported(`service ${service.capabilityId} version ${service.version} is unsupported`)
    if (!Array.isArray(service.operations) || service.operations.some(operation => typeof operation !== 'string')) {
      invalid(`${label}.operations must be a string array`)
    }
    const operations = [...service.operations]
    if (new Set(operations).size !== operations.length) invalid(`service ${service.capabilityId} repeats an operation`)
    for (const operation of operations) {
      if (!(adapter.operations as readonly string[]).includes(operation)) unsupported(`service ${service.capabilityId} operation ${operation} is unsupported`)
    }
    for (const operation of adapter.operations) {
      if (!operations.includes(operation)) unsupported(`service ${service.capabilityId} must enable all operations before publication`)
    }
    if (!Array.isArray(service.resources)) invalid(`${label}.resources must be an array`)
    const seenResources = new Set<string>()
    const resources = service.resources.map((resource, resourceIndex: number): CapabilityDeclaration['resources'][number] => {
      const resourceLabel = `${label}.resources[${resourceIndex}]`
      if (typeof resource !== 'object' || resource === null || Array.isArray(resource)) invalid(`${resourceLabel} must be an object`)
      if (typeof resource.resourceId !== 'string' || resource.resourceId.length === 0) invalid(`${resourceLabel}.resourceId is required`)
      if (seenResources.has(resource.resourceId)) invalid(`service ${service.capabilityId} repeats resource ${resource.resourceId}`)
      seenResources.add(resource.resourceId)
      const metadata = adapter.resources[resource.resourceId]
      if (metadata === undefined) unsupported(`service ${service.capabilityId} resource ${resource.resourceId} is unsupported`)
      if (!Number.isSafeInteger(resource.capacity) || resource.capacity <= 0) invalid(`${resourceLabel}.capacity must be positive`)
      if (resource.unit !== metadata.unit) invalid(`${resourceLabel}.unit does not match adapter metadata`)
      return {
        resourceId: resource.resourceId,
        capacity: resource.capacity,
        unit: resource.unit,
        sharing: metadata.sharing,
        allocationScope: metadata.allocationScope,
      }
    })
    for (const resourceId of Object.keys(adapter.resources)) {
      if (!seenResources.has(resourceId)) invalid(`service ${service.capabilityId} requires resource ${resourceId}`)
    }
    if (service.capabilityId === 'browser') {
      executablePath(options.camoExecutable, 'camoExecutable')
      if (options.profilePrefix === undefined || !/^teams-[A-Za-z0-9._-]+$/.test(options.profilePrefix)) {
        invalid('browser service requires an owned teams- profile prefix')
      }
    } else {
      executablePath(options.searchExecutable, 'searchExecutable')
      searchRootPath(options.searchRoot)
    }
    return {
      intent: service,
      declaration: {
        capabilityId: service.capabilityId,
        version: service.version,
        operations: structuredClone(operations.map(operation => cliOperationDeclarations[operation as keyof typeof cliOperationDeclarations])),
        resources,
      },
    }
  })
}

/** Adapter ownership is per Work; capacity and permission remain in the provider ledger. */
export function createCliWorkExecutor(input: CliWorkExecutorOptions): CliWorkExecutor {
  const options = { ...input }
  const compiled = compileServices(options.services, options)
  const search = compiled.some(service => service.intent.capabilityId === 'file-search')
    ? createReadOnlySearchCliAdapter({ root: options.searchRoot!, executable: options.searchExecutable! })
    : undefined
  const browsers = new Map<string, BrowserState>()
  const capabilities = compiled.map(service => service.declaration)
  const failed = (code: ServiceErrorCode, message: string): RequestCompletion => ({ outcome: 'failed', error: { code, message } })
  const hasUnreleasedBrowserContext = (allocations: readonly ResourceAllocation[]): boolean => allocations.some(allocation =>
    allocation.resourceId === 'browser-context' && allocation.scope === 'work' && allocation.state !== 'released')
  const browserFor = (work: AgentWork): ManagedBrowserState => {
    if (options.camoExecutable === undefined || options.profilePrefix === undefined) unsupported('browser adapter is not enabled')
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
    if (request.control.workId !== work.workId) throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'request workId does not match the Work' })
    const capability = capabilities.find(candidate => candidate.capabilityId === work.capabilityId)
    if (capability === undefined || capability.version !== work.capabilityVersion ||
      !capability.operations.some(item => item.operation === request.control.operation)) {
      throw new CliAdapterError({ code: 'UNAVAILABLE', message: 'operation is not declared by this Work capability' })
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
        if (error instanceof CliAdapterError && error.error.code === 'UNAVAILABLE') {
          return failed('UNSUPPORTED_OPERATION', error.message)
        }
        return failed('INVALID_INPUT', error instanceof Error ? error.message : 'invalid CLI request')
      }
      try {
        let result: unknown
        if (parsed.operation === 'search') {
          if (search === undefined) throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'file-search adapter is not enabled' })
          result = await search.search(parsed)
        }
        else {
          if (!capabilities.some(capability => capability.capabilityId === 'browser' && capability.operations.some(operation => operation.operation === parsed.operation))) {
            throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'browser operation is not enabled' })
          }
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
