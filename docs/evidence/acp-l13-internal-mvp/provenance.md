# Release provenance

This file explains how the internal MVP artifact is bound to the code that
produced it. Read it before you treat any later commit as the release.

## Binding

- Code candidate: `22f66fe35ebe41c330e24b165cfb11b28019a1a`, tree
  `2c680b2a2b52c4e670041a61a78bcc9693427640`.
- Staged package content: `f7a1c9b6c2cf5787d75469a0a4b7ff3c5bf8b2cb26964cbb7e347adf508963b6`.
- Release tarball: `release/agentteams-0.2.0-internal.1.tgz`, sha256
  `3aeebbdb929beac2a817ab046b2cba80f6da1d1774a0043bcf71d0ae6d5f50e4`.
- Release receipt: `release-receipt.json`.
- Staged package receipt snapshot: `package-receipt.snapshot.json`.

`release-receipt.json` records the exact staged package receipt that produced
the artifact. The live receipt under `generated/modules/teams-source/` is rebuilt
by every governance run, so the snapshot is the stable reference.

## Evidence layers

- Installed lifecycle: `installed-lifecycle.receipt.json` proves the release
  tarball installs, starts (generation 1) and restarts (generation 2) with the
  fixture config it names (`lifecycle_scope`). Its tarball sha256 equals the
  release tarball sha256.
- Black box: `bb-all/receipt.json` passes BB01-BB14 except BB07, which failed
  that run and passed in `bb-all/retry-bb07/receipt.json` on the same candidate
  and content. `release-receipt.json` records BB07 as flaky.
- D08 behavioral acceptance: `d08/acceptance.log` (exit 0, 44 checks, 4 gaps,
  1 finding) ran the rcc provider at `http://127.0.0.1:4444/v1` with model
  `gpt-5.5`. It builds its own package during the run (content `8eddac59...`),
  so it is behavioral acceptance at the installed layer, not release-artifact
  acceptance.

## Commits after the artifact

Commits after `22f66fe` are evidence-only. They add receipts, logs and this
provenance file. They do not change `cli/`, `runtime/`, `config/` or any packed
path, so they do not change the release tarball bytes.

## Known limit

The compiled runner embeds a per-build directory name, so rebuilding the package
changes the package content hash. The release artifact is bound by its tarball
sha256, not by a rebuilt content hash.
