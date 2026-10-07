ARG RUNNER_IMAGE=dev-mcp-runner:latest
FROM ${RUNNER_IMAGE}
USER 0:0
RUN dnf -y --setopt=install_weak_deps=False install sudo openssh-server bubblewrap \
    && dnf clean all \
    && useradd --non-unique --uid $(id -u runner) --gid runner --home-dir /workspace/.dev-mcp-home --no-create-home --shell /bin/bash workspace \
    && usermod --password '*' workspace \
    && printf '%s\n' '%runner ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/dev-mcp \
    && chmod 0440 /etc/sudoers.d/dev-mcp \
    && visudo -cf /etc/sudoers.d/dev-mcp
COPY docker/workspace-sshd_config /etc/ssh/dev-mcp-sshd_config
COPY scripts/ssh-server.mjs scripts/development-workspace.mjs scripts/development-home.mjs scripts/git-auth.mjs /opt/dev-mcp/scripts/
COPY scripts/dev-mcp-install.mjs /usr/local/bin/dev-mcp-install
RUN chmod 0755 /usr/local/bin/dev-mcp-install
USER runner:runner
ENV HOME=/workspace/.dev-mcp-home \
    RUNNER_USER_HOME=/workspace/.dev-mcp-home \
    GH_CONFIG_DIR=/workspace/.dev-mcp-home/.config/gh \
    PATH=/workspace/.dev-mcp-home/.local/bin:/workspace/.dev-mcp-home/bin:/workspace/.dev-mcp-home/.cargo/bin:${PATH} \
    SSH_WORKSPACE=true \
    SSH_MANIFEST_FILE=/run/dev-mcp-ssh/access.json \
    SSH_CONFIG_FILE=/etc/ssh/dev-mcp-sshd_config
EXPOSE 2222
CMD ["node", "/opt/dev-mcp/scripts/development-workspace.mjs"]
