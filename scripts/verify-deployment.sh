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
  "${docker_command[@]}" inspect "$runner_id" --format '{{.Name}} read-only={{.HostConfig.ReadonlyRootfs}} capabilities={{json .HostConfig.CapDrop}} apparmor={{.AppArmorProfile}}'
  runner_networks="$("${docker_command[@]}" inspect "$runner_id" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}')"
  for network in $runner_networks; do
    if [[ " $gateway_networks " == *" $network "* ]]; then
      echo "runner $runner_id and gateway unexpectedly share network $network" >&2
      exit 1
    fi
  done
  "${docker_command[@]}" exec "$runner_id" sh -c 'test ! -S /var/run/docker.sock && test ! -e /var/lib/gateway && command -v gh >/dev/null'
  readonly="$("${docker_command[@]}" inspect "$runner_id" --format '{{.HostConfig.ReadonlyRootfs}}')"
  role="$("${docker_command[@]}" inspect "$runner_id" --format '{{index .Config.Labels "dev-mcp.role"}}')"
  if [[ "$role" == runner ]]; then
    [[ "$readonly" == true ]]
    "${docker_command[@]}" inspect "$runner_id" --format '{{json .HostConfig.CapDrop}} {{json .HostConfig.SecurityOpt}}' | grep -q 'ALL.*no-new-privileges:true'
    "${docker_command[@]}" exec "$runner_id" sh -c 'test -r /run/dev-mcp-ipc-key && test "$HOME" = /home/runner && ! command -v sudo && ! command -v codex && ! command -v claude && test ! -r /workspace/.dev-mcp-home && test ! -e /run/dev-mcp-ssh && test ! -w /run/dev-mcp-git-auth'
  elif [[ "$role" == workspace ]]; then
    [[ "$readonly" == false ]]
    "${docker_command[@]}" exec "$runner_id" sh -c 'test "$HOME" = /workspace/.dev-mcp-home && test "$(sudo -n id -u)" = 0 && test ! -s /run/dev-mcp-ipc-key && test ! -S /ipc/runner.sock && test -r /run/dev-mcp-ssh/access.json'
    mounts="$("${docker_command[@]}" inspect "$runner_id" --format '{{range .Mounts}}{{.Destination}} {{end}}')"
    for forbidden in /ipc /run/dev-mcp-ipc-key /var/lib/dev-mcp; do
      if [[ " $mounts " == *" $forbidden "* ]]; then
        echo "Development container unexpectedly mounts $forbidden" >&2
        exit 1
      fi
    done
    owner="$("${docker_command[@]}" inspect "$runner_id" --format '{{index .Config.Labels "dev-mcp.user"}}')"
    peer="$("${docker_command[@]}" ps -aq --filter "label=dev-mcp.user=$owner" --filter label=dev-mcp.role=runner)"
    [[ -n "$peer" ]]
    peer_networks="$("${docker_command[@]}" inspect "$peer" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}')"
    for network in $runner_networks; do
      if [[ " $peer_networks " == *" $network "* ]]; then
        echo "MCP and development containers unexpectedly share network $network" >&2
        exit 1
      fi
    done
  else
    echo "Unexpected account container role: $role" >&2
    exit 1
  fi
done

echo "Deployment metadata, authentication challenge, MCP/development isolation, Git tools and development sudo checks passed."
