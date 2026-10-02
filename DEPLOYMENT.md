# Current server deployment

Updated on 2026-10-01 at `https://dev.crasnec.com`.

## Deployment command

```bash
C="-f compose.yaml -f compose.google.yaml -f compose.server.yaml -f compose.telemetry.yaml"
sudo docker compose $C build runner gateway provisioner telemetry
sudo docker compose $C up -d --no-deps --wait gateway provisioner telemetry
node scripts/verify-public.mjs https://dev.crasnec.com
```

A new runner image applies to runners created afterwards; existing per-account runners keep the image they were created with.

`compose.server.yaml` is a host-local, Git-ignored override. It maps Google credential copies and `/user-ipc` through the Docker host's `/home/crasnec/workspace/dev-mcp/data` directory. This development environment sees that repository as `/workspace/dev-mcp`. Do not replace these mappings with container-local paths.

The public reverse proxy is the existing `plan-app-caddy-1`, connected to `dev-mcp_edge`. Do **not** start this repository's separate `caddy` service on this server: the existing proxy owns ports 80/443. Its active configuration has access logging disabled. Other plan-app services were not changed.

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

## Pending: apps public URLs (code deployed, not enabled)

Apps go under the console host: `https://<name>.dev.crasnec.com`.

1. Deploy a gateway that accepts the console host as `PREVIEW_DOMAIN`; the image deployed on 2026-10-01 refuses it and would not start. Then set `PREVIEW_DOMAIN=dev.crasnec.com` in `.env` and recreate the gateway.
2. Add a Cloudflare DNS record `*.dev` as a CNAME to `crasnec.duckdns.org`, the same dynamic-DNS target as `dev` and `plan`. Keep it DNS only, so Caddy can answer the HTTP certificate challenges.
3. Add the app site to plan-app's Caddy, which owns ports 80/443 here:
   - the global `on_demand_tls { ask http://gateway:3200/__dev-mcp/tls-allowed }`;
   - a `*.dev.crasnec.com { tls { on_demand } reverse_proxy gateway:3200 { flush_interval -1 } }` block, as in this repository's `Caddyfile.preview`.

   Then validate it, rebuild the `plan-app-caddy` image and recreate only that service. It also fronts `plan.crasnec.com` and `matcha.oaknamu.com`. The proxy already shares `dev-mcp_edge` with the gateway.

4. Verify with an app in the administrator's account:
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
