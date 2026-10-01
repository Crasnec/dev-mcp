#!/usr/bin/env bash
# One-time move of an older installation's shared "primary" runner account to
# a dedicated runner like every other account. Run on the Docker host from this
# repository after building the new images and stopping gateway and
# provisioner. Without --apply it only inspects and prints the plan.
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repository_root"
apply=false
case "${1:-}" in
  "") ;;
  --apply) apply=true ;;
  *)
    echo "Usage: ./scripts/migrate-primary-runner.sh [--apply]" >&2
    exit 2
    ;;
esac

project="${COMPOSE_PROJECT_NAME:-dev-mcp}"
runner_image="${RUNNER_IMAGE:-dev-mcp-runner:latest}"
gateway_image="${GATEWAY_IMAGE:-$project-gateway:latest}"
provisioner_image="${PROVISIONER_IMAGE:-$project-provisioner:latest}"
helper=(docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true)

service_container() {
  docker ps -a --filter "label=com.docker.compose.project=$project" \
    --filter "label=com.docker.compose.service=$1" \
    --filter label=com.docker.compose.oneoff=False --format '{{.ID}}'
}
mount_of() {
  docker inspect --format "{{range .Mounts}}{{if eq .Destination \"$2\"}}$3{{end}}{{end}}" "$1"
}

legacy="$(service_container runner)"
if [[ -z "$legacy" ]]; then
  echo "No legacy primary runner container; nothing to migrate."
  exit 0
fi
if [[ "$legacy" == *$'\n'* ]]; then
  echo "More than one legacy runner container matches; migrate manually." >&2
  exit 1
fi
for service in gateway provisioner; do
  id="$(service_container "$service")"
  if [[ -z "$id" || "$id" == *$'\n'* ]]; then
    echo "Expected one $service container to locate its volumes." >&2
    exit 1
  fi
  if [[ "$(docker inspect --format '{{.State.Running}}' "$id")" == true ]]; then
    echo "Stop gateway and provisioner first (include your Compose overlays):" >&2
    echo "  docker compose ... stop gateway provisioner" >&2
    exit 1
  fi
  declare "${service}_id=$id"
done
workspace="$(mount_of "$legacy" /workspace '{{if eq .Type "bind"}}{{.Source}}{{end}}')"
data_volume="$(mount_of "$legacy" /var/lib/dev-mcp '{{if eq .Type "volume"}}{{.Name}}{{end}}')"
gateway_data="$(mount_of "$gateway_id" /var/lib/dev-mcp '{{.Name}}')"
runner_status="$(mount_of "$provisioner_id" /runner-status '{{.Name}}')"
if [[ "$workspace" != /* || "$workspace" == "/" || "$workspace" == *","* \
  || -z "$data_volume" || -z "$gateway_data" || -z "$runner_status" ]]; then
  echo "Could not determine the legacy workspace, data volume or service volumes." >&2
  exit 1
fi
for image in "$runner_image" "$gateway_image" "$provisioner_image"; do
  docker image inspect "$image" >/dev/null 2>&1 || {
    echo "Build $image first." >&2
    exit 1
  }
done

account="$("${helper[@]}" --user 10001:10001 \
  --mount "type=volume,source=$gateway_data,target=/data,readonly" \
  --entrypoint node "$gateway_image" scripts/migrate-primary-account.mjs \
  inspect /data/users.json "" "$workspace")"
if [[ "$account" == *'"none":true'* ]]; then
  echo "No account uses the primary runner; nothing to migrate."
  exit 0
fi
user_id="$(sed -n 's/.*"id":"\([0-9a-f-]\{36\}\)".*/\1/p' <<<"$account")"
if [[ ! "$user_id" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo "Could not read the primary runner account." >&2
  exit 1
fi
container="dev-mcp-user-$user_id"
if docker container inspect "$container" >/dev/null 2>&1 \
  || docker volume inspect "$container-data" >/dev/null 2>&1; then
  echo "$container or $container-data already exists; resolve it before migrating." >&2
  exit 1
fi
owner="$("${helper[@]}" --mount "type=bind,source=$workspace,target=/workspace,readonly" \
  --entrypoint node "$runner_image" \
  -e 'console.log(require("fs").statSync("/workspace").uid === process.getuid() ? "ok" : "invalid")')"
if [[ "$owner" != ok ]]; then
  echo "$workspace must be owned by the runner user (DEV_UID)." >&2
  exit 1
fi

cat <<EOF
Legacy primary runner: $legacy
Account:               $user_id
Workspace (kept):      $workspace
Runtime data:          $data_volume -> $container-data (copied)
Account records:       $gateway_data (backup: users.json.pre-primary-migration)
Workspace registry:    $runner_status
EOF
if [[ "$apply" != true ]]; then
  echo
  echo "Dry run only. Re-run with --apply to migrate."
  exit 0
fi

docker stop "$legacy" >/dev/null
docker volume create --label "dev-mcp.user=$user_id" "$container-data" >/dev/null
# Mounted where the image owns the directory, so the copy runs as DEV_UID and
# keeps project IDs, process logs and output cursors.
"${helper[@]}" --mount "type=volume,source=$data_volume,target=/source,readonly" \
  --mount "type=volume,source=$container-data,target=/var/lib/dev-mcp" \
  --entrypoint cp "$runner_image" -a /source/. /var/lib/dev-mcp/
"${helper[@]}" --user 0:0 --mount "type=volume,source=$runner_status,target=/status" \
  --entrypoint node "$provisioner_image" -e '
    const fs = require("node:fs");
    const [id, workspace] = process.argv.slice(1);
    const file = "/status/workspace-dirs.json";
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { users: {} };
    data.users ??= {};
    if (data.users[id]) {
      throw new Error("A workspace is already registered for this account");
    }
    data.users[id] = { path: workspace, legacy: true };
    fs.writeFileSync(file + ".tmp", JSON.stringify(data));
    fs.renameSync(file + ".tmp", file);
  ' "$user_id" "$workspace"
"${helper[@]}" --user 10001:10001 \
  --mount "type=volume,source=$gateway_data,target=/data" \
  --entrypoint node "$gateway_image" scripts/migrate-primary-account.mjs \
  apply /data/users.json "$user_id"

cat <<EOF

Migrated. Start the services (include your Compose overlays):
  docker compose ... up -d --no-deps gateway provisioner
The provisioner creates $container with $workspace at /workspace and a new
signed IPC key. Background processes from the old runner are not restarted.

Rollback (keep these until the new runner is verified): stop gateway and
provisioner, remove $container, restore users.json.pre-primary-migration in
$gateway_data, delete the "$user_id" entry from workspace-dirs.json in
$runner_status, start $legacy and redeploy the previous gateway and
provisioner images. $data_volume is left untouched.
EOF
