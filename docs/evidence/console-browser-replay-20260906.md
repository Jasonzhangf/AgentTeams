# Console daemon-backed browser replay

Candidate: uncommitted `codex/console-integration-20260906`, based on main `3b30dfe`.
This is partial integration evidence, AI-reviewed and human-unreviewed.

Built with `pnpm build` (`playground/console-live-build.log`). The primary launched
compiled Relay and separate compiled Agent/Console child processes using
`playground/console-live.mjs`. Relay traffic used TLS; this browser replay used
loopback HTTP with test-only Basic credentials. Separate runtime tests cover HTTPS;
this replay does not prove browser HTTPS, public NAT or a physical phone.

Observed through Camo profile `teams-console-live-20260906`:

- Desktop 1440×960 rendered one actual Agent, `AgentBrowser · 实际 daemon`, online,
  with daemon-published `browser` and `file-search` capabilities.
- Agent details opened by a real click and showed the same machine and capabilities.
- At 390×844, document scroll width was 390. Details and configuration were operable.
- Passive Agent configuration had no projected config; no effective provider/model
  was fabricated. Actual model/session execution remains outside this evidence.

Screenshots and text are retained in the current worktree's `playground/`:
`console-live-desktop.png`, `console-live-mobile-detail.png`,
`console-live-mobile-config.png`, `console-live-config-text.json`.

An initial URL containing Basic credentials loaded the page but Firefox refused
relative fetch with embedded URL credentials. Navigating to the clean origin after
authentication allowed actual API projection. This does not prove a manually entered
browser authentication-dialog flow; no product bypass was added.

Open UI findings: English technical implementation copy remains in Chinese mode;
narrow header wraps poorly; passive Agent cards show irrelevant model/session labels.
The selected icon is packaged but not yet bound to the card. These are unresolved
product work, not a completed UI acceptance claim.

Resource closure: Console PID 23444, Agent PID 23425, launcher PID 23400 exited;
exact-PID inspection returned no running processes. Camo reported this profile stopped.
Shared daemon PID 74038 remained running. The named browser profile data, test config,
test certificate and screenshots are retained for this stage's evidence archive and
must be considered during final cleanup. No other profile was stopped.
