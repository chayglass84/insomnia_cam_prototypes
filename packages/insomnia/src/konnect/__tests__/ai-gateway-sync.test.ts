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

function mockFetch(models = [apiModel('opus'), apiModel('fable')], opts: { pricesFail?: boolean } = {}) {
  const json = (data: unknown) =>
    new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } });
  return vi.fn(async (url: string) => {
    const region = new URL(url).hostname.split('.')[0];
    if (url.includes('/llm-cost/prices')) {
      if (opts.pricesFail) {
        return new Response('Not found', { status: 404 });
      }
      const data = [
        {
          provider: { id: 'anthropic' },
          model: { id: 'claude-opus' },
          pricing: { input_per_token: '0.000005', output_per_token: '0.000025' },
        },
      ];
      return json({ data, meta: { page: { total: data.length, size: 100, number: 1 } } });
    }
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

describe('AI Gateway starter tests', () => {
  const getRootFolder = async () => {
    const folders = await db.find(models.requestGroup.type, { konnectRouteId: 'ai:gw-1:root' });
    return folders[0];
  };

  it('puts starter after-response tests on the root folder on first sync', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });

    const script = (await getRootFolder()).afterResponseScript;
    expect(script).toContain("insomnia.test('Got a valid response'");
    expect(script).toContain("insomnia.test('Uses under 500 tokens'");
    // The generated script must be valid JavaScript, not just text that looks right.
    expect(() => new Function(script)).not.toThrow();
  });

  it('does not overwrite an edited script on re-sync', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });

    const folder = await getRootFolder();
    await insoservices.requestGroup.update(folder, { afterResponseScript: '// mine' });

    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    expect((await getRootFolder()).afterResponseScript).toBe('// mine');
  });
});

describe('AI Gateway prices', () => {
  const getCatalog = async () => {
    const project = (await insoservices.project.list({ parentId: ORG_ID })).find(p => p.konnectAiGateway);
    const workspaces = await insoservices.workspace.list({ parentId: project._id });
    return workspaces.find(w => w.konnectAiGatewayModels)!.konnectAiGatewayModels!;
  };

  it('stores Konnect per-token prices on matching catalog models', async () => {
    // targets are `claude-opus` / `claude-fable` (apiModel names them claude-<id>)
    vi.stubGlobal(
      'fetch',
      mockFetch([apiModel('opus', { targets: [{ name: 'claude-opus', provider: 'anthropic' }] }), apiModel('fable')]),
    );
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });

    const catalog = await getCatalog();
    const opus = catalog.find(m => m.routeModelValues.includes('opus'))!;
    expect(opus.inputPerToken).toBe(0.000_005);
    expect(opus.outputPerToken).toBe(0.000_025);
    // no price in the list -> no price fields at all
    expect(catalog.find(m => m.routeModelValues.includes('fable'))!.inputPerToken).toBeUndefined();
  });

  it('still syncs (without prices) when the price list is unavailable', async () => {
    vi.stubGlobal('fetch', mockFetch(undefined, { pricesFail: true }));
    const result = await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });

    expect(result.success).toBe(true);
    expect(result.skippedRegions.filter(r => r.includes('AI Gateways'))).toEqual([]);
    expect((await getCatalog()).every(m => m.inputPerToken === undefined)).toBe(true);
  });
});
