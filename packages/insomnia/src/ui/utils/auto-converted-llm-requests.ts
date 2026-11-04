// Prototype (3593AI) shortcut, flagged: which requests "Auto-convert LLM URLs to SSE Requests" converted.
// Held in memory only (cleared on app restart) rather than as a new request field, so there is no schema
// change or migration. The model guard and failure hint only apply to these requests; after a restart a
// converted request behaves like any other. Promote to a real field if this ships.
const autoConverted = new Set<string>();

export const markAutoConvertedLlmRequest = (requestId: string) => {
  autoConverted.add(requestId);
};

export const unmarkAutoConvertedLlmRequest = (requestId: string) => {
  autoConverted.delete(requestId);
};

export const isAutoConvertedLlmRequest = (requestId: string) => autoConverted.has(requestId);
