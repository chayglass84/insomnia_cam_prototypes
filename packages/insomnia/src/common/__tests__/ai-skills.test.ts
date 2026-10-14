import { describe, expect, it } from 'vitest';

import {
  applySkillsToChatBody,
  buildSkillsSystemText,
  CONCISE_SKILL_AFTER_RESPONSE_SCRIPT,
  isSkillRequest,
  isSkillsFolder,
  skillsFolderKey,
} from '../ai-skills';

const folder = (_id: string, parentId: string, konnectRouteId?: string) => ({ _id, parentId, konnectRouteId });

describe('ai skills', () => {
  it('recognises the Skills folder by its key', () => {
    expect(isSkillsFolder({ konnectRouteId: skillsFolderKey('gw-1') })).toBe(true);
    expect(isSkillsFolder({ konnectRouteId: 'ai:gw-1:prompts' })).toBe(false);
    expect(isSkillsFolder({})).toBe(false);
  });

  it('treats a request anywhere beneath a Skills folder as a skill', () => {
    const docs = [
      folder('skills', 'wrk', skillsFolderKey('gw-1')),
      folder('nested', 'skills'),
      folder('prompts', 'wrk', 'ai:gw-1:prompts'),
    ];
    expect(isSkillRequest({ parentId: 'skills' }, docs)).toBe(true);
    expect(isSkillRequest({ parentId: 'nested' }, docs)).toBe(true);
    expect(isSkillRequest({ parentId: 'prompts' }, docs)).toBe(false);
    expect(isSkillRequest({ parentId: 'wrk' }, docs)).toBe(false);
  });

  it('does not loop forever on a cyclic folder chain', () => {
    const docs = [folder('a', 'b'), folder('b', 'a')];
    expect(isSkillRequest({ parentId: 'a' }, docs)).toBe(false);
  });
});

describe('applySkillsToChatBody', () => {
  const skills = [
    { name: 'Concise', markdown: '# Concise\n\nBe brief.\n' },
    { name: 'Polite', markdown: 'Say please.' },
  ];

  it('builds one block per skill, in order', () => {
    expect(buildSkillsSystemText(skills)).toBe('## Skill: Concise\n\n# Concise\n\nBe brief.\n\n## Skill: Polite\n\nSay please.');
  });

  it('appends to an Anthropic system prompt and keeps the rest of the body', () => {
    const body = JSON.stringify({
      model: 'opus',
      max_tokens: 10,
      system: 'Be helpful.',
      messages: [{ role: 'user', content: 'Q' }],
    });
    const result = applySkillsToChatBody(body, skills);
    expect('bodyText' in result).toBe(true);
    const parsed = JSON.parse((result as { bodyText: string }).bodyText);
    expect(parsed.system).toBe(`Be helpful.\n\n${buildSkillsSystemText(skills)}`);
    expect(parsed).toMatchObject({ model: 'opus', max_tokens: 10, messages: [{ role: 'user', content: 'Q' }] });
  });

  it('adds a system prompt to an Anthropic body that has none', () => {
    const body = JSON.stringify({ model: 'opus', messages: [{ role: 'user', content: 'Q' }] });
    const parsed = JSON.parse((applySkillsToChatBody(body, skills) as { bodyText: string }).bodyText);
    expect(parsed.system).toBe(buildSkillsSystemText(skills));
  });

  it('merges into the first OpenAI system message, or prepends one', () => {
    const withSystem = JSON.stringify({
      model: 'gpt',
      messages: [
        { role: 'system', content: 'Be helpful.' },
        { role: 'user', content: 'Q' },
      ],
    });
    const merged = JSON.parse((applySkillsToChatBody(withSystem, skills) as { bodyText: string }).bodyText);
    expect(merged.messages).toHaveLength(2);
    expect(merged.messages[0].content).toBe(`Be helpful.\n\n${buildSkillsSystemText(skills)}`);

    const without = JSON.stringify({ model: 'gpt', messages: [{ role: 'user', content: 'Q' }] });
    const prepended = JSON.parse((applySkillsToChatBody(without, skills, 'openai') as { bodyText: string }).bodyText);
    expect(prepended.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
  });

  it('uses the known route format when the body shape is ambiguous', () => {
    // A user-only message list parses as Anthropic by shape, but this route is OpenAI: add a system message, not `system`.
    const body = JSON.stringify({ model: 'gpt', messages: [{ role: 'user', content: 'Q' }] });
    const parsed = JSON.parse((applySkillsToChatBody(body, skills, 'openai') as { bodyText: string }).bodyText);
    expect(parsed.system).toBeUndefined();
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(applySkillsToChatBody(body, skills, 'bedrock')).toHaveProperty('skipReason');
  });

  it('returns the body unchanged for no skills, and a reason for non-chat or Gemini bodies', () => {
    const body = JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'Q' }] });
    expect(applySkillsToChatBody(body, [])).toEqual({ bodyText: body });
    expect(applySkillsToChatBody('not json', skills)).toHaveProperty('skipReason');
    const gemini = JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Q' }] }] });
    expect(applySkillsToChatBody(gemini, skills)).toHaveProperty('skipReason');
  });
});

describe('concise skill starter test', () => {
  const run = (text: string) => {
    const results: { name: string; ok: boolean }[] = [];
    const insomnia = {
      response: { json: () => ({ content: [{ type: 'text', text }] }) },
      expect: (value: number) => ({ to: { be: { below: (limit: number) => { if (!(value < limit)) throw new Error('too long'); } } } }),
      test: (name: string, fn: () => void) => {
        try {
          fn();
          results.push({ name, ok: true });
        } catch {
          results.push({ name, ok: false });
        }
      },
    };
    new Function('insomnia', CONCISE_SKILL_AFTER_RESPONSE_SCRIPT)(insomnia);
    return results;
  };

  it('passes a short answer and fails a long one', () => {
    expect(run('Short answer here.')).toEqual([{ name: 'Answers in under 80 words', ok: true }]);
    expect(run(Array.from({ length: 120 }, () => 'word').join(' '))).toEqual([
      { name: 'Answers in under 80 words', ok: false },
    ]);
  });
});
