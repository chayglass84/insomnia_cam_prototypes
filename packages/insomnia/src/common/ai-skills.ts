// Prototype (3593AI): a "skill" is a request that lives under a prompts project's `Skills` folder; its Markdown
// instructions are stored in the request's `description`. This is a deliberate shortcut: Insomnia has no
// Markdown-file item, and a description already has an editor/preview and travels with the collection (and Git).
// Production would want a real file/item type.

import { parseChatRequestBody, serializeChatRequestBody } from './chat-request';

const SKILLS_FOLDER_KEY = /^ai:.+:skills$/;

export const skillsFolderKey = (gatewayId: string) => `ai:${gatewayId}:skills`;

export const isSkillsFolder = (group: { konnectRouteId?: string | null }) =>
  SKILLS_FOLDER_KEY.test(group.konnectRouteId ?? '');

/** The three folders sync creates in the AI Gateway projects; each holds one kind of thing (see the sidebar menus). */
export type AiFolderKind = 'models' | 'prompts' | 'skills';

/** The kind of a synced AI Gateway folder (`Routes and Models`, `Prompts`, `Skills`), or undefined for any other folder. */
export const aiFolderKind = (group: { konnectRouteId?: string | null }): AiFolderKind | undefined => {
  const key = group.konnectRouteId ?? '';
  if (SKILLS_FOLDER_KEY.test(key)) {
    return 'skills';
  }
  if (/^ai:.+:prompts$/.test(key)) {
    return 'prompts';
  }
  return /^ai:.+:root$/.test(key) ? 'models' : undefined;
};

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
export const CONCISE_SKILL_PROMPT_NAME = 'Skill Testing Demo';
export const CONCISE_SKILL_PROMPT_QUESTION = 'Explain how HTTP caching works.';
export const CONCISE_SKILL_PROMPT_DESCRIPTION =
  'Send this as is, then check **Concise answers** on the Skills tab and send again. The first test counts words. The second asks the judge (pick one on the collection\'s Judge tab), which also sees the skill the model was given, so it fails when the skill is missing or ignored.';
export const CONCISE_SKILL_AFTER_RESPONSE_SCRIPT = `insomnia.test('Answers in under 80 words', () => {
  const body = insomnia.response.json();
  // Anthropic-format models return content blocks; OpenAI-format models return choices.
  const text = body.content
    ? body.content.filter(b => b.type === 'text').map(b => b.text).join('')
    : body.choices?.[0]?.message?.content ?? '';
  const words = text.trim().split(/\\s+/).filter(Boolean).length;

  insomnia.expect(words, \`answered in \${words} words\`).to.be.below(80);
});

// Needs a judge: pick one on the collection's Judge tab. The judge sees the question, the answer and the system
// prompt (which includes any checked skills), so the first criterion fails when the skill was not applied.
insomnia.test('Follows the Concise answers skill', async () => {
  const verdict = await insomnia.judge([
    'The instructions the model was given include a "Concise answers" skill',
    'The first sentence answers the question directly, without restating it',
    'No more than two sentences of explanation follow the first sentence',
    'There is no closing summary or recap',
  ]);
  verdict.expectAllPassed();
  return verdict;
});
`;
