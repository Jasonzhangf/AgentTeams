# Relay process packaged replay

Date: 2026-09-06. N1 performed this read-only deployment audit from
`origin/main@e1b74cf` in
`playground/relay-process-replay-20260906`.

The audit installed the frozen lockfile, ran the relay process test (1 file / 4
tests), built the runtime, and packaged the compiled artifact. The packaged
artifact contained the executable compiled relay process and relay client. A
real replay using temporary TLS/configuration and temporary environment
credentials then:

1. started the compiled relay process;
2. logged two WSS clients in and queried a directory containing both identities;
3. stopped the first process with SIGTERM and confirmed the old listener
   rejected connections;
4. restarted the same configuration and confirmed login/directory again;
5. stopped the second process with SIGINT and confirmed the listener closed.

Both temporary children exited, the temporary TLS/config directory was
removed, and no credential values were emitted. No source change was produced.

This proves the compiled/package relay process entrypoint and local WSS
login/directory/restart lifecycle. It does not prove installation under an OS
service manager, public DNS/certificate ingress, NAT traversal, or production
Relay configuration.
