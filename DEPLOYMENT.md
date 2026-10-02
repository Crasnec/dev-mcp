# Current server deployment

Updated on 2026-10-02 at `https://dev.crasnec.com`.

## Deployment command

```bash
C="-f compose.yaml -f compose.google.yaml -f compose.server.yaml -f compose.telemetry.yaml -f compose.ssh.yaml"
sudo docker compose $C build runner gateway provisioner telemetry ssh-entry
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

## Unified development containers

Build `runner gateway provisioner ssh-entry` with the existing overlays (including `compose.ssh.yaml`), then recreate only `gateway provisioner telemetry ssh-entry`. The provisioner migrates legacy runner/workspace pairs while preserving account storage, keys, limits and stopped state. It removes old containers after the replacement is reachable through IPC. Each active account now has one `dev-mcp-user-<id>` development container; `dev-mcp-workspace-<id>` remains a private network alias for existing SSH configurations.

MCP and SSH share `/workspace` and HOME `/workspace/.dev-mcp-home`. Sudo works inside the container. Use `dev-mcp-install <packages>` to persist a package list and automatically restore it after recreation; use `dev-mcp-install --restore` to retry. Direct changes to the container image filesystem last until recreation. GitHub authentication configured with `gh auth login --web --git-protocol https` and `gh auth setup-git` is usable from both MCP and SSH. Project pages offer HTTPS clone and registration.

SSH and MCP stop/restart together. Per-user telemetry includes both. Browser sessions, active MCP sessions and per-user OAuth grant revocation are in administrator user details; `/admin/connections` redirects to the searchable user list. Audit records resolve users to emails, identify installation events as system actions, preserve target metadata and support `owner` filtering.
