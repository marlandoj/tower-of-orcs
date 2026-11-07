import { describe, it, expect } from 'vitest';
import { tierDamageMult, clampTier, MAX_SPELLBOOK_TIER } from '../src/shared/progression.js';
import { tierBonus } from '../src/ui/spellbook.js';

describe('spellbook tiers', () => {
  it('every tier, including the last, adds damage', () => {
    for (let t = 1; t <= MAX_SPELLBOOK_TIER; t++) expect(tierDamageMult(t)).toBeGreaterThan(tierDamageMult(t - 1));
  });
  it('clamps junk and over-max tiers', () => {
    expect(clampTier(NaN)).toBe(0);
    expect(clampTier(-2)).toBe(0);
    expect(clampTier(99)).toBe(MAX_SPELLBOOK_TIER);
  });
  it('the UI shows the number the game applies', () => {
    for (let t = 0; t <= MAX_SPELLBOOK_TIER; t++) expect(tierBonus(t)).toBe(Math.round((tierDamageMult(t) - 1) * 100));
  });
});
