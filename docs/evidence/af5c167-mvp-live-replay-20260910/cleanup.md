# Cleanup receipt: af5c167-mvp-live-replay

- candidate worktree: retained until review and integration
- Claw provider PID: stopped by exact PID after replay (the provider was not the
  production Relay service)
- Claw temporary paths removed, and verified absent after deletion:
  `/tmp/agentteams-relay-artifact-7d49b02.tgz`, `/tmp/agentteams-relay.json`,
  `/tmp/agentteams-runtime-59cb0de.tgz`, `/tmp/agentteams-relay.service`,
  `/tmp/install-agentteams-relay.sh`, `/tmp/agentteams-relay-artifact`, and
  `/tmp/agentteams-relay.env`
- Claw cleanup verification command returned `removed=7`,
  `relay_service=active`, and a listener on `0.0.0.0:9443` owned by the
  production Relay process (`pid=2492674`)
- no credential values were written to source, logs or receipt
- owned worktree/branch will be removed only after integration push and remote-main receipt
