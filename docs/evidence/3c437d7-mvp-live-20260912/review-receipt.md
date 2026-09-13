# 3c437d7 exact review receipt

- Review task: `3c437d7-exact-codex-review-20260912`
- Backend: independent Codex read-only review
- Candidate: `20f26837e85b92240002c324b70c45463be183fc`
- Base: `68aacf79d0db36f2c2e3a963c2b51b0bcb00443a`
- Scope: current-candidate public Relay/NAT replay, Console-offline replay, cleanup, and project-memory binding

The first exact review returned one P1 finding. The runtime and live replay
claims were not rejected; the failure was evidence durability. The L2 memory
record referenced the deleted integration worktree review path
`playground/3c437d7-mvp-live-20260912-integration/.agent-collab/review/3c437d7-mvp-live-20260912-integration-review/review.final.md`,
which was absent from the candidate tree and current workspace.

Raw controller result:

```json
{"contract_version":"1","scope":{"mode":"commit","commit":"20f26837e85b92240002c324b70c45463be183fc","base":"68aacf79d0db36f2c2e3a963c2b51b0bcb00443a"},"finding":{"severity":"P1","file":"memory/L2/agentteams-3c437d7-mvp-live-20260912.md","line":1,"rule":"Level 2 memory must have durable evidence-backed review; evidence bindings must remain verifiable","remediation":"Retain the exact review result in a durable tracked evidence receipt, or reference an existing committed review receipt and exact candidate/integration SHAs."}}
```

This receipt is the durable owner for the finding. The memory record must be
rebound to this tracked receipt before a replacement exact review and Level 2
promotion. No live replay claim is promoted by this failed review.
