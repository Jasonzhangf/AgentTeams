import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { runPackageUserSmoke } from './package-user-smoke.mjs'

const root = resolve(import.meta.dirname, '..')
const defaultReceiptDir = resolve(root, 'generated', 'u1-receipts', `${Date.now()}-${process.pid}`)

function parseOptions(argv) {
  const options = {
    packRoot: resolve(root, 'generated', 'modules', 'teams-source', 'lib'),
    receiptPath: process.env.AGENTTEAMS_U1_INSTALLED_RECEIPT_PATH
      ? resolve(process.env.AGENTTEAMS_U1_INSTALLED_RECEIPT_PATH)
      : join(defaultReceiptDir, 'installed-runtime-smoke.receipt.json'),
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) throw new Error(`${argument} requires a value`)
      index += 1
      return next
    }
    if (argument === '--pack-root') options.packRoot = resolve(value())
    else if (argument === '--receipt-path') options.receiptPath = resolve(value())
    else throw new Error(`unknown argument: ${argument}`)
  }
  return options
}

try {
  const options = parseOptions(process.argv.slice(2))
  const receipt = await runPackageUserSmoke({
    packRoot: options.packRoot,
    receiptPath: options.receiptPath,
    includeInstalledLifecycle: true,
  })
  if (receipt.lifecycle?.status !== 'passed') {
    throw new Error('installed runtime smoke: INSTALLED_LIFECYCLE_UNAVAILABLE: no installed start/restart evidence was produced')
  }
  const receiptSha256 = createHash('sha256').update(readFileSync(options.receiptPath)).digest('hex')
  console.log(`u1-installed-receipt ${options.receiptPath} sha256:${receiptSha256}`)
  console.log('Installed runtime smoke passed: the staged base package was installed outside the source tree and consumed through installed CLI/Relay/Agent lifecycle plus Console entrypoints.')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
