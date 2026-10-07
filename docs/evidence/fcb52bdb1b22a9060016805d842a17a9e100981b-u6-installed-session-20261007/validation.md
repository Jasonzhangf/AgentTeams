# U6 Installed Session Contract Validation (r19)

Task: `docs/design/teams-session-delivery.md` delivered path
Date: 2026-10-07 (America/Los_Angeles)
Status: `INSTALLED PUBLIC-ENTRY EVIDENCE / TREE-BOUND`

## Which commit this directory is about

This directory is named after the **tree hash**, because the receipt binds the tree,
not the commit that publishes the receipt.

| Fact | Value |
|---|---|
| Product tree the receipt binds, installs and replays | `fcb52bdb1b22a9060016805d842a17a9e100981b` |
| Commit whose tree that is | `0edb591edd1f942464880b80346c2d9354dc0bb0` |
| Delivery branch base | `e3ad473a4df609decef807401df756088c911b75` |
| This evidence directory | added by a `docs/`-only commit whose parent is that commit |

A receipt cannot live inside the commit it binds: it is written after the commit, and
adding it changes the tree hash. The receipt is produced under `generated/`, which
`.gitignore:5` excludes, so this directory holds its tracked copy. The publishing commit
changes no product path. Verify that one fact:

```text
$ git diff --name-only fcb52bdb1b22a9060016805d842a17a9e100981b HEAD | grep -v '^docs/'
```

Nothing is printed when the claim holds. Code admission rests on the tree the receipt
names. The receipt is never evidence for the commit that carries it.

## What changed in this candidate

This candidate answers the r18 independent review
(`u6-session-implementation-20261006-r18-main-retry-2-9zdslj`, verdict `fail` / `code_failure`, 1 P1).

| Finding | Severity | Change |
|---|---|---|
| `opencode-adapter/src/index.ts:734` fabricated the fields the installed SDK types as required for their tool state: an absent `completed.metadata` became `{}`, an absent `ToolStateError.error` became `''`, and a non-string `ToolStatePending.raw` became `''`. The closed Console parser accepts all three, so a malformed substrate part was projected as a successful-looking event with no loss record | P1 | `classifyPart` now returns `{ kind: 'invalid' }` for a `pending` state without a string `raw`, a `completed` state without `metadata`, and an `error` state without a string `error`, instead of normalizing them |

`classifyPart` no longer fabricates any per-state required field. The only remaining
optional-field handling matches the installed SDK: `running.title`, `running.metadata`,
`error.metadata` and `completed.attachments` are genuinely optional, and each is validated as
JSON when present.

The adapter test `projects every tool state into a shape the closed Console wire parser accepts`
now covers the negative shapes (`pending` without `raw`, `completed` without `metadata`,
`error` without a string `error`, plus the earlier title/output shapes) alongside the per-state
round trip through `parseConsoleSessionEvent` with the owning `agentId` bound (the adapter leaves
it empty; `runtime/agent-process.ts:309,442` binds it).

This candidate also carries the earlier r16 and r17 fixes: the multi-match assistant binding stays
ambiguous (a second distinct assistant identity for one `requestMessageId` refuses a cancel with
typed `ambiguous-owner` before any abort), the adapter exposes the substrate's real
`session.status` passthrough as typed auxiliary observation, and a tool title that cannot satisfy
the wire's non-empty rule is rejected instead of failing the whole projection reply.
`docs/architecture/verification-map.json` lists all four rules under
`teams-managed-session-contract`.

## Commands, exit codes and evidence

All commands ran in `/Volumes/Intel/playground/agentteams/u6-session-implementation-20261006`
on the clean committed candidate `0edb591edd1f942464880b80346c2d9354dc0bb0` (tree
`fcb52bdb1b22a9060016805d842a17a9e100981b`, `git status --porcelain` empty).

| Command | Result | Log |
|---|---|---|
| `pnpm build:governance` | exit 0, artifact `eb7530799c9d30fb8b1978b744d70d07c0a9d9c552a6cc16374b92d07c34bf54` | `build.log` |
| `pnpm typecheck` | exit 0 | `typecheck.log` |
| mapped gate for `teams-managed-session-contract` (9 spec files) | exit 0, 9 files / 127 tests | `gates.log` |
| `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --config vitest.config.ts --maxWorkers=2 --testTimeout=90000` | exit 0, 81 files / 673 tests | `full-regression.log` |
| `pnpm dagpipe graph validate docs/design/dagpipe/graphs/session-request.graph.json` | exit 0, `valid DAG: agentteams.session-request@1 (7 nodes, 7 edges, 6 waves)` | `gates.log` |
| `node scripts/u6-installed-session-replay.mjs --pack-root generated/modules/teams-source/lib --evidence-dir … --receipt-path …` | exit 0, 16/16 cases | `replay-cli.log`, `u6-installed-session-replay.receipt.json` |

### Installed replay receipt

`u6-installed-session-replay.receipt.json` is the primary public-entry evidence. It binds:

| Field | Value |
|---|---|
| `candidate.head_commit` | `0edb591edd1f942464880b80346c2d9354dc0bb0` |
| `candidate.tree_hash` | `fcb52bdb1b22a9060016805d842a17a9e100981b` |
| `candidate.base_commit` | `e3ad473a4df609decef807401df756088c911b75` |
| `candidate.source_state` | `committed` |
| `package.content_sha256` | `36c298a1779ac5320ab03afb6e58309ae3e6477d08369d37dbe0519684f379ac` |
| `install.installed_content_sha256` | `36c298a1779ac5320ab03afb6e58309ae3e6477d08369d37dbe0519684f379ac` (equals the pack) |
| `cleanup.leaked_pids` | `[]` |
| `cleanup.temporary_root_removed` | `true` |

Cases, in order: `initialization, lifecycle, console, discovery, config.apply, session.create,
session.open, session.send, permission, session.cancel, passive-refusal, binding-without-owner,
unsupported-payload, console-offline, stale-generation, clean-stop`.

Two cases matter directly for this candidate's tightening:

- `permission` recorded `status: "passed"` after a real `bash` tool call whose `completed` state
  passed the new required-field validation. So the installed substrate does supply `metadata`,
  `output` and a non-empty `title` on a real completed tool state; the stricter classifier rejects
  only genuinely malformed shapes.
- `session.cancel` recorded `variant: "confirmed"`. The installed substrate produced one owned
  assistant identity for the held prompt, the abort was accepted, and the final
  `MessageAbortedError` reconciled it to `finalState: cancelled`, so the multi-match tightening
  does not make a genuinely unique owned identity unconfirmable.

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
  (`36c298a1…` == `install.installed_content_sha256`), and candidate equivalence is judged by
  `git diff --name-only <tree> HEAD | grep -v '^docs/'` printing nothing.
- **Cross-check on the real substrate.** The U7 installed Session case BB12, run at a tip that
  contains this candidate's multi-match tightening, also recorded a confirmed cancel
  (`baseAccepted true`, `reconciliation: confirmed`, `finalState: cancelled`,
  `errorName MessageAbortedError`, `causalEvidence: unique-owned-message`) after a real tool-call
  round.
- **`readOpenCodeSessionStatus` is auxiliary.** `session.status` never confirms a cancel on its own.
  The replay's cancel case is confirmed by the owned final event, not by an `idle` observation.
- **Advisory, not fixed (outside this change).** `projectOpenCodeEvent` in
  `opencode-adapter/src/index.ts` still branches on a `permission.updated` tag that the installed
  substrate never emits; the real owner of that path is the `permission.ask` plugin hook in
  `registerOpenCodeHooks`. The delivered replay exercises the real `permission.asked` /
  `permission.replied` contracts, so the stale branch has no delivered behaviour behind it.
- **Superseded evidence.** `docs/evidence/0aca95ef…-u6-installed-session-20261007/` (tree
  `0aca95ef…`), `docs/evidence/8d27ed96…-u6-installed-session-20261007/` (tree `8d27ed96…`) and
  `docs/evidence/882a1679…-u6-installed-session-20261007/` (tree `882a1679…`) are marked
  historical. None of them covers this tree.
