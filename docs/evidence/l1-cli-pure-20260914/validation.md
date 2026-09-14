# L1 CLI pure delivery unit

Delivery base: `9387edad408556565658c0b2d41dbce0b61ed811`
(`fix(3742b9a): close local runtime config and work contract`). The CLI facade
was first committed at `591ebe8072a51c931d32771d335c805e8160ff03`; this fix
delivery unit (immediate parent `27554122dd938685f570d1b01d13c91fc04ad61c`,
worktree `playground/l1-cli-fix-20260914`, branch
`codex/l1-cli-fix-20260914`) corrects the exact-review P1s on top of it.

Scope: only the CLI facade and its test admission. Allowed paths are
`cli/agentteams.mjs`, `cli/agentteams.spec.ts`, and this evidence file (plus the
`cli/agentteams.mjs` executable bit if needed). The runtime owner
(`runtime/local-process.ts`, `runtime/local-config.ts`) is provided by parent
`9387eda` and was not modified here.

## Source changes

- Added `cli/agentteams.mjs` exposing `agentteams init|start|status|work|stop`.
  It imports `startLocalProcess`, `statusLocalProcess`, `stopLocalProcess`, and
  `runLocalConfiguredWork` from `../runtime/local-process.ts`, and
  `writeLocalConfig` from `../runtime/local-config.ts`. It never implements
  runtime lifecycle or transport logic.
- `init` writes `config.toml` through the runtime owner
  `writeLocalConfig(configPath, text, { exclusive: true })`. The CLI keeps no
  duplicate config-write helper; it only maps the runtime `EEXIST` to
  `config already exists: <path>` and other failures to
  `cannot create config: <path>: <message>`.
- `init` writes `relay.json` through the same runtime owner with exclusive
  creation. An existing `relay.json` is preserved (`EEXIST` is tolerated).
- `init` generates the local relay TLS material `relay-key.pem` and
  `relay-cert.pem`. `relay.json` advertises a `wss://` endpoint and references
  both files, so a default init must produce them to be usable. The runtime
  owner exposes no TLS bootstrap API and runtime edits are out of scope, so the
  facade uses the same `openssl req -x509 ...` invocation the repository's local
  smoke scripts already use (`scripts/runtime-smoke.mjs`,
  `scripts/installed-runtime-smoke.mjs`). Both files are set to mode `0600`. A
  complete existing pair is left untouched; a partial pair (only one file) fails
  explicitly and never silently substitutes or overwrites material.
- `init` creates the default fixed search root (`files`) and resolves the default
  `rg` executable from `PATH`, so a clean local machine does not inherit a
  platform-specific executable path or a missing root directory.
- `start` passes `SOURCE_ENTRIES` (`server/relay-process.ts`,
  `runtime/agent-process.ts`) plus the local credential env into
  `startLocalProcess`. `work` passes the same `SOURCE_ENTRIES` as the third
  `options` argument of `runLocalConfiguredWork(configPath, env, options)`, so
  an implicit start uses the same source child-entry bindings as explicit start.
- Added `cli/agentteams.spec.ts` covering exclusive init, generated TLS artifact
  validity, explicit failure on incomplete TLS material, concurrent init,
  preserved relay config, argument routing/`SOURCE_ENTRIES` parity between
  `start` and `work`, and explicit parse/runtime error surfacing.
- The `agentteams` `bin` binding in `package.json` and the `cli/**/*.spec.ts`
  entry in the root Vitest include list were already committed at `591ebe8` and
  are unchanged by this fix.

## Runtime dependency

The runtime API used here already exists at parent `9387eda`:
`writeLocalConfig(path, text, { exclusive: true })` in
`runtime/local-config.ts`, and
`runLocalConfiguredWork(configPath, env, options)` in
`runtime/local-process.ts`. These are the declared runtime owner signatures at
the baseline, not a pending sibling-unit dependency. If the runtime API rejects
the call, `work` fails explicitly at the runtime boundary and does not fall back
to a second lifecycle path.

## Validation

- `node --check cli/agentteams.mjs`: passed.
- `git diff --check`: passed.
- Focused test run
  `/Volumes/extension/code/AgentTeams/playground/r7-local-runtime-20260914/node_modules/.bin/vitest run
  --config /private/tmp/agentteams-cli-vitest.config.mts`: passed, 1 file / 6
  tests. The candidate worktree temporarily linked the already-installed
  dependency tree for this run; the link was removed before commit.
- Running the repo-root config directly (`vitest run cli/agentteams.spec.ts`)
  fails at config load with `EPERM ... mkdir node_modules/.vite-temp` through
  that same dependency link. This is a sandbox/dependency-link artifact, not a
  test failure.
- Real disposable-HOME entrypoint
  `HOME=/private/tmp/agentteams-cli-smoke2.93mvGL node --experimental-transform-types cli/agentteams.mjs init`:
  passed, exit 0. Created `config.toml`, `relay.json`, `files/`,
  `relay-key.pem`, and `relay-cert.pem`; the generated config resolved `rg` to
  `/opt/homebrew/bin/rg` and the certificate subject was `CN=localhost`.
  A second invocation was covered by the focused test and exited with
  `config already exists` while preserving the existing config.
- Real CLI lifecycle on the same disposable HOME:
  `start` passed at generation 1; `status` reported `running`; `work` returned
  `succeeded agent=receiver work=configured-search request=configured-search-1`;
  `stop --generation 1` passed; a restart passed at generation 2; stale
  `stop --generation 1` failed explicitly with `STALE_GENERATION`; final
  `stop --generation 2` and `status` passed with `state=stopped`.
- `pnpm exec tsc --noEmit`: fails only in `opencode-adapter/src/index.ts` with
  missing `@opencode-ai/plugin` and `@opencode-ai/sdk` declarations plus
  resulting implicit-any errors. This is a pre-existing environment dependency
  gap; `cli/` is not in the root `tsconfig.json` include list, so this change
  is not part of that failure.

`init` TLS generation requires a working `openssl` on PATH. When it is missing
or fails, `init` exits with
`cannot generate relay TLS material in <dir>: <detail>`; it never claims success
without the material.
