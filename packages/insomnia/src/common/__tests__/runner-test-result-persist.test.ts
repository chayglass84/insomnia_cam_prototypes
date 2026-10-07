// @ts-nocheck
/** The data layer prunes top-level fields a model does not declare, so new fields must be in `optionalKeys`. */
import { initDatabase, services } from 'insomnia-data';
import { beforeEach, describe, expect, it } from 'vitest';

import { mainDatabase } from '../../main/database.main';

beforeEach(async () => {
  await initDatabase(mainDatabase, { inMemoryOnly: true }, true);
});

describe('runner test result persistence', () => {
  it('keeps modelScores and scoringError', async () => {
    const created = await services.runnerTestResult.create({
      parentId: 'wrk_1',
      modelScores: [{ id: '/a|opus', score: 0.9, note: 'n' }],
      scoringError: 'boom',
    });
    const reread = await services.runnerTestResult.getById(created._id);
    expect(reread.modelScores).toEqual([{ id: '/a|opus', score: 0.9, note: 'n' }]);
    expect(reread.scoringError).toBe('boom');
  });
});
