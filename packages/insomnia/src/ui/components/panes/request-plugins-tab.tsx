import type { Project, Request, Workspace } from 'insomnia-data';
import React, { useState } from 'react';
import { Button } from 'react-aria-components';

import type { KonnectPlugin } from '../../../konnect/api';
import { resolveKonnectRouteLink, useKonnectPlugins } from '../../hooks/use-konnect-plugins';
import { DeckCommandModal } from '../modals/deck-command-modal';

interface Props {
  activeRequest: Pick<Request, 'konnectRouteKey'>;
  activeWorkspace: Pick<Workspace, 'konnectServiceId'> | null | undefined;
  activeProject: Pick<Project, 'konnectControlPlaneId' | 'konnectRegion' | 'name'> | null | undefined;
}

// PROTOTYPE SHORTCUT: curated static list, not derived from usage analytics
// or the control plane's actual traffic/config.
const SUGGESTED_PLUGINS: { name: string; description: string }[] = [
  { name: 'rate-limiting', description: 'Limit how many requests a consumer can make in a given time period.' },
  { name: 'key-auth', description: 'Require a valid API key on every request to this route.' },
  { name: 'cors', description: 'Control cross-origin access so browsers can safely call this route.' },
  { name: 'request-transformer', description: 'Add, remove, or modify headers, querystrings, and the body before it reaches the upstream.' },
  { name: 'prometheus', description: 'Expose Kong metrics for this route in Prometheus format for monitoring.' },
];

const docsUrl = (pluginName: string) => `https://developer.konghq.com/plugins/${pluginName}/`;

// PROTOTYPE SHORTCUT: best-effort Konnect Gateway Manager deep link built
// from region/control-plane/route IDs, not a verified/versioned URL scheme.
const konnectEditUrl = (region: string, controlPlaneId: string, pluginId: string) =>
  `https://cloud.konghq.com/${region}/gateway-manager/${controlPlaneId}/plugins/${pluginId}`;

function scopeLabel(plugin: KonnectPlugin): string {
  if (plugin.route) {
    return 'Route';
  }
  if (plugin.service) {
    return 'Service';
  }
  if (plugin.consumer) {
    return 'Consumer';
  }
  return 'Global';
}

// PROTOTYPE SHORTCUT: sorts route-scoped plugins first, then falls back to
// API return order. This is NOT a full resolution of Kong's real phase-based
// plugin execution order (which depends on each plugin's declared priority
// and its scope: route > service > global, per phase).
function sortByApproximateExecutionOrder(plugins: KonnectPlugin[]): KonnectPlugin[] {
  const scopeWeight = (p: KonnectPlugin) => (p.route ? 0 : p.service ? 1 : p.consumer ? 2 : 3);
  return [...plugins].sort((a, b) => scopeWeight(a) - scopeWeight(b));
}

function PluginRow({
  plugin,
  region,
  controlPlaneId,
  onShowDeckCommand,
}: {
  plugin: KonnectPlugin;
  region: string;
  controlPlaneId: string;
  onShowDeckCommand: (plugin: KonnectPlugin) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-solid border-(--hl-md) px-4 py-2">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`h-2 w-2 shrink-0 rounded-full ${plugin.enabled ? 'bg-green-500' : 'bg-(--hl-md)'}`} />
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{plugin.name}</span>
          <span className="text-xs text-(--hl)">{scopeLabel(plugin)}-scoped{!plugin.enabled ? ' · disabled' : ''}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 text-xs">
        <Button
          className="rounded-xs px-2 py-1 text-(--hl) hover:bg-(--hl-xs) hover:text-(--color-font)"
          onPress={() => window.main.openInBrowser(docsUrl(plugin.name))}
        >
          Docs
        </Button>
        <Button
          className="rounded-xs px-2 py-1 text-(--hl) hover:bg-(--hl-xs) hover:text-(--color-font)"
          onPress={() => window.main.openInBrowser(konnectEditUrl(region, controlPlaneId, plugin.id))}
        >
          Edit in Konnect
        </Button>
        <Button
          className="rounded-xs px-2 py-1 text-(--hl) hover:bg-(--hl-xs) hover:text-(--color-font)"
          onPress={() => onShowDeckCommand(plugin)}
        >
          decK command
        </Button>
      </div>
    </div>
  );
}

// PROTOTYPE SHORTCUT: a suggested plugin isn't applied yet, so there's no
// real KonnectPlugin to show a decK command for — this stub carries just
// enough shape (name + empty config) to reuse the same modal.
function stubSuggestedPlugin(name: string): KonnectPlugin {
  return {
    id: name,
    name,
    enabled: false,
    config: {},
    protocols: null,
    tags: null,
    route: null,
    service: null,
    consumer: null,
  };
}

export const RequestPluginsTab = ({ activeRequest, activeWorkspace, activeProject }: Props) => {
  const link = resolveKonnectRouteLink(activeRequest, activeWorkspace, activeProject);
  const { status, error, routePlugins } = useKonnectPlugins(link);
  const [deckModalPlugin, setDeckModalPlugin] = useState<{ plugin: KonnectPlugin; isNew: boolean } | null>(null);

  if (status === 'not-linked') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-(--hl)">
        <span>This request isn't linked to a Konnect route.</span>
        <span className="text-xs">Plugins can only be shown for requests imported/synced from Kong Konnect.</span>
      </div>
    );
  }

  if (status === 'loading') {
    return <div className="p-4 text-(--hl)">Loading plugins from Konnect…</div>;
  }

  if (status === 'error') {
    return <div className="p-4 text-(--color-danger)">Failed to load plugins: {error}</div>;
  }

  const orderedPlugins = sortByApproximateExecutionOrder(routePlugins);
  const appliedNames = new Set(routePlugins.map(p => p.name));
  const suggestions = SUGGESTED_PLUGINS.filter(p => !appliedNames.has(p.name)).slice(0, 5);

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto">
      <div className="p-4">
        <h3 className="mb-1 text-xs font-bold text-(--hl) uppercase">Konnect Plugins</h3>
        <p className="mb-2 text-xs text-(--hl)">
          Route-scoped plugins run before service-scoped, which run before global plugins.
        </p>
      </div>
      {orderedPlugins.length === 0 && <div className="px-4 pb-4 text-sm text-(--hl)">No plugins applied to this route.</div>}
      {orderedPlugins.map(plugin => (
        <PluginRow
          key={plugin.id}
          plugin={plugin}
          region={link!.region}
          controlPlaneId={link!.controlPlaneId}
          onShowDeckCommand={p => setDeckModalPlugin({ plugin: p, isNew: false })}
        />
      ))}

      {suggestions.length > 0 && (
        <div className="mt-6">
          <div className="flex items-start justify-between gap-3 bg-(--hl-xs) px-4 py-2">
            <div>
              <h3 className="text-xs font-bold text-(--hl) uppercase">Suggested plugins</h3>
              <p className="text-xs text-(--hl)">Commonly used plugins not yet applied to this route.</p>
            </div>
            <Button
              className="shrink-0 rounded-xs px-2 py-1 text-xs text-(--hl) hover:bg-(--hl-sm) hover:text-(--color-font)"
              onPress={() => window.main.openInBrowser('https://developer.konghq.com/plugins/')}
            >
              View all plugins
            </Button>
          </div>
          {suggestions.map(plugin => (
            <div
              key={plugin.name}
              className="flex items-center justify-between gap-3 border-b border-solid border-(--hl-md) px-4 py-3"
            >
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="font-medium">{plugin.name}</span>
                <span className="text-xs text-(--hl)">{plugin.description}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2 text-xs">
                <Button
                  className="rounded-xs px-2 py-1 text-(--hl) hover:bg-(--hl-xs) hover:text-(--color-font)"
                  onPress={() => window.main.openInBrowser(docsUrl(plugin.name))}
                >
                  Docs
                </Button>
                <Button
                  className="rounded-xs px-2 py-1 text-(--hl) hover:bg-(--hl-xs) hover:text-(--color-font)"
                  onPress={() => window.main.openInBrowser(konnectEditUrl(link!.region, link!.controlPlaneId, ''))}
                >
                  Add in Konnect
                </Button>
                <Button
                  className="rounded-xs px-2 py-1 text-(--hl) hover:bg-(--hl-xs) hover:text-(--color-font)"
                  onPress={() => setDeckModalPlugin({ plugin: stubSuggestedPlugin(plugin.name), isNew: true })}
                >
                  decK command
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {deckModalPlugin && (
        <DeckCommandModal
          plugin={deckModalPlugin.plugin}
          controlPlaneName={activeProject?.name ?? link!.controlPlaneId}
          isNew={deckModalPlugin.isNew}
          onHide={() => setDeckModalPlugin(null)}
        />
      )}
    </div>
  );
};
