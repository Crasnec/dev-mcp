ARG RUNNER_IMAGE=dev-mcp-runner:latest
FROM ${RUNNER_IMAGE}
USER 0:0
RUN dnf -y --setopt=install_weak_deps=False install openssh-server \
    && dnf clean all \
    && rm -rf /var/cache/dnf \
    && usermod --login workspace --home /workspace/.dev-mcp-home --password '*' runner \
    && groupmod --new-name workspace runner \
    && mkdir -p /run/dev-mcp-ssh /var/empty/sshd
COPY docker/workspace-sshd_config /opt/dev-mcp/workspace-sshd_config
COPY scripts/ssh-server.mjs /opt/dev-mcp/ssh-server.mjs
USER workspace:workspace
ENV HOME=/workspace/.dev-mcp-home \
    SSH_WORKSPACE=true \
    SSH_MANIFEST_FILE=/run/dev-mcp-ssh/access.json \
    SSH_CONFIG_FILE=/opt/dev-mcp/workspace-sshd_config
EXPOSE 2222
WORKDIR /workspace
CMD ["node", "/opt/dev-mcp/ssh-server.mjs"]
