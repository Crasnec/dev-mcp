export interface BootstrapAccount {
  id: string;
  role: string;
  status: string;
  runner: string;
  googleLinked?: boolean;
  email?: string;
}
export function bootstrapGoogleAdmin(options: {
  users: {
    list(): Promise<BootstrapAccount[]>;
    update(
      actorId: string,
      id: string,
      changes: { role: "admin"; status: "active" },
    ): Promise<BootstrapAccount>;
  };
  audit: { write(event: Record<string, unknown>): Promise<void> };
  userId: string;
  email: string;
}): Promise<BootstrapAccount>;
