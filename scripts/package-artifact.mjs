import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

// Package actual compiled libraries and the Console's required static assets.
// Missing build output is an error; this producer never creates placeholder code.
const root = resolve(import.meta.dirname, '..')
const output = resolve(root, 'generated/modules/teams-source/lib')
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
cpSync(resolve(root, 'opencode-adapter/lib'), resolve(output, 'opencode-adapter'), { recursive: true })
cpSync(resolve(root, 'console-host/lib'), resolve(output, 'console-host'), { recursive: true })
cpSync(resolve(root, 'console-host/static'), resolve(output, 'static'), { recursive: true })
cpSync(resolve(root, 'generated/runtime-lib'), resolve(output, 'runtime'), { recursive: true })
cpSync(resolve(root, 'ui/teams-console/lib'), resolve(output, 'ui'), { recursive: true })
cpSync(resolve(root, 'ui/teams-console/assets'), resolve(output, 'ui/assets'), { recursive: true })
