import { describe, it, expect } from 'vitest';
import { applyDamage, status } from '../src/shared/Damage.js';
import { stubGame, target } from './helpers.js';

const game = stubGame();

describe('applyDamage', () => {
  it('applies flat armour to physical, floored at 15%', () => {
    const t = target({ armor: 30 });
    expect(applyDamage(t, { amount: 100, type: 'physical' }, game)).toBe(70);
    const t2 = target({ armor: 30 });
    expect(applyDamage(t2, { amount: 20, type: 'physical' }, game)).toBeCloseTo(3);
  });

  it('crush ignores armour', () => {
    const t = target({ armor: 30 });
    expect(applyDamage(t, { amount: 100, type: 'crush' }, game)).toBe(100);
  });

  it('resistance multiplies, and an immune hit still lands its statuses', () => {
    const t = target({ resist: { fire: 0 } });
    const dealt = applyDamage(t, { amount: 50, type: 'fire', statuses: [status('burn', 2, 5)] }, game);
    expect(dealt).toBe(0);
    expect(t.statuses.map((s) => s.kind)).toEqual(['burn']);
    const h = target({ resist: { fire: 1.5 } });
    expect(applyDamage(h, { amount: 10, type: 'fire' }, game)).toBe(15);
  });

  it('a frontal shield absorbs physical but not crush', () => {
    const shield = () => ({ hp: 500, absorb: 0.9, arcCos: Math.cos(Math.PI / 3), max: 500 });
    // facing 0 looks down +z; a hit from +z is frontal.
    const front = { x: 0, y: 0, z: 5 };
    const a = target({ shield: shield() });
    expect(applyDamage(a, { amount: 100, type: 'physical', position: front }, game)).toBeCloseTo(10);
    const b = target({ shield: shield() });
    expect(applyDamage(b, { amount: 100, type: 'crush', position: front }, game)).toBe(100);
    // From behind the shield does nothing.
    const c = target({ shield: shield() });
    expect(applyDamage(c, { amount: 100, type: 'physical', position: { x: 0, y: 0, z: -5 } }, game)).toBe(100);
  });

  it('kills exactly once and clamps hp to zero', () => {
    let kills = 0;
    const t = target({ hp: 10, kill() { kills++; this.dead = true; } });
    applyDamage(t, { amount: 50, type: 'arcane' }, game);
    applyDamage(t, { amount: 50, type: 'arcane' }, game);
    expect(t.hp).toBe(0);
    expect(kills).toBe(1);
  });
});
