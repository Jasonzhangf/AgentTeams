# 3c437d7 exact review receipt

This receipt retains the failed review history for the evidence-repair delivery
unit. The earlier candidates attempted to bind a public Relay/NAT replay to an
L2 memory record whose review evidence was not durable. Those candidates are
not part of the corrected candidate diff.

## Historical r3 result

- Review task: `3c437d7-exact-codex-review-20260912-r3`
- Candidate reviewed: `2da31b34dce3fd1bba4c90df7fa88e132fdf04b3`
- Base: `9a2934c15999b5c14613e8496625a326664fc3ea`
- Controller result: **FAIL**, P1.
- The complete controller JSON is retained below; its referenced L2 and JSONL
  changes were reverted before the corrected candidate was created.

```json
{"contract_version":"1","scope":{"mode":"commit","commit":"2da31b34dce3fd1bba4c90df7fa88e132fdf04b3","base":"9a2934c15999b5c14613e8496625a326664fc3ea"},"module_boundary_evidence":[{"module":"Project memory Level 2 replay record","owner":"project-memory reviewed write-back and promotion flow; memory/L2 detail plus memory/knowledge.jsonl projection","paths":"Commit changes only memory/L2/agentteams-3c437d7-mvp-live-20260912.md and the corresponding appended L3/L2 events in memory/knowledge.jsonl. No runtime, test, dependency, or generated source paths changed.","edges":"The changed L2 metadata and latest JSONL events assert that the replay record is reviewed and bind review_evidence to docs/evidence/3c437d7-mvp-live-20260912/review-receipt.md. That receipt records the earlier exact review's P1 failure and explicitly requires a replacement exact review before promotion.","resources":"Canonical raw memory history is memory/knowledge.jsonl; the L2 Markdown detail is its human-readable projection. The tracked review receipt exists, but it is a failed-review receipt, not a replacement passing review receipt. No changed-file evidence records project-memory verify.","gates":"Project contract requires evidence-reviewed Level 2 updates and verified memory cleanup/acceptance. The commit supplies the prior failed review receipt as review_evidence but does not bind a replacement review result or project-memory verify evidence."}],"findings":[{"severity":"P1","file":"memory/L2/agentteams-3c437d7-mvp-live-20260912.md","line":1,"rule":"Level 2 memory must have durable evidence-backed review; evidence bindings must identify the applicable successful review","evidence":"The changed metadata sets review_status=reviewed and binds review_evidence to docs/evidence/3c437d7-mvp-live-20260912/review-receipt.md. That receipt's raw controller result is a P1 failure for the deleted-worktree evidence binding and states: \"This receipt is the durable owner for the finding\" and \"The memory record must be rebound to this tracked receipt before a replacement exact review and Level 2 promotion.\" It does not contain a replacement review result. The new Markdown body likewise says the record is reviewed, while the bound receipt only documents the failed prior review. The corresponding latest events at memory/knowledge.jsonl:99-100 repeat the same invalid reviewed binding.","remediation":"Run and retain a replacement exact review for commit 2da31b34dce3fd1bba4c90df7fa88e132fdf04b3, bind review_evidence to that exact durable passing result, and run/retain the required project-memory verify evidence before marking this L2 record reviewed."}]}
```

The corrected candidate retains the existing replay memory ID and repairs its
evidence binding through the official `project-memory promote` command. Its
effective metadata now points only to this tracked receipt; `project-memory
verify` passes with a consistent source digest.

## Durable replacement review

- Review task: `3c437d7-runtime-historical-review-20260912`
- Candidate reviewed: `03ca70cd511ec43db76eb9e7c91d9d809ca92991`
- Base: `76f3db91682cb9328cc3a377b9ba66cdc64757d0`
- Controller result: **PASS**; no P0/P1 findings.
- The complete controller JSON is retained below. This review covers the
  public Relay/NAT/Console-offline evidence receipt and cleanup evidence that
  the memory record summarizes; it explicitly leaves provider, direct,
  NAT-to-NAT, mobile, and full-MVP closure outside scope.

```json
{"contract_version":"1","scope":{"mode":"commit","commit":"03ca70cd511ec43db76eb9e7c91d9d809ca92991","base":"76f3db91682cb9328cc3a377b9ba66cdc64757d0"},"module_boundary_evidence":[{"module":"delivery-evidence-and-cleanup","owner":"primary integration owner under docs/development-governance.md","paths":"Only docs/evidence/3c437d7-mvp-live-20260912/receipt.md and cleanup-receipt.md changed; no runtime, test, configuration, map, dependency, or generated source paths changed.","edges":"Documentation-only amendment. receipt.md binds the previously validated source candidate 68aacf79d0db36f2c2e3a963c2b51b0bcb00443a to packaged runtime hashes and records public Relay, daemon Work, restart/generation, and Console-offline observations. No executable call edge is introduced.","resources":"The receipts identify owned Claw/coder2new replay processes, Console containers, staging and temporary trees, port 61991, the production Relay service, and the retained Claw rollback tree. Cleanup evidence records exact-PID/service-scoped handling and final absence checks; no unrelated resource is claimed as changed.","gates":"The receipt records pnpm install --frozen-lockfile, pnpm verify, artifact/package hashes, public Relay service active/enabled state, public TLS/NAT observations, cross-host Work, duplicate-request idempotency, RESOURCE_EXHAUSTED rejection, restart generation isolation, Console-offline Work, and cleanup. It explicitly leaves live RCC/goaichat-openai catalog/apply/readback, direct transport, NAT-to-NAT, mobile replay, and full MVP closure open."}],"findings":[]}
```
