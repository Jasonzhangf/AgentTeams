# U6 Session Design Validation

Task: `docs/design/teams-session-delivery.md`
Date: 2026-10-03 (America/Los_Angeles)
Status: `DESIGN-ONLY / UNVERIFIED`

## Baseline and revision binding

Current primary baseline: `b969e9740704977326c5054fb3afbeab8d523e36`, branch
`codex/u6-session-design-20261003`. The r5 reviewed candidate was HEAD
`63fe1cb68bf8943a9611ad8df73d4bf95f302bbb`, staged tree
`4361eb51519eb460a9afe1145d805ce5f7097cd6`, three `A ` staged additions.
Its final controller verdict was FAIL (four P1 and one P2); it is not admission
for this corrected candidate. Current exact tree/paths/checks are recorded in
the primary external receipt
`$HOME/.codex/task-evidence/agentteams/receipts/u6-session-design-20261003/r5-correction/candidate-receipt.json`
after validation and explicit staging. No current independent PASS is claimed.

Historical r4 author transcript follows. These commands are historical inputs,
not commands executed on the current candidate:

```text
$ git rev-parse HEAD
c3aa36fc637e2da4ac821d1b26d587eadbbf1268

$ git branch --show-current
codex/u6-session-design-20261003

$ git status --short
AM docs/design/teams-session-delivery.md
AM docs/evidence/u6-session-design-20261003/notes.md
AM docs/evidence/u6-session-design-20261003/validation.md
```

The historical author left the three paths above. Primary corrections remain
limited to those three paths; no product source, graph or map changes.

r1 originally reviewed base `55c8282cbad3886022790d9ffb4b04a84b776820` with
staged tree `41b6ae9b224faeed3e6992639cbc70b93be55c4d`. The historical r3
correction used HEAD `c3aa36fc637e2da4ac821d1b26d587eadbbf1268` before r4/r5.
The current r5 findings correction remains uncommitted and unadmitted.

## Commands run

The following author commands/SDK extractions retain their historical scope.
Current primary validation is reported separately at the end of this file.

### git diff --check

```text
$ git diff --check
(no output; exit 0)
```

### git diff --cached --check

```text
$ git diff --cached --check
(no output; exit 0)
```

### graph validation (read-only)

```text
$ dagpipe graph validate docs/design/dagpipe/graphs/session-request.graph.json
valid DAG: agentteams.session-request@1 (5 nodes, 4 edges, 5 waves)
operator bindings are syntactically present; project compile() remains the authoritative registry/schema/effect gate
```

No graph file was modified. The task prompt mentioned `session-dispatch.graph.json`; that file does not exist. The actual existing B5 Session graph is `docs/design/dagpipe/graphs/session-request.graph.json`, and that is the path validated here.

### Markdown fence balance and relative links

Read-only inline Node validator over the three allowed documents:

```text
fences docs/design/teams-session-delivery.md: 14 pairs
fences docs/evidence/u6-session-design-20261003/notes.md: 0 pairs
fences docs/evidence/u6-session-design-20261003/validation.md: 8 pairs
```

No missing relative links were reported. The validator used Node `fs`/`path`
only for reads and did not modify files.

### SDK 1.18.23 truth (read-only)

The r4 author reconfirmed the r3 correction against `@opencode-ai/sdk@1.18.23`
in its own `/tmp/u6-sdk-r4.p6EHJO`. This is a separate extraction from the r2
historical command transcript below; neither temporary path is expected to
remain after cleanup. Retained r4 author events `item_36` record mktemp,
npm pack and extraction, and `item_39`–`item_42` record reads from the r4 path.
They are in the primary evidence file
`u6-session-design-20261003-r4-author.events.jsonl`; these events, rather than
an absent temporary directory, bind the r4 observation. Exact typings reconfirmed:

- `SessionAbortResponses` is `boolean`; there is no operation ID in the abort response.
- `EventSessionIdle.properties` has only `sessionID`.
- `AssistantMessage` carries real `id`, `sessionID` and optional structured
  `error`, including `MessageAbortedError`.
- `SessionPromptResponses.200` is `{ info: AssistantMessage; parts: Array<Part> }`.
- `SessionPromptData.body` has optional `messageID?`; U6 does not treat this as a
  confirmed SDK operation identity for cancel reconciliation.
- `SessionCreateData.body` is `{ parentID?, title? }`; no model field.

Historical r2 download transcript (not the r4 command):

```text
$ npm pack @opencode-ai/sdk@1.18.23 --pack-destination /tmp/u6-sdk-r2.OYTA8C
opencode-ai-sdk-1.18.23.tgz
shasum: 97cea835474420320d24b304604f4dcadc126bf6

$ rg -n '@opencode-ai/sdk' pnpm-lock.yaml
126:  '@opencode-ai/sdk@1.18.23':
921:  '@opencode-ai/sdk@1.18.23':
```

The historical r2 typings were read from
`/tmp/u6-sdk-r2.OYTA8C/package/dist/gen/types.gen.d.ts`:

- `SessionCreateData.body` is `{ parentID?, title? }`; there is no model field.
- `SessionPromptData.body.model` is optional `{ providerID, modelID }`.
- `SessionAbortResponses` is `boolean`.
- `EventPermissionReplied.properties.response` is `string`.
- `EventSessionIdle.properties` has only `sessionID`.
- `ToolPart` carries `id`, `sessionID`, `messageID`, `callID`, `tool` and `state`.
- `Permission` carries `id`, `type`, `sessionID`, `messageID`, optional `callID`, `title`, `metadata`, `time`.
- `Message` distinguishes user/assistant; assistant carries `providerID`, `modelID`, `time.completed?`, `error?`.
- `MessageAbortedError` is a distinct structured error name.

The local `/Users/fanzhang/.opencode/node_modules/@opencode-ai/sdk` is an old
version and was not used as truth. The temporary extraction
`/tmp/u6-sdk-r2.OYTA8C` was removed after the checks; `test ! -e` succeeded.

Primary r4 review consumption: controller FAIL concerned the adjacent r2
transcript being presented as r4 evidence. The retained r4 author events prove
the separate real r4 extraction/reads and its cleanup (`item_120`); this record
now labels both attempts explicitly. No SDK download, product test or inference
was repeated. Both extraction paths remain absent as the intended cleanup
result, not as a claim of current filesystem evidence.
The earlier `/tmp/u6-sdk-1.18.23-a` path is also absent.

### Targeted seam checks

All of the following read-only probes passed:

```text
PASS: no session.create model member in command union
PASS: explicit create/model owner statement
PASS: SessionCreateResult typed result and adapter->wire/UI consumer/test roundtrip defined
PASS: runtime|directory agent observation union with explicit missing-kind failure
PASS: decoder ownership/caller documented
PASS: discriminated event contract documented
PASS: cancel outcomes/baseAccepted documented
PASS: per-session single active prompt admission and exact owned MessageAbortedError causality documented
PASS: cancel unknown retention and U2 durable fence seam documented
PASS: expected error containment documented
PASS: readiness states documented
PASS: model target mapping/caller documented
PASS: BB10/BB12 real-inference acceptance preserved
```

### r3 correction targeted checks

```text
git diff --check: exit 0
git diff --cached --check: exit 0
dagpipe graph validate docs/design/dagpipe/graphs/session-request.graph.json
  -> valid DAG: agentteams.session-request@1 (5 nodes, 4 edges, 5 waves)
read-only Markdown fence/link validator: balanced fences, no missing relative links
```

Design probes confirmed:

- `kind:'runtime'` requires `sessionCapable`/`sessionAvailability` and
  `current` requires real effective revision; `kind:'directory'` forbids all
  session/model fields; missing kind, wrong shapes, and directory rows carrying
  runtime fields fail explicitly in the wire decoder.
- Offline directory rows and online empty projections are produced by
  `runtime/console-hub.ts` as directory rows; online runtime fields are passed
  through verbatim; UI action gating requires `runtime && sessionCapable &&
  sessionAvailability==='current' && presence==='online'`.
- Per-session single active prompt operation record is claimed synchronously
  before the first async `session.prompt` dispatch; second prompt and duplicate
  cancel conflict before the SDK; different sessions stay concurrent and
  `ManagedConfigOwner.activeOperations` semantics are unchanged.
- `session.cancel` is bound to the snapshot operation/session/effective
  revision/prompt message identity; only a unique owned real `MessageAbortedError`
  with matching session/message can produce `reconciled`/`confirmed`.
- Idle, status idle, other same-session errors, missing/unknown message id,
  stale runtime generation/effective revision, superseded operation, and
  owner restart are all `unknown`; no memory restart or owner recover converts
  unknown to current/cancelled/confirmed.
- `session.create` success result is a closed `SessionCreateResult` carrying
  real `sessionId/title/directory/time` and no model/config commitment.

The probes checked the design for:

- `session.create` limited to `kind, agentId, title`, with no model/binding member;
- U2 `providerInstanceId/modelId` mapping through effective compiled target to `session.prompt.body.model`, with explicit fail-before-dispatch behavior;
- preserved arbitrary `JsonValue` transport and a named adapter-only decoder with real callers;
- kind/state discriminated event variants and explicit unsupported/lossy boundaries;
- cancel `baseAccepted`/reconciliation/unknown detail for abort=false and abort=true/no-final;
- expected adapter errors caught inside the `ManagedConfigOwner.use` callback, with `current` readiness retained and no mutex claim;
- five readiness states and correct owner separation for `STALE_GENERATION` and config conflicts;
- BB10/BB12 requiring real inference and real side effects after product implementation.

## Scope

Changed paths only:

```text
docs/design/teams-session-delivery.md
docs/evidence/u6-session-design-20261003/notes.md
docs/evidence/u6-session-design-20261003/validation.md
```

No product code, tests, maps, graph JSON, goals, package/lock, governance,
memory, shared config, credentials or global resources were changed. No
product build/test/install/daemon/inference was run. No review was run, and
this candidate is not declared fixed or implemented.

## Remaining Product Dependencies

- U2 must freeze the per-Agent provider/model binding and accepted/effective
  readback; U6 only consumes the effective target.
- U4/U5 must release the shared `agent-process.ts`/Console runtime seam before
  U6 implementation writes there.
- U7 must implement `scripts/blackbox-user-mvp.mjs`; BB10 and BB12 are pending
  product blackboxes requiring real inference, tool side effects and permission
  approval/rejection.
- Implementation must add `decodeOpenCodeSessionMessage`, owner readiness,
  effective model target propagation, event projection and cancel detail
  handling; none of those symbols currently exist in product source.

## Result

`DESIGN-ONLY / UNVERIFIED`. The design candidate incorporates the seven r1
ownership corrections and records exact design-time evidence. Product Session
wiring, installed blackboxes and independent review remain outside this task.

Primary 接手修订：作者的设计 hash 仅绑定其 r2 输出。组合 4fc38a4 后新增共享 U2 recover 消费边，当前 exact candidate 由 Git staged tree 绑定；旧 hash 不作为新候选的 review 身份。修订仅涉及设计/notes/本文件；Markdown、diff/cached-diff、Session 静态图及 recover/uncertain owner 定向检查为适用验证，产品 build/inference/BB10/12 仍未执行。

Primary r2正式FAIL后三项修订：组合最新main c3aa36f，补完整Agent管理投影字段、abort acceptance true/false/absent语义和八类SDK part显式保真投影。新候选需重新进行三文档针对性检查及独立r3设计审查；之前r2 FAIL不是准入。精确身份以新的staged tree为准，不复用旧hash称新审查已通过。产品测试/安装/真实推理仍未执行。

## r3 correction result

`DESIGN-ONLY / UNVERIFIED`. This pass corrected the three r3 P1/P2 findings
(offline directory row discriminated observation, cancel causality with
per-session single active prompt operation ownership, and closed
`SessionCreateResult`) in the three allowed documents. The candidate is left
uncommitted for primary independent r4 review. No product implementation,
graph, map, goal, build, daemon, install, inference, or BB10/BB12 execution was
performed. The temporary SDK extraction `/tmp/u6-sdk-r4.p6EHJO` is removed
after validation.

## Primary r5 findings correction (current)

The current three-document revision corrects: historical/current input labels;
passive runtime false/not-applicable with no fabricated owner/effective facts;
optional assistant binding while synchronous prompt remains in flight, using
the existing SDK messageID/parentID contract; retention until owned prompt
terminal/runtime termination; and complete subtask part preservation.

Read-only current SDK observation used the installed dependency of the separate
U2 worktree, version `1.18.23`, without modifying that author scope:
`opencode-adapter/node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts` defines
AssistantMessage.parentID, SessionPromptData.body.messageID and the subtask
Part fields. This confirms public type contracts, not runtime acceptance of
a chosen message identifier or product Session behavior. The latter remains
a required real SDK consumer test before product review.

Targeted diff/fence/relative-link and existing B5 topology checks bind the
candidate in the external receipt named above. No build/install/inference or
BB10/BB12 product result is claimed. The five existing independent rounds all
ended in code_failure; this revision has not started an additional reviewer
or bypassed that review limit. U6 implementation and merge remain pending.
