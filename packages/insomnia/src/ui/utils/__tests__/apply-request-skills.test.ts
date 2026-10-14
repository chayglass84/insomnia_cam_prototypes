// @ts-nocheck
/** The skill helper against the in-memory NeDB from setup-vitest.ts (real services, no mocks of the data layer). */
import { initDatabase, services as insoservices } from 'insomnia-data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line no-restricted-imports
import { resetV4Counter } from '../../../../../insomnia-data/__mocks__/uuid';
import { mainDatabase } from '../../../main/database.main';
import { bodyTextWithRequestSkills } from '../apply-request-skills';

const catalog = [
  {
    id: 'sonnet',
    displayName: 'Sonnet',
    format: 'anthropic',
    paths: ['/other-anthropic'],
    routeModelValues: ['sonnet'],
    enabled: true,
    targetModel: 'claude-sonnet',
    provider: 'claude',
  },
];

beforeEach(async () => {
  await initDatabase(mainDatabase, { inMemoryOnly: true }, true);
  resetV4Counter();
});
afterEach(() => vi.clearAllMocks());

describe('bodyTextWithRequestSkills', () => {
  it('adds a saved skill to the system prompt of a rendered request', async () => {
    const skill = await insoservices.request.create({
      parentId: 'fld_skills',
      name: 'Concise answers',
      description: '# Concise\n\nBe brief.',
    });
    const body = JSON.stringify({
      model: 'sonnet',
      stream: true,
      system: 'Be a helpful assistant.',
      messages: [{ role: 'user', content: 'Explain how HTTP caching works.' }],
    });
    const result = await bodyTextWithRequestSkills(
      { aiSkillIds: [skill._id], url: 'http://localhost:8500/other-anthropic/v1/messages', body: { text: body } },
      catalog,
    );
    expect(result).toBeDefined();
    const system = JSON.parse(result).system;
    expect(system).toContain('Be a helpful assistant.');
    expect(system).toContain('## Skill: Concise answers');
    expect(system).toContain('Be brief.');
  });

  it('returns undefined with no skills checked or a deleted skill', async () => {
    const body = JSON.stringify({ model: 'sonnet', messages: [{ role: 'user', content: 'Q' }] });
    const url = 'http://localhost:8500/other-anthropic/v1/messages';
    expect(await bodyTextWithRequestSkills({ aiSkillIds: [], url, body: { text: body } }, catalog)).toBeUndefined();
    expect(await bodyTextWithRequestSkills({ aiSkillIds: ['req_gone'], url, body: { text: body } }, catalog)).toBeUndefined();
  });
});
