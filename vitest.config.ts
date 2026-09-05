import { resolve } from 'node:path'

export default {
  root: resolve(import.meta.dirname),
  test: {
    include: [
      'agent-host/**/*.spec.ts',
      'server/**/*.spec.ts',
      'network/**/*.spec.ts',
      'control-protocol/*.spec.ts',
      'console-host/tests/**/*.spec.ts',
    ],
  },
}
