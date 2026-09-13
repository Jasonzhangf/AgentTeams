# 3c437d7 evidence repair integration receipt

- Delivery unit: `3c437d7`
- Source candidate: `76ad86943a6911869c57877695b7805e0fcae1d5`
- Candidate exact review: `3c437d7-final-exact-review-20260912` (PASS)
- Integration base: `origin/main@b2bc4aa36e845e3243e8db3326c6a71cd0ea5fb7`
- Integration worktree: `playground/3c437d7-claw-public-nat-20260912-integration`
- Integrated commit before this receipt: `673d5cc`

The candidate was merged into a clean worktree created from the fetched
`origin/main`. The merge had no conflicts and changed only the tracked review
receipt plus the existing project-memory L2 evidence binding and its canonical
JSONL event.

Integration validation on the exact merged tree:

```text
project-memory index       PASS
project-memory verify      PASS (56 nodes, source_consistent=true)
git diff --check           PASS
pnpm install --frozen-lockfile PASS
pnpm verify                PASS (75 files / 447 tests; typecheck; AppSDK guide compile;
                             AppSDK compile; packaged Console/runtime smoke; appsdk verify)
```

The runtime and deployment inputs were unchanged; the public Relay/NAT/
Console-offline replay remains bound to the previously reviewed source and its
tracked receipts. This integration evidence does not claim provider catalog,
direct transport, NAT-to-NAT, mobile replay, or full MVP closure.

## Integration exact review

- Review task: `3c437d7-integration-review-20260912`
- Candidate reviewed: `6053f45a4edac69512b5b060460f1e9d11b68a8d`
- Base: `b2bc4aa36e845e3243e8db3326c6a71cd0ea5fb7`
- Controller result: **PASS**; no P0/P1 findings.

```json
{"contract_version":"1","scope":{"mode":"commit","commit":"6053f45a4edac69512b5b060460f1e9d11b68a8d","base":"b2bc4aa36e845e3243e8db3326c6a71cd0ea5fb7"},"module_boundary_evidence":[{"module":"Delivery evidence and project-memory promotion records","owner":"Primary integration owner under docs/development-governance.md; project-memory official CLI owns memory source/index synchronization","paths":"Changed paths are docs/evidence/3c437d7-mvp-live-20260912/integration-receipt-20260912.md, docs/evidence/3c437d7-mvp-live-20260912/review-receipt.md, memory/L2/agentteams-3c437d7-mvp-live-20260912.md, and memory/knowledge.jsonl. No runtime, test, dependency, configuration, architecture-map, or generated runtime paths changed.","edges":"Documentation-only evidence binding. The integration receipt records validation of the merged tree; the review receipt retains the historical failed review and durable replacement review; the L2 Markdown projection and corresponding JSONL event bind the replay memory record to the tracked review receipt. No executable call edge, Session path, or business-payload path is introduced.","resources":"The receipts identify the source candidate, integration base, exact review records, project-memory evidence, prior public Relay/NAT/Console-offline receipts, and explicitly open provider, direct transport, NAT-to-NAT, mobile, and full-MVP obligations. JSONL syntax and whitespace validation were checked; no runtime resource ownership is changed.","gates":"Applicable gates are documentation/evidence integrity and project-memory Level 2 promotion/verification. The recorded integration receipt reports project-memory index and verify PASS, git diff --check PASS, frozen install PASS, and pnpm verify PASS on the exact merged tree. Runtime, build, install, restart, and live replay are not newly applicable because this commit changes only evidence and memory records; the receipts do not claim closure of explicitly open MVP gates."}],"findings":[]}
```
