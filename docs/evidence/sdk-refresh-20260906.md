# SDK bundle refresh and delivery receipts

Base: `8f3cf1cc9ed1a5a096d4da3167f1a461d5443015` (PR #4 merge).
PR #4 has the same tree as reviewed source `506bfc88d5ec22e10c19c1c0990c53dc4b80860c`.
PR #3 delivery contract merged at `dba3dd6230c2c5e83a8b5d1f8e8fc99235e24609`.

During main verification on 2026-09-06, the installed AppSDK binary changed:
`/Users/fanzhang/.cargo/bin/appsdk`, mtime Sep 5 21:50 local, SHA256
`12340a4b052fe370bce983668c47c9abc2f4204bad9febeeed92b15daab78f48`.
Both main and the previously passing P0 worktree then reported
`SDK_BUNDLE_DIGEST_MISMATCH`; source content had not diverged.

In this isolated worktree, official `appsdk init .` refreshed only SDK-owned
memory documentation/Skill and resource/lock records. The generated incidental
gitignore blank line was removed. Official verify then passed. New bundle:
`sha256:ae7da56fa164e7e99284b4f63e56c059d2ee9d1fa427a8b0e86179718df1dc35`.
The lock preserves the previous bundle digest. No digest was manually changed,
no external project was modified, and no old governance evidence was fabricated.

Fresh frozen install and `pnpm verify` passed: 33 files / 142 tests, typechecks,
library builds, Guidance/AppSDK compile, compiled HTTP smoke and verify. Logs
are retained under `playground/evidence-archive/sdk-refresh-*.log` in the main
checkout. Primary factual review PASS; AI-reviewed, human-unreviewed.

The merged delivery-control-20260906 worktree had no unique commits or tracked
changes. All three review handles were completed. Process inspection found no
matching active task process. Original review evidence, generated artifacts and
local notes were archived before a normal, non-forced git worktree removal.
Archive: `playground/evidence-archive/delivery-control-20260906/retained-evidence.tgz`;
SHA256 `e8fe042dfbe174cccae964a449b79d41dfcabb5f6f96783460b0610e3f9e7045`.
This worktree is closed; the archive remains primary-owned for final evidence
consolidation. Other task worktrees are not declared closed.

N1/C1/W1 candidates remain unmerged, with concrete main-review corrections
returned to their owners. P0 explicit Session selection and N2 remain pending.
