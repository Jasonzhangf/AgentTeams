import { createServer, type RequestListener } from 'node:http'
import { createServer as createSecureServer } from 'node:https'
import { readFile, realpath } from 'node:fs/promises'
import { extname, isAbsolute, relative, resolve } from 'node:path'
import { createConsoleApiHandler, type ConsoleApiOptions } from './http-api.ts'

export interface ConsoleServerOptions extends ConsoleApiOptions {
  readonly staticRoot: string
  readonly uiRoot: string
  readonly authenticationChallenge?: string
  readonly tls?: { readonly cert: Buffer; readonly key: Buffer }
}

/** Presentation/API transport only. Runtime supplies the authenticated remote client binding. */
export function createConsoleServer(options: ConsoleServerOptions) {
  const api = createConsoleApiHandler(options)
  const staticRoot = resolve(options.staticRoot)
  const uiRoot = resolve(options.uiRoot)
  const handler: RequestListener = async (request, response) => {
    try {
      const path = new URL(request.url ?? '/', 'http://console.invalid').pathname
      if (path.startsWith('/api/')) { await api(request, response); return }
      if (!await options.authorize(request)) {
        if (options.authenticationChallenge) response.setHeader('www-authenticate', options.authenticationChallenge)
        response.writeHead(401, { 'cache-control': 'no-store' }); response.end('Authentication required'); return
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
      let root: string
      let file: string
      if (path === '/' || path === '/index.html') { root = staticRoot; file = 'console.html' }
      else if (path === '/console-entry.js') { root = staticRoot; file = 'console-entry.js' }
      else if (path.startsWith('/ui/')) { root = uiRoot; file = decodeURIComponent(path.slice(4)) }
      else { response.writeHead(404); response.end(); return }
      const types: Readonly<Record<string, string>> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml' }
      const type = types[extname(file)]
      if (!type) { response.writeHead(404); response.end(); return }
      const [actualRoot, actualFile] = await Promise.all([realpath(root), realpath(resolve(root, file))])
      const within = relative(actualRoot, actualFile)
      if (within === '..' || within.startsWith('../') || isAbsolute(within)) { response.writeHead(404); response.end(); return }
      const content = await readFile(actualFile)
      response.writeHead(200, {
        'content-type': type, 'content-length': content.length, 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      })
      response.end(request.method === 'HEAD' ? undefined : content)
    } catch (error) {
      const status = (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500
      if (!response.headersSent) { response.writeHead(status, { 'cache-control': 'no-store' }); response.end('Console request failed') }
      else response.destroy()
    }
  }
  return options.tls ? createSecureServer(options.tls, handler) : createServer(handler)
}
