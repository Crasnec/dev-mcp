ARG RUNNER_IMAGE=dev-mcp-runner:workspace-test
FROM node:22-alpine AS dependencies
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/runner/package.json packages/runner/tsconfig.json packages/runner/
COPY packages/gateway/package.json packages/gateway/tsconfig.json packages/gateway/
RUN npm ci

FROM ${RUNNER_IMAGE}
USER 0:0
WORKDIR /src
COPY --from=dependencies --chown=runner:runner /src/ /src/
COPY --chown=runner:runner packages/ packages/
COPY --chown=runner:runner scripts/ scripts/
COPY --chown=runner:runner vitest.config.ts ./
USER runner:runner
ENV NODE_ENV=test
CMD ["npm", "test"]
