# U6 Installed Session Contract Validation

Task: `docs/design/teams-session-delivery.md` delivered path
Date: 2026-10-07 (America/Los_Angeles)
Status: `INSTALLED PUBLIC-ENTRY EVIDENCE / TREE-BOUND`

## Which commit this directory is about

This directory is named after the **tree hash**, because the receipt binds the tree,
not the commit that publishes the receipt.

| Fact | Value |
|---|---|
| Product tree the receipt binds, installs and replays | `1a1d39406f177322949ef744756e1a9fce89a00c` |
| Commit whose tree that is | `475a5eb200461e5664d40d1f97f995ba3df17c50` |
| Delivery branch base | `e3ad473a4df609decef807401df756088c911b75` |
| This evidence directory | added by a `docs/`-only commit whose parent is the delivery branch |

A receipt cannot live inside the commit it binds: it is written after the commit, and
adding it changes the tree hash. The receipt is produced under `generated/`, which
`.gitignore:5` excludes, so this directory holds its tracked copy. The publishing commit
changes no product path. Verify that one fact:

```text
$ git diff --name-only 1a1d39406f177322949ef744756e1a9fce89a00c HEAD | grep -v '^docs/'
```

Nothing is printed when the claim holds. Code admission rests on the tree the receipt
names. The receipt is never evidence for the commit that carries it.

## Candidate identity, recorded at `475a5eb`

```text
$ git rev-parse 475a5eb
475a5eb200461e5664d40d1f97f995ba3df17c50

$ git rev-parse 475a5eb^{tree}
1a1d39406f177322949ef744756e1a9fce89a00c

$ git merge-base 475a5eb origin/main
e3ad473a4df609decef807401df756088c911b75

$ git status --porcelain          # at 475a5eb
(empty)
```

The product tree is unchanged by every later docs-only commit on the branch. Confirm:

```text
$ git diff --name-only 475a5eb200461e5664d40d1f97f995ba3df17c50 HEAD | grep -v '^docs/'
```

## Receipt fields

```text
u6-installed-session-replay.receipt.json
  status                          = passed
  candidate.head_commit           = 475a5eb200461e5664d40d1f97f995ba3df17c50
  candidate.tree_hash             = 1a1d39406f177322949ef744756e1a9fce89a00c
  candidate.indexed_tree_hash     = 1a1d39406f177322949ef744756e1a9fce89a00c
  candidate.source_state          = committed
  candidate.base_commit           = e3ad473a4df609decef807401df756088c911b75
  package.pack_root               = generated/modules/teams-source/lib
  package.content_sha256          = 8dfdbe3d7227b86e74549f102b3b7534f8fd164bb00cee93ac780d6876568eba
  install.installed_content_sha256 = 8dfdbe3d7227b86e74549f102b3b7534f8fd164bb00cee93ac780d6876568eba
  cleanup.leaked_pids             = []
  cleanup.temporary_root_removed  = true
```

`package.content_sha256` equals `install.installed_content_sha256`, so the replayed
package is the package this tree produced. The hash covers every file the pack staged,
including the compiled runtime, Console library and UI. It does not include `docs/`, so
docs-only commits cannot change it.

## What was replayed

`scripts/u6-installed-session-replay.mjs` installs the staged tarball outside the source
tree under a private HOME, starts the installed CLI launcher, and drives every Session
action through the installed Console HTTP ingress. The request path is
`console-host/src/http-api.ts` -> `runtime/console-hub.ts` ->
`runtime/relay-console-client.ts` -> `runtime/agent-process.ts` -> the real
`ManagedConfigOwner` -> the real managed OpenCode child
(`/Users/fanzhang/.opencode/bin/opencode` 1.18.23, reached through
`AGENTTEAMS_OPENCODE_EXECUTABLE`) -> a local OpenAI-compatible provider stub.

Fifteen cases passed:

```text
initialization, lifecycle, console, discovery, config.apply,
session.create, session.open, session.send, permission,
session.cancel, passive-refusal, unsupported-payload,
console-offline, stale-generation, clean-stop
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
| Unmappable payload is a typed refusal | `unsupported-payload` returned typed `UNSUPPORTED_OPERATION` |

The permission case is real, not simulated. The managed launch config sets no
`permission` policy, so the substrate's built-in default applies: `"*":"allow"`,
`doom_loop:"ask"`, `external_directory:{"*":"ask"}`, `read:{"*.env":"ask"}`. A `bash`
probe is therefore auto-allowed, and the substrate genuinely asks before a `*.env`
read. The replay answers those asks in decision rounds, so the Console stays an optional
client and is never a required data path. Model text is never a fixed assertion.

## Companion logs in this directory

All logs were produced at `475a5eb` on the same tree.

| File | Command | Result |
|---|---|---|
| `replay-cli.log` | `node scripts/u6-installed-session-replay.mjs` | passed, 15 cases |
| `full-regression.log` | `TEAMS_CONSOLE_REAL_DOM=1 pnpm exec vitest run --config vitest.config.ts --maxWorkers=2 --testTimeout=90000` | 81 files / 669 tests passed |
| `gates.log` | `pnpm typecheck`; `dagpipe graph validate docs/design/dagpipe/graphs/session-request.graph.json`; `pnpm appsdk verify`; `node scripts/installed-runtime-smoke.mjs` | all exit 0 |
| `build.log` | `pnpm build:governance` | exit 0, staged pack at `generated/modules/teams-source/lib` |

## Boundary

This evidence covers the installed Console -> Agent -> managed OpenCode Session path.
Browser acceptance and the U7 user-driver package (`BB10`, `BB12`) are downstream host
gates and stay PENDING.
