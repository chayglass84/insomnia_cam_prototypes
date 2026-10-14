import type { AiGatewayModel } from 'insomnia-data';
import { services } from 'insomnia-data';

import { applySkillsToChatBody, type SkillText } from '../../common/ai-skills';
import { findCatalogModelsByPath } from '../../konnect/transform';

/**
 * Prototype (3593AI): the request body text with the request's checked skills added to its system prompt, or
 * undefined when nothing changes (no skills, a missing body, or a format we can't edit). Used by every send path
 * (plain send and event-stream connect) so a skill is never silently dropped on one of them. Nothing is saved.
 */
export const bodyTextWithRequestSkills = async (
  request: { aiSkillIds?: string[] | null; url: string; body?: { text?: string } },
  catalog: AiGatewayModel[] | null | undefined,
): Promise<string | undefined> => {
  const skillIds = request.aiSkillIds ?? [];
  if (skillIds.length === 0 || !request.body?.text) {
    return undefined;
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
    return undefined;
  }
  note(`added ${skills.map(skill => `"${skill.name}"`).join(', ')} to the system prompt (${routeFormat ?? 'format guessed from body'})`);
  return result.bodyText;
};
