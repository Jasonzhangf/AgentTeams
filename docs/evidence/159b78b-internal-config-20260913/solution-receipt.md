# Solution receipt: 159b78b

- Root cause: the v2 compiler moved relay JSON into `.internal/projections` while preserving
  relative TLS paths, and trusted projection paths from internal.toml without confinement.
- Fix: resolve relay TLS key/cert paths against the original relay JSON directory; confine relay and
  daemon projections to the exact runtime-owned `.internal/projections` paths; retain internal.toml
  as the sole non-user runtime source and preserve lifecycle state on same-revision reload.
- Verification: worker focused/replay evidence, integration 20-test focused gate, 458-test mapped
  regression, typecheck/build, AppSDK compile/verify and Codex Review PASS are recorded above.
- Remaining boundary: stale derived projection cleanup is separate issue `b17014d`; public Relay,
  NAT/STUN, mobile and multi-machine support remain post-MVP.
