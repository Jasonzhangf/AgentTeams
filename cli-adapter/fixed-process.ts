import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { CliAdapterError } from './contracts.ts'

const defaultTimeoutMs = 30_000
const defaultMaxOutputBytes = 8 * 1024 * 1024
const terminationGraceMs = 100

export interface FixedProcessSpec {
  readonly executable: string
  readonly argv: readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  readonly stdin?: string
  readonly timeoutMs?: number
  readonly maxOutputBytes?: number
  readonly readyToken?: string
  readonly shell: false
}

export interface FixedProcessResult {
  readonly exitCode: number | null
  readonly signal: NodeJS.Signals | null
  readonly timedOut: boolean
  readonly outputLimitExceeded?: boolean
  readonly stdout: string
  readonly stderr: string
}

export type FixedProcessRunner = (spec: FixedProcessSpec) => Promise<FixedProcessResult>

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const result = value ?? fallback
  if (!Number.isInteger(result) || result < 1) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: `${label} must be a positive integer` })
  }
  return result
}

function outputLimitMessage(spec: FixedProcessSpec): string {
  return `${spec.executable} output exceeded ${spec.maxOutputBytes ?? defaultMaxOutputBytes} bytes`
}

export function runFixedProcess(spec: FixedProcessSpec): Promise<FixedProcessResult> {
  if (spec.shell !== false) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'fixed process runner requires shell=false' })
  }
  if (spec.executable.length === 0 || spec.argv.some(argument => typeof argument !== 'string')) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'fixed executable and argv are required' })
  }
  const timeoutMs = positiveInteger(spec.timeoutMs, defaultTimeoutMs, 'timeoutMs')
  const maxOutputBytes = positiveInteger(spec.maxOutputBytes, defaultMaxOutputBytes, 'maxOutputBytes')
  if (spec.readyToken !== undefined && spec.readyToken.length === 0) {
    throw new CliAdapterError({ code: 'INVALID_INPUT', message: 'readyToken must be a non-empty string' })
  }

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(spec.executable, [...spec.argv], {
        cwd: spec.cwd,
        env: spec.env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new CliAdapterError({
        code: 'PROCESS_ERROR',
        message: `${spec.executable} could not be spawned: ${error instanceof Error ? error.message : String(error)}`,
      }))
      return
    }
    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      child.kill('SIGTERM')
      reject(new CliAdapterError({ code: 'PROCESS_ERROR', message: `${spec.executable} did not expose piped stdio` }))
      return
    }
    const stdin = child.stdin
    const stdoutStream = child.stdout
    const stderrStream = child.stderr

    const stdoutDecoder = new StringDecoder('utf8')
    const stderrDecoder = new StringDecoder('utf8')
    let stdout = ''
    let stderr = ''
    let outputBytes = 0
    let timedOut = false
    let outputLimitExceeded = false
    let settled = false
    let stdinError: Error | undefined
    let terminationTimer: ReturnType<typeof setTimeout> | undefined
    let operationTimer: ReturnType<typeof setTimeout> | undefined
    let readyWaitTimer: ReturnType<typeof setTimeout> | undefined
    let ready = spec.readyToken === undefined
    let readyFailed = false

    const clearTimers = (): void => {
      if (operationTimer !== undefined) clearTimeout(operationTimer)
      if (readyWaitTimer !== undefined) clearTimeout(readyWaitTimer)
      if (terminationTimer !== undefined) clearTimeout(terminationTimer)
    }

    const requestTermination = (): void => {
      if (settled || terminationTimer !== undefined) return
      child.kill('SIGTERM')
      terminationTimer = setTimeout(() => {
        if (settled) return
        child.kill('SIGKILL')
      }, terminationGraceMs)
    }

    const armOperationTimeout = (): void => {
      if (operationTimer !== undefined) return
      operationTimer = setTimeout(() => {
        timedOut = true
        requestTermination()
      }, timeoutMs)
    }

    const markReady = (): void => {
      if (ready) return
      ready = true
      if (readyWaitTimer !== undefined) {
        clearTimeout(readyWaitTimer)
        readyWaitTimer = undefined
      }
      armOperationTimeout()
    }

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      outputBytes += chunk.byteLength
      if (outputBytes > maxOutputBytes) {
        outputLimitExceeded = true
        if (!ready && spec.readyToken !== undefined && target === 'stdout') {
          const preview = stdout + chunk.toString('utf8')
          if (preview.includes(spec.readyToken)) markReady()
        }
        requestTermination()
        return
      }
      if (target === 'stdout') stdout += stdoutDecoder.write(chunk)
      else stderr += stderrDecoder.write(chunk)
      if (!ready && spec.readyToken !== undefined && stdout.includes(spec.readyToken)) markReady()
    }

    if (ready) armOperationTimeout()
    else {
      readyWaitTimer = setTimeout(() => {
        if (settled || ready) return
        readyFailed = true
        requestTermination()
      }, defaultTimeoutMs)
    }

    stdoutStream.on('data', chunk => append('stdout', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    stderrStream.on('data', chunk => append('stderr', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    child.once('error', error => {
      if (settled) return
      settled = true
      clearTimers()
      reject(new CliAdapterError({
        code: 'PROCESS_ERROR',
        message: `${spec.executable} could not be spawned: ${error.message}`,
        stdout,
        stderr,
      }))
    })
    child.once('close', (exitCode, signal) => {
      if (settled) return
      settled = true
      clearTimers()
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      if (!ready && spec.readyToken !== undefined && stdout.includes(spec.readyToken)) ready = true
      if (stdinError !== undefined) {
        reject(new CliAdapterError({
          code: 'PROCESS_ERROR',
          message: `${spec.executable} stdin failed: ${stdinError.message}`,
          exitCode,
          signal,
          stdout,
          stderr,
        }))
        return
      }
      if (readyFailed || (spec.readyToken !== undefined && !ready)) {
        reject(new CliAdapterError({
          code: 'PROCESS_ERROR',
          message: `${spec.executable} did not signal ready`,
          exitCode,
          signal,
          stdout,
          stderr,
        }))
        return
      }
      resolve({ exitCode, signal, timedOut, outputLimitExceeded, stdout, stderr })
    })

    stdin.on('error', error => {
      stdinError ??= error
      requestTermination()
    })
    if (spec.stdin === undefined) stdin.end()
    else stdin.end(spec.stdin)
  })
}

export function assertProcessSucceeded(spec: FixedProcessSpec, result: FixedProcessResult): void {
  if (result.timedOut) {
    throw new CliAdapterError({
      code: 'PROCESS_ERROR',
      message: `${spec.executable} timed out`,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    })
  }
  if (result.outputLimitExceeded) {
    throw new CliAdapterError({
      code: 'PROCESS_ERROR',
      message: outputLimitMessage(spec),
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    })
  }
  if (result.exitCode !== 0) {
    throw new CliAdapterError({
      code: 'PROCESS_ERROR',
      message: `${spec.executable} exited unsuccessfully`,
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    })
  }
}
