# Integration receipt: 2745502

- Candidate: `705e28a53dc29009fe5d381bc03ac3dceba9f4a8`
- Base: `7a9f25df61089e8ed658e7aabfe166ff6d61d87a`
- Integrated tree: `dee030dfe8c7acc395d5b0ddeebe73dd3c4786f0`
- Integration worktree: `playground/integration-2745502-20260912`
- Exact review: independent PASS; no P0/P1 findings.
- Mainline verification: focused local bridge `4 files / 11 tests`; runtime/network `3 files / 37 tests`; `pnpm test` `75 files / 442 tests`; `pnpm typecheck`; `pnpm exec tsc -p tsconfig.runtime.json --noEmit`; `pnpm build:runtime`; `pnpm smoke`; `appsdk guide compile`; `appsdk compile`; `appsdk verify`; `git diff --check`.
- Scope: local TLS Relay, two independent Agent daemon children, directory/capability discovery, grant/data channel, Work propose/request/result/close, clean supervisor restart. Public/NAT, UI projection, installed deployment, and cross-relay generation remain downstream.
