// Node host for the Teams DAGpipe runner.
//
// It owns the per-execution AgentWorkClient channels and dispatches typed
// `host.call` frames to the real public Work methods. The SDK Runtime owns node
// scheduling; this host never re-runs or sorts a graph and never reconstructs
// control state from the runner journal.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import type { JsonValue, RequestState } from '../../control-protocol/agent-services.ts';
import { RelayProtocolError } from '../../control-protocol/relay-codec.ts';
import {
  AgentWorkTransportError,
  type AgentWorkChannel,
  type AgentWorkClient,
  type AgentWorkTarget,
} from '../agent-work-client.ts';
import {
  decodeAgentWorkServiceSelection,
  decodeResourceDemands,
  decodeRunnerFrame,
  HostProtocolError,
  requiredInteger,
  requiredObject,
  requiredString,
  type ArcValue,
  type ExecutionResultFrame,
  type HostCallFrame,
  type HostOperationResult,
  type JournalEvent,
  type RunnerFinalFrame,
} from './protocol.ts';

/** Fixed typed port: the host operation each registered Operator may request. */
const OPERATOR_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  'teams.resolve-peer-service': ['agentWork.findProvider'],
  'teams.open-work-link': ['agentWork.open'],
  'teams.admit-provider-work': ['agentWork.propose'],
  'teams.request-provider-work': ['agentWork.request'],
  'teams.settle-provider-work': ['agentWork.close', 'agentWork.dispose'],
  'teams.return-held-work': ['agentWork.dispose'],
  'teams.continue-provider-work': ['agentWork.request'],
  'teams.close-provider-work': ['agentWork.close', 'agentWork.dispose'],
  'teams.query-provider-request': ['agentWork.get'],
  'teams.return-work-observation': [],
};

const KNOWN_OPERATIONS = new Set(Object.values(OPERATOR_OPERATIONS).flat());

export interface ExecutionIntentControl {
  readonly receiverAgentId: string;
  readonly targetAgentId: string;
  readonly targetGeneration?: number;
  readonly linkGeneration?: number;
  readonly serviceSelection?: 'endpoint' | 'capability';
  readonly capabilityId: string;
  readonly capabilityVersion: string;
  readonly operation: string;
  readonly workId: string;
  readonly requestId?: string;
}

export interface WorkIntentControl extends ExecutionIntentControl {
  readonly requestId: string;
  readonly policyRevision: number;
  readonly demands: readonly { readonly resourceId: string; readonly amount: number }[];
}

export interface WorkOpenIntentControl extends ExecutionIntentControl {
  readonly targetGeneration: number;
  readonly requestId: string;
  readonly policyRevision: number;
  readonly demands: readonly { readonly resourceId: string; readonly amount: number }[];
}

export interface WorkRequestIntentControl extends ExecutionIntentControl {
  readonly targetGeneration: number;
  readonly requestId: string;
  readonly demands: readonly { readonly resourceId: string; readonly amount: number }[];
}

export interface WorkCloseIntentControl extends ExecutionIntentControl {
  readonly targetGeneration: number;
}

export interface QueryIntentControl extends ExecutionIntentControl {
  readonly requestId: string;
  readonly targetGeneration?: number;
  readonly linkGeneration?: number;
  readonly serviceSelection?: 'endpoint' | 'capability';
}

export type ExecutionControl = WorkIntentControl | WorkOpenIntentControl | WorkRequestIntentControl | WorkCloseIntentControl | QueryIntentControl;

export interface WorkExecutionRequest {
  readonly runnerPath: string;
  readonly graphPath: string;
  readonly projectId: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly intent: { readonly control: ExecutionControl; readonly business?: JsonValue };
  readonly capabilities?: readonly string[];
  readonly onHostCall?: (frame: HostCallFrame) => void;
}

export interface ProjectExecutionControl {
  readonly projectId: string;
  readonly graphId: string;
  readonly graphVersion: string;
  readonly executionId: string;
  readonly attemptId: string;
  readonly workId?: string;
  readonly requestId?: string;
  readonly providerAgentId?: string;
  readonly targetGeneration?: number;
  readonly linkGeneration?: number;
  readonly serviceSelection?: 'endpoint' | 'capability';
  readonly capabilityId?: string;
  readonly capabilityVersion?: string;
  readonly operation?: string;
  readonly requestState?: RequestState;
  readonly workClosure?: 'closed' | 'retained' | 'close-failed';
  readonly deliveryState?: 'unconfirmed';
  readonly observed?: true;
  readonly error?: { readonly code: string; readonly message: string };
}

export interface ProjectExecutionReceipt {
  readonly status: 'completed' | 'failed';
  readonly control: ProjectExecutionControl;
  readonly business?: JsonValue;
  readonly cleanup: {
    readonly channelsOpened: number;
    readonly channelsDisposed: number;
    readonly cleanupError?: { readonly code: string; readonly message: string };
  };
  readonly evidence: {
    readonly execution: 'completed' | 'failed' | 'compile-failed' | 'runner-failed';
    readonly graphId: string;
    readonly graphVersion: string;
    readonly nodeSchedule: readonly string[];
    readonly nodeCompletion: readonly string[];
    readonly hostOperations: readonly string[];
    readonly errorKind?: string;
  };
}

interface ExecutionContext {
  readonly channels: Map<string, AgentWorkChannel>;
  channelsOpened: number;
  channelsDisposed: number;
  nextChannelRef: number;
  resolvedTarget?: AgentWorkTarget;
  requestAttempted: boolean;
  closeAttempted: boolean;
  transportUnconfirmed: boolean;
  error?: { readonly code: string; readonly message: string; readonly deliveryState?: 'unconfirmed'; readonly operation?: string };
  cleanupError?: { readonly code: string; readonly message: string };
}

function describeError(error: unknown): { code: string; message: string; deliveryState?: 'unconfirmed' } {
  if (error instanceof AgentWorkTransportError) {
    return { code: error.code, message: error.message, deliveryState: 'unconfirmed' };
  }
  if (error instanceof RelayProtocolError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof HostProtocolError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { code: typeof code === 'string' && code.length > 0 ? code : 'EXECUTION_FAILED', message: error.message };
  }
  return { code: 'EXECUTION_FAILED', message: 'host operation failed' };
}

function decodeTarget(value: unknown): AgentWorkTarget {
  const target = requiredObject(value, 'control.args.target');
  return {
    providerAgentId: requiredString(target.providerAgentId, 'control.args.target.providerAgentId'),
    generation: requiredInteger(target.generation, 'control.args.target.generation'),
    capabilityId: requiredString(target.capabilityId, 'control.args.target.capabilityId'),
    capabilityVersion: requiredString(target.capabilityVersion, 'control.args.target.capabilityVersion'),
    operation: requiredString(target.operation, 'control.args.target.operation'),
    serviceSelection: target.serviceSelection === 'capability' ? 'capability' : 'endpoint',
    ...(target.endpoint === undefined ? {} : { endpoint: target.endpoint as AgentWorkTarget['endpoint'] }),
  };
}

function replyControl(reply: { readonly control: unknown }): JsonValue {
  return reply.control as JsonValue;
}

function channelFor(context: ExecutionContext, value: unknown): { channelRef: string; channel: AgentWorkChannel } {
  const channelRef = requiredString(value, 'control.args.channelRef');
  const channel = context.channels.get(channelRef);
  if (!channel) {
    throw new HostProtocolError('INVALID_INPUT', `unknown channelRef ${channelRef}`);
  }
  return { channelRef, channel };
}

function createHostHandler(
  client: AgentWorkClient,
  context: ExecutionContext,
): (frame: HostCallFrame) => Promise<HostOperationResult> {
  return async frame => {
    switch (frame.control.operation) {
      case 'agentWork.findProvider': {
        const args = frame.control.args;
        const providerAgentId = args.providerAgentId;
        const serviceSelection = args.serviceSelection === undefined
          ? undefined
          : decodeAgentWorkServiceSelection(args.serviceSelection, 'control.args.serviceSelection');
        const target = await client.findProvider({
          capabilityId: requiredString(args.capabilityId, 'control.args.capabilityId'),
          capabilityVersion: requiredString(args.capabilityVersion, 'control.args.capabilityVersion'),
          operation: requiredString(args.operation, 'control.args.operation'),
          ...(providerAgentId === undefined ? {} : { providerAgentId: requiredString(providerAgentId, 'control.args.providerAgentId') }),
          ...(serviceSelection === undefined ? {} : { serviceSelection }),
        });
        context.resolvedTarget = target;
        return { result: { target: target as unknown as JsonValue } as JsonValue };
      }
      case 'agentWork.open': {
        const channel = await client.open(decodeTarget(frame.control.args.target));
        const channelRef = `channel-${context.nextChannelRef}`;
        context.nextChannelRef += 1;
        context.channels.set(channelRef, channel);
        context.channelsOpened += 1;
        return { result: { channelRef } as JsonValue };
      }
      case 'agentWork.propose': {
        const args = frame.control.args;
        const { channel } = channelFor(context, args.channelRef);
        const work = await channel.propose({
          workId: requiredString(args.workId, 'control.args.workId'),
          capabilityId: requiredString(args.capabilityId, 'control.args.capabilityId'),
          capabilityVersion: requiredString(args.capabilityVersion, 'control.args.capabilityVersion'),
          policyRevision: requiredInteger(args.policyRevision, 'control.args.policyRevision'),
        });
        return { result: { accepted: work as unknown as JsonValue } as JsonValue };
      }
      case 'agentWork.request': {
        const args = frame.control.args;
        const { channel } = channelFor(context, args.channelRef);
        if (frame.business === undefined) throw new HostProtocolError('INVALID_INPUT', 'host.call business is required for agentWork.request');
        context.requestAttempted = true;
        const reply = await channel.request({
          workId: requiredString(args.workId, 'control.args.workId'),
          requestId: requiredString(args.requestId, 'control.args.requestId'),
          operation: requiredString(args.operation, 'control.args.operation'),
          demands: decodeResourceDemands(args.demands, 'control.args.demands'),
          payload: frame.business,
        });
        return {
          result: { replyControl: replyControl(reply) } as JsonValue,
          ...(reply.payload === undefined ? {} : { business: reply.payload }),
        };
      }
      case 'agentWork.get': {
        const args = frame.control.args;
        const { channel } = channelFor(context, args.channelRef);
        const reply = await channel.get(
          requiredString(args.workId, 'control.args.workId'),
          requiredString(args.requestId, 'control.args.requestId'),
        );
        return {
          result: { replyControl: replyControl(reply) } as JsonValue,
          ...(reply.payload === undefined ? {} : { business: reply.payload }),
        };
      }
      case 'agentWork.close': {
        const args = frame.control.args;
        const { channel } = channelFor(context, args.channelRef);
        context.closeAttempted = true;
        const work = await channel.close(requiredString(args.workId, 'control.args.workId'));
        return { result: { work: work as unknown as JsonValue } as JsonValue };
      }
      case 'agentWork.dispose': {
        const args = frame.control.args;
        const { channelRef, channel } = channelFor(context, args.channelRef);
        await channel.dispose();
        context.channels.delete(channelRef);
        context.channelsDisposed += 1;
        return { result: {} as JsonValue };
      }
      default: {
        const operation = (frame.control as { readonly operation?: unknown }).operation;
        throw new HostProtocolError('INVALID_INPUT', `unknown host operation ${String(operation)}`);
      }
    }
  };
}

function validateHostCall(
  frame: HostCallFrame,
  expected: { readonly projectId: string; readonly executionId: string; readonly attemptId: string },
): string | undefined {
  const control = frame.control;
  if (control === null || typeof control !== 'object') return 'host.call lacks control object';
  const operation = (control as { readonly operation?: unknown }).operation;
  if (typeof operation !== 'string' || operation.length === 0) return 'host.call control.operation is missing';
  const allowed = OPERATOR_OPERATIONS[control.operator];
  if (!allowed) return `host.call operator ${String(control.operator)} is not a registered Teams Operator`;
  if (!allowed.includes(operation)) {
    return `host.call operation ${operation} is not allowed for ${control.operator}`;
  }
  if (!KNOWN_OPERATIONS.has(operation)) return `host.call operation ${operation} is unknown`;
  const identity = control.identity;
  if (identity === null || typeof identity !== 'object') return 'host.call identity is missing';
  if (identity.project_id !== expected.projectId) return 'host.call project identity mismatch';
  if (identity.execution_id !== expected.executionId) return 'host.call execution identity mismatch';
  if (identity.attempt_id !== expected.attemptId) return 'host.call attempt identity mismatch';
  const expectedRequestId = `${expected.executionId}/${control.node_id}/${expected.attemptId}`;
  if (control.request_id !== expectedRequestId) {
    return `host.call request_id mismatch: expected ${expectedRequestId}, got ${String(control.request_id)}`;
  }
  const args = (control as { readonly args?: unknown }).args;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return 'host.call control.args must be an object';
  }
  if (operation === 'agentWork.request') {
    if (!Object.hasOwn(frame, 'business')) return 'host.call business is required for agentWork.request';
  } else if (Object.hasOwn(frame, 'business')) {
    return `host.call business is not allowed for ${operation}`;
  }
  return undefined;
}

function writeFrame(child: ChildProcessWithoutNullStreams, frame: unknown): Promise<void> {
  if (child.stdin.destroyed || child.stdin.writableEnded) return Promise.resolve();
  return new Promise((resolveWrite) => {
    child.stdin.write(`${JSON.stringify(frame)}\n`, () => resolveWrite());
  });
}

function journalNodes(journal: readonly JournalEvent[], kind: string): string[] {
  return journal.filter(event => event.kind === kind).map(event => String(event.node_id));
}

export interface RunnerObservation {
  readonly final?: RunnerFinalFrame;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly finalCount: number;
}

async function runRunner(
  client: AgentWorkClient,
  request: WorkExecutionRequest,
  context: ExecutionContext,
  hostOperations: string[],
): Promise<RunnerObservation> {
  const args = [
    'run',
    '--graph', resolve(request.graphPath),
    '--project-id', request.projectId,
    '--execution-id', request.executionId,
    '--attempt-id', request.attemptId,
    '--input', JSON.stringify(request.intent),
  ];
  if (request.capabilities) args.push('--capabilities', JSON.stringify(request.capabilities));

  const child = spawn(request.runnerPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const handler = createHostHandler(client, context);
  const expected = { projectId: request.projectId, executionId: request.executionId, attemptId: request.attemptId };
  let final: RunnerFinalFrame | undefined;
  let finalCount = 0;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.stdin.on('error', () => undefined);
  child.on('error', error => {
    // A runner that cannot even be started is an explicit execution failure; it
    // must not crash the host or be reported as a business outcome.
    context.error ??= { code: 'RUNNER_UNAVAILABLE', message: `runner could not be started: ${error.message}` };
  });
  const close = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
    child.on('close', (code, signal) => resolveClose({ code, signal }));
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let frame;
    try {
      frame = decodeRunnerFrame(line);
    } catch (error) {
      context.error ??= describeError(error);
      child.kill('SIGKILL');
      break;
    }
    if (finalCount > 0) {
      finalCount += 1;
      context.error ??= {
        code: 'HOST_PROTOCOL',
        message: frame.type === 'host.call'
          ? 'runner emitted a host.call after its terminal frame'
          : 'runner emitted a second terminal frame',
      };
      child.kill('SIGKILL');
      break;
    }
    if (frame.type === 'host.call') {
      const validationError = validateHostCall(frame, expected);
      if (validationError) {
        context.error ??= { code: 'HOST_PROTOCOL', message: validationError };
        await writeFrame(child, {
          type: 'host.error',
          control: {
            request_id: frame.control.request_id ?? '',
            operation: frame.control.operation,
            status: 'error',
            error: { code: 'HOST_PROTOCOL', message: validationError },
          },
        });
        continue;
      }
      hostOperations.push(frame.control.operation);
      request.onHostCall?.(frame);
      try {
        const response = await handler(frame);
        await writeFrame(child, {
          type: 'host.result',
          control: {
            request_id: frame.control.request_id,
            operation: frame.control.operation,
            status: 'ok',
            result: response.result,
          },
          ...(response.business === undefined ? {} : { business: response.business }),
        });
      } catch (error) {
        const described = describeError(error);
        if (described.deliveryState === 'unconfirmed') context.transportUnconfirmed = true;
        context.error ??= { ...described, operation: frame.control.operation };
        await writeFrame(child, {
          type: 'host.error',
          control: {
            request_id: frame.control.request_id,
            operation: frame.control.operation,
            status: 'error',
            error: {
              code: described.code,
              message: described.message,
              ...(described.deliveryState === undefined ? {} : { deliveryState: described.deliveryState }),
            },
          },
        });
      }
      continue;
    }
    if (frame.type === 'execution.result'
      && (frame.identity.project_id !== expected.projectId
        || frame.identity.execution_id !== expected.executionId
        || frame.identity.attempt_id !== expected.attemptId)) {
      context.error ??= { code: 'HOST_PROTOCOL', message: 'runner final identity mismatch' };
      child.kill('SIGKILL');
      break;
    }
    finalCount = 1;
    final = frame;
    child.stdin.end();
  }
  const closed = await close;
  return { final, exitCode: closed.code, signal: closed.signal, stderr, finalCount };
}

async function disposeChannels(context: ExecutionContext, hostOperations: string[]): Promise<void> {
  for (const [channelRef, channel] of context.channels) {
    try {
      await channel.dispose();
      context.channelsDisposed += 1;
      hostOperations.push('agentWork.dispose');
    } catch (error) {
      context.cleanupError ??= describeError(error);
    }
    context.channels.delete(channelRef);
  }
}

function emptyEvidence(execution: ProjectExecutionReceipt['evidence']['execution']): ProjectExecutionReceipt['evidence'] {
  return { execution, graphId: '', graphVersion: '', nodeSchedule: [], nodeCompletion: [], hostOperations: [] };
}

function receiptBinding(
  control: ExecutionControl,
  resolvedTarget?: AgentWorkTarget,
  includeResolvedLink = false,
): Partial<ProjectExecutionControl> {
  const targetGeneration = control.targetGeneration ?? resolvedTarget?.generation;
  return {
    ...(control.workId === undefined ? {} : { workId: control.workId }),
    ...(control.requestId === undefined ? {} : { requestId: control.requestId }),
    ...(control.targetAgentId === undefined ? {} : { providerAgentId: control.targetAgentId }),
    ...(targetGeneration === undefined ? {} : { targetGeneration }),
    ...(control.linkGeneration === undefined
      ? (includeResolvedLink && resolvedTarget !== undefined ? { linkGeneration: resolvedTarget.generation } : {})
      : { linkGeneration: control.linkGeneration }),
    ...(control.serviceSelection === undefined ? {} : { serviceSelection: control.serviceSelection }),
    ...(control.capabilityId === undefined ? {} : { capabilityId: control.capabilityId }),
    ...(control.capabilityVersion === undefined ? {} : { capabilityVersion: control.capabilityVersion }),
    ...(control.operation === undefined ? {} : { operation: control.operation }),
  };
}

function validateExecutionIntent(
  control: ExecutionControl,
  graphPath: string,
  business: JsonValue | undefined,
): { readonly code: string; readonly message: string } | undefined {
  const graph = graphPath.replaceAll('\\', '/').split('/').pop() ?? graphPath;
  const agentWork = graph === 'agent-work.graph.json';
  const persistent = graph === 'work-open.graph.json' || graph === 'work-request.graph.json' || graph === 'work-close.graph.json';
  const query = graph === 'work-query.graph.json';
  if (!agentWork && !persistent && !query) {
    return { code: 'INVALID_INPUT', message: `unsupported Work graph ${graph}` };
  }
  if (persistent && control.serviceSelection !== 'capability') {
    return { code: 'INVALID_INPUT', message: `${graph} requires serviceSelection=capability` };
  }
  if (agentWork && control.serviceSelection !== undefined && control.serviceSelection !== 'endpoint') {
    return { code: 'INVALID_INPUT', message: `${graph} only supports endpoint service selection` };
  }
  if (query && control.serviceSelection !== undefined && control.serviceSelection !== 'endpoint' && control.serviceSelection !== 'capability') {
    return { code: 'INVALID_INPUT', message: `${graph} serviceSelection must be endpoint or capability` };
  }
  try {
    requiredString(control.receiverAgentId, 'intent.control.receiverAgentId');
    requiredString(control.targetAgentId, 'intent.control.targetAgentId');
    requiredString(control.capabilityId, 'intent.control.capabilityId');
    requiredString(control.capabilityVersion, 'intent.control.capabilityVersion');
    requiredString(control.operation, 'intent.control.operation');
    requiredString(control.workId, 'intent.control.workId');
    if (agentWork || graph === 'work-open.graph.json' || graph === 'work-request.graph.json' || query) {
      requiredString(control.requestId, 'intent.control.requestId');
    }
    if (control.targetGeneration !== undefined) requiredInteger(control.targetGeneration, 'intent.control.targetGeneration');
    if (control.linkGeneration !== undefined) requiredInteger(control.linkGeneration, 'intent.control.linkGeneration');
    if (query && control.serviceSelection === 'capability' && control.targetGeneration === undefined) {
      throw new HostProtocolError('INVALID_INPUT', 'intent.control.targetGeneration is required for capability query');
    }
    if (persistent && control.targetGeneration === undefined) {
      throw new HostProtocolError('INVALID_INPUT', 'intent.control.targetGeneration is required for persistent Work');
    }
    if (persistent && control.linkGeneration !== undefined) {
      throw new HostProtocolError('INVALID_INPUT', `${graph} forbids linkGeneration`);
    }
    if (agentWork || graph === 'work-open.graph.json' || graph === 'work-request.graph.json') {
      requiredInteger((control as Partial<WorkIntentControl>).policyRevision, 'intent.control.policyRevision');
      decodeResourceDemands((control as Partial<WorkIntentControl>).demands, 'intent.control.demands');
      if (business === undefined) throw new HostProtocolError('INVALID_INPUT', 'intent.business is required for Work execution');
    }
  } catch (error) {
    return describeError(error);
  }
  return undefined;
}

/**
 * Run one Teams Work graph execution through the real SDK runner and the real
 * AgentWorkClient. Returns exactly one typed ProjectExecutionReceipt; provider
 * resource responsibility stays in the provider ledger.
 */
export async function runWorkExecution(
  client: AgentWorkClient,
  request: WorkExecutionRequest,
): Promise<ProjectExecutionReceipt> {
  const invalidInputError = validateExecutionIntent(request.intent.control, request.graphPath, request.intent.business);
  if (invalidInputError) {
    const invalidControl = request.intent.control;
    return {
      status: 'failed',
      control: {
        projectId: request.projectId,
        graphId: '',
        graphVersion: '',
        executionId: request.executionId,
        attemptId: request.attemptId,
        ...receiptBinding(invalidControl, undefined,
          request.graphPath.endsWith('work-query.graph.json') && invalidControl.serviceSelection === 'capability'),
        error: invalidInputError,
      },
      cleanup: { channelsOpened: 0, channelsDisposed: 0 },
      evidence: { ...emptyEvidence('failed'), hostOperations: [] },
    };
  }
  const context: ExecutionContext = {
    channels: new Map(),
    channelsOpened: 0,
    channelsDisposed: 0,
    nextChannelRef: 1,
    requestAttempted: false,
    closeAttempted: false,
    transportUnconfirmed: false,
  };
  const hostOperations: string[] = [];
  let observation: RunnerObservation | undefined;
  try {
    observation = await runRunner(client, request, context, hostOperations);
  } finally {
    await disposeChannels(context, hostOperations);
  }

  const cleanup = {
    channelsOpened: context.channelsOpened,
    channelsDisposed: context.channelsDisposed,
    ...(context.cleanupError === undefined ? {} : { cleanupError: context.cleanupError }),
  };
  const intentControl = request.intent.control;
  const final = observation.final;

  if (!final) {
    const error = context.error ?? { code: 'EXECUTION_FAILED', message: 'runner exited without a final frame' };
    return {
      status: 'failed',
      control: {
        projectId: request.projectId,
        graphId: '',
        graphVersion: '',
        executionId: request.executionId,
        attemptId: request.attemptId,
        ...receiptBinding(intentControl, context.resolvedTarget,
          request.graphPath.endsWith('work-query.graph.json') && intentControl.serviceSelection === 'capability'),
        ...(context.transportUnconfirmed ? { deliveryState: 'unconfirmed' as const } : {}),
        ...(context.error?.operation === 'agentWork.close' && !context.transportUnconfirmed ? { workClosure: 'close-failed' as const } : {}),
        ...(context.error?.operation === 'agentWork.request' && context.error?.code === 'RESULT_UNKNOWN' && !context.transportUnconfirmed
          ? { requestState: 'unknown' as RequestState, workClosure: 'retained' as const }
          : {}),
        error,
      },
      cleanup,
      evidence: { ...emptyEvidence('runner-failed'), hostOperations },
    };
  }

  if (final.type === 'execution.result' && context.error === undefined && observation.finalCount === 1) {
    return buildCompletedReceipt(request, final, context, cleanup, hostOperations);
  }

  const execution = final.type === 'compile.failure' ? 'compile-failed'
    : final.type === 'usage.failure' || final.type === 'run.failure' ? 'runner-failed' : 'failed';
  const fallbackMessage = final.type === 'execution.failure' || final.type === 'compile.failure'
    || final.type === 'usage.failure' || final.type === 'run.failure'
    ? final.message
    : 'runner returned an unexpected final frame';
  const error = context.error ?? { code: 'EXECUTION_FAILED', message: fallbackMessage };
  const journal = 'journal' in final ? final.journal : [];
  return {
    status: 'failed',
    control: {
      projectId: request.projectId,
      graphId: 'graph_id' in final && final.graph_id ? final.graph_id : '',
      graphVersion: 'graph_version' in final && final.graph_version ? final.graph_version : '',
      executionId: request.executionId,
      attemptId: request.attemptId,
      ...receiptBinding(intentControl, context.resolvedTarget,
        request.graphPath.endsWith('work-query.graph.json') && intentControl.serviceSelection === 'capability'),
      ...(context.transportUnconfirmed ? { deliveryState: 'unconfirmed' as const } : {}),
      ...(context.error?.operation === 'agentWork.close' && !context.transportUnconfirmed ? { workClosure: 'close-failed' as const } : {}),
      ...(context.error?.operation === 'agentWork.request' && context.error?.code === 'RESULT_UNKNOWN' && !context.transportUnconfirmed
        ? { requestState: 'unknown' as RequestState, workClosure: 'retained' as const }
        : {}),
      error,
    },
    cleanup,
    evidence: {
      execution,
      graphId: 'graph_id' in final && final.graph_id ? final.graph_id : '',
      graphVersion: 'graph_version' in final && final.graph_version ? final.graph_version : '',
      nodeSchedule: journalNodes(journal, 'node_scheduled'),
      nodeCompletion: journalNodes(journal, 'node_completed'),
      hostOperations,
      ...('kind' in final ? { errorKind: final.kind } : {}),
    },
  };
}

function buildCompletedReceipt(
  request: WorkExecutionRequest,
  final: ExecutionResultFrame,
  context: ExecutionContext,
  cleanup: ProjectExecutionReceipt['cleanup'],
  hostOperations: string[],
): ProjectExecutionReceipt {
  const outputArcs = final.compiled.output_arcs;
  if (outputArcs.length !== 1) {
    throw new HostProtocolError('HOST_PROTOCOL', `compiled graph declares ${outputArcs.length} output ARCs`);
  }
  const arc: ArcValue | undefined = final.outputs[outputArcs[0]];
  if (!arc) {
    throw new HostProtocolError('HOST_PROTOCOL', `runner result lacks output ARC ${outputArcs[0]}`);
  }
  const control = arc.payload.control;
  const target = control.target as Record<string, JsonValue> | undefined;
  const closeError = control.closeError as { code?: unknown; message?: unknown; deliveryState?: unknown } | undefined;
  const workClosure = control.workClosure as ProjectExecutionControl['workClosure'];
  const requestState = control.requestState as RequestState | undefined;
  const providerAgentId = typeof control.targetAgentId === 'string'
    ? control.targetAgentId
    : target && typeof target.providerAgentId === 'string' ? target.providerAgentId : undefined;
  const targetGeneration = typeof control.targetGeneration === 'number'
    ? control.targetGeneration
    : target && typeof target.generation === 'number' ? target.generation : undefined;
  const linkGeneration = final.compiled.id === 'agentteams.work-query' && control.serviceSelection === 'capability'
    ? target && typeof target.generation === 'number' ? target.generation : undefined
    : typeof control.linkGeneration === 'number' ? control.linkGeneration : undefined;
  const deliveryState = control.deliveryState === 'unconfirmed' || closeError?.deliveryState === 'unconfirmed'
    ? 'unconfirmed' as const
    : undefined;
  return {
    status: workClosure === 'close-failed' ? 'failed' : 'completed',
    control: {
      projectId: final.identity.project_id,
      graphId: final.compiled.id,
      graphVersion: final.compiled.version,
      executionId: final.identity.execution_id,
      attemptId: final.identity.attempt_id,
      ...(typeof control.workId === 'string' ? { workId: control.workId } : {}),
      ...(typeof control.requestId === 'string' ? { requestId: control.requestId } : {}),
      ...(providerAgentId === undefined ? {} : { providerAgentId }),
      ...(targetGeneration === undefined ? {} : { targetGeneration }),
      ...(linkGeneration === undefined ? {} : { linkGeneration }),
      ...(control.serviceSelection === 'endpoint' || control.serviceSelection === 'capability' ? { serviceSelection: control.serviceSelection } : {}),
      ...(typeof control.capabilityId === 'string' ? { capabilityId: control.capabilityId } : {}),
      ...(typeof control.capabilityVersion === 'string' ? { capabilityVersion: control.capabilityVersion } : {}),
      ...(typeof control.operation === 'string' ? { operation: control.operation } : {}),
      ...(requestState === undefined ? {} : { requestState }),
      ...(workClosure === undefined ? {} : { workClosure }),
      ...(deliveryState === undefined ? {} : { deliveryState }),
      ...(control.observed === true ? { observed: true as const } : {}),
      ...(closeError === undefined ? {} : {
        error: {
          code: typeof closeError.code === 'string' ? closeError.code : 'CLEANUP_FAILED',
          message: typeof closeError.message === 'string' ? closeError.message : 'Work close failed',
        },
      }),
    },
    ...(arc.payload.business === undefined ? {} : { business: arc.payload.business }),
    cleanup,
    evidence: {
      execution: 'completed',
      graphId: final.compiled.id,
      graphVersion: final.compiled.version,
      nodeSchedule: journalNodes(final.journal, 'node_scheduled'),
      nodeCompletion: journalNodes(final.journal, 'node_completed'),
      hostOperations,
    },
  };
}
