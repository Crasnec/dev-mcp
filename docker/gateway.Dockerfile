FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/gateway/package.json packages/gateway/tsconfig.json packages/gateway/
COPY packages/runner/package.json packages/runner/tsconfig.json packages/runner/
RUN npm ci
COPY scripts/telemetry-distribution.mjs scripts/telemetry-distribution.d.mts scripts/bootstrap-google-admin.mjs scripts/bootstrap-google-admin.d.mts scripts/
COPY scripts/ssh-access.mjs scripts/ssh-access.d.mts scripts/
COPY packages/gateway/src packages/gateway/src
COPY packages/gateway/views packages/gateway/views
COPY packages/gateway/public packages/gateway/public
RUN npx tsc -b packages/gateway && npm prune --omit=dev

FROM node:22-alpine
RUN addgroup -S -g 10001 mcp && adduser -S -D -H -u 10001 -G mcp mcp \
    && mkdir -p /app /var/lib/dev-mcp \
    && chown -R mcp:mcp /app /var/lib/dev-mcp
WORKDIR /app
COPY --from=build --chown=mcp:mcp /src/package.json /src/package-lock.json ./
COPY --from=build --chown=mcp:mcp /src/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /src/packages/gateway ./packages/gateway
COPY --chown=mcp:mcp scripts/telemetry-distribution.mjs scripts/bootstrap-google-admin.mjs scripts/migrate-primary-account.mjs ./scripts/
COPY --chown=mcp:mcp scripts/ssh-access.mjs ./scripts/
USER 10001:10001
ENV NODE_ENV=production PORT=3000 GATEWAY_DATA_DIR=/var/lib/dev-mcp
EXPOSE 3000 3100
CMD ["node", "packages/gateway/dist/index.js"]
