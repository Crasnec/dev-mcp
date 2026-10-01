#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repository_root"

force=false
start=true
production=false
for argument in "$@"; do
  case "$argument" in
    --force)
      force=true
      ;;
    --no-start)
      start=false
      ;;
    --production)
      production=true
      ;;
    --help|-h)
      cat <<'EOF'
Usage: ./scripts/setup.sh [--force] [--no-start] [--production]

Creates a private .env file for the current host and optionally builds and
starts dev-mcp. The default ACME endpoint is Let's Encrypt staging.

  --force       replace an existing .env file
  --no-start    configure only; do not run Docker Compose
  --production  use the Let's Encrypt production endpoint
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $argument" >&2
      exit 2
      ;;
  esac
done

if [[ ! -t 0 || ! -t 1 ]]; then
  echo "Setup requires an interactive terminal." >&2
  exit 2
fi

if [[ -f .env && "$force" != true ]]; then
  echo ".env already exists; use --force to replace it." >&2
  exit 2
fi

for command in docker git; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "$command is required." >&2
    exit 2
  fi
done

docker_command=(docker)
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1 && sudo docker info >/dev/null 2>&1; then
    docker_command=(sudo docker)
  else
    echo "The current user cannot access the Docker daemon." >&2
    exit 2
  fi
fi
if ! "${docker_command[@]}" compose version >/dev/null 2>&1; then
  echo "Docker Compose v2 is required." >&2
  exit 2
fi

prompt_required() {
  local label="$1"
  local default_value="${2:-}"
  local value=""
  while [[ -z "$value" ]]; do
    if [[ -n "$default_value" ]]; then
      read -r -p "$label [$default_value]: " value
      value="${value:-$default_value}"
    else
      read -r -p "$label: " value
    fi
  done
  REPLY_VALUE="$value"
}

prompt_required "Public MCP domain (hostname only)" "${MCP_DOMAIN:-}"
mcp_domain="$REPLY_VALUE"
if [[ ! "$mcp_domain" =~ ^[A-Za-z0-9.-]+$ || "$mcp_domain" != *.* ]]; then
  echo "MCP domain must be a hostname such as mcp.example.com." >&2
  exit 2
fi

prompt_required "ACME account email" "${ACME_EMAIL:-}"
acme_email="$REPLY_VALUE"
if [[ ! "$acme_email" =~ ^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$ ]]; then
  echo "Enter a valid email address." >&2
  exit 2
fi

detected_uid="${SUDO_UID:-$(id -u)}"
detected_gid="${SUDO_GID:-$(id -g)}"
if [[ "$detected_uid" == 0 ]]; then
  detected_uid=1000
fi
if [[ "$detected_gid" == 0 ]]; then
  detected_gid=1000
fi
dev_uid="${DEV_UID:-$detected_uid}"
dev_gid="${DEV_GID:-$detected_gid}"
if [[ ! "$dev_uid" =~ ^[1-9][0-9]*$ || ! "$dev_gid" =~ ^[1-9][0-9]*$ ]]; then
  echo "DEV_UID and DEV_GID must be positive integers." >&2
  exit 2
fi

# Every account, the administrator included, gets <root>/<name> under this
# directory. It is only prepared here; the root is chosen during onboarding.
setup_user="${SUDO_USER:-$(id -un)}"
user_home="$(getent passwd "$setup_user" 2>/dev/null | cut -d: -f6 || true)"
default_root="${user_home:-$HOME}/dev-mcp-workspaces"
prompt_required "Host directory for account workspaces (confirmed during onboarding)" "$default_root"
workspace_root="$REPLY_VALUE"
mkdir -p "$workspace_root"
workspace_root="$(cd "$workspace_root" && pwd -P)"
if [[ "$(id -u)" == 0 ]]; then
  chown "$dev_uid:$dev_gid" "$workspace_root"
fi

acme_ca="https://acme-staging-v02.api.letsencrypt.org/directory"
if [[ "$production" == true ]]; then
  acme_ca="https://acme-v02.api.letsencrypt.org/directory"
fi

temporary_env=""
cleanup() {
  if [[ -n "$temporary_env" && -e "$temporary_env" ]]; then
    rm -f "$temporary_env"
  fi
}
trap cleanup EXIT

env_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

temporary_env="$(mktemp "$repository_root/.env.tmp.XXXXXX")"
chmod 600 "$temporary_env"
{
  printf 'CADDYFILE_PATH=%s\n' "$(env_quote "$repository_root/Caddyfile")"
  printf 'DEV_UID=%s\n' "$dev_uid"
  printf 'DEV_GID=%s\n\n' "$dev_gid"
  printf 'MCP_DOMAIN=%s\n' "$mcp_domain"
  printf 'ACME_EMAIL=%s\n' "$acme_email"
  printf 'ACME_CA=%s\n' "$acme_ca"
} >"$temporary_env"
mv "$temporary_env" .env
temporary_env=""
chmod 600 .env

"${docker_command[@]}" compose config --quiet
echo "Configuration written to $repository_root/.env"

if [[ "$start" == true ]]; then
  # The runner image is built only; the provisioner starts one runner per account.
  "${docker_command[@]}" compose build runner
  "${docker_command[@]}" compose up -d --build
  "${docker_command[@]}" compose ps
  echo
  echo "dev-mcp is starting at https://$mcp_domain/mcp"
  echo "After DNS and ports 80/443 are ready, run:"
  echo "  ./scripts/verify-deployment.sh"
  if [[ "$production" != true ]]; then
    echo "After staging verification, rerun setup with --force --production."
  fi
  echo
  echo "Finish the installation in the local onboarding page (not served on $mcp_domain):"
  echo "  1. Sign up with the intended administrator's Google account at https://$mcp_domain/signup"
  echo "  2. On this host open http://127.0.0.1:3100/, or from a workstation run:"
  echo "       ssh -L 3100:127.0.0.1:3100 <this-host>"
  echo "  3. Enter the one-time code from:"
  echo "       ${docker_command[*]} compose logs gateway | grep onboarding_available"
  echo "  4. Set the workspace root to $workspace_root so each account,"
  echo "     the administrator included, gets a host directory that VS Code can open."
fi
