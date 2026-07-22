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

curl --fail --silent --show-error "https://${MCP_DOMAIN}/.well-known/oauth-protected-resource" >/dev/null
status="$(curl --silent --output /dev/null --write-out '%{http_code}' "https://${MCP_DOMAIN}/mcp")"
[[ "$status" == "401" ]] || { echo "Expected unauthenticated /mcp to return 401; got $status" >&2; exit 1; }

runner_id="$(docker compose ps -q runner)"
gateway_id="$(docker compose ps -q gateway)"
[[ -n "$runner_id" && -n "$gateway_id" ]] || { echo "runner and gateway must be running" >&2; exit 1; }

docker inspect "$runner_id" --format '{{json .HostConfig.Binds}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}'
docker inspect "$gateway_id" --format '{{json .HostConfig.Binds}} {{.HostConfig.ReadonlyRootfs}} {{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}'

runner_networks="$(docker inspect "$runner_id" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}')"
gateway_networks="$(docker inspect "$gateway_id" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}')"
for network in $runner_networks; do
  [[ " $gateway_networks " != *" $network "* ]] || { echo "runner and gateway unexpectedly share network $network" >&2; exit 1; }
done

docker compose exec -T runner sh -c 'test ! -S /var/run/docker.sock && test ! -e "$HOME/.ssh" && test ! -e "$HOME/.codex" && test ! -e /var/lib/gateway'
docker compose exec -T gateway sh -c 'test ! -e /workspace && test ! -S /var/run/docker.sock'
if docker compose exec -T runner sh -c 'touch /root-filesystem-write-test' 2>/dev/null; then
  echo "Runner root filesystem unexpectedly accepted a write" >&2
  exit 1
fi

echo "Deployment metadata, authentication challenge, mount isolation, and read-only root checks passed."
