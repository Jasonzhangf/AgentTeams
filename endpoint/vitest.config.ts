import { resolve } from 'node:path'

export default {
  root: resolve(import.meta.dirname, '..'),
  test: {
    allowOnly: false,
    include: ['endpoint/**/*.spec.ts'],
  },
}
