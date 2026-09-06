# Installed runtime replay

Date: 2026-09-06. The packaged-runtime-install milestone was validated from
the clean candidate worktree at commit `7af9c30`, then integrated into
`origin/main` as merge commit `40e0ff0`.

The candidate build produced a self-describing runtime artifact with the
pinned `ws` dependency. `pnpm smoke:installed` copied that artifact to an
isolated temporary install root, ran `pnpm install --prod`, and exercised the
packaged Relay and Agent entrypoints. The replay confirmed Relay startup,
Agent startup and registration, a restart with a fresh generation, SIGTERM
shutdown, SIGINT shutdown, and credential-value redaction from captured
output. The temporary install root, children, and generated TLS/configuration
state were removed after the replay.

Candidate validation also passed `pnpm test` (60 files, 318 tests),
`pnpm typecheck`, `git diff --check`, and exact AGY commit review
`agentteams-packaged-runtime-20260906` (`PASS`, no findings). Mainline
verification at `40e0ff0` passed `pnpm test`, `pnpm typecheck`,
`pnpm build:governance`, `pnpm smoke`, and AppSDK `guide compile`, `compile`,
and `verify` in a clean worktree.

This proves an installable local packaged runtime and its restart/shutdown
entrypoint lifecycle. It does not prove OS service-manager installation,
public DNS/certificate ingress, NAT traversal, direct transport, production
Relay deployment, or real mobile replay.
