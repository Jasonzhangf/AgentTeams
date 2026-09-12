# 3c437d7 current-candidate replay cleanup receipt

- Delivery unit: `3c437d7`
- Candidate source: `68aacf79d0db36f2c2e3a963c2b51b0bcb00443a`
- Cleanup date: `2026-09-12`

Owned replay resources were stopped and checked after the public Relay,
generation, and Console-offline evidence was captured:

```text
Claw provider PID 3450673: stopped by exact PID; no owned provider replay tree remains
coder2new Console containers cce065b5... and 1b00ef7e...: stopped and removed
coder2new agentteams-console* containers: none in docker ps -a
coder2new /opt/agentteams.candidate-20260912-0145: absent
coder2new /tmp/agentteams-mvp-live-20260912 and replay scripts: absent
Claw /tmp/agentteams-mvp-live-20260912.completed: absent
coder2new port 61991: no listener
```

The production Relay was not removed. Final remote checks returned:

```text
agentteams-relay.service: active
agentteams-relay.service: enabled
0.0.0.0:9443: node MainPID 3448136
```

The Claw rollback tree `/opt/agentteams.backup-20260912-0145` remains as the
explicit retained rollback obligation. No unrelated process, service, DNS,
Nginx route, firewall rule, credential file, or other worktree was changed.
After the final memory receipt push at remote main
`20f26837e85b92240002c324b70c45463be183fc`, the owned candidate,
integration, and finalization worktrees were verified clean and removed with
their delivery branches. No active claim, process, listener, or unique
evidence remained in those worktrees at removal time.
