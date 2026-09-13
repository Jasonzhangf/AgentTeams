# Validation receipt

- `git diff --check`: PASS
- `appsdk guide compile`: PASS (`stage=contract_bound`)
- `appsdk verify`: PASS (`project_id=agentteams`)
- candidate identity: `fingerprint.txt` binds base commit/tree, staged candidate tree, source diff
  SHA-256, changed source paths and capture time; raw command output is retained beside this receipt.
- tool identity: `tool-versions.txt`; AppSDK manifest and project contract digests are retained in
  `appsdk-guide-compile.txt`.
- raw gate receipts: `appsdk-guide-compile.txt`, `appsdk-verify.txt`.
- `project-memory verify`: not applicable to this documentation candidate; the fresh linked worktree
  had no materialized project index (`status=missing`, `source_consistent=false`) and no memory was
  changed or claimed.
- scope check: PASS; only the three goal documents and this evidence directory are changed.
- runtime/build/entrypoint checks: not applicable; no runtime or product source changed.
