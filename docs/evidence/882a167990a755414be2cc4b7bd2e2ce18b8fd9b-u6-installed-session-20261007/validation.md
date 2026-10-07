# U6 Installed Session Contract Validation (r18)

Task: `docs/design/teams-session-delivery.md` delivered path
Date: 2026-10-07 (America/Los_Angeles)
Status: `SUPERSEDED / HISTORICAL`

> **Superseded.** This directory documents the tree `882a167990a755414be2cc4b7bd2e2ce18b8fd9b`
> only. The branch has since moved to tree `fcb52bdb1b22a9060016805d842a17a9e100981b`
> (commit `0edb591edd1f942464880b80346c2d9354dc0bb0`), which changes a product path
> (`opencode-adapter/src/index.ts`), so every claim below holds **at the publishing commit
> `3b578bba` and nowhere later**. The current receipt is
> `docs/evidence/fcb52bdb1b22a9060016805d842a17a9e100981b-u6-installed-session-20261007/`.

## Which commit this directory is about

This directory is named after the **tree hash**, because the receipt binds the tree,
not the commit that publishes the receipt.

| Fact | Value |
|---|---|
| Product tree the receipt binds, installs and replays | `882a167990a755414be2cc4b7bd2e2ce18b8fd9b` |
| Commit whose tree that is | `a598a377d3370bcd55f87ef61a2ddfbd7d94da16` |
| Delivery branch base | `e3ad473a4df609decef807401df756088c911b75` |
| This evidence directory | added by a `docs/`-only commit whose parent is that commit |

A receipt cannot live inside the commit it binds: it is written after the commit, and
adding it changes the tree hash. The receipt is produced under `generated/`, which
`.gitignore:5` excludes, so this directory holds its tracked copy. The publishing commit
changes no product path. Verify that one fact at the publishing commit `3b578bba`:

```text
$ git diff --name-only 882a167990a755414be2cc4b7bd2e2ce18b8fd9b 3b578bba | grep -v '^docs/'
```

Nothing is printed when the claim holds. At any later commit the branch has moved on and this
receipt no longer covers it; use the receipt named in the superseded banner above. Code
admission rests on the tree the receipt names. The receipt is never evidence for the commit
that carries it.

## What changed in this candidate

This candidate answers the r17 independent review
(`u6-session-implementation-20261006-r17-main`, verdict `fail` / `code_failure`, 1 P1).

| Finding | Severity | Change |
|---|---|---|
| `opencode-adapter/src/index.ts:722` coerced an absent or empty substrate tool title to `''` for both `running` and `completed`, but the closed Console parser requires a non-empty title whenever one is present (`optionalText`) and always for `completed` (`text`). One rejected event fails the whole projection reply instead of degrading a single event | P1 | `classifyPart` now rejects a `running` title that is present but empty or non-string, rejects a `completed` state without a non-empty string `title` or a string `output`, and keeps an absent `running` title absent instead of materialising `''` |

The fix carries the per-state round-trip test the review asked for:
`opencode-adapter/tests/index.spec.ts` — `projects every tool state into a shape the closed Console
wire parser accepts` feeds `projectOpenCodeSessionEvent` output for `pending`, `running`,
`completed` and `error` through `parseConsoleSessionEvent` with the owning `agentId` bound (the
adapter leaves it empty; `runtime/agent-process.ts:309,442` binds it), asserts that an absent
`running` title stays absent, and asserts that each non-conforming title shape is rejected as
`{ kind: 'invalid' }` at the adapter boundary. Two pre-existing fixtures that built a `completed`
tool state without a title were corrected, because the installed SDK types `title` and `output` as
required on `ToolStateCompleted`.

This candidate also still carries the r16 fixes: the multi-match assistant binding stays
ambiguous (a second distinct assistant identity for one `requestMessageId` refuses a cancel with
typed `ambiguous-owner` before any abort), and the adapter exposes the substrate's real
`session.status` passthrough as typed auxiliary observation. `docs/architecture/verification-map.json`
lists all three rules under `teams-managed-session-contract`.

## Commands, exit codes and evidence

All commands ran in `/Volumes/Intel/playground/agentteams/u6-session-implementation-20261006`
on the clean committed candidate `a598a377d3370bcd55f87ef61a2ddfbd7d94da16` (tree
`882a167990a755414be2cc4b7bd2e2ce18b8fd9b`, `git status --porcelain` empty).

| Command | Result | Log |
|---|---|---|
| `pnpm build:governance` | exit 0, artifact `ceac6348c611c3b90743975aec7a203b1193dceb4e029f809b78195f1e6e48ba` | `build.log` |
| `pnpm typecheck` | exit 0 | `typecheck.log` |
| mapped gate for `teams-managed-session-contract` (9 spec files) | exit 0, 9 files / 127 tests | `gates.log` |
| `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --config vitest.config.ts --maxWorkers=2 --testTimeout=90000` | exit 0, 81 files / 673 tests | `full-regression.log` |
| `pnpm dagpipe graph validate docs/design/dagpipe/graphs/session-request.graph.json` | exit 0, `valid DAG: agentteams.session-request@1 (7 nodes, 7 edges, 6 waves)` | `gates.log` |
| `node scripts/u6-installed-session-replay.mjs --pack-root generated/modules/teams-source/lib --evidence-dir … --receipt-path …` | exit 0, 16/16 cases | `replay-cli.log`, `u6-installed-session-replay.receipt.json` |

### Installed replay receipt

`u6-installed-session-replay.receipt.json` is the primary public-entry evidence. It binds:

| Field | Value |
|---|---|
| `candidate.head_commit` | `a598a377d3370bcd55f87ef61a2ddfbd7d94da16` |
| `candidate.tree_hash` | `882a167990a755414be2cc4b7bd2e2ce18b8fd9b` |
| `candidate.base_commit` | `e3ad473a4df609decef807401df756088c911b75` |
| `candidate.source_state` | `committed` |
| `package.content_sha256` | `75f61f0c17b5f3fb840c1dbdefbe5af1afe31ab46c048eb8877872ce0961d419` |
| `install.installed_content_sha256` | `75f61f0c17b5f3fb840c1dbdefbe5af1afe31ab46c048eb8877872ce0961d419` (equals the pack) |
| `cleanup.leaked_pids` | `[]` |
| `cleanup.temporary_root_removed` | `true` |

Cases, in order: `initialization, lifecycle, console, discovery, config.apply, session.create,
session.open, session.send, permission, session.cancel, passive-refusal, binding-without-owner,
unsupported-payload, console-offline, stale-generation, clean-stop`.

`session.cancel` recorded `variant: "confirmed"`. This is the evidence that the multi-match
tightening did not turn the real single-identity cancel path into an unconfirmable one: the
installed substrate still produced one owned assistant identity for the held prompt, the
abort was accepted, and the final `MessageAbortedError` reconciled it to `finalState: cancelled`.
The replay's `permission` case drives a real `bash` tool call whose `completed` state is the
shape this candidate now validates, so the tightened adapter is exercised on the installed path.

## Boundaries of this evidence

- **AppSDK admission is not claimed.** `pnpm appsdk verify` / `appsdk compile` cannot run on this
  machine: `/Users/fanzhang/.cargo/bin/appsdk` reports `appsdk 0.1.0011 (rust)` while
  `.appsdk/project.json` declares `sdk.version = "0.1.0010"`, so the CLI fails with
  `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0010:required_binary=appsdk-0.1.0010` (exit 1). The same
  failure reproduces on the untouched base commit, so it is toolchain drift, not a regression of
  this candidate. See `appsdk-pin-mismatch-on-base.log`. No prebuilt `appsdk` 0.1.0010 binary
  exists on this machine, and restoring one or promoting the pin are both outside this change.
- **Pack content hash is not byte-reproducible.** `pnpm build:governance` recompiles the
  `runtime/dagpipe` runner, so two builds of one commit can produce different pack hashes. The
  receipt therefore binds the pack it actually installed
  (`75f61f0c…` == `install.installed_content_sha256`), and candidate equivalence is judged by
  `git diff --name-only <tree> HEAD | grep -v '^docs/'` printing nothing.
- **Cross-check on the real substrate.** The U7 installed Session case BB12, run at a tip that
  contains this candidate's multi-match tightening, also recorded a confirmed cancel
  (`baseAccepted true`, `reconciliation: confirmed`, `finalState: cancelled`,
  `errorName MessageAbortedError`, `causalEvidence: unique-owned-message`) after a real tool-call
  round. So the tightening does not make a genuinely unique owned identity unconfirmable.
- **`readOpenCodeSessionStatus` is auxiliary.** `session.status` never confirms a cancel on its own.
  The replay's cancel case is confirmed by the owned final event, not by an `idle` observation.
- **Advisory, not fixed (outside this change).** `projectOpenCodeEvent` in
  `opencode-adapter/src/index.ts` still branches on a `permission.updated` tag that the installed
  substrate never emits; the real owner of that path is the `permission.ask` plugin hook in
  `registerOpenCodeHooks`. The delivered replay exercises the real `permission.asked` /
  `permission.replied` contracts, so the stale branch has no delivered behaviour behind it.
- **Superseded evidence.** `docs/evidence/0aca95ef…-u6-installed-session-20261007/` documents the
  earlier tree `0aca95ef…` only and is marked historical; `docs/evidence/8d27ed96…-u6-installed-session-20261007/`
  documents tree `8d27ed96…`. Neither covers this tree.
