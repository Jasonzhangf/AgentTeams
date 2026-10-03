#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const evidenceRoot = dirname(fileURLToPath(import.meta.url));
const runnerRoot = join(evidenceRoot, 'runner');
const templatePath = join(runnerRoot, 'Cargo.toml.template');
const lockPath = join(runnerRoot, 'Cargo.lock');
const probeSourcePath = join(runnerRoot, 'src', 'bin', 'probe.rs');
const driverPath = join(evidenceRoot, 'host', 'host.mjs');
const buildEntryPath = fileURLToPath(import.meta.url);
const receiptPath = join(evidenceRoot, 'results', 'build-receipt.json');
const buildRoot = join(evidenceRoot, '.build', 'current');
const generatedManifestPath = join(buildRoot, 'Cargo.toml');
const targetDir = join(buildRoot, 'target');
const runnerPath = join(targetDir, 'debug', 'probe');

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

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
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

async function collectFiles(root, relativeRoot = root) {
  const entries = [];
  const directoryEntries = await readdir(root, { withFileTypes: true });
  for (const entry of directoryEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    const fullPath = join(root, entry.name);
    if (entry.isDirectory()) {
      entries.push(...await collectFiles(fullPath, relativeRoot));
    } else if (entry.isFile()) {
      entries.push({
        path: relative(relativeRoot, fullPath).split(sep).join('/'),
        sha256: await hashFile(fullPath),
      });
    }
  }
  return entries;
}

async function main() {
  const sdk = await resolveSdk();
  const template = await readFile(templatePath, 'utf8');
  for (const marker of ['__DAGPIPE_SDK_PATH__', '__DAGPIPE_SDK_VERSION__']) {
    if (!template.includes(marker)) {
      fail(`Cargo.toml template is missing ${marker}`);
    }
  }

  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(buildRoot, { recursive: true });
  await cp(join(runnerRoot, 'src'), join(buildRoot, 'src'), { recursive: true });
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

  execFileSync('cargo', [
    'build',
    '--manifest-path',
    generatedManifestPath,
    '--target-dir',
    targetDir,
    '--locked',
  ], {
    cwd: evidenceRoot,
    stdio: 'inherit',
  });

  if (!await pathExists(runnerPath)) {
    fail(`cargo did not produce ${runnerPath}`);
  }
  const sourceLockHash = await hashFile(lockPath);
  if (await hashFile(join(buildRoot, 'Cargo.lock')) !== sourceLockHash) {
    fail('cargo changed the isolated Cargo.lock');
  }

  const sdkSources = [
    {
      path: 'Cargo.toml',
      sha256: await hashFile(sdk.manifestPath),
    },
    ...await collectFiles(join(sdk.path, 'src'), sdk.path),
  ];
  const receipt = {
    protocol: 'd2-sdk-probe-build-receipt',
    version: 1,
    generated_at: new Date().toISOString(),
    inputs: {
      build_entry: {
        path: relative(evidenceRoot, buildEntryPath).split(sep).join('/'),
        sha256: await hashFile(buildEntryPath),
      },
      driver: {
        path: relative(evidenceRoot, driverPath).split(sep).join('/'),
        sha256: await hashFile(driverPath),
      },
      probe_source: {
        path: relative(evidenceRoot, probeSourcePath).split(sep).join('/'),
        sha256: await hashFile(probeSourcePath),
      },
      build_template: {
        path: relative(evidenceRoot, templatePath).split(sep).join('/'),
        sha256: await hashFile(templatePath),
      },
      lock: {
        path: relative(evidenceRoot, lockPath).split(sep).join('/'),
        sha256: await hashFile(lockPath),
      },
    },
    fixtures: {
      cases: {
        path: 'cases.json',
        sha256: await hashFile(join(evidenceRoot, 'cases.json')),
      },
      input_a: {
        path: 'input-A.txt',
        sha256: await hashFile(join(evidenceRoot, 'input-A.txt')),
      },
      input_b: {
        path: 'input-B.txt',
        sha256: await hashFile(join(evidenceRoot, 'input-B.txt')),
      },
    },
    sdk: {
      crate: 'pipeline_runtime',
      version: sdk.version,
      path: sdk.path,
      manifest: {
        path: 'Cargo.toml',
        sha256: await hashFile(sdk.manifestPath),
      },
      sources: sdkSources.filter((entry) => entry.path !== 'Cargo.toml'),
    },
    generated: {
      manifest: {
        path: relative(evidenceRoot, generatedManifestPath).split(sep).join('/'),
        sha256: sha256(generatedManifest),
      },
      lock: {
        path: relative(evidenceRoot, join(buildRoot, 'Cargo.lock')).split(sep).join('/'),
        sha256: sourceLockHash,
      },
    },
    artifact: {
      kind: 'rust-bin',
      name: 'probe',
      path: relative(evidenceRoot, runnerPath).split(sep).join('/'),
      sha256: await hashFile(runnerPath),
      size: (await stat(runnerPath)).size,
    },
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
  };

  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({
    protocol: receipt.protocol,
    receipt: relative(evidenceRoot, receiptPath).split(sep).join('/'),
    runner: runnerPath,
    artifact_sha256: receipt.artifact.sha256,
    sdk: {
      version: receipt.sdk.version,
      path: receipt.sdk.path,
    },
  }, null, 2));
}

main().catch((error) => {
  fail(error.stack ?? error.message);
});
