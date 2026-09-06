import { createFixtureClient } from './fixture.ts'
import { mountTeamsConsole } from './client/index.ts'

const root = document.querySelector<HTMLElement>('#app')
if (root === null) throw new Error('Teams fixture requires #app')

mountTeamsConsole(root, createFixtureClient(), {
  initialOpen: true,
  locale: 'en',
  fixtureLabel: 'Browser fixture — host projection only; not live daemon/device E2E',
})
