import { resolve } from 'node:path'

export default {
  root: resolve(import.meta.dirname, '..'),
  test: {
    allowOnly: false,
    include: ['cli-adapter/**/*.spec.ts'],
  },
}
