// Prototype (3593AI): a "skill" is a request that lives under a prompts project's `Skills` folder; its Markdown
// instructions are stored in the request's `description`. This is a deliberate shortcut: Insomnia has no
// Markdown-file item, and a description already has an editor/preview and travels with the collection (and Git).
// Production would want a real file/item type.

import { parseChatRequestBody, serializeChatRequestBody } from './chat-request';

const SKILLS_FOLDER_KEY = /^ai:.+:skills$/;

export const skillsFolderKey = (gatewayId: string) => `ai:${gatewayId}:skills`;

export const isSkillsFolder = (group: { konnectRouteId?: string | null }) =>
  SKILLS_FOLDER_KEY.test(group.konnectRouteId ?? '');

/** True when the request sits anywhere beneath a Skills folder. `docs` is the collection's folders (any order). */
export const isSkillRequest = (
  request: { parentId: string },
  docs: { _id: string; parentId: string; konnectRouteId?: string | null }[],
): boolean => {
  const byId = new Map(docs.map(doc => [doc._id, doc]));
  const seen = new Set<string>();
  let parent = byId.get(request.parentId);
  while (parent && !seen.has(parent._id)) {
    if (isSkillsFolder(parent)) {
      return true;
    }
    seen.add(parent._id);
    parent = byId.get(parent.parentId);
  }
  return false;
};

export const STARTER_SKILL_NAME = 'Concise answers';
export const STARTER_SKILL_MARKDOWN = `# Concise answers

Answer in as few words as the question allows.

- Lead with the answer, then at most two sentences of explanation.
- Use a bullet list only when the user asks for several items.
- Never restate the question or add a closing summary.
`;

export interface SkillText {
  name: string;
  markdown: string;
}

/** The block added to a system prompt for the checked skills, in the order given. */
export const buildSkillsSystemText = (skills: SkillText[]): string =>
  skills.map(skill => `## Skill: ${skill.name}\n\n${skill.markdown.trim()}`).join('\n\n');

/**
 * Adds the skills to a chat request body's system prompt (the top-level `system` for Anthropic, a system message for
 * OpenAI), after any system prompt already there. Returns `skipReason` instead when the body isn't a chat request in a
 * format with a system prompt we know how to edit (e.g. Gemini); the caller then sends the body unchanged.
 */
export const applySkillsToChatBody = (
  bodyText: string,
  skills: SkillText[],
  /** The route's real format when known (the gateway catalog). Body shape alone can't tell OpenAI from Anthropic. */
  knownFormat?: string,
): { bodyText: string } | { skipReason: string } => {
  if (skills.length === 0) {
    return { bodyText };
  }
  const parsed = parseChatRequestBody(bodyText);
  if (!parsed) {
    return { skipReason: "The body isn't a chat request, so skills can't be added." };
  }
  const format = knownFormat === 'anthropic' || knownFormat === 'openai' ? knownFormat : parsed.format;
  if (format === 'gemini' || (knownFormat && knownFormat !== 'anthropic' && knownFormat !== 'openai')) {
    return { skipReason: "Skills can't be added to this request's format yet." };
  }
  const skillText = buildSkillsSystemText(skills);
  const [first, ...rest] = parsed.messages;
  const messages =
    first?.role === 'system'
      ? [{ ...first, content: `${first.content}\n\n${skillText}` }, ...rest]
      : [{ role: 'system' as const, content: skillText }, ...parsed.messages];
  return { bodyText: serializeChatRequestBody(bodyText, format, { messages }) };
};

/** Starter prompt that wants a long answer, so the Concise answers skill visibly changes the outcome. */
export const CONCISE_SKILL_PROMPT_NAME = 'Test the Concise answers skill';
export const CONCISE_SKILL_PROMPT_QUESTION = 'Explain how HTTP caching works.';
export const CONCISE_SKILL_PROMPT_DESCRIPTION =
  'Send this as is, then check **Concise answers** on the Skills tab and send again. The test passes only when the answer is under 80 words.';
export const CONCISE_SKILL_AFTER_RESPONSE_SCRIPT = `insomnia.test('Answers in under 80 words', () => {
  const body = insomnia.response.json();
  // Anthropic-format models return content blocks; OpenAI-format models return choices.
  const text = body.content
    ? body.content.filter(b => b.type === 'text').map(b => b.text).join('')
    : body.choices?.[0]?.message?.content ?? '';
  const words = text.trim().split(/\\s+/).filter(Boolean).length;

  insomnia.expect(words, \`answered in \${words} words\`).to.be.below(80);
});
`;
