# dev-mcp

`dev-mcp` is a self-contained Docker Compose deployment that lets ChatGPT use MCP tools to work with files, shell commands, background processes, and Git in each account's own workspace. It does not use an OpenAI API key, run Codex CLI, or expose the Docker socket to the gateway or runners. A separate trusted provisioner uses Docker access to create one runner container per approved account. An optional trusted telemetry collector observes the host and runners without restarting them.

```text
Internet / ChatGPT
        │ HTTPS :443
        ▼
      Caddy ── internal HTTP ──▶ gateway ── signed IPC ──▶ dev-mcp-user-<id>   (one per account,
                                   │      (per-account          │                 administrators
                              gateway-data  socket + key)  /workspace:rw          included)
                           (users + OAuth)                 dev-mcp-user-<id>-data
```

There is no shared or "primary" runner: an administrator's environment is created and managed exactly like any other account's. The gateway cannot see any `/workspace`. Runners cannot see OAuth state, other accounts' files or keys. Every request is HMAC-signed with the account's own key, and runners refuse unsigned requests. The gateway and runners use separate Docker networks. Trusted control-plane services publish status and telemetry through `runner-status`, mounted read-only in the gateway.

Each approved account gets a dedicated runner container, workspace and runtime storage, an IPC key and a Docker bridge network. When the installer chooses a host workspace root during local onboarding, every account's `/workspace`, the administrator's included, is a subdirectory of that root, so the same files can be edited from VS Code on the host. Project access follows workspace ownership: users can access every project in their own runner, and cannot access another user's workspace. Sharing an individual project between users is not supported. Installations from before this layout move their shared runner account with [the one-time migration](#migrating-an-older-installations-primary-runner).

## Accounts and administration

- `/signup`: Google-only registration; new accounts remain pending until approved. Password signup is rejected server-side.
- `/login` and `/account`: Google sign-in and project overview. Every account is created by Google sign-in, so there is no password login, password change or account linking. OAuth consent also requires an existing session or Google sign-in.
- `/admin`: ERP-style dashboard with a persistent navigation sidebar. Each management area and detail view has its own URL (see below).
- A fresh installation has no accounts until the [local onboarding](#local-installer-onboarding) approves the first Google account as administrator. No account is seeded, and `ADMIN_PASSWORD_HASH` is no longer read.
- Existing OAuth credentials without a user identity are rejected after upgrading. Reconnect each MCP client, sign in with Google, and explicitly approve its requested permissions.
- Browser session tokens are stored as hashes and sent in HttpOnly, SameSite=Lax cookies (Secure on HTTPS). Forms require CSRF tokens. The final active administrator who can sign in cannot be disabled or demoted.
- Account status/role changes and “revoke all” invalidate previous browser sessions, OAuth codes/tokens, and MCP session reuse. Already running commands are not killed automatically.

### Google login setup

1. Prepare a Google **Web application** OAuth client. In its authorized redirect URIs, **add** `https://<MCP_DOMAIN>/auth/google/callback` without removing plan-app's existing callback URIs. The full URI must match, including scheme and path. See [Google's OIDC setup](https://developers.google.com/identity/openid-connect/openid-connect#redirect-uri).
2. From this repository, run `node scripts/import-google-secrets.mjs` (optional argument: the source directory). This copies `../plan-app/oauth-id.txt` and `oauth-secret.txt` as opaque files, without printing or parsing their contents. Each source must contain only the credential value; a trailing newline is accepted at runtime. Existing destination files are never overwritten.
3. Enable the secrets overlay when deploying:

   ```bash
   docker compose -f compose.yaml -f compose.google.yaml up -d --build
   ```

   Continue including the overlay for subsequent Compose operations. If Docker runs in another filesystem namespace, set `GOOGLE_CLIENT_ID_SOURCE` and `GOOGLE_CLIENT_SECRET_SOURCE` to the copied files' absolute paths **on the Docker host**. Do not point the container at an unreadable owner-only source file or make plan-app's original files public.
4. Existing administrators can sign in immediately. On a fresh installation, register the intended administrator through Google, then approve that verified pending account in the [local onboarding](#local-installer-onboarding). Accounts are identified by Google's `sub` and never merged by email.

Copied files live inside a mode-0700 `data/google` directory; individual files are read-only and readable by the non-root gateway through Compose secret mounts. Neither the directory nor the source filenames are included in Git or the Docker build context. Only the gateway receives these mounts. Never print `docker compose config` with credentials supplied as literal environment values. For non-Docker runs, configure `GOOGLE_CLIENT_ID_FILE` and `GOOGLE_CLIENT_SECRET_FILE` (or the corresponding environment values, but never both).

The gateway validates the ID token's signature, issuer, audience, expiry, nonce, authorized party and verified email, and identifies accounts by Google's stable `sub`, **not email**. It requests only `openid email` and does not retain Google access/refresh tokens. The callback uses single-use state bound to an HttpOnly browser cookie plus PKCE. Pending/disabled accounts cannot receive login sessions or MCP tokens. Closing registration blocks new Google identities but leaves existing users able to log in. Without Google credentials, sign-in and registration remain unavailable; there is no password fallback.

For MCP connections, Google login returns to a browser-bound consent page, never directly to the external client's callback. The user must approve the requested scopes, with session CSRF protection. Unfinished Google login state expires after 10 minutes or a gateway restart. Auth callback/consent URLs are excluded from Caddy access logging to avoid logging codes or transaction identifiers. The application records sanitized authentication audit events instead. Other upstream proxies must apply equivalent redaction.

### Local installer onboarding

Until onboarding is completed, the gateway opens a second listener that Compose publishes only on the Docker host's loopback interface (`127.0.0.1:${ONBOARDING_HOST_PORT:-3100}`). Caddy never proxies it, so it is not reachable through `MCP_DOMAIN`. Open it on the host, or from a workstation through an SSH tunnel:

```bash
ssh -L 3100:127.0.0.1:3100 <docker-host>
# then open http://127.0.0.1:3100/
docker compose logs gateway | grep onboarding_available   # one-time code
```

Each gateway start prints a new random code to its log; only users with Docker access can read it. The page also answers only `localhost`, `127.0.0.1` and `[::1]` Host headers, uses its own SameSite=Strict session cookie and CSRF token, rejects cross-origin posts and limits code guesses. It has three steps:

1. **First administrator:** sign up at `https://<MCP_DOMAIN>/signup` with the intended Google account, then choose that pending account. This applies the same checks as the CLI bootstrap below, inside the running gateway. The provisioner then creates the administrator's runner like any other account's. Skipped when an active administrator exists.
2. **Workspace root (optional):** an absolute path on the Docker host, for example `/srv/dev-mcp/workspaces`. It must already exist and be writable by `DEV_UID`. Every account's workspace, the administrator's included, becomes `<root>/<name>`. It must not lie inside another runner's host workspace, such as a [migrated administrator environment](#migrating-an-older-installations-primary-runner), so no runner can reach other accounts' files. The provisioner verifies the root and the page refreshes until the result is shown. Leave the field empty and save, or choose **Docker 볼륨 사용**, to use each account's dedicated Docker volume. Saving an empty field also clears a previously configured root.
3. **Complete:** available once an administrator exists and any configured root is verified. Afterwards the root cannot be changed and later gateway starts do not open the listener. Set `ONBOARDING_PORT=0` in the gateway environment to disable it entirely.

An existing installation sees the onboarding once after upgrading; it skips the administrator step and only asks for the optional workspace root.

### CLI fallback for the first Google administrator

Complete Google registration first so the pending account has a verified provider identity. As the host operator, list only the pending Google account IDs and emails:

```bash
docker compose -f compose.yaml -f compose.google.yaml exec -T gateway node --input-type=module -e '
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
const file = path.join(process.env.GATEWAY_DATA_DIR, "users.json");
if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error("Account database exceeds inspection limit");
const { users } = JSON.parse(await readFile(file, "utf8"));
console.log(users.filter(u => u.status === "pending" && u.googleSub).map(u => ({ id: u.id, email: u.email })));
'
```

Check the exact intended account, then stop the gateway before the one-time write. Include any deployment-specific Compose overlays used by your installation in each command:

```bash
docker compose -f compose.yaml -f compose.google.yaml stop gateway provisioner
docker compose -f compose.yaml -f compose.google.yaml run --rm --no-deps gateway \
  node scripts/bootstrap-google-admin.mjs --gateway-stopped '<pending-user-UUID>' '<exact-Google-email>'
docker compose -f compose.yaml -f compose.google.yaml up -d gateway provisioner
```

The bootstrap rejects an incorrect email, an unverified/non-pending account, or an installation that already has an active administrator. It approves the selected Google account, which keeps its own runner, and records an audit event. Sign in with Google again after completion. Never run the bootstrap concurrently with the gateway: account updates use a process-local queue.

### Management pages

| URL | Management functions |
| --- | --- |
| `/account` | Current user's runner, projects, and Google identity |
| `/admin` | User/approval/session/client counts, pending approvals, recent activity |
| `/admin/users` | Search and status filters; account detail, approval, suspension, role changes, revoke all authentication |
| `/admin/projects` | Owner-specific project list and search; register existing directories; Git status; unregister or permanently delete with name confirmation |
| `/admin/usage` | Live and historical CPU, memory, disk and network charts; host, all runners or one owner; period averages, P50/P95/P99, sampled peaks and transfer totals |
| `/admin/runners` | Per-user connectivity, lifecycle operations, network access, resource/quota controls, workspace location and moves to a host directory |
| `/admin/processes` | Owner/status filters; process detail, paged logs, stop a running process |
| `/admin/apps` | [Apps](#apps-simple-deployment): deploy a project command with a port, start/stop, visibility, delete; all owners (`/account/apps` for one's own) |
| `/admin/users/<id>` | Browser sessions and individual revocation; OAuth clients, callback URLs and grant counts; client removal with ID confirmation |
| `/admin/audit` | Automatically refreshed, searchable audit records with inline details and live process logs; bounded to the most recent 1 MiB of the log |
| `/admin/settings` | Open/close new registrations and edit the signup notice; allow or disable public app links; VS Code link settings; read-only deployment, workspace root and onboarding information |

Lists are paginated (25 records). Browser sessions, active MCP sessions and per-user OAuth connections are managed from user details; the old connections URL redirects to the searchable user list. Administrators can manage all users' workspaces, but every operation still targets that owner's isolated runner. Normal users cannot enter administration. All administrative mutations require the administrator's authenticated session, CSRF token, and a matching Origin when present. Removing an OAuth client invalidates its access/refresh tokens and pending authorizations. Project deletion is permanent and does not stop running processes automatically.

Active users have their own workspace under `/account`: execution environment status and assigned limits, project registration/Git status/unregistration/deletion, process launch/stop and live logs, resource history with percentiles, and their activity records. The workspace uses the same console views and incremental JSON updates as administration. Owner identity comes from the authenticated session; foreign or ambiguous owner selectors are rejected before runner access. Project deletion requires the project name, and all workspace mutations require CSRF and same-origin validation. Runner provisioning/limits, user approval, other users' data, host statistics and service-wide settings remain administrator controls.

Runner and process pages refresh their status automatically while the browser tab is visible, preserving filters and unsaved settings. Their `/live` endpoints return JSON fields and changed rows only; unchanged polls return HTTP 204 with no body. HTML layouts, forms and navigation are loaded only during page navigation. Process details append new log output and follow the bottom; scrolling up keeps the reading position. Polling drains the remaining output when a process exits, then stops. Manual refresh and paged logs remain available without JavaScript.

Audit details expand in place. Tool-call rows show the tool name and caller-provided reason; longer reasons are shown in full in the detail view and are searchable from the list. Older records without a reason remain readable. The list, related process state, and logs refresh while the tab is visible; incoming records retain open details and the current reading position. Audit polling sends new/changed summaries and process metadata, while immutable raw details are sent once per baseline and logs use their byte cursor. Raw record data stays collapsed until requested. Without JavaScript, detail links still render on the server.

Already-open clients from before the JSON polling upgrade must reload once. Legacy browser page/history polls receive a small `refresh_required` response so they cannot continue downloading full documents or history after deployment. Normal navigation and non-browser full telemetry API requests remain available.

Page HTML lives in `packages/gateway/views/**/*.mustache`, separate from TypeScript route logic. Shared layouts and partials provide navigation, forms, notices, and pagination. Edit menu labels/order in `views/admin/navigation.json`; edit styles in `packages/gateway/public/{auth,admin}.css`. `src/views.ts` renders escaped data; only the already-rendered layout body is inserted as HTML. Production templates are cached until restart. Templates and CSS are copied into the gateway image; rebuild the image when changing them. Signup policy persists in `gateway-data/settings.json` and is included in gateway volume backups.

When an administrator approves an account, the `provisioner` service creates its dedicated runner automatically. It checks committed account state every five seconds, also repairs missing runners for already-approved users after a restart, and retries failed creations. Initial startup can take longer while Docker prepares volumes. Pending and disabled users are skipped. Start it when upgrading an existing deployment:

```bash
docker compose up -d --build provisioner
```

Include your usual Compose overlays. On a host sharing an existing reverse proxy, start only the intended services. For manual recovery, open **실행 환경 → 사용자 상세** and run the displayed command on the Docker host:

```bash
./scripts/provision-user.sh <user-uuid>
```

Run it with Docker access (`sudo` if required), after building the runner image (`docker compose build runner`) and starting the updated gateway. It uses `RUNNER_IMAGE` (default `dev-mcp-runner:latest`). No request falls back to another runner when an account's runner is missing. For accounts with a host-directory workspace, use the web controller instead: the manual helper creates volume workspaces only.

The helper creates `dev-mcp-user-<uuid>`, two persistent volumes (`-workspace`, `-data`), a dedicated bridge network, and a per-user authenticated Unix socket. It does not publish ports or mount Docker credentials, any other workspace, or other users' sockets. Git commits use the shared Git configuration; newly provisioned accounts get an email-based default identity. Each user's projects can be cloned via MCP or copied into their workspace volume by the operator.

Set `USER_RUNNER_IPC_DIR` to a dedicated absolute path on the Docker host if the daemon uses a different filesystem namespace. Otherwise it defaults to `./data/user-ipc`. Back up this directory (including the `.key` files), `gateway-data`, and each user's workspace/data volumes.

The provisioner and optional telemetry collector have Docker access; the gateway and runners do not. It has no network or HTTP endpoint and reads `gateway-data` read-only. Its logs contain provisioning success/failure events with account UUIDs (`docker compose logs provisioner`); a failed creation is retried on the next pass. Treat this service as a trusted host administrator. To stop existing jobs after disabling a user:

```bash
docker stop dev-mcp-user-<uuid>
```

After rebuilding the runner image, existing runners keep their old image until recreated: stop and remove a user's container and the provisioner recreates it, keeping its workspace and data. Preserve the named volumes and host workspace directories. Do not remove volumes as part of an upgrade. Running and intentionally stopped containers are left untouched; use `docker start` to resume a stopped environment. A container left in the `created` state by a failed start is retried. Stop the provisioner during maintenance if you need to keep an active user's container absent. Runners are separate from the main Compose stack and must be stopped/backed up explicitly.

## Requirements

- A Linux host with Docker Engine and Docker Compose v2
- Git, for cloning this repository
- A public DNS A/AAAA record pointing to the host
- Inbound TCP 80/443; UDP 443 is recommended for HTTP/3
- A free loopback port for the one-time local onboarding (`ONBOARDING_HOST_PORT`, default 3100)

The runner builds directly from the official `fedora:44` image. No local base image, dev container repository, host Node.js installation, Codex installation, Docker socket, SSH key, or host home mount is required.

## Quick setup

On a new host:

```bash
git clone https://github.com/Crasnec/dev-mcp.git
cd dev-mcp
./scripts/setup.sh
```

The interactive setup command:

- asks for the public domain and ACME email;
- detects the host UID and GID;
- prepares a host directory for account workspaces (default `~/dev-mcp-workspaces`), to confirm as the workspace root during onboarding;
- writes a mode-`0600` `.env` file with absolute host paths;
- builds the runner image (`docker compose build runner`), then the gateway, provisioner and Caddy stack;
- starts the services with Docker Compose and prints how to open the local onboarding.

No runner container starts with the stack: the provisioner creates the first one when onboarding approves the administrator. Host Node.js is not required.

Setup uses Let's Encrypt staging by default. Once DNS, HTTPS, OAuth, and MCP tool calls work, switch to production certificates:

```bash
./scripts/setup.sh --force --production
./scripts/verify-deployment.sh
```

`--force` intentionally replaces the host-specific `.env`; the OAuth state and runner volumes are preserved. Use `--no-start` to create and validate `.env` without starting containers.

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

Host-specific configuration stays in the ignored `.env` file. OAuth clients/tokens, account records, runner state, project registries, process logs, and Caddy certificates live in Docker named volumes and host directories that are not part of Git. A fresh host therefore starts with fresh OAuth state; refresh or recreate the ChatGPT app after DNS points to the new deployment.

To migrate state instead of starting clean, stop the stack and runners, then back up and restore these using your normal Docker volume procedure:

- `dev-mcp_gateway-data`, `dev-mcp_runner-status` and the `USER_RUNNER_IPC_DIR` directory (including the `.key` files)
- each account's `dev-mcp-user-<id>-data` volume, and its `-workspace` volume or host workspace directory
- `dev-mcp_caddy-data`, `dev-mcp_caddy-config`

## Manual configuration

If you do not want the setup script:

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
docker compose config --quiet
docker compose build runner
docker compose up -d --build
./scripts/verify-deployment.sh
```

Set `CADDYFILE_PATH` to an absolute path visible to the Docker daemon. Set `DEV_UID` and `DEV_GID` to the host owner of workspace files; they are built into the runner image. Resource limits are set per account in **실행 환경 → 사용자 상세**.

## MCP tools

Every tool requires a `reason` string explaining the purpose of that call in one short, user-facing sentence. It must contain 1–500 characters after trimming surrounding whitespace. For example, `project_list` accepts `{"reason":"작업할 프로젝트를 확인합니다."}`. The gateway records this text on the `tool_call` audit entry, including failed or scope-denied calls, and removes it before forwarding execution parameters to the runner. Omitted, blank, non-string or overlong reasons fail validation before execution. Keep credentials and other secrets out of this public-facing explanation. Refresh the connected client's tool catalog after upgrading, since clients with cached schemas may omit the new required argument.

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
| Files     | `file_list`, `file_read`, `file_search`, `file_apply_patch`                   |
| Commands  | `command_run`, `command_output`                                                             |
| Processes | `process_start`, `process_list`, `process_logs`, `process_stop`                             |
| Git       | `git_read`, `git_commit`                                                                 |
| Apps      | `app_list`, `app_deploy`, `app_stop`, `app_delete`                                          |

The catalog has 21 tools. Use `git_read` with `operation: "status" | "diff" | "log"`; `staged` applies to diffs and `limit` to logs. This replaces `git_status`, `git_diff`, and `git_log`. Use `process_list` (optionally filtered by `project_id`) for current process state instead of `process_status`. Refresh the connected client's tool catalog after updating.

The browser UI contains connection instructions, OAuth consent, and error pages. The separate `/security` introduction page has been removed; the security model is documented below.

`command_run` and `process_start` require `network_intent` to be `none`, `read`, or `write`. This value is used for OAuth authorization, ChatGPT confirmation policy, and auditing; it is not a runner-side network firewall. Command and Git output over 64 KiB is saved in runner data and paginated through `command_output`. Process logs use the `process_logs` cursor.

The `image_read` tool and its signed `/media` URLs have been removed. Refresh the connected client’s tool catalog after upgrading.

Tool annotations distinguish reads, writes, destructive actions, and external communication. Shell calls always advertise `destructiveHint: true` and `openWorldHint: true`. The design follows the [OpenAI tool guidance](https://developers.openai.com/apps-sdk/plan/tools).

## Apps (simple deployment)

An app is a server started from a project, published at `https://<name>.<PREVIEW_DOMAIN>`. It consists of a name, a project, a start command, and the port the server listens on (on `localhost` or `0.0.0.0`) inside the account's runner. Apps are created on **앱** (`/admin/apps`, `/account/apps`) or by ChatGPT with `app_deploy`, which saves the app, (re)starts it as a tracked background process and returns the URL. `app_list`, `app_stop` and `app_delete` manage apps. App processes are not restarted automatically: after a runner restart or crash, start the app again. Each account can have 10 apps; names are global.

Each app is either **private** (default: only its owner and administrators, after signing in) or **public** (anyone with the link). Administrators can disable public links in **운영 설정**; public apps then behave as private.

**Domain.** Apps run arbitrary user code, so each one gets its own host and never the console's origin: a page on the console's origin could act with a visiting administrator's session.

- Set `PREVIEW_DOMAIN` to the console host to serve apps at `https://<name>.<MCP_DOMAIN>`, for example `myapp.dev.example.com`. A separate domain also works. The gateway refuses a parent of the console host, and accepts the console host or a subdomain of it only over HTTPS. The same-site trade-offs are in [SECURITY.md](SECURITY.md).
- Point a wildcard DNS record `*.PREVIEW_DOMAIN` at the host. With Cloudflare, make it DNS-only, so this host answers the certificate challenges.
- Use `CADDYFILE_PATH=./Caddyfile.preview`. Its wildcard site uses on-demand TLS, and the `ask` endpoint (`/__dev-mcp/tls-allowed`) lets certificates be issued only for existing app names. Without `PREVIEW_DOMAIN`, apps can still be defined and run but have no URL.

**How requests reach the app.**

- The gateway serves apps on a separate listener (`PREVIEW_PORT`, default 3200, reached only by the reverse proxy over the `edge` network) that has no console routes.
- Gateway and runners still share no network. Each request opens a byte stream over the account's signed IPC socket: an `http_tunnel` request with a fresh timestamp, refused if replayed or older than 30 seconds. The runner then connects to `127.0.0.1:<port>`, falling back to `::1`, and pipes the bytes. HTTP and WebSocket upgrades (for example development hot reload) pass through. A runner allows 64 concurrent app connections.
- The app receives `Host: localhost:<port>` (development servers often accept only that) plus `X-Forwarded-Host`, `X-Forwarded-Proto` and `X-Forwarded-For`.
- Traffic tunnelled this way is not counted in the runner's network statistics.

**Private access.**

1. A visitor without a valid app cookie is redirected to the console's `/preview/authorize`, signing in with Google first if needed.
2. The console checks that the viewer owns the app or is an administrator, then redirects back with a 60-second single-use code.
3. The app host exchanges the code for its own host-only cookie (`__Host-dev-mcp-preview`, 12 hours). The cookie is HMAC-signed with `gateway-data/preview-secret`, bound to that app, and checked against the viewer's current credential version, so revoking access ends it.

The proxy strips this cookie before forwarding and drops any upstream `Set-Cookie` with that name.

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

- Each runner receives only its own account's workspace as `/workspace:rw`. The workspace root itself cannot be registered as a project.
- Runners accept only requests HMAC-signed with their account's key, read from a per-account file; the gateway chooses the runner from the authenticated account.
- File paths receive lexical checks followed by `realpath` checks. Absolute paths, parent traversal, symlink escapes, and patch escapes are rejected.
- Public cloning accepts credential-free HTTPS URLs from GitHub, GitLab, and Bitbucket. SSH, URL credentials, loopback, and private targets are rejected.
- Neither service receives the Docker socket, SSH keys, host home, `~/.codex`, or Codex credentials.
- Child processes receive a clean `PATH`, runner-only `HOME`, locale, and optional Git author values. Gateway variables and OAuth tokens are not inherited.
- The gateway uses a read-only root, dropped capabilities and `no-new-privileges`. Per-account development containers start as UID 1000, have writable roots and passwordless sudo for package installation, using ordinary Docker capabilities without privileged mode.
- The development image includes Bash, Git, GitHub CLI, sudo, OpenSSH, ripgrep, Node.js, Python, Rust and common native build tools. It has no host Docker socket.
- Runners have no default CPU, memory, or command-duration limit; set limits per account on the runner page. Each runner allows four synchronous commands and eight background processes.
- Audit records are stored in `gateway-data/audit.jsonl`. Patch bodies and continuation/token values are omitted; command strings are limited to 2,000 characters.

This service deliberately exposes arbitrary shell execution and destructive file operations to an OAuth-authorized client. Secure administrator Google accounts and consider firewall, rate limiting, or an additional access-control layer.

## Development and verification

```bash
npm ci
npm run style
npm run typecheck
npm test
npm run build
docker compose config --quiet
```

Tests cover PKCE, one-time codes, refresh rotation, revocation, path and symlink escapes, project registration through commit, long-output pagination, and background process lifecycle. After deployment, `scripts/verify-deployment.sh` checks public HTTPS metadata, the authentication challenge, mount isolation, network separation, development tools and sudo.

### Resource monitoring

Enable the independent collector alongside the gateway, retaining any deployment-specific Compose overlays:

```bash
docker compose -f compose.yaml -f compose.telemetry.yaml build gateway telemetry
docker compose -f compose.yaml -f compose.telemetry.yaml up -d --no-deps --no-build --wait gateway telemetry
```

These targeted commands preserve running runners and the provisioner. Keep `compose.telemetry.yaml` in subsequent deployment commands. The collector has no network listener and uses Docker's Unix socket plus read-only host observations; treat it as a trusted host administrator. The gateway receives only the read-only `runner-status` volume. The collector does not apply limits, provision environments, or restart jobs.

Open the usage page (`/admin/usage`) to select the host, all runners, or an individual owner's environment and the last hour, day, week, or 30 days. Visible pages update every five seconds; background tabs pause and abort in-flight updates. The browser requests a compact `stream=1` snapshot once, then sends its revision to receive only changed chart points and displayed values. Stable time buckets avoid retransmitting the complete history on every tick; empty intervals are reconstructed in the browser and unchanged snapshots return HTTP 204. Revisions are bound to the authenticated viewer, scope and range; bounded/expired baselines trigger a full JSON resync. Charts support pointer and keyboard inspection, with a shared average/P50/P95/P99 selector. Displayed timestamps and chart axes follow the browser’s locale and time zone, including daylight-saving changes; stored timestamps remain UTC. Current values and period statistics remain available without JavaScript. Administrator session authorization applies to the page and JSON endpoint (`/admin/telemetry`); ordinary accounts cannot read host or other users' measurements.

Metric definitions:

- **CPU:** used CPU cores, with 1 core equal to 100% CPU time. Values can exceed one core. Capacity utilization is a separate percentage; the host and all-runner views use physical host capacity. A runner uses its configured CPU allowance when available.
- **Memory:** host RAM is total minus available memory; runner memory is its working set (Docker usage minus inactive file cache). Runner memory is not expected to sum to total host RAM.
- **Disk space:** the host's root filesystem; a runner's workspace plus runtime data, measured independently at a slower cadence. Disk read/write throughput measures block-device traffic and is shown separately from occupied space. Aggregate runner disk capacity is not inferred from shared host capacity.
- **Network:** host uplink traffic, excluding loopback and virtual bridge duplicates; runner traffic covers its container interfaces. Received/transmitted byte totals include valid measured intervals only.

CPU/rate averages are weighted by valid observation time. Peaks are sampled maxima, not guarantees that every short spike was captured. Restarted counters, unavailable collectors, and gaps remain missing rather than being plotted as zero. Disk-space timestamps can be older than CPU/network observations because scans run less frequently. The page distinguishes unavailable or stale data.

History begins when the collector is enabled. There is no reconstructed usage before that time. `runner-status/telemetry` holds atomic current snapshots and append-only hourly/daily JSONL shards: five-second observations for two hours, minute rollups for 48 hours, and hourly rollups for 30 days. `TELEMETRY_MAX_HISTORY_MIB` (default 512) bounds history storage and can shorten effective retention; the UI reports incomplete retained history. `TELEMETRY_MAX_RUNNERS` (default 256) bounds each collection pass; omitted environments make aggregate coverage incomplete. Back up this volume if monitoring history must survive volume removal; ordinary gateway/collector recreation retains it. Long-range views use rollups and preserve sampled maxima and valid transfer totals. Percentiles use mergeable, elapsed-time-weighted histograms of valid measurements, with bounded storage and approximation metadata. Historical rollups written before percentile collection have no recoverable distribution: their percentiles remain unavailable instead of being estimated from averages.

The CPU and memory definitions follow [Docker's container statistics](https://docs.docker.com/reference/cli/docker/container/stats/) and [runtime metric documentation](https://docs.docker.com/engine/containers/runmetrics/). Host block traffic follows [Linux block statistics](https://cdn.kernel.org/doc/html/latest/block/stat.html).

### Web execution environment operations

Administrators can use **실행 환경 → 사용자 상세** to create, start, stop and restart a runner, and edit external network access, memory, CPU, process count, total persistent storage and per-file size limits. Requests require the existing administrator session and CSRF protection. Forms include a revision to reject stale submissions. The page distinguishes pending/failed requests from the latest Docker observations; saving a request alone does not mean it was applied.

The gateway writes requests into `gateway-data/runner-controls.json`. The provisioner validates account/container ownership, executes fixed Docker operations and atomically publishes observations into the separate `runner-status` volume (read-only in the gateway). It still has no HTTP listener. User processes never receive the control/status volumes or Docker socket. Restart requests are not replayed after an ambiguous controller crash; check the actual state and submit a new request.

Network blocking disconnects the development container from Internet networks while preserving the private SSH network; authenticated Unix-socket management remains available. Nonzero memory limits disable swap. CPU and PID limits are enforced by Docker/cgroups. Reducing memory can terminate processes. File size limits use `RLIMIT_FSIZE`. Changing these or resetting an existing memory/CPU limit to unlimited requires container replacement; volumes and host workspace directories are preserved. Storage limit changes can stop running jobs. These operations work the same for administrators' runners.

#### VS Code workspace containers (Remote - SSH)

Each approved account has one development container, `dev-mcp-user-<id>`, running both MCP and SSH. Commands, terminals, servers and VS Code share `/workspace`, the PID/network namespace and HOME `/workspace/.dev-mcp-home`. Git credentials configured through SSH (including `gh auth login --web --git-protocol https` and `gh auth setup-git`) are also available to MCP. Set `git config --global user.name` and `user.email` to override the initial identity. The project page can clone an HTTPS repository and register it automatically. App proxies can reach servers started through SSH on the same container's loopback; process lists discover terminal processes in registered projects. Terminal output stays in its terminal; use MCP `process_start` for captured logs. User telemetry measures the whole container, including SSH and VS Code.

The container starts as an ordinary user and permits passwordless sudo and system package installation. Work files and HOME persist across recreation; the writable image filesystem does not. Install reproducible extra Fedora packages with `dev-mcp-install <packages>`; its package list is saved under `~/.dev-mcp/packages.txt` and restored in the background after recreation. A failed restore is recorded in `~/.dev-mcp/packages-status.json`; retry with `dev-mcp-install --restore`. Tools installed into HOME also persist.

Enable SSH with your normal deployment overlays:

```bash
docker compose -f compose.yaml -f compose.google.yaml -f compose.ssh.yaml build runner gateway provisioner ssh-entry
docker compose -f compose.yaml -f compose.google.yaml -f compose.ssh.yaml up -d gateway provisioner ssh-entry
```

Keep `compose.ssh.yaml` in subsequent deployments. The provisioner migrates older pairs of runner/workspace containers once to the unified image, retaining work/data volumes, HOME, resource limits, host keys and stopped state. Old containers are removed only after the replacement's IPC socket is ready; creation failures restore the originals. MCP and SSH lifecycle operations now start/stop/restart the same container, so stopping it also stops development servers and MCP jobs. Limits apply once to the full development environment. Resource changes requiring replacement preserve volumes and restore recorded packages.

The shared **ssh-entry** service publishes only TCP **2222**. Host SSH on **22** remains untouched. Set `WORKSPACE_SSH_HOST` (default `MCP_DOMAIN`) to a DNS name resolving directly to the Docker host and allow TCP 2222 through the firewall. An HTTP/CDN proxy does not carry this SSH connection. `WORKSPACE_SSH_PORT` can select a different unprivileged external port if needed; workspace SSH always uses internal 2222. No per-account external ports are allocated.

In **내 계정 → 개발 workspace** (`/account/workspace`), users can view their development environment and create/start/stop/restart only their own container, register or delete named public keys, download an SSH configuration, and open `/workspace` in VS Code. At most ten Ed25519, RSA (2048 bits or larger), or ECDSA keys can be registered. Only `.pub` files are uploaded; private keys remain on the user's computer. The page shows both SSH host key fingerprints and enables its VS Code link after fresh controller and SSH health observations agree with the registered keys.

The generated configuration uses standard OpenSSH `ProxyJump`: one account/key-authenticated jump connection to the entry and another SSH connection to the user's workspace. Entry accounts permit forwarding only to that account's exact workspace name on 2222 and have no shell, SFTP, agent or remote-forwarding access. Multiple clients using an account reach the same workspace. The user-specific domain shown in the configuration is a local SSH alias; wildcard DNS is unnecessary and is not used to route SSH. VS Code requires its normal Remote - SSH extension; no TLS transport utility, npm SSH library or external relay service is added.

Each workspace has its own internal Docker SSH network. It retains this network when external networking is disabled; Internet access follows the runner's network setting. VS Code TCP and Unix-socket forwarding are supported, with TCP destinations restricted to the workspace's loopback addresses. For workspaces without Internet access, VS Code may need `remote.SSH.localServerDownload: "always"` to transfer its server from the client.

Public-key changes are normally applied within five seconds and close existing SSH sessions for that workspace. Account disablement, authentication revocation or role changes invalidate its keys; active accounts must register keys again after an authentication-version change. Authorization is refreshed independently of slow Docker operations. If the controller cannot read account/key state or stops, both OpenSSH supervisors close access after a 30-second lease expires (plus at most one polling second). Arbitrary-shell users still control their own running workspace programs; deliberate sharing of their own account environment is outside this boundary.

Back up `gateway-data` (public-key registrations), the `ssh-entry-data` volume (entry host key) and `workspace-auth` volume (per-account host keys), alongside work storage. These authentication volumes are read-only inside SSH containers; workspaces mount only their own metadata subdirectory. The development container receives its own work/data volumes and IPC key/socket, never another account's data, the account database, control/status volumes or host Docker socket. Restoring host keys preserves client trust across recreation.

#### Host-directory workspaces (VS Code)

With a verified workspace root, the provisioner creates each new dedicated runner's workspace as `<root>/<name>` and bind-mounts it at `/workspace`; `/var/lib/dev-mcp` stays a named volume. The name comes from the account's email (`mina@example.com` → `mina`, then `mina-2`, …). Directories are created exclusively by an unprivileged helper from the runner image running as `DEV_UID`, so an existing directory, such as another project, is never handed to an account, and new files have the same owner as the host user who opens them in VS Code. Assignments are recorded in `runner-status/workspace-dirs.json`. Before every start, restart or recreation, the helper checks that the directory is still a real directory owned by `DEV_UID`, not a symlink.

An account whose container was removed but whose `-workspace` volume remains keeps using that volume. On **실행 환경 → 사용자 상세**, **작업 공간 위치** shows the storage mode and, for host directories, the host path. Administrators can move a volume-backed runner to a host directory with a chosen name. The runner is stopped, the volume is copied with `cp -a`, and the container is recreated with the bind mount, restarting it if it was running. The original volume is kept. A failure restores the previous container and removes the new directory. Runners using the storage quota pool cannot be moved yet. Storage quotas do not apply to host directories; per-file size, memory, CPU and process limits still do.

To open workspaces directly, set **운영 설정 → VS Code 연결**. The SSH host is a Remote - SSH host or `~/.ssh/config` alias. The optional path mapping rewrites a host path prefix for editors that see the files elsewhere, such as a dev container. The page then shows a `vscode://vscode-remote/ssh-remote+<host><path>` link. Ordinary users never see host paths.

No runner may see another account's workspace. A host workspace outside the root, such as a migrated administrator environment (recorded as `{path, legacy: true}`), is reserved. A root inside or equal to a reserved workspace is rejected on save. The provisioner also compares the kernel-resolved locations of the root and every reserved workspace from `/proc/self/mountinfo` inside the helper, so a symlink or bind alias cannot hide an overlap. It repeats that comparison before every start, restart and recreation. Reserved workspaces are mounted read-only in the helper only for that comparison; their files are never read. A reserved workspace inside the root is allowed: its runner sees only its own directory, and existing directories are never assigned.

### Migrating an older installation's primary runner

Installations from before this layout ran a shared Compose `runner` (the "primary runner") with `${WORKSPACE_DIR}` and an account whose `runner` is `"primary"`. The new gateway and provisioner skip such an account, so run the one-time migration when deploying this version. It requires exactly one active, Google-linked account on the primary runner, and keeps the same host directory as that account's workspace.

```bash
docker compose build runner gateway provisioner        # include your overlays
docker compose ... stop gateway provisioner
./scripts/migrate-primary-runner.sh                     # dry run: prints the plan
./scripts/migrate-primary-runner.sh --apply
docker compose ... up -d --no-deps gateway provisioner
```

`--apply` does the following:

- stops the old runner container;
- copies its runtime volume (project registry and IDs, process logs, output cursors, home) into `dev-mcp-user-<id>-data`;
- records the old workspace as a reserved host workspace;
- sets the account's `runner` to its ID and drops the legacy password hash (backup: `users.json.pre-primary-migration`).

The provisioner then creates `dev-mcp-user-<id>` with the old directory at `/workspace` and a new signed IPC key. Sessions and OAuth credentials stay valid. Running background processes are not restarted, Git commits use the per-account default identity, and the network becomes a per-account bridge.

Nothing is deleted: the old container, its runtime volume and the original `users.json` remain for rollback. The script prints the rollback steps. Remove them only after the new runner is verified.

#### Persistent storage hard quota

On the first nonzero storage quota, the provisioner prepares a separate XFS filesystem in the `dev-mcp-quota-images` volume and mounts it as `dev-mcp-quota-pool`. This needs Linux XFS/project-quota and loop-device support. A short-lived trusted storage helper uses privileged Docker access to prepare the loop device and administer XFS quotas; the user runner remains unprivileged. The helper image is the running provisioner's image, not an arbitrary image supplied by a request.

Each user gets a unique project ID and isolated volume subpaths. `/workspace` and `/var/lib/dev-mcp` share a single block quota; writes beyond it fail in the filesystem (XFS commonly returns `ENOSPC`). Existing files are copied while the runner is stopped. The original named volumes remain available for deliberate rollback. A failed copy leaves the original container and volumes intact. The pool is a sparse 100 GiB filesystem; quota values may range from 64 MiB to 100 GiB. Zero removes the user's project limit but does not remove the pool's total capacity. Physical host free space can be exhausted before allocated quotas are reached. `/tmp`, `/dev/shm` and IPC socket storage are outside the persistent workspace/runtime quota.

The image volume records its reserved loop device. After a restart, the provisioner reattaches only that image to that device, and refuses to overwrite an occupied device. Do not detach or repurpose this loop device while runners use the quota pool. Back up `dev-mcp-quota-images`, `runner-status` (project IDs), account/control state and IPC keys together, with affected runners stopped. Copy the image consistently; do not treat a live copy of the filesystem image as a backup. Do not delete the old user volumes until migration and backups have been verified. After quota migration, recreate missing environments through the web controller, which retains the quota backing store; do not use the original manual helper without its quota settings.

The mechanism follows [Docker volume subpaths and block devices](https://docs.docker.com/engine/storage/volumes/) and [XFS directory tree quotas](https://man7.org/linux/man-pages/man8/xfs_quota.8.html). Memory/CPU behavior follows [Docker resource constraints](https://docs.docker.com/engine/containers/resource_constraints/).

#### Development verification without deployment

Build a separate test image; do not recreate running services:

```bash
docker build -f docker/provisioner.Dockerfile -t dev-mcp-provisioner-devtest .
# Disposable container with no host data mounts or Docker socket; cleans up its loop device.
docker run --rm -i --privileged --network none --entrypoint sh dev-mcp-provisioner-devtest -s < scripts/test-quota-storage.sh
```

`npm test` covers authorization, form validation, stale requests, ownership checks, migration failure and recreation recovery. `scripts/test-runner-controls.mjs` is an optional Docker integration test: run it inside the test image with the scripts directory read-only and the Docker socket mounted. It creates random test containers/networks and removes them in `finally`; it never selects an existing user's runner.

`scripts/test-runner-storage.mjs` additionally checks the full Docker migration path, volume subpaths, quota resizing and retained original data with uniquely named temporary volumes; its cleanup removes those test volumes and detaches only the test image's loop device.


For repeatable verification with the runner's actual tools and unmodified child-process output, build and run `docker/verification.Dockerfile`. SSH integration uses disposable accounts and resources; it needs Docker access, but never attaches to existing accounts or binds host port 22 or 2222:

```bash
docker build -f docker/runner.Dockerfile -t dev-mcp-runner:workspace-test .
docker build -f docker/verification.Dockerfile -t dev-mcp-verification:workspace-test .
docker run --rm --network none --cap-drop ALL --security-opt no-new-privileges:true dev-mcp-verification:workspace-test

docker build -f docker/workspace.Dockerfile --build-arg RUNNER_IMAGE=dev-mcp-runner:workspace-test -t dev-mcp-workspace:workspace-test .
docker build -f docker/ssh-entry.Dockerfile -t dev-mcp-ssh-entry:workspace-test .
docker build -f docker/provisioner.Dockerfile -t dev-mcp-provisioner:workspace-test .
docker build -f docker/workspace-test.Dockerfile -t dev-mcp-workspace-integration:workspace-test .
SSH_TEST_RUN="dev-mcp-ws-test-$(date +%s)"
docker run --rm --name "$SSH_TEST_RUN-check" -e SSH_TEST_PROJECT="$SSH_TEST_RUN" \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount type=volume,source="$SSH_TEST_RUN-entry",target=/ssh-entry-data \
  --mount type=volume,source="$SSH_TEST_RUN-auth",target=/workspace-auth \
  dev-mcp-workspace-integration:workspace-test
docker volume rm "$SSH_TEST_RUN-entry" "$SSH_TEST_RUN-auth"
```

The SSH test verifies concurrent native ProxyJump clients, public-key and destination isolation, shared work files, persistent home/host keys, PTY, SFTP, loopback forwarding, independent lifecycle, Internet blocking with SSH retained, key removal, account revocation and both authorization leases. It removes its temporary containers, networks and work volumes in `finally`; remove the two registry volumes after its disposable test container exits, as shown above.
