import { useEffect, useState } from 'react';

import { fetchAiGatewayPolicies, type KonnectAiGatewayPolicy } from '../../konnect/api';

interface AiGatewayPoliciesState {
  status: 'loading' | 'error' | 'ready';
  error?: string;
  policies: KonnectAiGatewayPolicy[];
}

/** Loads every policy on an AI Gateway (gateway-wide and model-scoped); the caller decides which apply. */
export function useAiGatewayPolicies(gatewayId: string | null | undefined, region: string | null | undefined) {
  const [state, setState] = useState<AiGatewayPoliciesState>({ status: 'loading', policies: [] });

  useEffect(() => {
    if (!gatewayId || !region) {
      setState({ status: 'error', error: 'This gateway has no Konnect id or region.', policies: [] });
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setState({ status: 'loading', policies: [] });

    (async () => {
      const pat = await window.main.secretStorage.getSecret('konnectPat');
      if (!pat) {
        if (!cancelled) {
          setState({ status: 'error', error: 'No Konnect personal access token found.', policies: [] });
        }
        return;
      }
      try {
        const policies = await fetchAiGatewayPolicies(pat, gatewayId, region, controller.signal);
        if (!cancelled) {
          setState({ status: 'ready', policies });
        }
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            error: err instanceof Error ? err.message : 'Failed to load Konnect policies.',
            policies: [],
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [gatewayId, region]);

  return state;
}
