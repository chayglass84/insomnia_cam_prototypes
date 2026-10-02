// Per-turn model/token-usage metadata for chat bubbles, keyed by the assistant message's own text.
//
// Shortcut, deliberately: this is an in-memory-only cache (lost on reload), not persisted to the
// request/response models. A full fix would carry this alongside each turn in a real data model
// field; this is the fast version for a prototype. Past turns' text only ever exists as
// live-accumulated SSE text (see handleSendFollowUp's comment in realtime-response-pane.tsx) — it's
// never written back anywhere with structure, so content is the only stable key available once a
// turn is superseded by the next one.
export interface ChatTurnMeta {
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  stopReason?: string;
}

const turnMetaByContent = new Map<string, ChatTurnMeta>();

export const recordChatTurnMeta = (content: string, meta: ChatTurnMeta) => {
  if (!content.trim()) {
    return;
  }
  turnMetaByContent.set(content, meta);
};

export const getChatTurnMeta = (content: string): ChatTurnMeta | undefined => turnMetaByContent.get(content);
