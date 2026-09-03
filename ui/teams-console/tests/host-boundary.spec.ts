import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const client = join(import.meta.dirname, '../src/client')
const overlay = readFileSync(join(client, 'TeamsOverlay.tsx'), 'utf8')
const controller = readFileSync(join(client, 'controller.ts'), 'utf8')
const model = readFileSync(join(client, 'model.ts'), 'utf8')
const slots = readFileSync(join(client, 'slots.ts'), 'utf8')
const index = readFileSync(join(client, 'index.ts'), 'utf8')

const forbiddenCredentialTokens = ['password', 'secret', 'apikey', 'bearer', 'token:']

const authorityDecisionPatterns = [
  /relation\s*===?\s*['"]/,
  /relation\s*!==?\s*['"]/,
]

const businessPayloadTokens = [
  'session.history',
  'session.queue',
  'session.approval',
  'session.draft',
]

function stripJsxTags(text: string): string {
  return text.replace(/<[^>]+>/g, '')
}

describe('UI boundary against credential, permission, and host command payload leakage', () => {
  it('UI never carries credential fields in any module', () => {
    const sources = [overlay, controller, model, slots, index]
    for (const source of sources) {
      const lowered = source.toLowerCase()
      for (const token of forbiddenCredentialTokens) {
        expect(lowered.includes(token)).toBe(false)
      }
    }
  })

  it('UI never makes authority or disabled decisions based on agent.relation', () => {
    const sources = [stripJsxTags(overlay), controller]
    for (const source of sources) {
      for (const pattern of authorityDecisionPatterns) {
        expect(source.match(pattern)).toBeNull()
      }
    }
  })

  it('UI never reads session business body fields to construct a host command', () => {
    const sources = [overlay, controller]
    for (const source of sources) {
      for (const token of businessPayloadTokens) {
        expect(source.includes(token)).toBe(false)
      }
    }
  })
})
