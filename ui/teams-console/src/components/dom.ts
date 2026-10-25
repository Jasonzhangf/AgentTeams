/** Shared DOM helpers for the Teams console views. */
export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const value = document.createElement(tag)
  if (className !== undefined) value.className = className
  return value
}

export function append(parent: Node, ...children: readonly (Node | string | null | undefined)[]): void {
  for (const child of children) {
    if (child === null || child === undefined) continue
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
}

export function button(
  label: string,
  className: string,
  action: () => void | Promise<void>,
  disabled = false,
  focusKey?: string,
): HTMLButtonElement {
  const value = element('button', `teams-button ${className}`)
  value.type = 'button'
  value.textContent = label
  value.disabled = disabled
  if (focusKey !== undefined) value.dataset.focusKey = focusKey
  value.addEventListener('click', async () => { await action() })
  return value
}
