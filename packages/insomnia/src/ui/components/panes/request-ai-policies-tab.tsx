import type { AiGatewayModel, Project, Request } from 'insomnia-data';
import React from 'react';
import { Button } from 'react-aria-components';

import { findCatalogModelsByPath } from '../../../konnect/transform';
import { useAiGatewayPolicies } from '../../hooks/use-konnect-ai-policies';

interface Props {
  activeRequest: Pick<Request, 'url' | 'body'>;
  activeProject: Pick<Project, 'konnectControlPlaneId' | 'konnectRegion' | 'name'> | null | undefined;
  catalog: AiGatewayModel[];
}

// PROTOTYPE SHORTCUT: curated static list of AI-relevant policy types. Konnect has an "available policies" list
// (91 types), but that endpoint is internal and its path unconfirmed.
const SUGGESTED_AI_POLICIES: { type: string; description: string }[] = [
  { type: 'ai-prompt-guard', description: 'Allow or deny prompts that match patterns before they reach the model.' },
  {
    type: 'ai-semantic-cache',
    description: 'Serve cached answers for semantically similar prompts to cut cost and latency.',
  },
  {
    type: 'ai-rate-limiting-advanced',
    description: 'Rate limit by token usage per provider, model or consumer, not just request count.',
  },
  { type: 'ai-sanitizer', description: 'Redact sensitive data from prompts and responses.' },
  { type: 'ai-prompt-decorator', description: 'Prepend or append fixed instructions to every prompt.' },
];

const docsUrl = (policyType: string) => `https://developer.konghq.com/plugins/${policyType}/`;

const rowButton = 'rounded-xs px-2 py-1 text-(--hl) hover:bg-(--hl-xs) hover:text-(--color-font)';

/** The AI Gateway flavor of the Konnect Plugins tab: policies on the request's route, each labelled with the models it covers. */
export const RequestAiPoliciesTab = ({ activeRequest, activeProject, catalog }: Props) => {
  const { status, error, policies } = useAiGatewayPolicies(
    activeProject?.konnectControlPlaneId,
    activeProject?.konnectRegion,
  );

  if (status === 'loading') {
    return <div className="p-4 text-(--hl)">Loading policies from Konnect…</div>;
  }
  if (status === 'error') {
    return <div className="p-4 text-(--color-danger)">Failed to load policies: {error}</div>;
  }

  // Scoped to the request's route, not its model (the model can change without this tab re-rendering the request):
  // global policies, plus any attached to at least one model on this route, each labelled with those models.
  const routeModels = findCatalogModelsByPath(activeRequest.url, catalog);
  const modelLabel = (model: AiGatewayModel) => model.routeModelValues[0] ?? model.displayName;
  const applied = [...policies]
    .sort((a, b) => Number(b.global) - Number(a.global))
    .flatMap(policy => {
      if (policy.global) {
        return [{ policy, models: '<all>' }];
      }
      const attached = routeModels.filter(
        model => model.policyRefs?.includes(policy.id) || model.policyRefs?.includes(policy.name),
      );
      return attached.length > 0 ? [{ policy, models: attached.map(modelLabel).join(', ') }] : [];
    });
  const appliedTypes = new Set(applied.map(({ policy }) => policy.type));
  const suggestions = SUGGESTED_AI_POLICIES.filter(s => !appliedTypes.has(s.type)).slice(0, 5);

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto">
      <div className="p-4">
        <h3 className="mb-1 text-xs font-bold text-(--hl) uppercase">Konnect Policies</h3>
      </div>
      {applied.length === 0 && <div className="px-4 pb-4 text-sm text-(--hl)">No policies apply to this route.</div>}
      {applied.map(({ policy, models }) => (
        <div
          key={policy.id}
          className="flex items-center justify-between gap-3 border-b border-solid border-(--hl-md) px-4 py-2"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className={`h-2 w-2 shrink-0 rounded-full ${policy.enabled ? 'bg-green-500' : 'bg-(--hl-md)'}`} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{policy.display_name || policy.name}</span>
              <span className="text-xs text-(--hl)">
                <span className="font-mono">{policy.type}</span> · models: {models}{policy.enabled ? '' : ' · disabled'}
              </span>
            </div>
          </div>
          <Button
            className={`${rowButton} shrink-0 text-xs`}
            onPress={() => window.main.openInBrowser(docsUrl(policy.type))}
          >
            Docs
          </Button>
        </div>
      ))}
      {suggestions.length > 0 && (
        <div className="p-4">
          <h3 className="mb-1 text-xs font-bold text-(--hl) uppercase">Suggested policies</h3>
          {suggestions.map(suggestion => (
            <div
              key={suggestion.type}
              className="flex items-center justify-between gap-3 border-b border-solid border-(--hl-md) py-2"
            >
              <div className="flex min-w-0 flex-col">
                <span className="font-mono text-sm">{suggestion.type}</span>
                <span className="text-xs text-(--hl)">{suggestion.description}</span>
              </div>
              <Button
                className={`${rowButton} shrink-0 text-xs`}
                onPress={() => window.main.openInBrowser(docsUrl(suggestion.type))}
              >
                Docs
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
