FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/gateway/package.json packages/gateway/tsconfig.json packages/gateway/
COPY packages/runner/package.json packages/runner/tsconfig.json packages/runner/
RUN npm ci
COPY packages/gateway/src packages/gateway/src
RUN npx tsc -b packages/gateway && npm prune --omit=dev

FROM node:22-alpine
RUN addgroup -S -g 10001 mcp && adduser -S -D -H -u 10001 -G mcp mcp \
    && mkdir -p /app /ipc /var/lib/dev-mcp \
    && chmod 0777 /ipc \
    && chown -R mcp:mcp /app /var/lib/dev-mcp
WORKDIR /app
COPY --from=build --chown=mcp:mcp /src/package.json /src/package-lock.json ./
COPY --from=build --chown=mcp:mcp /src/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /src/packages/gateway ./packages/gateway
USER 10001:10001
ENV NODE_ENV=production PORT=3000 GATEWAY_DATA_DIR=/var/lib/dev-mcp RUNNER_SOCKET=/ipc/runner.sock
EXPOSE 3000
CMD ["node", "packages/gateway/dist/index.js"]
