import { resolve } from 'node:path'

export default {
  root: resolve(import.meta.dirname),
  test: {
    include: ['*.spec.ts'],
  },
}
