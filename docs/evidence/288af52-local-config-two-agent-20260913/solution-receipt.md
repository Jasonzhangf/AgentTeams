# Solution receipt: 288af52

- Root cause: the local launcher had no persisted v2 endpoint role/config contract or durable internal lifecycle state, so a receiver could not be bootstrapped from a machine-owned config and replay a provider Work through the local bridge.
- Resolution: `config.toml` now owns user endpoint intent and provider/receiver roles; generated endpoint JSON is derived under `.internal/endpoints`; `internal.toml` atomically records PID, generation, and lifecycle state. Receiver startup performs explicit provider discovery, Work propose/request/result/close, and disposal.
- Payload safety: JSON values are validated before TOML materialization and at the direct agent endpoint parser; lossy TOML Date coercion is rejected explicitly.
- Candidate commits: `c04b0a0`, `0bda03f`; exact review `288af52-exact-review-r7` PASS with no findings.
- Integration receipt: `63bf25b`; integration focused 33 tests, regression 455 tests, typecheck, runtime build, compiled replay, AppSDK compile/verify all passed.
- Mainline and push: `main` fast-forwarded and remote `origin/main` is `887b439549bd4e8cc86ade4fa557bfca88ffdf51`.
- Machine receipt: `/Users/fanzhang/.agentteams` persisted config, started two compiled daemons, completed one local bridge Work, and stopped both daemons with `internal.toml` showing `stopped`.
- Cleanup receipt: candidate/integration worktrees and branches removed; root main is the only worktree and clean.

Remaining boundary: this issue closes the local bridge profile only. Public Relay, NAT/STUN, mobile, and multi-machine deployment are not claimed by this receipt.
