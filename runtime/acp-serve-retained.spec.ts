import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { processAlive, terminateProcess } from './local-ownership.ts'

const retained = vi.hoisted(() => ({ pid: 0 }))

// This file owns one branch: `startAcpAgentDaemon` returns a failed outcome
// whose cleanup could not confirm the engine exited. Mocking only that function
// keeps the real adapter, convergence, state record and engine-home lifecycle.
vi.mock('./acp-daemon.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('./acp-daemon.ts')>()
  return {
    ...actual,
    startAcpAgentDaemon: async () => ({
      kind: 'failed' as const,
      fault: { code: 'ENGINE_UNAVAILABLE' as const, message: 'simulated initialize failure' },
      cleanup: {
        kind: 'retained' as const,
        pid: retained.pid,
        error: { code: 'ENGINE_UNAVAILABLE' as const, message: 'simulated unresponsive engine' },
      },
    }),
  }
})

import { acpServeStatePath, readAcpServeIntent, startAcpServe } from './acp-serve.ts'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()!()
})

async function availableLoopbackPort(): Promise<number> {
  const listener = createServer()
  await new Promise<void>((resolveListen, reject) => {
    listener.once('error', reject)
    listener.listen(0, '127.0.0.1', () => resolveListen())
  })
  const address = listener.address()
  await new Promise<void>(resolveClose => listener.close(() => resolveClose()))
  if (address === null || typeof address === 'string') throw new Error('no loopback port')
  return address.port
}

function dshConfig(input: {
  readonly executable: string
  readonly port: number
  readonly dataDirectory: string
  readonly workspace: string
}): string {
  return `version = 4

[daemon]
kind = "agent"
id = "reasoner-dsh"
hostId = "host-a"
accountId = "local"
scopeId = "local"
dataDirectory = ${JSON.stringify(input.dataDirectory)}

[engine]
kind = "dsh"
executable = ${JSON.stringify(input.executable)}
workspace = ${JSON.stringify(input.workspace)}

[listen]
ip = "127.0.0.1"
port = ${input.port}

[acp]
enabled = true
required = ["method:session/prompt"]
blacklist = []
clientCapabilities = []
callbackExecutor = "controller"

[providers.probe]
protocol = "openai-responses"
apiBaseUrl = "http://127.0.0.1:1/v1"
label = "Probe provider"
enabled = true
credentialEnv = "PROBE_DSH_KEY"

[[models]]
provider = "probe"
id = "probe-model"

[model.primary]
provider = "probe"
model = "probe-model"
`
}

/**
 * A live process whose command line carries the configured engine executable,
 * so the ownership-checked convergence can recognise and stop it by exact PID.
 */
async function spawnRetainedEngine(executable: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', executable], { stdio: 'ignore' })
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', () => resolveSpawn())
    child.once('error', rejectSpawn)
  })
  // Let exec replace the fork image, so `ps` reports the argument that carries
  // the engine executable.
  await new Promise(resolveWait => setTimeout(resolveWait, 100))
  if (child.pid === undefined) throw new Error('retained engine helper has no pid')
  cleanup.push(async () => {
    if (processAlive(child.pid!)) await terminateProcess(child.pid!, { gracefulMs: 500, hardMs: 500 }).catch(() => undefined)
  })
  return child
}

it('records a retained engine after a failed start and converges it on the next start', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'acp-serve-retained-'))
  cleanup.push(async () => { await rm(directory, { recursive: true, force: true }) })
  const fakeEngine = join(directory, 'fake-dsh.mjs')
  await writeFile(fakeEngine, '#!/usr/bin/env node\nsetInterval(() => {}, 1000)\n')
  chmodSync(fakeEngine, 0o755)
  const dataDirectory = join(directory, 'state')
  const configPath = join(directory, 'agent.toml')
  await writeFile(configPath, dshConfig({
    executable: fakeEngine,
    port: await availableLoopbackPort(),
    dataDirectory,
    workspace: join(directory, 'workspace'),
  }))
  const intent = await readAcpServeIntent({ engine: 'dsh', configPath })

  const first = await spawnRetainedEngine(fakeEngine)
  retained.pid = first.pid!
  await expect(startAcpServe(intent, { env: process.env }))
    .rejects.toThrow(/retained engine pid=\d+ is recorded for the next start to converge/)

  const statePath = acpServeStatePath(dataDirectory)
  const recorded = JSON.parse(await readFile(statePath, 'utf8')) as {
    readonly daemonPid: number
    readonly enginePid: number
    readonly engineInstanceId: string
    readonly engineKind: string
  }
  expect(recorded).toMatchObject({ daemonPid: 0, enginePid: first.pid, engineKind: 'dsh' })
  expect(recorded.engineInstanceId.length).toBeGreaterThan(0)
  expect(processAlive(first.pid!)).toBe(true)
  expect(existsSync(join(dataDirectory, 'engine'))).toBe(true)

  // The next start must stop the retained PID before it creates the new home.
  const second = await spawnRetainedEngine(fakeEngine)
  retained.pid = second.pid!
  await expect(startAcpServe(intent, { env: process.env }))
    .rejects.toThrow(/retained engine pid=\d+ is recorded for the next start to converge/)
  expect(processAlive(first.pid!)).toBe(false)
  expect(existsSync(statePath)).toBe(true)
  const replaced = JSON.parse(await readFile(statePath, 'utf8')) as { readonly daemonPid: number; readonly enginePid: number }
  expect(replaced).toMatchObject({ daemonPid: 0, enginePid: second.pid })
})
