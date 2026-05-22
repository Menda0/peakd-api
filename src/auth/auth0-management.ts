import { normalizeRoleName } from './auth-roles';

function normalizeAuth0Domain(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  return t || undefined;
}

let mgmtTokenCache: { token: string; expiresAtMs: number } | null = null;
const rolesCache = new Map<string, { names: string[]; expiresAtMs: number }>();
const ROLES_TTL_MS = 5 * 60 * 1000;

function managementAudience(domain: string): string {
  return `https://${domain}/api/v2/`;
}

async function getManagementAccessToken(): Promise<string | null> {
  const clientId = process.env.AUTH0_MANAGEMENT_CLIENT_ID?.trim();
  const clientSecret = process.env.AUTH0_MANAGEMENT_CLIENT_SECRET?.trim();
  const domain = normalizeAuth0Domain(
    process.env.AUTH0_MANAGEMENT_DOMAIN ?? process.env.AUTH0_DOMAIN,
  );
  if (!clientId || !clientSecret || !domain) return null;

  const now = Date.now();
  if (mgmtTokenCache && mgmtTokenCache.expiresAtMs > now + 30_000) {
    return mgmtTokenCache.token;
  }

  const res = await fetch(`https://${domain}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      audience: managementAudience(domain),
      grant_type: 'client_credentials',
    }),
  });
  if (!res.ok) {
    mgmtTokenCache = null;
    return null;
  }
  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!body.access_token) return null;
  const ttlSec = typeof body.expires_in === 'number' ? body.expires_in : 86_400;
  mgmtTokenCache = {
    token: body.access_token,
    expiresAtMs: now + ttlSec * 1000 - 60_000,
  };
  return body.access_token;
}

/** Role `name` values from Auth0 Dashboard → User Management → Roles. */
export async function fetchAuth0UserRoleNames(
  userSub: string,
): Promise<string[]> {
  const domain = normalizeAuth0Domain(
    process.env.AUTH0_MANAGEMENT_DOMAIN ?? process.env.AUTH0_DOMAIN,
  );
  if (!domain) return [];

  const now = Date.now();
  const hit = rolesCache.get(userSub);
  if (hit && hit.expiresAtMs > now) return hit.names;

  const token = await getManagementAccessToken();
  if (!token) return [];

  const res = await fetch(
    `https://${domain}/api/v2/users/${encodeURIComponent(userSub)}/roles`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!res.ok) {
    if (res.status === 401) mgmtTokenCache = null;
    return [];
  }
  const rows = (await res.json()) as { name?: string }[];
  const names = rows
    .map((r) => normalizeRoleName(String(r.name ?? '')))
    .filter(Boolean);
  rolesCache.set(userSub, { names, expiresAtMs: now + ROLES_TTL_MS });
  return names;
}

export async function userHasAuth0Role(
  userSub: string,
  role: string,
): Promise<boolean> {
  const want = normalizeRoleName(role);
  const names = await fetchAuth0UserRoleNames(userSub);
  return names.some((n) => n === want);
}
