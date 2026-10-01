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
    promoteFirstAdmin(id: string): Promise<BootstrapAccount>;
  };
  audit: { write(event: Record<string, unknown>): Promise<void> };
  userId: string;
  email: string;
  actor?: string;
}): Promise<BootstrapAccount>;
