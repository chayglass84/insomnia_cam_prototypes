import { describe, expect, it } from 'vitest';

import { detectUi } from './detectUi';

describe('detectUi deprecated key (4348 S7c)', () => {
  it('reads the nested form without a deprecation flag', () => {
    expect(detectUi({ ui: { resourceUri: 'ui://a' } })).toEqual({ resourceUri: 'ui://a', visibility: ['model', 'app'] });
  });

  it('still reads the flat key, and says it is deprecated', () => {
    expect(detectUi({ 'ui/resourceUri': 'ui://a' })).toEqual({ resourceUri: 'ui://a', visibility: ['model', 'app'], deprecatedKey: true });
  });

  it('prefers the nested form when both are present, and ignores an invalid flat value', () => {
    expect(detectUi({ ui: { resourceUri: 'ui://new' }, 'ui/resourceUri': 'ui://old' })?.deprecatedKey).toBeUndefined();
    expect(detectUi({ 'ui/resourceUri': 'https://not-ui' })).toBeUndefined();
  });
});
