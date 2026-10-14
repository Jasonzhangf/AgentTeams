# L8 increment receipt: the initiator channel-open primitive (D00 amendment A3 consumed)

- Task: deliver the initiator side of the Teams ACP channel handshake. The A3
  amendment published the responder's live engine instance on
  `teams.connection.context`, but no code consumed it: `network/teams-ingress.ts`
  stayed the responder composer and nothing in production ever sent `acp.open`.
- Base: `main == origin/main == bbbf678`.
- Worktree: `/Volumes/Intel/playground/agentteams/acp-l8-write-side-20261013`
- Branch: `codex/acp-l8-write-side-20261013`
- Changed files in this increment (7):
  `network/teams-session.ts`, `network/teams-session.spec.ts`,
  `docs/architecture/function-map.json`,
  `docs/architecture/mainline-call-map.json`,
  `docs/architecture/verification-map.json`,
  `docs/design/teams-acp-daemon-config-v4.md`,
  `docs/development-governance.md`.
- Untouched and still responder-only: `network/teams-ingress.ts`,
  `runtime/acp-daemon.ts`, `runtime/control-process.ts`, `console-host/**`,
  `ui/teams-console/**`, `control-protocol/**`.

Every surface below is reported separately. A later surface is never inferred
from an earlier one.

## 1. Source surface (delivered)

`createTeamsSession` now exposes `open(input?: TeamsSessionOpenInput)` and
`TeamsSessionOpenInput`. The initiator opens exactly one outbound ACP channel:

1. It refuses a non-initiator session with `CONFLICT` (`only the initiator opens a
   channel; the responder waits for acp.open`), refuses `open` after `run()` owns
   the transport with `CONFLICT`, and refuses a closed session.
2. It refuses an agreement that published no `targetEngineInstanceId` or no
   positive `targetGeneration` with `INVALID_ACP_FRAME`, instead of guessing a
   value. This is the A3 fact and there is no second source for it.
3. It builds **two** refs, because the two boundaries demand different facts:
   - the **host-facing** ref carries this side's own `targetGeneration` and
     `engineInstanceId`, because `AcpHost.open` refuses anything else with
     `STALE_GENERATION` (`agent-host/acp-host.ts:967`);
   - the **wire** ref carries the responder's `targetGeneration` and
     `engineInstanceId` from the agreed context, because that is the pair the
     responder validates and keys by. `connectionId`/`channelId` stay this side's
     own transport-scoped correlation keys on both refs (R2).
4. It calls `host.open`, then sends `acp.open` with the wire ref, then waits for
   exactly one frame: the `acp.open_ack` (adopted as the peer ref), a matching
   `acp.error` (re-thrown with its own fault), or nothing.
5. Every failure path releases the local host channel through `host.close` before
   it throws, so a channel the peer never acknowledged cannot stay open.
6. A deadline reports `RESULT_UNKNOWN` (`the peer did not acknowledge acp.open`),
   which is the convention `timeoutTeamsNegotiation` already uses. No fault code
   was added to the frozen `AcpFaultCode` union.

Supporting change: `ChannelRecord` gained `outboundRef`, distinct from the
host-facing `localRef`. Outbound `acp.frame`, the relayed RPC error envelope and
`acp.close` now use `outboundRef`; `host.open`/`host.read`/`host.receive`/
`host.close` keep `localRef`. For the responder the two refs are the same object
value, so the responder wire behaviour is unchanged.

`receiveFrame` freshness is now judged against the stored `peerRef` instead of the
local constants. This is the same rule on both sides: the responder compares
against its own pair (its stored `peerRef` came from the peer and equals its own),
the initiator compares against the target's pair. The responder path is
byte-identical; the initiator path was broken before, because it would have
rejected every legitimate inbound frame from the responder.

`receive` now refuses an inbound `acp.open` on an initiator session with
`INVALID_ACP_FRAME`. The pre-existing `default:` refusal for an unsolicited
`acp.open_ack` on the responder read path is untouched and still covered.

## 2. Test surface (delivered)

`network/teams-session.spec.ts` grew from 13 to 26 tests. Thirteen are new:

| Test | Failure mode it catches |
| --- | --- |
| names the responder engine instance on acp.open and keeps the host ref on this side | the wire ref names this side's engine instead of the target's |
| maps an inbound acp.frame addressed to the ack ref onto the local ref before the host sees it | the peer wire key leaks into `host.receive` |
| refuses an ack that names a different engine instance and releases the local host channel | a mismatched ack is accepted, or the local channel leaks |
| refuses to open when the agreed context published no engine instance | a missing A3 fact is guessed instead of refused |
| fails the pending open on a matching acp.error and releases the local host channel | a peer refusal is swallowed |
| refuses an unexpected frame before the ack instead of skipping it | the handshake silently skips a protocol violation |
| refuses to open on the responder side, which never initiates a channel | the responder is turned into an initiator |
| refuses an inbound acp.open on an initiator session | an initiator is downgraded into a responder |
| still refuses an unsolicited acp.open_ack on the responder read path | the pre-existing guard is weakened |
| reports an unknown outcome when the peer never acknowledges and releases the local host channel | a deadline is reported as a definite failure, or the channel leaks |
| completes a real two-sided open against a responder session | the wire contract does not interoperate with the real responder |

The last test is the strongest one. It builds a real initiator session and a real
responder session, cross-wires their transports, starts the responder's real read
loop, and lets the real handshake run: the responder's own `openChannel` validates
the wire ref, the real `AcpHost` opens on both sides, and the ack is adopted. It
also asserts each host saw only its own `connectionId`.

Independent review of commit `4945be8` found one FAIL-level defect: after
`host.open` succeeded, a transport failure while sending `acp.open` (or while
reading its single answer) escaped without releasing the local host channel,
because `refuse()` only ran on the typed handshake branches. Two replacement
tests reproduce it (`releases the local host channel when the read rejects before
the ack`, `... when the transport refuses to send acp.open`) and both were red
before the fix. The fix wraps the send-and-race in `try/catch/finally`, uses a
`released` flag so a typed refusal is not double-released, preserves the original
transport error identity, and clears the deadline timer on every path. Mutation
verification: removing the outer release fails exactly those two tests.

The gate count therefore moved from 77 to 90 (thirteen new session tests).

Red state was proven before implementation: 8 of the first-round tests failed
with `session.open` absent.

## 3. Mutation verification (delivered)

Two mutations were applied to `network/teams-session.ts`, run, and reverted. The
file was restored byte-for-byte (`diff -q` clean) and the suite returned to 24/24.

| Mutation | Result |
| --- | --- |
| the wire ref names this side's `engineInstanceId` instead of the target's | 2 failed: `names the responder engine instance...`, `completes a real two-sided open...` |
| the ack `engineInstanceId` check is deleted | 1 failed: `refuses an ack that names a different engine instance...` |

Both mutations are caught by the tests written for them, and no unrelated test
failed.

## 4. Gate surface (delivered on this candidate)

| Gate | Command | Result |
| --- | --- | --- |
| `teams-acp-d05-network` | the map's declared 9-file command | **90/90**, exit 0 |
| `teams-acp-d06-control` | the map's declared 6-file command | **118/118**, exit 0 |
| `pnpm typecheck` | `tsc -p tsconfig.json --noEmit` | exit 0 |
| `pnpm build` | `tsc -p tsconfig.runtime.json` plus the web build | exit 0 |

The D05 count moved from 77 to 90 (thirteen new session tests, two of which are
the independent-review release tests). The D06 gate is unchanged at 118/118,
which is the point: this increment touches no control-plane surface.

## 5. Not delivered, and not inferred

- **No production initiator.** *(SUPERSEDED 2026-10-13/14; see the correction below.)*
  `network/teams-ingress.ts` is still the responder composer and never sends `acp.open`.
  No daemon composed an initiator when this note was written, so there was no egress path
  from a real process.
  - 2026-10-14 更正（L9 command side）：这条已经不再成立。`runtime/acp-serve.ts` 现在通过
    `runtime/serve-egress.ts` 组合 egress，并对已接受的 `peers` 拨出 initiator 通道；
    真实入口证据见 `docs/evidence/acp-l9-command-side-20261013/`。仍然成立的部分：本单元
    没有 installed-copy、restart、deployed-entrypoint 或跨设备证据。
- **No control-plane write side.** `runtime/control-process.ts` still hardcodes
  `sessions: []`, `notifications: []`, `configs: []` in its projection, still
  passes no `owner` to `createControlOwner`, and still answers
  `connection.connect`/`connection.disconnect`/`network.membership.apply` with a
  typed `UNSUPPORTED_OPERATION`. `TeamsStatusPort` remains read-only.
  - 2026-10-14 更正（L9 intent-side）：这条已经不再成立。三条 A2.4 关系命令现在经
    `config/relations-intent-store.ts` 做一次 CAS 写入；目标不可解析时是 typed `FORBIDDEN`。
    `TeamsStatusPort` 仍是只读，控制 daemon 仍只写记录、不拨号。
- **No Session/permission/notification event stream** behind SSE.
- **No installed-artifact, restart, deployed-entrypoint, live-browser or
  cross-device evidence.** Nothing in this increment was run from an installed
  copy or through a browser.
- **Remote receipt: delivered.** Pushed `bbbf678..0f9c1d0` to `origin/main` and
  re-read the receipt with `git ls-remote origin main`:
  `0f9c1d0230d138cb9341d6a26f52fbe3a3a4eda5 refs/heads/main`. The receipt is
  recorded in section 7 below.
- **`pnpm verify` stays a recorded BLOCKED gate.** It fails at
  `scripts/regression.mjs` on a pre-existing load flake, unrelated to this change
  (proven on the pristine base `85df0a8`).
- All eleven `teams-acp-*` gates stay `partial`.

## 6. Environment

- node v22.22.2, pnpm 10.31.0.
- opencode 1.18.23 at `/Users/fanzhang/.opencode/bin/opencode`; dsh at
  `/opt/homebrew/bin/dsh`; Chrome at
  `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`.
- `TEAMS_CONSOLE_REAL_DOM=1` is set by the regression script, not by this
  increment's gate commands.

## 7. Remote receipt, integration and cleanup

- Push: `git push origin HEAD:main` returned `bbbf678..0f9c1d0  HEAD -> main`.
- Receipt, re-read after the push with `git ls-remote origin main`:
  `0f9c1d0230d138cb9341d6a26f52fbe3a3a4eda5	refs/heads/main`. The remote head
  equals the candidate head, and both commits (`4945be8`, `0f9c1d0`) are audited
  on the remote.
- Integration precondition, restated as evidence: the independent review of
  `4945be8` raised one FAIL (an unreleased host channel after a transport failure),
  it was fixed by `0f9c1d0`, and the independent re-verification returned PASS on
  `0f9c1d0`: D05 90/90, D06 118/118, `pnpm typecheck` exit 0, `pnpm build` exit 0,
  plus its own mutation run (removing the outer release fails exactly the two new
  tests; the file was restored byte-identical). Without that PASS this push would
  not be authorized.
- Cleanup: this worktree is removed only after the receipt above and the
  retention copy under `docs/evidence/acp-l8-initiator-open-20261013/` exist. The
  reclamation is executed and recorded separately.
- Still partial: the eleven `teams-acp-*` gates, because no L9-L12 domain carries
  them. The counts in the three maps describe this candidate only.
