import type { ConsoleClientV1 } from './protocol.ts'
import { TeamsConsoleController } from './controller.ts'
import { containDrawerTab } from './focus.ts'
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
  let renderedState = controller.getSnapshot()
  let consoleFocusKey: string | undefined
  const drawerFocusKeys: (string | undefined)[] = []
  const activeFocusKey = (): string | undefined => document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focusKey : undefined
  const restoreFocus = (focusKey: string | undefined): void => {
    if (focusKey === undefined) return
    const target = [...root.querySelectorAll<HTMLElement>('[data-focus-key]')].find(candidate => candidate.dataset.focusKey === focusKey)
    target?.focus()
  }
  const render = () => {
    const nextState = controller.getSnapshot()
    if (!renderedState.open && nextState.open) consoleFocusKey = activeFocusKey()
    const drawerOpened = nextState.drawerStack.length > renderedState.drawerStack.length
    if (drawerOpened) drawerFocusKeys.push(activeFocusKey())
    let drawerFocusKey: string | undefined
    while (drawerFocusKeys.length > nextState.drawerStack.length) drawerFocusKey = drawerFocusKeys.pop()
    const restoreConsole = renderedState.open && !nextState.open
    const restoreDrawer = nextState.open && nextState.drawerStack.length < renderedState.drawerStack.length
    renderConsole(root, controller, options)
    if (drawerOpened) root.querySelector<HTMLElement>('.teams-drawer-header')?.focus()
    else if (restoreConsole) restoreFocus(consoleFocusKey)
    else if (restoreDrawer) restoreFocus(drawerFocusKey)
    renderedState = nextState
  }
  const unsubscribe = controller.subscribe(render)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Tab' && controller.getSnapshot().drawer !== null) {
      containDrawerTab(root, event)
      return
    }
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
