import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { currentCandidateIdentity } from './receipt-identity.mjs'

const root = resolve(import.meta.dirname, '..')
const moduleRoot = resolve(root, 'generated', 'modules', 'teams-source')
const output = resolve(moduleRoot, 'lib')
const receiptPath = resolve(moduleRoot, 'package-receipt.json')
const rootPackagePath = resolve(root, 'package.json')

function fail(message) {
  throw new Error(`package artifact: ${message}`)
}

function parseMode(argv) {
  let mode = 'final'
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--mode') {
      mode = argv[index + 1]
      index += 1
    } else if (argument.startsWith('--mode=')) {
      mode = argument.slice('--mode='.length)
    } else {
      fail(`unknown argument: ${argument}`)
    }
  }
  if (mode !== 'base' && mode !== 'final') fail(`mode must be base or final, received: ${mode ?? '<missing>'}`)
  return mode
}

function requireFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) fail(`required ${label} is missing: ${path}`)
}

function requireDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) fail(`required ${label} is missing: ${path}`)
}

function copyFile(source, destination, label) {
  requireFile(source, label)
  mkdirSync(resolve(destination, '..'), { recursive: true })
  cpSync(source, destination)
}

function copyDirectory(source, destination, label) {
  requireDirectory(source, label)
  cpSync(source, destination, { recursive: true })
}

function listFiles(directory) {
  const files = []
  const visit = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) visit(child)
      else if (entry.isFile()) files.push(relative(directory, child).split(sep).join('/'))
      else fail(`unsupported staged entry: ${child}`)
    }
  }
  visit(directory)
  return files.sort()
}

function hashFileSet(directory, files) {
  const digest = createHash('sha256')
  for (const file of files) {
    digest.update(file)
    digest.update('\0')
    digest.update(readFileSync(join(directory, file)))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function packageManifest(rootPackage) {
  const required = ['name', 'version', 'type', 'bin', 'files', 'engines', 'os', 'cpu', 'dependencies']
  for (const field of required) {
    if (rootPackage[field] === undefined) fail(`root package.json is missing required field: ${field}`)
  }
  return {
    name: rootPackage.name,
    version: rootPackage.version,
    private: true,
    type: rootPackage.type,
    bin: rootPackage.bin,
    files: rootPackage.files,
    engines: rootPackage.engines,
    os: rootPackage.os,
    cpu: rootPackage.cpu,
    dependencies: rootPackage.dependencies,
  }
}

const mode = parseMode(process.argv.slice(2))
if (mode === 'final') {
  fail('final mode requires the frozen D3/U4 SDK build receipt interface; no runner build interface is available')
}

requireFile(rootPackagePath, 'root package.json')
const rootPackage = JSON.parse(readFileSync(rootPackagePath, 'utf8'))
rmSync(output, { recursive: true, force: true })
rmSync(receiptPath, { force: true })
mkdirSync(output, { recursive: true })

copyFile(resolve(root, 'cli', 'agentteams.mjs'), resolve(output, 'cli', 'agentteams.mjs'), 'CLI entry')
copyDirectory(resolve(root, 'generated', 'runtime-lib'), resolve(output, 'generated', 'runtime-lib'), 'compiled runtime')
copyDirectory(resolve(root, 'console-host', 'lib'), resolve(output, 'console-host', 'lib'), 'Console library')
copyDirectory(resolve(root, 'console-host', 'static'), resolve(output, 'console-host', 'static'), 'Console static assets')
copyDirectory(resolve(root, 'ui', 'teams-console', 'lib'), resolve(output, 'ui', 'teams-console'), 'UI library')
copyDirectory(resolve(root, 'ui', 'teams-console', 'assets'), resolve(output, 'ui', 'teams-console', 'assets'), 'UI assets')

const manifest = packageManifest(rootPackage)
writeFileSync(resolve(output, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)

const files = listFiles(output)
const receipt = {
  schema_version: 1,
  mode,
  release_eligible: false,
  version: manifest.version,
  candidate: currentCandidateIdentity(root),
  pack_root: relative(root, output).split(sep).join('/'),
  content_sha256: hashFileSet(output, files),
  files,
  dependencies: manifest.dependencies,
  sdk: {
    included: false,
    reason: 'base mode explicitly omits runtime/dagpipe runner, manifest and graphs',
  },
}
writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`)
console.log(`package artifact ${mode} ${manifest.name}@${manifest.version} ${receipt.content_sha256} ${receipt.pack_root}`)
