# Issue 7cb9b01 canonical guidance artifact refresh

## Identity and scope

- Issue: `7cb9b01` [U7 P1] Canonical guidance compile dirties committed lifecycle candidate.
- Branch: `codex/u7-guidance-refresh-20261004`
- Worktree: `/Volumes/Intel/playground/agentteams/u7-guidance-refresh-20261004`
- Base/HEAD: `26f12ec3ea92175cc8d9900459450490b4a71745` (clean, tree `3b90a5747066a47574d407ca2940d110ca7d4c62`)
- `origin/main` observed: `26f12ec3ea92175cc8d9900459450490b4a71745` (same as base)
- Canonical binary: `/Users/fanzhang/.cargo/bin/appsdk`
- Canonical binary version/SHA-256: `0.1.0010` / `84a8f6f24f08031d55cb9ae87564cb7930c8af5ea3da183b576de581564e028a`
- Scope: generated governance artifact `.appsdk/guidance/compiled.json` only; no product/runtime code,
  no lifecycle-adapter, SDK source, rules, or quality-gate change.
- Not performed: no commit, merge, push, memory write, reviewer/child agent, Collab/AGY, service
  install/restart, full `pnpm verify`, or root-main edit.

## Actual failure being fixed

The U7 reentry worktree (`u7-reentry-resume-20261004`) ran public
`pnpm lifecycle:admission` and failed at post-gate `assertCleanSource`
(`scripts/lifecycle-adapter.mjs:241`, called from `:417`/`:329`) with
`M .appsdk/guidance/compiled.json`: `pnpm verify -> appsdk guide compile` had rewritten the
tracked artifact during the gate, dirtying the candidate. Raw logs:
`$HOME/.codex/task-evidence/agentteams/receipts/u7-reentry-resume-20261004/attempt-1-injected-failure.log`
(and attempt-2/attempt-3, which also show `?? docs/evidence/u7-reentry-resume-20261004/`).
The genuine cause is a stale committed artifact: `.appsdk/guidance/compiled.json` at base still
carried the pre-refresh skill/contract digests, while the canonical SDK consumer refresh
(`852c3ac`, landed via `26f12ec`) had already updated the declared sources on disk.

## Baseline fingerprints (before mutation)

| Item | Value |
| --- | --- |
| Committed artifact bytes | `docs/evidence/7cb9b01-guidance-refresh-20261004/compiled.json.before` (26567 bytes) |
| Committed artifact SHA-256 | `8c57b9dd2516a8b674b3138863e4cb072031e6a431109ea955ea7fb715117a1e` |
| Old `manifest_hash` | `sha256:33064eebb4b8ffb2f669866770deeba4f5a5a03d46adc6ff5e36754fc1137e64` |
| Old `project_contract_digest` | `sha256:86407ecbbad07f82e32046ac1d89d56fb3a74356b943ba0368e4b85a2bab5393` |
| Old skill source `digest` | `sha256:d96320c2ed0b9159bb882cb1b2e209fbe4af16b693baa1b39fe027c71519851a` |
| Old skill `contract_digest` | `sha256:d1ef60799f60327cf6af6e22db0dab1cc1f849ba2d24eec7e1141ec6096bf317` |
| `AGENTS.md` SHA-256 | `2c362e9c7498b05482f9482a9eef87bdb48d7d94a20f31288737e3e890ab691d` |
| `.appsdk/skills/appsdk-project-governance/SKILL.md` SHA-256 | `937fc302ae0046ef965b37c2b6f17f58b17c98b76789dd4951cef7bb13c32f6f` |
| `.appsdk/skills/appsdk-project-governance/appsdk-guidance.json` SHA-256 | `054f4719f3e3f73dcfed64d2974913cea33745bbc30ecfedccc3160e9b9757f2` |
| `.appsdk/sdk.lock` SHA-256 | `fcf53045b8b6c9097c35a3e1fb038421af66b8213c2f1b5ccf9661d6875ccbac` |
| `.appsdk/project.json` SHA-256 | `ae0401d6bd0f578f0eca8df7942e4f15983722dabe43dd31c57330adf2098a29` |

## Node notes

| Node | Result | Evidence |
| --- | --- | --- |
| Preserve committed bytes | pass; before-bytes copy hash equals committed blob hash | `compiled.json.before` |
| Declared-source fingerprints | captured for AGENTS, skill, contract, lock, project | table above |
| Official `appsdk guide compile` #1 | pass, exit 0; rewrote artifact | `raw/compile-1.stdout.log`, `raw/compile-1.stderr.log`, `raw/compile-1.exit` |
| Diff old -> new | 84 insertions / 6 deletions; digests + migration wording + `communication-recovery` domain | `compiled.diff` |
| Official `appsdk guide compile` #2 | pass, exit 0; byte-identical to pass 1 | `raw/compile-2.*`, `raw/compiled.json.pass2`, `compiled.json.pass1` |
| Digest binding to declarations | pass; compiled digests equal recomputed source hashes | table below |
| Canonical `appsdk verify` | pass, exit 0; `command_ok=true`, `development_ready=true`, `delivery_not_evaluated` | `raw/verify.stdout.log`, `raw/verify.stderr.log`, `raw/verify.exit` |

## Refreshed artifact fingerprints

| Item | Value |
| --- | --- |
| New artifact bytes | 29613 bytes |
| New artifact SHA-256 | `5a2e9fa144f9d58c62bafe89ed9f7e2f2907d09a4c6b0ca63d60926514ff5073` |
| New `manifest_hash` | `sha256:54e06681f1603cbcf136e8395ce47abb32ef67215bfd433c6c5b5b9fb37578b7` |
| New `project_contract_digest` | `sha256:853dd611504a25d97585d78b52bca02703e4c6e90416cf7dc4191832fdacff03` |
| New skill source `digest` | `sha256:937fc302ae0046ef965b37c2b6f17f58b17c98b76789dd4951cef7bb13c32f6f` |
| New skill `contract_digest` | `sha256:054f4719f3e3f73dcfed64d2974913cea33745bbc30ecfedccc3160e9b9757f2` |

Binding check: the compiled `sources[].digest`/`contract_digest` now equal the SHA-256 of the
current on-disk `AGENTS.md`, `SKILL.md`, and `appsdk-guidance.json` respectively, so the refreshed
output is bound to the actual declared sources (the old digests matched none of them).

## Idempotence

- Pass 1 artifact SHA-256: `5a2e9fa144f9d58c62bafe89ed9f7e2f2907d09a4c6b0ca63d60926514ff5073`
- Pass 2 artifact SHA-256: `5a2e9fa144f9d58c62bafe89ed9f7e2f2907d09a4c6b0ca63d60926514ff5073`
- `cmp pass1 pass2` -> equal; second compile under unchanged declarations is byte-identical.
- `raw/compile-1.stdout.log`, `raw/compile-2.stdout.log`, and the artifact are all byte-identical
  (`appsdk guide compile` writes the JSON to stdout and to the artifact).
- No trailing whitespace; file ends with a single `\n`.

## Canonical verify

```json
{"baseline_status":"current","command_ok":true,"delivery_assessed":false,"delivery_verified":false,"development_ready":true,"ok":false,"project_id":"agentteams","reason":"delivery_not_evaluated","stage":"contract_bound","test_governance":{"mode":"off","objects":[],"status":"not_selected"}}
```

- `command_ok=true` and `development_ready=true`; `ok=false` is solely
  `reason=delivery_not_evaluated`, which is explicit and expected for this advisory artifact refresh.

## Verification applicability (precise)

- This is a generated governance/advisory artifact refresh with no product, runtime, dependency,
  lockfile, or build-input change, so the applicable verification is: official generator twice,
  byte-identity, declared-source digest binding, and canonical `appsdk verify`.
- `pnpm verify`, service install/restart, OTA, and live replay are intentionally NOT run: no product
  or runtime input changed, and the task forbids installing/running services or a full `pnpm verify`
  just to refresh advisory documentation. Black-box runtime regression is not applicable to a
  generated advisory JSON with no executable behavior.
- Focused checks performed: `git diff` scope inspection, `cmp`, SHA-256 recomputation, JSON parse.

## Remaining public lifecycle obligation (deferred)

- The real `pnpm lifecycle:admission` requires a committed clean HEAD; it cannot pass in this
  uncommitted worktree and must NOT be forced by an early commit before independent review.
- Parent owns review, commit, main integration, push, and then the actual clean committed admission
  (`scripts/lifecycle-adapter.mjs` post-gate `assertCleanSource` at `:241`/`:417`), which is the
  node that proves `appsdk guide compile` no longer dirties the candidate.
- This evidence does not claim issue closure; it proves the stale artifact is refreshed and bound
  to current declarations, and that a second compile is idempotent.

## Changed paths (staged explicitly by parent)

- `.appsdk/guidance/compiled.json` (official generator output)
- `docs/evidence/7cb9b01-guidance-refresh-20261004/**` (this evidence)

No other path was written. The worktree is left staged for independent review; no commit was made.

## Final candidate identity

- Base commit: `26f12ec3ea92175cc8d9900459450490b4a71745`
- Base tree: `3b90a5747066a47574d407ca2940d110ca7d4c62`
- Candidate index tree: computed by `git write-tree` after this note is staged; it cannot be
  recorded here without self-reference. The parent records the final tree hash after staging.
- Staged artifact SHA-256 equals worktree artifact SHA-256
  (`5a2e9fa144f9d58c62bafe89ed9f7e2f2907d09a4c6b0ca63d60926514ff5073`); staged set contains
  only the allowed generated artifact and this evidence directory.
- Complete iff status: original stale output and genuine mutation cause preserved (before-bytes +
  diff + failure logs); official refreshed output bound to current declarations; second compile
  byte-identical; only allowed paths changed; focused JSON/diff/canonical verify passed; remaining
  public lifecycle obligation recorded. Scope is a generated governance artifact, not runtime.
