import { cpSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const packageRoot = resolve(import.meta.dirname, '..')
const temporaryRoot = resolve(packageRoot, '.ts-build')
const compiledUiRoot = resolve(temporaryRoot, 'ui/teams-console/src')
const compiledCanonicalRoot = resolve(temporaryRoot, 'control-protocol')
const libraryRoot = resolve(packageRoot, 'lib')

rmSync(libraryRoot, { recursive: true, force: true })
cpSync(compiledUiRoot, libraryRoot, { recursive: true })
cpSync(compiledCanonicalRoot, resolve(libraryRoot, 'canonical'), {
  recursive: true,
  filter: source => statSync(source).isDirectory() || source.endsWith('.d.ts'),
})

function rewriteDeclarationImports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      rewriteDeclarationImports(path)
    } else if (entry.name.endsWith('.d.ts')) {
      const source = readFileSync(path, 'utf8')
        .replaceAll('../../../../control-protocol/console-api.ts', '../canonical/console-api.js')
        .replace(/(['"])(\.[^'"]+)\.ts\1/g, '$1$2.js$1')
      writeFileSync(path, source)
    }
  }
}

rewriteDeclarationImports(libraryRoot)
rmSync(temporaryRoot, { recursive: true, force: true })
