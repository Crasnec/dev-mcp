FROM docker:28-cli AS docker-cli
FROM node:22-alpine
RUN apk add --no-cache bash util-linux xfsprogs xfsprogs-extra coreutils rsync
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/dev-mcp
COPY scripts/provision-user.sh scripts/reconcile-user-runners.mjs scripts/runner-operations.mjs scripts/quota-storage.sh scripts/
ENV NODE_ENV=production
CMD ["flock", "-n", "/runner-status/controller.lock", "node", "scripts/reconcile-user-runners.mjs"]
