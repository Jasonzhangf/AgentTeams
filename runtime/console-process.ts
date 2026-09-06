import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAgentDeclaration, RelayProtocolError } from '../control-protocol/relay-codec.ts'
import { object, text, number, credential, loadRelayConfig } from './process-config.ts'
import { startConsoleRuntime, type ConsoleRuntimeOptions } from './console-runtime.ts'

export async function loadConsoleProcessConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<ConsoleRuntimeOptions> {
  const configPath = resolve(path)
  const input = object(JSON.parse(await readFile(configPath, 'utf8')),
    ['version', 'identity', 'scopeId', 'presenceIntervalMs', 'agentIds', 'listen', 'auth', 'staticRoot', 'uiRoot', 'relay'], 'Console config')
  if (input.version !== 1) throw new RelayProtocolError('UNSUPPORTED_VERSION', 'Console config version must be 1')
  const location = (value: unknown, label: string) => resolve(dirname(configPath), text(value, label))
  const listen = object(input.listen, ['host', 'port', 'origin', 'certFile', 'keyFile'], 'Console listen')
  const auth = object(input.auth, ['username', 'passwordEnv'], 'Console auth')
  const password = credential(auth.passwordEnv, env)
  if (!Array.isArray(input.agentIds) || input.agentIds.some(id => typeof id !== 'string' || !id) || new Set(input.agentIds).size !== input.agentIds.length) {
    throw new RelayProtocolError('INVALID_INPUT', 'Console Agent IDs must be unique')
  }
  if (!Number.isSafeInteger(listen.port) || (listen.port as number) < 0 || (listen.port as number) > 65535) throw new RelayProtocolError('INVALID_INPUT', 'Invalid Console port')
  if ((listen.certFile === undefined) !== (listen.keyFile === undefined)) throw new RelayProtocolError('INVALID_INPUT', 'Console TLS requires both certificate and key')
  const declaration = parseAgentDeclaration({ identity: input.identity, scopeId: input.scopeId, revision: 1, capabilities: [], routes: [] })
  return {
    host: text(listen.host, 'Console host'), port: listen.port as number, origin: text(listen.origin, 'Console origin'),
    username: text(auth.username, 'Console username'), password, agentIds: [...input.agentIds] as string[],
    staticRoot: location(input.staticRoot, 'Console staticRoot'), uiRoot: location(input.uiRoot, 'Console uiRoot'),
    ...(listen.certFile === undefined ? {} : { tls: { cert: await readFile(location(listen.certFile, 'Console certificate')),
      key: await readFile(location(listen.keyFile, 'Console key')) } }),
    daemon: { presenceIntervalMs: number(input.presenceIntervalMs, 'presenceIntervalMs'),
      relay: await loadRelayConfig(input.relay, declaration, configPath, env) },
  }
}

export async function runConsoleProcess(argv = process.argv.slice(2)): Promise<void> {
  if (argv.length !== 2 || argv[0] !== '--config') throw new RelayProtocolError('INVALID_INPUT', 'usage: console-process --config <file>')
  const handle = await startConsoleRuntime(await loadConsoleProcessConfig(argv[1]))
  const stop = () => { void handle.stop().catch(() => { process.exitCode = 1; console.error('Console shutdown failed') }) }
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  process.send?.({ kind: 'console.listening', url: handle.url })
  try { await handle.closed } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void runConsoleProcess().catch(error => {
    console.error('Console process failed:', error instanceof RelayProtocolError ? error.code : 'UNAVAILABLE')
    process.exitCode = 1
  })
}
