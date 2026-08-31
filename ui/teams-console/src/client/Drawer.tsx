import { useRef, useState, type PointerEvent, type ReactNode } from 'react'
import type { TeamsKey } from './locale.ts'
import type { DrawerRequest, TeamsConsoleController } from './controller.ts'
import css from './teams.module.css'

interface DrawerProps {
  readonly drawer: DrawerRequest
  readonly depth: number
  readonly controller: TeamsConsoleController
  readonly t: (key: TeamsKey) => string
  readonly children: ReactNode
}

export function Drawer({ drawer, depth, controller, t, children }: DrawerProps): ReactNode {
  const startY = useRef<number | null>(null)
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    startY.current = event.clientY
    setDragging(true)
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const start = startY.current
    startY.current = null
    setDragging(false)
    event.currentTarget.releasePointerCapture(event.pointerId)
    if (start === null) return
    const delta = event.clientY - start
    if (delta < -48) controller.toggleExpanded()
    if (delta > 48) controller.popDrawer()
  }

  return (
    <section
      className={`${css.drawer} ${depth > 0 ? css.drawerNested : ''} ${dragging ? css.drawerDragging : ''}`}
      style={{ zIndex: 20 + depth }}
      aria-label={drawer.kind === 'session' ? t('currentSession') : drawer.kind === 'notifications' ? t('notifications') : drawer.agent.label}
    >
      <header
        className={css.drawerHeader}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
      >
        <div className={css.drawerHeaderCopy}>
          <span className={css.drawerHandle} aria-hidden />
          <div>
            <strong>{drawer.kind === 'session' ? drawer.agent.currentSessionTitle : drawer.kind === 'notifications' ? t('notifications') : drawer.agent.label}</strong>
            <span>{drawer.agent.machine} · {drawer.agent.label}</span>
          </div>
        </div>
        <div className={css.drawerActions}>
          <button type="button" className={css.drawerButton} onClick={() => { controller.toggleExpanded() }}>
            {controller.getSnapshot().expanded ? t('collapse') : t('expand')}
          </button>
          <button type="button" className={css.drawerButton} onClick={() => { controller.popDrawer() }}>
            {t('close')}
          </button>
        </div>
      </header>
      <div className={css.drawerBody}>{children}</div>
    </section>
  )
}
