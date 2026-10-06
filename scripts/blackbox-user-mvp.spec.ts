import { describe, expect, it } from 'vitest'
import { cases, exitCode, parseArgs } from './blackbox-user-mvp.mjs'

describe('blackbox user MVP driver interface', () => {
  it('parses a case list and receipt path into the public runner contract', () => {
    const parsed = parseArgs(['--case', 'BB01,BB02', '--receipt', 'generated/u7-driver/receipt.json'])
    expect(parsed.caseIds).toEqual(['BB01', 'BB02'])
    expect(parsed.receiptPath.endsWith('/generated/u7-driver/receipt.json')).toBe(true)
    expect(parsed.command).toBe('run')
  })

  it('expands --case all to every registered case', () => {
    const parsed = parseArgs(['--case', 'all'])
    expect(parsed.caseIds).toHaveLength(14)
    expect(parsed.caseIds).toEqual(cases.map(item => item.id))
  })

  it('routes --help and --list without executing cases', () => {
    expect(parseArgs(['--help']).command).toBe('help')
    expect(parseArgs(['--list']).command).toBe('list')
  })

  it('keeps every unverified case wired to an exact missing capability', () => {
    for (const item of cases.filter(candidate => candidate.implemented === false)) {
      expect(item.missingCapability).toMatch(/\S/u)
      expect(item.publicProbe === 'work' || item.publicProbe === 'status').toBe(true)
    }
  })

  it('exits non-zero with a distinct unverified code', () => {
    expect(exitCode.passed).toBe(0)
    expect(exitCode.failed).toBe(1)
    expect(exitCode.unverified).toBe(2)
    expect(exitCode.unverified).not.toBe(exitCode.failed)
  })
})
