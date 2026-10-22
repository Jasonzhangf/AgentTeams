import { execFileSync, execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createTlsServer } from 'node:tls'
import { tmpdir } from 'node:os'
import { join as joinPath } from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)

let directory: string
let key: Buffer
let cert: Buffer
let server: ReturnType<typeof createTlsServer> | undefined
let url: string
let closedUrl: string
let caPath: string

beforeAll(async () => {
  directory = mkdtempSync(joinPath(tmpdir(), 'join-'))
  const keyPath = joinPath(directory, 'key.pem')
  const certPath = joinPath(directory, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost', '-keyout', keyPath, '-out', certPath, '-days', '1'], { stdio: 'ignore' })
  caPath = certPath
  key = readFileSync(keyPath)
  cert = readFileSync(certPath)
  server = createTlsServer({ key, cert }, (socket) => socket.end())
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  url = `wss://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  closedUrl = `wss://127.0.0.1:1`
})

afterAll(() => {
  server?.close()
  rmSync(directory, { recursive: true, force: true })
})

async function runJoin(args: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['cli/join.mjs', ...args], { encoding: 'utf8', cwd: process.cwd(), timeout: 20_000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string }
    return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
  }
}

describe('agentteams join', () => {
  it('writes a v4 agent config after a real TLS handshake', async () => {
    const configPath = joinPath(directory, 'agent-a.toml')
    const result = await runJoin(['--remote', url, '--ca', caPath, '--endpoint', '127.0.0.1:7445', '--serve', 'dsh', '--name', 'reasoner-a', '--config', configPath, '--no-start'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('reachable=true')
    const text = readFileSync(configPath, 'utf8')
    expect(text).toContain('version = 4')
    expect(text).toContain('kind = "dsh"')
    expect(text).toContain('id = "reasoner-a"')
    expect(text).toContain(`url = "${url}"`)
    expect(text).toContain('credentialEnv = "AGENTTEAMS_RELAY_CREDENTIAL"')
    expect(text).not.toMatch(/(?:token|secret|password)\s*=/iu)
  })

  it('is reachable through the agentteams entry as a subcommand', async () => {
    const configPath = joinPath(directory, 'agent-d.toml')
    const { stdout } = await execFileAsync(process.execPath, ['cli/agentteams.mjs', 'join', '--remote', url, '--ca', caPath, '--endpoint', '127.0.0.1:7446', '--serve', 'opencode', '--name', 'reasoner-d', '--config', configPath, '--no-start'], { encoding: 'utf8', cwd: process.cwd(), timeout: 20_000 })
    expect(stdout).toContain('reachable=true')
    expect(readFileSync(configPath, 'utf8')).toContain('kind = "opencode"')
  })

  it('refuses to rebuild a config that declares another identity', async () => {
    const configPath = joinPath(directory, 'agent-b.toml')
    writeFileSync(configPath, 'version = 4\n\n[daemon]\nkind = "agent"\nid = "existing-agent"\n')
    const before = readFileSync(configPath, 'utf8')
    const result = await runJoin(['--remote', url, '--endpoint', '127.0.0.1:7445', '--serve', 'dsh', '--name', 'other-agent', '--config', configPath, '--no-start'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('refusing to rebuild')
    expect(readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('keeps the previous config when the relay is unreachable', async () => {
    const configPath = joinPath(directory, 'agent-c.toml')
    writeFileSync(configPath, 'version = 4\n\n[daemon]\nkind = "agent"\nid = "reasoner-c"\n')
    const before = readFileSync(configPath, 'utf8')
    const result = await runJoin(['--remote', closedUrl, '--endpoint', '127.0.0.1:7445', '--serve', 'dsh', '--name', 'reasoner-c', '--config', configPath, '--no-start'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('unreachable')
    expect(readFileSync(configPath, 'utf8')).toBe(before)
  })

  it('verifies the relay certificate by default and refuses an untrusted peer', async () => {
    const configPath = joinPath(directory, 'agent-e.toml')
    // The relay is self-signed and no anchor is given, so verification must fail
    // and the config must not be written.
    const result = await runJoin(['--remote', url, '--endpoint', '127.0.0.1:7447', '--serve', 'dsh', '--name', 'reasoner-e', '--config', configPath, '--no-start'])
    expect(result.code).not.toBe(0)
    expect(result.stderr).toContain('unreachable')
    expect(existsSync(configPath)).toBe(false)
  })

  it('reaches the relay only when the bypass is asked for explicitly', async () => {
    const configPath = joinPath(directory, 'agent-f.toml')
    const result = await runJoin(['--remote', url, '--insecure', '--endpoint', '127.0.0.1:7448', '--serve', 'dsh', '--name', 'reasoner-f', '--config', configPath, '--no-start'])
    expect(result.code).toBe(0)
    // The bypass is announced, never silent.
    expect(result.stderr).toContain('TLS verification bypassed')
    expect(existsSync(configPath)).toBe(true)
  })
})
