# dev-mcp

ChatGPT가 원격 MCP 도구를 반복 호출해 호스트 워크스페이스의 파일, 셸, 백그라운드 프로세스와 Git을 다루게 하는 독립 Docker Compose 배포입니다. OpenAI API 키, Codex CLI 실행, Docker socket 전달을 사용하지 않습니다.

```text
Internet / ChatGPT
        │ HTTPS :443
        ▼
      Caddy ── internal HTTP ──▶ gateway ── Unix socket ──▶ runner
                                   │                         │
                              gateway-data              /workspace:rw
                              (OAuth only)               runner-data
```

gateway에는 `/workspace`가 없고 runner에는 OAuth 상태와 관리자 해시가 없습니다. 두 서비스는 서로 다른 Docker network에 배치되며 공유되는 것은 `runner-ipc` 볼륨의 Unix socket뿐입니다.

## 요구 사항

- Docker Engine과 Docker Compose v2
- 공개 DNS A/AAAA 레코드와 호스트로 연결되는 TCP 80/443(HTTP/3을 쓸 경우 UDP 443도 권장)
- Node.js 22 이상(로컬 테스트와 관리자 해시 생성용)
- 기존 [`Crasnec/dev-containers`](https://github.com/Crasnec/dev-containers)에서 빌드한 `local/dev-fedora:44`

## 실행

1. 기존 dev-containers 저장소에서 이미지를 빌드합니다. 그 저장소는 수정할 필요가 없습니다.

   ```bash
   git clone https://github.com/Crasnec/dev-containers.git
   cd dev-containers
   cp .env.example .env
   # 해당 저장소 문서에 따라 절대 경로와 UID/GID를 설정
   docker compose build dev-fedora
   docker image inspect local/dev-fedora:44 >/dev/null
   ```

2. 이 저장소를 설정합니다.

   ```bash
   npm ci
   npm run password-hash
   cp .env.example .env
   chmod 600 .env
   ```

   출력된 `scrypt:...` 해시를 `.env`의 `ADMIN_PASSWORD_HASH`에 넣습니다. `WORKSPACE_DIR`, `DEV_UID`, `DEV_GID`, `MCP_DOMAIN`, `ACME_EMAIL`도 설정합니다. Docker daemon이 현재 셸과 다른 host namespace에서 실행된다면 `CADDYFILE_PATH`도 daemon 기준 절대 경로로 설정합니다. 원문 비밀번호는 파일이나 명령 인자에 기록되지 않습니다.

3. 먼저 Let's Encrypt staging으로 기동합니다. `.env.example`의 staging `ACME_CA`가 기본값입니다.

   ```bash
   docker compose up -d --build
   docker compose ps
   docker compose logs caddy gateway runner
   ./scripts/verify-deployment.sh
   ```

4. OAuth 로그인, MCP 도구 검색, 읽기/쓰기 확인 흐름까지 성공하면 `.env`의 `ACME_CA`를 production URL로 바꾸고 Caddy를 재생성합니다.

   ```bash
   docker compose up -d --force-recreate caddy
   ```

   인증서 자동 발급에는 올바른 DNS와 외부 80/443 연결이 필요합니다. 자세한 조건은 [Caddy HTTPS quick-start](https://caddyserver.com/docs/quick-starts/https)를 참고하십시오.

5. ChatGPT의 개발자 모드에서 connector/app을 만들고 MCP URL로 `https://<MCP_DOMAIN>/mcp`를 등록합니다. DCR 후 Authorization Code + PKCE 로그인 화면이 열립니다. 연결 절차는 [OpenAI의 ChatGPT 연결 문서](https://developers.openai.com/apps-sdk/deploy/connect-chatgpt)를 따릅니다.

리소스 제한을 원하는 배포에서는 예시 override를 명시적으로 추가합니다.

```bash
docker compose -f compose.yaml -f compose.limits.yaml.example up -d --build
```

## MCP 도구

모든 도구는 짧은 텍스트 요약과 함께 다음 형태의 `structuredContent`를 반환합니다.

```json
{
  "ok": true,
  "data": {},
  "truncated": false,
  "continuation": "optional opaque cursor"
}
```

오류에는 `error.code`, `error.message`, 선택적 `error.details`가 포함됩니다.

| 영역 | 도구 |
|---|---|
| 프로젝트 | `project_list`, `project_register`, `project_clone`, `project_unregister`, `project_delete` |
| 파일 | `file_list`, `file_read`, `file_search`, `file_apply_patch` |
| 명령 | `command_run`, `command_output` |
| 프로세스 | `process_start`, `process_list`, `process_status`, `process_logs`, `process_stop` |
| Git | `git_status`, `git_diff`, `git_log`, `git_commit` |

`command_run`과 `process_start`는 `network_intent`를 `none`, `read`, `write` 중 하나로 반드시 선언합니다. 실제 runner 네트워크를 기술적으로 차단하는 값은 아니며 OAuth 승인, ChatGPT 확인 정책과 감사 기록에 사용됩니다. 64 KiB를 넘는 명령/Git 출력은 runner-data에 저장되고 `command_output`으로 이어 읽습니다. 프로세스 로그는 `process_logs` cursor를 사용합니다.

도구 annotation은 읽기, 쓰기, 파괴적 작업, 외부 통신을 구분합니다. 셸 호출은 항상 `destructiveHint: true`, `openWorldHint: true`입니다. 도구 설계 기준은 [OpenAI 도구 지침](https://developers.openai.com/apps-sdk/plan/tools)을 따릅니다.

## OAuth와 scope

gateway는 다음 endpoint를 제공합니다.

- `/.well-known/oauth-protected-resource`와 `/mcp` 경로형 metadata
- `/.well-known/oauth-authorization-server`
- `/oauth/register`, `/oauth/authorize`, `/oauth/token`, `/oauth/revoke`

단일 관리자 Authorization Code + PKCE(S256), 공개 클라이언트 DCR만 지원합니다. authorization code는 5분/일회용, access token은 15분, refresh token은 30일이며 토큰과 code는 SHA-256 해시로만 `gateway-data`에 저장됩니다. refresh token은 사용할 때마다 회전합니다.

| scope | 허용 작업 |
|---|---|
| `workspace:read` | 프로젝트/파일/Git 읽기 |
| `workspace:write` | 등록, patch, 삭제, commit |
| `command:run` | 동기 명령, 프로세스와 로그 |
| `command:network` | clone 또는 `network_intent != none`인 명령/프로세스 |

인증 구현은 [OpenAI Apps SDK 인증 요구사항](https://developers.openai.com/apps-sdk/build/auth)과 MCP OAuth 2.1 protected-resource 규약을 전제로 합니다.

## 보안 경계

- runner만 `${WORKSPACE_DIR}`를 `/workspace:rw`로 받습니다. 프로젝트 등록 경로는 workspace 자체가 될 수 없습니다.
- 모든 파일 경로는 lexical 검사 후 `realpath`로 다시 확인합니다. 절대 경로, `..`, symlink 탈출과 patch 경로 탈출을 거부합니다.
- public clone은 자격 증명이 없는 `https://github.com`, `https://gitlab.com`, `https://bitbucket.org` URL만 허용합니다. SSH, loopback/private 호스트와 URL credential은 거부됩니다.
- runner에는 Docker socket, SSH 키, 호스트 홈, `~/.codex`, `gateway-data`가 마운트되지 않습니다.
- 자식 프로세스 환경은 고정된 `PATH`, runner 전용 `HOME`, locale과 선택적 Git 작성자 값으로 새로 만듭니다. gateway 환경과 OAuth token은 전달되지 않습니다.
- gateway와 runner는 read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`로 실행합니다. runner 기반 이미지의 passwordless sudo도 이 설정 아래에서는 권한 상승에 사용할 수 없습니다.
- Compose는 기본 CPU/메모리/명령 timeout을 강제하지 않습니다. 동기 명령 4개와 백그라운드 프로세스 8개의 기본 동시성 한도만 있으며 `.env`에서 바꿀 수 있습니다.
- 감사 로그는 `gateway-data/audit.jsonl`에 저장됩니다. patch 본문과 continuation/token은 기록하지 않으며 명령 문자열은 2,000자로 제한합니다.

임의 셸과 파일 삭제를 공개 인터넷에 노출하는 서비스이므로 관리자 비밀번호 재사용을 피하고, firewall/rate limiting 또는 별도 접근 제어 계층을 추가하는 것을 권장합니다. push, PR 생성, 비공개 저장소 credential은 v1 범위가 아닙니다.

## 개발과 검증

```bash
npm ci
npm run style
npm run typecheck
npm test
npm run build
docker compose config --quiet
```

테스트는 PKCE·code 재사용·refresh 회전·revoke, 경로와 symlink 탈출, 등록→검색→patch→명령→diff→commit, 긴 출력 continuation, 백그라운드 로그와 종료를 검증합니다. 실제 배포 뒤 `scripts/verify-deployment.sh`는 HTTPS metadata, 인증 challenge, mount 격리, read-only root를 추가로 확인합니다. 최종 수동 확인은 staging 인증서 → production 인증서 → ChatGPT 도구 검색 → 읽기/쓰기 승인 흐름 순서로 수행합니다.
