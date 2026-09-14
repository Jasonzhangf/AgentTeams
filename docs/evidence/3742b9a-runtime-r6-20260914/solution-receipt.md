# Solution Receipt: 3742b9a Runtime R6

- delivery unit: `3742b9a`
- user contract: persist local launcher and configured Work state in
  `internal.toml`; preserve `config.toml` intent; support detached
  `start/status/stop/work`, generation and start-token isolation, failed and
  orphan recovery, and restart-safe Work receipts.
- root cause: launcher lifecycle state and supervisor identity were not durably
  synchronized across startup, timeout, restart, and recovery windows.
- fix commits: `74045cc`, `534b0cc`, `b4cce4a`, `954afa4`,
  `f664484fe73f20eb0db24eadc79de486009de66d`
- exact review: `20260914T043000Z-review-r6-final-commit`, PASS, findings empty
- integration commit: `5eb568abc39a8c7ce5b277e3c99010ecdcea5824`
- remote main SHA: `5eb568abc39a8c7ce5b277e3c99010ecdcea5824`
- candidate and integration artifact: `sha256:edc5a828bbf0b0abced7eda52103742a4e56d59ab44ebe3754a01d6f24ece3b9`

Validation completed on the integrated source before push:

- `pnpm verify`: 77 suites, 468 tests; typecheck, build, AppSDK compile/verify,
  and packaged smoke passed.
- `pnpm smoke:installed`: isolated install, compiled Relay and Agent startup,
  Agent restart with generation change, local TOML launcher, and signal
  shutdown passed.

The evidence proves local installed runtime behavior only. It does not prove
public Relay, NAT/STUN, mobile, or cross-device acceptance.
