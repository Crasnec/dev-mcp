# Current server deployment

Updated on 2026-10-06 (UTC) at `https://dev.crasnec.com`.

## Audit detail cleanup (deployed 2026-10-06)

Commit `f80d3dd` was pushed to GitHub main and deployed by recreating the gateway at 04:47 UTC. Audit details now display only the process explicitly identified by the recorded result or `process_id` call argument. Project, command and timestamp matching no longer bring in other processes, and calls without a process ID omit the process section entirely. Duplicate tool, reason and argument sections were removed from details; the raw record opens by default. List headings, recorded values and requested command display remain available. Server-rendered and automatically refreshed administrator and account views use the same behavior, and polling preserves the user's raw-record disclosure state.

Only the gateway was recreated. The eight other running container IDs were retained. Gateway image: `b9813c9d4dfc`. The preceding image `8cc7babfbb99` is retained as `dev-mcp-gateway:rollback-20261006-before-audit-detail-cleanup`.

Validation: all 48 related audit, live-update, administrator and account HTTP/view tests passed, including explicit process selection, disappearance of a recorded process, and absence of unrelated runner calls. TypeScript, style and diff checks passed. The built gateway became healthy; deployed-template rendering and public HTTPS/OAuth checks passed.

## MCP audit request diagnostics (deployed 2026-10-06)

Commit `9c6077a` was pushed to GitHub main and deployed by recreating the gateway at 03:14 UTC. Standard MCP methods with nested paths or camel-case names and the `skills/list` / `skills/get` discovery extension now retain their names in failure records. An exact allowlist keeps arbitrary custom method names redacted. HTTP failure records also identify the message kind and whether a nonempty session header was present, and both fields appear in audit details.

These records support the next investigation of ChatGPT's repeated `MCP_SESSION_ID_REQUIRED` responses. This deployment adds diagnostic information; the HTTP 400 behavior still requires identifying and addressing the client's sessionless request. Existing MCP clients must initialize a new session after the gateway restart.

Only the gateway was recreated. The eight other running container IDs were retained. Gateway image: `8cc7babfbb99`. The preceding image `bb10717592ff` is retained as `dev-mcp-gateway:rollback-20261006-before-request-metadata`.

Validation: all 21 related MCP session/failure-audit and audit HTTP tests passed, along with TypeScript, style and diff checks. The gateway image compiled successfully and became healthy. Public HTTPS/OAuth verification passed. Runtime checks verified five formerly obscured method names, and two unauthenticated diagnostic requests created the expected 401 audit records with exact method names, message kinds and `sessionHeaderPresent: false`.

The build also surfaced an existing dependency advisory: `npm audit --omit=dev` reports one critical finding for `proxy-addr` 2.0.7, [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), fixed in 2.0.8. The advisory concerns IPv6 trust-subnet compilation; this gateway configures numeric `trust proxy: 1`. Dependency updates were outside this diagnostic deployment and remain a separate maintenance item.

## MCP/development split (deployed 2026-10-04)

The per-account MCP and SSH development containers are separated again. MCP uses the clean runner image, a private temporary HOME, read-only root, dropped capabilities and no-new-privileges, with no sudo. Development HOME, existing AI credentials/programs and directly installed system packages remain in the developer-only environment. Shared project/runtime mounts, account identities, roles, authentication versions and all three SSH host keys were retained. The two active accounts have running MCP and healthy SSH containers; the disabled account's pair remains unstarted.

Existing GitHub authentication on the crasnec account is available through MCP gh and the Git HTTPS credential helper. Only Git identity and HTTPS Git/gh credentials cross the boundary, without original Git aliases/helpers/includes, gh aliases/extensions or SSH/AI authentication. The dara0994 account had no existing gh login; its Git identity is available and it can authenticate through development SSH. Both account HOME file hashes match the pre-transition evidence. Native SSH, rollback, authentication change/logout, account rename and stopped-state preservation were also verified with disposable Docker accounts.

Full regression verification passed: 289 tests across 46 files, followed by the 14 affected Git/provisioner tests after the final identity adjustment. TypeScript, style, shell syntax, public HTTPS/OAuth checks and production mount/network/Git-authentication checks passed. Process-terminal notices now render once outside the log stream. MCP initialization and command/process tool descriptions prohibit other-agent execution/delegation and alternate launch paths. Existing MCP clients must initialize a new session after the gateway update.

Pre-transition metadata, SSH authorization/key backups and preservation evidence are in the private `/tmp/dev-mcp-pre-split-20261004` directory. Prior gateway/provisioner/telemetry/runner images have `rollback-20261004-before-split` tags. The provisioner retains each developer snapshot image in `runner-status/runtime-splits.json`; preserve these images and the private HOME/authentication volumes.

## Earlier npm global installs and Bash startup (2026-10-04, before separation)

The development image now initializes missing Fedora `.bashrc` and `.bash_profile` files in the shared HOME and gives npm a user-owned default prefix, `${HOME}/.local`. Interactive shells display `[user@hostname directory]$`, and global npm commands are available to SSH and MCP. Existing personal startup files, registry/authentication settings and explicit npm prefixes are retained. Installed npm packages persist in the workspace volume through recreation.

Runner image: `a6e74d68240f`. The previous base image is tagged `dev-mcp-runner:rollback-20261004-before-npm-shell`. Existing account containers received the updated development startup scripts in place; the two running accounts' homes were initialized without restarting their containers or SSH entry. The disabled account remains unstarted and has the corrected startup scripts ready for its next authorized start. Original startup script copies are retained in `/tmp/dev-mcp-development-shell-backup-20261004`.

Ordinary-user offline global package installation and command execution through login-shell and MCP environments passed in both running account containers. All eleven isolated native SSH integration checks passed, including the Bash prompt and global npm CLI surviving recreation. Repeated initialization preserves existing shell/npm settings. Reload existing terminals with `source ~/.bashrc` to pick up the prompt and user PATH.

## MCP tool visibility in audit (deployed 2026-10-03)

The gateway was rebuilt and recreated at 22:10 UTC. The previous command layout emphasized only `params.command`, which none of the nine stored MCP tool-call records contained. MCP tool names now appear first in the row heading in larger, darker text, before the secondary event label. Inline details show the invoked tool and recorded arguments before the reason and process output; shell commands still appear expanded first when present.

Gateway image: `0c18f77243fe`. The preceding command-layout image is tagged `dev-mcp-gateway:rollback-20261003-before-audit-tool-layout`. Only the gateway was recreated; per-user runners and account/workspace state were retained.

Validation: all 31 related audit/live-update tests passed, including MCP calls without `params.command`, argument escaping and automatic updates. TypeScript build, style and diff checks passed. All nine actual stored tool-call records were rendered with the deployed templates and confirmed to put the tool ahead of the event label and process output. Public assets include the updated layout, and public HTTPS verification passed.

## Audit command visibility (deployed 2026-10-03)

The gateway was rebuilt and recreated at 21:59 UTC. Audit lists now put the requested command in the first column, ahead of event metadata, time and actor. Commands wrap within the column, with previews bounded to 320 characters to keep incremental polling small. The full requested command is expanded at the top of inline details before the reason and process output, including records with related processes. Server-rendered and automatically refreshed rows use the same layout.

Only the gateway was recreated; per-user runners and stored account/workspace state were retained. Gateway image: `7acc56274695`. The preceding failure-audit image is tagged `dev-mcp-gateway:rollback-20261003-before-audit-command-layout`.

Validation: all 29 related audit/live-update tests passed, including command escaping, preview payload bounds and detail order after live updates. TypeScript build, style checks and diff checks passed. Public HTTPS verification passed after deployment.

## MCP failure audit (deployed 2026-10-03)

The gateway was rebuilt and recreated at 21:44 UTC to record errors previously absent from the audit log: bearer authentication, session validation, JSON/HTTP/protocol rejection and SDK tool-input validation before a tool handler runs. OAuth token exchange and refresh rejections now produce `oauth_token_failed` records. Administrator audit details display failure stages, error codes, HTTP/RPC status and sanitized schema issues. Raw bearer/refresh tokens, authorization headers, cookies, argument values and SDK error text are excluded from these new failure records. Known token principals are retained for attribution on rejection; unknown or already-pruned credentials remain unattributed.

Only the gateway was recreated. Accounts, OAuth state, workspace storage and both running user containers were retained. As with previous gateway restarts, existing MCP sessions must be initialized again. Gateway image: `548521b9ba79`. The prior image is tagged `dev-mcp-gateway:rollback-20261003-before-failure-audit`.

Validation: TypeScript build, repository style/format checks and all 269 tests across 43 test files passed. Full tests ran in the isolated verification image with no network or production volumes; the bare host lacks runner search tooling. Public HTTPS verification passed after deployment, including Google authorization start/provider reachability and MCP authentication rejection. Diagnostic requests to the live public MCP and OAuth token endpoints returned 401 and created the expected sanitized failure records in the production audit file.

## Deployment command

```bash
C="-f compose.yaml -f compose.google.yaml -f compose.server.yaml -f compose.telemetry.yaml -f compose.ssh.yaml"
sudo docker compose $C build runner gateway provisioner telemetry ssh-entry
sudo docker compose $C build workspace
sudo docker compose $C up -d --no-deps --wait gateway provisioner telemetry ssh-entry
node scripts/verify-public.mjs https://dev.crasnec.com
```

A new runner image applies to runners created afterwards; existing per-account runners keep the image they were created with.

`compose.server.yaml` is a host-local, Git-ignored override. It maps Google credential copies and `/user-ipc` through the Docker host's `/home/crasnec/workspace/dev-mcp/data` directory. This development environment sees that repository as `/workspace/dev-mcp`. Do not replace these mappings with container-local paths.

The public reverse proxy is the standalone `edge-proxy-caddy-1`, operated from `/home/crasnec/services/caddy/compose.yaml` outside application Git repositories and connected to `dev-mcp_edge`. Do **not** start this repository's separate `caddy` service on this server: the standalone proxy owns ports 80/443. Its active configuration has access logging disabled. If the proxy is stopped, start it with `sudo docker compose -f /home/crasnec/services/caddy/compose.yaml up -d`.

## Standalone HTTPS proxy (2026-10-02)

Caddy operations were moved out of plan-app's repository into `/home/crasnec/services/caddy`. The current Caddyfile was retained, including all four existing site routes, and bind-mounted read-only into the official `caddy:2.11.4` image. Certificate and runtime configuration data were copied while the previous proxy was stopped to the independent external volumes `edge-proxy-caddy-data` and `edge-proxy-caddy-config`. The standalone proxy joins the existing `caddy` and `dev-mcp_edge` networks; application containers are managed separately.

plan-app's `deploy/Caddyfile`, `deploy/Caddyfile.example`, `deploy/Dockerfile.caddy` and `compose.edge.yaml` were removed from its entire reachable Git history, including GitHub main. Documentation and Git/Docker exclusion rules were updated. Its four unpushed application commits remain local. Rewritten GitHub main: `3b3a1ff`; local main: `2c6f891`.

The standalone Compose and Caddy configurations validate, the operational directory is outside Git, and dev-mcp public HTTPS health returns 200. Historical sections below refer to the previous proxy names and locations.

## Fresh onboarding reset (2026-10-02)

At the owner's request, all existing accounts, OAuth/browser credentials, account SSH registrations, app/control state, project registries, runner logs, telemetry history and installation assignments were cleared. Existing per-account runner/workspace containers and the legacy shared runner were removed, along with their runtime-data volumes and user networks. The gateway, provisioner, telemetry and SSH entry were then recreated with fresh state.

The administrator's `/home/crasnec/workspace` bind mount and its legacy reserved-workspace assignment are gone. The original host files and the old dedicated user's workspace volume remain preserved and detached; new accounts cannot access them. No account is seeded or restored. Administrators use the same provisioning path as every other account. With the onboarding workspace root left empty, each approved account receives its own named workspace volume.

Google OAuth client configuration and the public HTTPS proxy were retained. SSH entry's host key was retained to preserve client trust; all account authorizations and per-account host keys were cleared. Existing account SSH aliases and MCP authorizations must be configured again after registration.

Verification: zero users, no completed onboarding timestamp, no configured workspace root or reserved workspace, no account runner/workspace containers, and HTTP 200 from the local onboarding code page. Gateway, telemetry and SSH entry are healthy, provisioner is running, and public HTTPS verification passed.

Onboarding is available at `http://127.0.0.1:3100/` on the Docker host or through host SSH port forwarding. Obtain the current installation code from `sudo docker logs dev-mcp-gateway-1 2>&1 | rg onboarding_available`, register through Google, and select that pending account as the first administrator in onboarding. Keep the workspace root empty to use per-account Docker volumes.

The deployment history below predates this reset.

## Empty workspace root form fix (2026-10-02)

The gateway was rebuilt and recreated after fixing empty workspace-root submissions: an empty or whitespace-only value now selects per-account Docker volumes and clears a previously configured host root. The onboarding form always shows **Docker 볼륨 사용** and marks the host path optional. Existing state was retained and onboarding was not completed. Gateway restart invalidates the local onboarding session and generates a new installation code.

Verification: all 24 onboarding and runner-workspace tests passed, formatting and style checks passed, the gateway image compiled successfully, and public HTTPS verification passed. Deployed gateway image: `87c7938d0337`.

## Native SSH workspaces (deployed 2026-10-02)

Commit `3a87f76` is deployed with `compose.ssh.yaml`. Gateway, provisioner, telemetry and SSH entry were built and started; the derived workspace image was built after the runner image. The retired `dev-fedora` remains stopped, and SSH entry now publishes host TCP 2222. Only dev-mcp services, both accounts' runners/workspaces and the existing HTTPS proxy were restarted after the requested shutdown. The plan-app application, matchamap application and PostgreSQL remain stopped.

Existing account runners retain their previous images and storage mounts. Both SSH workspaces use `dev-mcp-workspace:latest` and share their respective account's existing work storage. No data volumes or host workspace files were removed.

Verification: public and local HTTPS health return 200, `verify-public.mjs` passed, both accounts' signed `project_list` calls succeeded, and host port 2222 returns an OpenSSH banner and host key. Gateway, telemetry and SSH entry are healthy; provisioner is running without reconciliation errors.

Neither account has registered an SSH public key yet. Their workspace containers are running, but SSH is disabled by the fresh authorization manifests, so their SSH health checks report unhealthy until a key is registered at `/account/workspace`. Register a public key there and download the generated SSH configuration before connecting with VS Code Remote - SSH.

## Per-account runners only, onboarding and host workspaces (deployed 2026-10-01)

Commit `46da0f8` was deployed at about 22:55 UTC. It also contains the apps code, which stays inactive until `PREVIEW_DOMAIN` is set (next section).

1. The current images were tagged `rollback-20261001-before-accounts`:

   | Image            | ID             |
   | ---------------- | -------------- |
   | gateway          | `e336f09674f8` |
   | runner           | `b0a702391709` |
   | provisioner      | `b8c74a02bfca` |
   | telemetry        | `2b0389dcc000` |
   | `plan-app-caddy` | `e65ed7f25d44` |

   The new images are gateway `09a27ec5d0ef`, runner `2bac23575617`, provisioner `73e861310ee5` and telemetry `44ae03f0ec92`.

2. Host loopback ports 3100 and 3200 were free. The shared runner had no background processes.
3. Gateway and provisioner were stopped, and `scripts/migrate-primary-runner.sh` was run, first as a dry run, then with `--apply`. It migrated the administrator account `fc14e8ef-791e-4014-9f04-c639def636eb`:
   - `dev-mcp_runner-data` was copied to `dev-mcp-user-fc14e8ef-…-data`.
   - `/home/crasnec/workspace` was registered as that account's reserved (legacy) host workspace.
   - `users.json.pre-primary-migration` was written to `dev-mcp_gateway-data`.
4. `up -d --no-deps --wait gateway provisioner telemetry` brought all three up healthy. The provisioner created `dev-mcp-user-fc14e8ef-…` from the new runner image, with `/home/crasnec/workspace` at `/workspace` and a new signed IPC key.

Verification:

- `verify-public.mjs` passed all 36 checks.
- Signed `project_list` calls returned 5 projects for the administrator and 0 for the dedicated user.
- Telemetry reports the host and both runners.
- The local onboarding is available. Its administrator step is skipped because an active administrator exists. No workspace root is set yet, so new accounts still get Docker volumes.

The old `dev-mcp-runner-1` (exited) and `dev-mcp_runner-data` are kept for rollback.

The dedicated user's runner `dev-mcp-user-989ec54d-…` was left running on its older image `20fd5131486c`. It serves normal tools, but that account's apps will report the server as unavailable until the runner is recreated from the current image. A limit change that recreates the container, or a workspace move, does this.

Onboarding: `dev-fedora` uses the host network, so `http://127.0.0.1:3100/` opens there directly, and through VS Code port forwarding. The code is in `docker logs dev-mcp-gateway-1 | grep onboarding_available`. If you set a workspace root:

- It must lie outside `/home/crasnec/workspace`, the administrator's reserved workspace. For example `/home/crasnec/dev-mcp-workspaces`, owned by UID 1000.
- New accounts' directories there are not mounted in `dev-fedora`. Open them with Remote - SSH to the Docker host.

Rollback:

1. Stop gateway and provisioner.
2. Remove `dev-mcp-user-fc14e8ef-…`.
3. Restore `users.json.pre-primary-migration` in `dev-mcp_gateway-data`.
4. Delete the account's entry from `workspace-dirs.json` in `dev-mcp_runner-status`.
5. Start `dev-mcp-runner-1`.
6. Redeploy the `rollback-20261001-before-accounts` gateway, provisioner and telemetry images.

## Apps public URLs (enabled 2026-10-02)

Apps go under the console host: `https://<name>.dev.crasnec.com`.

Commit `067dd4e` was deployed at about 00:13 UTC on 2026-10-02. Only the gateway image changed (`bf03b6e7a62e`); runner, provisioner and telemetry rebuilt from cache with unchanged IDs. The previous images, and `plan-app-caddy` `e65ed7f25d44`, are tagged `rollback-20261002-before-preview`. Type checking, formatting and all 234 tests passed (the tests ran in the runner image).

1. Done. The gateway was deployed with the documented command, then `PREVIEW_DOMAIN=dev.crasnec.com` was added to `.env` and the gateway recreated. It logs `preview_ready` on port 3200, and from `plan-app-caddy-1` the TLS ask endpoint answers 404 for unknown hosts.
2. Done. `*.dev.crasnec.com` resolves as a CNAME to `crasnec.duckdns.org`.
3. Done at about 00:17 UTC. plan-app's Caddy, which owns ports 80/443 here, now has:
   - the global `on_demand_tls { ask http://gateway:3200/__dev-mcp/tls-allowed }`;
   - a `*.dev.crasnec.com { tls { on_demand } reverse_proxy gateway:3200 { flush_interval -1 } }` block, as in this repository's `Caddyfile.preview`.

   The change is in `/workspace/plan-app/deploy/Caddyfile`, uncommitted, like its earlier `matcha.oaknamu.com` block. `caddy validate` passed, the `plan-app-caddy` image was rebuilt (`25257a1c8a2a`) and only that service was recreated. Afterwards `plan.crasnec.com`, `matcha.oaknamu.com` and `dev.crasnec.com/healthz` returned 200, `verify-public.mjs` passed all 36 checks, and an unknown app host gets no certificate (TLS handshake fails).

   Rollback: remove `PREVIEW_DOMAIN` from `.env` and recreate the gateway, or redeploy `dev-mcp-gateway:rollback-20261002-before-preview`. For the proxy, remove the two blocks above from the Caddyfile and rebuild, or recreate the service from `plan-app-caddy:rollback-20261002-before-preview`.

4. Pending: no app exists yet. Verify with an app in the administrator's account:
   1. Open a private app; it should go through the console sign-in redirect.
   2. Switch it to public and open it again.

## Automatic user runner creation (2026-09-22)

Account approval previously saved only the runner identity; creating its container required the manual host helper. The separate `provisioner` service now polls active accounts every five seconds and creates missing dedicated runners with that helper. It also repairs already-approved accounts and retries failed creations. Running or deliberately stopped containers are preserved. Pending/disabled accounts are skipped.

The provisioner alone receives the Docker socket, has no network, and mounts `gateway-data` read-only. `DAC_READ_SEARCH` lets it read the gateway-owned mode-0600 account file without changing its permissions. The gateway and runners still have no Docker access. Check `sudo docker compose logs provisioner` for UUID-only success/failure events. Stop the provisioner during maintenance if an active user's container must remain absent.

The gateway and provisioner were rebuilt and started; the existing primary runner and reverse proxy were left running. The previously missing approved user's container was automatically created, with separate workspace/data volumes, network, IPC directory and key. Authenticated `project_list` calls succeeded for both primary and dedicated runners. The dedicated runner returned an empty project list, as expected for a new workspace. No existing projects were modified.

Type checking, formatting, shell syntax and all 46 tests passed. Tests ran in the existing Fedora runner image because this development environment intercepts subprocess executable resolution. Public HTTPS health, login/signup, Google authorization start, OAuth metadata and MCP authentication checks passed after deployment.

## Previous deployment verification (2026-09-21)

- Build, formatting and all 39 tests passed after compatible runtime dependency security updates and the browser-form regression fix.
- `npm audit --omit=dev` reported zero vulnerabilities. Development-only dependency warnings remain outside the runtime image.
- Gateway and runner are healthy, with read-only root filesystems, all capabilities dropped, and separate networks.
- Public HTTPS health, login/signup, CSS, OAuth metadata, unauthenticated admin redirect and MCP 401 response passed.
- Password registration is rejected, Google authorization starts with PKCE and the correct callback, and Google's sign-in page is reachable. Interactive Google authentication still requires the account owner.
- Native Chromium form submission reproduced the original `/auth/google` 403 (`Origin: null` under `no-referrer`). Form pages now use `same-origin` referrer policy and allow the Google authorization redirect in CSP. The deployed browser flow was verified to send the correct Origin and receive 303 to Google; external referrers remain suppressed. CSRF token and origin checks remain enforced.
- All 14 existing projects remain registered in the original primary workspace. No project files were moved or deleted.

## Existing projects and Google ownership

The production system had no multi-user records before this deployment. The bootstrap `admin` account now owns the original primary runner. `crasnec@gmail.com` has not yet been authenticated or linked.

To use that Google identity for the existing projects, sign in as the existing `admin`, open **내 계정 → Google 계정 연결**, and authenticate as **crasnec@gmail.com**. This preserves the account ID, primary workspace, project IDs and administrator role. It invalidates old sessions/MCP credentials; reconnect MCP clients afterward. Do not register a separate new Google account first if the intention is to keep the existing primary account. No Google subject identifier was fabricated, and no automatic email-based account merge was performed.

## Rollback assets

- Images: `dev-mcp-gateway:rollback-20260921`, `dev-mcp-runner:rollback-20260921`.
- Private Docker volume: `dev-mcp-backup-20260921`, containing `gateway.tar.gz` and `runner.tar.gz` (approximately 1.1 MiB and 1.9 GiB).
- Existing project files remain in the unchanged `/home/crasnec/workspace` bind mount; that workspace was not included in the metadata/runtime-volume archive.

Do not remove the backup volume or original data volumes during rollback. First stop the gateway/runner, preserve any post-deployment changes in a separate backup, and restore the matching old images/configuration and data deliberately. The old gateway uses the previous single-user authentication model, so rollback also changes the security model. Never dump credential files, cookies, tokens or full configuration environment values into logs while troubleshooting.

## Web runner operations and quotas deployed (2026-09-22)

Following explicit deployment authorization, commit `e9b4e0a` was deployed at approximately 04:38 UTC. The gateway and provisioner were rebuilt and recreated with the new `runner-status` volume. Web administrators can now request runner creation/start/stop/restart, account-wide external network access, memory/CPU/PID limits, per-file size limits and hard combined workspace/runtime storage quotas.

The existing primary and dedicated runner containers and reverse proxy were left running. No production account received a resource limit change or storage migration during deployment. Quota storage is initialized only when an administrator requests a nonzero storage limit for a dedicated user; the original primary workspace is excluded. Review the storage backup/loop-device notes in README before enabling quotas.

Deployment verification passed: public HTTPS health, login/signup, static assets, Google authorization start and provider reachability, OAuth metadata, unauthenticated admin redirect and MCP authentication rejection. Authenticated read-only `project_list` calls succeeded for both active accounts (four primary projects and one dedicated-runner project at verification time). The gateway could read fresh observations for both running containers from the status volume, and the provisioner logged no reconciliation errors.

Development verification previously passed: 55 tests, TypeScript, formatting and shell syntax; disposable Docker lifecycle/resource/network tests; and a full temporary-volume migration test confirming combined workspace/runtime hard quota, quota increase and preserved source volumes.

Deployed image IDs:

- Gateway: `sha256:898fe033b52962cb56d8521288c3fbc6d1b32deba087e58a6e25ae42d04bc0d9`.
- Provisioner: `sha256:8017bcc4fdf92732cb9bf38ead9dac3015ba5e1f9cafb822525ba3c2f4a7a1a2`.

The immediately preceding images are retained as `dev-mcp-gateway:rollback-20260922-before-controls` and `dev-mcp-provisioner:rollback-20260922-before-controls`. These are separate from the older single-user rollback assets above. Preserve any subsequently applied runner settings and quota storage when planning a rollback.

## Separated development and MCP containers

Build `runner gateway provisioner telemetry ssh-entry` with the existing overlays (including `compose.ssh.yaml`), then build `workspace` against the updated runner. Recreate only the control-plane services with `--no-deps`; the provisioner handles per-account migration. Each account receives a hardened MCP container `dev-mcp-user-<google-id>` and a separate development container `dev-mcp-workspace-<google-id>`. The UUID-based private SSH alias and host keys remain unchanged.

The split migration stops the original, preserves its writable image in a development-only snapshot, copies its existing embedded HOME into `dev-mcp-user-<UUID>-home`, and creates the MCP runner from the clean runner image. Project/runtime volumes and IPC keys remain intact. Only Git identity and HTTPS Git/gh authentication are exported into `dev-mcp-user-<UUID>-git-auth`, mounted read-only by MCP. Developer HOME, AI credentials/programs, Git/gh executable aliases/extensions, SSH authentication and networks are unavailable to MCP. Ordinary development commands remain available; see SECURITY.md for the arbitrary-shell boundary.

Both replacement services must become ready before removing a running original. A failed split restores the original and waits for a fresh runner operation. Disabled and intentionally stopped accounts stay stopped. `runner-status/runtime-splits.json` records the phase and snapshot image. Retain that journal, private HOME/authentication volumes and development snapshots with account backups. The old embedded HOME remains under a read-only mode-000 mask in MCP as a recovery copy, not a live shared HOME. Never prune volumes or snapshot images during migration.

For the email-naming update, build and recreate only `provisioner telemetry` with `--no-deps`; the runner, gateway and SSH-entry images do not need rebuilding. The provisioner migrates both per-account volumes to `dev-mcp-user-<google-id>-workspace` and `-data` using verified copies while the account is stopped. It preserves the development container's writable layer in a local snapshot image, retaining directly installed packages, and rolls back the container on copy/startup failure. UUID-named original volumes remain available for recovery. Do not prune volumes during this transition. The host volume paths follow these names; the account's UUID, IPC paths and SSH authorization remain stable. A pre-existing destination owned by another account is rejected rather than renamed or shared.

`runner-status/naming-migrations.json` records copy progress and completion. After completion, the new volumes are authoritative: recreating a container reuses them rather than restoring the older UUID-named copies. A failed migration restores the original container and waits for a fresh runner operation before retrying. Keep the status volume with the account volumes in backups.

MCP and SSH share project files under `/workspace`. Development HOME is `/workspace/.dev-mcp-home` in a private persistent volume; MCP uses temporary `/home/runner`, no sudo, a read-only root, dropped capabilities and no-new-privileges. Sudo and `dev-mcp-install` remain available through development SSH. GitHub HTTPS authentication configured with `gh auth login --web --git-protocol https` and Git identity changes propagate within five seconds, including logout. MCP keeps its own writable gh configuration copy for CLI schema migrations. Project pages offer HTTPS clone and registration. MCP process lists/app proxies reach only MCP-started processes; development servers use SSH forwarding.

Personal SSH workspace operations and administrator MCP runner operations have independent lifecycles. Storage copies pause both writers. Disabled accounts stop both during reconciliation. Resource limits apply to each container; per-user CPU/memory/network/activity telemetry sums both, and shared project/runtime disk is counted once. The private development HOME and image layers are outside project/runtime storage quota. Browser sessions, active MCP sessions and per-user OAuth grant revocation are in administrator user details; `/admin/connections` redirects to the searchable user list. Audit records resolve users to emails, identify installation events as system actions, preserve target metadata and support `owner` filtering.
