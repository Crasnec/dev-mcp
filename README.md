# dev-mcp

`dev-mcp` is a self-contained Docker Compose deployment that lets ChatGPT use MCP tools to work with files, shell commands, background processes, and Git in one host directory. It does not use an OpenAI API key, run Codex CLI, or expose the Docker socket to the gateway or runners. A separate trusted provisioner uses Docker access to create approved users' containers. An optional trusted telemetry collector observes the host and runners without restarting them.

```text
Internet / ChatGPT
        │ HTTPS :443
        ▼
      Caddy ── internal HTTP ──▶ gateway ── Unix socket ──▶ runner
                                   │                         │
                              gateway-data              /workspace:rw
                           (users + OAuth)               runner-data
```

The gateway cannot see `/workspace`. The runner cannot see OAuth state or the administrator password hash. The gateway and runner use separate Docker networks and share the runner's Unix socket volume. Trusted control-plane services publish status and telemetry through `runner-status`, mounted read-only in the gateway.

New users have dedicated runner containers, workspace/log volumes, IPC keys, and Docker bridge networks. The existing runner belongs to the initial administrator. Project access follows workspace ownership: users can access every project in their own runner, and cannot access another user's workspace. Sharing an individual project between users is not supported.

## Accounts and administration

- `/signup`: Google-only registration; new accounts remain pending until approved. Password signup is rejected server-side.
- `/login` and `/account`: Google sign-in, project overview, and explicit Google linking for existing accounts. Username/password login and password-change endpoints have been removed. OAuth consent also requires an existing session or Google sign-in.
- `/admin`: ERP-style dashboard with a persistent navigation sidebar. Each management area and detail view has its own URL (see below).
- Existing Google-linked accounts keep their account IDs, roles and workspaces. A fresh installation requires the one-time operator bootstrap below before the first administrator can sign in. `ADMIN_PASSWORD_HASH` remains a legacy configuration/storage field; it no longer enables browser or OAuth password authentication.
- Existing OAuth credentials without a user identity are rejected after upgrading. Reconnect each MCP client, sign in with Google, and explicitly approve its requested permissions.
- Browser session tokens are stored as hashes and sent in HttpOnly, SameSite=Lax cookies (Secure on HTTPS). Forms require CSRF tokens. The final active administrator, and the final active Google-linked administrator, cannot be disabled or demoted.
- Account status/role changes and “revoke all” invalidate previous browser sessions, OAuth codes/tokens, and MCP session reuse. Already running commands are not killed automatically.

### Google login setup

1. Prepare a Google **Web application** OAuth client. In its authorized redirect URIs, **add** `https://<MCP_DOMAIN>/auth/google/callback` without removing plan-app's existing callback URIs. The full URI must match, including scheme and path. See [Google's OIDC setup](https://developers.google.com/identity/openid-connect/openid-connect#redirect-uri).
2. From this repository, run `node scripts/import-google-secrets.mjs` (optional argument: the source directory). This copies `../plan-app/oauth-id.txt` and `oauth-secret.txt` as opaque files, without printing or parsing their contents. Each source must contain only the credential value; a trailing newline is accepted at runtime. Existing destination files are never overwritten.
3. Enable the secrets overlay when deploying:

   ```bash
   docker compose -f compose.yaml -f compose.google.yaml up -d --build
   ```

   Continue including the overlay for subsequent Compose operations. If Docker runs in another filesystem namespace, set `GOOGLE_CLIENT_ID_SOURCE` and `GOOGLE_CLIENT_SECRET_SOURCE` to the copied files' absolute paths **on the Docker host**. Do not point the container at an unreadable owner-only source file or make plan-app's original files public.
4. Existing Google-linked administrators can sign in immediately. On a fresh installation, register the intended administrator through Google, then use the one-time operator bootstrap below to approve that verified pending account. Existing authenticated users can still use **내 계정 → Google 계정 연결** to connect an unlinked account explicitly. Linking preserves its account ID, role and workspace and invalidates old sessions/MCP credentials. Accounts are never auto-merged by email.

Copied files live inside a mode-0700 `data/google` directory; individual files are read-only and readable by the non-root gateway through Compose secret mounts. Neither the directory nor the source filenames are included in Git or the Docker build context. Only the gateway receives these mounts. Never print `docker compose config` with credentials supplied as literal environment values. For non-Docker runs, configure `GOOGLE_CLIENT_ID_FILE` and `GOOGLE_CLIENT_SECRET_FILE` (or the corresponding environment values, but never both).

The gateway validates the ID token's signature, issuer, audience, expiry, nonce, authorized party and verified email, and identifies accounts by Google's stable `sub`, **not email**. It requests only `openid email` and does not retain Google access/refresh tokens. The callback uses single-use state bound to an HttpOnly browser cookie plus PKCE. Pending/disabled accounts cannot receive login sessions or MCP tokens. Closing registration blocks new Google identities but leaves existing users able to log in. Without Google credentials, sign-in and registration remain unavailable; there is no password fallback.

For MCP connections, Google login returns to a browser-bound consent page, never directly to the external client's callback. The user must approve the requested scopes, with session CSRF protection. Unfinished Google login state expires after 10 minutes or a gateway restart. Auth callback/consent URLs are excluded from Caddy access logging to avoid logging codes or transaction identifiers. The application records sanitized authentication audit events instead. Other upstream proxies must apply equivalent redaction.

### First Google administrator on a new installation

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

The bootstrap rejects an incorrect email, an unverified/non-pending account, or an installation that already has an active Google administrator. It approves the selected Google account with its own runner identity and records an audit event; it does not merge it with the legacy primary-workspace account. Sign in with Google again after completion. Never run the bootstrap concurrently with the gateway: account updates use a process-local queue.

### Management pages

| URL | Management functions |
| --- | --- |
| `/account` | Current user's runner, projects, and Google link |
| `/admin` | User/approval/session/client counts, pending approvals, recent activity |
| `/admin/users` | Search and status filters; account detail, approval, suspension, role changes, revoke all authentication |
| `/admin/projects` | Owner-specific project list and search; register existing directories; Git status; unregister or permanently delete with name confirmation |
| `/admin/usage` | Live and historical CPU, memory, disk and network charts; host, all runners or one owner; period averages, P50/P95/P99, sampled peaks and transfer totals |
| `/admin/runners` | Per-user connectivity, lifecycle operations, network access and resource/quota controls |
| `/admin/processes` | Owner/status filters; process detail, paged logs, stop a running process |
| `/admin/connections` | Browser sessions and individual revocation; OAuth clients, callback URLs and grant counts; client removal with ID confirmation |
| `/admin/audit` | Automatically refreshed, searchable audit records with inline details and live process logs; bounded to the most recent 1 MiB of the log |
| `/admin/settings` | Open/close new registrations and edit the signup notice; read-only deployment/isolation information |

Lists are paginated (25 records); browser sessions and OAuth clients have independent pagination on the connections screen. Administrators can manage all users' workspaces, but every operation still targets that owner's isolated runner. Normal users cannot enter administration. All administrative mutations require the administrator's authenticated session, CSRF token, and a matching Origin when present. Removing an OAuth client invalidates its access/refresh tokens and pending authorizations. Project deletion is permanent and does not stop running processes automatically.

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

Run it with Docker access (`sudo` if required), after rebuilding and starting the updated gateway and primary runner. It uses the running primary runner's image. No request falls back to the primary runner when a user runner is missing.

The helper creates `dev-mcp-user-<uuid>`, two persistent volumes (`-workspace`, `-data`), a dedicated bridge network, and a per-user authenticated Unix socket. It does not publish ports or mount Docker credentials, the primary workspace, or other users' sockets. Git commits default to a per-user UUID identity. Each user's projects can be cloned via MCP or copied into their workspace volume by the operator.

Set `USER_RUNNER_IPC_DIR` to a dedicated absolute path on the Docker host if the daemon uses a different filesystem namespace. Otherwise it defaults to `./data/user-ipc`. Back up this directory (including the `.key` files), `gateway-data`, and each user's workspace/data volumes.

The provisioner and optional telemetry collector have Docker access; the gateway and runners do not. It has no network or HTTP endpoint and reads `gateway-data` read-only. Its logs contain provisioning success/failure events with account UUIDs (`docker compose logs provisioner`); a failed creation is retried on the next pass. Treat this service as a trusted host administrator. To stop existing jobs after disabling a user:

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
- generates the legacy bootstrap scrypt field for configuration compatibility (this does not enable password login);
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

The catalog has 17 tools. Use `git_read` with `operation: "status" | "diff" | "log"`; `staged` applies to diffs and `limit` to logs. This replaces `git_status`, `git_diff`, and `git_log`. Use `process_list` (optionally filtered by `project_id`) for current process state instead of `process_status`. Refresh the connected client's tool catalog after updating.

The browser UI contains connection instructions, OAuth consent, and error pages. The separate `/security` introduction page has been removed; the security model is documented below.

`command_run` and `process_start` require `network_intent` to be `none`, `read`, or `write`. This value is used for OAuth authorization, ChatGPT confirmation policy, and auditing; it is not a runner-side network firewall. Command and Git output over 64 KiB is saved in runner data and paginated through `command_output`. Process logs use the `process_logs` cursor.

The `image_read` tool and its signed `/media` URLs have been removed. Refresh the connected client’s tool catalog after upgrading.

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

Tests cover PKCE, one-time codes, refresh rotation, revocation, path and symlink escapes, project registration through commit, long-output pagination, and background process lifecycle. After deployment, `scripts/verify-deployment.sh` checks public HTTPS metadata, the authentication challenge, mount isolation, network separation, and read-only roots.

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

Network blocking disconnects the runner from Docker networks; authenticated Unix-socket management remains available. Nonzero memory limits disable swap. CPU and PID limits are enforced by Docker/cgroups. Reducing memory can terminate processes. File size limits use `RLIMIT_FSIZE`. Changing these or resetting an existing memory/CPU limit to unlimited requires container replacement; volumes are preserved. Storage limit changes can stop running jobs. The existing primary runner's host bind mount is never automatically migrated; persistent storage and per-file limits apply to dedicated user runners. Resetting an already-set primary memory/CPU limit to unlimited requires an operator-managed Compose recreation; the web controller rejects that change before mutating it.

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
