ARG PROVISIONER_IMAGE=dev-mcp-provisioner:workspace-test
FROM ${PROVISIONER_IMAGE}
RUN apk add --no-cache openssh-client
COPY scripts/test-workspace-ssh.mjs scripts/
COPY scripts/test-runtime-split.mjs scripts/
ENTRYPOINT ["node", "scripts/test-runtime-split.mjs"]
