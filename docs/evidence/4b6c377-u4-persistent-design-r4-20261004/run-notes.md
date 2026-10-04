# 4b6c377 u4-persistent-design-r4-20261004

## Source and candidate binding

- Worktree: `/Volumes/Intel/playground/agentteams/u4-persistent-design-r4-20261004`
- Branch: `codex/u4-persistent-design-r4-20261004`
- HEAD/base: `07006d69f574fe23dbf2df517d51e15429dd82a1`
- Inherited staged-input index tree before r4 edits: `1ff991c9aa33f805fe9dc3df310469646e096ed8`
- Candidate product index tree after r4 corrections, before this evidence note:
  `994efc2b30d70ee3ad0e237fedeaed2e6a7c8810`
- Final handoff index tree including this note is reported in the final handoff
  after the note is staged; this avoids a self-referential hash field.
- Corrected-file blob hashes:
  - `docs/design/teams-local-work-entry-v1.md` `f7af100a45452af17f5b538103120c84b62cdd9b`
  - `docs/design/teams-behavior-contracts.md` `5b15f2869d1cf29267ef3402ee28cdcd5b12d863`
  - `docs/architecture/resource-map.json` `21067fc5adf93023b67bccfa37736e4eec75f860`
  - `docs/architecture/mainline-call-map.json` `272049b3aed03ac2e350c6643315a9bbea32ef95`

## Task-owned changes vs inherited staged input

Inherited staged input retained without task edits:

- `docs/architecture/function-map.json`
- `docs/architecture/verification-map.json`
- `docs/design/dagpipe/graphs/work-open.graph.json`
- `docs/design/dagpipe/graphs/work-request.graph.json`
- `docs/design/dagpipe/graphs/work-close.graph.json`
- `docs/evidence/4b6c377-u4-persistent-design-20261004/run-notes.md`
- `docs/evidence/4b6c377-u4-persistent-design-r3-20261004/run-notes.md`

Task-owned r4 corrections:

- `docs/design/teams-local-work-entry-v1.md`
- `docs/design/teams-behavior-contracts.md`
- `docs/architecture/resource-map.json`
- `docs/architecture/mainline-call-map.json`
- `docs/evidence/4b6c377-u4-persistent-design-r4-20261004/run-notes.md`

## Corrected P1s

1. Persistent open/request/close now use capability-level Work with an explicit
   PENDING `AgentWorkClient.findProvider` `serviceSelection` contract. Capability
   selection matches provider capability declarations only, runs before Endpoint
   admission, returns an `AgentWorkTarget` without Endpoint, and has no fallback.
   One-shot/query keep their existing Endpoint-capable baseline and fixed operation.
2. Every planned browser open/request command, including capacity and stale-generation
   cases, explicitly passes both `browser-context` and `browser-slot` demands. Omission
   is valid only for capabilities with no declared resources; otherwise owning
   admission fails explicitly. Close has no request demands.
3. `resource-map.json` now names all five design graph artifacts and distinguishes
   the one-shot/query baseline from the three new design-only persistent graphs.
   `mainline-call-map.json` now has three design-only open/request/close chains and
   implementation allowlists covering `runtime/agent-work-client.ts` and its spec.
   `teams-behavior-contracts.md` now records the five graph lifecycles, held-work
   receipt fields, capability binding, request-without-propose, generation
   preservation, demands, unknown/unconfirmed handling, and close/dispose owner
   boundaries while marking the new operators/contracts unimplemented.

## Static checks

- `jq empty docs/architecture/resource-map.json`: PASS
- `jq empty docs/architecture/mainline-call-map.json`: PASS
- `git diff --cached --check`: PASS
- Markdown fences: `teams-local-work-entry-v1.md` has 20 fence lines (balanced);
  `teams-behavior-contracts.md` has no fenced block.
- Markdown relative links: `teams-behavior-model.md` and
  `../goals/teams-user-delivery-plan.md` both resolve; PASS.
- `dagpipe graph validate docs/design/dagpipe/graphs/agent-work.graph.json`: PASS
- `dagpipe graph validate docs/design/dagpipe/graphs/work-open.graph.json`: PASS
- `dagpipe graph validate docs/design/dagpipe/graphs/work-request.graph.json`: PASS
- `dagpipe graph validate docs/design/dagpipe/graphs/work-close.graph.json`: PASS
- `dagpipe graph validate docs/design/dagpipe/graphs/work-query.graph.json`: PASS

These are static design checks only. No SDK compile, runtime execution, install,
restart, OTA, or BB PASS is claimed.

## Remaining implementation obligations

- Add the PENDING typed `serviceSelection` capability/endpoint contract to
  `runtime/agent-work-client.ts` and `runtime/agent-work-client.spec.ts`.
- Add typed host/runner control fields and receipt fields for the persistent
  open/request/close graphs, including immutable provider/generation/capability/version
  binding, per-request operation/demands, captured open operation for close, and
  held-work delivery/closure states.
- Register `teams.return-held-work`, `teams.continue-provider-work`, and
  `teams.close-provider-work`; ship and fingerprint all five graphs in the runner
  manifest.
- Wire CLI/launcher/receiver graph selection and test open retention,
  request-without-propose, close/dispose, stale generation, unconfirmed delivery,
  and browser demand admission.
- Do not change `agent/work-resource.ts` or WorkHost ledger algorithms for this
  correction.
