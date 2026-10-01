FROM node:22-alpine
RUN apk add --no-cache util-linux
WORKDIR /opt/dev-mcp
COPY scripts/collect-runner-telemetry.mjs scripts/telemetry-metrics.mjs scripts/telemetry-store.mjs scripts/telemetry-distribution.mjs scripts/
ENV NODE_ENV=production
CMD ["flock", "-n", "/runner-status/telemetry.lock", "node", "scripts/collect-runner-telemetry.mjs"]
