/** Normalize a role name for case-insensitive comparison. */
export function normalizeRoleName(name: string): string {
  return name.trim().toLowerCase();
}

/** Extract role name strings from Auth0 JWT claim values (arrays, strings, or role objects). */
export function extractRoleNames(value: unknown): string[] {
  if (value == null) return [];

  if (typeof value === 'string') {
    const t = value.trim();
    if (!t) return [];
    if (t.includes(',')) {
      return t
        .split(',')
        .map((s) => normalizeRoleName(s))
        .filter(Boolean);
    }
    return [normalizeRoleName(t)];
  }

  if (Array.isArray(value)) {
    const out: string[] = [];
    for (const item of value) {
      out.push(...extractRoleNames(item));
    }
    return out;
  }

  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if (typeof o.name === 'string' && o.name.trim()) {
      return [normalizeRoleName(o.name)];
    }
    if (typeof o.role === 'string' && o.role.trim()) {
      return [normalizeRoleName(o.role)];
    }
    if (typeof o.id === 'string' && o.id.trim() && !o.id.startsWith('rol_')) {
      return [normalizeRoleName(o.id)];
    }
  }

  return [];
}

function addRolesFromValue(seen: Set<string>, value: unknown) {
  for (const name of extractRoleNames(value)) {
    if (name) seen.add(name);
  }
}

/** Collect role names from Auth0 JWT payload (RBAC / Actions / custom claims). */
export function collectRolesFromPayload(
  payload: Record<string, unknown>,
  audience?: string,
): Set<string> {
  const seen = new Set<string>();
  addRolesFromValue(seen, payload.roles);

  const aud = audience?.trim();
  if (aud) {
    addRolesFromValue(seen, payload[`${aud}/roles`]);
    const audLower = aud.toLowerCase();
    for (const [key, value] of Object.entries(payload)) {
      if (key.toLowerCase() === `${audLower}/roles`) {
        addRolesFromValue(seen, value);
      }
    }
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key.toLowerCase().endsWith('/roles')) {
      addRolesFromValue(seen, value);
    }
  }

  return seen;
}

export function hasRoleInPayload(
  payload: Record<string, unknown>,
  role: string,
  audience?: string,
): boolean {
  const want = normalizeRoleName(role);
  return collectRolesFromPayload(payload, audience).has(want);
}
