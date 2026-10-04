export interface RuntimeOwner {
  id: string;
  email?: string;
}
export interface RuntimeInfo {
  Name?: string;
  Config?: { Labels?: Record<string, string> };
}
export function validRuntimeName(name: unknown): name is string;
export function runtimeName(user: RuntimeOwner): string;
export function runtimeContainer(user: RuntimeOwner): string;
export function developmentContainer(user: RuntimeOwner): string;
export function developmentHome(user: RuntimeOwner): string;
export function gitAuthVolume(user: RuntimeOwner): string;
export function ownsRuntime(user: RuntimeOwner, info?: RuntimeInfo): boolean;
export function ownsDevelopment(
  user: RuntimeOwner,
  info?: RuntimeInfo,
): boolean;
