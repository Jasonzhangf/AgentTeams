# Changelog

All notable changes to the AgentTeams internal MVP artifact are recorded here.
This file describes the installable package, not the design history.

## 0.2.0-internal.1 — 2026-10-21

First internal MVP candidate that ships the complete final package: ACP daemon,
engine adapters, registry daemon, control daemon with the Console WebUI, and the
five Work graphs with their runner and identity manifest.

### Added

- `--serve opencode` and `--serve dsh` runtime entries, with one
  `engineAdapterFor` dispatch that selects the engine adapter.
- Registry daemon and automatic registration, plus the Console discovery
  directory projection over the real registration readback.
- Control daemon with the Console WebUI, HTTP Basic challenge, real projection
  and connection history reads, and an SSE stream of `{ seq, projection }`.
- Provider configuration from the frozen v4 config, including OpenCode adapter
  output derived from the accepted revision.
- Session observation projection: the control daemon reads observed Session and
  permission rows from declared peers.
- Internal release gate `scripts/release-receipt.mjs`. It cuts the release
  tarball from the staged root and grants release eligibility only when the
  installed lifecycle and the same-package black-box acceptance both passed.

### Changed

- A staged package receipt is always `release_eligible: false`. Eligibility now
  belongs to the release receipt, which binds candidate, package content,
  tarball sha256 and the retained obligations. Smoke and lifecycle receipts no
  longer propagate a mode-derived flag.
- The runner build uses a fixed build directory, so the compiled runner and the
  package content hash are reproducible across builds. A random build directory
  leaked into the cargo debug paths and changed the content hash every build.
- The full regression runs Vitest with `--no-file-parallelism`. The real Chrome
  and package-install fixtures contend for host resources when many files run at
  once, which produced rotating false failures in the BB13 acceptance case.
- Three real-DOM specs launch Chrome with a private profile per run. Concurrent
  `--headless=new --dump-dom` launches without `--user-data-dir` collided on one
  default profile lock.

### Fixed

- BB09 assertions read the live Console rows and the Agent drawer instead of
  stale DOM selectors, and the drawer is re-opened after a refresh.
- BB10 reads the first declared auth entry with the declared entry count and
  does not rotate or fall back between entries.
- `pnpm verify` runs the AppSDK CLI through `scripts/appsdk.mjs`, which prefers
  the project-pinned `.appsdk/sdk.bin`. A different AppSDK build on `PATH`
  rewrote `.appsdk/guidance/compiled.json`, and the receipt identity guard then
  correctly rejected that drift; this was the root cause of the BB13 failure.
- D08 A07 records the Session projection and targeted-interaction boundaries as
  gaps with the current behavior, and no longer counts an older cross-device
  receipt as a pass for this package.

### Known limits

- The `sessionEvents` projection is incomplete. The Console streams directory
  changes, not a full Session, permission and notification event projection.
- No cross-device receipt exists for this package content. The retained
  two-host receipt belongs to package `0.1.0` at base commit `8cb0238`.
- The AppSDK rule audit for this candidate is retained, not delivered.
- A graceful stop and start of the control owner reuses generation 1 (D08
  finding A09), so a stale `--generation` can collide after a graceful stop.
- The release tarball is an internal artifact. It is not published to any
  registry and is not deployed.
