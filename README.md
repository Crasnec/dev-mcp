# dev-mcp

`dev-mcp` is a self-contained Docker Compose deployment that lets ChatGPT use MCP tools to work with files, shell commands, background processes, and Git in one host directory. It does not use an OpenAI API key, run Codex CLI, or expose the Docker socket to the gateway or runners. A separate trusted provisioner uses Docker access to create approved users' containers.

```text
Internet / ChatGPT
        │ HTTPS :443
        ▼
      Caddy ── internal HTTP ──▶ gateway ── Unix socket ──▶ runner
                                   │                         │
                              gateway-data              /workspace:rw
                           (users + OAuth)               runner-data
```

The gateway cannot see `/workspace`. The runner cannot see OAuth state or the administrator password hash. The services use separate Docker networks and share only the runner's Unix socket volume.

New users have dedicated runner containers, workspace/log volumes, IPC keys, and Docker bridge networks. The existing runner belongs to the initial administrator. Project access follows workspace ownership: users can access every project in their own runner, and cannot access another user's workspace. Sharing an individual project between users is not supported.

## Accounts and administration

- `/signup`: Google-only registration; new accounts remain pending until approved. Password signup is rejected server-side.
- `/login` and `/account`: Google sign-in, project overview, and explicit Google linking for existing accounts. Existing password accounts retain login/password-change access; new Google accounts have no local password.
- `/admin`: ERP-style dashboard with a persistent navigation sidebar. Each management area and detail view has its own URL (see below).
- On the first startup, `users.json` is created with username `admin` and the existing `ADMIN_PASSWORD_HASH`. Change the password from the account page. Later startups do not overwrite that password.
- Existing OAuth credentials without a user identity are rejected after upgrading. Reconnect each MCP client, sign in with Google (or an existing password account), and explicitly approve its requested permissions.
- Passwords use scrypt. Browser session tokens are stored as hashes and sent in HttpOnly, SameSite=Lax cookies (Secure on HTTPS). Forms require CSRF tokens. The final active administrator cannot be disabled or demoted.
- Password changes, account status/role changes, and “revoke all” invalidate previous browser sessions, OAuth codes/tokens, MCP session reuse, and signed image URLs. Already running commands are not killed automatically.

### Google login setup

1. Prepare a Google **Web application** OAuth client. In its authorized redirect URIs, **add** `https://<MCP_DOMAIN>/auth/google/callback` without removing plan-app's existing callback URIs. The full URI must match, including scheme and path. See [Google's OIDC setup](https://developers.google.com/identity/openid-connect/openid-connect#redirect-uri).
2. From this repository, run `node scripts/import-google-secrets.mjs` (optional argument: the source directory). This copies `../plan-app/oauth-id.txt` and `oauth-secret.txt` as opaque files, without printing or parsing their contents. Each source must contain only the credential value; a trailing newline is accepted at runtime. Existing destination files are never overwritten.
3. Enable the secrets overlay when deploying:

   ```bash
   docker compose -f compose.yaml -f compose.google.yaml up -d --build
   ```

   Continue including the overlay for subsequent Compose operations. If Docker runs in another filesystem namespace, set `GOOGLE_CLIENT_ID_SOURCE` and `GOOGLE_CLIENT_SECRET_SOURCE` to the copied files' absolute paths **on the Docker host**. Do not point the container at an unreadable owner-only source file or make plan-app's original files public.
4. The initial administrator signs in using the existing password, then opens **내 계정 → Google 계정 연결** before using that Google identity for login. Linking preserves the account ID, administrator role and primary workspace, while invalidating old sessions/MCP credentials. Signing in with a new Google identity first creates a separate pending account; accounts are never auto-merged by email.

Copied files live inside a mode-0700 `data/google` directory; individual files are read-only and readable by the non-root gateway through Compose secret mounts. Neither the directory nor the source filenames are included in Git or the Docker build context. Only the gateway receives these mounts. Never print `docker compose config` with credentials supplied as literal environment values. For non-Docker runs, configure `GOOGLE_CLIENT_ID_FILE` and `GOOGLE_CLIENT_SECRET_FILE` (or the corresponding environment values, but never both).

The gateway validates the ID token's signature, issuer, audience, expiry, nonce, authorized party and verified email, and identifies accounts by Google's stable `sub`, **not email**. It requests only `openid email` and does not retain Google access/refresh tokens. The callback uses single-use state bound to an HttpOnly browser cookie plus PKCE. Pending/disabled accounts cannot receive login sessions or MCP tokens. Closing registration blocks new Google identities but leaves existing users able to log in. Without Google credentials, new signup remains unavailable (it never falls back to password signup).

For MCP connections, Google login returns to a browser-bound consent page, never directly to the external client's callback. The user must approve the requested scopes, with session CSRF protection. Unfinished Google login state expires after 10 minutes or a gateway restart. Auth callback/consent URLs are excluded from Caddy access logging to avoid logging codes or transaction identifiers. The application records sanitized authentication audit events instead. Other upstream proxies must apply equivalent redaction.

### Management pages

| URL | Management functions |
| --- | --- |
| `/account` | Current user's runner, projects, Google link, and password settings |
| `/admin` | User/approval/session/client counts, pending approvals, recent activity |
| `/admin/users` | Search and status filters; account detail, approval, suspension, role changes, revoke all authentication |
| `/admin/projects` | Owner-specific project list and search; register existing directories; Git status; unregister or permanently delete with name confirmation |
| `/admin/runners` | Per-user connectivity and project counts; detail pages with host provisioning/stop commands |
| `/admin/processes` | Owner/status filters; process detail, paged logs, stop a running process |
| `/admin/connections` | Browser sessions and individual revocation; OAuth clients, callback URLs and grant counts; client removal with ID confirmation |
| `/admin/audit` | Searchable, event-filtered audit records; bounded to the most recent 1 MiB of the log |
| `/admin/settings` | Open/close new registrations and edit the signup notice; read-only deployment/isolation information |

Lists are paginated (25 records); browser sessions and OAuth clients have independent pagination on the connections screen. Administrators can manage all users' workspaces, but every operation still targets that owner's isolated runner. Normal users cannot enter administration. All mutations require the administrator's authenticated session, CSRF token, and a matching Origin when present. Removing an OAuth client invalidates its access/refresh tokens and pending authorizations. Project deletion is permanent and does not stop running processes automatically.

Page HTML lives in `packages/gateway/views/**/*.mustache`, separate from TypeScript route logic. Shared layouts and partials provide navigation, forms, notices, and pagination. Edit menu labels/order in `views/admin/navigation.json`; edit styles in `packages/gateway/public/{auth,admin}.css`. `src/views.ts` renders escaped data; only the already-rendered layout body is inserted as HTML. Production templates are cached until restart. Templates and CSS are copied into the gateway image; rebuild the image when changing them. Signup policy persists in `gateway-data/settings.json` and is included in gateway volume backups.

When an administrator approves an account, the `provisioner` service creates its dedicated runner automatically. It checks committed account state every five seconds, also repairs missing runners for already-approved users after a restart, and retries failed creations. Initial startup can take longer while Docker prepares volumes. Pending and disabled users are skipped. Start it when upgrading an existing deployment:

```bash
docker compose up -d --build provisioner
```

Include your usual Compose overlays. On a host sharing an existing reverse proxy, start only the intended services. For manual recovery, open **실행 환경 → 사용자 상세** and run the displayed command on the Docker host:

```bash
./scripts/provision-user.sh <user-uuid>
```

Run it with Docker access (`sudo` if required), after rebuilding and starting the updated gateway and primary runner. It uses the running primary runner's image. No request falls back to the primary runner when a user runner is missing.

The helper creates `dev-mcp-user-<uuid>`, two persistent volumes (`-workspace`, `-data`), a dedicated bridge network, and a per-user authenticated Unix socket. It does not publish ports or mount Docker credentials, the primary workspace, or other users' sockets. Git commits default to a per-user UUID identity. Each user's projects can be cloned via MCP or copied into their workspace volume by the operator.

Set `USER_RUNNER_IPC_DIR` to a dedicated absolute path on the Docker host if the daemon uses a different filesystem namespace. Otherwise it defaults to `./data/user-ipc`. Back up this directory (including the `.key` files), `gateway-data`, and each user's workspace/data volumes.

Only the provisioner has Docker access. It has no network or HTTP endpoint and reads `gateway-data` read-only. Its logs contain provisioning success/failure events with account UUIDs (`docker compose logs provisioner`); a failed creation is retried on the next pass. Treat this service as a trusted host administrator. To stop existing jobs after disabling a user:

```bash
docker stop dev-mcp-user-<uuid>
```

After updating the runner image, stop and remove that user's container, then rerun the provisioning command. Preserve the named volumes to retain projects and logs. Do not remove volumes as part of an upgrade. Running and intentionally stopped containers are left untouched; use `docker start` to resume a stopped environment. A container left in the `created` state by a failed start is retried. Stop the provisioner during maintenance if you need to keep an active user's container absent. Dedicated runners are separate from the main Compose stack and must be stopped/backed up explicitly.

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

| Area      | Tools                                                                                       |
| --------- | ------------------------------------------------------------------------------------------- |
| Projects  | `project_list`, `project_register`, `project_clone`, `project_unregister`, `project_delete` |
| Files     | `file_list`, `file_read`, `image_read`, `file_search`, `file_apply_patch`                   |
| Commands  | `command_run`, `command_output`                                                             |
| Processes | `process_start`, `process_list`, `process_logs`, `process_stop`                             |
| Git       | `git_read`, `git_commit`                                                                 |

The catalog has 18 tools. Use `git_read` with `operation: "status" | "diff" | "log"`; `staged` applies to diffs and `limit` to logs. This replaces `git_status`, `git_diff`, and `git_log`. Use `process_list` (optionally filtered by `project_id`) for current process state instead of `process_status`. Refresh the connected client's tool catalog after updating.

The browser UI contains connection instructions, OAuth consent, and error pages. The separate `/security` introduction page has been removed; the security model is documented below.

`command_run` and `process_start` require `network_intent` to be `none`, `read`, or `write`. This value is used for OAuth authorization, ChatGPT confirmation policy, and auditing; it is not a runner-side network firewall. Command and Git output over 64 KiB is saved in runner data and paginated through `command_output`. Process logs use the `process_logs` cursor.

`image_read` validates a project image and returns a short-lived HTTPS URL. The gateway serves the image through the runner without mounting the workspace into the gateway; the URL is a bearer credential and expires after ten minutes.

Tool annotations distinguish reads, writes, destructive actions, and external communication. Shell calls always advertise `destructiveHint: true` and `openWorldHint: true`. The design follows the [OpenAI tool guidance](https://developers.openai.com/apps-sdk/plan/tools).

## OAuth scopes

The gateway provides:

- `/.well-known/oauth-protected-resource` and path-specific `/mcp` metadata;
- `/.well-known/oauth-authorization-server`;
- `/oauth/register`, `/oauth/authorize`, `/oauth/token`, and `/oauth/revoke`.

It supports approved user accounts using Authorization Code + PKCE (S256) and public-client DCR. Authorization codes are one-time and valid for five minutes. Access tokens last 15 minutes, refresh tokens last 30 days, and refresh tokens rotate on use. Codes and tokens are stored only as SHA-256 hashes in `gateway-data` and bound to a user and credential version.

| Scope             | Operations                                                   |
| ----------------- | ------------------------------------------------------------ |
| `workspace:read`  | Project, file, and Git reads                                 |
| `workspace:write` | Registration, patching, deletion, and commits                |
| `command:run`     | Synchronous commands, processes, and logs                    |
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
