import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TeamsSidebarFace } from './slots.ts'
import type { TeamsKey } from './locale.ts'
import type { TeamsConsoleController } from './controller.ts'
import css from './teams.module.css'

export type TeamsSidebarActionProps =
  PropsRuntime<'sidebar.footer.action'>
  & PropsLocale<'teams'>
  & TeamsSidebarFace

export interface TeamsSidebarActionInjected {
  readonly controller: TeamsConsoleController
}

export function TeamsSidebarAction(props: TeamsSidebarActionProps): ReactNode {
  const label = props.t('entry')
  return (
    <button
      type="button"
      className={css.sidebarAction}
      aria-label={label}
      title={label}
      onClick={() => { props.controller.openConsole() }}
    >
      <span className={css.sidebarMark} aria-hidden>TS</span>
      {props.wide && <span>{label}</span>}
    </button>
  )
}

export type { TeamsKey }
