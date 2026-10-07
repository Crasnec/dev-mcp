FROM debian:trixie-slim
RUN apt-get update \
    && apt-get install --no-install-recommends -y apparmor \
    && rm -rf /var/lib/apt/lists/*
COPY docker/workspace-apparmor /etc/apparmor.d/dev-mcp-workspace
ENTRYPOINT ["sh", "-eu", "-c", "if test -d /host-apparmor; then install -m 0644 /etc/apparmor.d/dev-mcp-workspace /host-apparmor/dev-mcp-workspace; fi; exec apparmor_parser --replace --skip-read-cache /etc/apparmor.d/dev-mcp-workspace"]
