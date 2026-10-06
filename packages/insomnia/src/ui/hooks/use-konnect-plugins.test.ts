import { describe, expect, it } from 'vitest';

import { resolveKonnectRouteLink } from './use-konnect-plugins';

describe('resolveKonnectRouteLink', () => {
  const project = { konnectControlPlaneId: 'cp-1', konnectRegion: 'us' };
  const workspace = { konnectServiceId: 'svc-1' };

  it('resolves a control-plane request, taking only the route id from the composite key', () => {
    expect(resolveKonnectRouteLink({ konnectRouteKey: 'route-uuid:GET:/flights:https' }, workspace, project)).toEqual({
      controlPlaneId: 'cp-1',
      region: 'us',
      serviceId: 'svc-1',
      routeId: 'route-uuid',
    });
  });

  it('returns null for an AI Gateway request, whose workspace has no Konnect service', () => {
    // AI gateway requests carry `ai:<gatewayId>:<path>` keys and live in a workspace without konnectServiceId;
    // they must not be misread as a control-plane route (the first segment would be the literal "ai").
    expect(resolveKonnectRouteLink({ konnectRouteKey: 'ai:gw-1:/anthropic' }, {}, project)).toBeNull();
  });

  it('returns null when any link in the Request -> Workspace -> Project chain is missing', () => {
    expect(resolveKonnectRouteLink({}, workspace, project)).toBeNull();
    expect(resolveKonnectRouteLink({ konnectRouteKey: 'r:GET::http' }, {}, project)).toBeNull();
    expect(resolveKonnectRouteLink({ konnectRouteKey: 'r:GET::http' }, workspace, {})).toBeNull();
    expect(resolveKonnectRouteLink({ konnectRouteKey: 'r:GET::http' }, null, project)).toBeNull();
  });
});
