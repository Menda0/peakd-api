/** Handle validation and email-based generation (stored lowercase, no `@` prefix). */

export const HANDLE_PATTERN = /^[a-z0-9][a-z0-9_-]{2,29}$/;
export const HANDLE_MAX_LENGTH = 30;
export const HANDLE_MIN_LENGTH = 3;

export const RESERVED_HANDLES = new Set([
  'admin',
  'api',
  'auth',
  'share',
  'studio',
  'partner',
  'profile',
  'users',
  'user',
  'feed',
  'discover',
  'billing',
  'payouts',
  'public',
  'static',
  'login',
  'logout',
  'u',
  'www',
]);

export function normalizeHandleInput(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (s.startsWith('@')) {
    s = s.slice(1);
  }
  return s;
}

export function isReservedHandle(handle: string): boolean {
  return RESERVED_HANDLES.has(handle.toLowerCase());
}

export function validateHandleFormat(handle: string): void {
  if (!HANDLE_PATTERN.test(handle)) {
    throw new Error(
      'Handle must be 3–30 characters, start with a letter or number, and use only lowercase letters, numbers, underscores, or hyphens',
    );
  }
  if (isReservedHandle(handle)) {
    throw new Error('This handle is reserved');
  }
}

/** Extract and sanitize the email local part into a handle base candidate. */
export function sanitizeEmailLocalPartToHandleBase(email: string): string {
  const at = email.indexOf('@');
  const local = (at >= 0 ? email.slice(0, at) : email).trim().toLowerCase();
  let base = local
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!base) {
    base = 'user';
  }
  if (!/^[a-z0-9]/.test(base)) {
    base = `u_${base}`;
  }
  if (base.length > HANDLE_MAX_LENGTH) {
    base = base.slice(0, HANDLE_MAX_LENGTH);
    base = base.replace(/_+$/, '');
  }
  if (base.length < HANDLE_MIN_LENGTH) {
    base = `${base}${'_'.repeat(HANDLE_MIN_LENGTH - base.length)}`;
  }
  return base;
}

/** Build candidate handles: base, then 2base, 3base, … (numeric prefix on collision). */
export function handleCandidatesFromBase(base: string, max = 999): string[] {
  const candidates: string[] = [];
  const normalizedBase = sanitizeEmailLocalPartToHandleBase(base);
  if (
    normalizedBase.length >= HANDLE_MIN_LENGTH &&
    HANDLE_PATTERN.test(normalizedBase) &&
    !isReservedHandle(normalizedBase)
  ) {
    candidates.push(normalizedBase);
  }
  for (let n = 2; n <= max; n += 1) {
    const prefixed = `${n}${normalizedBase}`;
    if (prefixed.length > HANDLE_MAX_LENGTH) {
      const trimmed = prefixed.slice(0, HANDLE_MAX_LENGTH);
      if (trimmed.length >= HANDLE_MIN_LENGTH && HANDLE_PATTERN.test(trimmed)) {
        candidates.push(trimmed);
      }
      continue;
    }
    if (HANDLE_PATTERN.test(prefixed) && !isReservedHandle(prefixed)) {
      candidates.push(prefixed);
    }
  }
  if (candidates.length === 0) {
    candidates.push(`user_${Date.now().toString(36).slice(-6)}`);
  }
  return candidates;
}
