import { execFile as execFileCallback } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export type ProcessTermination = 'exited' | 'killed' | 'unresponsive'

export async function terminateProcess(
  pid: number,
  options: { readonly gracefulMs: number; readonly hardMs: number },
): Promise<ProcessTermination> {
  if (!processAlive(pid)) return 'exited'
  try { process.kill(pid, 'SIGTERM') } catch { /* the liveness checks below report the outcome */ }
  if (await waitForProcessGone(pid, options.gracefulMs)) return 'exited'
  try { process.kill(pid, 'SIGKILL') } catch { /* the liveness check below reports the outcome */ }
  return await waitForProcessGone(pid, options.hardMs) ? 'killed' : 'unresponsive'
}

async function waitForProcessGone(pid: number, deadlineMs: number): Promise<boolean> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true
    await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
  }
  return !processAlive(pid)
}

export async function processCommand(pid: number): Promise<string | undefined> {
  try { return (await execFile('ps', ['-p', String(pid), '-o', 'command='])).stdout }
  catch { return undefined }
}

export async function processStartTime(pid: number): Promise<string | undefined> {
  try {
    const started = (await execFile('ps', ['-p', String(pid), '-o', 'lstart='])).stdout.trim()
    return started === '' ? undefined : started
  } catch { return undefined }
}

function splitProcessCommand(command: string): readonly string[] {
  const args: string[] = []
  let current = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  for (const character of command.trim()) {
    if (escaped) { current += character; escaped = false; continue }
    if (character === '\\' && quote !== "'") { escaped = true; continue }
    if (quote !== undefined) {
      if (character === quote) quote = undefined
      else current += character
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (/\s/.test(character)) {
      if (current.length > 0) { args.push(current); current = '' }
    } else current += character
  }
  if (escaped) current += '\\'
  if (current.length > 0) args.push(current)
  return args
}

export function processOwnsConfigCommand(
  command: string,
  configPath: string,
  entryPath: string,
  startToken: string | undefined,
  tokenFlag: '--launcher-start-token' | '--start-token' = '--launcher-start-token',
): boolean {
  if (startToken === undefined) return false
  const args = splitProcessCommand(command)
  const entryIndex = args.findIndex(argument => resolve(argument) === resolve(entryPath))
  return entryIndex >= 0 && args[entryIndex + 1] === '--config' && args[entryIndex + 2] === resolve(configPath) && args[entryIndex + 3] === tokenFlag && args[entryIndex + 4] === startToken
}
