# Fingerprint: Local MVP scheduler re-entry

- Integration base commit/tree: `ce91c14cd7b6c9d97a3d7f25bd35e384599cbb85` /
  `fc38ecaa0061b5bc3d7d6901ab370ce964009edb`.
- Candidate commit/tree: `b4a2747128bc3c6c5b3abbc0d05fd62da0c3ea02` /
  `91344e9488ea5af1c2042c520140081a10762125`.
- Integrated source commit/tree before evidence follow-up: `e823a46183a9e24921aac9165b5688dc0180ba9d` /
  `15388c7e14751170fc69eb2bcc271ef4b9baa803`.
- Final evidence commit/tree before push: `a24afdd9eac5981cbf3379f0812ff8d53ac3d2a3` /
  `91344e9488ea5af1c2042c520140081a10762125`.
- Changed paths are limited to `docs/goals/**` and
  `docs/evidence/af5c167-goal-reentry-20260913/**`; no runtime, network, agent, config, adapter, UI,
  dependency or lockfile path changed.
- Tool/environment: Node `v22.22.2`, pnpm `10.31.0`, macOS Desktop; dependencies installed with
  `pnpm install --frozen-lockfile --offline`.
- Lockfile SHA-256: `d6ffb637673ac0ef6c8f4e7f03a2a76eb58ed3e1b13e53a19122d8eca7053d37`.
- AppSDK source identities: `.appsdk/contracts/sdk-bundle.manifest.json` SHA-256
  `e83eb63aceb3673920948f8e04dd57cd7b121343c7e004f611aa3c774c5387e9`; `.appsdk/project.json`
  SHA-256 `5e87b3e29c43792078d09e6f0757ff3b64dc33f4778c52437e70c38e6b979e43`.
- Validation command: `pnpm verify`; raw output:
  `docs/evidence/af5c167-goal-reentry-20260913/integration-pnpm-verify.log`.
- Result: 77 test files / 458 tests, typecheck, AppSDK guide compile, AppSDK compile, packaged
  Console/runtime smoke and AppSDK verify passed. No runtime MVP, public relay, NAT, provider live,
  Console-offline or multi-device acceptance is claimed.
