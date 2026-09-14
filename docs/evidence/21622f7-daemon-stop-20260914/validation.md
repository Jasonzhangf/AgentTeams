# Validation receipt

The exact integrated candidate passed:

```text
pnpm exec vitest run runtime/local-config.spec.ts runtime/local-process.spec.ts runtime/local-supervisor.spec.ts runtime/local-two-agent.spec.ts cli/agentteams.spec.ts
5 files passed, 38 tests passed

pnpm test
78 test files passed, 483 tests passed

pnpm typecheck
passed

appsdk compile
passed; module_id=teams-source; stage=source_implemented

appsdk verify
passed; stage=contract_bound; development_ready=true

git diff --check
passed
```

The focused lifecycle test was rerun directly on the candidate after the worker completed, and
again in the clean integration worktree. The compiled replay attempted with `TEAMS_LOCAL_REPLAY=compiled`
returned `START_TIMEOUT` in both candidate and baseline; it is retained as an environment/runtime
artifact limitation and is not attributed to this change.
