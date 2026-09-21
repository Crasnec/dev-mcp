# Current server deployment

Applied on 2026-09-21 to `https://dev.crasnec.com`.

## Deployment command

```bash
sudo docker compose -f compose.yaml -f compose.google.yaml -f compose.server.yaml up -d --build --wait runner gateway
node scripts/verify-public.mjs https://dev.crasnec.com
```

`compose.server.yaml` is a host-local, Git-ignored override. It maps Google credential copies and `/user-ipc` through the Docker host's `/home/crasnec/workspace/dev-mcp/data` directory. This development environment sees that repository as `/workspace/dev-mcp`. Do not replace these mappings with container-local paths.

The public reverse proxy is the existing `plan-app-caddy-1`, connected to `dev-mcp_edge`. Do **not** start this repository's separate `caddy` service on this server: the existing proxy owns ports 80/443. Its active configuration has access logging disabled. Other plan-app services were not changed.

## Verification

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
