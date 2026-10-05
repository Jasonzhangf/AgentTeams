# U1 manifest review repair

Issue `746dd7b`; base `53c6831`. Prior independent r2 failed on an incomplete manifest graph set. This attempt derives the expected five graphs and canonical paths from the existing installed-runtime file definition, validates each hash once, and adds a dropped-entry installed-copy rejection. It also removes a redundant hardcoded tamper-result count and updates affected resource/verification descriptions.

The current public verifier red/green fixture, 24-test package suite, typecheck, compile/smoke and installed final runtime/SDK receipts are recorded in `current-gates.json`. The SDK smoke uses the installed package and real provider result; it does not prove the public Work CLI. Unchanged source/full-regression and real-DOM stages are explicitly reused with their original evidence and limits.

Frozen product validation tree: `7c798668ed73373ba809091f74163d4a2fc6de80`. These two evidence files only publish the result. Independent review, candidate delivery and full user MVP remain pending.
