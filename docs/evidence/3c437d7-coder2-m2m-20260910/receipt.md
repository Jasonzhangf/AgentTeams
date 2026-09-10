# 3c437d7 coder2new cross-host Agent Work replay

- Candidate: `origin/main@cf62442c74c22c387e7058d99fb397b34ca9b91a`
- Delivery unit: `3c437d7`; related Console-offline boundary: `9b10ed3`.
- Worktree: `playground/3c437d7-coder2-m2m-20260910`.
- Relay: Claw `wss://claw.codewhisper.cc:9443`; provider ran on Claw (`159.75.134.56`), consumer ran in a one-shot `node:22-alpine` Docker container on coder2new (`154.40.58.131`, hostname `ser162766042809`) with host networking.
- Artifact hashes, checked on both hosts:
  - `runtime/agent-process.js` = `730234b93f9dd0327cb259ead9f7eef208e166a0b98c8195fb53266fa03f61d8`
  - `runtime/agent-work-client.js` = `3a15a9e4714622844d7b67b80694efb99513c526b953e95b7a5f321ba62c18f3`
- Provider `claw-test-b` admitted at generation `27`; consumer `claw-test-a` admitted at generation `23`.
- Consumer directory discovery found provider `claw-test-b`, capability `file-search`, version `1`, operation `search`.
- Work `coder2-cross-host-work-2`: proposal `accepted`; request `succeeded`; close `closed`.
- Provider durable ledger readback: both replay works are `closed`, both requests are `succeeded`, and both `search-slot` allocations are `released`.
- No Console process participated. Provider capability was executed by `/usr/bin/rg` against an isolated replay root.
- Resource check before cleanup: no coder2new replay container remained; provider listener was only the owned loopback lease `127.0.0.1:48083`.

## Validation

- Candidate build input: `pnpm build:runtime` at `cf62442`; the two artifact hashes above were checked locally, on Claw, and on coder2new.
- Replay entrypoint: `node /replay/consumer.mjs` inside `node:22-alpine`; the process returned `status=passed` with the target, proposal, request, and close states recorded above.
- Provider ledger readback: `node` JSON projection of `provider-data2/work.json` on Claw; both Work records and both resource allocations were checked after the replay.
- Cleanup checks: exact-PID stop, `systemctl is-active/is-enabled agentteams-relay.service`, `ss` listener checks, `docker ps -a`, and temporary-directory existence checks.

## Exact review

- Reviewer: `consumer_work_exact_review` (independent agent), timestamp `2026-09-10T05:59:47-07:00`.
- Bound cwd: `/Volumes/extension/code/AgentTeams/playground/3c437d7-coder2-m2m-20260910`.
- Bound candidate/base: `cf62442c74c22c387e7058d99fb397b34ca9b91a`; `HEAD` and `origin/main` were equal at review time.
- Changed path: only this receipt; no source, configuration, artifact, or other worktree changes.
- Verdict: `PASS`; no P0/P1 finding. The reviewer confirmed that this receipt may be integrated alone and does not authorize unrelated delivery units.

## Boundary

This is real cross-host/public-relay Agent Work evidence for the current candidate. It does not prove dual-NAT traversal, direct transport, mobile/cellular access, production daemon installation, relay hostname DNS correctness for every client, or Console-offline V1 acceptance beyond the absence of a Console in this replay.

## Cleanup

- Provider PID was stopped by exact PID; Claw temporary directory was removed and no `48083` lease remained.
- The coder2new one-shot Docker container had already exited with `--rm`; its temporary directory was removed and no `48082` listener remained.
- Claw `agentteams-relay.service` remained `active` and `enabled`, with only its formal `0.0.0.0:9443` listener present.
- Local replay worktree and branch remain until this receipt is committed and integrated; no other worktree or branch is owned by this delivery unit.
