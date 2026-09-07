import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const project = JSON.parse(readFileSync(resolve(root, '.appsdk/project.json'), 'utf8'))
const module = project.modules.find(item => item.module_id === 'teams-source')
assert.ok(module, 'teams-source contract missing')
process.stderr.write('Regression gate: TEAMS_CONSOLE_REAL_DOM=1 (real Chrome required)\n')
const result = spawnSync('pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.config.ts', '--reporter=json'], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, TEAMS_CONSOLE_REAL_DOM: '1' },
  maxBuffer: 16 * 1024 * 1024,
})
if (result.error) throw result.error
mkdirSync(resolve(root, 'generated/validation'), { recursive: true })
writeFileSync(resolve(root, 'generated/validation/regression.json'), result.stdout)
if (result.stderr) process.stderr.write(result.stderr)
if (result.status !== 0) {
  process.stderr.write(result.stdout)
  throw new Error(`Regression process failed: status=${result.status}, signal=${result.signal}`)
}
const report = JSON.parse(result.stdout)
assert.equal(report.success, true, 'Regression report must indicate success')
assert.ok(report.numPassedTests >= module.regression.minimum_test_count, 'Regression count fell below the declared baseline')
assert.equal(report.numPendingTests, 0, 'Skipped tests are forbidden')
assert.equal(report.numTodoTests, 0, 'TODO tests do not count as verified')
console.log(`Test Files ${report.testResults.length} passed`)
console.log(`Tests ${report.numPassedTests} passed`)
