import { cpSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const packageRoot = resolve(import.meta.dirname, '..')
const temporaryRoot = resolve(packageRoot, '.ts-build')
const compiledUiRoot = resolve(temporaryRoot, 'ui/teams-console/src')
const compiledCanonicalRoot = resolve(temporaryRoot, 'control-protocol')
const libraryRoot = resolve(packageRoot, 'lib')
const canonicalRoot = resolve(libraryRoot, 'canonical')

rmSync(libraryRoot, { recursive: true, force: true })
cpSync(compiledUiRoot, libraryRoot, { recursive: true })
// The browser client consumes the shared console contract at runtime, so the compiled
// canonical modules ship next to the UI library instead of staying declaration-only.
cpSync(compiledCanonicalRoot, canonicalRoot, { recursive: true })

const canonicalSpecifier = /(['"])(?:\.\.\/)+control-protocol\/([\w./-]+)\.(?:ts|js)\1/g

function rewriteCanonicalImports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      rewriteCanonicalImports(path)
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.d.ts')) {
      const source = readFileSync(path, 'utf8')
        .replace(canonicalSpecifier, (_match, quote, target) => {
          const rewritten = relative(dirname(path), resolve(canonicalRoot, `${target}.js`))
          return `${quote}${rewritten.startsWith('.') ? rewritten : `./${rewritten}`}${quote}`
        })
        .replace(/(['"])(\.[^'"]+)\.ts\1/g, '$1$2.js$1')
      writeFileSync(path, source)
    }
  }
}

rewriteCanonicalImports(libraryRoot)
rmSync(temporaryRoot, { recursive: true, force: true })
