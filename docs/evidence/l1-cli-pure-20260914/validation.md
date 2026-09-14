# L1 CLI pure delivery unit

Baseline: `origin/main` = `69a3e4b3d0d9986a6640e892562ba51116e6db9c`
(worktree `playground/l1-cli-pure-20260914`, branch
`codex/l1-cli-pure-20260914`).

Scope: only the CLI facade and its test admission. Allowed paths are
`cli/agentteams.mjs`, `cli/agentteams.spec.ts`, `vitest.config.ts`, the
`package.json` `bin` binding, and this evidence file. The runtime owner
(`runtime/local-process.ts`, `runtime/local-config.ts`) is provided by another
delivery unit and was not modified here.

## Source changes

- Added `cli/agentteams.mjs` exposing `agentteams init|start|status|work|stop`.
  It imports `startLocalProcess`, `statusLocalProcess`, `stopLocalProcess`, and
  `runLocalConfiguredWork` from `../runtime/local-process.ts` and never
  implements runtime lifecycle, config, or transport logic.
- `init` writes `config.toml` and `relay.json` with exclusive creation
  (`flag: 'wx'`, mode `0o600`). An existing `config.toml` fails with
  `config already exists: <path>`; an existing `relay.json` is left untouched.
  No pre-check/overwrite race exists because creation is the exclusive syscall.
  This is done at the CLI boundary because the baseline runtime
  `writeLocalConfig` has no exclusive-create option and runtime edits are out of
  scope for this delivery unit.
- `start` passes `SOURCE_ENTRIES` (`server/relay-process.ts`,
  `runtime/agent-process.ts`) plus the local credential env into
  `startLocalProcess`. `work` passes the same `SOURCE_ENTRIES` as the third
  `options` argument of `runLocalConfiguredWork(configPath, env, options)`, so
  an implicit start uses the same source child-entry bindings as explicit
  start.
- Added `cli/agentteams.spec.ts` covering exclusive init, concurrent init,
  preserved relay config, argument routing/`SOURCE_ENTRIES` parity between
  `start` and `work`, and explicit parse/runtime error surfacing.
- Added the `agentteams` `bin` binding to `package.json`.
- Added `cli/**/*.spec.ts` to the root Vitest include list so the focused CLI
  test is admitted by the project gate.

## Runtime dependency

`work` calls the declared runtime contract
`runLocalConfiguredWork(configPath, env, options)`. On this baseline that
runtime signature is supplied by the sibling runtime delivery unit; the CLI
code is written against the declared import and call contract only. If the
runtime API is absent or rejects the third argument, `work` fails explicitly at
the runtime boundary and does not fall back to a second lifecycle path.

## Validation

- `node --check cli/agentteams.mjs`: passed.
- `pnpm exec vitest run cli/agentteams.spec.ts`: passed, 1 file / 5 tests,
  after the root `vitest.config.ts` gained the `cli/**/*.spec.ts` include. The
  command used a temporary dependency link and out-of-tree Vite temp directory
  because the sandbox blocks writes through the prepared dependency link; both
  temporary links were removed after the run.
- Equivalent isolated run with
  `pnpm exec vitest run --config /private/tmp/vitest.cli.config.mts
  cli/agentteams.spec.ts`: passed, 1 file / 5 tests.
- `pnpm exec tsc --noEmit`: fails only in `opencode-adapter/src/index.ts` with
  missing `@opencode-ai/plugin` and `@opencode-ai/sdk` declarations plus
  resulting implicit-any errors. This is a pre-existing environment dependency
  gap; `cli/` is not in the root `tsconfig.json` include list, so this change
  is not part of that failure.
- Real disposable-HOME entrypoint
  `HOME=<temporary> node --experimental-transform-types cli/agentteams.mjs init`:
  passed, exit 0, created `config.toml` (2130 bytes, mode 0600) and
  `relay.json` (749 bytes, mode 0600, listen `127.0.0.1:48010`, 2 credentials).
  A second invocation exited 1 with
  `config already exists: <home>/.agentteams/config.toml`; both files were
  preserved.

## Pending

Real `start/status/work/stop/restart/generation-change` lifecycle replay needs
the runtime delivery unit's `runLocalConfiguredWork(..., options)` contract and
is blocked in this sandbox by localhost listener and `ps` restrictions. No
runtime lifecycle, deployment, or live-daemon evidence is claimed here.
