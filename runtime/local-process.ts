import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createLocalSupervisor, type LocalSupervisor } from './local-supervisor.ts'
import { loadLocalConfig, defaultLocalConfigPath } from './local-config.ts'

export function parseLocalProcessArgs(argv: readonly string[]): string {
  if (argv.length === 0) return defaultLocalConfigPath()
  if (argv.length === 2 && argv[0] === '--config' && argv[1].trim() !== '') return resolve(argv[1])
  if (argv.length === 1 && argv[0].startsWith('--config=') && argv[0].slice('--config='.length).trim() !== '') {
    return resolve(argv[0].slice('--config='.length))
  }
  throw new Error('usage: local-process [--config <file>]')
}

export type LocalSupervisorFactory = (config: Awaited<ReturnType<typeof loadLocalConfig>>) => LocalSupervisor

export async function runLocalProcess(
  argv: readonly string[] = process.argv.slice(2),
  createSupervisor: LocalSupervisorFactory = createLocalSupervisor,
): Promise<void> {
  const config = await loadLocalConfig(parseLocalProcessArgs(argv))
  const supervisor = createSupervisor(config)
  let stopping: Promise<void> | undefined
  const stop = () => {
    if (stopping) return
    stopping = supervisor.stop().catch(error => {
      process.exitCode = 1
      console.error(error instanceof Error ? error.message : String(error))
    })
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  await supervisor.start()
  console.log(`local supervisor ready config=${config.configPath} daemons=${config.daemons.filter(daemon => daemon.enabled).map(daemon => daemon.id).join(',')}`)
  let runtimeFailure: Error | undefined
  await new Promise<void>(resolveStopped => {
    const poll = () => {
      if (stopping) void stopping.finally(resolveStopped)
      else if (supervisor.state() === 'failed') {
        runtimeFailure = supervisor.failure() ?? new Error('local supervisor failed')
        stopping = supervisor.stop().catch(error => {
          process.exitCode = 1
          console.error(error instanceof Error ? error.message : String(error))
        })
        void stopping.finally(resolveStopped)
      }
      else setTimeout(poll, 50)
    }
    poll()
  })
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  if (supervisor.state() !== 'stopped') throw new Error('local supervisor did not stop')
  if (runtimeFailure) {
    process.exitCode = 1
    throw runtimeFailure
  }
}

const invokedPath = process.argv[1] === undefined ? undefined : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runLocalProcess().catch(error => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
