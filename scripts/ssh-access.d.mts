export interface SshKey {
  id: string;
  name: string;
  publicKey: string;
  fingerprint: string;
  createdAt: number;
}
export interface SshAccess {
  revision: string;
  authVersion: number;
  keys: SshKey[];
}
export const MAX_SSH_KEYS: number;
export const WORKSPACE_SSH_PORT: number;
export function sshLogin(id: string): string;
export function workspaceContainer(id: string): string;
export function parseSshPublicKey(value: unknown): {
  publicKey: string;
  fingerprint: string;
};
export function validSshAccess(value: unknown): value is SshAccess;
export function sshKeysForUser(
  user: { id: string; runner: string; status: string; authVersion: number },
  entry: unknown,
): string[];
export function sshAccessRevision(
  user: { id: string; runner: string; status: string; authVersion: number },
  entry: unknown,
): string;
