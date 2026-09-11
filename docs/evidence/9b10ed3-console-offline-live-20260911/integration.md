# Console-offline integration receipt

- delivery unit: `9b10ed3-console-offline-live-20260911`
- candidate base: `8e743aec4c86dcb8053f6532c6b452e20ccb0407`
- integrated candidate: `a78082c1b3e1fe7c2e513e411da2aa65ad752855`
- integration worktree: `playground/9b10ed3-console-offline-integration-20260911`
- integration mode: fast-forward from the clean `main` at the declared base
- integrated paths: `docs/evidence/9b10ed3-console-offline-live-20260911/**`

The exact candidate passed the independent review and the integration worktree
`pnpm verify` before the fast-forward. The integrated tree had no whitespace
errors (`git diff --check`). The runtime evidence remains loopback TLS only;
public Relay, NAT, direct transport, mobile and production deployment remain
separate acceptance gates.
