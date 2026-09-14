# c3c2e0e solution receipt

- Issue: `c3c2e0e`
- Root cause: `cli/agentteams.mjs` imported TypeScript runtime sources directly; Node 22 strip-only execution rejected `LocalProcessError` parameter-property syntax before `init`.
- Fix: lazy-load compiled runtime artifacts, ship `generated/runtime-lib` through `package.json` `files`, build it from `prepack`, and run the complete packaged CLI lifecycle.
- Candidate commit: `acb5d77`
- Exact review: Codex review `c3c2e0e-cli-entry-r2-review-20260914-attempt5`, controller `pass`, exit 0.
- Integration commit: `0c0516b`
- Remote main: `0c0516b24531c77ec3575f54eb9c459145dfb005` (`git ls-remote origin refs/heads/main`).
- Verification: 4 focused files / 36 tests; full regression 78 files / 482 tests; typecheck; AppSDK compile/verify; isolated tarball install and init/start/status/work/stop/restart replay.
- Remaining boundary: public Relay/NAT/STUN, mobile and Console-offline acceptance remain post-MVP or separate delivery units.
