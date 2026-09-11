# AgentTeams MVP current-SHA Relay replay

- delivery unit: `af5c167-mvp-live-replay`
- base: `59cb0dee4d023fedaa1708cefdacd5833e350a35`
- candidate worktree: `playground/af5c167-mvp-live-replay`
- transport: Claw AgentTeams Relay `wss://claw.codewhisper.cc:9443`
- replay source commit: `59cb0dee4d023fedaa1708cefdacd5833e350a35`
- source artifact: `pnpm build:runtime` from the replay source commit above
- Claw artifact staging: `/tmp/agentteams-runtime-59cb0de.tgz`, expanded at
  `/tmp/agentteams-relay-artifact` before cleanup; the archive and staging directory
  are listed in `cleanup.md` and were removed after capture
- artifact hashes:
  - `runtime/agent-process.js`: `076bb40e6992eeac3c19592417eb685caaf40e18e25ea21b11d30580e1ca8560`
  - `runtime/agent-work-client.js`: `3a15a9e4714622844d7b67b80694efb99513c526b953e95b7a5f321ba62c18f3`

## Live replay

The provider daemon `claw-test-b` and consumer daemon `claw-test-a` booted independently
from the artifact built from replay source commit `59cb0dee4d023fedaa1708cefdacd5833e350a35`
and authenticated to the running Relay. The consumer discovered
`file-search/1/search`, proposed Work `mvp-live-work-59cb0de`, and the provider executed a
fixed-root `/usr/bin/rg` search.

Observed consumer result:

```json
{"proposalState":"accepted","first":{"state":"succeeded","matchCount":1},"second":{"state":"succeeded"},"closed":"closed"}
```

The second request reused the same `requestId` and returned the prior result. Provider
durable ledger readback after the replay was:

```json
{"revision":10,"works":[{"workId":"mvp-live-work-59cb0de","state":"closed"},{"workId":"mvp-live-work-reconnect-59cb0de","state":"closed"}],"requests":[{"requestId":"mvp-live-request-59cb0de","state":"succeeded"},{"requestId":"mvp-live-request-reconnect-59cb0de","state":"succeeded"}],"allocations":[{"resourceId":"search-slot","state":"released"},{"resourceId":"search-slot","state":"released"}]}
```

After stopping and restarting the provider, the consumer's captured generation `33` was
rejected with `STALE_GENERATION`; it discovered generation `34`, completed a new request,
and closed the Work:

```json
{"staleCode":"STALE_GENERATION","targetGeneration":34,"proposalState":"accepted","resultState":"succeeded","closed":"closed"}
```

No Console process participated in this replay. The Relay service remained active on
`0.0.0.0:9443`. The current host's split DNS resolves the Relay name to a Tailscale
address, so this replay is a Claw-host public Relay run rather than a dual-NAT claim.
Existing cross-host Claw/coder2new evidence remains a separate boundary.

Cleanup verification for this delivery unit was run on Claw after capture. The seven
owned temporary paths listed in `cleanup.md` were removed and each was checked absent;
the command returned `removed=7`. The same check returned `agentteams-relay.service`
`active` with only the production `0.0.0.0:9443` listener (`pid=2492674`).

## Verification

- `pnpm verify`: passed, 71 files / 413 tests, typecheck, Guidance compile, AppSDK compile,
  packaged Console/runtime smoke and AppSDK verify (`stage=contract_bound`).
- `git diff --check`: passed.

This receipt does not claim direct transport, NAT-to-NAT, mobile replay, live provider
catalog/apply, or Console reopen readback; those remain the explicit next acceptance units.
