import { rm } from "node:fs/promises";
import { loadConfig } from "./config.ts";
import { startIpcServer } from "./ipc-server.ts";
import { RunnerRuntime } from "./runtime.ts";

const config = loadConfig();
const runtime = new RunnerRuntime(config);
await runtime.initialize();
const server = await startIpcServer(config.socketPath, runtime);
console.log(
  JSON.stringify({ event: "runner_ready", socket: config.socketPath }),
);

async function shutdown(signal: string): Promise<void> {
  console.log(JSON.stringify({ event: "runner_shutdown", signal }));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(config.socketPath, { force: true });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}
