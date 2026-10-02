import { inferStreamSummaryPath } from './stream-summary';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatCompletionSummary {
  messages: ChatMessage[];
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null);

export const extractRequestMessages = (requestBodyText?: string): ChatMessage[] => {
  if (!requestBodyText) {
    return [];
  }
  try {
    const parsed = JSON.parse(requestBodyText);
    const messages: ChatMessage[] = [];
    const system = asString(parsed?.system);
    if (system) {
      messages.push({ role: 'system', content: system });
    }
    if (Array.isArray(parsed?.messages)) {
      for (const message of parsed.messages) {
        const role = message?.role;
        if (role !== 'user' && role !== 'assistant' && role !== 'system') {
          continue;
        }
        const content = typeof message?.content === 'string'
          ? message.content
          : Array.isArray(message?.content)
            ? message.content.map((block: unknown) => asString((block as { text?: unknown })?.text)).filter(Boolean).join('')
            : null;
        if (content) {
          messages.push({ role, content });
        }
      }
    }
    return messages;
  } catch {
    return [];
  }
};

const extractOpenAi = (parsed: any): ChatCompletionSummary | null => {
  const choice = parsed?.choices?.[0];
  const content = asString(choice?.message?.content);
  if (!choice || content === null) {
    return null;
  }
  return {
    messages: [{ role: 'assistant', content }],
    model: asString(parsed?.model) ?? undefined,
    usage: parsed?.usage
      ? { inputTokens: parsed.usage.prompt_tokens, outputTokens: parsed.usage.completion_tokens }
      : undefined,
    stopReason: asString(choice?.finish_reason) ?? undefined,
  };
};

const extractAnthropic = (parsed: any): ChatCompletionSummary | null => {
  if (parsed?.role !== 'assistant' || !Array.isArray(parsed?.content)) {
    return null;
  }
  const content = parsed.content
    .filter((block: unknown) => (block as { type?: unknown })?.type === 'text')
    .map((block: unknown) => asString((block as { text?: unknown }).text))
    .filter((value: unknown): value is string => value !== null)
    .join('');
  if (!content) {
    return null;
  }
  return {
    messages: [{ role: 'assistant', content }],
    model: asString(parsed?.model) ?? undefined,
    usage: parsed?.usage
      ? { inputTokens: parsed.usage.input_tokens, outputTokens: parsed.usage.output_tokens }
      : undefined,
    stopReason: asString(parsed?.stop_reason) ?? undefined,
  };
};

const extractGemini = (parsed: any): ChatCompletionSummary | null => {
  const candidate = parsed?.candidates?.[0];
  const parts = candidate?.content?.parts;
  if (!candidate || !Array.isArray(parts)) {
    return null;
  }
  const content = parts
    .map((part: unknown) => asString((part as { text?: unknown })?.text))
    .filter((value: unknown): value is string => value !== null)
    .join('');
  if (!content) {
    return null;
  }
  return {
    messages: [{ role: 'assistant', content }],
    usage: parsed?.usageMetadata
      ? { inputTokens: parsed.usageMetadata.promptTokenCount, outputTokens: parsed.usageMetadata.candidatesTokenCount }
      : undefined,
    stopReason: asString(candidate?.finishReason) ?? undefined,
  };
};

export const extractChatCompletion = (
  responseBodyText: string,
  requestBodyText?: string,
): ChatCompletionSummary | null => {
  let parsed: any;
  try {
    parsed = JSON.parse(responseBodyText);
  } catch {
    return null;
  }

  const assistant = extractOpenAi(parsed) ?? extractAnthropic(parsed) ?? extractGemini(parsed);
  if (!assistant) {
    return null;
  }

  return { ...assistant, messages: [...extractRequestMessages(requestBodyText), ...assistant.messages] };
};

export const supportsStreaming = (url: string): boolean => inferStreamSummaryPath(url) !== null;
