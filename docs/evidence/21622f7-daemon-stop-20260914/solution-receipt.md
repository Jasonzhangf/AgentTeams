# Solution receipt

- Issue: `21622f7` — Persist daemon stopped state across restart generations.
- Root cause: child network generation was written into the launcher-owned daemon generation field;
  on restart it could be lower than the persisted launcher generation, so the existing stale-writer
  guard rejected legitimate stop writes. Relay was also marked orphaned during every reload because
  it is a fixed launcher child rather than a user endpoint.
- Fix: persist daemon state with the launcher generation, leave network generation owned by the child
  network layer, and keep the always-configured relay non-orphaned.
- Integrated/pushed code: `063ff29f3c7d4597b1247c9f7e745184c2552c35`.
- Final remote main: `c9ee1e85cb0b9463c9734f78fe36c363fb45ddbf`.
- Review: official integration Codex Review task `21622f7f-integration-codex-20260914` completed with
  no P0/P1 findings; the independent GCM review also found no P0/P1 findings.
- Memory: `memory-f8a521346d59b5f0`, promoted to Level 2 with `ai-reviewed` and `human-unreviewed`.
- Remaining boundary: compiled replay still has a pre-existing `START_TIMEOUT` in both candidate and
  baseline; public Relay/NAT, mobile, multi-machine deployment, and status projection remain later MVP
  units and are not closed by this lifecycle fix.
