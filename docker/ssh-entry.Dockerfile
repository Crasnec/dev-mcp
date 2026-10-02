FROM node:22-alpine
RUN apk add --no-cache openssh-server \
    && mkdir -p /registry /var/empty /opt/dev-mcp \
    && rm /etc/passwd \
    && ln -s /registry/passwd /etc/passwd
COPY docker/ssh-entry-sshd_config /opt/dev-mcp/sshd_config
COPY scripts/ssh-server.mjs /opt/dev-mcp/ssh-server.mjs
ENV SSH_MANIFEST_FILE=/registry/access.json \
    SSH_CONFIG_FILE=/opt/dev-mcp/sshd_config
USER 0:0
EXPOSE 2222
CMD ["node", "/opt/dev-mcp/ssh-server.mjs"]
