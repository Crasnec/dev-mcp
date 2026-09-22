# Current server deployment

Updated on 2026-09-22 at `https://dev.crasnec.com`.

## Deployment command

```bash
sudo docker compose -f compose.yaml -f compose.google.yaml -f compose.server.yaml up -d --build --wait runner gateway provisioner
node scripts/verify-public.mjs https://dev.crasnec.com
```

`compose.server.yaml` is a host-local, Git-ignored override. It maps Google credential copies and `/user-ipc` through the Docker host's `/home/crasnec/workspace/dev-mcp/data` directory. This development environment sees that repository as `/workspace/dev-mcp`. Do not replace these mappings with container-local paths.

The public reverse proxy is the existing `plan-app-caddy-1`, connected to `dev-mcp_edge`. Do **not** start this repository's separate `caddy` service on this server: the existing proxy owns ports 80/443. Its active configuration has access logging disabled. Other plan-app services were not changed.

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

## Development changes awaiting deployment

The web execution-environment operations and resource/quota management changes have **not** been deployed. As requested, verification uses a separately tagged development image and disposable test containers only. Do not run Compose `up`, recreate production services, or migrate production storage as part of this development work.

When a future deployment is explicitly authorized, the gateway and provisioner need the updated images and the new `runner-status` volume mounts. Quota storage is initialized only when an administrator requests a nonzero storage limit for a dedicated user. The prior primary workspace and existing runner volumes must be preserved. Review the storage backup/loop-device notes in README before enabling quotas.

Development verification passed: 55 tests, TypeScript, formatting and shell syntax; disposable Docker lifecycle/resource/network tests; and a full temporary-volume migration test confirming combined workspace/runtime hard quota, quota increase and preserved source volumes. No production account received a resource or storage change.
