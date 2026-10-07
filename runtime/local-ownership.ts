import { execFile as execFileCallback } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export async function processCommand(pid: number): Promise<string | undefined> {
  try { return (await execFile('ps', ['-p', String(pid), '-o', 'command='])).stdout }
  catch { return undefined }
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
