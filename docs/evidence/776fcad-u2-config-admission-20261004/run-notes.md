# U2 776fcad current SDK admission and affected public config verification

Owner worktree `/Volumes/Intel/playground/agentteams/u2-config-admission-20261004`,
branch `codex/u2-config-admission-20261004`, base `4155c01b8c2107891a6a97579d96601d9cae0bf9`
(latest `origin/main` at start). Frozen U2 source from `e5f7604` was already applied
and staged; this task only verifies admission and adds its own evidence directory.
No commit/merge/push, no Collab/AGY/childagents, no memory, no real user HOME config.

Allowed write paths for this step:
`docs/evidence/776fcad-u2-config-admission-20261004/**` (evidence) plus the already
staged U2 product/map scope. The pin-lock-generated SDK refresh is recorded
separately in `generated-sdk-dependency.txt` and is NOT staged.

## Nodes (timestamps are UTC, from tool output)

| time/node | conclusion / evidence | input | next |
|---|---|---|---|
| 2026-10-04T07:24Z / N0 orient | Read project contract, work order, inherited seams run notes and primary consumption receipt. | base tree + receipts | scoped hash comparison |
| 2026-10-04T07:25Z / N1 scoped hashes | All 21 primary-receipt source fingerprints match byte-for-byte (source, tests, maps). `git diff -- docs/architecture` and `git diff -- config runtime control-protocol cli` are empty, i.e. staged U2 product and map rows are unchanged by this step. | primary receipt sourceHashes | SDK admission |
| 2026-10-04T07:25Z / N2 SDK admission | Pre-pin `appsdk verify` = `NON_CANONICAL_RECORD_CONTRACT_SET` (exit 1) and fails identically on clean main `4155c01b`: `.appsdk/project.json` carried 19 `governance.record_contracts` while the installed SDK requires 20. Official `appsdk pin-lock --binary /Users/fanzhang/.cargo/bin/appsdk` refreshed the pin to `0.1.0010` (20 records, `compiler_digest` = installed binary). Post-pin `appsdk verify` = `command_ok:true`, `stage:contract_bound` (exit 0); `appsdk compile` exit 0. Evidence: `pre-pin-verify.txt`, `pin-lock.txt`, `post-pin-verify.txt`, `compile.txt`, `post-compile-verify.txt`. | installed binary sha `84a8f6f2...`, SDK source `80f8524` | maps/graph checks |
| 2026-10-04T07:26Z / N3 maps + graph | `dagpipe graph validate` for `daemon-start.graph.json` and `provider-config.graph.json` both exit 0. Evidence: `graph-validation.txt`. | unchanged graphs | public consumer |
| 2026-10-04T07:26Z / N4 public consumer | Real-file consumer run against the compiled public boundary `generated/runtime-lib/runtime/local-config.js` (built by `appsdk compile` -> `pnpm build:runtime`). Real temp `config.toml` v3 with provider `services.file-search`; observed daemon `endpoint.services` projection and durable `[workControl]` readback after `writeLocalInternalLauncherState`. exit 0. Evidence: `public-consumer.jsonl`. | compiled boundary | record + stage |

## Red / green

- This is an admission/verification task, not a product change. No product red test was
  needed because every scoped source fingerprint already matches the consumed primary
  receipt; the seam red->green (`red.log`, `focused-green.log`, `mapped-green.log`) is
  inherited and reused unchanged.
- SDK admission green: pin-lock exit 0, verify `command_ok:true`, compile exit 0.
- Public consumer green: exit 0 with `endpoint.services` and `workControl` observed.

## Public consumer evidence

Command imports the compiled boundary (not source) and exercises exported APIs against
real files:

```sh
node --input-type=module - <<'EOF'
import { ... } from './generated/runtime-lib/runtime/local-config.js'
// real temp config.toml v3, .internal work-control.sock, launcher generation 7
EOF
```

Observed stdout (see `public-consumer.jsonl`):

```json
{"endpoint":{"role":"provider","services":[{"capabilityId":"file-search","version":"1","operations":["search"],"resources":[{"resourceId":"slot","capacity":1,"unit":"slot"}]}]},"workControl":{"socketPath":".../.agentteams/.internal/work-control.sock","launcherGeneration":7,"launcherStartToken":"admission-7"}}
```

## Generated official SDK dependency (recorded separately, not staged)

- `appsdk pin-lock --binary /Users/fanzhang/.cargo/bin/appsdk` rewrote `.appsdk/**` and
  root `contracts/**` (37 modified, 40 added). These are the official SDK refresh owned
  by the separate `852c3ac` dependency delivery; they are intentionally left unstaged.
- Post-pin digests: `sdk.lock fcf53045...`, `project.json ae0401d6...`,
  `sdk-resources.json 85e18dba...`. Full path list in `generated-sdk-dependency.txt`.
- `pnpm install --frozen-lockfile` exit 0; `pnpm-lock.yaml` byte-identical before/after
  (`pnpm-lock.before.sha256` == `pnpm-lock.after.sha256`).

## Dependencies / retained obligations

- U3 still owns `endpoint.services` decoding, adapter compilation and enabled capability
  publication; U4 owns the actual `workControl` socket lifecycle and installed Work.
  This task only proves the v3 user config, `endpoint.services` intent projection and
  same-lock `workControl` persistence; it does NOT claim BB02 / installed Work / MVP.
- The SDK refresh in this tree is the official pin-lock output, not a U2 semantic
  delivery; primary combines the separately merged `852c3ac` refresh before review.
