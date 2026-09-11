# V1 cleanup receipt

- delivery unit: `v1-cross-host-live-20260911`
- merged remote main before cleanup: `501697b1d161d9d5c026cd6961a927bae9ee7a19`
- worker candidate integrated: `36ac55f`
- integration commit integrated: `501697b1d161d9d5c026cd6961a927bae9ee7a19`

The V1 worker and integration worktrees were clean, had stopped writing, and
were removed after the integration SHA was observed on remote main. Their owned
branches were deleted after confirming the integrated mainline retained the V1
receipt and integration receipt with no live acceptance claim.

Integration-only dependency trees, generated artifacts, and runtime-smoke
temporary state were removed before worktree deletion. No daemon, Relay,
listener, remote service, or credential material was left running or retained
by this unit. The blocker and integration receipts remain durable on main.
