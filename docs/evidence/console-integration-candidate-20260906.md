# Console integration candidate

Primary-reviewed facts; AI-reviewed, human-unreviewed. Base: `3b30dfe`.

The independent Console now uses authenticated HTTP/HTTPS and relay management
requests to Agent owners. Passive Agent management authorization is distinct from
Work authorization. Old direct OpenCode forwarding and Console-owned relation/message
state are removed. AgentBrowser's original icon is packaged, not yet rendered.

Verified in this candidate worktree:

- `playground/console-legacy-regression.log`: 53 files, 304 tests passed, no skips.
- `playground/console-legacy-typecheck.log`, `console-legacy-build.log`: passed.
- `playground/console-final-guide.log`, `console-final-compile.log`,
  `console-final-smoke.log`, `console-final-verify.log`: passed; verify `contract_bound`.
- Actual Console child HTTPS authentication/shutdown and bind-failure cleanup:
  `console-process-green.log`, `console-runtime-green.log`.
- Compiled daemon-backed browser evidence: [replay receipt](console-browser-replay-20260906.md).
- Independent AGY task `agentteams-console-integration-20260906-r1` completed with
  controller verdict `pass`, `controller_no_blocking_findings`. Records are retained
  under `.agent-collab/review/agentteams-console-integration-20260906-r1/`.
- No unstaged tracked diff appeared after reviewer completion.

This candidate is source integration, not complete first-release acceptance.
Managed OpenCode apply/live providers, active crash recovery, relations, direct/public
network and physical-phone evidence remain pending. Browser UI findings remain in the
replay receipt. Git delivery and stage resource closure are pending at this record time;
do not infer either from tests or AGY PASS.
