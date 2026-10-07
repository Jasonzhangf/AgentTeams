# U6 Installed Session Contract Validation (r16)

Task: `docs/design/teams-session-delivery.md` delivered path
Date: 2026-10-07 (America/Los_Angeles)
Status: `INSTALLED PUBLIC-ENTRY EVIDENCE / TREE-BOUND`

## Which commit this directory is about

This directory is named after the **tree hash**, because the receipt binds the tree,
not the commit that publishes the receipt.

| Fact | Value |
|---|---|
| Product tree the receipt binds, installs and replays | `8d27ed963daf25c3ffff3008354eb8208ee5a9f9` |
| Commit whose tree that is | `d3e25daebb4f0853db199bf931865033e1358c30` |
| Delivery branch base | `e3ad473a4df609decef807401df756088c911b75` |
| This evidence directory | added by a `docs/`-only commit whose parent is that commit |

A receipt cannot live inside the commit it binds: it is written after the commit, and
adding it changes the tree hash. The receipt is produced under `generated/`, which
`.gitignore:5` excludes, so this directory holds its tracked copy. The publishing commit
changes no product path. Verify that one fact:

```text
$ git diff --name-only 8d27ed963daf25c3ffff3008354eb8208ee5a9f9 HEAD | grep -v '^docs/'
```

Nothing is printed when the claim holds. Code admission rests on the tree the receipt
names. The receipt is never evidence for the commit that carries it.

## What changed in this candidate

This candidate answers the r15 independent review (`u6-session-implementation-20261006-r15-main`,
verdict `fail` / `code_failure`, 2 P1 + 1 P2).

| Finding | Severity | Change |
|---|---|---|
| `runtime/agent-process.ts:266` silently kept the first assistant binding when a second distinct assistant identity shared `parentID === requestMessageId`, so a later `MessageAbortedError` for that first identity could reconcile a confirmed cancel | P1 | `SessionOperationRecord` now keeps `promptMatchIds`; `bindPromptMatch` records every distinct identity, clears `promptMessageId` as soon as there are two, and the `MessageAbortedError` confirm guard additionally requires `current.promptMessageId === event.messageId` |
| `opencode-adapter/src/index.ts:173` exposed no `session.status` / `readStatus` | P1 | added `OpenCodeSessionStatus`, `OpenCodeSessionClient.session.status` and `readOpenCodeSessionStatus`, unwrapping the real SDK `session.status` map as auxiliary observation |
| trailing whitespace in the published r15 logs | P2 | regenerated logs in this directory carry no trailing whitespace |

Both fixes carry focused tests:

- `runtime/agent-process.spec.ts` — `keeps a multi-match assistant identity ambiguous and never confirms its cancel`
  asserts `cancelSession` returns `{ ok: false, error: { code: 'RESULT_UNKNOWN', detail: { reason: 'ambiguous-owner' } } }`,
  that `abortCalls()` stays `0`, that no `cancel`/`reconciled` event is emitted, and that an
  in-flight abort cannot be confirmed from an ambiguous binding (it settles `unknown` / `no-final`).
- `opencode-adapter/tests/index.spec.ts` — `reads the real session-level status map as auxiliary observation only`
  and `reports a failing session.status as a typed adapter error instead of idle`.
- `docs/architecture/verification-map.json` — the `teams-managed-session-contract` gate now lists both
  the multi-match ambiguity rule and the typed status passthrough.

## Commands, exit codes and evidence

All commands ran in `/Volumes/Intel/playground/agentteams/u6-session-implementation-20261006`
on the clean committed candidate `d3e25daebb4f0853db199bf931865033e1358c30` (tree
`8d27ed963daf25c3ffff3008354eb8208ee5a9f9`, `git status --porcelain` empty).

| Command | Result | Log |
|---|---|---|
| `pnpm build:governance` | exit 0, artifact `5f46f2c39a271ec1fbb349ae9b96603920ae36b7f5677d09a9e67aae50aad104` | `build.log` |
| mapped gate for `teams-managed-session-contract` (9 spec files) | exit 0, 9 files / 126 tests | `gates.log` |
| `pnpm typecheck` | exit 0 | — |
| `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --config vitest.config.ts --maxWorkers=2 --testTimeout=90000` | exit 0, 81 files / 672 tests | `full-regression.log` |
| `pnpm dagpipe graph validate docs/design/dagpipe/graphs/session-request.graph.json` | exit 0, `valid DAG: agentteams.session-request@1 (7 nodes, 7 edges, 6 waves)` | `gates.log` |
| `node scripts/u6-installed-session-replay.mjs --pack-root generated/modules/teams-source/lib --evidence-dir … --receipt-path …` | exit 0, 16/16 cases | `replay-cli.log`, `u6-installed-session-replay.receipt.json` |

### Installed replay receipt

`u6-installed-session-replay.receipt.json` is the primary public-entry evidence. It binds:

| Field | Value |
|---|---|
| `candidate.head_commit` | `d3e25daebb4f0853db199bf931865033e1358c30` |
| `candidate.tree_hash` | `8d27ed963daf25c3ffff3008354eb8208ee5a9f9` |
| `candidate.base_commit` | `e3ad473a4df609decef807401df756088c911b75` |
| `candidate.source_state` | `committed` |
| `package.content_sha256` | `72668d9dbaa3cbaad36ac90b925fe901f4dd94431e100707697e02237551d8b5` |
| `install.installed_content_sha256` | `72668d9dbaa3cbaad36ac90b925fe901f4dd94431e100707697e02237551d8b5` (equals the pack) |
| `cleanup.leaked_pids` | `[]` |
| `cleanup.temporary_root_removed` | `true` |

Cases, in order: `initialization, lifecycle, console, discovery, config.apply, session.create,
session.open, session.send, permission, session.cancel, passive-refusal, binding-without-owner,
unsupported-payload, console-offline, stale-generation, clean-stop`.

`session.cancel` recorded `variant: "confirmed"`. This is the evidence that the multi-match
tightening did not turn the real single-identity cancel path into an unconfirmable one: the
installed substrate still produced one owned assistant identity for the held prompt, the
abort was accepted, and the final `MessageAbortedError` reconciled it to `finalState: cancelled`.

## Boundaries of this evidence

- **AppSDK admission is not claimed.** `pnpm appsdk verify` / `appsdk compile` cannot run on this
  machine: `/Users/fanzhang/.cargo/bin/appsdk` reports `appsdk 0.1.0011 (rust)` while
  `.appsdk/project.json` declares `sdk.version = "0.1.0010"`, so the CLI fails with
  `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0010:required_binary=appsdk-0.1.0010` (exit 1). The same
  failure reproduces on the untouched base commit, so it is toolchain drift, not a regression of
  this candidate. See `appsdk-pin-mismatch-on-base.log`. No prebuilt `appsdk` 0.1.0010 binary
  exists on this machine, and restoring one or promoting the pin are both outside this change.
- **Pack content hash is not byte-reproducible.** Two `pnpm build:governance` runs on this same
  commit produced `5f46f2c3…` and `7e330057…` because the build recompiles the `runtime/dagpipe`
  runner. The receipt therefore binds the pack it actually installed
  (`72668d9d…` == `install.installed_content_sha256`), and candidate equivalence is judged by
  `git diff --name-only <tree> HEAD | grep -v '^docs/'` printing nothing.
- **Cross-check on the real substrate.** The U7 installed Session case BB12, run at the rebased
  tip that contains this candidate's multi-match tightening, also recorded a confirmed cancel
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
