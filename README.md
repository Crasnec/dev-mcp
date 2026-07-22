# dev-mcp

`dev-mcp` is a self-contained Docker Compose deployment that lets ChatGPT use MCP tools to work with files, shell commands, background processes, and Git in one host directory. It does not use an OpenAI API key, run Codex CLI, or expose the Docker socket to the MCP services.

```text
Internet / ChatGPT
        │ HTTPS :443
        ▼
      Caddy ── internal HTTP ──▶ gateway ── Unix socket ──▶ runner
                                   │                         │
                              gateway-data              /workspace:rw
                              (OAuth only)               runner-data
```

The gateway cannot see `/workspace`. The runner cannot see OAuth state or the administrator password hash. The services use separate Docker networks and share only the runner's Unix socket volume.

## Requirements

- A Linux host with Docker Engine and Docker Compose v2
- Git, for cloning this repository
- A public DNS A/AAAA record pointing to the host
- Inbound TCP 80/443; UDP 443 is recommended for HTTP/3

The runner builds directly from the official `fedora:44` image. No local base image, dev container repository, host Node.js installation, Codex installation, Docker socket, SSH key, or host home mount is required.

## Quick setup

On a new host:

```bash
git clone https://github.com/Crasnec/dev-mcp.git
cd dev-mcp
./scripts/setup.sh
```

The interactive setup command:

- creates the host workspace directory;
- detects the host UID and GID;
- asks for the public domain and ACME email;
- generates the administrator scrypt hash without storing the password;
- writes a mode-`0600` `.env` file with absolute host paths;
- builds the Fedora runner, gateway, and Caddy stack;
- starts the services with Docker Compose.

Host Node.js is optional. If Node.js 22 is unavailable, setup uses a temporary `node:22-alpine` container only for password hashing.

Setup uses Let's Encrypt staging by default. Once DNS, HTTPS, OAuth, and MCP tool calls work, switch to production certificates:

```bash
./scripts/setup.sh --force --production
./scripts/verify-deployment.sh
```

`--force` intentionally replaces the host-specific `.env`; the OAuth and runner named volumes are preserved. Use `--no-start` to create and validate `.env` without starting containers.

Certificate issuance requires correct DNS and public access to ports 80 and 443. See the [Caddy HTTPS quick-start](https://caddyserver.com/docs/quick-starts/https) for the external requirements.

## Connect ChatGPT

Enable developer mode, create a developer-mode app, and use this MCP endpoint:

```text
https://<MCP_DOMAIN>/mcp
```

The gateway supports Dynamic Client Registration and opens an Authorization Code + PKCE login page. Follow the [OpenAI ChatGPT connection guide](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt).

After any deployment that changes tool names, descriptions, annotations, or OAuth schemes, open the app in **Settings → Plugins**, choose **Refresh**, and test it in a new conversation. Existing ChatGPT conversations may retain an older tool snapshot.

## Moving to another host

The repository contains everything needed to rebuild the service. On the new host, clone it and run `./scripts/setup.sh`; do not copy `node_modules`, build output, a local development image, SSH credentials, or Codex state.

Host-specific configuration stays in the ignored `.env` file. OAuth clients/tokens, the project registry, process logs, and Caddy certificates live in Docker named volumes and are not part of Git. A fresh host therefore starts with fresh OAuth state; refresh or recreate the ChatGPT app after DNS points to the new deployment.

To migrate state instead of starting clean, back up and restore these volumes using your normal Docker volume procedure:

- `dev-mcp_gateway-data`
- `dev-mcp_runner-data`
- `dev-mcp_caddy-data`
- `dev-mcp_caddy-config`

Do not copy the transient `runner-ipc` volume.

## Manual configuration

If you do not want the setup script:

```bash
cp .env.example .env
chmod 600 .env
npm run password-hash  # requires local Node.js 22 and a TTY
$EDITOR .env
docker compose config --quiet
docker compose up -d --build
./scripts/verify-deployment.sh
```

Set `WORKSPACE_DIR` and `CADDYFILE_PATH` to absolute paths visible to the Docker daemon. Set `DEV_UID` and `DEV_GID` to the owner of the workspace files.

For optional resource limits, add the example override explicitly:

```bash
docker compose -f compose.yaml -f compose.limits.yaml.example up -d --build
```

## MCP tools

Every tool returns a short text summary and structured content in this form:

```json
{
  "ok": true,
  "data": {},
  "truncated": false,
  "continuation": "optional opaque cursor"
}
```

Errors include `error.code`, `error.message`, and optional `error.details`.

| Area | Tools |
|---|---|
| Projects | `project_list`, `project_register`, `project_clone`, `project_unregister`, `project_delete` |
| Files | `file_list`, `file_read`, `file_search`, `file_apply_patch` |
| Commands | `command_run`, `command_output` |
| Processes | `process_start`, `process_list`, `process_status`, `process_logs`, `process_stop` |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit` |

`command_run` and `process_start` require `network_intent` to be `none`, `read`, or `write`. This value is used for OAuth authorization, ChatGPT confirmation policy, and auditing; it is not a runner-side network firewall. Command and Git output over 64 KiB is saved in runner data and paginated through `command_output`. Process logs use the `process_logs` cursor.

Tool annotations distinguish reads, writes, destructive actions, and external communication. Shell calls always advertise `destructiveHint: true` and `openWorldHint: true`. The design follows the [OpenAI tool guidance](https://developers.openai.com/apps-sdk/plan/tools).

## OAuth scopes

The gateway provides:

- `/.well-known/oauth-protected-resource` and path-specific `/mcp` metadata;
- `/.well-known/oauth-authorization-server`;
- `/oauth/register`, `/oauth/authorize`, `/oauth/token`, and `/oauth/revoke`.

It supports a single administrator using Authorization Code + PKCE (S256) and public-client DCR. Authorization codes are one-time and valid for five minutes. Access tokens last 15 minutes, refresh tokens last 30 days, and refresh tokens rotate on use. Codes and tokens are stored only as SHA-256 hashes in `gateway-data`.

| Scope | Operations |
|---|---|
| `workspace:read` | Project, file, and Git reads |
| `workspace:write` | Registration, patching, deletion, and commits |
| `command:run` | Synchronous commands, processes, and logs |
| `command:network` | Cloning or commands/processes with non-`none` network intent |

Each tool publishes its OAuth policy. Insufficient-scope results include an MCP authentication challenge so ChatGPT can request additional authorization. The implementation follows the [OpenAI Apps SDK authentication requirements](https://developers.openai.com/apps-sdk/build/auth) and the MCP OAuth protected-resource model.

## Security boundary

- Only the runner receives `${WORKSPACE_DIR}` as `/workspace:rw`. The workspace root itself cannot be registered as a project.
- File paths receive lexical checks followed by `realpath` checks. Absolute paths, parent traversal, symlink escapes, and patch escapes are rejected.
- Public cloning accepts credential-free HTTPS URLs from GitHub, GitLab, and Bitbucket. SSH, URL credentials, loopback, and private targets are rejected.
- Neither service receives the Docker socket, SSH keys, host home, `~/.codex`, or Codex credentials.
- Child processes receive a clean `PATH`, runner-only `HOME`, locale, and optional Git author values. Gateway variables and OAuth tokens are not inherited.
- Gateway and runner use read-only root filesystems, dropped capabilities, non-root users, and `no-new-privileges`.
- The runner image includes Bash, Git, ripgrep, Node.js, Python, Rust, and common native build tools, but no Docker CLI, Codex CLI, or `sudo`.
- Compose applies no default CPU, memory, or command-duration limit. It limits synchronous commands to four and background processes to eight by default; `.env` can change these values.
- Audit records are stored in `gateway-data/audit.jsonl`. Patch bodies and continuation/token values are omitted; command strings are limited to 2,000 characters.

This service deliberately exposes arbitrary shell execution and destructive file operations to an OAuth-authorized client. Use a unique administrator password and consider firewall, rate limiting, or an additional access-control layer.

## Development and verification

```bash
npm ci
npm run style
npm run typecheck
npm test
npm run build
docker compose config --quiet
```

Tests cover PKCE, one-time codes, refresh rotation, revocation, path and symlink escapes, project registration through commit, long-output pagination, and background process lifecycle. After deployment, `scripts/verify-deployment.sh` checks public HTTPS metadata, the authentication challenge, mount isolation, network separation, and read-only roots.
