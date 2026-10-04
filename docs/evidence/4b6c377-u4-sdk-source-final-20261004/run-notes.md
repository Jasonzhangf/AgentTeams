# U4 SDK source slice author notes

Owner: independent GCM implementation worker for Desktop primary.
Worktree: `/Volumes/Intel/playground/agentteams/u4-sdk-source-final-20261004`.
Branch: `codex/u4-sdk-source-final-20261004`.
Base: `47e14005ab61b9ce53cc7f4ab8987ac47c6aae33`.
Allowed product scope: `runtime/dagpipe/**`, `runtime/dagpipe-work.spec.ts`,
`runtime/agent-work-client.ts`, `runtime/agent-work-client.spec.ts`, U4 entries in
the five architecture maps, and this evidence directory.

This phase author-verifies the SDK/host/client library source slice. It does not
close full U4 installed delivery.

## Evidence ready after build/test

| Time | Node | State | Conclusion / evidence | Next |
|---|---|---|---|---|
| 2026-10-04 | baseline | complete | HEAD is `47e1400`; inherited U4 source files are present in the worktree; previous persistent evidence was read and is unchanged. | Freeze source slice. |
| 2026-10-04 | install | complete | `pnpm install --frozen-lockfile` completed without lockfile changes. | Run focused build/test. |
| 2026-10-04 | maps | complete | Existing U4 map entries were updated to partial source/library status; installed gate remains PENDING. | Run command gates. |
| 2026-10-04 | build | complete | `node runtime/dagpipe/build.mjs` passed against public `pipeline_runtime 0.1.1` at `/Users/fanzhang/.local/share/dagpipe/sdk`; artifact SHA recorded in the external receipt. | Run runtime build and focused tests. |
| 2026-10-04 | runtime-build | complete | `pnpm build:runtime` exited 0. | Run focused suite. |
| 2026-10-04 | focused | complete | `pnpm exec vitest run --no-file-parallelism runtime/dagpipe-work.spec.ts runtime/agent-work-client.spec.ts` exited 0, 26/26 tests passed across 2 files. The suite exercised real compiled SDK runner, TLS Relay/local sockets, provider ledger, one-shot submit/query, persistent open/request/query/close, stale/incomplete rejection, compile rejections, bad correlation/EOF/malformed runner frames, and transport-unconfirmed retention. | Run remaining gates. |
| 2026-10-04 | runtime-gates | complete | `pnpm typecheck`, `node --check runtime/dagpipe/build.mjs`, and `git diff --check` exited 0. | Validate graphs. |
| 2026-10-04 | graph-validate | complete | All five approved graph files validated as SESE with exact identities. | Run official appsdk gates. |
| 2026-10-04 | appsdk-guide | complete | `appsdk guide compile` exited 0 (advisory). | Run appsdk compile. |
| 2026-10-04 | appsdk-compile | blocked | `appsdk compile` exited 1: `MODULE_BUILD_FAILED:teams-source`. `scripts/receipt-identity.mjs` rejected inherited untracked evidence dirs `docs/evidence/4b6c377-d3-u4-20261003/**` and `docs/evidence/4b6c377-u4-sdk-persistent-20261004/**` as `candidate has untracked product paths`. The 9262-owned identity helper and the inherited records are out of this worker's scope. | Primary resolves the untracked-path staging boundary. |
| 2026-10-04 | smoke | blocked | `pnpm smoke` failed because `appsdk compile` produced no `generated/modules/teams-source/package-receipt.json` (same root cause). | Blocked on appsdk compile. |
| 2026-10-04 | appsdk-verify | complete | `appsdk verify` exited 0 with `development_ready:true`, `delivery_verified:false`, `ok:false`, `reason:"delivery_not_evaluated"`. Library/source development admission only; not full U4 delivery. | Report source admission. |
| 2026-10-04 | smoke-installed | blocked | `pnpm smoke:installed` (`build:governance`) exited 1 on the same `receipt-identity` untracked-path check. This is the base product install gate, distinct from new SDK installed Work. | Blocked on the same identity boundary. |
| 2026-10-04 | latest-main-combination | complete | The two map conflicts keep the latest-main Relay rows and take the U4 library rows with installed Work PENDING. The current author evidence target is `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-source-integrate-20261004/candidate-receipt.json`. | Freeze maps/note. |
| 2026-10-04 | freeze | complete | Final frozen: HEAD/base `47e1400`, 18 staged paths. The exact staged index tree and hashes are written to the external evidence directory, not tracked here. | Hand off to primary. |

## Current correction r2

The `appsdk-compile`, `smoke`, and `smoke:installed` rows above are historical
failures. The current candidate corrects their fixture-ownership cause by
tracking the three runner fixtures under `runtime/dagpipe/fixtures/` and
referencing only that test-owned directory. The old evidence-directory
dependency is absent.

| Time | Node | State | Conclusion / evidence | Next |
|---|---|---|---|---|
| 2026-10-04 | current-fixtures | complete | The three tracked fixture bytes match the inherited originals; no old evidence directory is present. | Run current gates. |
| 2026-10-04 | current-build | complete | `node runtime/dagpipe/build.mjs` exited 0; raw log: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-fixtures-live-20261004/raw/build.log`. | Build runtime. |
| 2026-10-04 | current-runtime-build | complete | `pnpm build:runtime` exited 0; raw log: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-fixtures-live-20261004/raw/build-runtime.log`. | Run focused suite. |
| 2026-10-04 | current-focused | complete | `pnpm exec vitest run --no-file-parallelism runtime/dagpipe-work.spec.ts runtime/agent-work-client.spec.ts` exited 0, 26/26 tests passed; raw log: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-fixtures-live-20261004/raw/focused.log`. | Run current admission gates. |

Current candidate commands, exits, raw logs, identity, hashes, installed
validation, cleanup, and limitations are recorded by the stable external
CURRENT pointer:
`/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-fixtures-live-20261004/candidate-receipt.json`.
No tree hash is embedded in this source note.

## Current correction r3: dynamic receipts leave product source

The r2 `afterAll` wrote `build-receipt.json` and
`u4-sdk-source-final-work-results.json` into tracked
`docs/evidence/4b6c377-u4-sdk-source-final-20261004/results/`. Those bytes
contain per-run timestamps, runner paths, and search timings. A second public
consumer run therefore changed staged product source before compile, and
`currentCandidateIdentity` failed with `staged product does not match the
recorded index`.

| Time | Node | State | Conclusion / evidence | Next |
|---|---|---|---|---|
| 2026-10-04 | r3-archive | complete | The tracked index and observed copies of both dynamic JSON files are archived individually under the external receipt directory `tracked-results-archive/`; each pair differs and has its own SHA256. | Remove the redundant tracked copies. |
| 2026-10-04 | r3-owner-fix | complete | `runtime/dagpipe-work.spec.ts` now writes dynamic receipts only below ignored `generated/u4-receipts/<run-id>/results/`; the run id is supplied by `U4_RECEIPT_RUN_ID` or the process id. The two tracked result copies are removed. | Run the public consumer twice. |

Dynamic receipts stay outside the product tree. The verification map records
the clean-source acceptance condition. No SDK identity helper, assertion,
count, registry, graph, or semantic behavior changes in this correction.

Historical r3 external pointer:
`/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-source-integrate-20261004/candidate-receipt.json`.
That receipt binds the historical candidate identity, the two public 26-test runs
with their identity and clean-source guards, and the remaining acceptance
commands. Historical r2 result links are archived under the external
`tracked-results-archive/`; current genuine run results are preserved under the
external `generated-receipts/` directory and ignored `generated/` output.

## Known boundary

The source/library consumer is runnable. The CLI/launcher socket, receiver
executor, installed runner/graph/manifest pack, final package, and real
installed black-box evidence are not part of this phase. `teams-work-sdk-installed`
remains PENDING.

Detailed receipts, build hash, and freeze identity are written to
`/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-source-final-20261004/`.

## Current correction r4: input preflight and terminal protocol

Formal r4 review FAILed two P1s: malformed Work input could reach
`agentWork.propose` before the host rejected it, and known `execution.result`
frames with missing `compiled`/`identity`/`journal` could reject public
`runWorkExecution` or let a later terminal frame masquerade as success.

| Time | Node | State | Conclusion / evidence | Next |
|---|---|---|---|---|
| 2026-10-04 | r4-red-input | confirmed | The red case returned `EXECUTION_FAILED` before the fix and could produce provider effects for missing request/demand/business fields; raw log: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-input-protocol-fix-20261004/raw/focused-red-input.log`. | Move graph-aware validation before spawn. |
| 2026-10-04 | r4-red-final | confirmed | Malformed known terminals rejected from `runWorkExecution` (`compiled.output_arcs` TypeError, missing output ARC) or returned completed for wrong identity/duplicate final; raw log: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-input-protocol-fix-20261004/raw/focused-red-final.log`. | Decode known final shapes and enforce one correlated terminal. |
| 2026-10-04 | r4-targeted-green | complete | The two corrected P1 cases passed 6/6 with 13 skipped; raw log: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-input-protocol-fix-20261004/raw/focused-green-p1.log`. | Run the full focused suite. |
| 2026-10-04 | r4-focused | complete | `pnpm exec vitest run runtime/dagpipe-work.spec.ts runtime/agent-work-client.spec.ts` passed 32/32 across two files; raw log: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-input-protocol-fix-20261004/raw/focused-full.log`. | Run remaining gates. |
| 2026-10-04 | r4-final-candidate | complete | Final staged identity is HEAD `fce39c2073d100b49893182d2b74408825b67f14`, write-tree `2992e00c4b37ac87c3e89fe35ba3e3df86128736`; final focused suite passed 32/32 with raw log `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-input-protocol-fix-20261004/raw/focused-final-candidate.log`. | Write external candidate receipt. |

The correction keeps provider ledger/admission ownership unchanged, validates
only the five current graph contracts, and preserves complete business values
for valid Work executions. Query and close still reject only their own missing
control bindings; they do not require a request business payload.

## Primary latest-main composition

The earlier author identities and receipts are historical checkpoints. The
author summary copied the HEAD commit into its `tree_hash` field; that field
is invalid and is preserved in the original evidence. Git and the official
installed receipt provide the actual identities. The primary stopped the
bounded author after consuming the raw validation; no author final is claimed.

The current candidate combines the unchanged U4 owner source with main
`fe97c5284476c484769bb2945a5353190cca99f7`. Its 32 public consumers,
typecheck, Guidance compile, AppSDK compile, smoke and installed BASE replay
passed. This note-only clarification preserves those test inputs; the package
and installed receipts are rebound to the final staged identity. The current
primary receipt is
`/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-sdk-p1-current-main-20261004/candidate-receipt.json`.
AppSDK reports a current baseline and `development_ready=true`; full delivery
is not evaluated. Installed SDK Work and the complete MVP remain pending.

## Correction r6: terminal settlement and endpoint query preflight

Formal review r5 failed the two P1s described by
`/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u4-terminal-query-fix-20261004/review-r5-result.json`:
a valid first `execution.result` could still be reported completed after a second
terminal, malformed frame or host.call, and endpoint-mode `work-query` missing
`requestId` escaped preflight.

| Time | Node | State | Conclusion / evidence | Next |
|---|---|---|---|---|
| 2026-10-04 | r6-red | confirmed | With new cases only, the old source returned `EXECUTION_FAILED` for endpoint missing `requestId`, and returned `completed` for valid-first plus duplicate terminal, valid-first plus malformed frame and valid-first plus host.call; the valid-only control remained completed. Raw log: `/Volumes/Intel/playground/agentteams/u4-terminal-query-fix-20261004/generated/u4-receipts/u4-terminal-query-fix-20261004/raw/focused-red-r6-final.log`. | Restore the final-settlement and endpoint query fixes. |
| 2026-10-04 | r6-green | complete | `runRunner` now treats every frame after the first terminal as HOST_PROTOCOL and stops dispatch, while final settlement only completes a single valid correlated result. `validateExecutionIntent` requires `requestId` for every work-query mode. Targeted red, failure and control cases passed 5/5. Raw log: `/Volumes/Intel/playground/agentteams/u4-terminal-query-fix-20261004/generated/u4-receipts/u4-terminal-query-fix-20261004/raw/focused-green-r6-final.log`. | Run full consumers and gates. |
| 2026-10-04 | r6-focused | complete | `pnpm exec vitest run runtime/dagpipe-work.spec.ts runtime/agent-work-client.spec.ts --reporter verbose` passed 35/35 across two files. Raw log: `/Volumes/Intel/playground/agentteams/u4-terminal-query-fix-20261004/generated/u4-receipts/u4-terminal-query-fix-20261004/raw/focused-full-r6-final.log`. | Run build, typecheck and graph gates. |
| 2026-10-04 | r6-gates | complete | `pnpm build:runtime`, `pnpm --dir opencode-adapter build`, `pnpm typecheck`, and `dagpipe graph validate` for the five Work graphs exited 0. Raw logs: `/Volumes/Intel/playground/agentteams/u4-terminal-query-fix-20261004/generated/u4-receipts/u4-terminal-query-fix-20261004/raw/{build-runtime,adapter-build,typecheck,graph-validate}-r6-final.log`. | Freeze exact candidate. |

This correction changes only host final settlement, endpoint query preflight,
the owned malformed-final fixture and public Work spec cases. It adds no parser,
fallback, release path or graph change.
