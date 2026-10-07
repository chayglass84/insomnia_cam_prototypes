// Prototype (3593AI): turns the collection's Judge settings (a request + extra instructions) into the plain config that
// `insomnia.judge()` reads inside the script sandbox. Rendered here, in the host, so `{{ _.proxy_host }}` etc. resolve.
import type { RequestContext } from '../../../insomnia-scripting-environment/src/objects';

type JudgeConfig = NonNullable<RequestContext['judge']>;

interface RenderedJudgeRequest {
  url: string;
  headers: { name: string; value: string; disabled?: boolean }[];
  body: { text?: string };
}

/**
 * The judge request becomes a template: URL, headers and parsed JSON body. The response is read as JSON, so an
 * `Accept: text/event-stream` header (set on generated streaming requests) is replaced. Authentication configured on the
 * request (as opposed to a header) is not applied yet.
 */
export const toJudgeConfig = (rendered: RenderedJudgeRequest, system?: string, runs?: number): JudgeConfig => {
  const headers: Record<string, string> = {};
  for (const header of rendered.headers) {
    if (!header.disabled && header.name && header.name.toLowerCase() !== 'accept') {
      headers[header.name] = header.value;
    }
  }
  headers.Accept = 'application/json';

  let body: Record<string, any> | undefined;
  try {
    const parsed = JSON.parse(rendered.body.text || '');
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    body = undefined;
  }

  return { url: rendered.url, headers, body, ...(system ? { system } : {}), ...(runs && runs > 1 ? { runs } : {}) };
};
