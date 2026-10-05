# U1 installed host repair notes

## Current final SDK candidate

Base is `468111a785ca21bb398369ce10b865be973be61c`; current validation is in
`current-final-gates.json` and `current-package-public.json`. All 19 public
package tests pass. Current final compile, library smoke, installed lifecycle,
installed SDK consumer and AppSDK verify exit zero. The installed SDK consumer
uses the real packaged host/runner and provider rg marker; it rejects five
tampered installed package copies and missing operator/effect compilation.
Installed lifecycle proves the current final package's Relay/two-Agent restart.

The map composition retains the retired historical-only receipt check and
dynamic regression wording. Prior source-prep typecheck and SDK36 are reused
only for unchanged source/dependency inputs. Current pack/install identities
come from the new receipts, not from the historical sections below.
This unit does not close installed public Work CLI, Console/Session or BB01–BB14.
Independent review and remote integration remain pending.

Task: consume the sole installed SDK host (`runtime/dagpipe/host.ts`) from the
staged npm pack, remove the duplicate host dispatcher from
`scripts/package-sdk-smoke.mjs`, and keep installed compile negatives.

## Baseline

- worktree: `/Volumes/Intel/playground/agentteams/u1-installed-host-owner-20261004`
- branch: `codex/u1-installed-host-owner-20261004`
- HEAD/base: `258aaec34e331db9d4667ba84850d086741f1589`
- inherited candidate blob in `scripts/package-sdk-smoke.mjs`: `6562b6f7b5910c8ae1089e5ba69479173328db0c`
- existing missing-host red:
  `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u1-sdk-final-pack-20261004/primary-installed-host-missing-red.stderr`
  exits `1` with `ERR_MODULE_NOT_FOUND` for
  `generated/runtime-lib/runtime/dagpipe/host.js`.

## Root defect and allowed fix

- `tsconfig.runtime.json` did not include `runtime/dagpipe/host.ts`, so the
  runtime build emitted no `runtime/dagpipe/host.js`.
- `scripts/package-sdk-smoke.mjs` duplicated host frame dispatch and channel
  bookkeeping that already exists in `runtime/dagpipe/host.ts`.
- Fix: add the host source root to `tsconfig.runtime.json` and replace the
  smoke dispatcher with the installed `runWorkExecution` export.

## Owned edits

- `tsconfig.runtime.json`: add `runtime/dagpipe/host.ts` to explicit build roots.
- `scripts/package-sdk-smoke.mjs`: import `runWorkExecution` from installed
  `generated/runtime-lib/runtime/dagpipe/host.js`; delete duplicate host
  framing/dispatch/channel code and unused imports; pass an explicit
  `file-search` `LocalServiceIntent[]` to `createCliWorkExecutor`.

## Evidence so far

- `pnpm install --frozen-lockfile`: passed.
- `pnpm build:runtime`: passed; emitted
  `generated/runtime-lib/runtime/dagpipe/host.js` and `protocol.js`.
- `pnpm build`: passed.
- `node scripts/package-artifact.mjs --mode final`: first attempt failed in
  receipt identity because `tsconfig.runtime.json` was not yet staged. Runner
  build itself completed.
- Final pack: `node scripts/package-artifact.mjs --mode final` passed and staged
  the official compiled host plus the runner, manifest, and five graphs.
- Installed host consumer:
  `node scripts/package-sdk-smoke.mjs --receipt-path .../installed-sdk.receipt.json`
  passed with status `completed`, business status `matched`, real
  `./alpha.txt` rg marker, and `workClosure=closed`.
- Installed runtime lifecycle smoke passed with
  `lifecycle.status=passed` and `release_eligible=false`.
- Targeted tests passed: `pnpm exec vitest run cli/agentteams.spec.ts
  server/deployment-contract.spec.ts --reporter verbose` (13/13).
- `pnpm typecheck`, `appsdk guide compile`, `appsdk compile`, and `pnpm smoke`
  passed.

## Boundary

This candidate closes the SDK-inclusive pack slice only. It does not claim
installed CLI Work, full U1/MVP, review, merge, or push. The primary owns
review, integration, source-tree cleanup, and final candidate admission.

Exact final hashes and command exits live in the external task evidence:
`/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u1-installed-host-owner-20261004/`.

## 2026-10-04T23:01Z / negative assertion root fix / IN PROGRESS

- Defect: `scripts/package-sdk-smoke.mjs` wrapped its own acceptance
  `fail(...)` in the same `catch` as `verifyInstalledRuntime(...)`.  An
  unchanged package that passed verification was therefore counted as one of
  the five rejected tamper cases.
- Root fix: move verifier invocation into a narrow helper.  The helper catches
  only the verifier rejection.  It asserts rejection after that catch.  Thus
  an accepted unchanged copy throws outside the verifier catch and stops the
  smoke.
- Counterexample source: valid unmodified installed copy from predecessor
  frozen runtime assets; manifest SHA256
  `589f6cd370dc4a69d5c6f03b5b8b522319543d0382e41020b743e41aa3cceaeb`,
  runner SHA256
  `ba37ddbda151cd104b84d638bda3be610b592618f02645f6ee9373fd23995707`.
- Old behavior evidence: an unchanged copy produced
  `OLD_ASSERTION_ACCEPTED_UNCHANGED_COPY` with old catch logic.
- New behavior evidence: the same copy is rejected by
  `assertInstalledRuntimeRejected` with
  `package SDK smoke: tampered installed package copy unchanged-installed-copy was accepted`.
- Mutated-copy evidence: the five current cases returned real verifier errors,
  not self-thrown acceptance errors.
- Staged candidate after the owned fix: indexed tree
  `8796aba181cc992f9c67655154670ba7d2f07843`, script SHA256
  `9491a7e3edfd6cc0172c15325554fe89fa321357bd83c8479ca250bfa0556eb0`.
- Current gates: `pnpm install --frozen-lockfile`, targeted Vitest
  (`cli/agentteams.spec.ts`, `server/deployment-contract.spec.ts`),
  `pnpm typecheck`, `appsdk guide compile`, `appsdk compile`, `pnpm smoke`,
  and `AGENTTEAMS_U1_INSTALLED_RECEIPT_PATH=... pnpm smoke:installed` all
  passed.
- Installed lifecycle receipt: status `passed`, indexed tree
  `8796aba181cc992f9c67655154670ba7d2f07843`, pack content SHA256
  `6119122ac8d5fa2608f4c7f6f14544ec5645d2fb54214fad3cae187ccd50a68d`,
  tarball SHA256
  `8dc05df8b4aeb43575a1da5fd89f131b9b6722ea481d48dd7ebc1d639efefa2a`.

## 2026-10-05T02:05Z | final composition handoff

Final worker tree: `/Volumes/Intel/playground/agentteams/u1-current-final-pack-20261005`,
branch `codex/u1-current-final-pack-20261005`, HEAD/base
`85ed441a0c18c9ce664598a802b57edfa30ddbf3`. Staged indexed tree is
`981d7c5a6f4af188da934bcc38f8a222e054aaaa`; HEAD tree is
`93a50e2700427dd63a680d040b7999b4b8cfe39f`.

Artifact contract now binds compiled `runtime/dagpipe/host.js`,
`runtime/dagpipe/protocol.js`, and the transitive control-protocol/network
runtime JS used by the installed SDK host: `endpoint-ref.js`, `json-value.js`,
`relay-codec.js`, `work-wire.js`, `network/work-channel.js`, and
`runtime/agent-work-client.js`.

Final package receipt: `generated/modules/teams-source/package-receipt.json`,
content SHA256
`6ac5b3723d81f0a8b5416bc55ee435891b5b400ab1b825b03dcfd0109cb9a038`, runner
SHA256 `f367f65d54ec5d338201a300cf9bf23441e7f757be616d296f03be083644b2b8`.
The same package identity is bound to the installed lifecycle receipt
(`start` generation 1 -> `restart` generation 2, stop `state=stopped`) and the
installed SDK consumer receipt (status `passed`, work `completed`,
`workClosure=closed`, real `./alpha.txt` rg marker). The SDK consumer records
two compile failures and five genuine tamper rejections:
`missing-runner`, `missing-manifest`, `missing-graph`, `runner-hash-mismatch`,
and `graph-hash-mismatch`.

Current worker evidence: `pnpm install --frozen-lockfile` passed,
`appsdk guide compile` passed, focused `cli/package-install.spec.ts` passed
`1 file / 20 tests / 0 failures / 0 pending`, `pnpm typecheck` passed,
`pnpm verify` passed `81 files / 557 tests / 0 failures / 0 pending`, and
`pnpm smoke:installed` passed. Exact raw logs and receipts are in
`/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u1-current-final-pack-20261005/`.

Handoff limits remain: public CLI Work, BB01-BB14, user acceptance, formal
review, commit, merge, push, memory, and issue closure are primary-owned.

Latest-main continuation, 2026-10-05: the preceding worker hashes and counts
are historical. This composite starts at main
`bca92a0411a2a787bf0189896623e7eb08124586`, including the delivered U3 services.
The current 20 package and 33 real service/SDK tests passed, as did typecheck.
After this evidence pointer is frozen, the current package is rebuilt and
tested through the same-package installed lifecycle and SDK consumers. Exact
candidate, package, runner and graph hashes, current receipts and raw exits
are recorded in
`/Users/fanzhang/.codex/task-evidence/agentteams/receipts/u1-latest-pack-20261005/candidate-receipt.json`.
This is the SDK packaging slice. Installed public CLI Work, Console lifecycle,
OpenCode Session and final BB01–BB14 acceptance remain pending.
