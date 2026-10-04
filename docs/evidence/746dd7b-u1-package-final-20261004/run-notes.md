# U1 Final Package Author Verification Run Notes

## 2026-10-04T07:22:06Z | baseline

- Status: running.
- Scope: current tree `/Volumes/Intel/playground/agentteams/u1-package-final-20261004`,
  branch `codex/u1-package-final-20261004`, base `origin/main`
  `4155c01b8c2107891a6a97579d96601d9cae0bf9`.
- Inputs: frozen U1 source staged from `candidate-receipt-r3.json`; canonical SDK
  `/Users/fanzhang/.cargo/bin/appsdk`, reported `appsdk 0.1.0010 (rust)`,
  SHA-256 `84a8f6f24f08031d55cb9ae87564cb7930c8af5ea3da183b576de581564e028a`.
- Existing evidence: prior focused/build/typecheck/installed lifecycle results
  are only reusable when the current product and lock/build fingerprints match.
- Next: record scoped product and lock/build input hashes, then run the official
  `appsdk pin-lock`, `appsdk verify`, and real `appsdk compile`.

## 2026-10-04T07:22:30Z | fingerprints

- Status: passed.
- Source/evidence: `source-fingerprints.txt`.
- Inputs: staged index tree `17d15e083a56d7f56ac3a8a88c375aedd2e989f8`,
  staged diff SHA-256
  `88d15602cba44d49fbc177b575e5f8624abaceeab8441e8894cc41d0de7ce0bc`,
  working-tree diff SHA-256
  `2947ea0d131d60a76aa1fa44d113f44c2468dfc5dd6f6a41e9acae056c92f474`.
- Product hashes match the frozen U1 scripts and package metadata; the five
  architecture maps differ from the older author receipt because they are
  applied on the newer `4155c01b8c2107891a6a97579d96601d9cae0bf9` base.
- Next: official SDK pin-lock.

## 2026-10-04T07:22:47Z | sdk-pin-lock

- Status: passed.
- Source/evidence: `appsdk pin-lock . --binary
  /Users/fanzhang/.cargo/bin/appsdk`, exit 0, output
  `pinned /Users/fanzhang/.cargo/bin/appsdk`.
- Provenance: canonical SDK SHA-256
  `84a8f6f24f08031d55cb9ae87564cb7930c8af5ea3da183b576de581564e028a`;
  SDK bundle moved from `0.1.6`
  `sha256:e9a816589ce03740b30bf847be4fbb6c4203c70d39b11ada2b723dc966d0a091`
  to `0.1.0010`
  `sha256:a51c01a3a2bbe4158d358db672b7e9683bfb8c714c97fed0600a413fe03b2aa1`.
- Generated dependency: 77 `.appsdk/**` and `contracts/**` paths are classified
  separately in `sdk-generated-paths.txt`; `.appsdk/project.json` contains the
  staged U1 artifact paths plus an unstaged SDK version update. None of this
  generated dependency is staged or committed by this worker.
- Next: frozen-lockfile install and SDK verify.

## 2026-10-04T07:23:07Z | install-and-verify

- Status: passed.
- Source/evidence: `pnpm install --frozen-lockfile` exit 0
  (`pnpm-install.log.gz`); `/Users/fanzhang/.cargo/bin/appsdk verify .` exit 0
  (`appsdk-verify.log.gz`).
- Result: `baseline_status=current`, `command_ok=true`,
  `development_ready=true`, `delivery_assessed=false`, `ok=false`,
  `reason=delivery_not_evaluated`. This is development verification only; it
  does not claim delivery admission.
- Next: build, typecheck, and real SDK compile.

## 2026-10-04T07:23:38Z | build-typecheck-compile

- Status: passed.
- Source/evidence: `pnpm build` exit 0 (`pnpm-build.log.gz`);
  `pnpm typecheck` exit 0 (`pnpm-typecheck.log.gz`);
  `/Users/fanzhang/.cargo/bin/appsdk compile .` exit 0
  (`appsdk-compile.log.gz`).
- Compiled artifact: `artifact_hash=sha256:2f12a64e36cdadf54839674040e0c7a34f30d1a774f46f85442704395273b07d`,
  `source_hash=sha256:cdadde82606bfff4f27a2a4e39fa866447b1ec7a0aab32ecc3cd9ebd71d976a3`,
  `public_api_hash=sha256:c7bd9d8c834d4df34022d7af3a90be1da6bfce50e667082cfd67375b834a1ff5`,
  `contract_hash=sha256:8198c076b46ff05606c7c47fcadcce972550fd9dcfd2ecfe554d2bff2378b9b1`.
- Base package receipt: `mode=base`, `release_eligible=false`, version `0.1.0`,
  content SHA-256
  `f6d3f822e88f58c72013f03b3e7d703af26844d6326fcb9209ccd8390ee1b1de`,
  169 files, SDK omitted by explicit base mode.
- Next: consume the exact staged package through public smoke and installed
  lifecycle entrypoints.

## 2026-10-04T07:24:20Z | public-smokes

- Status: passed.
- Source/evidence: `artifact-smoke.log.gz`, `runtime-smoke.log.gz`,
  `package-user-smoke.log.gz`, `installed-runtime-smoke.log.gz`.
- `artifact-smoke` passed on the single staged pack root; `runtime-smoke`
  passed real TLS Relay/daemon library admission, directory, stop, and fresh
  generation.
- Base install receipt:
  `docs/evidence/746dd7b-u1-package-final-20261004/package-user-smoke.receipt.json`,
  SHA-256
  `c8cfbb6fe3c83ece25f56e1bd2af5b01147fae481742a8ddbd30fbc27515be78`;
  `release_eligible=false`, `lifecycle.status=not_run`.
- Installed receipt:
  `docs/evidence/746dd7b-u1-package-final-20261004/installed-runtime-smoke.receipt.json`,
  SHA-256
  `897cdf5d06acdcc2d9094cfc6f425cf6f5680ac42e388b895197164b7737963b`;
  `release_eligible=false`, `lifecycle.status=passed`, generation 1 -> 2,
  launcher PIDs `23475` -> `24396`, three owned process PIDs per generation,
  installed entry paths, final stop, and temporary-root removal.
- The installed wrapper hardcodes the frozen receipt directory. To preserve
  that frozen evidence, the same exported `runPackageUserSmoke` implementation
  was invoked with the existing `evidenceDir` and `includeInstalledLifecycle`
  options and wrote to the final-run directory.
- Next: focused public package spec.

## 2026-10-04T07:27:20Z | focused-package-spec

- Status: passed.
- Source/evidence: `pnpm exec vitest run --no-file-parallelism
  --configLoader runner cli/package-install.spec.ts`, exit 0, 1 file and 6
  tests passed (`package-install-spec.log.gz`).
- Guard: the spec internally invokes the frozen smoke wrappers. The two frozen
  receipts were backed up and restored byte-for-byte; final hashes remain
  `d40bc84370b039e05ba7dc6b2510817a3e4d324a40533e9f178acec718c86041`
  and
  `f7fa5fc3f7805ce84c88b22b4c006af879bda22bbb03b0ea345cb4d115cd15e3`.
- Next: final verify/cleanup audit.

## 2026-10-04T07:28:20Z | final-audit

- Status: passed author verification; retained obligations remain.
- Source/evidence: post-compile `appsdk verify` exit 0
  (`appsdk-verify-post-compile.log.gz`) with the same
  `command_ok=true`/`development_ready=true` and
  `delivery_not_evaluated` result; `raw-log-archive.json` binds raw and gzip
  hashes.
- Cleanup: no owned package-smoke temp root, listener, or Relay/Agent process
  remains. The two frozen receipts are unchanged. The final evidence directory
  contains only this run's receipts, logs, provenance, path classification, and
  notes.
- Retained obligations: parent owns latest-main composition, final U1 review,
  integration, and delivery; the official SDK pin-lock dependency remains
  separate from U1 and must be combined by the primary from merged main; base
  mode remains `release_eligible=false`; final SDK runner/graph packaging,
  final user-TOML/U2, Console browser evidence, and BB01-BB14 are not claimed.

## 2026-10-04T07:32:24Z | external-main-boundary

- Status: observed, not incorporated.
- Source/evidence: while this worker ran, `origin/main` advanced from the
  assigned base to `26f12ec3ea92175cc8d9900459450490b4a71745`
  (`fix(governance): refresh canonical SDK consumer inputs (852c3ac)`).
- Comparison: the merged SDK bundle digest is the same
  `sha256:a51c01a3a2bbe4158d358db672b7e9683bfb8c714c97fed0600a413fe03b2aa1`.
  The only observed local pin-lock generated-file difference is the
  `created_at` timestamp in
  `.appsdk/migrations/0.1.0009-to-0.1.0010/record.json`.
- Next: parent owns latest-main composition and integration; this worker did
  not fetch, merge, or rebase onto the advanced main.
