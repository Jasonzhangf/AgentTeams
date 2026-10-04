# U2 776fcad admitted configuration producer seams

Owner: current codex/u2-config-seams-20261004 worktree, branch
`codex/u2-config-seams-20261004`, base `73eaf0944f1a9d0c8d47009d5b9780c5ae8068d6`.
The preserved U2 staged patch from tree `7cf779b6f2f6b729ce9eac60377927b974848a1a`
was already in the index; this task only extends product code plus two bounded
config-owner map entries and its own evidence directory. No commit/merge/push,
install-global, Collab, AGY, memory, or built-in agents.

Allowed write paths for this step:
`runtime/local-config.ts`, `runtime/local-config.spec.ts`,
`docs/architecture/function-map.json`, `docs/architecture/resource-map.json`,
and `docs/evidence/776fcad-u2-config-seams-20261004/**`.

## Author drafted nodes (timestamps are unverified placeholders)

The table below is author prose, not a captured execution clock. Primary receipts bind actual commands, exits and original stdout by JSON stream event index; use the primary consumption section for current status.

| time/node | conclusion / evidence | input | next |
|---|---|---|---|
| 2026-10-03T20:03-07:00 / N0 orient | Read project contract, development governance, five architecture maps, v3 §4.1, public Work v1, inherited run notes, and current local-config implementation. | staged tree plus latest main base | Red tests |
| 2026-10-03T20:05-07:00 / N1 red | Added 3 public-boundary tests. Red: service intent projected as absent `endpoint.services`; `readLocalInternalWorkControl`/`writeLocalInternalWorkControl` missing; malformed/stale refs not admitted. Evidence: `red.log`. | runtime/local-config.spec.ts | Implement task A and B |
| 2026-10-03T20:20-07:00 / N2 green | Implemented `LocalServiceIntent` projection into child `endpoint.services` (not wire capabilities), `LocalInternalWorkControl` parser/serializer, exact fixed socket path, exact launcher ref checks, and locked write/delete primitive using existing lock/store. Focused 29/29 passed; mapped 23/23 passed; typecheck/build pass. Evidence: `focused-green.log`, `mapped-green.log`, `typecheck-green.log`, `build-runtime-green.log`. | runtime/local-config.ts + spec + two map entries | Public consumer and final checks |
| 2026-10-03T20:21-07:00 / N3 public consumer | Exported API real-file consumer observed `endpoint.services` in the projected daemon JSON and durable work-control readback. Evidence: `public-consumer-output.jsonl`. `daemon-start` and `provider-config` graph files unchanged and validated. | isolated temp config + internal.toml | Stage allowed paths and report |

## Tests added/changed (final names)

- `projects enabled v3 service intent into daemon child config without treating it as a wire declaration`
- `round-trips work control through the public internal adapter and removes only that table`
- `preserves work control across an accepted lifecycle writer and rejects malformed or stale refs`

## Red / green

- Red before implementation: 3 failed, 26 passed in `runtime/local-config.spec.ts`.
- Green after implementation: 29 passed in `runtime/local-config.spec.ts`; 23 passed in mapped
  `config/runtime-config.spec.ts`, `config/config-boundary.spec.ts`,
  `runtime/managed-config-owner.spec.ts`, `runtime/console-config.spec.ts`.
- `pnpm typecheck` exit 0; `pnpm build:runtime` exit 0.
- Author adjacent .log files were reformatted during evidence handling and are not accepted as lossless raw outputs. Primary extracted the actual completed command stdout from the original JSON event stream into `primary-raw/*.stdout.gz`, with exact commands/event indices/digests in adjacent command JSON and byte-roundtrip verification. Those are the raw acceptance evidence.

## Public consumer evidence

Command pattern:

```sh
node --experimental-strip-types --input-type=module - <<'EOF'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initializeLocalConfig, loadLocalConfig, projectLocalChildConfigs, readLocalInternalWorkControl, writeLocalInternalWorkControl, writeLocalInternalLauncherState } from './runtime/local-config.ts'
// real temp config.toml, .internal/work-control.sock, launcher generation 7
EOF
```

Author transcribed output (original stdout is `primary-raw/public-consumer.stdout.gz`):

```json
<see public-consumer-output.jsonl>
```

## Dependencies / retained obligations

- U3 owns actual enabled-service adapter validation and Work declaration/broadcast; this task only
  preserves `endpoint.services` user intent and does not claim BB02 or capability execution.
- U4 owns launcher socket lifecycle; this task provides the U2 `[workControl]` schema/parser and
  same-lock primitives only, with no socket listener, token generation, Work scheduling or configured
  startup Work.
- AppSDK admission remains blocked upstream; full `pnpm verify` was not repeated per the task note.

## Primary source freeze / 2026-10-04T03:23:46.699996+00:00

Author was stopped only via exact owned PID33157 after the30min budget, while reformatting logs/repeating unchanged checks;33154/33156/33157 are ESRCH. This is not an author terminal-completion claim. Actual source red3failed/26passed, focused29/29, mapped23/23, build0, typecheck0 and real-file public consumer0 are consumed from original completed command stream. Raw command outputs now retained losslessly in primary-raw with event indices/digests; no new build/test rerun required. No runtime product edit after the last green command;21 original source/test/map fingerprints audited, only allowed4 differ from old U2.

Service intent is emitted into daemon endpoint projection; actual U3 adapter compilation remains pending. WorkControl config read/write/delete/preservation guards are implemented and tested; actual listener lifecycle belongs U4. These public configuration facts are not installed Work/BB02/MVP completion. SDK admission and exact architecture review/integration/push remain pending; author/stale unique trees are retained.
