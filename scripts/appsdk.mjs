#!/usr/bin/env node
/**
 * Run the AppSDK CLI the project pinned.
 *
 * `appsdk` on `PATH` is whatever the host installed. It may be a different build
 * than the version this project pins in `.appsdk/project.json`, and a different
 * build rewrites tracked governance files with different content. That drift makes
 * `pnpm verify` fail in a fresh checkout even though no product file changed.
 *
 * The project installs its pinned binary at `.appsdk/sdk.bin`. This entry uses that
 * binary when it exists and falls back to `PATH` otherwise, so `verify` behaves the
 * same on a developer machine and in a fresh clone.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '..')

export function resolveSdkBinary({ projectRoot = root, isExecutable = path => existsSync(path) && statSync(path).isFile() } = {}) {
  const pinned = join(projectRoot, '.appsdk', 'sdk.bin')
  return isExecutable(pinned) ? pinned : 'appsdk'
}

function main(argv) {
  const binary = resolveSdkBinary()
  const result = spawnSync(binary, argv, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) {
    console.error(`appsdk entry: ${binary} could not start: ${result.error.message}`)
    return 1
  }
  return result.status ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2))
}
