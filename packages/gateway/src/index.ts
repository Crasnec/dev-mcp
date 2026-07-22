import { mkdir } from "node:fs/promises";
import { createApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
const app = createApp(config);
const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(
    JSON.stringify({
      event: "gateway_ready",
      port: config.port,
      publicBaseUrl: config.publicBaseUrl,
    }),
  );
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
