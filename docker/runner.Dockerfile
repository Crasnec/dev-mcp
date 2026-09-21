FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json tsconfig.base.json ./
COPY packages/runner/package.json packages/runner/tsconfig.json packages/runner/
COPY packages/gateway/package.json packages/gateway/tsconfig.json packages/gateway/
RUN npm ci
COPY packages/runner/src packages/runner/src
RUN npx tsc -b packages/runner

FROM fedora:44
ARG DEV_UID=1000
ARG DEV_GID=1000
RUN dnf -y --setopt=install_weak_deps=False install \
      bash \
      bzip2-devel \
      ca-certificates \
      cargo \
      cmake \
      curl \
      fd-find \
      file \
      findutils \
      gcc \
      gcc-c++ \
      git \
      gzip \
      jq \
      libffi-devel \
      make \
      ninja-build \
      nodejs \
      npm \
      openssl-devel \
      openssh-clients \
      pkgconf-pkg-config \
      procps-ng \
      python3 \
      python3-pip \
      python3-virtualenv \
      readline-devel \
      ripgrep \
      rust \
      sqlite-devel \
      tar \
      unzip \
      wget \
      which \
      xz \
      xz-devel \
      zip \
      zlib-devel \
    && rpm -e --nodeps sudo \
    && dnf clean all \
    && rm -rf /var/cache/dnf \
    && node --version \
    && git --version \
    && rg --version \
    && python3 --version \
    && cargo --version \
    && ! command -v sudo \
    && groupadd --non-unique --gid ${DEV_GID} runner \
    && useradd --non-unique --uid ${DEV_UID} --gid runner --home-dir /var/lib/dev-mcp --no-create-home --shell /bin/bash runner \
    && mkdir -p /opt/dev-mcp/packages/runner /ipc /var/lib/dev-mcp /workspace \
    && chmod 0777 /ipc \
    && chown -R ${DEV_UID}:${DEV_GID} /opt/dev-mcp /var/lib/dev-mcp /workspace
COPY --from=build --chown=${DEV_UID}:${DEV_GID} /src/packages/runner/package.json /opt/dev-mcp/packages/runner/package.json
COPY --from=build --chown=${DEV_UID}:${DEV_GID} /src/packages/runner/dist /opt/dev-mcp/packages/runner/dist
WORKDIR /opt/dev-mcp
USER runner:runner
ENV NODE_ENV=production \
    HOME=/var/lib/dev-mcp \
    WORKSPACE_ROOT=/workspace \
    RUNNER_DATA_DIR=/var/lib/dev-mcp \
    RUNNER_SOCKET=/ipc/runner.sock
CMD ["node", "packages/runner/dist/index.js"]
