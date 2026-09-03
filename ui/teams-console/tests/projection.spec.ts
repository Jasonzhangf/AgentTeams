import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const client = join(import.meta.dirname, '../src/client')

const uiFiles = [
  'controller.ts',
  'Drawer.tsx',
  'TeamsOverlay.tsx',
  'TeamsSidebarAction.tsx',
  'index.ts',
  'model.ts',
  'dsh-adapter.ts',
  'slots.ts',
  'locale.ts',
]

const runtimeModuleMarker = '@deepseek-ai/dsh-client-runtime/client'

const truthPaths = [
  '@/../agent',
  '@/../config',
  '@/../memory-plugin',
  '@/../runtime',
  '@/../search-plugin',
  '@/../server',
  '@/../network',
  '@/../dsh-adapter/agent-identity',
]

describe('Teams UI projection boundary', () => {
  it('treats the Teams UI as a single client-runtime consumer', () => {
    const consumers = uiFiles.filter(file => {
      const text = readFileSync(join(client, file), 'utf8')
      return text.includes(runtimeModuleMarker)
    })
    expect(consumers.length).toBeGreaterThan(0)
    for (const consumer of consumers) {
      const otherFiles = uiFiles.filter(file => file !== consumer)
      for (const other of otherFiles) {
        const text = readFileSync(join(client, other), 'utf8')
        for (const path of truthPaths) {
          expect(text.includes(path)).toBe(false)
        }
      }
    }
  })

  it('routes mutations through the controller and host bindings only', () => {
    const controller = readFileSync(join(client, 'controller.ts'), 'utf8')
    const index = readFileSync(join(client, 'index.ts'), 'utf8')
    expect(controller.includes('sessions.open')).toBe(false)
    expect(controller.includes('localStorage.setItem')).toBe(false)
    expect(index.includes('ctx.reflect.provide')).toBe(false)
    expect(index.includes('config.save')).toBe(false)
  })
})
