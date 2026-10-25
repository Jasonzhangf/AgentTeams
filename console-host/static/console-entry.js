import { createGroupRequestClient, createLiveConsoleHttpClient, createSessionStorageDrafts, mountTeamsConsole, withGroupRequests } from '/ui/browser.js'

const client = withGroupRequests(createLiveConsoleHttpClient(), createGroupRequestClient())

mountTeamsConsole(document.getElementById('app'), client, {
  initialOpen: true,
  locale: 'zh',
  persistence: typeof sessionStorage === 'undefined' ? undefined : createSessionStorageDrafts(sessionStorage),
})
