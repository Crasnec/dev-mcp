export interface McpSessionSummary {
  id: string;
  clientId: string;
  createdAt: number;
  lastSeenAt: number;
}
export interface McpSessionManager {
  list(userId: string): McpSessionSummary[];
  close(
    userId: string,
    filter?: { id?: string; clientId?: string },
  ): Promise<void>;
}
