# Integration receipt

- Delivery unit: `af5c167-phase1-current-20260914`
- Candidate commit: `17e60ef`
- Integration base: `3ab618aab39e4bc809294ae554c1714aabc35016`
- Integration candidate before this receipt: `b8e97c41ade8f248e6a777425cad717f45fedaf3`
- Integrated paths: `docs/evidence/af5c167-phase1-current-20260914/**` only.

Mainline verification on the integrated tree passed:

- mapped Phase 1 suite: 24 files, 172 tests (`integration-tests.log`)
- `pnpm typecheck`: exit 0 (`integration-typecheck.log`)
- `git diff --check`: exit 0
- `appsdk verify`: command exit 0 with `development_ready=true`; `delivery_assessed=false` and `delivery_verified=false` because this evidence-only unit did not request delivery admission (`integration-appsdk-verify.log`)

No product source changed in this unit. The local replay and provider replay receipts remain bounded to their own current-SHA evidence.
