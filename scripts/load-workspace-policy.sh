#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "$(docker info --format '{{json .SecurityOptions}}')" != *name=apparmor* ]]; then
  echo "Docker does not use AppArmor; no workspace AppArmor policy was loaded."
  exit 0
fi

docker build -f docker/workspace-policy.Dockerfile -t dev-mcp-workspace-policy:latest .
# A fixed policy loader with no account mounts or Docker socket. Persist the
# profile for the host's AppArmor service to reload after reboot.
docker run --rm --network none --cap-drop ALL --cap-add MAC_ADMIN \
  --security-opt apparmor=unconfined --security-opt no-new-privileges:true \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,mode=1777 \
  --mount type=bind,source=/sys/kernel/security,target=/sys/kernel/security \
  --mount type=bind,source=/etc/apparmor.d,target=/host-apparmor \
  dev-mcp-workspace-policy:latest
echo "Loaded and persisted dev-mcp-workspace. Set WORKSPACE_APPARMOR_PROFILE=dev-mcp-workspace in .env."
