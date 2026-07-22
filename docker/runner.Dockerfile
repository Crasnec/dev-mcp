ARG DEV_IMAGE=local/dev-fedora:44

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/runner/package.json packages/runner/tsconfig.json packages/runner/
COPY packages/gateway/package.json packages/gateway/tsconfig.json packages/gateway/
RUN npm ci
COPY packages/runner/src packages/runner/src
RUN npx tsc -b packages/runner

FROM ${DEV_IMAGE}
ARG DEV_UID=1000
ARG DEV_GID=1000
USER 0:0
RUN mkdir -p /opt/dev-mcp/packages/runner /ipc /var/lib/dev-mcp \
    && chmod 0777 /ipc \
    && chown -R ${DEV_UID}:${DEV_GID} /opt/dev-mcp /var/lib/dev-mcp
COPY --from=build --chown=${DEV_UID}:${DEV_GID} /src/packages/runner/package.json /opt/dev-mcp/packages/runner/package.json
COPY --from=build --chown=${DEV_UID}:${DEV_GID} /src/packages/runner/dist /opt/dev-mcp/packages/runner/dist
WORKDIR /opt/dev-mcp
USER ${DEV_UID}:${DEV_GID}
ENV NODE_ENV=production WORKSPACE_ROOT=/workspace RUNNER_DATA_DIR=/var/lib/dev-mcp RUNNER_SOCKET=/ipc/runner.sock
CMD ["node", "packages/runner/dist/index.js"]
