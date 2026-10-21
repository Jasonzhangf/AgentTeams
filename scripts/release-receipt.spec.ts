import { describe, expect, it } from 'vitest'
import { assembleReleaseReceipt } from './release-receipt.mjs'

/**
 * The release gate is the only place that may claim `release_eligible: true`.
 * These cases prove it stays closed for every incomplete input, so a failed
 * run cannot leave an eligible artifact behind.
 */
const candidate = { head_commit: 'a'.repeat(40), tree_hash: 'b'.repeat(40), base_commit: 'c'.repeat(40) }
const content = 'd'.repeat(64)
const files = ['cli/agentteams.mjs', 'package.json']
const allCases = Array.from({ length: 14 }, (_, index) => `BB${String(index + 1).padStart(2, '0')}`)

function blackBoxRun(caseIds, overrides = {}) {
  return {
    receipt_path: 'docs/evidence/x/bb.json',
    candidate_commit: candidate.head_commit,
    installed_package: { content_sha256: content },
    cases: caseIds.map(id => ({ case_id: id, status: 'passed' })),
    exit: { code: 0, failed: [], unverified: [] },
    ...overrides,
  }
}

function inputs() {
  return {
    packageReceipt: {
      mode: 'final',
      release_eligible: false,
      version: '0.2.0-internal.1',
      content_sha256: content,
      pack_root: 'generated/modules/teams-source/lib',
      candidate,
      files: [...files],
    },
    installedLifecycle: {
      receipt_path: 'docs/evidence/x/installed.json',
      lifecycle: { status: 'passed', start: { state: 'running', generation: 1 }, restart: { state: 'running', generation: 2 } },
      package: { version: '0.2.0-internal.1' },
      tarball: { content_sha256: content, sha256: 'e'.repeat(64) },
      candidate,
    },
    blackBoxRuns: [blackBoxRun(allCases)],
    tarball: { filename: 'agentteams-0.2.0-internal.1.tgz', sha256: 'f'.repeat(64), size: 1024, files: [...files] },
    retainedObligations: { retained: [{ obligation: 'sessionEvents projection' }] },
  }
}

describe('assembleReleaseReceipt', () => {
  it('grants eligibility only when every gate passed on the same package content', () => {
    const receipt = assembleReleaseReceipt(inputs())
    expect(receipt).toMatchObject({
      release_eligible: true,
      scope: 'internal-mvp',
      version: '0.2.0-internal.1',
      tarball: { filename: 'agentteams-0.2.0-internal.1.tgz' },
      black_box: { cases_total: 14, cases_passed: 14 },
    })
    expect(receipt.black_box.flaky_cases).toEqual([])
    expect(receipt.retained_obligations).toHaveLength(1)
  })

  it('composes two runs on the same artifact and records the flaky case', () => {
    const input = inputs()
    const first = blackBoxRun(allCases)
    first.cases = first.cases.map(entry => (entry.case_id === 'BB07' ? { ...entry, status: 'failed' } : entry))
    first.exit = { code: 1, failed: ['BB07'], unverified: [] }
    input.blackBoxRuns = [first, blackBoxRun(['BB07'])]
    const receipt = assembleReleaseReceipt(input)
    expect(receipt.black_box.cases_passed).toBe(14)
    expect(receipt.black_box.runs).toHaveLength(2)
    expect(receipt.black_box.flaky_cases).toEqual([{ case_id: 'BB07', attempts: ['failed', 'passed'] }])
  })

  it('refuses when a case never passed', () => {
    const input = inputs()
    input.blackBoxRuns = [blackBoxRun(allCases.filter(id => id !== 'BB07'))]
    expect(() => assembleReleaseReceipt(input)).toThrow(/never passed|do not cover/u)
  })

  it('refuses a second run against different package content', () => {
    const input = inputs()
    input.blackBoxRuns = [blackBoxRun(allCases), blackBoxRun(['BB07'], { installed_package: { content_sha256: '1'.repeat(64) } })]
    expect(() => assembleReleaseReceipt(input)).toThrow(/different package content/u)
  })

  it('refuses a staged receipt that already claims eligibility', () => {
    const input = inputs()
    input.packageReceipt.release_eligible = true
    expect(() => assembleReleaseReceipt(input)).toThrow(/must stay non-release/u)
  })

  it('refuses a lifecycle receipt that did not restart', () => {
    const input = inputs()
    input.installedLifecycle.lifecycle.restart = { state: 'stopped' }
    expect(() => assembleReleaseReceipt(input)).toThrow(/restart state is stopped/u)
  })

  it('refuses an installed lifecycle from different package content', () => {
    const input = inputs()
    input.installedLifecycle.tarball.content_sha256 = '0'.repeat(64)
    expect(() => assembleReleaseReceipt(input)).toThrow(/installed different package content/u)
  })

  it('refuses a black-box run from another candidate', () => {
    const input = inputs()
    input.blackBoxRuns = [blackBoxRun(allCases, { candidate_commit: '9'.repeat(40) })]
    expect(() => assembleReleaseReceipt(input)).toThrow(/does not belong to the staged package candidate/u)
  })

  it('refuses a tarball whose file set differs from the staged package', () => {
    const input = inputs()
    input.tarball.files = ['cli/agentteams.mjs']
    expect(() => assembleReleaseReceipt(input)).toThrow(/exactly the staged file set/u)
  })

  it('refuses a receipt with no retained obligations', () => {
    const input = inputs()
    input.retainedObligations = { retained: [] }
    expect(() => assembleReleaseReceipt(input)).toThrow(/retained obligations/u)
  })
})
