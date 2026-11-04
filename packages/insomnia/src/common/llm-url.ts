import type { RequestHeader } from 'insomnia-data';

import type { ParsedChatRequest } from './chat-request';
import { ensureEventStreamAcceptHeader, ensureIncludeUsageFlag } from './chat-streaming';

// Prototype (3593AI): "Auto-convert LLM URLs to SSE Requests". Isomorphic (no window), unit-tested.
//
// Matching is deliberately tight: the URL's *path* must END with one of these suffixes (query string,
// fragment and a trailing slash are ignored). Plain string handling rather than `new URL()` so templated
// URLs like `{{ _.base_url }}/chat/completions` still match. Not covered yet: OpenAI `/v1/responses` (body
// uses `input`, not `messages`, which the chat UI can't parse) and Gemini (streams via a different URL suffix).
const LLM_URL_SUFFIXES: { suffix: string; format: Extract<ParsedChatRequest['format'], 'openai' | 'anthropic'> }[] = [
  { suffix: '/chat/completions', format: 'openai' },
  { suffix: '/v1/messages', format: 'anthropic' },
];

export type LlmUrlFormat = (typeof LLM_URL_SUFFIXES)[number]['format'];

export const detectLlmUrl = (url: string | undefined | null): LlmUrlFormat | null => {
  if (!url) {
    return null;
  }
  const path = url
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
  return LLM_URL_SUFFIXES.find(({ suffix }) => path.endsWith(suffix))?.format ?? null;
};

// The one trigger: the URL goes from blank to an LLM URL. Editing an already-filled URL never re-triggers,
// so the user can undo once and carry on without fighting us.
export const shouldAutoConvertLlmUrl = (previousUrl: string | undefined | null, nextUrl: string): LlmUrlFormat | null => {
  if (previousUrl?.trim()) {
    return null;
  }
  return detectLlmUrl(nextUrl);
};

export interface LlmUrlConversionInput {
  method: string;
  headers: RequestHeader[];
  body: { mimeType?: string | null; text?: string };
}

export interface LlmUrlConversionPatch {
  method: string;
  headers: RequestHeader[];
  body: LlmUrlConversionInput['body'];
}

// Builds the patch that turns a request into a streaming chat request for `format`. Existing body JSON is
// merged into (never replaced) so a user's own fields survive; a blank body gets an empty-model starter.
// The model is left empty on purpose: we can't know it from a URL, and a wrong default (e.g. `gpt-4`) on a
// gateway gives a confusing 400. The chat settings bar prompts for it.
export const buildLlmUrlConversion = (format: LlmUrlFormat, request: LlmUrlConversionInput): LlmUrlConversionPatch => {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = request.body.text ? JSON.parse(request.body.text) : {};
    existing = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    existing = {};
  }

  const next: Record<string, unknown> = { model: '', ...existing, stream: true };
  if (format === 'anthropic') {
    next.max_tokens = existing.max_tokens ?? 1024;
  }
  if (!Array.isArray(next.messages) || next.messages.length === 0) {
    next.messages = [{ role: 'user', content: 'Hello!' }];
  }

  let text = JSON.stringify(next, null, 2);
  if (format === 'openai') {
    // OpenAI-format streams only report token usage (so cost) with stream_options.include_usage.
    text = ensureIncludeUsageFlag(text) ?? text;
  }

  const withAccept = ensureEventStreamAcceptHeader(request.headers).headers;
  const hasContentType = withAccept.some(header => header.name.toLowerCase() === 'content-type');
  const headers = hasContentType ? withAccept : [...withAccept, { name: 'Content-Type', value: 'application/json' }];

  return {
    method: 'POST',
    headers,
    body: { ...request.body, mimeType: 'application/json', text },
  };
};

// True when the body is JSON but has no usable `model` (missing, empty or not a string). A body that isn't
// JSON returns false: we can't tell, so we don't block it.
export const isModelMissingInBody = (bodyText?: string): boolean => {
  if (!bodyText) {
    return false;
  }
  try {
    const parsed = JSON.parse(bodyText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return false;
    }
    return typeof parsed.model !== 'string' || parsed.model.trim() === '';
  } catch {
    return false;
  }
};
