#!/usr/bin/env node

// Product SDK build entry for the Teams DAGpipe runner.
//
// It resolves the installed SDK through `dagpipe sdk path`, generates an
// isolated manifest from the checked-in template, builds the project runner with
// `--locked`, verifies the resolved `pipeline_runtime` identity, and writes a
// receipt that binds source, SDK, registry effects, graph files, generated
// manifest/lock, toolchain and binary hash. No machine-specific path is checked
// in; the resolved SDK path lives only in the disposable build directory and the
// receipt.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const moduleRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(moduleRoot, '..', '..');
const runnerRoot = join(moduleRoot, 'runner');
const templatePath = join(runnerRoot, 'Cargo.toml.template');
const lockPath = join(runnerRoot, 'Cargo.lock');
const runnerSourceRoot = join(runnerRoot, 'src');
const buildEntryPath = fileURLToPath(import.meta.url);
const buildRoot = join(moduleRoot, '.build', 'current');
const generatedManifestPath = join(buildRoot, 'Cargo.toml');
const targetDir = join(buildRoot, 'target');
const cargoBinaryName = 'teams-dagpipe-runner';
const installBinaryName = 'agentteams-dagpipe-runner';
const buildProfile = 'debug';
const receiptPath = join(buildRoot, 'build-receipt.json');

const graphFiles = {
  agent_work: join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'agent-work.graph.json'),
  work_open: join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-open.graph.json'),
  work_request: join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-request.graph.json'),
  work_close: join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-close.graph.json'),
  work_query: join(repoRoot, 'docs', 'design', 'dagpipe', 'graphs', 'work-query.graph.json'),
};

// Fixed effect grant for the Teams Work graphs; must match the runner registry.
const effects = [
  'agent.work.close',
  'agent.work.get',
  'agent.work.propose',
  'agent.work.request',
  'directory.read',
  'network.close',
  'network.connect',
];

function fail(message) {
  console.error(`build: ${message}`);
  process.exit(1);
}

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

async function hashFile(path) {
  return sha256(await readFile(path));
}

function hashJson(value) {
  return sha256(JSON.stringify(value));
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function cargoHostTarget() {
  const version = execText('rustc', ['-vV']);
  const match = /^host: (.+)$/m.exec(version);
  if (!match) {
    fail('rustc -vV did not report a host target');
  }
  return match[1].trim();
}

function execText(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function cargoMetadata(manifestPath, { noDeps = false, locked = false } = {}) {
  const args = ['metadata', '--format-version', '1', '--manifest-path', manifestPath];
  if (noDeps) args.push('--no-deps');
  if (locked) args.push('--locked');
  return JSON.parse(execText('cargo', args));
}

function packageFromMetadata(metadata, manifestPath, expectedName) {
  const matches = metadata.packages.filter((entry) => entry.name === expectedName);
  if (matches.length !== 1) {
    fail(`cargo metadata found ${matches.length} packages named ${expectedName}`);
  }
  const entry = matches[0];
  if (entry.manifest_path !== manifestPath) {
    fail(`cargo resolved ${expectedName} to ${entry.manifest_path}, expected ${manifestPath}`);
  }
  return entry;
}

async function resolveSdk() {
  let rawPath;
  try {
    rawPath = execText('dagpipe', ['sdk', 'path']);
  } catch (error) {
    fail(`dagpipe sdk path failed: ${error.message}`);
  }
  if (!rawPath || !isAbsolute(rawPath)) {
    fail(`dagpipe sdk path returned a non-absolute path: ${JSON.stringify(rawPath)}`);
  }

  let sdkPath;
  try {
    sdkPath = await realpath(rawPath);
  } catch (error) {
    fail(`dagpipe sdk path is not resolvable: ${error.message}`);
  }
  const sdkManifestPath = await realpath(join(sdkPath, 'Cargo.toml'));
  const sdkLibPath = await realpath(join(sdkPath, 'src', 'lib.rs'));
  if (!await pathExists(sdkManifestPath) || !await pathExists(sdkLibPath)) {
    fail(`SDK source is incomplete at ${sdkPath}`);
  }

  const metadata = cargoMetadata(sdkManifestPath, { noDeps: true });
  const sdkPackage = packageFromMetadata(metadata, sdkManifestPath, 'pipeline_runtime');
  if (!sdkPackage.version) {
    fail('cargo metadata did not report pipeline_runtime version');
  }
  return {
    path: sdkPath,
    manifestPath: sdkManifestPath,
    libPath: sdkLibPath,
    version: sdkPackage.version,
  };
}

async function collectCargoInputs(sdkPath, packageMetadata) {
  const paths = new Set([packageMetadata.manifest_path]);
  for (const target of packageMetadata.targets) {
    if (typeof target.src_path === 'string') paths.add(target.src_path);
  }
  if (typeof packageMetadata.build === 'string') {
    paths.add(resolve(sdkPath, packageMetadata.build));
  }
  const lockPath = join(sdkPath, 'Cargo.lock');
  if (await pathExists(lockPath)) paths.add(lockPath);
  const cargoConfigPath = join(sdkPath, '.cargo', 'config.toml');
  if (await pathExists(cargoConfigPath)) paths.add(cargoConfigPath);

  const entries = [];
  for (const path of [...paths].sort()) {
    if (!await pathExists(path)) {
      fail(`SDK build input is missing at ${path}`);
    }
    entries.push({
      path: relative(sdkPath, path).split(sep).join('/'),
      sha256: await hashFile(path),
    });
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

function relativeToRepo(path) {
  return relative(repoRoot, path).split(sep).join('/');
}

export async function buildRunner() {
  const sdk = await resolveSdk();
  const template = await readFile(templatePath, 'utf8');
  for (const marker of ['__DAGPIPE_SDK_PATH__', '__DAGPIPE_SDK_VERSION__']) {
    if (!template.includes(marker)) {
      fail(`Cargo.toml template is missing ${marker}`);
    }
  }
  if (!await pathExists(lockPath)) {
    fail(`runner lockfile is missing at ${relativeToRepo(lockPath)}`);
  }
  for (const [name, path] of Object.entries(graphFiles)) {
    if (!await pathExists(path)) {
      fail(`graph file ${name} is missing at ${relativeToRepo(path)}`);
    }
  }

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await cp(runnerSourceRoot, join(buildRoot, 'src'), { recursive: true });
  await cp(lockPath, join(buildRoot, 'Cargo.lock'));

  const generatedManifest = template
    .replaceAll('__DAGPIPE_SDK_PATH__', JSON.stringify(sdk.path))
    .replaceAll('__DAGPIPE_SDK_VERSION__', sdk.version);
  if (generatedManifest.includes('__DAGPIPE_')) {
    fail('generated Cargo.toml still contains a template marker');
  }
  await writeFile(generatedManifestPath, generatedManifest, 'utf8');

  const resolvedMetadata = cargoMetadata(generatedManifestPath, { locked: true });
  const resolvedSdk = packageFromMetadata(resolvedMetadata, sdk.manifestPath, 'pipeline_runtime');
  if (resolvedSdk.version !== sdk.version) {
    fail(`cargo resolved pipeline_runtime ${resolvedSdk.version}, expected ${sdk.version}`);
  }
  if (resolvedSdk.source !== null) {
    fail(`cargo resolved pipeline_runtime from a non-path source: ${resolvedSdk.source}`);
  }

  const target = cargoHostTarget();
  execFileSync('cargo', [
    'build',
    '--manifest-path',
    generatedManifestPath,
    '--target-dir',
    targetDir,
    '--target',
    target,
    '--locked',
  ], {
    cwd: buildRoot,
    stdio: 'inherit',
  });

  const cargoRunnerPath = join(targetDir, target, buildProfile, cargoBinaryName);
  if (!await pathExists(cargoRunnerPath)) {
    fail(`cargo did not produce ${cargoRunnerPath}`);
  }
  const sourceLockHash = await hashFile(lockPath);
  if (await hashFile(join(buildRoot, 'Cargo.lock')) !== sourceLockHash) {
    fail('cargo changed the isolated Cargo.lock');
  }

  const sdkBuildInputs = await collectCargoInputs(sdk.path, resolvedSdk);
  const projectSourceInputs = [
    { path: relativeToRepo(buildEntryPath), sha256: await hashFile(buildEntryPath) },
    { path: relativeToRepo(join(runnerSourceRoot, 'bin', 'runner.rs')), sha256: await hashFile(join(runnerSourceRoot, 'bin', 'runner.rs')) },
    { path: relativeToRepo(templatePath), sha256: await hashFile(templatePath) },
    { path: relativeToRepo(lockPath), sha256: sourceLockHash },
  ];
  const graphInputs = await Promise.all(Object.entries(graphFiles).map(async ([name, path]) => [
    name,
    { path: relativeToRepo(path), sha256: await hashFile(path) },
  ]));
  const graphDefinitions = await Promise.all(Object.values(graphFiles).map(async path => JSON.parse(await readFile(path, 'utf8'))));
  const operators = [...new Set(graphDefinitions.flatMap(graph => graph.nodes.map(node => `${node.operator}@${node.operator_version}`)))].sort();
  const generatedInputs = [
    { path: 'Cargo.toml', sha256: sha256(generatedManifest) },
    { path: 'Cargo.lock', sha256: sourceLockHash },
  ];
  const sdkBuildInputsSha256 = hashJson(sdkBuildInputs);
  const projectSourceSha256 = hashJson(projectSourceInputs);
  const buildInputs = {
    sdk: {
      package: resolvedSdk.name,
      version: resolvedSdk.version,
      root: sdk.path,
      inputs: sdkBuildInputs,
      sha256: sdkBuildInputsSha256,
    },
    project_source: {
      inputs: projectSourceInputs,
      sha256: projectSourceSha256,
    },
    generated: {
      inputs: generatedInputs,
      sha256: hashJson(generatedInputs),
    },
    graphs: Object.fromEntries(graphInputs),
    registry: {
      operators,
      effects,
      sha256: hashJson({ operators, effects }),
    },
    toolchain: {
      node: process.version,
      cargo: execText('cargo', ['-vV']),
      rustc: execText('rustc', ['-vV']),
    },
    target,
    profile: buildProfile,
  };
  const sdkBuildInputsSha256Aggregate = hashJson(buildInputs);
  const receipt = {
    protocol: 'teams-dagpipe-runner-build-receipt',
    version: 2,
    generated_at: new Date().toISOString(),
    inputs: {
      build_entry: { path: relativeToRepo(buildEntryPath), sha256: await hashFile(buildEntryPath) },
      runner_source: { path: relativeToRepo(join(runnerSourceRoot, 'bin', 'runner.rs')), sha256: await hashFile(join(runnerSourceRoot, 'bin', 'runner.rs')) },
      build_template: { path: relativeToRepo(templatePath), sha256: await hashFile(templatePath) },
      lock: { path: relativeToRepo(lockPath), sha256: sourceLockHash },
    },
    graphs: Object.fromEntries(await Promise.all(Object.entries(graphFiles).map(async ([name, path]) => [
      name,
      { path: relativeToRepo(path), sha256: await hashFile(path) },
    ]))),
    registry: { operators, effects },
    sdk: {
      crate: 'pipeline_runtime',
      version: sdk.version,
      path: sdk.path,
      manifest: { path: 'Cargo.toml', sha256: await hashFile(sdk.manifestPath) },
      build_inputs: sdkBuildInputs,
      build_inputs_sha256: sdkBuildInputsSha256,
      project_source_sha256: projectSourceSha256,
      sdk_build_inputs_sha256: sdkBuildInputsSha256Aggregate,
    },
    generated: {
      manifest: { path: relative(buildRoot, generatedManifestPath).split(sep).join('/'), sha256: sha256(generatedManifest) },
      lock: { path: relative(buildRoot, join(buildRoot, 'Cargo.lock')).split(sep).join('/'), sha256: sourceLockHash },
    },
    artifact: {
      kind: 'rust-bin',
      cargo_name: cargoBinaryName,
      install_name: installBinaryName,
      path: relativeToRepo(cargoRunnerPath),
      installed_path: installBinaryName,
      sha256: await hashFile(cargoRunnerPath),
      size: (await stat(cargoRunnerPath)).size,
    },
    build_inputs: buildInputs,
    resolution: {
      package: resolvedSdk.name,
      version: resolvedSdk.version,
      manifest_path: resolvedSdk.manifest_path,
      source: resolvedSdk.source,
    },
    toolchain: {
      node: process.version,
      cargo: execText('cargo', ['-vV']),
      rustc: execText('rustc', ['-vV']),
    },
    target,
    profile: buildProfile,
  };

  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { receiptPath, runnerPath: cargoRunnerPath, receipt };
}

async function main() {
  const built = await buildRunner();
  console.log(JSON.stringify({
    protocol: built.receipt.protocol,
    receipt: relativeToRepo(built.receiptPath),
    runner: built.runnerPath,
    artifact_sha256: built.receipt.artifact.sha256,
    sdk: { version: built.receipt.sdk.version, path: built.receipt.sdk.path },
  }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    fail(error.stack ?? error.message);
  });
}
