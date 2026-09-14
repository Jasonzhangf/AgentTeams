# c3c2e0e CLI entry validation

- Base: `origin/main@68ea2303a1acc70facb028b385c01bebdfa5e27b`
- Worktree: `playground/c3c2e0e-cli-entry-r2-20260914`
- Scope: `cli/agentteams.mjs`, `cli/agentteams.spec.ts`, `package.json`, this evidence file
- Root cause: the CLI statically imported `runtime/*.ts`; Node 22 strip-only execution rejects the parameter property in `LocalProcessError` before `init` runs.

## Candidate behavior

- The CLI dynamically loads only the compiled `generated/runtime-lib` modules and reports a direct `build:runtime` instruction when artifacts are absent or unloadable.
- `start` and configured `work` pass compiled `relay-process.js` and `agent-process.js` entries to the runtime supervisor.
- `init` delegates config persistence and `loadLocalConfig` to the compiled runtime owner, which atomically creates `internal.toml` from the user `config.toml`.
- `config.toml` remains the user source; child JSON remains an internal projection.
- Root `package.json` explicitly ships `cli` and `generated/runtime-lib`, so the
  package binary resolves the same compiled runtime from an installed copy.
- `prepack` runs `build:runtime`, making generated runtime production deterministic
  before tarball creation.

## Verification

Commands run from this worktree:

```text
PATH=/Volumes/extension/code/AgentTeams/node_modules/.bin:$PATH pnpm build:runtime
=> exit 0

PATH=/Volumes/extension/code/AgentTeams/node_modules/.bin:$PATH pnpm exec vitest run --config vitest.config.ts cli/agentteams.spec.ts
=> 1 file passed, 7 tests passed

The focused spec builds `generated/runtime-lib` in `beforeAll`, so the canonical
direct Vitest gate is self-contained on a clean checkout.

```text
PATH=/Volumes/extension/code/AgentTeams/node_modules/.bin:$PATH pnpm exec vitest run --config vitest.config.ts cli/agentteams.spec.ts runtime/local-config.spec.ts runtime/local-supervisor.spec.ts runtime/local-process.spec.ts
=> 4 files passed, 36 tests passed

appsdk compile
=> exit 0; artifact_hash=sha256:73ce3deb23508328e3e219a0bb5be402e018f820927bcc694a94910d48a5047a

appsdk verify
=> ok=true; stage=contract_bound; delivery_verified=false (admission not requested)

PATH=/Volumes/extension/code/AgentTeams/node_modules/.bin:$PATH pnpm typecheck
=> exit 0

PATH=/Volumes/extension/code/AgentTeams/node_modules/.bin:$PATH pnpm test
=> exit 0; 78 files passed, 482 tests passed

```text
pnpm pack --pack-destination <temporary directory>
=> prepack built runtime; tarball contains cli/agentteams.mjs and generated/runtime-lib/**

isolated consumer install from that tarball:
  pnpm add --ignore-scripts <agentteams-0.1.0.tgz>
  pnpm exec agentteams init
  pnpm exec agentteams start
  pnpm exec agentteams status
  pnpm exec agentteams work
  pnpm exec agentteams stop --generation 1
  pnpm exec agentteams start
  pnpm exec agentteams stop --generation 2
=> all commands exited 0; work succeeded; installed compiled lifecycle proved
```
```

node --check cli/agentteams.mjs
=> exit 0

git diff --check
=> exit 0

```text
pnpm pack --dry-run --json
=> package file list includes cli/agentteams.mjs and generated/runtime-lib/**
```
```

Direct disposable-home entrypoint:

```text
HOME=/private/tmp/agentteams-cli-c3c2e0e.PrBFN3 node cli/agentteams.mjs init
=> exit 0; config.toml, internal.toml, relay.json, relay-key.pem, relay-cert.pem and files/ exist
```

The generated `internal.toml` contains `version = 1`, a config revision, relay projection, and both provider/receiver daemon projections. The compiled runtime artifact hashes at validation time were:

```text
d09ebe4ad370b0d60f24827ba852a5cbe635529857194a46153ba7880c2e7df2  generated/runtime-lib/runtime/local-config.js
b5bcfbf71f655ff44d3ae38dbba81c6308a557c95327d1dc243265a0154b1532  generated/runtime-lib/runtime/local-process.js
3387737036e7c54a6b8c54c370ce6a06fff25c0e43d70aafd67e3f310d4106bf  generated/runtime-lib/server/relay-process.js
20e55c03ab9452f76cadf690d7cfd97dd99250cbbbb9ac40cb0509a1ab217857  generated/runtime-lib/runtime/agent-process.js
```

Real CLI lifecycle on the same disposable home:

```text
start => state=running generation=1
status => state=running generation=1
work => succeeded agent=receiver work=configured-search request=configured-search-1 state=succeeded
stop --generation 1 => state=stopped generation=1
start => state=running generation=2
status => state=running generation=2
stop --generation 1 => exit 1, stale local supervisor generation expected=1 current=2
work => succeeded agent=receiver work=configured-search request=configured-search-1 state=succeeded
stop --generation 2 => state=stopped generation=2
status => state=stopped generation=2
```

The executable smoke now runs the complete compiled lifecycle, including both
generation stops and the stale-generation rejection; it is the same sequence
asserted by `cli/agentteams.spec.ts`, not an injected runtime mock.

## Boundaries

- This candidate fixes the packaged CLI boundary and init-time `internal.toml` creation. It does not claim public NAT, mobile, or Console-offline acceptance.
- Full AppSDK lifecycle admission, exact review, integration, push, cleanup, and bug closure remain downstream delivery steps.
