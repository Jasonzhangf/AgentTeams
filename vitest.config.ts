import { resolve } from 'node:path'

export default {
  root: resolve(import.meta.dirname),
  test: {
    allowOnly: false,
    include: [
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
      'dsh-adapter/**/*.spec.ts',
      'ui/teams-console/tests/**/*.spec.ts',
    ],
  },
}
