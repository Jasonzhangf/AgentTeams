# N3-D4-B direct admission contract receipt

- issue: `8ea5f7c` (`[N3 P1] Direct transport and network resilience audit`)
- delivery unit: N3-D4-B typed direct peer admission/source identity
- candidate commit: `ddfc4777ffe7a36b44b2e4bd7f817498931cf683`
- candidate base: `655a931421c9044a2c3d71c2f689df62ad534152`
- integration commit: `040c02025e8ce06da6bd2a470c79abf473f27441`
- owner: Desktop primary integration owner
- allowed source paths: `control-protocol/frames.ts`, `network/direct-listener.ts`, `network/direct-route.ts`, `network/peer-route.ts`, `network/target-transport.ts`, `runtime/process-config.ts`, `runtime/agent-process.ts`, and their tests

## Change

`transport.hello` now carries a typed source `AuthenticatedAgent` and opaque `admissionRef`. Direct WSS listener admissions bind local credentials to one peer, reject duplicate credentials/peers, verify target identity and generation, and expose the authenticated peer to the runtime. Runtime config supports peer-specific credential references; legacy shared credential mode is limited to one allowed consumer. Credentials remain local and are absent from declarations, route publication and business payload.

## Verification

- focused direct admission/network/runtime tests: passed
- `pnpm test`: passed, 71 files / 413 tests
- `pnpm typecheck`: passed
- `pnpm build`: passed
- `appsdk compile`: passed, artifact hash `sha256:c92cb1d7e297a3ec6db5655dad50be8b4031446aae7916da86aca6b468252bdb`
- `appsdk verify`: passed, `stage=contract_bound`
- exact Codex review: PASS, task `d4b-direct-admission-exact-20260911-r4`
- review evidence: `.agent-collab/review/d4b-direct-admission-exact-20260911-r4/review.final.md`

## Scope boundary

This unit freezes the direct admission contract and provider listener boundary. Consumer runtime `connectPeerRoute()` wiring, directory-published admission references, direct-vs-relay route selection, NAT traversal, and real public/NAT/relay replay remain the next delivery units; this receipt does not claim those gates.
