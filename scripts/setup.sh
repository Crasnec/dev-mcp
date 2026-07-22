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

default_workspace="${WORKSPACE_DIR:-$HOME/workspace}"
prompt_required "Host workspace directory" "$default_workspace"
workspace_dir="$REPLY_VALUE"
mkdir -p "$workspace_dir"
workspace_dir="$(cd "$workspace_dir" && pwd -P)"

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

temporary_directory="$(mktemp -d)"
temporary_env=""
cleanup() {
  if [[ -n "$temporary_env" && -e "$temporary_env" ]]; then
    rm -f "$temporary_env"
  fi
  rm -rf "$temporary_directory"
}
trap cleanup EXIT
hash_file="$temporary_directory/admin-password.hash"

node_usable=false
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || true)"
  if [[ "$node_major" =~ ^[0-9]+$ && "$node_major" -ge 22 ]]; then
    node_usable=true
  fi
fi

if [[ "$node_usable" == true ]]; then
  node scripts/hash-password.mjs --output "$hash_file"
else
  echo "Node.js 22 was not found; using a temporary container for password hashing."
  "${docker_command[@]}" run --rm -it \
    --user "$(id -u):$(id -g)" \
    --mount "type=bind,src=$repository_root/scripts/hash-password.mjs,dst=/opt/hash-password.mjs,readonly" \
    --mount "type=bind,src=$temporary_directory,dst=/output" \
    node:22-alpine \
    node /opt/hash-password.mjs --output /output/admin-password.hash
fi

admin_password_hash="$(tr -d '\r\n' <"$hash_file")"
if [[ ! "$admin_password_hash" =~ ^scrypt: ]]; then
  echo "Password hash generation failed." >&2
  exit 1
fi

git_author_name="${GIT_AUTHOR_NAME:-$(git config --global user.name 2>/dev/null || true)}"
git_author_email="${GIT_AUTHOR_EMAIL:-$(git config --global user.email 2>/dev/null || true)}"

acme_ca="https://acme-staging-v02.api.letsencrypt.org/directory"
if [[ "$production" == true ]]; then
  acme_ca="https://acme-v02.api.letsencrypt.org/directory"
fi

env_quote() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

temporary_env="$(mktemp "$repository_root/.env.tmp.XXXXXX")"
chmod 600 "$temporary_env"
{
  printf 'WORKSPACE_DIR=%s\n' "$(env_quote "$workspace_dir")"
  printf 'CADDYFILE_PATH=%s\n' "$(env_quote "$repository_root/Caddyfile")"
  printf 'DEV_UID=%s\n' "$dev_uid"
  printf 'DEV_GID=%s\n\n' "$dev_gid"
  printf 'MCP_DOMAIN=%s\n' "$mcp_domain"
  printf 'ACME_EMAIL=%s\n' "$acme_email"
  printf 'ACME_CA=%s\n\n' "$acme_ca"
  printf 'ADMIN_PASSWORD_HASH=%s\n\n' "$admin_password_hash"
  printf 'MAX_CONCURRENT_COMMANDS=4\n'
  printf 'MAX_CONCURRENT_PROCESSES=8\n'
  printf 'DEFAULT_COMMAND_TIMEOUT_MS=0\n'
  printf 'MAX_OUTPUT_BYTES=65536\n\n'
  printf 'GIT_AUTHOR_NAME=%s\n' "$(env_quote "$git_author_name")"
  printf 'GIT_AUTHOR_EMAIL=%s\n' "$(env_quote "$git_author_email")"
} >"$temporary_env"
mv "$temporary_env" .env
temporary_env=""
chmod 600 .env

"${docker_command[@]}" compose config --quiet
echo "Configuration written to $repository_root/.env"

if [[ "$start" == true ]]; then
  "${docker_command[@]}" compose up -d --build
  "${docker_command[@]}" compose ps
  echo
  echo "dev-mcp is starting at https://$mcp_domain/mcp"
  echo "After DNS and ports 80/443 are ready, run:"
  echo "  ./scripts/verify-deployment.sh"
  if [[ "$production" != true ]]; then
    echo "After staging verification, rerun setup with --force --production."
  fi
fi
