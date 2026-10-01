# Current server deployment

Updated on 2026-09-22 at `https://dev.crasnec.com`.

## Deployment command

```bash
sudo docker compose -f compose.yaml -f compose.google.yaml -f compose.server.yaml build gateway provisioner
sudo docker compose -f compose.yaml -f compose.google.yaml -f compose.server.yaml up -d --no-deps --wait gateway provisioner
node scripts/verify-public.mjs https://dev.crasnec.com
```

`compose.server.yaml` is a host-local, Git-ignored override. It maps Google credential copies and `/user-ipc` through the Docker host's `/home/crasnec/workspace/dev-mcp/data` directory. This development environment sees that repository as `/workspace/dev-mcp`. Do not replace these mappings with container-local paths.

The public reverse proxy is the existing `plan-app-caddy-1`, connected to `dev-mcp_edge`. Do **not** start this repository's separate `caddy` service on this server: the existing proxy owns ports 80/443. Its active configuration has access logging disabled. Other plan-app services were not changed.

## Pending: per-account runners only, onboarding and host workspaces (developed 2026-10-01, not deployed)

The current server still runs the previous version: the shared `dev-mcp-runner-1` serves the administrator, with the whole `/home/crasnec/workspace`. The new version has no shared runner, so deploying it means migrating that account in the same maintenance window. Nothing below has been run on this server.

1. Check that host loopback port 3100 is free; the gateway now publishes `127.0.0.1:${ONBOARDING_HOST_PORT:-3100}` for the local onboarding.
2. Build: `sudo docker compose -f compose.yaml -f compose.google.yaml -f compose.server.yaml build runner gateway provisioner`.
3. Stop the services: `sudo docker compose -f compose.yaml -f compose.google.yaml -f compose.server.yaml stop gateway provisioner`.
4. Migrate: run `sudo ./scripts/migrate-primary-runner.sh` and review the dry run, then run `sudo ./scripts/migrate-primary-runner.sh --apply`.
   - It finds the single active Google-linked administrator on the shared runner. Read-only check on 2026-10-01: one such account, plus one dedicated user.
   - It copies `dev-mcp_runner-data` into `dev-mcp-user-<id>-data`.
   - It records `/home/crasnec/workspace` as that account's reserved host workspace.
   - It updates `users.json`, keeping a backup.
5. Start the services: `sudo docker compose -f compose.yaml -f compose.google.yaml -f compose.server.yaml up -d --no-deps --wait gateway provisioner`.
   - The provisioner creates the administrator's `dev-mcp-user-<id>` with the same `/home/crasnec/workspace`, so existing projects and IDs remain.
   - The old `dev-mcp-runner-1` stays stopped for rollback.
6. Verify with `node scripts/verify-public.mjs https://dev.crasnec.com`, then check the administrator's projects via MCP. MCP sessions and OAuth tokens stay valid.
7. Open the onboarding through `ssh -L 3100:127.0.0.1:3100` to the Docker host (not `dev-fedora`, whose loopback is its own) with the code from `logs gateway | grep onboarding_available`. The administrator step is skipped. Workspace root:
   - It must lie outside `/home/crasnec/workspace`, which is now the administrator's reserved workspace. For example `/home/crasnec/dev-mcp-workspaces`, owned by UID 1000.
   - New accounts' directories there are not visible in the current `dev-fedora` VS Code session. Open them with Remote - SSH to the Docker host.
   - Alternatively, leave the root unset and keep Docker volumes.

Rollback (printed by the migration script):

1. Stop gateway and provisioner.
2. Remove the new `dev-mcp-user-<id>` container.
3. Restore `users.json.pre-primary-migration` in `dev-mcp_gateway-data`.
4. Remove the entry from `workspace-dirs.json` in `dev-mcp_runner-status`.
5. Start `dev-mcp-runner-1`, and redeploy the previous gateway and provisioner images. Tag them before step 2, e.g. `dev-mcp-gateway:rollback-<date>`.

## Pending: apps (developed 2026-10-01, not deployed)

Requires the pending per-account runner version above, deployed and migrated first. Then:

1. Pick a preview domain on a different registrable domain from `dev.crasnec.com`. `crasnec.duckdns.org` already resolves `*.crasnec.duckdns.org` to this host. Set `PREVIEW_DOMAIN=crasnec.duckdns.org` in `.env` and recreate the gateway.
2. Add the app site to plan-app's Caddy, which owns ports 80/443 here: the global `on_demand_tls { ask http://gateway:3200/__dev-mcp/tls-allowed }` and a `*.crasnec.duckdns.org { tls { on_demand } reverse_proxy gateway:3200 { flush_interval -1 } }` block, as in this repository's `Caddyfile.preview`. Then rebuild the `plan-app-caddy` image. The proxy already shares `dev-mcp_edge` with the gateway.
3. Verify with an app in the administrator's account: open a private app, which goes through the console sign-in redirect. Then switch it to public and open it again.

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
