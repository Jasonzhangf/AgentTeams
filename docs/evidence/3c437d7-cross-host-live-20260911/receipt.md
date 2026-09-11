# 3c437d7 cross-host live blocker receipt

- issue: `3c437d7`
- input candidate: `origin/main@3c7dfb94226547fc60bbd9e299f931abbd680c2f`
- worktree: `playground/mvp-cross-host-live-20260911`
- result: `BLOCKED` for current-SHA Claw/coder2new relay-first Agent Work replay
- capture time: `2026-09-11` America/Los_Angeles

## Candidate identity

This worktree is checked out at the requested candidate:

```text
3c7dfb94226547fc60bbd9e299f931abbd680c2f
```

The candidate diff from the immediately preceding live same-host Claw replay
source `e508f45ef6752e9c6bf2fc447faffbf9cb168f99` changes only memory/evidence
docs; no product source, package manifest, lockfile, `.appsdk`, or server
production configuration is changed by this worker.

No runtime artifact hashes are claimed here. An isolated build staging attempt
under `/tmp` did not retain generated runtime artifacts, a full reproducible
build command, Node/pnpm/TypeScript versions, or a final artifact path. The
generated outputs were removed and were not deployed; they cannot be used as
current-candidate acceptance evidence.

## Intended replay

The intended live evidence was:

1. Run provider daemon `claw-test-b` on Claw with the current-candidate runtime
   artifact and isolated replay data.
2. Run consumer daemon `claw-test-a` on coder2new (`ser162766042809` /
   `154.40.58.131` / Tailscale `100.77.236.86`) in a one-shot replay container
   or isolated runtime process.
3. Use the existing public Claw AgentTeams Relay
   `wss://claw.codewhisper.cc:9443` for login, directory publication,
   capability/resource discovery, proposal/request/close, and restart or
   generation-isolation evidence.
4. Capture provider ledger readback, artifact hashes on both hosts, process
   cleanup, and formal relay service untouched.

## Observed blocker

This sandbox denied all attempted outbound network syscalls and DNS lookups, so
the live cross-host replay could not be started from here. Exact command
results:

```text
sshpass -p <documented inventory value> ssh -o ... root@154.40.58.131 'hostname; id'
ssh: connect to host 154.40.58.131 port 22: Operation not permitted

sshpass -p <documented inventory value> ssh -o ... root@100.77.236.86 'hostname; id'
ssh: connect to host 100.77.236.86 port 22: Operation not permitted

ssh -i <documented claw key> -o ... root@159.75.134.56 'hostname; systemctl is-active agentteams-relay.service; ss -ltn | grep 9443'
ssh: connect to host 159.75.134.56 port 22: Operation not permitted

nc -vz -w 3 100.77.236.86 22
nc: connectx to 100.77.236.86 port 22 (tcp) failed: Operation not permitted

curl -sS --connect-timeout 5 https://claw.codewhisper.cc:9443/
curl: (6) Could not resolve host: claw.codewhisper.cc

tailscale status
The Tailscale CLI failed to start: Failed to load preferences.

ping 100.77.236.86
ping: sendto/recvmsg: Operation not permitted
```

The server inventory was read before the attempt and documents `coder2new` as
the current server and its Tailscale SSH management path. No SSH credential was
guessed; the documented path from `/Users/fanzhang/Documents/server/docs/ACCESS_INVENTORY.md`
was attempted, and this environment could not open the connection. Historical
receipts were not used as current-SHA cross-host proof.

## Boundary

This is a blocker receipt, not a pass receipt. It does not claim Claw/coder2new
cross-host live Agent Work, real NAT egress, current-SHA directory discovery,
proposal/request/close, restart/generation isolation, provider ledger readback,
or retained runtime artifact identity for
`3c7dfb94226547fc60bbd9e299f931abbd680c2f`. It records the exact environmental
blocker and the blocked candidate at that SHA.

## Cleanup

No daemon or replay process was started. No production service, DNS, firewall,
systemd unit, source file, package manifest, lockfile, `.appsdk`, or server
production configuration was changed. Temporary build staging and build log
paths created under `/tmp` were removed and verified absent.
