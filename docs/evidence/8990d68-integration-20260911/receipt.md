# 8990d68 integration receipt

- Issue: `8990d68` (`[E2 P1] Endpoint discovery and protocol admission`), remains open pending remote delivery and cleanup.
- Candidate: `7baf7f6073817cd04e66dc84b7898b7041f1254c`.
- Integration base: `ccedf1d69d8fe797aab35a167152ed4f5d5cddcb`.
- Integration tree before this receipt: `787ce3a`.
- Integration branch: `codex/integration-8990d68-20260911`.

## Scope

This is a read-only endpoint discovery/admission audit. It records the existing
typed Endpoint reference, scope filtering, relay Agent-identity admission,
Endpoint-to-Work call edge, and the verification-map omission of
`server/relay.spec.ts`. No production source or map implementation was added.

## Validation

- `vitest run control-protocol/endpoint-ref.spec.ts server/endpoint-discovery.spec.ts control-protocol/relay-codec.spec.ts` — 3 files / 13 tests passed on the exact integration tree.
- `appsdk verify` — passed: `{"ok":true,"project_id":"agentteams","stage":"contract_bound"}`.
- `git diff --check` — passed.
- The audit file retains its earlier listener-capable 5-file / 38-test evidence as historical evidence for the audited source base; it is not reused as a current public Relay or NAT acceptance result.

## Boundaries

The map omission remains an advisory governance gap. This receipt does not claim public Relay deployment, NAT egress, dual-daemon Work replay, provider apply/readback, Console-offline execution, full regression, or remote `main` push.
