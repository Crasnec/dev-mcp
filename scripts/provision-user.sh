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
if [[ -z "$gateway_id" ]]; then
  echo "Start the updated gateway with Docker Compose first." >&2
  exit 1
fi
ipc_root="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/user-ipc"}}{{.Source}}{{end}}{{end}}' "$gateway_id")"
# Built by `docker compose build runner`; the provisioner passes a pinned ID.
runner_image="${RUNNER_IMAGE_ID:-$(docker image inspect --format '{{.Id}}' "${RUNNER_IMAGE:-dev-mcp-runner:latest}" 2>/dev/null || true)}"
if [[ ! "$runner_image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Build the runner image first: docker compose build runner" >&2
  exit 1
fi
if [[ -z "$ipc_root" || "$ipc_root" == "/" || "$ipc_root" == *","* ]]; then
  echo "Gateway must mount a dedicated /user-ipc directory (path cannot contain commas)." >&2
  exit 1
fi
container="${RUNNER_CONTAINER_NAME:-}"
if [[ -z "$container" ]]; then
  # Manual provisioning uses the same email-derived name as the controller.
  container="$(docker exec "$gateway_id" node -e '
    const fs = require("node:fs");
    const id = process.argv[1];
    const db = JSON.parse(fs.readFileSync((process.env.GATEWAY_DATA_DIR || "/var/lib/dev-mcp") + "/users.json", "utf8"));
    const user = db.users.find(user => user.id === id && user.runner === id);
    if (!user) { throw new Error("Account not found"); }
    const local = String(user.email || "").split("@")[0].toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "")
      .slice(0, 64).replace(/[-._]+$/, "");
    console.log("dev-mcp-user-" + (local || id));
  ' "$user_id")"
  if [[ "$container" != "dev-mcp-user-$user_id" ]] && docker container inspect "dev-mcp-user-$user_id" >/dev/null 2>&1; then
    echo "Let the updated provisioner migrate the existing UUID-named container first." >&2
    exit 1
  fi
fi
if [[ ! "$container" =~ ^dev-mcp-user-[a-z0-9][a-z0-9._-]{0,63}$ ]]; then
  echo "Invalid development container name." >&2
  exit 2
fi
if docker container inspect "$container" >/dev/null 2>&1; then
  if [[ "$(docker inspect --format '{{index .Config.Labels "dev-mcp.user"}}' "$container")" != "$user_id" ]]; then
    echo "Cannot verify ownership of $container." >&2
    exit 1
  fi
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
elif [[ "$(docker network inspect --format '{{index .Labels "dev-mcp.user"}}' "$container")" != "$user_id" ]]; then
  echo "Cannot verify ownership of network $container." >&2
  exit 1
fi
resource_args=()
if [[ "${RUNNER_KEEP_STOPPED:-false}" == true ]]; then
  resource_args+=(--label dev-mcp.keep-stopped=true)
fi
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
# The provisioner creates and verifies this directory under the workspace root
# chosen during local onboarding, so host editors such as VS Code can open it.
workspace_host_dir="${RUNNER_WORKSPACE_HOST_DIR:-}"
if [[ -n "$workspace_host_dir" ]]; then
  if [[ "${RUNNER_QUOTA_STORAGE:-false}" == true || "$workspace_host_dir" != /* \
    || "$workspace_host_dir" == "/" || "$workspace_host_dir" == *","* ]]; then
    echo "Workspace host directory must be an absolute path without commas and cannot use quota storage." >&2
    exit 2
  fi
  workspace_mount="type=bind,source=$workspace_host_dir,target=/workspace"
  resource_args+=(--label dev-mcp.workspace=host)
fi
create_command=(run --detach)
if [[ "${RUNNER_QUOTA_STORAGE:-false}" != true ]]; then
  volume_names=("$container-data")
  if [[ -z "$workspace_host_dir" ]]; then
    volume_names+=("$container-workspace")
  fi
  for volume in "${volume_names[@]}"; do
    if ! docker volume inspect "$volume" >/dev/null 2>&1; then
      docker volume create --label "dev-mcp.user=$user_id" "$volume" >/dev/null
    elif [[ "$container" != "dev-mcp-user-$user_id" \
      && "$(docker volume inspect --format '{{index .Labels "dev-mcp.user"}}' "$volume")" != "$user_id" ]]; then
      echo "Cannot verify ownership of $volume." >&2
      exit 1
    fi
  done
fi
ssh_args=()
if [[ "${WORKSPACE_SSH_ENABLED:-false}" == true ]]; then
  ssh_args+=(--mount "type=volume,source=${WORKSPACE_AUTH_VOLUME:-dev-mcp-workspace-auth},target=/run/dev-mcp-ssh,volume-subpath=$user_id,readonly")
  ssh_args+=(--env SSH_WORKSPACE=true --env SSH_MANIFEST_FILE=/run/dev-mcp-ssh/access.json --env SSH_CONFIG_FILE=/etc/ssh/dev-mcp-sshd_config)
fi
if [[ "${RUNNER_START:-true}" == false ]]; then
  create_command=(create)
fi
docker "${create_command[@]}" --name "$container" --label "dev-mcp.user=$user_id" \
  --label "dev-mcp.name=${container#dev-mcp-user-}" \
  --label dev-mcp.runtime=unified \
  --network "$network" "${resource_args[@]}" \
  --init --restart unless-stopped "${ssh_args[@]}" \
  --tmpfs /tmp:rw,nosuid,nodev,exec,mode=1777 \
  --mount "$workspace_mount" \
  --mount "$data_mount" \
  --mount "type=bind,source=$ipc_root/$user_id,target=/ipc" \
  --mount "type=bind,source=$ipc_root/$user_id.key,target=/run/dev-mcp-ipc-key,readonly" \
  --env WORKSPACE_ROOT=/workspace --env RUNNER_DATA_DIR=/var/lib/dev-mcp \
  --env RUNNER_SOCKET=/ipc/runner.sock \
  --env RUNNER_IPC_SECRET_FILE=/run/dev-mcp-ipc-key \
  --env "GIT_AUTHOR_NAME=${RUNNER_GIT_AUTHOR_NAME:-Dev MCP user $user_id}" \
  --env "GIT_AUTHOR_EMAIL=${RUNNER_GIT_AUTHOR_EMAIL:-$user_id@users.dev-mcp.invalid}" \
  "$runner_image"

echo "Created $container. Refresh the user's execution environment in /admin."
if [[ -n "$workspace_host_dir" ]]; then
  echo "Workspace host directory: $workspace_host_dir"
else
  echo "Workspace volume: $container-workspace"
fi
echo "Runtime/log volume: $container-data"
echo "To stop running jobs: docker stop $container"
echo "To recreate after rebuilding the runner image: docker stop $container && docker rm $container"
echo "Then run this script again. Keep the named volumes to preserve projects and logs."
