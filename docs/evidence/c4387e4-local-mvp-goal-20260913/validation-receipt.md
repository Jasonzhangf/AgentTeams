# Validation receipt

- `git diff --check`: passed.
- `appsdk guide compile`: passed (`contract_bound`).
- `appsdk verify`: passed (advisory governance verification).
- `appsdk compile`: attempted; failed before source compilation because this clean worktree has no
  installed dependencies (`tsdown: command not found`). This documentation-only unit has no runtime
  build gate; the failure is retained as environment evidence.
- `project-memory verify`: attempted; this fresh worktree has no generated project memory index and
  reported `scope=project status=missing`. No memory claim is made from that result.
- No runtime, install, restart, or live replay gate applies to this documentation-only change.
