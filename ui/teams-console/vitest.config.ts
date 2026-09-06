import { resolve } from 'node:path'

export default {
  root: resolve(import.meta.dirname, '../../..'),
  test: {
    include: ['ui/teams-console/tests/**/*.spec.ts'],
  },
}
