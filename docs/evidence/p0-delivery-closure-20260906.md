# P0 delivery and retained evidence receipt

Primary factual review: AI-reviewed, human-unreviewed. This records delivery
and resource closure, not additional product runtime acceptance.

- PR #5 merged at `7d171e8c4b61f42d01bd32065baa576f321e663f`.
- PR #6 merged at `364ceec10ec03b6d652b820ffdb8fbf0bdf9967c` from
  `a8d9fa20522aca06086eb4ab6d3086e0112093c1`.
- PR #6 merge and reviewed candidate share tree
  `385198d416b515b55a957006b9bae37f463b7002`. Main was fast-forwarded,
  remained clean, and `appsdk verify` passed. The candidate's 143-test and
  AGY `agentteams-p0-session-20260906-r1` pass evidence remains applicable.

The following primary-owned worktrees were normally removed after preserving
evidence and verifying no unique commits or unpreserved tracked work. Current
`git worktree list --porcelain` confirms they are absent. Archive paths are
relative to the main checkout, not this integration worktree:

| Removed worktree | Retained archive | SHA256 |
| --- | --- | --- |
| `playground/daemon-main-20260906` | `playground/evidence-archive/p0-payload-20260906/retained-evidence.tgz` | `087c6197a27a91b5cf130777b152306a27c5f013e8aa2a3efbf0c0a30be8e289` |
| `playground/sdk-refresh-20260906` | `playground/evidence-archive/sdk-refresh-20260906/retained-evidence.tgz` | `84d336235d34d6d1b12228262086941aa6d997f80e21e746f5c90c52e2af2214` |
| `playground/p0-session-20260906` | `playground/evidence-archive/p0-session-20260906/retained-evidence.tgz` | `a7ee63d4125d874d5c6fcccaa5b38521c57dbd71adae849f024db3bda0dc8f83` |

For the Session tree, only untracked `.agent-collab/` remained; it and ignored
playground evidence were archived, and the original review directory was moved
alongside the archive before normal worktree removal. The exact-path process
check showed only its own inspection commands. No process was killed and no
force removal was used. Evidence archives remain primary-owned for audit.

N2 integration and the three Luna implementation trees remain open. Other
historical or app-bound trees were not removed in this operation. Real daemon
binding, public relay, provider inference and desktop/mobile acceptance remain
pending. Project memory promotion of this receipt does not change that scope.
