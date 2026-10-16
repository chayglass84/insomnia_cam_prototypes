import type { AiGatewayModel } from 'insomnia-data';
import { services } from 'insomnia-data';

import { applySkillsToChatBody, type SkillText } from '../../common/ai-skills';
import { findCatalogModelsByPath } from '../../konnect/transform';

/**
 * Prototype (3593AI): the request body text with the request's checked skills added to its system prompt, or
 * undefined when nothing changes (no skills, a missing body, or a format we can't edit). Used by every send path
 * (plain send and event-stream connect) so a skill is never silently dropped on one of them. Nothing is saved.
 * `skillNames` lists the skills actually added (empty when none were), for recording on the response.
 */
export const applyRequestSkills = async (
  request: { aiSkillIds?: string[] | null; url: string; body?: { text?: string } },
  catalog: AiGatewayModel[] | null | undefined,
): Promise<{ bodyText: string | undefined; skillNames: string[] }> => {
  const skillIds = request.aiSkillIds ?? [];
  if (skillIds.length === 0 || !request.body?.text) {
    return { bodyText: undefined, skillNames: [] };
  }
  // Diagnostics (prototype): says what was decided on every send that has skills checked.
  const note = (message: string) => console.info(`[skills] ${message}`);
  const skills: SkillText[] = [];
  for (const id of skillIds) {
    const skill = await services.request.getById(id);
    if (skill) {
      skills.push({ name: skill.name, markdown: skill.description });
    }
  }
  const routeFormat = findCatalogModelsByPath(request.url, catalog ?? [])[0]?.format;
  const result = applySkillsToChatBody(request.body.text, skills, routeFormat);
  if ('skipReason' in result || skills.length === 0) {
    note(
      `not applied (${skillIds.length} checked, ${skills.length} found): ${'skipReason' in result ? result.skipReason : 'none of the checked skills exist any more'}`,
    );
    return { bodyText: undefined, skillNames: [] };
  }
  note(`added ${skills.map(skill => `"${skill.name}"`).join(', ')} to the system prompt (${routeFormat ?? 'format guessed from body'})`);
  return { bodyText: result.bodyText, skillNames: skills.map(skill => skill.name) };
};

export const bodyTextWithRequestSkills = async (
  ...args: Parameters<typeof applyRequestSkills>
): Promise<string | undefined> => (await applyRequestSkills(...args)).bodyText;
