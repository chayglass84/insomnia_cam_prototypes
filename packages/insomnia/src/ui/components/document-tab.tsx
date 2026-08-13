import classnames from 'classnames';
import { NavLink } from 'react-router';

import { useRootLoaderData } from '~/root';

interface Props {
  organizationId: string;
  projectId: string;
  workspaceId: string;
  className?: string;
}

export const DocumentTab = ({ organizationId, projectId, workspaceId, className }: Props) => {
  const { settings } = useRootLoaderData()!;

  // INS-3528: Collection is no longer nested under the Document — hidden here. The Tests tab
  // (and this whole switcher) only shows when legacy unit tests are enabled; most Documents
  // only have a Spec, so there's nothing to switch between otherwise.
  if (!settings.enableLegacyUnitTests) {
    return null;
  }

  return (
    <nav className={`flex h-[40px] w-full items-center ${className} justify-around px-1`}>
      {[
        { id: 'spec', name: 'Spec' },
        { id: 'test', name: 'Tests' },
      ].map(item => (
        <NavLink
          key={item.id}
          to={`/organization/${organizationId}/project/${projectId}/workspace/${workspaceId}/${item.id}`}
          className={({ isActive, isPending }) =>
            classnames('rounded-full px-2 text-center', {
              'bg-(--color-surprise) text-(--color-font-surprise)': isActive,
              'animate-pulse': isPending,
            })
          }
          data-testid={`workspace-${item.id}`}
        >
          {item.name}
        </NavLink>
      ))}
    </nav>
  );
};
