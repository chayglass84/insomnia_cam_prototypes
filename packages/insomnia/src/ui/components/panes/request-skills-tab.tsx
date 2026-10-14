import type { Request } from 'insomnia-data';
import type { FC } from 'react';
import { Checkbox, CheckboxGroup } from 'react-aria-components';

import { useRequestPatcher } from '../../hooks/use-request';
import { Icon } from '../icon';

/**
 * Prototype (3593AI): which skills (Markdown from the Skills folder) are added to this prompt's system prompt on send.
 * The prompt's saved body is never changed; the skills are added per send.
 */
export const RequestSkillsTab: FC<{ request: Request; skills: Request[] }> = ({ request, skills }) => {
  const patchRequest = useRequestPatcher();
  const checked = (request.aiSkillIds ?? []).filter(id => skills.some(skill => skill._id === id));

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-y-auto p-4">
      <p className="text-sm text-(--hl)">
        Checked skills are added to this prompt's system prompt every time it is sent. The prompt itself isn't changed.
      </p>
      {skills.length === 0 ? (
        <p className="text-sm text-(--hl)">No skills yet. Add a request to the Skills folder to create one.</p>
      ) : (
        <CheckboxGroup
          aria-label="Skills"
          value={checked}
          onChange={aiSkillIds => patchRequest(request._id, { aiSkillIds })}
          className="flex flex-col gap-1"
        >
          {skills.map(skill => (
            <Checkbox
              key={skill._id}
              value={skill._id}
              className="group flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1.5 text-sm hover:bg-(--hl-xs)"
            >
              <span className="flex h-4 w-4 items-center justify-center rounded-xs border border-solid border-(--hl) group-data-selected:bg-(--color-surprise) group-data-selected:text-(--color-font-surprise)">
                <Icon icon="check" className="hidden text-[10px] group-data-selected:block" />
              </span>
              <span className="font-semibold">{skill.name || 'Untitled skill'}</span>
              <span className="truncate text-(--hl)">{firstLine(skill.description)}</span>
            </Checkbox>
          ))}
        </CheckboxGroup>
      )}
    </div>
  );
};

/** The first non-heading, non-empty line of a skill's Markdown, as a one-line summary. */
const firstLine = (markdown: string) =>
  markdown
    .split('\n')
    .map(line => line.trim())
    .find(line => line && !line.startsWith('#')) ?? '';
