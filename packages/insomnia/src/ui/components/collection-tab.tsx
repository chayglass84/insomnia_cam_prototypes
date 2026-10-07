import { Tab, TabList, Tabs } from 'react-aria-components';
import { useNavigate } from 'react-router';
import { twMerge } from 'tailwind-merge';

type DocumentTabId = 'spec' | 'test' | 'judge' | 'scoring';

interface Props {
  organizationId: string;
  projectId: string;
  workspaceId: string;
  activeItemId: DocumentTabId;
  enableLegacyUnitTests: boolean;
  hasLegacyUnitTests: boolean;
  className?: string;
  /** Overrides the first tab's label, e.g. 'Routes/Models' for synced AI Gateway collections. */
  specTabLabel?: string;
  /** Shows the Judge tab (settings for `insomnia.judge()`); synced AI Gateway collections only. Prototype (3593AI). */
  showJudgeTab?: boolean;
  /** Shows the Model Scoring tab; synced AI Gateway collections only. Prototype (3593AI). */
  showScoringTab?: boolean;
}

export const CollectionTab = ({
  organizationId,
  projectId,
  workspaceId,
  activeItemId,
  enableLegacyUnitTests,
  hasLegacyUnitTests,
  className,
  specTabLabel,
  showJudgeTab,
  showScoringTab,
}: Props) => {
  const navigate = useNavigate();
  const base = `/organization/${organizationId}/project/${projectId}/workspace/${workspaceId}`;

  // The setting forces the tab to show. Otherwise, only show it if the collection already has legacy tests.
  const showTestsTab = enableLegacyUnitTests || hasLegacyUnitTests;

  const items: { id: DocumentTabId; name: string; to: string }[] = [
    { id: 'spec', name: specTabLabel ?? 'Spec', to: `${base}/debug` },
    ...(showJudgeTab ? [{ id: 'judge' as const, name: 'Judge', to: `${base}/debug?collectionTab=judge` }] : []),
    ...(showScoringTab
      ? [{ id: 'scoring' as const, name: 'Model Scoring', to: `${base}/debug?collectionTab=scoring` }]
      : []),
    ...(showTestsTab ? [{ id: 'test' as const, name: 'Tests', to: `${base}/test` }] : []),
  ];

  return (
    <Tabs
      selectedKey={activeItemId}
      onSelectionChange={key => {
        const item = items.find(item => item.id === key);
        item && navigate(item.to);
      }}
    >
      <TabList
        aria-label="API Collection Tabs"
        className={twMerge(
          'flex h-(--line-height-sm) w-full shrink-0 items-center border-b border-solid border-b-(--hl-md) bg-(--color-bg)',
          className,
        )}
      >
        {items.map(item => (
          <Tab
            key={item.id}
            id={item.id}
            className="flex h-full shrink-0 cursor-pointer items-center justify-between gap-2 px-3 py-1 text-(--hl) outline-hidden transition-colors duration-300 select-none hover:bg-(--hl-sm) hover:text-(--color-font) focus:bg-(--hl-sm) aria-selected:bg-(--hl-xs) aria-selected:text-(--color-font) aria-selected:hover:bg-(--hl-sm) aria-selected:focus:bg-(--hl-sm) data-focus-visible:ring-2 data-focus-visible:ring-(--hl-md) data-focus-visible:ring-inset"
            data-testid={`api-collection-tab-${item.name.toLowerCase()}`}
          >
            {item.name}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  );
};
