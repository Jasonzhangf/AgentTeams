#!/usr/bin/env bash
set -euo pipefail

artifact_root=${1:?usage: install-relay.sh <artifact-root> [install-root]}
install_root=${2:-/opt/agentteams}

if [[ ! -f "$artifact_root/package.json" || ! -f "$artifact_root/runtime/server/relay-process.js" ]]; then
  printf 'invalid AgentTeams runtime artifact: %s\n' "$artifact_root" >&2
  exit 1
fi
if [[ -e "$install_root" ]]; then
  printf 'refusing to overwrite existing install root: %s\n' "$install_root" >&2
  exit 1
fi

install -d "$install_root"
cp -R "$artifact_root"/. "$install_root"/
pnpm install --prod --ignore-scripts --dir "$install_root"
printf 'AgentTeams relay artifact installed at %s\n' "$install_root"
