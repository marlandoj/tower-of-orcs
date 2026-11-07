import { describe, it, expect } from 'vitest';
import { Grid, TILE, CEIL_H } from '../src/world/Grid.js';
import { boomHit } from '../src/core/CameraRig.js';

/** A 7x3 room: walls all round, one floor row with a spawn at x=1 and a rift at x=5. */
function corridor() {
  const g = new Grid(7, 3);
  for (const c of g.cells) c.kind = 'wall';
  for (let x = 1; x <= 5; x++) g.cell(x, 1).kind = 'floor';
  g.cell(5, 1).kind = 'rift';
  g.rifts.push({ gx: 5, gz: 1 });
  return g;
}

describe('Grid', () => {
  it('maps world to cell and back to the cell centre', () => {
    const g = corridor();
    expect(g.toCell({ x: TILE * 2.5, z: TILE * 1.1 })).toEqual({ gx: 2, gz: 1 });
    const w = g.toWorld(2, 1);
    expect([w.x, w.z]).toEqual([TILE * 2.5, TILE * 1.5]);
  });

  it('rift flow distance falls toward the rift and is infinite through walls', () => {
    const g = corridor();
    const f = g.riftFlow();
    const d = [1, 2, 3, 4, 5].map((x) => f.distAt(x, 1));
    for (let i = 1; i < d.length; i++) expect(d[i]).toBeLessThan(d[i - 1]);
    expect(d[4]).toBe(0);
    expect(Number.isFinite(f.distAt(0, 0))).toBe(false);
  });
});

describe('boomHit (camera collision)', () => {
  const dir = (x, y, z) => { const l = Math.hypot(x, y, z); return { x: x / l, y: y / l, z: z / l }; };

  it('hits the first wall cell below ceiling height', () => {
    const g = corridor();
    const o = { x: TILE * 3.5, y: 1, z: TILE * 1.5 };
    const t = boomHit(g, o, dir(1, 0, 0), 100);
    // Wall at gx=6 starts at x = 6*TILE.
    expect(t).toBeCloseTo(6 * TILE - o.x);
  });

  it('passes over walls when the boom is above ceiling height, and stops at map edge', () => {
    const g = corridor();
    const o = { x: TILE * 3.5, y: CEIL_H + 1, z: TILE * 1.5 };
    expect(boomHit(g, o, dir(1, 0, 0), 100)).toBe(-1);
  });

  it('ignores the start cell and respects maxT', () => {
    const g = corridor();
    const o = { x: TILE * 3.5, y: 1, z: TILE * 1.5 };
    expect(boomHit(g, o, dir(1, 0, 0), 1)).toBe(-1);
  });
});
