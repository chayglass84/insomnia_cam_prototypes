import type { Project, Request, Workspace } from 'insomnia-data';
import { useEffect, useState } from 'react';

import { fetchAllPlugins, fetchPluginsForRoute, type KonnectPlugin } from '../../konnect/api';

export interface KonnectRouteLink {
  controlPlaneId: string;
  region: string;
  serviceId: string;
  routeId: string;
}

// Walks Request -> Workspace -> Project to resolve the Konnect route this
// request was synced from. Returns null if any link in the chain is missing,
// which callers use to decide whether to show the Plugins tab's content or
// an empty "not connected to Konnect" state.
export function resolveKonnectRouteLink(
  request: Pick<Request, 'konnectRouteKey'>,
  workspace: Pick<Workspace, 'konnectServiceId'> | null | undefined,
  project: Pick<Project, 'konnectControlPlaneId' | 'konnectRegion'> | null | undefined,
): KonnectRouteLink | null {
  if (!request.konnectRouteKey || !workspace?.konnectServiceId || !project?.konnectControlPlaneId || !project?.konnectRegion) {
    return null;
  }
  // `konnectRouteKey` is a composite key built during sync as
  // `${route.id}:${method}:${pathSegment}:${protocol}` (see konnect/sync.ts)
  // — the actual Konnect route UUID is only the first segment.
  const routeId = request.konnectRouteKey.split(':')[0];
  return {
    controlPlaneId: project.konnectControlPlaneId,
    region: project.konnectRegion,
    serviceId: workspace.konnectServiceId,
    routeId,
  };
}

interface KonnectPluginsState {
  status: 'not-linked' | 'loading' | 'error' | 'ready';
  error?: string;
  // Plugins that actually affect this route's traffic: attached directly to
  // the route, to its service, or global (no route/service/consumer scope).
  // Excludes plugins scoped to other routes/services in the control plane.
  routePlugins: KonnectPlugin[];
  suggestablePlugins: KonnectPlugin[];
}

// Fetches the plugins that apply to a Konnect-linked request's route (route +
// service + global scoped), plus the full control-plane plugin list (used to
// derive "not yet applied" suggestions).
export function useKonnectPlugins(link: KonnectRouteLink | null): KonnectPluginsState {
  const [state, setState] = useState<KonnectPluginsState>({
    status: link ? 'loading' : 'not-linked',
    routePlugins: [],
    suggestablePlugins: [],
  });

  useEffect(() => {
    if (!link) {
      setState({ status: 'not-linked', routePlugins: [], suggestablePlugins: [] });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setState({ status: 'loading', routePlugins: [], suggestablePlugins: [] });

    (async () => {
      const pat = await window.main.secretStorage.getSecret('konnectPat');
      if (!pat) {
        if (!cancelled) {
          setState({ status: 'error', error: 'No Konnect personal access token found.', routePlugins: [], suggestablePlugins: [] });
        }
        return;
      }
      try {
        const [directRoutePlugins, allPlugins] = await Promise.all([
          fetchPluginsForRoute(pat, link.controlPlaneId, link.routeId, link.region, controller.signal),
          fetchAllPlugins(pat, link.controlPlaneId, link.region, controller.signal),
        ]);
        if (cancelled) {
          return;
        }
        // `/routes/{id}/plugins` only returns plugins attached directly to
        // the route — it misses service-scoped and global plugins, which
        // still apply to this route's traffic. Merge those in from the
        // full control-plane plugin list.
        const servicePlugins = allPlugins.filter(p => p.service?.id === link.serviceId);
        const globalPlugins = allPlugins.filter(p => !p.route && !p.service && !p.consumer);
        const appliedById = new Map<string, KonnectPlugin>();
        [...directRoutePlugins, ...servicePlugins, ...globalPlugins].forEach(p => appliedById.set(p.id, p));
        const routePlugins = [...appliedById.values()];

        const appliedNames = new Set(routePlugins.map(p => p.name));
        const suggestablePlugins = allPlugins.filter(p => !appliedNames.has(p.name));
        setState({ status: 'ready', routePlugins, suggestablePlugins });
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            error: err instanceof Error ? err.message : 'Failed to load Konnect plugins.',
            routePlugins: [],
            suggestablePlugins: [],
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `link` is a freshly-constructed object every render; depend on its
    // primitive fields instead so the effect only reruns when they change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link?.controlPlaneId, link?.region, link?.serviceId, link?.routeId]);

  return state;
}
