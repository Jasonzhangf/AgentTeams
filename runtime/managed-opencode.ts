import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { OpenCodeCompiledConfig } from '../opencode-adapter/src/index.ts'
import { createOpenCodeLaunchConfig } from '../opencode-adapter/src/managed-config.ts'

export interface ManagedOpenCodeOptions {
  readonly executable: string
  /** Caller holds the Agent's exclusive data-directory lease. */
  readonly directory: string
  readonly port: number
  readonly startupTimeoutMs: number
  readonly stopTimeoutMs: number
  readonly compiled: OpenCodeCompiledConfig
  readonly resolveCredential: (reference: string) => Promise<string>
}

/** Owns one substrate child; successful launch requires authenticated configuration readback. */
export async function startManagedOpenCode(options: ManagedOpenCodeOptions) {
  if (!isAbsolute(options.executable) || !isAbsolute(options.directory)) throw new Error('Managed OpenCode requires absolute paths')
  for (const value of [options.startupTimeoutMs, options.stopTimeoutMs]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new Error('Invalid managed OpenCode deadline')
  }
  if (!Number.isSafeInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error('Invalid managed OpenCode port')
  const compiled = structuredClone(options.compiled)
  const launch = createOpenCodeLaunchConfig(compiled)
  const secrets: Record<string, string> = {}
  for (const [key, reference] of Object.entries(launch.credentialReferences)) {
    const value = await options.resolveCredential(reference)
    if (typeof value !== 'string' || !value) throw new Error('Managed OpenCode credential unavailable')
    secrets[key] = value
  }
  const directory = resolve(options.directory)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const password = randomBytes(32).toString('hex')
  const authorization = `Basic ${Buffer.from(`teams:${password}`).toString('base64')}`
  const url = `http://127.0.0.1:${options.port}`
  const child = spawn(options.executable, ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(options.port)], {
    cwd: directory, env: { PATH: process.env.PATH,
      XDG_CONFIG_HOME: `${directory}/config`, XDG_DATA_HOME: `${directory}/data`, XDG_CACHE_HOME: `${directory}/cache`, XDG_STATE_HOME: `${directory}/state`,
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_CONFIG_CONTENT: JSON.stringify(launch.config),
      OPENCODE_SERVER_USERNAME: 'teams', OPENCODE_SERVER_PASSWORD: password, ...secrets },
    stdio: 'ignore',
  })
  let ended = false
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', () => { ended = true; reject(new Error('Managed OpenCode spawn failed')) })
    child.once('exit', (code, signal) => { ended = true; resolve({ code, signal }) })
  })
  void closed.catch(() => undefined)
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      if (!ended) child.kill('SIGTERM')
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([closed, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Managed OpenCode exit remains unconfirmed')), options.stopTimeoutMs) })])
      } finally { clearTimeout(timer) }
    })()
    return stopping
  }
  const hasEnded = () => ended || child.exitCode !== null || child.signalCode !== null
  try {
    const deadline = Date.now() + options.startupTimeoutMs
    let ready = false
    while (Date.now() < deadline) {
      if (hasEnded()) throw new Error('Managed OpenCode exited before readiness')
      try {
        ready = (await fetch(`${url}/global/health`, { headers: { authorization }, signal: AbortSignal.timeout(Math.max(1, Math.min(300, deadline - Date.now()))) })).ok
      } catch { /* Connection refusal before listen is expected; the startup deadline still applies. */ }
      if (!ready && hasEnded()) throw new Error('Managed OpenCode exited before readiness')
      if (ready) break
      await delay(50)
    }
    if (!ready) {
      if (hasEnded()) throw new Error('Managed OpenCode exited before readiness')
      throw new Error('Managed OpenCode startup deadline')
    }
    const response = await fetch(`${url}/config`, { headers: { authorization }, signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
    if (!response.ok || !response.body) throw new Error('Managed OpenCode config readback failed')
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []; let size = 0
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break
        size += chunk.value.length
        if (size > 1_048_576) throw new Error('Managed OpenCode config readback exceeds limit')
        chunks.push(chunk.value)
      }
    } finally { await reader.cancel() }
    const actual = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (actual.model !== launch.config.model || JSON.stringify(actual.enabled_providers) !== JSON.stringify(launch.config.enabled_providers) ||
      JSON.stringify(Object.keys(actual.provider ?? {}).sort()) !== JSON.stringify(Object.keys(launch.config.provider).sort())) throw new Error('Managed OpenCode config readback mismatch')
    for (const [id, expected] of Object.entries(launch.config.provider)) {
      const received = actual.provider[id]
      const reference = expected.options.apiKey?.slice(5, -1)
      if (received.npm !== expected.npm || received.options?.baseURL !== expected.options.baseURL ||
        received.options?.apiKey !== (reference === undefined ? undefined : secrets[reference]) ||
        JSON.stringify(Object.keys(received.models ?? {}).sort()) !== JSON.stringify(Object.keys(expected.models).sort())) throw new Error('Managed OpenCode provider readback mismatch')
    }
    if (ended) throw new Error('Managed OpenCode exited during readback')
    return { url, authorization, pid: child.pid!, effectiveRevision: compiled.acceptedRevision, closed, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
