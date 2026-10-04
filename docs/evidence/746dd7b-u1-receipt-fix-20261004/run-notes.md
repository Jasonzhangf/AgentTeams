# U1 Exact Installed Receipt Corrections Run Notes

## 2026-10-04T07:55Z | baseline

- Status: running.
- Scope: `/Volumes/Intel/playground/agentteams/u1-receipt-fix-20261004`, branch
  `codex/u1-receipt-fix-20261004`, base `origin/main`
  `2f6caaa90db9f2592dcfc54c51984080650da0a4`. Frozen U1 product/evidence patch staged.
- Inputs: canonical SDK `/Users/fanzhang/.cargo/bin/appsdk`, `appsdk 0.1.0010 (rust)`,
  SHA-256 `84a8f6f24f08031d55cb9ae87564cb7930c8af5ea3da183b576de581564e028a`.
- Ownership: only U1 exact installed-receipt owner chain
  (`scripts/installed-runtime-smoke.mjs`, `scripts/package-user-smoke.mjs`,
  `scripts/lifecycle-adapter.mjs`, `scripts/package-artifact.mjs`, `cli/package-install.spec.ts`,
  U1 map rows, new `docs/evidence/746dd7b-u1-receipt-fix-20261004/**`). U2/U4/U7 untouched.
- Next: reproduce the three P1 findings as red before editing.

## 2026-10-04T07:58Z | red-frozen-mutation

- Status: reproduced.
- Source/evidence: `red-frozen-mutation.log`.
- Ran the normal exported wrappers pre-fix. `node scripts/package-user-smoke.mjs` changed the
  tracked frozen `docs/evidence/746dd7b-u1-package-20261003/package-user-smoke.receipt.json`
  (`d40bc843...` -> `b3f734a5...`), and `node scripts/installed-runtime-smoke.mjs` changed the
  frozen `installed-runtime-smoke.receipt.json` (`f7fa5fc3...` -> `1cc294bf...`). Both showed
  `git status` `AM`.
- Restored both from the index; frozen hashes back to the originals.
- Next: reproduce finding 3 non-rejection.

## 2026-10-04T08:02Z | red-prefix-consumer

- Status: reproduced.
- Source/evidence: `red-prefix-replay.log`.
- The staged pre-fix `installedLifecycleReceipt` accepted the frozen foreign receipt
  (`sha256:f7fa5fc3...`) even though it carries no `pack` binding for this candidate.
- Next: minimal fixes at the unique producer/consumer owners.

## 2026-10-04T08:20Z | fixes

- Status: implemented.
- Producer: `scripts/package-user-smoke.mjs` records `pack.content_sha256`, `tarball.content_sha256`,
  and `install.installed_content_sha256` with one shared hash algorithm, asserts they agree with the
  staged pack root, defaults its receipt to a run-scoped ignored path
  (`generated/u1-receipts/<run>/`), and accepts an explicit `--receipt-path`.
  `scripts/installed-runtime-smoke.mjs` writes to `AGENTTEAMS_U1_INSTALLED_RECEIPT_PATH` (or a
  run-scoped ignored default) and emits the exact `u1-installed-receipt <path> sha256:<hash>` line.
- Consumer: `scripts/lifecycle-adapter.mjs` exports `installedLifecycleReceipt`, binds the
  deterministic per-candidate receipt path into the smoke stage fingerprint/required paths, records
  the receipt hash as a verified output, and rejects any receipt whose pack/tarball/installed-content
  hash is missing or does not match this candidate's `package-receipt.json` content hash. The receipt
  hash is never placed in the fingerprint before first generation, so reuse is not permanently
  invalidated.
- Maps: U1 rows only (`docs/architecture/function-map.json`,
  `docs/architecture/resource-map.json`, `docs/architecture/verification-map.json`).
- Next: rerun the focused gate and the full affected verification stack on the frozen tree.

## 2026-10-04T08:27Z | verification

- Status: passed.
- Source/evidence: `package-install-spec.log.gz` (12 tests, exit 0), `pnpm-build.log.gz`,
  `pnpm-typecheck.log.gz`, `appsdk-compile.log`, `appsdk-verify.log`, `artifact-smoke.log`,
  `runtime-smoke.log`, `installed-runtime-smoke.log`, `package-user-smoke.log`.
- Package binding: pack == tarball content == installed content ==
  `f6d3f822e88f58c72013f03b3e7d703af26844d6326fcb9209ccd8390ee1b1de`, matching this candidate's
  `package-receipt.json` content hash. Tarball SHA-256 `f97763a5...`. Installed generations 1 -> 2.
- Negative paths: correct receipt succeeds; wrong candidate pack, wrong installed content, wrong
  tarball, and missing receipt each fail explicitly.
- Frozen immutability: `frozen-receipt-hashes.txt` shows the 20261003 receipts byte-unchanged
  (`d40bc843...`, `f7fa5fc3...`) after public smoke runs.
- Next: stage only the allowed paths; the parent commits, then runs `pnpm lifecycle:admission`.

## 2026-10-04T08:30Z | closeout

- Status: complete (author scope).
- `provenance.json` and `source-fingerprints.txt` bind this exact uncommitted candidate tree.
- Not claimed: `pnpm lifecycle:admission` (requires a committed clean HEAD; parent runs it after
  review PASS and commit), final SDK runner, U2/U3/U4, BB01-BB14. Frozen historical receipts and
  the external primary composition receipt are preserved, not overwritten.

## Primary consumption | 2026-10-04T08:36Z

- Author terminal stream and actual exit markers consumed. Three raw logs failed
  `git diff --cached --check` on original whitespace. They are preserved as
  deterministic lossless gzip; `cmp` against decompressed bytes passed for each.
  No test result was changed and product inputs remain unchanged.
- `u1-staged-paths.txt` is an author intermediate scope observation, preceding
  final staging and compression. Exact reviewed paths/tree are held in the
  independent review receipt; that historical snapshot is not rewritten.
- Main remains at `2f6caaa90db9f2592dcfc54c51984080650da0a4`; fresh fetch
  confirmed no new remote commits. Architecture review is the next node.
