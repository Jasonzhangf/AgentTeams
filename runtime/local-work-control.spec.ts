import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { createConnection } from 'node:net'
import type { Duplex } from 'node:net'
import { join, resolve } from 'node:path'
import { afterAll, expect, it } from 'vitest'
import type { ResourceDemand } from '../control-protocol/agent-services.ts'
import type { ProjectExecutionReceipt } from './dagpipe/host.ts'
import {
  decodeLocalWorkControlRequest,
  decodeLocalControlRequest,
  decodeLocalConsoleControlReply,
  decodeLocalWorkControlReply,
  LocalWorkControlError,
  sendLocalConsoleControlRequest,
  sendLocalWorkControlRequest,
  startLocalWorkControlListener,
  type LocalConsoleControlRequest,
  type LocalConsolePublicStatus,
  type LocalWorkControlDelivery,
  type LocalWorkControlRequest,
  type LocalWorkControlServer,
} from './local-work-control.ts'

const directories: string[] = []
const sockets: LocalWorkControlServer[] = []
const evidence: Record<string, unknown>[] = []

afterAll(async () => {
  await Promise.all(
    sockets.splice(0).map(async listener => {
      try {
        await listener.close()
      } catch {
        // close is best-effort cleanup after an explicit failure assertion
      }
    }),
  )
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })))
  const receiptDirectory = resolve(import.meta.dirname, '..', 'generated', 'u4-receipts')
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 })
  const runDirectory = await mkdtemp(join(receiptDirectory, 'local-work-control-'))
  const receiptPath = join(runDirectory, 'socket-evidence.json')
  await writeFile(receiptPath, `${JSON.stringify({
    generatedAt: new Date().toISOString(),
    evidence,
  }, null, 2)}\n`, { mode: 0o600 })
  console.log(`u4-socket-receipt ${receiptPath}`)
})

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join('/tmp', prefix))
  directories.push(root)
  return root
}

function receipt(kind: LocalWorkControlRequest['kind'], business?: unknown): ProjectExecutionReceipt {
  const control: ProjectExecutionReceipt['control'] = {
    projectId: 'agentteams-local-work',
    graphId: `agentteams.${kind.replace('work.', '')}`,
    graphVersion: '1',
    executionId: 'execution-1',
    attemptId: 'attempt-1',
    workId: 'work-1',
    requestId: 'request-1',
    providerAgentId: 'provider-1',
    targetGeneration: 12,
    capabilityId: 'file-search',
    capabilityVersion: '1',
    operation: 'search',
    requestState: 'succeeded',
    workClosure: 'retained',
  }
  return {
    status: 'completed',
    control,
    ...(business === undefined ? {} : { business: business as ProjectExecutionReceipt['business'] }),
    cleanup: { channelsOpened: 1, channelsDisposed: 1 },
    evidence: {
      execution: 'completed',
      graphId: control.graphId,
      graphVersion: '1',
      nodeSchedule: ['resolve-service', 'execute-work'],
      nodeCompletion: ['resolve-service', 'execute-work'],
      hostOperations: ['agentWork.findProvider', 'agentWork.request'],
    },
  }
}

function submitControl(overrides: Partial<LocalWorkControlRequest['control']> = {}) {
  return {
    receiverAgentId: 'receiver-1',
    expectedLauncherGeneration: 7,
    startToken: 'token-7',
    executionId: 'execution-1',
    attemptId: 'attempt-1',
    workId: 'work-1',
    requestId: 'request-1',
    ...overrides,
  } as LocalWorkControlRequest['control']
}

function demands(): readonly ResourceDemand[] {
  return [{ resourceId: 'file-search-slot', amount: 1 }]
}

function request(overrides: Partial<LocalWorkControlRequest> = {}): LocalWorkControlRequest {
  const kind = overrides.kind ?? 'work.submit'
  return {
    kind,
    requestId: 'corr-1',
    control: submitControl(),
    ...(kind === 'work.submit' || kind === 'work.open' || kind === 'work.request'
      ? { business: { text: 'alpha', nested: [1, null, { key: 'value' }] } }
      : {}),
    ...overrides,
  }
}

async function startServer(options: {
  readonly socketPath: string
  readonly receivers?: Readonly<Record<string, boolean>>
  readonly handle: (item: {
    readonly frame: LocalWorkControlRequest
    readonly peer: Duplex
    readonly disconnected: Promise<void>
    readonly respond: (reply: ProjectExecutionReceipt | { code: string; message: string }) => Promise<LocalWorkControlDelivery>
  }) => Promise<void> | void
}): Promise<LocalWorkControlServer> {
  const server = await startLocalWorkControlListener({
    socketPath: options.socketPath,
    launcherGeneration: 7,
    startToken: 'token-7',
    receivers: options.receivers ?? { 'receiver-1': true },
    handler: options.handle,
  })
  sockets.push(server)
  return server
}

async function socketState(path: string): Promise<{ exists: boolean; mode?: number; isSocket?: boolean }> {
  try {
    const actual = await stat(path)
    return { exists: true, mode: actual.mode & 0o777, isSocket: actual.isSocket() }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    throw cause
  }
}

async function rawExchange(socketPath: string, frame: unknown): Promise<unknown> {
  const peer = createConnection(socketPath)
  peer.setEncoding('utf8')
  let settled = false
  const reply = new Promise<string>((resolveReply, rejectReply) => {
    let buffered = ''
    const finish = (settle: () => void) => {
      if (settled) return
      settled = true
      settle()
    }
    peer.on('data', chunk => {
      buffered += chunk.toString('utf8')
      const index = buffered.indexOf('\n')
      if (index >= 0) finish(() => resolveReply(buffered.slice(0, index)))
    })
    peer.once('error', cause => finish(() => rejectReply(cause)))
    peer.once('close', () => finish(() => rejectReply(new Error('raw peer closed before a reply'))))
    peer.once('connect', () => peer.write(`${JSON.stringify(frame)}\n`))
  })
  const text = await reply
  peer.destroy()
  return JSON.parse(text)
}

it('validates the closed local Work frame once and preserves arbitrary business JSON through real Unix sockets', async () => {
  const root = await tempRoot('teams-local-work-control-success-')
  const socketPath = join(root, '.internal', 'work-control.sock')
  const sideEffect = join(root, 'side-effect.jsonl')
  const calls: LocalWorkControlRequest[] = []
  let delivery: LocalWorkControlDelivery | undefined
  const server = await startServer({
    socketPath,
    handle: async item => {
      calls.push(item.frame)
      await writeFile(sideEffect, `${JSON.stringify({ kind: item.frame.kind, accepted: true })}\n`, { flag: 'a' })
      delivery = await item.respond(receipt(item.frame.kind, item.frame.business))
    },
  })
  const before = await socketState(socketPath)
  const response = await sendLocalWorkControlRequest({
    socketPath,
    frame: request(),
    timeoutMs: 2000,
  })
  expect(before).toEqual({ exists: true, mode: 0o600, isSocket: true })
  expect(await socketState(join(root, '.internal'))).toEqual({ exists: true, mode: 0o700, isSocket: false })
  expect(response.kind).toBe('work.result')
  expect(response.requestId).toBe('corr-1')
  expect(response.receipt.business).toEqual({ text: 'alpha', nested: [1, null, { key: 'value' }] })
  expect(response.receipt.control).toEqual(expect.objectContaining({
    workId: 'work-1', requestId: 'request-1', providerAgentId: 'provider-1', targetGeneration: 12,
  }))
  expect(delivery).toBe('written')
  expect(calls).toHaveLength(1)
  expect(calls[0]?.business).toEqual({ text: 'alpha', nested: [1, null, { key: 'value' }] })
  expect(JSON.parse(await readFile(sideEffect, 'utf8'))).toEqual({ kind: 'work.submit', accepted: true })
  evidence.push({ case: 'success-preservation', response, delivery, sideEffects: [JSON.parse(await readFile(sideEffect, 'utf8'))], socketAfterHandler: before })
  await server.close()
  expect(await socketState(socketPath)).toEqual({ exists: false })
  evidence.push({ case: 'own-socket-cleanup-after-success', socket: await socketState(socketPath) })
})

it('covers all five admitted modes and both query selections with explicit ownership', async () => {
  const root = await tempRoot('teams-local-work-control-modes-')
  const socketPath = join(root, '.internal', 'work-control.sock')
  const sideEffect = join(root, 'side-effect.jsonl')
  const calls: LocalWorkControlRequest[] = []
  const server = await startServer({
    socketPath,
    handle: async item => {
      calls.push(item.frame)
      await writeFile(sideEffect, `${JSON.stringify({ kind: item.frame.kind, accepted: true })}\n`, { flag: 'a' })
      await item.respond(receipt(item.frame.kind, item.frame.business))
    },
  })
  const endpointControl = {
    serviceSelection: 'endpoint' as const,
    receiverAgentId: 'receiver-1',
    expectedLauncherGeneration: 7,
    startToken: 'token-7',
    executionId: 'query-exec-1',
    attemptId: 'query-attempt-1',
    workId: 'work-1',
    requestId: 'request-1',
  }
  const capabilityControl = {
    serviceSelection: 'capability' as const,
    receiverAgentId: 'receiver-1',
    expectedLauncherGeneration: 7,
    startToken: 'token-7',
    executionId: 'query-exec-2',
    attemptId: 'query-attempt-2',
    workId: 'work-2',
    requestId: 'request-2',
    targetAgentId: 'provider-1',
    targetGeneration: 13,
    capabilityId: 'file-search',
    capabilityVersion: '1',
    operation: 'search',
    linkGeneration: 14,
  }
  const frames: LocalWorkControlRequest[] = [
    request(),
    request({ kind: 'work.query', requestId: 'corr-q1', control: endpointControl }),
    request({ kind: 'work.query', requestId: 'corr-q2', control: capabilityControl }),
    request({
      kind: 'work.open', requestId: 'corr-o',
      control: submitControl({
        receiverAgentId: 'receiver-1', expectedLauncherGeneration: 7, startToken: 'token-7',
        executionId: 'open-exec', attemptId: 'open-attempt', workId: 'work-open', requestId: 'request-open',
        targetAgentId: 'provider-1', targetGeneration: 13, capabilityId: 'file-search', capabilityVersion: '1',
        operation: 'search', demands: demands(),
      }),
      business: null,
    }),
    request({
      kind: 'work.request', requestId: 'corr-r',
      control: submitControl({
        receiverAgentId: 'receiver-1', expectedLauncherGeneration: 7, startToken: 'token-7',
        executionId: 'request-exec', attemptId: 'request-attempt', workId: 'work-open', requestId: 'request-cont',
        targetAgentId: 'provider-1', targetGeneration: 13, capabilityId: 'file-search', capabilityVersion: '1',
        operation: 'search', demands: demands(),
      }),
      business: 0,
    }),
    request({
      kind: 'work.close', requestId: 'corr-c',
      control: submitControl({
        receiverAgentId: 'receiver-1', expectedLauncherGeneration: 7, startToken: 'token-7',
        executionId: 'close-exec', attemptId: 'close-attempt', workId: 'work-open', requestId: 'request-open',
        targetAgentId: 'provider-1', targetGeneration: 13, capabilityId: 'file-search', capabilityVersion: '1',
        operation: 'search',
      }),
    }),
  ]

  const responses = await Promise.all(frames.map(frame => sendLocalWorkControlRequest({ socketPath, frame, timeoutMs: 2000 })))
  expect(responses.map(item => item.kind)).toEqual(['work.result', 'work.result', 'work.result', 'work.result', 'work.result', 'work.result'])
  expect(responses.map(item => item.requestId)).toEqual(['corr-1', 'corr-q1', 'corr-q2', 'corr-o', 'corr-r', 'corr-c'])
  expect(calls.map(item => item.kind)).toEqual(['work.submit', 'work.query', 'work.query', 'work.open', 'work.request', 'work.close'])
  expect(calls.map(item => item.business)).toEqual([expect.any(Object), undefined, undefined, null, 0, undefined])
  expect(calls[1]).toMatchObject({ kind: 'work.query', control: { serviceSelection: 'endpoint' } })
  expect(calls[1]?.control).not.toHaveProperty('linkGeneration')
  expect(calls[2]).toMatchObject({ kind: 'work.query', control: { serviceSelection: 'capability', linkGeneration: 14, targetGeneration: 13 } })
  expect(calls[3]).toMatchObject({ control: { targetAgentId: 'provider-1', demands: demands() } })
  expect(calls[5]).not.toHaveProperty('business')
  expect((await readFile(sideEffect, 'utf8')).trim().split('\n')).toHaveLength(6)
  evidence.push({ case: 'five-modes-and-query-selections', requestKinds: frames.map(item => item.kind), responseCorrelations: responses.map(item => item.requestId) })
  await server.close()
  await expect(socketState(socketPath)).resolves.toEqual({ exists: false })
})

it('keeps endpoint and capability query selections closed over the public decoder and raw Unix sockets', async () => {
  const root = await tempRoot('teams-local-work-control-query-selection-')
  const socketPath = join(root, '.internal', 'work-control.sock')
  const calls: LocalWorkControlRequest[] = []
  const server = await startServer({
    socketPath,
    handle: async item => {
      calls.push(item.frame)
      await item.respond(receipt(item.frame.kind))
    },
  })
  const endpointControl = {
    serviceSelection: 'endpoint' as const,
    receiverAgentId: 'receiver-1',
    expectedLauncherGeneration: 7,
    startToken: 'token-7',
    executionId: 'query-endpoint-exec',
    attemptId: 'query-endpoint-attempt',
    workId: 'work-1',
    requestId: 'request-1',
  }
  const capabilityFields = {
    targetAgentId: 'provider-1',
    targetGeneration: 13,
    capabilityId: 'file-search',
    capabilityVersion: '1',
    operation: 'search',
    linkGeneration: 14,
  }
  const rejected: Record<string, { decoder: { threw: boolean }; socket: { kind: string; code?: string } }> = {}
  for (const [field, value] of Object.entries(capabilityFields)) {
    const frame = {
      kind: 'work.query',
      requestId: `corr-endpoint-${field}`,
      control: { ...endpointControl, [field]: value },
    }
    let decoder: { threw: boolean }
    try {
      decodeLocalWorkControlRequest(frame)
      decoder = { threw: false }
    } catch {
      decoder = { threw: true }
    }
    const socket = await rawExchange(socketPath, frame) as { kind: string; error?: { code: string } }
    rejected[field] = { decoder, socket: { kind: socket.kind, code: socket.error?.code } }
  }

  const endpointFrame = { kind: 'work.query', requestId: 'corr-endpoint-positive', control: endpointControl }
  const capabilityFrame = {
    kind: 'work.query',
    requestId: 'corr-capability-positive',
    control: { ...endpointControl, serviceSelection: 'capability' as const, ...capabilityFields },
  }
  expect(decodeLocalWorkControlRequest(endpointFrame).control).toEqual(endpointControl)
  expect(decodeLocalWorkControlRequest(capabilityFrame).control).toEqual(capabilityFrame.control)
  const [endpointReply, capabilityReply] = await Promise.all([
    rawExchange(socketPath, endpointFrame),
    rawExchange(socketPath, capabilityFrame),
  ])

  expect(rejected).toEqual(Object.fromEntries(Object.keys(capabilityFields).map(field => [
    field,
    { decoder: { threw: true }, socket: { kind: 'work.error', code: 'HOST_PROTOCOL' } },
  ])))
  expect(endpointReply).toMatchObject({ kind: 'work.result', requestId: 'corr-endpoint-positive' })
  expect(capabilityReply).toMatchObject({ kind: 'work.result', requestId: 'corr-capability-positive' })
  expect(calls.map(item => item.requestId)).toEqual(['corr-endpoint-positive', 'corr-capability-positive'])
  expect(calls[0]?.control).toEqual(endpointControl)
  expect(calls[1]?.control).toEqual(capabilityFrame.control)
  evidence.push({ case: 'query-selection-closed', rejected, positiveCorrelations: calls.map(item => item.requestId) })
  await server.close()
})

it('rejects launcher authorization before business dispatch without touching the selected receiver', async () => {
  const root = await tempRoot('teams-local-work-control-denied-')
  const socketPath = join(root, '.internal', 'work-control.sock')
  const calls: LocalWorkControlRequest[] = []
  const server = await startServer({
    socketPath,
    receivers: { 'receiver-1': true },
    handle: async item => {
      calls.push(item.frame)
      await item.respond(receipt(item.frame.kind))
    },
  })

  const unauthorized = await sendLocalWorkControlRequest({
    socketPath,
    frame: request({ control: submitControl({ startToken: 'wrong-token' }) }),
    timeoutMs: 2000,
  })
  const stale = await sendLocalWorkControlRequest({
    socketPath,
    frame: request({ control: submitControl({ expectedLauncherGeneration: 6 }) }),
    timeoutMs: 2000,
  })
  const missingReceiver = await sendLocalWorkControlRequest({
    socketPath,
    frame: request({ control: submitControl({ receiverAgentId: 'missing-receiver' }) }),
    timeoutMs: 2000,
  })

  expect(unauthorized).toEqual({ kind: 'work.error', requestId: 'corr-1', error: { code: 'NOT_AUTHORIZED', message: expect.any(String) } })
  expect(stale).toEqual({ kind: 'work.error', requestId: 'corr-1', error: { code: 'STALE_GENERATION', message: expect.any(String) } })
  expect(missingReceiver).toEqual({ kind: 'work.error', requestId: 'corr-1', error: { code: 'RECEIVER_NOT_FOUND', message: expect.any(String) } })
  expect(calls).toHaveLength(0)
  evidence.push({ case: 'authorization-before-handler', errors: [unauthorized, stale, missingReceiver], handlerCalls: calls.length })
  await server.close()
})

it('serves console.status/start/stop on the same launcher socket as Work and keeps the two verbs independent', async () => {
  const root = await tempRoot('teams-local-console-union-')
  const socketPath = join(root, '.internal', 'work-control.sock')
  const workCalls: LocalWorkControlRequest[] = []
  const consoleCalls: LocalConsoleControlRequest[] = []
  const consoleStatus: LocalConsolePublicStatus = {
    enabled: true,
    state: 'online',
    generation: 2,
    launcherState: 'running',
    launcherGeneration: 7,
    credential: 'configured',
    url: 'http://127.0.0.1:51234',
    origin: 'http://127.0.0.1:51234',
    pid: 4242,
    identityRef: 'console:local',
  }
  const server = await startLocalWorkControlListener({
    socketPath,
    launcherGeneration: 7,
    startToken: 'token-7',
    receivers: { 'receiver-1': true },
    handler: async input => {
      workCalls.push(input.frame)
      const result = receipt(input.frame.kind)
      await input.respond(result)
      return result
    },
    consoleHandler: async input => {
      consoleCalls.push(input.frame)
      await input.respond({ kind: 'console.result', correlationId: input.frame.correlationId, ok: true, status: consoleStatus })
    },
  })
  sockets.push(server)

  const stale = await sendLocalConsoleControlRequest({
    socketPath,
    frame: { kind: 'console.start', correlationId: 'console-stale', expectedLauncherGeneration: 6 },
    timeoutMs: 2000,
  })
  const responses = await Promise.all((['console.status', 'console.start', 'console.stop'] as const).map(kind =>
    sendLocalConsoleControlRequest({
      socketPath,
      frame: { kind, correlationId: `corr-${kind}`, expectedLauncherGeneration: 7, expectedConsoleGeneration: 2 },
      timeoutMs: 2000,
    })))
  const work = await sendLocalWorkControlRequest({ socketPath, frame: request(), timeoutMs: 2000 })

  expect(stale).toMatchObject({ kind: 'console.result', ok: false, error: { code: 'STALE_GENERATION' } })
  expect(responses.map(reply => reply.ok)).toEqual([true, true, true])
  expect(responses.map(reply => reply.kind === 'console.result' && reply.ok ? reply.status : undefined)).toEqual([consoleStatus, consoleStatus, consoleStatus])
  expect(consoleCalls.map(frame => frame.kind)).toEqual(['console.status', 'console.start', 'console.stop'])
  expect(consoleCalls.map(frame => frame.expectedConsoleGeneration)).toEqual([2, 2, 2])
  expect(work.kind).toBe('work.result')
  expect(workCalls.map(frame => frame.kind)).toEqual(['work.submit'])

  expect(decodeLocalControlRequest({ kind: 'console.status', correlationId: 'c', expectedLauncherGeneration: 7 }))
    .toEqual({ kind: 'console.status', correlationId: 'c', expectedLauncherGeneration: 7 })
  expect(() => decodeLocalControlRequest({ kind: 'console.stop', correlationId: 'c', expectedLauncherGeneration: 7, port: 51234 })).toThrowError(LocalWorkControlError)
  expect(decodeLocalConsoleControlReply({ kind: 'console.result', correlationId: 'c', ok: false, error: { code: 'CONSOLE_DISABLED', message: 'disabled' } }, 'c'))
    .toEqual({ kind: 'console.result', correlationId: 'c', ok: false, error: { code: 'CONSOLE_DISABLED', message: 'disabled' } })
  evidence.push({ case: 'console-work-same-socket', stale, responseKinds: responses.map(reply => reply.kind), work: work.kind, consoleCalls: consoleCalls.map(frame => frame.kind) })
  await server.close()
})

it('fails closed malformed, unknown, extra, missing and mismatched-control frames as HOST_PROTOCOL', async () => {
  const root = await tempRoot('teams-local-work-control-protocol-')
  const socketPath = join(root, '.internal', 'work-control.sock')
  const calls: LocalWorkControlRequest[] = []
  const server = await startServer({
    socketPath,
    handle: async item => {
      calls.push(item.frame)
      await item.respond(receipt(item.frame.kind))
    },
  })

  const send = async (frame: unknown) => sendLocalWorkControlRequest({
    socketPath,
    frame: frame as LocalWorkControlRequest,
    timeoutMs: 2000,
  }).catch((error: unknown) => ({
    kind: 'work.error' as const,
    requestId: 'corr-1',
    error: {
      code: error instanceof LocalWorkControlError ? error.code : 'HOST_PROTOCOL',
      message: error instanceof Error ? error.message : 'invalid Work request',
    },
  }))
  const cases: Record<string, unknown> = {
    unknown: request({ kind: 'work.retry' as never }),
    topExtra: { ...request(), metadata: 'not-control' },
    controlExtra: request({ control: { ...submitControl(), linkGeneration: 9 } as LocalWorkControlRequest['control'] }),
    missingWorkId: request({ control: submitControl({ workId: undefined } as never) }),
    closeBusiness: request({ kind: 'work.close', control: submitControl({ workId: 'work-close' }), business: null }),
    queryBusiness: request({ kind: 'work.query', control: { serviceSelection: 'endpoint', receiverAgentId: 'receiver-1', expectedLauncherGeneration: 7, startToken: 'token-7', executionId: 'e', attemptId: 'a', workId: 'w', requestId: 'r' }, business: null }),
  }
  const malformed = createConnection(socketPath)
  malformed.once('error', () => undefined)
  const malformedPromise = new Promise<void>(resolveMalformed => {
    malformed.once('connect', () => {
      malformed.write('not-json\n')
      malformed.once('data', () => resolveMalformed())
    })
  })

  const responses = await Promise.all(Object.entries(cases).map(async ([name, frame]) => ({ name, response: await send(frame) })))
  const responsesByCode = Object.fromEntries(responses.map(item => [item.name, item.response.error?.code]))
  const validCorrelationReply = await sendLocalWorkControlRequest({
    socketPath,
    frame: request({ control: submitControl({ requestId: 'request-1' }) }),
    timeoutMs: 2000,
  })

  expect(responsesByCode).toMatchObject({
    unknown: 'HOST_PROTOCOL', topExtra: 'HOST_PROTOCOL', controlExtra: 'HOST_PROTOCOL',
    missingWorkId: 'HOST_PROTOCOL', closeBusiness: 'HOST_PROTOCOL', queryBusiness: 'HOST_PROTOCOL',
  })
  expect(validCorrelationReply.requestId, 'reply correlation is the outer requestId even when it equals control requestId').toBe('corr-1')
  await malformedPromise
  expect(() => decodeLocalWorkControlReply({
    kind: 'work.result',
    requestId: 'wrong-correlation',
    receipt: receipt('work.submit'),
  }, 'corr-reply')).toThrowError(LocalWorkControlError)
  expect(calls.map(frame => frame.requestId)).toEqual(['corr-1'])
  evidence.push({ case: 'closed-frame-rejection', codes: responsesByCode, validCorrelation: validCorrelationReply.requestId })
  await malformed.destroy()
  await server.close()
})

it('rejects unknown demand keys and non-positive amounts on real raw socket frames before handler dispatch', async () => {
  const root = await tempRoot('teams-local-work-control-demands-')
  const socketPath = join(root, '.internal', 'work-control.sock')
  const calls: LocalWorkControlRequest[] = []
  const server = await startServer({
    socketPath,
    handle: async item => {
      calls.push(item.frame)
      await item.respond(receipt(item.frame.kind, item.frame.business))
    },
  })

  const frameWithDemand = (kind: 'work.open' | 'work.request', demand: Record<string, unknown>, suffix: string) => ({
    kind,
    requestId: `corr-${kind}-${suffix}`,
    control: submitControl({
      executionId: `${kind}-exec`, attemptId: `${kind}-attempt`, workId: 'work-open', requestId: 'request-x',
      targetAgentId: 'provider-1', targetGeneration: 13, capabilityId: 'file-search', capabilityVersion: '1',
      operation: 'search', demands: [demand],
    }),
    business: { text: 'alpha' },
  })

  const rejected: Record<string, { kind: string; code?: string }> = {}
  for (const kind of ['work.open', 'work.request'] as const) {
    for (const amount of [0, -1]) {
      const reply = await rawExchange(socketPath, frameWithDemand(kind, { resourceId: 'file-search-slot', amount }, String(amount))) as { kind: string; error?: { code: string } }
      rejected[`${kind}:${amount}`] = { kind: reply.kind, code: reply.error?.code }
    }
  }
  const decoderRejected: Record<string, { threw: boolean }> = {}
  for (const kind of ['work.open', 'work.request'] as const) {
    const frame = frameWithDemand(kind, { resourceId: 'file-search-slot', amount: 1, metadata: 'not-demand' }, 'metadata')
    try {
      decodeLocalWorkControlRequest(frame)
      decoderRejected[kind] = { threw: false }
    } catch {
      decoderRejected[kind] = { threw: true }
    }
    const reply = await rawExchange(socketPath, frame) as { kind: string; error?: { code: string } }
    rejected[`${kind}:metadata`] = { kind: reply.kind, code: reply.error?.code }
  }
  const positiveOpen = await rawExchange(socketPath, frameWithDemand('work.open', { resourceId: 'file-search-slot', amount: 1 }, 'positive')) as { kind: string }
  const positiveRequest = await rawExchange(socketPath, frameWithDemand('work.request', { resourceId: 'file-search-slot', amount: 1 }, 'positive')) as { kind: string }

  expect(rejected).toEqual({
    'work.open:0': { kind: 'work.error', code: 'HOST_PROTOCOL' },
    'work.open:-1': { kind: 'work.error', code: 'HOST_PROTOCOL' },
    'work.open:metadata': { kind: 'work.error', code: 'HOST_PROTOCOL' },
    'work.request:0': { kind: 'work.error', code: 'HOST_PROTOCOL' },
    'work.request:-1': { kind: 'work.error', code: 'HOST_PROTOCOL' },
    'work.request:metadata': { kind: 'work.error', code: 'HOST_PROTOCOL' },
  })
  expect(decoderRejected).toEqual({
    'work.open': { threw: true },
    'work.request': { threw: true },
  })
  expect(positiveOpen.kind).toBe('work.result')
  expect(positiveRequest.kind).toBe('work.result')
  expect(calls.map(frame => frame.requestId)).toEqual(['corr-work.open-positive', 'corr-work.request-positive'])
  evidence.push({ case: 'malformed-demand-rejected-before-handler', rejected, decoderRejected, positiveAccepted: [positiveOpen.kind, positiveRequest.kind], handlerCalls: calls.length })
  await server.close()
})

it('fails closed on prototype-key kinds at the public decoder and over a real socket', async () => {
  const root = await tempRoot('teams-local-work-control-protokind-')
  const socketPath = join(root, '.internal', 'work-control.sock')
  const calls: LocalWorkControlRequest[] = []
  const server = await startServer({
    socketPath,
    handle: async item => {
      calls.push(item.frame)
      await item.respond(receipt(item.frame.kind))
    },
  })

  const protoKinds = ['toString', 'constructor', '__proto__'] as const
  const decoderResults = protoKinds.map(kind => {
    try {
      decodeLocalWorkControlRequest({ kind, requestId: 'corr-proto', control: submitControl() })
      return { kind, threw: false }
    } catch (cause) {
      return {
        kind,
        threw: true,
        typed: cause instanceof LocalWorkControlError,
        code: cause instanceof LocalWorkControlError ? cause.code : (cause as Error).constructor.name,
      }
    }
  })
  const socketResults: Record<string, { kind: string; code?: string }> = {}
  for (const kind of protoKinds) {
    const reply = await rawExchange(socketPath, { kind, requestId: 'corr-proto', control: submitControl() }) as { kind: string; error?: { code: string } }
    socketResults[kind] = { kind: reply.kind, code: reply.error?.code }
  }

  expect(decoderResults).toEqual(protoKinds.map(kind => ({ kind, threw: true, typed: true, code: 'HOST_PROTOCOL' })))
  expect(socketResults).toEqual({
    toString: { kind: 'work.error', code: 'HOST_PROTOCOL' },
    constructor: { kind: 'work.error', code: 'HOST_PROTOCOL' },
    __proto__: { kind: 'work.error', code: 'HOST_PROTOCOL' },
  })
  expect(calls).toHaveLength(0)
  evidence.push({ case: 'prototype-key-kind-fails-closed', decoderResults, socketResults, handlerCalls: calls.length })
  await server.close()
})

it.each(['', '{"kind":'])('closes after a peer disconnects without a complete frame (%j)', async partial => {
  const root = await tempRoot('teams-local-work-control-eof-')
  const socketPath = join(root, 'control.sock')
  let calls = 0
  const server = await startServer({ socketPath, handle: () => { calls += 1 } })
  const peer = createConnection(socketPath)
  try {
    await once(peer, 'connect')
    const peerClosed = once(peer, 'close')
    peer.end(partial)
    await peerClosed
    await server.close()
    expect(calls).toBe(0)
    expect(await socketState(socketPath)).toEqual({ exists: false })
    evidence.push({ case: 'pre-dispatch-eof', partial, calls, socketRemoved: true })
  } finally {
    peer.destroy()
  }
}, 1_000)

it('closes an idle peer without dispatching business', async () => {
  const root = await tempRoot('teams-local-work-control-idle-')
  const socketPath = join(root, 'control.sock')
  let calls = 0
  const server = await startServer({ socketPath, handle: () => { calls += 1 } })
  const peer = createConnection(socketPath)
  try {
    await once(peer, 'connect')
    const peerClosed = once(peer, 'close')
    await server.close()
    await peerClosed
    expect(calls).toBe(0)
    expect(await socketState(socketPath)).toEqual({ exists: false })
    evidence.push({ case: 'idle-peer-close', calls, socketRemoved: true })
  } finally {
    peer.destroy()
  }
}, 1_000)

it('reports handler failure to the caller and retains the cause for shutdown', async () => {
  const root = await tempRoot('teams-local-work-control-handler-error-')
  const socketPath = join(root, 'control.sock')
  const failure = new Error('owned handler failed')
  const server = await startServer({ socketPath, handle: () => { throw failure } })
  await expect(sendLocalWorkControlRequest({ socketPath, frame: request() })).resolves.toEqual({
    kind: 'work.error', requestId: 'corr-1',
    error: { code: 'HOST_PROTOCOL', message: failure.message },
  })
  await expect(server.close()).rejects.toMatchObject({ code: 'HOST_PROTOCOL', cause: failure })
  expect(await socketState(socketPath)).toEqual({ exists: false })
  evidence.push({ case: 'handler-error-shutdown', error: failure.message, socketRemoved: true })
})

it('drains an already accepted dispatch after disconnect and closes admission before waiting', async () => {
  const root = await tempRoot('teams-local-work-control-disconnect-')
  const socketPath = join(root, '.internal', 'work-control.sock')
  const sideEffect = join(root, 'side-effect.jsonl')
  let delivery: LocalWorkControlDelivery | undefined
  let releaseDispatch = (): void => undefined
  const dispatchReleased = new Promise<void>(resolveDispatch => {
    releaseDispatch = resolveDispatch
  })
  let admitHandler = (): void => undefined
  const handlerAdmitted = new Promise<void>(resolveAdmit => {
    admitHandler = resolveAdmit
  })
  const server = await startServer({
    socketPath,
    handle: async item => {
      admitHandler()
      await item.disconnected
      await dispatchReleased
      expect(item.peer.destroyed).toBe(true)
      await writeFile(sideEffect, `${JSON.stringify({ kind: item.frame.kind, accepted: true })}\n`, { flag: 'a' })
      delivery = await item.respond(receipt(item.frame.kind, item.frame.business))
    },
  })

  const dispatched = createConnection(socketPath)
  dispatched.once('error', () => undefined)
  await new Promise<void>(resolveConnect => dispatched.once('connect', () => resolveConnect()))
  dispatched.write(`${JSON.stringify(request({ requestId: 'corr-disconnect' }))}\n`)
  await handlerAdmitted
  dispatched.destroy()
  let closeSettled = false
  const close = server.close().then(() => {
    closeSettled = true
  })
  await expect(sendLocalWorkControlRequest({ socketPath, frame: request({ requestId: 'corr-after-drain' }), timeoutMs: 100 }))
    .rejects.toMatchObject({ code: 'LOCAL_CONTROL_UNAVAILABLE' })
  expect(closeSettled).toBe(false)
  releaseDispatch()
  await close

  const effects = (await readFile(sideEffect, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  expect(effects).toEqual([{ kind: 'work.submit', accepted: true }])
  expect(delivery).toBe('unconfirmed')
  evidence.push({ case: 'post-dispatch-peer-disconnect', admissionClosedBeforeDrain: true, acceptedHandlerDrained: true, delivery, sideEffects: effects })
  await expect(socketState(socketPath)).resolves.toEqual({ exists: false })
})

it('stops accepting new Work and leaves existing dispatch to complete', async () => {
  const root = await tempRoot('teams-local-work-control-close-')
  const socketPath = join(root, '.internal', 'work-control.sock')
  let received: LocalWorkControlRequest | undefined
  let releaseDispatch = (): void => undefined
  const dispatchedReady = new Promise<void>(resolveDispatch => {
    releaseDispatch = resolveDispatch
  })
  const server = await startServer({
    socketPath,
    handle: async item => {
      received = item.frame
      await dispatchedReady
      await item.respond(receipt(item.frame.kind))
    },
  })
  const incoming = createConnection(socketPath)
  incoming.once('error', () => undefined)
  await new Promise<void>(resolveConnect => incoming.once('connect', () => resolveConnect()))
  incoming.write(`${JSON.stringify(request({ requestId: 'corr-before-close' }))}\n`)
  while (received === undefined) await new Promise<void>(resolveTick => setTimeout(resolveTick, 10))
  const close = server.close()
  releaseDispatch()
  await close
  incoming.end()

  await expect(sendLocalWorkControlRequest({ socketPath, frame: request({ requestId: 'corr-after-close' }), timeoutMs: 100 })).rejects.toMatchObject({ code: 'LOCAL_CONTROL_UNAVAILABLE' })
  expect(received?.requestId).toBe('corr-before-close')
  expect(await socketState(socketPath)).toEqual({ exists: false })
  evidence.push({ case: 'admission-closure', acceptedBeforeClose: received, rejectedAfterClose: true, socket: await socketState(socketPath) })
})

it('preserves the existing socket and rejects a non-owned existing path as unavailable', async () => {
  const root = await tempRoot('teams-local-work-control-existing-')
  const ownerPath = join(root, '.internal', 'work-control.sock')
  await mkdir(dirname(ownerPath), { recursive: true, mode: 0o700 })
  await chmod(dirname(ownerPath), 0o700)
  await writeFile(ownerPath, 'existing-owner\n', { mode: 0o600 })
  const before = await readFile(ownerPath, 'utf8')

  await expect(startLocalWorkControlListener({
    socketPath: ownerPath,
    launcherGeneration: 1,
    startToken: 'token',
    receivers: {},
    handler: async () => receipt('work.submit'),
  })).rejects.toMatchObject({ code: 'LOCAL_CONTROL_UNAVAILABLE' })
  expect(await readFile(ownerPath, 'utf8')).toBe(before)
  expect((await stat(ownerPath)).mode & 0o777).toBe(0o600)
  evidence.push({ case: 'do-not-replace-or-alter-existing-socket', preserved: before })
})

it('rejects an overlong Unix socket path without leaving its parent directory or listener behind', async () => {
  const root = await tempRoot('teams-u4-long-')
  const longDirectory = join(root, 'x'.repeat(140))
  const socketPath = join(longDirectory, '.internal', 'work-control.sock')

  await expect(startLocalWorkControlListener({
    socketPath,
    launcherGeneration: 1,
    startToken: 'token',
    receivers: {},
    handler: async () => receipt('work.submit'),
  })).rejects.toMatchObject({ code: 'LOCAL_CONTROL_UNAVAILABLE' })

  expect(await socketState(socketPath)).toEqual({ exists: false })
  await expect(socketState(longDirectory)).resolves.toEqual({ exists: true, mode: 0o700, isSocket: false })
  evidence.push({ case: 'overlong-socket-path-rejected', socketPathBytes: Buffer.byteLength(socketPath), residualSocket: false })
})

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '.' : path.slice(0, index)
}
