import { createConsoleHttpClient, mountTeamsConsole } from '/ui/browser.js'

mountTeamsConsole(document.getElementById('app'), createConsoleHttpClient(), { initialOpen: true, locale: 'zh' })
