import type { ConsoleClientV1 } from './protocol.ts'
import { TeamsConsoleController } from './controller.ts'
import { renderConsole } from './render.ts'
import { teamsStyles } from './styles.ts'

export interface MountTeamsConsoleOptions {
  readonly initialOpen?: boolean
  readonly locale?: 'en' | 'zh'
  readonly fixtureLabel?: string
}

export interface MountedTeamsConsole {
  readonly controller: TeamsConsoleController
  readonly destroy: () => void
}

function installStyles(): void {
  if (document.getElementById('teams-console-styles') !== null) return
  const style = document.createElement('style')
  style.id = 'teams-console-styles'
  style.textContent = teamsStyles
  document.head.append(style)
}

export function mountTeamsConsole(root: HTMLElement, client: ConsoleClientV1, options: MountTeamsConsoleOptions = {}): MountedTeamsConsole {
  installStyles()
  const controller = new TeamsConsoleController(client)
  if (options.locale !== undefined) controller.setLocale(options.locale)
  const render = () => { renderConsole(root, controller, options) }
  const unsubscribe = controller.subscribe(render)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !controller.getSnapshot().open) return
    event.preventDefault()
    if (controller.getSnapshot().drawer !== null) controller.closeDrawer()
    else controller.closeConsole()
  }
  document.addEventListener('keydown', onKeyDown)
  render()
  if (options.initialOpen === true) controller.openConsole()
  return {
    controller,
    destroy: () => {
      unsubscribe()
      document.removeEventListener('keydown', onKeyDown)
      root.replaceChildren()
    },
  }
}

export type { ConsoleClientV1 }
export { TeamsConsoleController }
