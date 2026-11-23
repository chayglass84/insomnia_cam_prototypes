// Task 4348 S5d: editing an OAuth call (plain HTTP, not JSON-RPC) before sending it again. Form-encoded bodies are shown as
// an object (one key per parameter) so a parameter can be dropped or changed without hand-editing `a=b&c=d`, then
// re-encoded on send. Pure functions so they can be unit tested.

export interface OAuthWireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | Record<string, unknown>;
}

type FormValue = string | string[];

const contentTypeOf = (headers: Record<string, string>) =>
  Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? '';

const isForm = (headers: Record<string, string>) => contentTypeOf(headers).toLowerCase().includes('application/x-www-form-urlencoded');

/** The shape the editor shows: the request event's payload (method, url, body) plus its headers. */
export const toEditable = (payload: unknown, headers: Record<string, string> = {}): OAuthWireRequest => {
  const { method, url, body } = (payload ?? {}) as { method?: string; url?: string; body?: unknown };
  const out: OAuthWireRequest = { method: method ?? 'GET', url: url ?? '', headers };
  if (body === undefined) {
    return out;
  }
  if (typeof body === 'string' && isForm(headers)) {
    const form: Record<string, FormValue> = {};
    for (const [key, value] of new URLSearchParams(body)) {
      const existing = form[key];
      form[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
    }
    out.body = form;
  } else {
    out.body = body as OAuthWireRequest['body'];
  }
  return out;
};

/** Parse what the user edited. Returns an error string for anything that cannot be sent. */
export const fromEditable = (text: string): { request: OAuthWireRequest & { body?: string | Record<string, unknown> } } | { error: string } => {
  let parsed: Partial<OAuthWireRequest>;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
  if (typeof parsed.method !== 'string' || !parsed.method) {
    return { error: '"method" must be a non-empty string' };
  }
  if (typeof parsed.url !== 'string' || !/^https?:\/\//i.test(parsed.url)) {
    return { error: '"url" must start with http:// or https://' };
  }
  const headers = parsed.headers ?? {};
  if (typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(v => typeof v !== 'string')) {
    return { error: '"headers" must be an object of string values' };
  }
  let body = parsed.body;
  if (body !== undefined && typeof body === 'object' && body !== null && isForm(headers)) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        search.append(key, typeof item === 'string' ? item : JSON.stringify(item));
      }
    }
    body = search.toString();
  }
  return { request: { method: parsed.method.toUpperCase(), url: parsed.url, headers, ...(body === undefined ? {} : { body }) } };
};

/** True for a form-encoded token request whose credential is single-use (an authorization code) or rotated (refresh token). */
export const singleUseNote = (payload: unknown): string | undefined => {
  const body = (payload as { body?: unknown } | undefined)?.body;
  if (typeof body !== 'string') {
    return undefined;
  }
  const grant = new URLSearchParams(body).get('grant_type');
  if (grant === 'authorization_code') {
    return 'This request carries an authorization code, which works once. The server already accepted or rejected it, so a correct server rejects it now with invalid_grant. That rejection is the thing to check.';
  }
  if (grant === 'refresh_token') {
    return 'This request carries a refresh token. Servers that rotate refresh tokens reject one that was already used, and some then revoke the whole family.';
  }
  return undefined;
};
