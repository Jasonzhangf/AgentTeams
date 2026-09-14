# Integration receipt

- Delivery unit: `c5708f3-current-syah-live-20260914`
- Candidate commit: `52107b8`
- Integration base: `18279c48c26af725e98de7194c59d600b115f77a`
- Integration commit before this receipt: `fd27dfff35cb28a9404b5c67dd2c0bdd0e1447d6`
- Worktree: `playground/integration-c5708f3-current-syah-live-20260914`
- Integrated paths: `docs/evidence/c5708f3-current-syah-live-20260914/**` only.

Integration verification on the integrated tree passed:

- focused provider/OpenCode suite: 7 files, 43 tests passed (`integration-tests.log`)
- `pnpm typecheck`: exit 0 (`integration-typecheck.log`)
- `git diff --check`: exit 0
- `appsdk verify`: command exit 0 with `development_ready=true`; `delivery_assessed=false` and `delivery_verified=false` because this evidence-only unit did not request delivery admission (`integration-appsdk-verify.log`)

No product source or runtime behavior was changed by this delivery unit. The live replay evidence remains bound to the candidate source SHA in `candidate-receipt.md`.
