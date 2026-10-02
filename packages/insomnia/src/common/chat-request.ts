import type { ChatMessage } from './chat-completion';

export interface ParsedChatRequest {
  format: 'openai' | 'anthropic' | 'gemini';
  model?: string;
  messages: ChatMessage[];
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

const isValidRole = (role: unknown): role is ChatMessage['role'] =>
  role === 'user' || role === 'assistant' || role === 'system';

const parseOpenAiLike = (parsed: any): { messages: ChatMessage[] } | null => {
  if (!Array.isArray(parsed?.messages) || parsed.messages.length === 0) {
    return null;
  }
  const messages: ChatMessage[] = [];
  for (const message of parsed.messages) {
    const content = asString(message?.content);
    if (!isValidRole(message?.role) || content === null) {
      return null;
    }
    messages.push({ role: message.role, content });
  }
  return { messages };
};

const parseAnthropic = (parsed: any): { messages: ChatMessage[] } | null => {
  if (!Array.isArray(parsed?.messages) || parsed.messages.length === 0) {
    return null;
  }
  const messages: ChatMessage[] = [];
  for (const message of parsed.messages) {
    const content = asString(message?.content);
    if ((message?.role !== 'user' && message?.role !== 'assistant') || content === null) {
      return null;
    }
    messages.push({ role: message.role, content });
  }
  const system = asString(parsed?.system);
  if (system) {
    messages.unshift({ role: 'system', content: system });
  }
  return { messages };
};

const parseGemini = (parsed: any): { messages: ChatMessage[] } | null => {
  if (!Array.isArray(parsed?.contents) || parsed.contents.length === 0) {
    return null;
  }
  const messages: ChatMessage[] = [];
  for (const entry of parsed.contents) {
    const part = entry?.parts?.[0];
    const content = asString(part?.text);
    if ((entry?.role !== 'user' && entry?.role !== 'model') || content === null) {
      return null;
    }
    messages.push({ role: entry.role === 'model' ? 'assistant' : 'user', content });
  }
  return { messages };
};

export const parseChatRequestBody = (bodyText: string): ParsedChatRequest | null => {
  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return null;
  }

  const model = asString(parsed?.model) ?? undefined;

  if (typeof parsed.system === 'string' || Array.isArray(parsed.messages)) {
    const anthropic = parseAnthropic(parsed);
    if (anthropic) {
      return { format: 'anthropic', model, messages: anthropic.messages };
    }
  }

  const openai = parseOpenAiLike(parsed);
  if (openai) {
    return { format: 'openai', model, messages: openai.messages };
  }

  const gemini = parseGemini(parsed);
  if (gemini) {
    return { format: 'gemini', model, messages: gemini.messages };
  }

  return null;
};

export const serializeChatRequestBody = (
  originalBodyText: string,
  format: ParsedChatRequest['format'],
  edited: { model?: string; messages: ChatMessage[] },
): string => {
  let original: Record<string, unknown>;
  try {
    const parsed = JSON.parse(originalBodyText);
    original = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    original = {};
  }

  const next: Record<string, unknown> = { ...original };
  if (edited.model) {
    next.model = edited.model;
  }

  if (format === 'anthropic') {
    const system = edited.messages.find(message => message.role === 'system');
    if (system) {
      next.system = system.content;
    } else {
      delete next.system;
    }
    next.messages = edited.messages
      .filter(message => message.role !== 'system')
      .map(({ role, content }) => ({ role, content }));
  } else if (format === 'gemini') {
    next.contents = edited.messages.map(({ role, content }) => ({
      role: role === 'assistant' ? 'model' : 'user',
      parts: [{ text: content }],
    }));
  } else {
    next.messages = edited.messages.map(({ role, content }) => ({ role, content }));
  }

  return JSON.stringify(next, null, 2);
};

export interface ChatSamplingParams {
  temperature?: number;
  maxTokens?: number;
}

// `temperature`/`max_tokens` are literal top-level JSON keys shared by both the OpenAI and
// Anthropic request shapes, so these work unmodified for either `format`. Gemini nests the
// equivalent fields under `generationConfig` with different names (`maxOutputTokens`) — callers
// should not use these for a Gemini-format request.
export const parseChatSamplingParams = (bodyText: string): ChatSamplingParams => {
  try {
    const parsed = JSON.parse(bodyText);
    return {
      temperature: typeof parsed?.temperature === 'number' ? parsed.temperature : undefined,
      maxTokens: typeof parsed?.max_tokens === 'number' ? parsed.max_tokens : undefined,
    };
  } catch {
    return {};
  }
};

export const applyChatSamplingParams = (bodyText: string, params: ChatSamplingParams): string => {
  let original: Record<string, unknown>;
  try {
    const parsed = JSON.parse(bodyText);
    original = parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    original = {};
  }

  const next = { ...original };
  if (params.temperature === undefined) {
    delete next.temperature;
  } else {
    next.temperature = params.temperature;
  }
  if (params.maxTokens === undefined) {
    delete next.max_tokens;
  } else {
    next.max_tokens = params.maxTokens;
  }
  return JSON.stringify(next, null, 2);
};
