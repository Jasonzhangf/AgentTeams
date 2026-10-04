# U1 Package Implementation Run Notes

## 2026-10-03T06:13:23Z | baseline

- Status: running.
- Source: `AGENTS.md`, `docs/development-governance.md`,
  `docs/goals/teams-user-delivery-plan.md`, behavior contracts/model,
  `version-delivery.graph.json`, and the five architecture maps.
- Design: `u1-package-design-20261003/docs/design/teams-package-delivery.md`,
  file SHA-256
  `608b00d91a26d18869d77dc7b222e7b1b64b77222567dd0d5d10b78db457124b`.
- Candidate: branch `codex/u1-package-impl-20261003`, base/origin/main
  `8d143ae8bab7594d25402282a4a2ed33d06919b0`, clean worktree.
- Environment: Node `v22.22.2`, pnpm `10.31.0`, npm `10.9.7`.
- Observation: root `npm pack` contains only `cli/**` and
  `generated/runtime-lib/**`; current `scripts/package-artifact.mjs` emits a
  fixed-version flat artifact at `generated/modules/teams-source/lib/` with
  `runtime/**`, `console-host/**`, `static/**`, and `ui/**`, not the approved
  install root layout.
- Next: add the red public package gate before changing producer or package
  metadata.

## 2026-10-03T06:14:31Z | red

- Status: failed as expected.
- Source/evidence: `pnpm exec vitest run --no-file-parallelism
  cli/package-install.spec.ts` on candidate tree
  `8d143ae8bab7594d25402282a4a2ed33d06919b0` plus the new test file.
- First divergence: the producer created no
  `generated/modules/teams-source/package-receipt.json`; the public install
  consumer script is absent.
- Actual original errors: `ENOENT` for the package receipt and
  `MODULE_NOT_FOUND` for `scripts/package-user-smoke.mjs`.
- Next: implement the single explicit-mode producer, root-derived package
  metadata, staged layout, and the two smoke consumers.

## 2026-10-03T06:39:00Z | implementation

- Status: passed for the independently implementable base package.
- Source/evidence:
  - `scripts/package-artifact.mjs` now has one explicit-mode producer and one
    staged pack root; base mode omits `runtime/dagpipe/**` and writes a receipt
    with `release_eligible=false`. Default final mode fails before staging
    because the D3/U4 receipt interface is not frozen.
  - `scripts/package-user-smoke.mjs` packs the staged root, installs it under
    an isolated prefix and HOME, runs installed `init/status/stop` away from
    the source cwd, and exercises installed Console HTTP assets/auth.
  - `scripts/artifact-smoke.mjs` verifies byte identity against the staged
    root and exercises authenticated/unauthorized Console behavior.
  - `scripts/installed-runtime-smoke.mjs` delegates to the same public
    package consumer so the historical installed-runtime entrypoint now
    actually exercises the tarball boundary.
  - `package.json`, `.appsdk/project.json`, and the five architecture maps now
    point at the single pack root and record the final SDK dependency.
- Inputs: candidate tree
  `8d143ae8bab7594d25402282a4a2ed33d06919b0` plus this U1 implementation;
  root `package.json` version `0.1.0`; Node `v22.22.2`.
- Verification commands:
  - `pnpm install --frozen-lockfile` passed.
  - `pnpm exec vitest run --no-file-parallelism cli/package-install.spec.ts`
    passed: 3 tests.
  - `pnpm exec vitest run --no-file-parallelism cli/agentteams.spec.ts`
    passed: 9 tests.
  - `pnpm build:governance` passed.
  - `node scripts/package-user-smoke.mjs` passed; tarball SHA-256
    `f97763a5e1183426f89ee41c3ff1463a573217fe19ad0d9d333b0aa4e25a5502`
    (receipt `package-user-smoke.receipt.json`).
  - `node scripts/installed-runtime-smoke.mjs` passed; receipt
    `installed-runtime-smoke.receipt.json`.
  - `pnpm typecheck` passed.
- Observed public result: unauthorized Console request `401`; authenticated
  page/entry/UI/icon `200`; cross-site request `401`; installed CLI
  `init/status/stop` exited `0`; temporary install prefix/HOME removed.
- Unverified/blocking downstream: default final mode is intentionally
  explicit failure until the D3/U4 SDK build receipt/runner interface exists;
  U1 final same-package mode, BB01, and BB14 remain open. `appsdk compile`
  currently reports `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.6:required_binary=appsdk-0.1.6`
  before artifact admission, so that gate is not claimed as passed.
- Next: Primary review/integration; no commit, merge, push, review, or
  worktree cleanup from this worker.

## 2026-10-03T07:30:49Z | scope and gate audit

- Status: base phase complete for the independently implementable U1 slice;
  final same-package SDK mode remains blocked on D3/U4.
- Source/evidence: final diff audit shows only the allowed package, map, smoke,
  spec, and U1 evidence paths; `scripts/runtime-smoke.mjs` and
  `scripts/lifecycle-adapter.mjs` remain unmodified.
- Observation: `node scripts/runtime-smoke.mjs` fails with
  `ERR_MODULE_NOT_FOUND` for
  `generated/modules/teams-source/lib/runtime/server/relay.js`; it still
  imports the pre-U1 flat layout. The U1 artifact smoke, tarball install smoke,
  and installed-runtime delegation pass because they consume the staged root.
- Correction: the function and verification maps now mark the combined
  `pnpm smoke` gate partial and explicitly separate the passing base package
  gate from the out-of-scope stale runtime-smoke rebind.
- Next: Primary owns integration/review, the runtime-smoke/lifecycle-adapter
  follow-up decision, and final D3/U4/U2/U5 seam closure.

## 2026-10-03T07:34:18Z | final exact rerun

- Status: passed on the final audited tree.
- Source/evidence: `pnpm exec vitest run --no-file-parallelism
  cli/package-install.spec.ts` passed 3/3; `node scripts/artifact-smoke.mjs`
  passed; `node scripts/installed-runtime-smoke.mjs` passed; `pnpm typecheck`
  passed.
- Artifact identity: staged receipt mode `base`, `release_eligible=false`,
  version `0.1.0`, content SHA-256
  `f6d3f822e88f58c72013f03b3e7d703af26844d6326fcb9209ccd8390ee1b1de`,
  169 files; tarball SHA-256
  `f97763a5e1183426f89ee41c3ff1463a573217fe19ad0d9d333b0aa4e25a5502`.
- Cleanup: both package smoke receipts report their temporary roots removed;
  no temporary package-user root or `.tgz` remains.
- Next: Primary integration/review; final SDK, U2/U5, BB01, and BB14 remain
  explicitly open.

## 2026-10-03T00:43:00Z | correction red

- Status: failed as expected on the preserved candidate.
- Source/evidence: added two public-boundary cases to
  `cli/package-install.spec.ts`; exact output is
  `docs/evidence/746dd7b-u1-package-20261003/red-package-consumer.log.gz` (exact raw bytes after decompression).
- First divergence 1: `node scripts/runtime-smoke.mjs` raises
  `ERR_MODULE_NOT_FOUND` for
  `generated/modules/teams-source/lib/runtime/server/relay.js`; the producer
  stages the runtime at `generated/runtime-lib/`.
- First divergence 2: the base `package-user-smoke.receipt.json` has no
  lifecycle fact, and `installed-runtime-smoke.receipt.json` only repeats the
  base asset/CLI result. Base asset success therefore still has no separate
  installed start/restart evidence.
- Next: implement one installed tarball lifecycle consumer that starts and
  restarts the installed Relay and two Agents with owned dynamic ports, then
  bind its receipt into the lifecycle adapter.

## 2026-10-03T01:31:00Z | installed lifecycle green

- Status: passed on the preserved candidate plus correction edits.
- Source/evidence: `node scripts/runtime-smoke.mjs` passed against
  `generated/modules/teams-source/lib/generated/runtime-lib/**`;
  `node scripts/installed-runtime-smoke.mjs` passed and wrote
  `installed-runtime-smoke.receipt.json`.
- Installed lifecycle: the real npm tarball was installed outside the source
  tree; installed CLI generation 1 started Relay plus two Agents, exposed two
  online endpoint identities, stopped with owned generation, generation 2
  restarted with new launcher/Relay/Agent PIDs and same installed entry paths,
  then stopped. Dynamic ports and generation/PID facts are in the receipt.
- Fail-closed boundary: base `package-user-smoke.receipt.json` records
  `lifecycle.status=not_run`; only the separately named installed lifecycle
  receipt can carry restart evidence. The lifecycle adapter now validates that
  receipt (base-only, passed, two online generations, three installed processes
  each, advanced generation, new PIDs) before emitting install/restart/blackbox
  records.
- Cleanup: installed smoke removed its temporary root. The U1 v2 fixture is
  explicitly not final user-TOML/U2 evidence.
- Next: rerun focused package spec and full listed validation; no review,
  commit, merge, push, or worktree deletion.

## 2026-10-03T01:41:30Z | focused candidate validation

- Status: passed.
- Source/evidence: focused command
  `pnpm exec vitest run --no-file-parallelism --configLoader runner
  cli/package-install.spec.ts` passed 6/6;
  `docs/evidence/746dd7b-u1-package-20261003/green-package-install.log.gz` (exact raw bytes after decompression).
- Exact candidate: HEAD
  `4fc38a491089693f61b5901aa15c1c966a664338` plus the uncommitted U1
  correction; staged tarball SHA-256
  `f97763a5e1183426f89ee41c3ff1463a573217fe19ad0d9d333b0aa4e25a5502`;
  installed content SHA-256
  `f6d3f822e88f58c72013f03b3e7d703af26844d6326fcb9209ccd8390ee1b1de`;
  lifecycle receipt SHA-256
  `f7fa5fc3f7805ce84c88b22b4c006af879bda22bbb03b0ea345cb4d115cd15e3`.
- Lifecycle: dynamic ports relay/provider-lease/receiver-lease were
  `60989/60990/60991`; launcher/Relay/provider/receiver PIDs changed from
  `88308/88322/88330/88385` generation 1 to
  `88747/88752/88771/88809` generation 2; both generations stopped and the
  temporary root was removed.
- Cleanup correction: an earlier failed fixture assertion left one owned
  generation alive; the harness now arms cleanup from the parsed start
  generation before post-start assertions, and the four known owned PIDs were
  explicitly terminated. Repeated focused run left no matching packaged-smoke
  process or temp root.
- Validation also passed: each modified `.mjs` `node --check`, `pnpm build`,
  base producer, `artifact-smoke`, `runtime-smoke`, `package-user-smoke`,
  `installed-runtime-smoke`, `pnpm typecheck`, `git diff --check`, and
  `git diff --cached --check`.
- Next: no review, commit, merge, push, or worktree deletion; stop after final
  report.

## 2026-10-03 / primary staging and raw evidence preservation

- Author exited 0; the latest main c3aa36f adds only two goal documents and was
  combined without changing tested product inputs. Product validation is reused.
- The first staged diff check found trailing whitespace in newly added raw
  tool logs. Earlier unstaged checks did not cover those untracked files.
- Kept exact raw bytes in primary task receipts and committed gzip copies;
  raw-log-archive.json binds original/compressed hashes and byte equivalence.
  This changes evidence representation only, not the test outcome or source.
- Current state: candidate awaiting SDK admission; no architecture review,
  commit, merge, push, final SDK package or user MVP completion is claimed.
