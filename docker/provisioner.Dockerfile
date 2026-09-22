FROM docker:28-cli AS docker-cli
FROM node:22-alpine
RUN apk add --no-cache bash
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/dev-mcp
COPY scripts/provision-user.sh scripts/reconcile-user-runners.mjs scripts/
ENV NODE_ENV=production
CMD ["node", "scripts/reconcile-user-runners.mjs"]
