# Issue 852c3ac SDK input restoration

## Identity and scope

- Issue: `852c3ac877063c15379f9ced8a5136d43ca538c24e0829bdf8304873a916d3e2`
- Branch: `codex/852c3ac-sdk-consumer-refresh-20261004`
- Worktree: `/Volumes/Intel/playground/agentteams/852c3ac-sdk-consumer-refresh-20261004`
- Base: `07006d69f574fe23dbf2df517d51e15429dd82a1`
- Teams remote main observed by `git ls-remote`: `4155c01b8c2107891a6a97579d96601d9cae0bf9`
- Canonical binary: `/Users/fanzhang/.cargo/bin/appsdk`
- Canonical binary SHA-256: `84a8f6f24f08031d55cb9ae87564cb7930c8af5ea3da183b576de581564e028a`
- Canonical binary receipt: `/Users/fanzhang/.codex/task-evidence/agentteams/receipts/1a21b0c-transition-final-20261004/canonical-install-receipt.json`
- No Collab, AGY, child agent, model probe, commit, merge, push, memory write, or daemon restart was performed.

## Node notes

| Node | Result | Evidence |
| --- | --- | --- |
| Baseline protected snapshot | captured before mutation | `protected-baseline.sha256`, `tracked-baseline.sha256`, `pre-status.txt`, `baseline-head.txt`, `baseline-tree.txt` |
| Canonical pre-pin verify | red as expected, exit 1, `NON_CANONICAL_RECORD_CONTRACT_SET` | `raw/pre-verify.stdout`, `raw/pre-verify.stderr`, `raw/pre-verify.exit` |
| Official pin-lock | pass, exit 0 | `raw/pin-lock.stdout`, `raw/pin-lock.stderr`, `raw/pin-lock.exit` |
| Canonical verify | pass, exit 0; `command_ok=true`, `development_ready=true`, `delivery_verified=false` | `raw/verify.stdout`, `raw/verify.stderr`, `raw/verify.exit` |
| Pin-lock and verify reentry | pass, exit 0 for both; control and status fingerprints are byte-identical | `raw/pin-lock-reentry.*`, `raw/verify-reentry.*`, `first-pin-control.sha256`, `reentry-control.sha256`, `raw/reentry-control.cmp.exit` |
| Frozen install | pass, exit 0; lock bytes unchanged | `raw/pnpm-install.*`, `pnpm-lock.before.sha256`, `pnpm-lock.after.sha256` |
| Official compile | pass, exit 0; `teams-source` artifact `sha256:39f07388f31e695401e631ea9244a10c4d16b1a4cd230af6a13cf34ea01654b0` | `raw/compile.stdout`, `raw/compile.stderr`, `raw/compile.exit` |
| Protected path preservation | pass for all 776 non-authorized protected paths after compile | `protected-preserved-baseline.sha256`, `raw/protected-post-compile-check.stdout`, `raw/protected-post-compile-check.exit` |
| Generated control stability | pass; post-compile `.appsdk` plus root-contract fingerprint equals reentry | `reentry-control.sha256`, `post-compile-control.sha256`, `raw/post-compile-control.cmp.exit` |

## SDK provenance

- SDK lock version: `0.1.0010`
- SDK lock compiler digest: `sha256:84a8f6f24f08031d55cb9ae87564cb7930c8af5ea3da183b576de581564e028a`
- SDK lock binary digest: `sha256:84a8f6f24f08031d55cb9ae87564cb7930c8af5ea3da183b576de581564e028a`
- Installed project binary witness `.appsdk/sdk.bin`: `84a8f6f24f08031d55cb9ae87564cb7930c8af5ea3da183b576de581564e028a`
- SDK bundle digest: `sha256:a51c01a3a2bbe4158d358db672b7e9683bfb8c714c97fed0600a413fe03b2aa1`
- Previous bundle digest: `sha256:e9a816589ce03740b30bf847be4fbb6c4203c70d39b11ada2b723dc966d0a091`
- New migration: `appsdk-0.1.0009-to-0.1.0010`, source `0.1.0009`, target `0.1.0010`
- Historical `0.1.5-to-0.1.6` migration was retained and preserved.
- Declared root transition canonical SHA-256: `ae910c4426c8bccc22c9e2256e8ca9842eb39c2caa783428afec5c9a2d44c5d5`
- Both declared transition paths match that canonical digest:
  - `contracts/transitions/zone-transition.manifest.json`
  - `contracts/transitions/zone-transition-manifest.json`
- Root record contracts changed only where `pin-lock` regenerated declared SDK bundle resources; each changed root file is byte-identical to its `.appsdk/contracts` installed copy.

## Boundaries and residual work

- This proves SDK pin, canonical verify, idempotent reentry, and actual source compile only.
- It does not prove Teams product delivery, U7 completion, deployment admission, install/restart, or live replay.
- Compile declared `deployment_operations: ["install", "restart"]`; neither operation was executed because this task explicitly forbids daemon restart.
- `node_modules/` and `generated/` were created by this run, but the cleanup command was rejected by the tool guard. They remain ignored and unstaged in the candidate worktree and must be removed by the review/integration owner.
- The candidate is intentionally left staged for independent review.
