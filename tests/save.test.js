import { describe, it, expect } from 'vitest';
import { normalizeSave } from '../src/core/Save.js';

describe('normalizeSave', () => {
  it('returns defaults for non-objects', () => {
    for (const raw of [null, 42, 'x', []]) {
      const d = normalizeSave(raw);
      expect(d.unlockedLevel).toBe(0);
      expect(d.best).toEqual({});
      expect(d.settings.master).toBe(0.8);
    }
  });

  it('survives {"best": null} and junk best records', () => {
    const d = normalizeSave({ best: null });
    expect(d.best).toEqual({});
    const e = normalizeSave({ best: { 0: { score: 900, skulls: 9 }, 1: 'bad', 2: { score: 'NaN' } } });
    expect(e.best[0]).toEqual({ score: 900, skulls: 5 });
    expect(e.best[1]).toBeUndefined();
    expect(e.best[2]).toEqual({ score: 0, skulls: 0 });
    expect(e.totalSkulls).toBe(5);
  });

  it('repairs a partial player record instead of leaking NaN', () => {
    const d = normalizeSave({ player: { ranks: { hp: 2, bad: 'x' } } });
    expect(d.player).toEqual({ points: 0, spent: 0, ranks: { hp: 2 }, claimed: [] });
  });

  it('clamps settings, keeps unknown settings and top-level keys', () => {
    const d = normalizeSave({ settings: { master: 99, damageNumbers: 'yes', keybinds: { pause: ['KeyP'] } }, future: 1 });
    expect(d.settings.master).toBe(4);
    expect(d.settings.damageNumbers).toBe(true);
    expect(d.settings.keybinds).toEqual({ pause: ['KeyP'] });
    expect(d.future).toBe(1);
  });
});
