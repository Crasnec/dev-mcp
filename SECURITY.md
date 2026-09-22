# Security policy

This service intentionally exposes arbitrary shell execution and destructive workspace operations after OAuth authorization. Treat every access token and the administrator password as high-value credentials.

Report vulnerabilities privately to the repository owner. Do not include real access tokens, password hashes, workspace contents, or audit logs in a public issue.

The supported boundary is the current main branch. Docker daemon compromise, upstream container image or package-registry compromise, and host-kernel/container-runtime escapes are outside the application threat model.

The separate provisioner is a trusted host control-plane service with Docker daemon access and a read-only account database mount. It has no network or HTTP endpoint, polls approved accounts, validates UUID and runner identity, and invokes a fixed creation helper. The gateway and all runners have no Docker access. Pending/disabled accounts are skipped; existing stopped containers are not restarted automatically. Approval withdrawal cannot cancel a Docker creation already in flight, but account authentication checks continue to block access.

Approved users receive dedicated runner containers, workspace/data volumes, bridge networks, and per-user authenticated IPC endpoints. The gateway chooses the runner from the authenticated account; clients cannot supply a runner identity. Per-user IPC calls are signed and wrapped in a method the legacy primary runner does not execute, preventing socket redirection from reaching another runner. No user runner mounts the shared parent IPC directory.

Projects are private to their owner's execution environment. Administrators can inspect users and project metadata; administrator privileges are trusted service-wide privileges. Do not promote untrusted users. The primary administrator retains the pre-existing workspace.

Disabling an account or revoking its credentials prevents subsequent authenticated requests and image retrieval. It does not interrupt already-dispatched commands or stop background processes; the operator must stop the user's container to terminate them. All containers still share the host kernel, and default resource limits do not prevent a user from consuming excessive host resources. Apply host/container resource limits for untrusted workloads.

The gateway must run as a single process when using the JSON stores; the in-process write queue does not coordinate multiple gateway replicas. Back up user records together with OAuth state so credential versions are not rolled back independently.

New accounts require Google OIDC authentication and administrator approval; there is no local-password registration endpoint. Existing local-password accounts remain usable for migration and initial administrator access. Google identities are bound by the verified `sub`, never auto-linked by email. Explicit linking requires an authenticated browser session, CSRF token, browser-bound OAuth state, and a still-valid matching session and credential version at callback time. Linking preserves roles/workspaces and invalidates prior account sessions and MCP credentials. Already-linked identities cannot be reassigned or merged through the login flow.

Google sign-in uses state, nonce and PKCE; ID tokens must have a valid RS256 signature from Google's keys, accepted issuer, correct audience/authorized party, recent issuance, unexpired lifetime and verified email. Browser and MCP credentials are issued only for active accounts. Google access/refresh tokens are not persisted. Provider errors are not reflected or logged. Authentication URLs containing codes/transactions are omitted from Caddy access logs, and form pages use `Referrer-Policy: same-origin` to preserve native form Origin headers while suppressing cross-origin referrers (non-form pages use `no-referrer`); configure any upstream proxies consistently.

Google credentials are loaded only by the gateway at runtime. `scripts/import-google-secrets.mjs` copies the named files without reading their contents into logs or command arguments; `compose.google.yaml` mounts only the two files, never the whole plan-app directory. Preserve the mode-0700 parent directory of the read-only copies. Keep originals, copies and backups out of repositories/build contexts. Reusing a plan-app OAuth client shares its branding, allowed callbacks and secret-rotation lifecycle; add callbacks rather than replacing existing ones, and coordinate rotation across both applications.
