# Current U1 final package candidate after r1 FAIL

This is the authoritative current source-slice validation, base main3bf42b2. The previous sdk-final-pack-20261004 receipts and notes are historical candidate evidence, including the diagnosed base/final mode contradiction. They do not prove this candidate.

## Exact review defects and fixes

1. The legitimate base pack excludes runtime/dagpipe. artifact-smoke now computes the mode-aware expected manifest. Actual base public smoke is a regression; final still includes the runner, manifest and five graphs.
2. package-user-smoke validates and emits the actual package-receipt mode at its single producer. installed-runtime-smoke rejects missing/unsupported mode before effects and mismatched lifecycle mode. Current actual final lifecycle receipt is mode final with start/restart generations1->2 and distinct launcher PIDs.
3. SDK default output is invocation-scoped, matching the existing map; explicit output paths remain supported.
4. The primary found two newly introduced negative-test fixture leaks before acceptance and added exact-root finally teardown. Supported negative tests and the full public suite now leave no new fixture roots.

## Author validation

Current full public package suite23 PASS, no skips. The first full source run had five failures in four unchanged files; all32 cases of those files passed serial replay. Native Vitest maxWorkers=2 then passed all582 cases. Preserve the original failed report; do not claim it passed. Original full run used TEAMS_CONSOLE_REAL_DOM=1 and its real Chrome focus test passed. That same unchanged-input result is reused with the bounded full regression; do not label the bounded invocation itself real-DOM enabled.

From that stage, current typecheck, Guidance compile, AppSDK compile, source/artifact smoke and AppSDK verify command all exited0. Verify reports development_ready, with delivery_not_evaluated; it is not full user MVP acceptance.

The actual newly compiled final package passed installed CLI/Console/Relay/two-Agent start/restart and cleanup, and separately installed SDK Work through registered Operators/compile/runtime/real provider rg marker. Missing Operator/effects compile negatives and five tampered installed-copy failures were checked. Their immutable raw receipts and exact tested candidate identity are in current-gates.json.

All validation used staged product tree e80be8a2116f2f60aeca242e1e0a4b75b6c7a2f8 at base3bf42b2. Publishing this notes file and current-gates.json changes only evidence; product and package inputs are unchanged. The reviewer must bind the resulting exact review tree and this publication delta, not treat old r1 FAIL as PASS.

No user Work CLI success, Console-offline Work, Session, BB01-BB14, main push or milestone completion is claimed. Work source assembly is a separate current candidate. After current exact review PASS, primary handles commit/admission, integration/push and own cleanup. Entire issue746dd7b remains open until its full product acceptance.
