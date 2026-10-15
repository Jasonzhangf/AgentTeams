# L10 owned-resource inventory and reclaim receipt

Date: 2026-10-15. Scope: every git worktree this ACP/LAN/WebUI delivery created under
`/Volumes/Intel/playground/agentteams/`. Owner: the L10 integration owner. All commands are
read-only inventory or `git worktree remove` + `git worktree prune` on the shared administrative
metadata; no source file of any tree and no branch was modified.

## 1. Four-way classification

`MISSING_DIR` — registered in the past, directory already gone.

1. `acp-d06-part2-20261011`, `acp-d07-webui-20261011`, `acp-l11-installed-browser-20261014` were
   already reclaimed in earlier rounds: absent from `git worktree list` and from the disk.

`RECYCLABLE_CLEAN` — git-clean, no live process, and every byte the tree holds is already in
`origin/main`. Removed this round.

2. `acp-d00-integration-20261010`, `acp-d00-worker-20261010`, `acp-d01-bind-20261010`,
   `acp-d01-worker-20261010`, `acp-d02-merge-20261010`, `acp-d02-serve-20261010`,
   `acp-d02-worker-20261010`, `acp-d03-bind-20261010`, `acp-d03-merge-20261010`,
   `acp-d03-serve-20261010`, `acp-d04-bind-20261010`, `acp-d05-network-20261010`,
   `acp-d06-control-20261011`, `acp-engines-20261010`, `acp-runtime-20261010`,
   `sdk-refresh-0.1.0013-20261009` — git-clean, `git log origin/main..HEAD` empty.
3. `acp-d03-worker-20261010`, `acp-d04-worker-20261010`, `acp-d09-discovery-projection-20261011` —
   git-clean, but each has one commit whose object is not reachable from `origin/main`. Their
   content is verified in main: the working tree equals HEAD, and every file in it is byte-equal to
   `origin/main`, so the branch commits add nothing main lacks. Removed this round.

19 worktrees removed; `git worktree prune` left no stale administrative entries.

`PROTECTED_HOLD` — the tree holds local content that `origin/main` does not contain. Not deleted;
removing them would need a per-file decision about whether the content is real work, a scratch
record or an obsolete copy of a delivered file, and that decision is not this unit's.

4. `acp-console-20261010` — 3 tracked files differ from main, 9 untracked files (all present in
   main by path).
5. `acp-core-20261010` — 6 tracked files differ from main (staged `acp-adapter/stdio.ts` and its
   spec among them).
6. `acp-daemon-network-20261010` — 10 tracked files differ from main, 2 untracked files whose paths
   are absent from main.
7. `acp-execution-plan-20261010` — 0 tracked differences, 12 untracked files absent from main
   (`docs/design/teams-acp-daemon-v1.md`, `docs/goals/teams-acp-network-*.md`).
8. `acp-host-20261010` — 0 tracked differences, 2 untracked files absent from main.
9. `acp-network-20261010` — 0 tracked differences, 2 untracked files absent from main.
10. `acp-ui-20261010` — 3 tracked files differ from main, 1 untracked file absent from main.
11. `acp-d05-closure-20261011` — 0 tracked differences, 5 untracked files absent from main, all
    under `.worker-runs/`.
12. `acp-d00-contract-20261010` — content verified fully present in main (0 tracked differences,
    0 untracked files absent from main), but the tree has one modified file, so `git worktree
    remove` refuses it and the rule does not allow a forced delete of a dirty tree.
13. `acp-intent-20261010` — content verified fully present in main, but 2 untracked files, so the
    same forced-delete question applies.

`EXTRACT_THEN_CLOSE` — the same set as `PROTECTED_HOLD`; each needs one per-file review that
decides extract-or-discard before removal. That review is a retained obligation, listed below.

## 2. Own tree

`acp-l10-session-projection-20261015` (this unit) stays until delivery, the remote receipt and
retention evidence exist, per the project contract.

## 3. Retained obligations after this round

- The 10 held trees above stay on disk and still registered. Each needs a per-file decision by
  their own unit owner; this unit has not touched their content.
- `acp-d00-contract-20261010` and `acp-intent-20261010` are content-clean and could be closed the
  moment a forced delete of a dirty tree is authorized.
- No branch was deleted. The 19 removed trees' branches still exist in the repository.