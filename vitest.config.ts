import { resolve } from 'node:path'

export default {
  root: resolve(import.meta.dirname),
  test: {
    allowOnly: false,
    // Real-process and real-DOM suites inflate far past the vitest 5000ms default when the
    // gate runs 164 files in parallel on a loaded host: the same cases measure 0.3-1.4s
    // isolated but exceed 5s under load, so the default produced rotating false failures in
    // the BB13 acceptance case. 90s matches the budget recorded for the full regression in
    // docs/evidence/*-u6-installed-session-20261007/validation.md.
    testTimeout: 90_000,
    hookTimeout: 90_000,
    include: [
      'cli/**/*.spec.ts',
      'agent-host/**/*.spec.ts',
      'cli-adapter/**/*.spec.ts',
      'server/**/*.spec.ts',
      'network/**/*.spec.ts',
      'control-protocol/*.spec.ts',
      'console-host/tests/**/*.spec.ts',
      'agent/**/*.spec.ts',
      'config/**/*.spec.ts',
      'runtime/**/*.spec.ts',
      'opencode-adapter/**/*.spec.ts',
      'memory-plugin/**/*.spec.ts',
      'search-plugin/**/*.spec.ts',
      'ui/teams-console/tests/**/*.spec.ts',
      'endpoint/**/*.spec.ts',
      'scripts/**/*.spec.ts',
    ],
  },
}
