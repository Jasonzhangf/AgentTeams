#!/usr/bin/env node

// Negative fixture: emits one invalid runner frame, records its own PID, then
// waits for the host to terminate it. The fallback final frame keeps the red
// test bounded if the host incorrectly continues or hangs.

import { writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const kind = process.env.TEAMS_D3_U4_INVALID_FRAME ?? 'malformed-json'
const pidFile = process.env.TEAMS_D3_U4_PID_FILE
if (pidFile) writeFileSync(pidFile, `${process.pid}\n`)

const frames = {
  'malformed-json': '{not-json}\n',
  'missing-control': `${JSON.stringify({ type: 'host.call' })}\n`,
  'unknown-frame': `${JSON.stringify({ type: 'unknown.frame' })}\n`,
}
process.stdout.write(frames[kind] ?? frames['malformed-json'])

const fallback = {
  type: 'execution.failure',
  message: `invalid-frame fixture survived: ${kind}`,
}
const fallbackTimer = setTimeout(() => {
  process.stdout.write(`${JSON.stringify(fallback)}\n`)
  process.exit(0)
}, 1000)

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const _line of lines) {
  // Invalid frames have no valid host response; wait for host cleanup.
}
clearTimeout(fallbackTimer)
process.stdout.write(`${JSON.stringify(fallback)}\n`)
