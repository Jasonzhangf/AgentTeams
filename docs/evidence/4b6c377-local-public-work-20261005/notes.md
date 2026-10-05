2026-10-05 07:39:46 -0700 | required-reads | partial | Same node; evidence notes initialized | docs/evidence/4b6c377-local-public-work-20261005/notes.md | run focused build/tests
2026-10-05 07:43:32 -0700 | build-artifacts | passed | node -c cli/agentteams.mjs exit 0 | cli-syntax.log | run pnpm build:runtime
2026-10-05 07:52:01 -0700 | validation | blocked | node net listen EPERM for /tmp Unix socket and 127.0.0.1; ps denied | unix-socket-probe.log | continue non-listen checks
2026-10-05 07:54:44 -0700 | focused-runtime-tests | blocked | 30 tests: 9 passed, 21 failed from listen EPERM | vitest-work-runtimes.log | inspect test config and add sandbox-independent real-entry coverage
2026-10-05 08:17:46 -0700 | real-entry-runner | passed | runtime/local-work-real-entry.spec.ts: 1 passed; real DAGpipe runner preserved submit identity and query did not replay provider request | vitest-local-work-real-entry-rerun.log | run affected socket suites
2026-10-05 08:23:27 -0700 | affected-socket-suites | blocked | 40 tests: 13 passed, 27 failed; all failures are listen EPERM | vitest-affected-final.log | run public CLI replay
2026-10-05 08:30:00 -0700 | public-cli-replay | blocked | init exit=1 with listen EPERM 127.0.0.1; start/work/stop did not reach a running launcher because init created no config | public-cli-replay/transcript-summary.txt | keep blocker in final report
2026-10-05 08:44:18 -0700 | cli-socket-client-test | passed | CLI suite 14 tests: 9 passed, 5 failed only in init loopback EPERM | vitest-cli-final.log | final compile build
2026-10-05 08:45:00 -0700 | final-build-gates | passed | tsc exit=0, build:runtime exit=0, diff check exit=0, runtime artifacts emitted | final-restored-exit-codes.txt, runtime-artifacts-restored.txt | report INCOMPLETE due sandbox acceptance blocker
2026-10-05 09:14:00 -0700 | socket-root-fix | passed | local-supervisor projection-failure fixture now reserves the launcher before start and uses a short temp root; suite green | host log: vitest-local-supervisor.log under the unit receipt directory | rerun the affected socket suites
2026-10-05 09:16:00 -0700 | affected-socket-suites | passed | 7 suites, all green on the host shell | host receipt: affected.json under the unit receipt directory | run the installed public replay
2026-10-05 09:28:00 -0700 | installed-public-work | passed | staged final pack installed outside the source tree; public CLI submit/query returned real provider matches and the query observed the original request | host receipt: installed-runtime-smoke.receipt.json under the unit receipt directory | run full regression on this exact candidate
2026-10-05 09:30:00 -0700 | full-regression | passed | pnpm test exit 0 with 0 failed, 0 pending, 0 todo | generated/validation/regression.json | start independent review
2026-10-05 10:22:00 -0700 | independent-review-r1 | failed | two P1: work open required an explicit --provider-generation instead of resolving the selected Agent's typed status projection; the installed gate exercised submit/query only although open/request/close are now public entries | external receipt: reviews/public-work-receiver-fix-20261005-r1/review.final.md | fix both and revalidate
2026-10-05 10:32:00 -0700 | review-r1-fix | passed | open resolves targetGeneration from the selected Agent's typed local daemon status projection and fails before dispatch when neither source exists; the installed gate now runs open/request/query/close plus the unresolvable-provider negative | host receipt: installed-runtime-smoke.receipt.json under the unit receipt directory | full regression and independent r2 on this exact candidate

The `blocked` entries above are the worker-process record from the GCM sandbox, which
denies loopback/Unix-socket `listen` and `/bin/ps`. They are kept because they document
why the acceptance replay had to move to the host shell. The authoritative acceptance
evidence is the host-side receipt set under the unit receipt directory outside this
repository; all mutable counts, hashes and candidate identities live there so this file
never quotes its own revision.
