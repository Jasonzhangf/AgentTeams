import type { TeamsConsoleController } from './controller.ts'

export interface TeamsSidebarFace {
  readonly controller: TeamsConsoleController
}

export interface TeamsOverlayFace {
  readonly controller: TeamsConsoleController
}
