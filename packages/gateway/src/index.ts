import { mkdir } from "node:fs/promises";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { AuditLogger } from "./audit.ts";
import { InstallationStore } from "./installation-store.ts";
import { createOnboardingApp, onboardingCode } from "./onboarding.ts";
import { SettingsStore } from "./settings-store.ts";
import { UserStore } from "./user-store.ts";
import { AppStore } from "./app-store.ts";
import { RunnerRouter } from "./runner-router.ts";
import { createPreviewServer, PreviewAuth } from "./preview-proxy.ts";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
const users = new UserStore(config.dataDir);
const settings = new SettingsStore(config.dataDir);
const audit = new AuditLogger(config.dataDir);
const installation = new InstallationStore(
  config.dataDir,
  config.runnerStatusDir ?? "/runner-status",
);
const apps = new AppStore(config.dataDir);
const previewAuth = new PreviewAuth(config.dataDir);
const app = createApp(config, {
  users,
  settings,
  audit,
  installation,
  apps,
  previewAuth,
});
const servers = [
  app.listen(config.port, "0.0.0.0", () => {
    console.log(
      JSON.stringify({
        event: "gateway_ready",
        port: config.port,
        publicBaseUrl: config.publicBaseUrl,
      }),
    );
  }),
];

// Compose publishes this port on the host's loopback interface only; Caddy
// never proxies it. Completed installations do not open it again.
if (
  config.onboardingPort &&
  !(await installation.read()).onboardingCompletedAt
) {
  const code = onboardingCode();
  const onboarding = createOnboardingApp({
    users,
    installation,
    audit,
    code,
    googleEnabled: !!config.google,
    publicBaseUrl: config.publicBaseUrl,
  });
  servers.push(
    onboarding.listen(config.onboardingPort, "0.0.0.0", () => {
      console.log(
        JSON.stringify({
          event: "onboarding_available",
          port: config.onboardingPort,
          code,
          hint: "Open http://127.0.0.1:<ONBOARDING_HOST_PORT>/ on the Docker host or through an SSH tunnel.",
        }),
      );
    }),
  );
}

// Published apps are served on their own listener, reached by the reverse
// proxy for *.<PREVIEW_DOMAIN> only; it has no console routes.
if (config.previewDomain && config.previewPort) {
  const preview = createPreviewServer({
    config,
    apps,
    users,
    runners: new RunnerRouter(config),
    settings,
    auth: previewAuth,
    audit,
  });
  servers.push(
    preview.listen(config.previewPort, "0.0.0.0", () => {
      console.log(
        JSON.stringify({
          event: "preview_ready",
          port: config.previewPort,
          previewDomain: config.previewDomain,
        }),
      );
    }),
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    let open = servers.length;
    for (const server of servers) {
      server.close(() => {
        if (--open === 0) {
          void audit.flush().finally(() => process.exit(0));
        }
      });
    }
  });
}
