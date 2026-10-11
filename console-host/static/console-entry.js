import { createLiveConsoleHttpClient, createSessionStorageDrafts, mountTeamsConsole } from '/ui/browser.js'

mountTeamsConsole(document.getElementById('app'), createLiveConsoleHttpClient(), {
  initialOpen: true,
  locale: 'zh',
  persistence: typeof sessionStorage === 'undefined' ? undefined : createSessionStorageDrafts(sessionStorage),
})
