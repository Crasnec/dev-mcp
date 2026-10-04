const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const validRuntimeName = (name) =>
  typeof name === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);

// UUIDs remain authorization identities; only Docker resource names change.
export function runtimeName(user) {
  if (!uuid.test(user?.id)) {
    throw new Error("Invalid runtime owner");
  }
  const local = String(user.email ?? "")
    .split("@")[0]
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 64)
    .replace(/[-._]+$/, "");
  return local || user.id;
}

export const runtimeContainer = (user) => "dev-mcp-user-" + runtimeName(user);

export function ownsRuntime(user, info) {
  if (!uuid.test(user?.id)) {
    return false;
  }
  const labels = info?.Config?.Labels ?? {};
  if (labels["dev-mcp.user"] !== user.id) {
    return false;
  }
  const name = info?.Name?.replace(/^\//, "");
  const assigned = labels["dev-mcp.name"];
  return (
    name === "dev-mcp-user-" + user.id ||
    (validRuntimeName(assigned) && name === "dev-mcp-user-" + assigned)
  );
}
