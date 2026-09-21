import path from "node:path";
import type { GatewayConfig } from "./config.ts";
import { IpcClient } from "./ipc-client.ts";
import type { User } from "./user-store.ts";

export class RunnerRouter {
  constructor(
    private readonly config: GatewayConfig,
    private readonly primary?: IpcClient,
  ) {}

  forUser(user: User): IpcClient {
    if (user.runner === "primary") {
      return this.primary ?? new IpcClient(this.config.runnerSocket);
    }
    if (
      user.runner !== user.id ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        user.id,
      )
    ) {
      throw new Error("Invalid user runner identity");
    }
    const directory = this.config.userRunnerSocketDir ?? "/user-ipc";
    return new IpcClient(
      path.join(directory, user.id, "runner.sock"),
      path.join(directory, user.id + ".key"),
    );
  }
}
