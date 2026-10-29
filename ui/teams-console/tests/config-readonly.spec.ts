import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TeamsConsoleController } from '../src/state/controller.ts'
import { createFixtureClient } from '../src/fixture.ts'

const srcRoot = join(import.meta.dirname, '../src')

/**
 * The Console provider/model surface is a read-only projection of the config-owned
 * source of truth. These guards fail if a write entrypoint is reintroduced on the
 * shipped UI surface or if the controller starts building a config-mutating command.
 */
describe('Console provider/model config surface is read-only', () => {
  it('refuses provider/model write commands without dispatching a config command', async () => {
    const fixture = createFixtureClient()
    const kinds: string[] = []
    const controller = new TeamsConsoleController({
      ...fixture,
      async command(request) {
        kinds.push(request.kind)
        return fixture.command(request)
      },
    })
    await controller.refresh()
    await expect(controller.putProvider('planner')).resolves.toBe(false)
    await expect(controller.bindModel('planner', 'rcc', 'deepseek-v4')).resolves.toBe(false)
    await expect(controller.refreshModels('planner', 'rcc')).resolves.toBe(false)
    await expect(controller.applyConfig('planner')).resolves.toBe(false)
    expect(controller.getSnapshot().error).toBe(controller.configReadonlyError)
    expect(kinds.filter(kind => kind.startsWith('config.'))).toEqual([])
  })

  it('issues no config command while the settings view is opened and an agent is selected', async () => {
    const fixture = createFixtureClient()
    const kinds: string[] = []
    const controller = new TeamsConsoleController({
      ...fixture,
      async command(request) {
        kinds.push(request.kind)
        return fixture.command(request)
      },
    })
    await controller.refresh()
    controller.openSettings('planner')
    controller.selectAgent('reviewer')
    controller.openSettings()
    await controller.refresh()
    expect(kinds.filter(kind => kind.startsWith('config.'))).toEqual([])
  })

  it('never constructs a config-mutating wire command in the shipped UI source', () => {
    const sources = {
      controller: readFileSync(join(srcRoot, 'state/controller.ts'), 'utf8'),
      render: readFileSync(join(srcRoot, 'components/render.ts'), 'utf8'),
    }
    for (const [label, source] of Object.entries(sources)) {
      expect(source, `${label} builds a config wire command`).not.toContain("kind: 'config.")
    }
  })
})
