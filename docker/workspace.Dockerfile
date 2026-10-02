ARG RUNNER_IMAGE=dev-mcp-runner:latest
FROM ${RUNNER_IMAGE}
# Compatibility image: MCP and SSH now run in the same development container.
