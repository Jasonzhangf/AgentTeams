import { spawnSync } from 'node:child_process'

const objectIdPattern = /^[0-9a-f]{40}$/u
const sdkEvidencePathPattern = /^\.appsdk\/records\/evidence\/teams-source\/[^/]+\.json$/u
const sdkLifecycleRecordPathPattern = /^\.appsdk\/records\/(?:(?:fix-candidate-record-|pre-review-validation-record-)[^/]+|(?:evidence-record|worktree-record)(?:-[^/]+)?)\.json$/u

function fail(message) {
  throw new Error(`receipt identity: ${message}`)
}

export function currentCandidateIdentity(root) {
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) {
      fail(`git ${args.join(' ')} failed: ${(result.stderr || result.stdout).trim()}`)
    }
    return result.stdout.trim()
  }

  const identity = {
    head_commit: git(['rev-parse', 'HEAD']),
    base_commit: git(['merge-base', 'HEAD', 'origin/main']),
    tree_hash: git(['rev-parse', 'HEAD^{tree}']),
    indexed_tree_hash: git(['write-tree']),
  }
  identity.source_state = identity.indexed_tree_hash === identity.tree_hash ? 'committed' : 'staged'
  validateCandidateIdentity(identity)

  const unstaged = spawnSync('git', ['diff', '--quiet'], { cwd: root })
  if (unstaged.status !== 0) {
    fail('staged product does not match the recorded index')
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(path => path !== '' && !sdkEvidencePathPattern.test(path) && !sdkLifecycleRecordPathPattern.test(path))
  if (untracked.length !== 0) {
    fail(`candidate has untracked product paths:\n${untracked.join('\n')}`)
  }
  return identity
}

export function validateCandidateIdentity(candidate) {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    fail('candidate identity is missing')
  }
  for (const field of ['head_commit', 'base_commit', 'tree_hash', 'indexed_tree_hash']) {
    if (typeof candidate[field] !== 'string' || !objectIdPattern.test(candidate[field])) {
      fail(`candidate ${field} is missing or malformed`)
    }
  }
  if (candidate.source_state !== 'committed' && candidate.source_state !== 'staged') {
    fail('candidate source_state must be committed or staged')
  }
  const isCommitted = candidate.tree_hash === candidate.indexed_tree_hash
  if ((candidate.source_state === 'committed') !== isCommitted) {
    fail('candidate source_state does not match candidate tree identity')
  }
  return candidate
}

export function assertCandidateIdentity(actual, expected, label = 'receipt') {
  validateCandidateIdentity(actual)
  validateCandidateIdentity(expected)
  for (const field of ['head_commit', 'base_commit', 'tree_hash', 'indexed_tree_hash', 'source_state']) {
    if (actual[field] !== expected[field]) {
      fail(`${label} candidate ${field} ${actual[field]} does not match this candidate ${expected[field]}`)
    }
  }
  return actual
}
