import type { Routing } from "../Protocol";

type ProxyMethod = "POST" | "GET" | "DELETE";

/**
 * Ardi's proxyFetch tunneled browser requests through a hosted proxy / local relay to dodge CORS. Insomnia's
 * main process has no CORS, so this is a thin direct fetch with the same signature (callers are unchanged).
 * PROTOTYPE-MOCK: no TLS options (sslValidation), cookies, proxy settings, user-agent toggle or client certs yet;
 * `routing` and `url` (proxy URL) are accepted and ignored.
 */
export async function proxyFetch(args: {
  target: string;
  method: ProxyMethod;
  headers: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  keepalive?: boolean;
  url?: string;
  routing?: Routing;
}): Promise<Response> {
  return fetch(args.target, {
    method: args.method,
    headers: args.headers,
    body: args.body === undefined ? undefined : JSON.stringify(args.body),
    signal: args.signal,
  });
}
