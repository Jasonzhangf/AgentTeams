# 3c437d7 cleanup receipt

- Delivery unit: `3c437d7`
- Integration tree before cleanup: `2352b70660e0d7a7fff27680b7cc7507cdd8483c`
- Remote main observed before this receipt: `2352b70660e0d7a7fff27680b7cc7507cdd8483c`
- Owned source worktree: `playground/3c437d7-claw-public-nat-20260912`
- Owned integration worktree: `playground/3c437d7-claw-public-nat-20260912-integration`

Cleanup checks completed before removal:

```text
source worktree clean                         PASS
integration worktree clean                    PASS
owned AgentTeams/Relay replay processes       none running
owned temporary listeners/containers          none running
project-memory verify on integration tree     PASS
remote main receipt                           present and verified
```

The formal Claw Relay service and its rollback obligation are external retained
resources documented by the public replay receipt; this delivery unit did not
stop or delete them. Only the two worktrees and branches listed above are
eligible for removal after this receipt is pushed.
