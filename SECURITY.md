# Security policy

This service intentionally exposes arbitrary shell execution and destructive workspace operations after OAuth authorization. Treat every access token and the administrator password as high-value credentials.

Report vulnerabilities privately to the repository owner. Do not include real access tokens, password hashes, workspace contents, or audit logs in a public issue.

The supported boundary is the current main branch. Docker daemon compromise, a malicious `local/dev-fedora:44` base image, and host-kernel/container-runtime escapes are outside the application threat model.
