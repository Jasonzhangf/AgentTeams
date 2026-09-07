# Relay process entrypoint

`server/relay-process.ts` is the deployable Node entrypoint for the existing
`createRelayServer` owner. It creates one TLS/WSS Relay instance from one
explicit JSON file. It does not create a second Relay implementation and it
does not stop services outside the process that it started.

## Configuration

Start with an explicit path:

```sh
node --experimental-transform-types server/relay-process.ts --config ./relay.json
```

The schema is versioned and strict:

```json
{
  "version": 1,
  "listen": {
    "host": "127.0.0.1",
    "port": 8443
  },
  "tls": {
    "keyFile": "./tls/relay-key.pem",
    "certFile": "./tls/relay-cert.pem"
  },
  "limits": {
    "maxPayload": 65536,
    "maxConnections": 64,
    "maxGrants": 32,
    "maxBufferedAmount": 65536,
    "maxPendingMessages": 32,
    "maxPendingBytes": 65536,
    "grantTtlMs": 10000
  },
  "credentials": [
    {
      "credentialEnv": "TEAMS_RELAY_AGENT_A",
      "identity": {
        "accountId": "account-a",
        "scopeId": "scope-a",
        "agentId": "agent-a"
      }
    }
  ]
}
```

`keyFile` and `certFile` are resolved relative to the JSON file. Absolute
paths are also accepted. The listener port may be `0` for an OS-selected
test port; the process prints only the resulting `wss://` listener address.
All limit fields are positive safe integers, and `grantTtlMs` must fit the
Node timer range.

Each credential is an environment-variable reference, never a credential
value. The environment value is the exact HTTP `Authorization` header sent by
the client, for example `Bearer ...`. The loader rejects missing or empty
variables, line breaks, duplicate environment references, duplicate resolved
credential values, duplicate `(accountId, scopeId, agentId)` identities, and
unknown fields. Credential values are never written to the config projection,
logs, directory, or control frames.

The process maps the exact header to the configured `AuthenticatedAgent`.
Client declarations are still checked by `createRelayServer` against that
authenticated identity; an agent cannot claim another account, scope, or
agent ID. The returned `handle.config` is an independent snapshot, and each
authentication result is a fresh identity object; mutating public state cannot
change the live credential map.

## Lifecycle

The only supported command-line form is `--config <file>` (the equivalent
`--config=<file>` form is accepted). Startup fails explicitly if the argument,
JSON, TLS files, environment credential, identity, or limit is invalid.
All process-owned configuration and startup failures use
`RelayProcessConfigError` and retain the original error as `cause`; callers can
distinguish this boundary without losing the TLS or listener failure.

`SIGTERM` and `SIGINT` call the handle returned by `createRelayServer` and
await its `close()`. That closes this process's WSS sockets, grants, and HTTPS
listener. No shared-service process is discovered or stopped.

For a clean checkout, install the repository dependencies with:

```sh
pnpm install --frozen-lockfile
```

The source-entry verification uses the already installed dependency tree and
the same executable command shown above. Node's transform-types mode is used
because the existing Relay owner uses TypeScript parameter properties. It starts a child Node process,
connects two verified TLS clients, logs both in, queries the scoped directory,
sends `SIGTERM`, waits for exit, starts the same config again, logs in after
restart, queries the directory, then sends `SIGINT` and waits for exit:

```sh
pnpm exec vitest run server/relay-process.spec.ts
```

That test is the evidence for the real entrypoint, relative certificate/key
resolution, exact credential/identity admission, listener shutdown, and
same-config restart. It also opens a granted data connection through the shared
admission/client codec and verifies opaque binary delivery in both process
clients. It is separate from library-level Relay tests and does not use a
health endpoint as a login or shutdown proof.
