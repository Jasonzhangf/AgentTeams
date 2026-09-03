import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const agentFiles = [
  'relation-graph.ts',
  'notification-projection.ts',
]

const truthPaths = [
  '../network',
  '../config',
  '../server',
  '../runtime',
]

describe('Agent module boundary', () => {
  it('never imports network, config, server, or runtime modules', () => {
    for (const file of agentFiles) {
      const text = readFileSync(join('Teams/agent', file), 'utf8')
      for (const path of truthPaths) {
        expect(text.includes(`from '${path}`)).toBe(false)
        expect(text.includes(`from "${path}`)).toBe(false)
      }
    }
  })

  it('exposes only pure functions and types from agent modules', () => {
    for (const file of agentFiles) {
      const text = readFileSync(join('Teams/agent', file), 'utf8')
      expect(text.includes('export function')).toBe(true)
      expect(text.includes('class ')).toBe(false)
    }
  })
})
