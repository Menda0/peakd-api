function addRolesFromArray(seen: Set<string>, value: unknown) {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    seen.add(String(item).toLowerCase());
  }
}

/** Collect role names from Auth0 JWT payload (RBAC / Actions). */
export function collectRolesFromPayload(
  payload: Record<string, unknown>,
  audience?: string,
): Set<string> {
  const seen = new Set<string>();
  addRolesFromArray(seen, payload.roles);
  if (audience) {
    addRolesFromArray(seen, payload[`${audience}/roles`]);
  }
  for (const [key, value] of Object.entries(payload)) {
    if (key.endsWith('/roles')) {
      addRolesFromArray(seen, value);
    }
  }
  return seen;
}

export function hasRoleInPayload(
  payload: Record<string, unknown>,
  role: string,
  audience?: string,
): boolean {
  return collectRolesFromPayload(payload, audience).has(role.toLowerCase());
}
