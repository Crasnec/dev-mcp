#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repository_root"
user_id="${1:-}"
if [[ "$#" != 1 || ! "$user_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Usage: ./scripts/provision-user.sh <user UUID from the admin page>" >&2
  exit 2
fi

gateway_id="${GATEWAY_CONTAINER_ID:-$(docker compose ps -q gateway)}"
primary_id="${PRIMARY_CONTAINER_ID:-$(docker compose ps -q runner)}"
if [[ -z "$gateway_id" || -z "$primary_id" ]]; then
  echo "Start the updated gateway and primary runner with Docker Compose first." >&2
  exit 1
fi
ipc_root="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/user-ipc"}}{{.Source}}{{end}}{{end}}' "$gateway_id")"
runner_image="$(docker inspect --format '{{.Image}}' "$primary_id")"
if [[ -z "$ipc_root" || "$ipc_root" == "/" || "$ipc_root" == *","* ]]; then
  echo "Gateway must mount a dedicated /user-ipc directory (path cannot contain commas)." >&2
  exit 1
fi
container="dev-mcp-user-$user_id"
if docker container inspect "$container" >/dev/null 2>&1; then
  # A failed docker run may have created the container without starting it.
  # Never restart an exited container: an operator may have stopped its jobs.
  if [[ "${RUNNER_START:-true}" != false && "$(docker inspect --format '{{.State.Status}}' "$container")" == created ]]; then
    docker start "$container"
  fi
  echo "$container already exists; use docker start $container if it is stopped."
  exit 0
fi

# The application never gets Docker access. This host-side helper prepares only
# the user's socket directory; the runner never mounts the parent directory.
docker run --rm --network none --read-only --user 0:0 --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --mount "type=bind,source=$ipc_root,target=/user-ipc" \
  --entrypoint node "$runner_image" -e '
    const fs = require("node:fs");
    const crypto = require("node:crypto");
    const target = "/user-ipc/" + process.argv[1];
    if (fs.existsSync(target) && !fs.lstatSync(target).isDirectory()) {
      throw new Error("Socket target must be a directory, not a symlink");
    }
    fs.mkdirSync(target, { recursive: true, mode: 0o777 });
    fs.chmodSync(target, 0o777);
    const key = "/user-ipc/" + process.argv[1] + ".key";
    if (!fs.existsSync(key)) {
      fs.writeFileSync(key, crypto.randomBytes(32).toString("hex"), { flag: "wx", mode: 0o444 });
    }
    if (!fs.lstatSync(key).isFile() || !/^[a-f0-9]{64}$/.test(fs.readFileSync(key, "utf8").trim())) {
      throw new Error("Invalid existing runner key");
    }
  ' "$user_id"

# Separate bridge networks also keep users' development servers apart.
if ! docker network inspect "$container" >/dev/null 2>&1; then
  docker network create --label "dev-mcp.user=$user_id" "$container" >/dev/null
fi
resource_args=()
for value in "${RUNNER_MEMORY_MIB:-0}" "${RUNNER_PIDS:-0}" "${RUNNER_FILE_SIZE_MIB:-0}"; do
  [[ "$value" =~ ^[0-9]+$ ]] || exit 2
done
[[ "${RUNNER_CPUS:-0}" =~ ^[0-9]+([.][0-9]+)?$ ]] || exit 2
if [[ "${RUNNER_MEMORY_MIB:-0}" != 0 ]]; then
  resource_args+=(--memory "${RUNNER_MEMORY_MIB}m" --memory-swap "${RUNNER_MEMORY_MIB}m")
fi
if [[ "${RUNNER_CPUS:-0}" != 0 ]]; then
  resource_args+=(--cpus "$RUNNER_CPUS")
fi
if [[ "${RUNNER_PIDS:-0}" != 0 ]]; then
  resource_args+=(--pids-limit "$RUNNER_PIDS")
fi
if [[ "${RUNNER_FILE_SIZE_MIB:-0}" != 0 ]]; then
  bytes=$((RUNNER_FILE_SIZE_MIB * 1048576))
  resource_args+=(--ulimit "fsize=$bytes:$bytes")
fi
network="$container"
if [[ "${RUNNER_NETWORK:-true}" == false ]]; then
  network=none
fi
workspace_mount="type=volume,source=$container-workspace,target=/workspace"
data_mount="type=volume,source=$container-data,target=/var/lib/dev-mcp"
if [[ "${RUNNER_QUOTA_STORAGE:-false}" == true ]]; then
  quota_volume="${RUNNER_QUOTA_VOLUME:-dev-mcp-quota-pool}"
  [[ "$quota_volume" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]*$ ]] || exit 2
  workspace_mount="type=volume,source=$quota_volume,target=/workspace,volume-subpath=$user_id/workspace"
  data_mount="type=volume,source=$quota_volume,target=/var/lib/dev-mcp,volume-subpath=$user_id/data"
  resource_args+=(--label dev-mcp.storage=quota)
fi
create_command=(run --detach)
if [[ "${RUNNER_START:-true}" == false ]]; then
  create_command=(create)
fi
docker "${create_command[@]}" --name "$container" --label "dev-mcp.user=$user_id" \
  --network "$network" "${resource_args[@]}" \
  --read-only --init --restart unless-stopped \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,exec,mode=1777 \
  --mount "$workspace_mount" \
  --mount "$data_mount" \
  --mount "type=bind,source=$ipc_root/$user_id,target=/ipc" \
  --mount "type=bind,source=$ipc_root/$user_id.key,target=/run/dev-mcp-ipc-key,readonly" \
  --env WORKSPACE_ROOT=/workspace --env RUNNER_DATA_DIR=/var/lib/dev-mcp \
  --env RUNNER_SOCKET=/ipc/runner.sock \
  --env RUNNER_IPC_SECRET_FILE=/run/dev-mcp-ipc-key \
  --env "GIT_AUTHOR_NAME=Dev MCP user $user_id" \
  --env "GIT_AUTHOR_EMAIL=$user_id@users.dev-mcp.invalid" \
  "$runner_image"

echo "Created $container. Refresh the user's execution environment in /admin."
echo "Workspace volume: $container-workspace"
echo "Runtime/log volume: $container-data"
echo "To stop running jobs: docker stop $container"
echo "To recreate after rebuilding the runner image: docker stop $container && docker rm $container"
echo "Then run this script again. Keep the named volumes to preserve projects and logs."
