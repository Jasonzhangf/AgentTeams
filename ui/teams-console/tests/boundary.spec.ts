import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const sourceRoot = join(import.meta.dirname, '../src')
const sourceFiles = [
  'client/api.ts', 'client/controller.ts', 'client/index.ts', 'client/model.ts', 'client/protocol.ts', 'client/render.ts', 'client/styles.ts', 'fixture.ts', 'index.ts',
]

describe('independent UI boundary', () => {
  it('has no DSH, Cordis, deepseek-harness, or parent runtime imports', () => {
    const source = sourceFiles.map(file => readFileSync(join(sourceRoot, file), 'utf8')).join('\n')
    expect(source).not.toMatch(/@deepseek-ai\/dsh|@deepseek-ai\/cordis|deepseek-harness|from ['"]\.\.\/\.\.\/\.\.(agent|config|network|server|runtime)/)
  })

  it('uses the injected client and keeps Session payload separate from control target', () => {
    const index = readFileSync(join(sourceRoot, 'client/index.ts'), 'utf8')
    const api = readFileSync(join(sourceRoot, 'client/api.ts'), 'utf8')
    const render = readFileSync(join(sourceRoot, 'client/render.ts'), 'utf8')
    expect(index).toContain('client: ConsoleClientV1')
    expect(api).toContain('/api/v1/projection')
    expect(api).toContain('/api/v1/command')
    expect(api).toContain('/api/v1/session-message')
    expect(render).toContain('const payload: JsonValue = { text: textarea.value }')
    expect(render).not.toContain('session.history')
    expect(render).not.toContain('session.metadata')
  })

  it('keeps credential values and local persistence out of the UI source', () => {
    const source = sourceFiles.map(file => readFileSync(join(sourceRoot, file), 'utf8')).join('\n').toLowerCase()
    expect(source).not.toContain('localstorage')
    expect(source).not.toContain('password')
    expect(source).not.toContain('api_key')
    expect(source).toContain('credentialref')
  })
})
