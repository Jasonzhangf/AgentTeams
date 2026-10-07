# U6 Installed Session Contract Validation

Task: `docs/design/teams-session-delivery.md` delivered path
Date: 2026-10-07 (America/Los_Angeles)
Status: `SUPERSEDED / HISTORICAL`

> **Superseded.** This directory documents the tree `0aca95ef682eca42947d6df48f7452f5505515e8`
> only. The branch has since moved to tree `8d27ed963daf25c3ffff3008354eb8208ee5a9f9`
> (commit `d3e25daebb4f0853db199bf931865033e1358c30`), which changes product paths, so every
> claim below holds **at the publishing commit `de1b9c42` and nowhere later**. The current
> receipt is `docs/evidence/8d27ed963daf25c3ffff3008354eb8208ee5a9f9-u6-installed-session-20261007/`.

## Which commit this directory is about

This directory is named after the **tree hash**, because the receipt binds the tree,
not the commit that publishes the receipt.

| Fact | Value |
|---|---|
| Product tree the receipt binds, installs and replays | `0aca95ef682eca42947d6df48f7452f5505515e8` |
| Commit whose tree that is | `8ffb130832391007c56e02fad79c94856d3a385a` |
| Delivery branch base | `e3ad473a4df609decef807401df756088c911b75` |
| This evidence directory | added by a `docs/`-only commit whose parent is that commit |

A receipt cannot live inside the commit it binds: it is written after the commit, and
adding it changes the tree hash. The receipt is produced under `generated/`, which
`.gitignore:5` excludes, so this directory holds its tracked copy. The publishing commit
changes no product path. Verify that one fact at the publishing commit `de1b9c42`:

```text
$ git diff --name-only 0aca95ef682eca42947d6df48f7452f5505515e8 de1b9c42 | grep -v '^docs/'
```

Nothing is printed when the claim holds. At any later commit the branch has moved on and this
receipt no longer covers it; use the receipt named in the superseded banner above. Code
admission rests on the tree the receipt names. The receipt is never evidence for the commit
that carries it.

## Candidate identity, recorded at `8ffb130`

```text
$ git rev-parse 8ffb130
8ffb130832391007c56e02fad79c94856d3a385a

$ git rev-parse 8ffb130^{tree}
0aca95ef682eca42947d6df48f7452f5505515e8

$ git merge-base 8ffb130 origin/main
e3ad473a4df609decef807401df756088c911b75

$ git status --porcelain          # at 8ffb130
(empty)
```

## What this round changed

The previous review round reported one P1. It is fixed here, and the code fix is a
product-path change, so this directory supersedes the earlier evidence directory named
after tree `1a1d3940`.

| Finding | Fix in this candidate |
|---|---|
| A binding whose managed executable is unresolvable returned `CREDENTIAL_UNAVAILABLE`, but `docs/design/teams-session-delivery.md:45` gates `sessionCapable` on a *constructed* Session owner, so this Agent is passive and owes the contract's typed capability refusal | `runtime/agent-process.ts` now records `UNSUPPORTED_OPERATION` for that path; `runtime/agent-process.spec.ts:407` asserts it; the installed replay gained the `binding-without-owner` case |

`CREDENTIAL_UNAVAILABLE` remains the Config-owner code (`runtime/agent-process.ts:969`,
`docs/design/teams-session-delivery.md:827`) and is no longer used for a missing
managed executable.

## Receipt fields

```text
u6-installed-session-replay.receipt.json
  status                          = passed
  candidate.head_commit           = 8ffb130832391007c56e02fad79c94856d3a385a
  candidate.tree_hash             = 0aca95ef682eca42947d6df48f7452f5505515e8
  candidate.indexed_tree_hash     = 0aca95ef682eca42947d6df48f7452f5505515e8
  candidate.source_state          = committed
  candidate.base_commit           = e3ad473a4df609decef807401df756088c911b75
  package.pack_root               = generated/modules/teams-source/lib
  package.content_sha256          = ef735b08ca375e8ce4864aa1cc8099e0373d85bd97240ef74c808008236f5f5e
  install.installed_content_sha256 = ef735b08ca375e8ce4864aa1cc8099e0373d85bd97240ef74c808008236f5f5e
  cleanup.leaked_pids             = []
  cleanup.temporary_root_removed  = true
```

`package.content_sha256` equals `install.installed_content_sha256`, so the replayed
package is the package this tree produced. The hash covers every file the pack staged,
including the compiled runtime, Console library and UI. It does not include `docs/`, so
docs-only commits cannot change it. The pack hash is **not** byte-reproducible across
builds: `pnpm build:governance` rebuilds the `runtime/dagpipe` runner binary, so a
second build from this same product tree produced a different `content_sha256`. This
directory therefore records the receipt of the build it actually replayed, and
candidate equivalence is asserted by the docs-only diff command above, not by the hash.

## What was replayed

`scripts/u6-installed-session-replay.mjs` installs the staged tarball outside the source
tree under a private HOME, starts the installed CLI launcher, and drives every Session
action through the installed Console HTTP ingress. The request path is
`console-host/src/http-api.ts` -> `runtime/console-hub.ts` ->
`runtime/relay-console-client.ts` -> `runtime/agent-process.ts` -> the real
`ManagedConfigOwner` -> the real managed OpenCode child
(`/Users/fanzhang/.opencode/bin/opencode` 1.18.23, reached through
`AGENTTEAMS_OPENCODE_EXECUTABLE`) -> a local OpenAI-compatible provider stub.

Sixteen cases passed:

```text
initialization, lifecycle, console, discovery, config.apply,
session.create, session.open, session.send, permission,
session.cancel, passive-refusal, binding-without-owner,
unsupported-payload, console-offline, stale-generation, clean-stop
```

## Required assertions

| Requirement | Observation in the receipt |
|---|---|
| Message meaning preserved | `session.send` returned `ok=true`; the projection carried the assistant text part the stub returned |
| Real tool call with identity, arguments and result | a `bash` tool call reached the substrate; the completed tool event kept `callId`, `input.command` verbatim, and the command's own stdout |
| Approve produces the expected side effect | the `permission` `once` round answered the substrate's own requests and the approved `read` returned the file content |
| Reject produces no such side effect | the `permission` `reject` round answered the request and the rejected tool returned no file content |
| Cancel keeps the base acceptance and a correlated outcome | `baseAccepted=true`, `reconciliation=confirmed`, `finalState=cancelled`, the aborted error name, and the correlated `promptMessageId`; the held dispatch ended on that correlation |
| Passive Agent explicitly unsupported | create and send both returned typed `UNSUPPORTED_OPERATION` |
| Binding without a launch-owned owner is passive, not credential-broken | `binding-without-owner` observed `sessionCapable=false`, `sessionAvailability=not-applicable`, and both create and send returned typed `UNSUPPORTED_OPERATION` with `managed OpenCode executable is unavailable`; the message names the unresolved executable |
| Unmappable payload is a typed refusal | `unsupported-payload` returned typed `UNSUPPORTED_OPERATION` |

The permission case is real, not simulated. The managed launch config sets no
`permission` policy, so the substrate's built-in default applies: `"*":"allow"`,
`doom_loop:"ask"`, `external_directory:{"*":"ask"}`, `read:{"*.env":"ask"}`. A `bash`
probe is therefore auto-allowed, and the substrate genuinely asks before a `*.env`
read. The replay answers those asks in decision rounds, so the Console stays an optional
client and is never a required data path. Model text is never a fixed assertion.

The `binding-without-owner` case runs its own installed launcher with its own HOME,
because the managed executable is a per-launcher launch parameter. That Agent has a
declared `[agents.bound-agent.model]` binding and
`AGENTTEAMS_OPENCODE_EXECUTABLE=/missing/u6-opencode`, so it is exactly the
binding-without-owner shape the verification map names.

## Companion logs in this directory

All logs were produced at `8ffb130` on tree `0aca95ef`.

| File | Command | Result |
|---|---|---|
| `replay-cli.log` | `node scripts/u6-installed-session-replay.mjs` | passed, 16 cases |
| `full-regression.log` | `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --config vitest.config.ts --maxWorkers=2 --testTimeout=90000` | 81 files / 669 tests passed |
| `gates.log` | the mapped `teams-managed-session-contract` command (9 files / 123 tests); `pnpm typecheck`; `dagpipe graph validate docs/design/dagpipe/graphs/session-request.graph.json`; `pnpm appsdk verify`; `node scripts/installed-runtime-smoke.mjs` | mapped gate, typecheck, dagpipe and installed smoke exit 0; `pnpm appsdk verify` exit 1 — see the boundary section |
| `appsdk-pin-mismatch-on-base.log` | `pnpm appsdk verify` at the untouched base commit `e3ad473` | the same `PROJECT_SDK_VERSION_PIN_MISMATCH` — pre-existing, not caused by this candidate |
| `build.log` | `pnpm build:governance` | exit 0, staged pack at `generated/modules/teams-source/lib` |

## Boundary and open gap

- This evidence covers the installed Console -> Agent -> managed OpenCode Session path.
  Browser acceptance and the U7 user-driver package (`BB10`, `BB12`) are downstream host
  gates and stay PENDING.
- `pnpm appsdk verify` cannot pass in this environment. The installed `appsdk` binary
  reports `appsdk 0.1.0011` while `.appsdk/project.json:281` pins `0.1.0010`, so the
  binary fails closed with `PROJECT_SDK_VERSION_PIN_MISMATCH:0.1.0010`. The same command
  fails identically on the untouched base commit `e3ad473`, before any change of this
  candidate, so it is toolchain drift and not a regression here. The AppSDK binary is
  outside this repository; restoring the pinned binary needs separate authorization.
  Every other gate in `gates.log` passes. Because one declared gate cannot run, this
  round does not claim AppSDK admission.
- Advisory, unchanged and out of scope: `projectOpenCodeEvent`
  (`opencode-adapter/src/index.ts:947`) still branches on `permission.updated`, a tag
  the substrate never emits. The live owner is the `permission.ask` plugin hook in
  `registerOpenCodeHooks`.
