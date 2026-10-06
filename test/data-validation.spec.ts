import { describe, expect, it } from 'vitest';

import { createCanonicalKey } from '../src/domain/index';

describe('canonical keys', () => {
  it('normalizes case, whitespace, and optional object keys deterministically', () => {
    expect(createCanonicalKey(' 艾琳 ', ' 会 送达 ', ' STAR MAP ')).toBe('艾琳::会 送达::star map');
    expect(createCanonicalKey('艾琳', '会 送达')).toBe('艾琳::会 送达::');
  });
});
