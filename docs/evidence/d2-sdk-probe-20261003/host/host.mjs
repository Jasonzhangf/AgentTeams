#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const evidenceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cases = JSON.parse(await readFile(join(evidenceRoot, 'cases.json'), 'utf8'));
let runnerSpawnCount = 0;
const expectedIdentity = {
  project_id: 'agentteams-d2-probe',
  graph_id: 'd2_sdk_host_probe',
  graph_version: '1',
  execution_id: 'd2-probe-execution',
  attempt_id: '1',
};

function usage() {
  console.error('usage: node host.mjs --runner <absolute-runner-path> --receipt <build-receipt> [--case <name>] [--results <path>]');
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === '--runner' || name === '--receipt' || name === '--case' || name === '--results') {
      if (!value) throw new Error(`${name} requires a value`);
      options[name.slice(2)] = value;
      index += 1;
    } else {
      throw new Error(`unknown argument ${name}`);
    }
  }
  return options;
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

async function verifyRecordedFile(record, root, label) {
  const recordedPath = requiredString(record?.path, `${label}.path`);
  const expectedHash = requiredString(record?.sha256, `${label}.sha256`);
  const candidate = resolve(root, recordedPath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`${label}.path escapes its receipt root`);
  }

  let actualHash;
  try {
    actualHash = sha256(await readFile(candidate));
  } catch (error) {
    throw new Error(`${label} is not readable: ${error.message}`);
  }
  if (actualHash !== expectedHash) {
    throw new Error(`${label} sha256 mismatch: expected ${expectedHash}, got ${actualHash}`);
  }
  return candidate;
}

function currentToolchain() {
  return {
    node: process.version,
    cargo: execFileSync('cargo', ['-vV'], { encoding: 'utf8' }).trim(),
    rustc: execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).trim(),
  };
}

async function verifyReceipt(receipt, runnerPath) {
  if (receipt?.protocol !== 'd2-sdk-probe-build-receipt' || receipt.version !== 1) {
    throw new Error('build receipt protocol/version mismatch');
  }

  for (const [key, label] of [
    ['build_entry', 'inputs.build_entry'],
    ['driver', 'inputs.driver'],
    ['probe_source', 'inputs.probe_source'],
    ['build_template', 'inputs.build_template'],
    ['lock', 'inputs.lock'],
  ]) {
    await verifyRecordedFile(receipt.inputs?.[key], evidenceRoot, label);
  }
  for (const [key, label] of [
    ['cases', 'fixtures.cases'],
    ['input_a', 'fixtures.input_a'],
    ['input_b', 'fixtures.input_b'],
  ]) {
    await verifyRecordedFile(receipt.fixtures?.[key], evidenceRoot, label);
  }

  if (!isAbsolute(receipt.sdk?.path)) {
    throw new Error('sdk.path must be an absolute build-time path');
  }
  let sdkPath;
  try {
    sdkPath = await realpath(receipt.sdk.path);
  } catch (error) {
    throw new Error(`sdk.path is not resolvable: ${error.message}`);
  }
  if (sdkPath !== receipt.sdk.path) {
    throw new Error(`sdk.path changed: expected ${receipt.sdk.path}, got ${sdkPath}`);
  }
  if (receipt.sdk.crate !== 'pipeline_runtime') {
    throw new Error(`sdk.crate mismatch: expected pipeline_runtime, got ${receipt.sdk.crate}`);
  }
  await verifyRecordedFile(receipt.sdk.manifest, sdkPath, 'sdk.manifest');
  if (!Array.isArray(receipt.sdk.sources) || receipt.sdk.sources.length === 0) {
    throw new Error('sdk.sources is empty');
  }
  for (const [index, source] of receipt.sdk.sources.entries()) {
    await verifyRecordedFile(source, sdkPath, `sdk.sources[${index}]`);
  }
  if (receipt.resolution?.package !== 'pipeline_runtime') {
    throw new Error(`resolution.package mismatch: ${receipt.resolution?.package}`);
  }
  if (receipt.resolution.version !== receipt.sdk.version) {
    throw new Error(`resolution.version mismatch: ${receipt.resolution.version} != ${receipt.sdk.version}`);
  }
  if (resolve(receipt.resolution.manifest_path) !== join(sdkPath, 'Cargo.toml')) {
    throw new Error(`resolution.manifest_path mismatch: ${receipt.resolution.manifest_path}`);
  }
  if (receipt.resolution.source !== null) {
    throw new Error(`resolution.source is not a path dependency: ${receipt.resolution.source}`);
  }

  const artifactPath = resolve(evidenceRoot, requiredString(receipt.artifact?.path, 'artifact.path'));
  if (artifactPath !== runnerPath) {
    throw new Error(`artifact path mismatch: expected ${artifactPath}, got ${runnerPath}`);
  }
  const artifactBytes = await readFile(runnerPath);
  const artifactHash = sha256(artifactBytes);
  if (artifactHash !== requiredString(receipt.artifact?.sha256, 'artifact.sha256')) {
    throw new Error(`artifact sha256 mismatch: expected ${receipt.artifact.sha256}, got ${artifactHash}`);
  }
  const artifactSize = (await stat(runnerPath)).size;
  if (artifactSize !== receipt.artifact.size) {
    throw new Error(`artifact size mismatch: expected ${receipt.artifact.size}, got ${artifactSize}`);
  }

  const toolchain = currentToolchain();
  for (const key of ['node', 'cargo', 'rustc']) {
    if (receipt.toolchain?.[key] !== toolchain[key]) {
      throw new Error(`toolchain ${key} mismatch: expected ${receipt.toolchain?.[key]}, got ${toolchain[key]}`);
    }
  }
  return { artifactHash, toolchain };
}

async function identityMismatchChecks(receipt, runnerPath) {
  const checks = [];
  const beforeSpawns = runnerSpawnCount;
  const mutations = [
    {
      label: 'artifact sha256',
      mutate: (candidate) => {
        candidate.artifact.sha256 = '0'.repeat(64);
      },
    },
    {
      label: 'SDK source sha256',
      mutate: (candidate) => {
        candidate.sdk.sources[0].sha256 = '0'.repeat(64);
      },
    },
  ];

  for (const mutation of mutations) {
    const candidate = JSON.parse(JSON.stringify(receipt));
    mutation.mutate(candidate);
    let rejected = false;
    let errorMessage = '';
    try {
      await verifyReceipt(candidate, runnerPath);
    } catch (error) {
      rejected = true;
      errorMessage = error.message;
    }
    check(checks, `${mutation.label} mismatch rejected`, rejected, rejected, true);
    check(checks, `${mutation.label} mismatch zero runner spawn`, runnerSpawnCount === beforeSpawns, runnerSpawnCount - beforeSpawns, 0);
    if (rejected) {
      check(checks, `${mutation.label} mismatch error`, errorMessage.includes('mismatch'), errorMessage, 'contains "mismatch"');
    }
  }
  return {
    pass: checks.every((item) => item.pass),
    hostCalls: 0,
    runnerSpawns: runnerSpawnCount - beforeSpawns,
    checks,
  };
}

function buildInput(configuration) {
  if (configuration.input) return configuration.input;
  if (!configuration.inputFile) return {};
  const input = { path: join(evidenceRoot, configuration.inputFile) };
  if (configuration.inputExtra) {
    input.extra = { not_a_record_field: true };
  }
  return input;
}

function validateHostCall(frame) {
  if (!frame.control || typeof frame.control !== 'object') return 'host.call lacks control object';
  if (frame.control.operation !== 'host.read_file') return 'host.call operation is not host.read_file';
  if (frame.control.operator !== 'd2.host_read') return 'host.call operator is not d2.host_read';
  if (frame.control.node_id !== 'first-host-read') return 'host.call node_id is not first-host-read';
  if (typeof frame.control.request_id !== 'string' || frame.control.request_id.length === 0) {
    return 'host.call request_id is missing';
  }
  if (!isDeepStrictEqual(frame.control.identity, expectedIdentity)) {
    return 'host.call identity does not match the expected SDK identity';
  }
  if (!frame.business || typeof frame.business !== 'object') return 'host.call lacks business object';
  if (typeof frame.business.path !== 'string' || frame.business.path.length === 0) {
    return 'host.call business.path is missing';
  }
  return undefined;
}

async function sendFrame(child, frame, protocolErrors) {
  if (child.stdin.destroyed || child.stdin.writableEnded) return;
  await new Promise((resolvePromise, rejectPromise) => {
    child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
      if (error) rejectPromise(error);
      else resolvePromise();
    });
  }).catch((error) => {
    if (error.code !== 'EPIPE') protocolErrors.push(`host response write failed: ${error.message}`);
  });
}

async function handleHostCall(child, frame, configuration, protocolErrors) {
  const validationError = validateHostCall(frame);
  if (validationError) {
    protocolErrors.push(validationError);
    await sendFrame(
      child,
      {
        type: 'host.error',
        control: { request_id: frame.control?.request_id ?? '', status: 'error', code: 'invalid_host_call' },
        business: { message: validationError },
      },
      protocolErrors,
    );
    return;
  }

  if (configuration.hostBehavior === 'eof') {
    child.stdin.end();
    return;
  }

  if (configuration.hostBehavior === 'error') {
    await sendFrame(
      child,
      {
        type: 'host.error',
        control: { request_id: frame.control.request_id, status: 'error', code: 'read_failed' },
        business: { message: 'host read failed: permission denied' },
      },
      protocolErrors,
    );
    return;
  }

  try {
    const content = await readFile(frame.business.path, 'utf8');
    await sendFrame(
      child,
      {
        type: 'host.result',
        control: { request_id: frame.control.request_id, status: 'ok' },
        business: {
          path: frame.business.path,
          content,
          bytes: Buffer.byteLength(content, 'utf8'),
        },
      },
      protocolErrors,
    );
  } catch (error) {
    protocolErrors.push(`readFile failed: ${error.message}`);
    await sendFrame(
      child,
      {
        type: 'host.error',
        control: { request_id: frame.control.request_id, status: 'error', code: 'read_failed' },
        business: { message: `host read failed: ${error.message}` },
      },
      protocolErrors,
    );
  }
}

async function runCase(name, configuration, input) {
  const args = [configuration.mode, JSON.stringify(input)];
  runnerSpawnCount += 1;
  const child = spawn(options.runner, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const hostCalls = [];
  const protocolErrors = [];
  let final = null;
  let finalCount = 0;
  let stderr = '';
  let stdout = '';

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdin.on('error', (error) => {
    if (error.code !== 'EPIPE') protocolErrors.push(`stdin error: ${error.message}`);
  });
  const closePromise = new Promise((resolvePromise) => {
    child.on('close', (code, signal) => resolvePromise({ code, signal }));
  });

  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) {
    stdout += `${line}\n`;
    if (!line.trim()) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch (error) {
      protocolErrors.push(`runner stdout is not JSON: ${error.message}`);
      continue;
    }
    if (frame.type === 'host.call') {
      hostCalls.push(frame);
      await handleHostCall(child, frame, configuration, protocolErrors);
    } else {
      finalCount += 1;
      final = frame;
      child.stdin.end();
    }
  }
  const close = await closePromise;
  return { name, args, exitCode: close.code, signal: close.signal, final, finalCount, hostCalls, protocolErrors, stdout, stderr };
}

function check(checks, label, pass, actual, expected) {
  checks.push({ label, pass: Boolean(pass), actual, expected });
}

function journalNodeOrder(journal, kind) {
  return journal.filter((event) => event.kind === kind).map((event) => event.node_id);
}

function evaluateSuccess(configuration, input, observed, checks) {
  const result = observed.final;
  const expectedPayload = {
    path: input.path,
    content: configuration.expectedContent,
    bytes: Buffer.byteLength(configuration.expectedContent, 'utf8'),
  };
  check(checks, 'status', result.status === 'success', result.status, 'success');
  check(checks, 'compiled graph', isDeepStrictEqual(result.compiled, {
    id: 'd2_sdk_host_probe',
    version: '1',
    node_ids: ['first-host-read', 'second-pure-output'],
  }), result.compiled, {
    id: 'd2_sdk_host_probe',
    version: '1',
    node_ids: ['first-host-read', 'second-pure-output'],
  });
  check(checks, 'identity', isDeepStrictEqual(result.identity, expectedIdentity), result.identity, expectedIdentity);
  check(checks, 'graph input accepted by Object', isDeepStrictEqual(result.graph_input, input), result.graph_input, input);
  check(checks, 'output keys', isDeepStrictEqual(Object.keys(result.outputs ?? {}), ['work.receipt']), Object.keys(result.outputs ?? {}), ['work.receipt']);
  check(checks, 'output payload', isDeepStrictEqual(result.outputs?.['work.receipt'], {
    id: 'work.receipt',
    version: 1,
    schema: 'Object',
    payload: expectedPayload,
  }), result.outputs?.['work.receipt'], {
    id: 'work.receipt',
    version: 1,
    schema: 'Object',
    payload: expectedPayload,
  });
  check(checks, 'SDK node schedule order', isDeepStrictEqual(journalNodeOrder(result.journal, 'node_scheduled'), ['first-host-read', 'second-pure-output']), journalNodeOrder(result.journal, 'node_scheduled'), ['first-host-read', 'second-pure-output']);
  check(checks, 'SDK node completion order', isDeepStrictEqual(journalNodeOrder(result.journal, 'node_completed'), ['first-host-read', 'second-pure-output']), journalNodeOrder(result.journal, 'node_completed'), ['first-host-read', 'second-pure-output']);
  check(checks, 'journal completed last', result.journal?.at(-1)?.kind === 'execution_completed', result.journal?.at(-1), { kind: 'execution_completed' });
  check(checks, 'journal has no failure', !result.journal?.some((event) => event.kind === 'execution_failed'), result.journal?.filter((event) => event.kind === 'execution_failed'), []);

  if (observed.hostCalls.length === 1) {
    const call = observed.hostCalls[0];
    check(checks, 'host.call control', isDeepStrictEqual(call.control, {
      request_id: 'd2-probe-execution/first-host-read/1',
      operation: 'host.read_file',
      operator: 'd2.host_read',
      node_id: 'first-host-read',
      identity: expectedIdentity,
    }), call.control, {
      request_id: 'd2-probe-execution/first-host-read/1',
      operation: 'host.read_file',
      operator: 'd2.host_read',
      node_id: 'first-host-read',
      identity: expectedIdentity,
    });
    check(checks, 'host.call business', isDeepStrictEqual(call.business, { path: input.path }), call.business, { path: input.path });
  }
}

function evaluateRuntimeError(configuration, input, observed, checks) {
  const result = observed.final;
  const expected = configuration.expect;
  check(checks, 'status', result.status === 'runtime_error', result.status, 'runtime_error');
  check(checks, 'error kind', result.kind === expected.kind, result.kind, expected.kind);
  check(checks, 'error message', result.message === expected.message, result.message, expected.message);
  check(checks, 'no false outputs', !Object.hasOwn(result, 'outputs'), Object.hasOwn(result, 'outputs'), false);
  check(checks, 'node completion order', isDeepStrictEqual(journalNodeOrder(result.journal, 'node_completed'), expected.nodeOrder), journalNodeOrder(result.journal, 'node_completed'), expected.nodeOrder);
  check(checks, 'journal failed last', result.journal?.at(-1)?.kind === 'execution_failed', result.journal?.at(-1), { kind: 'execution_failed' });
  check(checks, 'journal error kind', result.journal?.at(-1)?.error_kind === expected.kind, result.journal?.at(-1)?.error_kind, expected.kind);
  check(checks, 'no false execution completion', !result.journal?.some((event) => event.kind === 'execution_completed'), result.journal?.filter((event) => event.kind === 'execution_completed'), []);
  if (observed.hostCalls.length === 1) {
    check(checks, 'failed host.call business', isDeepStrictEqual(observed.hostCalls[0].business, { path: input.path }), observed.hostCalls[0].business, { path: input.path });
  }
}

function evaluateCompileError(configuration, observed, checks) {
  const result = observed.final;
  const expected = configuration.expect;
  check(checks, 'status', result.status === 'compile_error', result.status, 'compile_error');
  check(checks, 'stage', result.stage === 'compile', result.stage, 'compile');
  check(checks, 'graph id', result.graph_id === 'd2_sdk_host_probe', result.graph_id, 'd2_sdk_host_probe');
  check(checks, 'error message', result.message === expected.message, result.message, expected.message);
  check(checks, 'no host calls', observed.hostCalls.length === 0, observed.hostCalls.length, 0);
  check(checks, 'no journal', !Object.hasOwn(result, 'journal'), Object.hasOwn(result, 'journal'), false);
}

function evaluateCase(configuration, input, observed) {
  const checks = [];
  check(checks, 'runner exit code', observed.exitCode === 0, observed.exitCode, 0);
  check(checks, 'one final frame', observed.finalCount === 1, observed.finalCount, 1);
  check(checks, 'no protocol errors', observed.protocolErrors.length === 0, observed.protocolErrors, []);
  check(checks, 'stderr empty', observed.stderr === '', observed.stderr, '');
  check(checks, 'host call count', observed.hostCalls.length === configuration.expect.hostCalls, observed.hostCalls.length, configuration.expect.hostCalls);

  if (!observed.final) return checks;
  if (configuration.expect.status === 'success') {
    evaluateSuccess(configuration, input, observed, checks);
  } else if (configuration.expect.status === 'runtime_error') {
    evaluateRuntimeError(configuration, input, observed, checks);
  } else if (configuration.expect.status === 'compile_error') {
    evaluateCompileError(configuration, observed, checks);
  }
  return checks;
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  usage();
  process.exit(2);
}
if (!options.runner) {
  usage();
  process.exit(2);
}
if (!options.receipt) {
  usage();
  process.exit(2);
}
try {
  options.runner = await realpath(resolve(options.runner));
} catch (error) {
  console.error(`runner path is not resolvable: ${error.message}`);
  process.exit(1);
}
options.receipt = resolve(options.receipt);

let receiptBytes;
let receipt;
let verified;
try {
  receiptBytes = await readFile(options.receipt);
  receipt = JSON.parse(receiptBytes.toString('utf8'));
  verified = await verifyReceipt(receipt, options.runner);
} catch (error) {
  console.error(`identity verification failed: ${error.message}`);
  process.exit(1);
}

const selected = options.case
  ? Object.fromEntries(Object.entries(cases).filter(([name]) => name === options.case))
  : cases;
if (Object.keys(selected).length === 0) {
  console.error(`unknown case ${options.case}`);
  process.exit(2);
}

const identityMismatch = await identityMismatchChecks(receipt, options.runner);

const results = [];
for (const [name, configuration] of Object.entries(selected)) {
  const input = buildInput(configuration);
  const observed = await runCase(name, configuration, input);
  const checks = evaluateCase(configuration, input, observed);
  results.push({
    case: name,
    command: [options.runner, ...observed.args],
    pass: checks.every((item) => item.pass),
    checks,
    exitCode: observed.exitCode,
    signal: observed.signal,
    hostCalls: observed.hostCalls,
    final: observed.final,
    stderr: observed.stderr,
  });
}

const report = {
  protocol: 'd2-sdk-probe-results',
  receipt: {
    path: relative(evidenceRoot, options.receipt).split(sep).join('/'),
    sha256: sha256(receiptBytes),
    artifact: receipt.artifact,
    sdk: receipt.sdk,
  },
  identityMismatch,
  sdk: receipt.sdk,
  runtime: {
    ...verified.toolchain,
    receiptMatch: true,
  },
  passed: results.filter((result) => result.pass).length,
  total: results.length,
  results,
};

if (options.results) {
  await writeFile(resolve(options.results), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify({
  protocol: report.protocol,
  receipt: {
    path: report.receipt.path,
    sha256: report.receipt.sha256,
    artifact_sha256: report.receipt.artifact.sha256,
  },
  sdk: {
    version: report.sdk.version,
    path: report.sdk.path,
  },
  runtime: report.runtime,
  identityMismatch: {
    pass: report.identityMismatch.pass,
    hostCalls: report.identityMismatch.hostCalls,
    runnerSpawns: report.identityMismatch.runnerSpawns,
  },
  passed: report.passed,
  total: report.total,
  cases: results.map((result) => ({ case: result.case, pass: result.pass })),
}, null, 2));

process.exit(report.passed === report.total && report.identityMismatch.pass ? 0 : 1);
