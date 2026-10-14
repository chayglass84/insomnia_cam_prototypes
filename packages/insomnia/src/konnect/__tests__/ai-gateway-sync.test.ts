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

describe('AI Gateway prompts project', () => {
  const getPromptsProject = async () =>
    (await insoservices.project.list({ parentId: ORG_ID })).find(p => p.konnectAiGatewayPromptsFor === 'gw-1');

  it('creates a plain local project with Prompts and Skills folders and a starter prompt', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });

    const project = (await getPromptsProject())!;
    expect(project.konnectControlPlaneId ?? null).toBeNull();
    const [workspace] = await insoservices.workspace.list({ parentId: project._id, scope: 'collection' });
    const folders = await db.find(models.requestGroup.type, { parentId: workspace._id });
    expect(folders.map(f => f.name).sort()).toEqual(['Prompts', 'Skills']);
    const prompts = folders.find(f => f.name === 'Prompts');
    expect(prompts.afterResponseScript).toContain("insomnia.test('Got a valid response'");
    const requests = await db.find(models.request.type, { parentId: prompts._id });
    expect(requests.map(r => r.name)).toEqual(['My first prompt test', 'Test the Concise answers skill']);
    const concise = requests.find(r => r.name === 'Test the Concise answers skill');
    expect(concise.afterResponseScript).toContain('under 80 words');
    expect(concise.aiSkillIds ?? []).toEqual([]);
    expect(JSON.parse(concise.body.text).messages.at(-1).content).toBe('Explain how HTTP caching works.');
  });

  it('adds the example skill to an empty Skills folder, and not once the user has a skill of their own', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    const skillsFolder = (await db.find(models.requestGroup.type, { konnectRouteId: 'ai:gw-1:skills' }))[0];
    const skillsIn = () => db.find(models.request.type, { parentId: skillsFolder._id });
    const [example] = await skillsIn();
    expect(example.name).toBe('Concise answers');
    expect(example.description).toContain('Answer in as few words');

    // Re-sync does not duplicate it.
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    expect(await skillsIn()).toHaveLength(1);

    // The user's own skill replaces the example; it does not come back alongside it.
    await insoservices.request.create({ parentId: skillsFolder._id, name: 'Mine', description: '# Mine' });
    await insoservices.request.remove(example);
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    expect((await skillsIn()).map(r => r.name)).toEqual(['Mine']);
  });

  it('backfills the example into a Skills folder that already existed empty', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    const skillsFolder = (await db.find(models.requestGroup.type, { konnectRouteId: 'ai:gw-1:skills' }))[0];
    for (const request of await db.find(models.request.type, { parentId: skillsFolder._id })) {
      await insoservices.request.remove(request);
    }
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    expect((await db.find(models.request.type, { parentId: skillsFolder._id })).map(r => r.name)).toEqual([
      'Concise answers',
    ]);
  });

  it('is create-only: a deleted starter prompt stays deleted and nothing is duplicated on re-sync', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    const [request] = await db.find(models.request.type, { name: 'My first prompt test' });
    await insoservices.request.remove(request);

    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    expect(await db.find(models.request.type, { name: 'My first prompt test' })).toHaveLength(0);
    expect(await db.find(models.request.type, { name: 'Test the Concise answers skill' })).toHaveLength(1);
    expect((await insoservices.project.list({ parentId: ORG_ID })).filter(p => p.konnectAiGatewayPromptsFor)).toHaveLength(1);
  });

  it('adopts an existing unmarked project with the generated name instead of creating a duplicate', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    const marked = (await getPromptsProject())!;
    // Simulate a data layer that pruned the marker when the project was first saved.
    await insoservices.project.update(marked, { konnectAiGatewayPromptsFor: null });
    expect(await getPromptsProject()).toBeUndefined();

    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    const all = await insoservices.project.list({ parentId: ORG_ID });
    expect(all.filter(p => p.name === 'My Gateway prompts')).toHaveLength(1);
    expect((await getPromptsProject())?._id).toBe(marked._id);
  });

  it('keeps a copy of the gateway model catalog on the prompts workspace and refreshes it on re-sync', async () => {
    vi.stubGlobal('fetch', mockFetch([apiModel('opus')]));
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    const promptsCatalog = async () => {
      const project = (await getPromptsProject())!;
      const [workspace] = await insoservices.workspace.list({ parentId: project._id, scope: 'collection' });
      return workspace.konnectAiGatewayModels?.flatMap(m => m.routeModelValues);
    };
    expect(await promptsCatalog()).toEqual(['opus']);

    vi.stubGlobal('fetch', mockFetch([apiModel('opus'), apiModel('fable')]));
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });
    expect(await promptsCatalog()).toEqual(['opus', 'fable']);
  });

  it('gives the prompts project the same proxy_host as the gateway project on first sync', async () => {
    vi.stubGlobal('fetch', mockFetch());
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });

    const project = (await getPromptsProject())!;
    const [envWorkspace] = await insoservices.workspace.list({ parentId: project._id, scope: 'environment' });
    const promptsEnv = await insoservices.environment.getOrCreateForParentId(envWorkspace._id);
    expect(promptsEnv.data.proxy_host).toBe((await getGatewayEnv()).data.proxy_host);
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

describe('AI Gateway model policies', () => {
  it('stores the policies attached to a model as refs, accepting ids or { id } objects', async () => {
    vi.stubGlobal(
      'fetch',
      mockFetch([
        apiModel('opus', { policies: ['pol-1', { id: 'pol-2', name: 'two' }, { name: 'by-name' }, null] }),
        apiModel('fable'),
      ]),
    );
    await syncKonnect({ pat: 'kpat_test', organizationId: ORG_ID });

    const project = (await insoservices.project.list({ parentId: ORG_ID })).find(p => p.konnectAiGateway);
    const catalog = (await insoservices.workspace.list({ parentId: project._id })).find(
      w => w.konnectAiGatewayModels,
    )!.konnectAiGatewayModels!;
    expect(catalog.find(m => m.routeModelValues.includes('opus'))!.policyRefs).toEqual(['pol-1', 'pol-2', 'by-name']);
    expect(catalog.find(m => m.routeModelValues.includes('fable'))!.policyRefs).toEqual([]);
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
