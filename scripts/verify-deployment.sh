#!/usr/bin/env bash
set -euo pipefail

if [[ ! -f .env ]]; then
  echo ".env is required" >&2
  exit 2
fi

set -a
source .env
set +a
: "${MCP_DOMAIN:?MCP_DOMAIN is required}"

docker_command=(docker)
if ! docker info >/dev/null 2>&1; then
  docker_command=(sudo docker)
fi

curl --fail --silent --show-error "https://${MCP_DOMAIN}/.well-known/oauth-protected-resource" >/dev/null
status="$(curl --silent --output /dev/null --write-out '%{http_code}' "https://${MCP_DOMAIN}/mcp")"
if [[ "$status" != "401" ]]; then
  echo "Expected unauthenticated /mcp to return 401; got $status" >&2
  exit 1
fi

gateway_id="$("${docker_command[@]}" compose ps -q gateway)"
if [[ -z "$gateway_id" ]]; then
  echo "gateway must be running" >&2
  exit 1
fi
"${docker_command[@]}" inspect "$gateway_id" --format '{{json .HostConfig.Binds}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}'
"${docker_command[@]}" compose exec -T gateway sh -c 'test ! -e /workspace && test ! -S /var/run/docker.sock'

# Every account has its own runner; check each that exists. A fresh install
# has none until the first administrator is approved during onboarding.
gateway_networks="$("${docker_command[@]}" inspect "$gateway_id" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}')"
runner_ids="$("${docker_command[@]}" ps -q --filter label=dev-mcp.user)"
if [[ -z "$runner_ids" ]]; then
  echo "No account runner is running yet; skipping runner isolation checks."
fi
for runner_id in $runner_ids; do
  "${docker_command[@]}" inspect "$runner_id" --format '{{.Name}} {{json .HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}'
  runner_networks="$("${docker_command[@]}" inspect "$runner_id" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}')"
  for network in $runner_networks; do
    if [[ " $gateway_networks " == *" $network "* ]]; then
      echo "runner $runner_id and gateway unexpectedly share network $network" >&2
      exit 1
    fi
  done
  "${docker_command[@]}" exec "$runner_id" sh -c 'test ! -S /var/run/docker.sock && test -z "$(find "$HOME/.ssh" -type f -print -quit 2>/dev/null)" && test ! -e "$HOME/.codex" && test ! -e /var/lib/gateway && test -r /run/dev-mcp-ipc-key'
  if "${docker_command[@]}" exec "$runner_id" sh -c 'touch /root-filesystem-write-test' 2>/dev/null; then
    echo "Runner $runner_id root filesystem unexpectedly accepted a write" >&2
    exit 1
  fi
done

echo "Deployment metadata, authentication challenge, mount isolation, and read-only root checks passed."
