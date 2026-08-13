import { database } from 'insomnia-data';
import { models, services } from 'insomnia-data';

// INS-3528: legacy unit tests are hidden by default. If a user already has UnitTestSuites
// from before this change, turn the setting on for them so their existing tests don't
// disappear. Sticky-on: once enabled this way, it's never auto-disabled — only a manual
// toggle in Preferences turns it back off.
export async function enableLegacyUnitTestsIfPresent(): Promise<void> {
  const settings = await services.settings.get();
  if (settings.enableLegacyUnitTests) {
    return;
  }

  const unitTestSuiteCount = await database.count(models.unitTestSuite.type);
  if (unitTestSuiteCount > 0) {
    await services.settings.patch({ enableLegacyUnitTests: true });
  }
}
