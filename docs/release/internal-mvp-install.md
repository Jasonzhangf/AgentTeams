# AgentTeams internal MVP — install and start guide

This guide installs the internal MVP artifact and starts one AgentTeams
deployment on one machine. It covers the released tarball only. It does not
describe deployment to a shared host.

## 1. Artifact and verification

The release artifact is `agentteams-0.2.0-internal.1.tgz` together with
`agentteams-0.2.0-internal.1.tgz.sha256`. The two files are produced by
`scripts/release-receipt.mjs`, and the same run writes the release receipt.

Verify the tarball before you install it:

```
shasum -a 256 -c agentteams-0.2.0-internal.1.tgz.sha256
```

## 2. Requirements

- Node.js 22 or later, and `npm`.
- One engine binary for the engine you select:
  - `--serve opencode` needs the OpenCode executable that the v4 config names.
  - `--serve dsh` needs the DSH executable that the v4 config names.
- A free TCP port for each daemon you start.

## 3. Install

Install the tarball into a prefix, then use the CLI from that prefix:

```
npm install --prefix "$HOME/.agentteams-prefix" ./agentteams-0.2.0-internal.1.tgz
export PATH="$HOME/.agentteams-prefix/node_modules/.bin:$PATH"
agentteams init
agentteams status
```

`agentteams init` writes `~/.agentteams/config.toml` when that file does not
exist. `agentteams status` reports the stored daemon state.

## 4. Configure

Copy the v4 examples and edit the values that belong to your machine:

```
cp config/examples/agent-opencode.toml ~/.agentteams/agent.toml
cp config/examples/control.toml      ~/.agentteams/control.toml
cp config/examples/registry.toml     ~/.agentteams/registry.toml
```

Each file declares exactly one daemon: `agent`, `control` or `registry`. Start
one file per daemon. Values do not leak between files.

Credentials are read from the environment variables that each config names.
Export them before you start a daemon:

```
export TEAMS_CONSOLE_PASSWORD='<console-password>'
export EXAMPLE_OPENAI_API_KEY='<provider-key>'
```

Do not put a real secret in a config file or in a command line.

The registry reuses the TLS-only relay. Create the certificate and key pair that
`registry.toml` references before the first start. A missing pair fails with
`TLS_REQUIRED`; the daemon does not generate a certificate silently.

## 5. Start

Start the registry, then the control daemon, then the agent daemon:

```
agentteams registry start --config ~/.agentteams/registry.toml
agentteams control start  --config ~/.agentteams/control.toml
agentteams start          --config ~/.agentteams/agent.toml
```

The quick-start entry starts one agent daemon with explicit listen values:

```
agentteams --serve opencode --ip 127.0.0.1 --port 7443 --config ~/.agentteams/agent.toml
```

Explicit `--serve`, `--ip` and `--port` values win over the config file.

Check each daemon:

```
agentteams registry status
agentteams control status
agentteams status
```

## 6. Console

Open `http://127.0.0.1:7331` in a browser. The Console asks for the HTTP Basic
credential from `[webui.auth]` in `control.toml`. The Console shows the
registration directory, the Session rows that declared peers publish, and the
connection history.

Closing the Console is safe. It is an observation client, and it is never a
required relay. Agent-to-agent traffic continues after the browser closes.

## 7. Stop and restart

```
agentteams stop --config ~/.agentteams/agent.toml
agentteams control stop
agentteams registry stop
```

A restart is a start on the same config. The daemon keeps its data directory, so
the config and the stored state survive the restart and the generation number
increases. A stop or status command that names an older generation is refused,
and it does not touch the live process.

## 8. What this artifact does not deliver

State these limits when you hand the artifact to another person:

- The `sessionEvents` projection is incomplete. The Console stream carries
  directory changes, not a full Session, permission and notification event
  projection.
- There is no cross-device receipt for this package content. The retained
  two-host receipt belongs to package `0.1.0` at another commit.
- The AppSDK rule audit for this candidate is retained, not delivered.
- The tarball is an internal artifact. It is not published to a registry and it
  is not deployed to a shared host.
