# Validation R2 receipt

- `git diff --check`: passed.
- `appsdk guide compile`: passed (`contract_bound`).
- `appsdk verify`: passed (`stage=contract_bound`).
- `project-memory verify`: passed (`project` scope 65/65, source consistent).
- `appsdk compile`: attempted and stopped before source compilation because the clean worktree
  lacks installed dependencies (`tsdown: command not found`); this remains an environment limit.
- Runtime tests, install, restart, and live replay are out of scope for this documentation and
  memory-only candidate.
