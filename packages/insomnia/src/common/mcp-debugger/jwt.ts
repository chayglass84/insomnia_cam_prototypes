// Task 4348 S5c: decode (never verify) a JWT so a developer debugging their own authorization server can read the
// claims. Isomorphic: uses atob/TextDecoder only.

const decodePart = (part: string): unknown => {
  const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
  const bytes = Uint8Array.from(atob(padded), c => c.codePointAt(0) ?? 0);
  return JSON.parse(new TextDecoder().decode(bytes));
};

export interface DecodedJwt {
  header: unknown;
  payload: Record<string, unknown>;
}

/** Returns null when the value is not a three-part JWT with JSON header and payload. */
export const decodeJwt = (token: string): DecodedJwt | null => {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  try {
    const header = decodePart(parts[0]);
    const payload = decodePart(parts[1]);
    if (typeof header !== 'object' || header === null || typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
      return null;
    }
    return { header, payload: payload as Record<string, unknown> };
  } catch {
    return null;
  }
};

/** Claims that hold a Unix time, for display as a readable date next to the raw number. */
export const JWT_TIME_CLAIMS = ['exp', 'iat', 'nbf', 'auth_time'];
