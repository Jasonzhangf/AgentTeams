const focusableSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]'

export function containDrawerTab(root: HTMLElement, event: KeyboardEvent): boolean {
  if (event.key !== 'Tab') return false
  const drawer = root.querySelector<HTMLElement>('.teams-drawer')
  if (drawer === null) return false
  const focusable = [...drawer.querySelectorAll<HTMLElement>(focusableSelector)]
  const first = focusable[0]
  const last = focusable.at(-1)
  if (first === undefined || last === undefined) {
    event.preventDefault()
    drawer.focus()
    return true
  }

  const active = root.ownerDocument.activeElement
  if (!drawer.contains(active)) {
    event.preventDefault()
    ;(event.shiftKey ? last : first).focus()
    return true
  }
  if (event.shiftKey && active === first) {
    event.preventDefault()
    last.focus()
    return true
  }
  if (!event.shiftKey && active === last) {
    event.preventDefault()
    first.focus()
    return true
  }
  return false
}
