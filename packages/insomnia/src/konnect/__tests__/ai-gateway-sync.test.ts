// @ts-nocheck
/** AI Gateway sync, run against the in-memory NeDB from setup-vitest.ts with fetch mocked. */
import { initDatabase, models, services as insoservices } from 'insomnia-data';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// eslint-disable-next-line no-restricted-imports
import { resetV4Counter } from '../../../../insomnia-data/__mocks__/uuid';
import { database as db } from '../../common/database';
import { mainDatabase } from '../../main/database.main';
import { syncKonnect } from '../sync';

const ORG_ID = 'org_test';

const GATEWAY = {
  id: 'gw-1',
  name: 'my-gw',
  display_name: 'My Gateway',
  deployment_type: 'hybrid',
  proxy_urls: [],
};

const apiModel = (id: string, overrides = {}) => ({
  id,
  name: id,
  display_name: id.toUpperCase(),
  enabled: true,
  formats: [{ type: 'anthropic' }],
  targets: [{ name: `claude-${id}`, provider: 'claude' }],
  config: { route: { paths: ['/anthropic'], model: { values: [id] } } },
  ...overrides,
});

function mockFetch(models = [apiModel('opus'), apiModel('fable')]) {
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return vi.fn(async (url: string) => {
    const region = new URL(url).hostname.split('.')[0];
    if (url.includes('/v1/ai-gateways/') && url.includes('/models')) {
      return json({ data: models, meta: { page: { next: null } } });
    }
    if (url.includes('/v1/ai-gateways')) {
      const data = region === 'us' ? [GATEWAY] : [];
      return json({ data, meta: { page: { total: data.length, size: 100, number: 1 } } });
    }
    if (url.includes('/v2/control-planes')) {
      return json({ data: [], meta: { page: { total: 0, size: 100, number: 1 } } });
    }
    return new Response('Not found', { status: 404 });
  });
}

const getGatewayEnv = async () => {
  const project = (await insoservices.project.list({ parentId: ORG_ID })).find(p => p.konnectAiGateway);
  const [envWorkspace] = await insoservices.workspace.list({ parentId: project._id, scope: 'environment' });
  return insoservices.environment.getOrCreateForParentId(envWorkspace._id);
};

beforeEach(async () => {
  await initDatabase(mainDatabase, { inMemoryOnly: true }, true);
  resetV4Counter();
  vi.stubGlobal('window', { main: { trackAnalyticsEvent: vi.fn() } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('AI Gateway environment', () => {
  it('creates proxy_host with a localhost default on first sync', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    expect((await getGatewayEnv()).data.proxy_host).toBe('localhost:8000');
  });

  it('keeps a value the user edited in JSON (Raw Edit) mode, which only updates `data`', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });

    const env = await getGatewayEnv();
    await insoservices.environment.update(env, { data: { ...env.data, proxy_host: 'localhost:8500' } });

    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    expect((await getGatewayEnv()).data.proxy_host).toBe('localhost:8500');
  });

  it('keeps a value the user edited in Table Edit mode (kvPairData + data)', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });

    const env = await getGatewayEnv();
    const kvPairData = env.kvPairData.map(kv => (kv.name === 'proxy_host' ? { ...kv, value: 'localhost:8500' } : kv));
    await insoservices.environment.update(env, { kvPairData, data: { ...env.data, proxy_host: 'localhost:8500' } });

    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    const after = await getGatewayEnv();
    expect(after.data.proxy_host).toBe('localhost:8500');
    expect(after.kvPairData.find(kv => kv.name === 'proxy_host').value).toBe('localhost:8500');
  });

  it('keeps user edits (and other variables) when kvPairData is missing, e.g. a legacy JSON environment', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });

    const env = await getGatewayEnv();
    await insoservices.environment.update(env, {
      kvPairData: undefined,
      data: { proxy_host: 'localhost:8500', my_api_key: 'secret' },
    });

    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    const after = await getGatewayEnv();
    expect(after.data.proxy_host).toBe('localhost:8500');
    expect(after.data.my_api_key).toBe('secret');
  });
});
