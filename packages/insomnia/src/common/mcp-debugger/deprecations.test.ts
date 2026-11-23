import { describe, expect, it } from 'vitest';

import { isLegacyOnlyTab, versionBadge, versionPickerNote } from './deprecations';

describe('deprecations', () => {
  it('derives the legacy-only panels from the profiles', () => {
    for (const tab of ['roots', 'sampling', 'logging', 'ping'] as const) {
      expect(isLegacyOnlyTab(tab)).toBe(true);
    }
    for (const tab of ['tools', 'resources', 'prompts', 'tasks', 'subscriptions'] as const) {
      expect(isLegacyOnlyTab(tab)).toBe(false);
    }
  });

  it('labels each version by how far it is from the newest', () => {
    expect(versionBadge('2026-07-28')).toMatchObject({ tone: 'newest', monthsBehind: 0 });
    expect(versionBadge('2025-11-25')).toMatchObject({ tone: 'older', label: 'Older spec', monthsBehind: 8 });
    expect(versionBadge('2025-03-26').monthsBehind).toBe(16);
    const oldest = versionBadge('2024-11-05');
    expect(oldest.tone).toBe('deprecated');
    expect(oldest.tooltip).toMatch(/HTTP\+SSE/);
    expect(oldest.tooltip).toMatch(/Validate Server/);
  });

  it('annotates the version picker', () => {
    expect(versionPickerNote('2026-07-28')).toBe('newest');
    expect(versionPickerNote('2025-06-18')).toBe('session-era');
    expect(versionPickerNote('2024-11-05')).toBe('deprecated (HTTP+SSE)');
  });
});
