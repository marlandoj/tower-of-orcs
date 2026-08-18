/**
 * Cost-aware flow field (uniform-cost Dijkstra from the targets outward) plus a
 * bilinear gradient sampler. One field serves every enemy of a movement class, so
 * 300 orcs cost the same as 3.
 *
 * Returned object:
 *   distAt(gx,gz) -> number (Infinity if unreachable)
 *   dirAt(gx,gz)  -> {x,z} unit-ish vector toward the target
 *   sample(worldX, worldZ, out) -> out {x,z} smoothed steering direction
 */
import { TILE } from './Grid.js';

const NEI = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, 1.41421], [1, -1, 1.41421], [-1, 1, 1.41421], [-1, -1, 1.41421],
];

export function buildFlowField(grid, targets, opts = {}) {
  const { w, h } = grid;
  const n = w * h;
  const dist = new Float32Array(n).fill(Infinity);
  const dirX = new Float32Array(n);
  const dirZ = new Float32Array(n);
  const passable = opts.fly
    ? (x, z) => grid.isFlyable(x, z)
    : (x, z) => grid.isWalkable(x, z);

  // Bucketed priority queue: costs are small multiples, so 1024 buckets is plenty
  // and gives O(1) push/pop versus a binary heap.
  const BUCKETS = 2048, GRAN = 4; // 0.25 unit resolution
  const buckets = Array.from({ length: BUCKETS }, () => []);
  let head = 0, remaining = 0;

  const push = (i, d) => {
    dist[i] = d;
    const b = Math.min(BUCKETS - 1, Math.max(head, Math.round(d * GRAN) % BUCKETS));
    buckets[b].push(i);
    remaining++;
  };

  for (const t of targets) {
    if (!grid.inBounds(t.gx, t.gz)) continue;
    push(t.gz * w + t.gx, 0);
  }
  if (remaining === 0) return emptyField(grid);

  let scanned = 0;
  while (remaining > 0 && scanned < BUCKETS * 4) {
    const b = buckets[head % BUCKETS];
    if (b.length === 0) { head++; scanned++; continue; }
    scanned = 0;
    const i = b.pop();
    remaining--;
    const gx = i % w, gz = (i / w) | 0;
    const d = dist[i];

    for (let k = 0; k < 8; k++) {
      const [dx, dz, base] = NEI[k];
      const nx = gx + dx, nz = gz + dz;
      if (!passable(nx, nz)) continue;
      // No corner-cutting through wall diagonals.
      if (dx && dz && (!passable(gx + dx, gz) || !passable(gx, gz + dz))) continue;
      const c = grid.cells[nz * w + nx];
      const step = base * (c.cost || 1);
      const nd = d + step;
      const ni = nz * w + nx;
      if (nd < dist[ni] - 1e-4) push(ni, nd);
    }
  }

  // Gradient pass: each cell points at its cheapest neighbour.
  for (let gz = 0; gz < h; gz++) {
    for (let gx = 0; gx < w; gx++) {
      const i = gz * w + gx;
      if (!isFinite(dist[i])) continue;
      let best = dist[i], bx = 0, bz = 0;
      for (let k = 0; k < 8; k++) {
        const [dx, dz] = NEI[k];
        const nx = gx + dx, nz = gz + dz;
        if (!passable(nx, nz)) continue;
        if (dx && dz && (!passable(gx + dx, gz) || !passable(gx, gz + dz))) continue;
        const nd = dist[nz * w + nx];
        if (nd < best) { best = nd; bx = dx; bz = dz; }
      }
      const len = Math.hypot(bx, bz) || 1;
      dirX[i] = bx / len; dirZ[i] = bz / len;
    }
  }

  const at = (gx, gz) => (grid.inBounds(gx, gz) ? gz * w + gx : -1);

  return {
    dist, dirX, dirZ, grid,
    distAt(gx, gz) { const i = at(gx, gz); return i < 0 ? Infinity : dist[i]; },
    dirAt(gx, gz, out = { x: 0, z: 0 }) {
      const i = at(gx, gz);
      if (i < 0) { out.x = 0; out.z = 0; return out; }
      out.x = dirX[i]; out.z = dirZ[i];
      return out;
    },
    /**
     * Bilinear blend of the four surrounding cells' directions, weighted by proximity
     * to their centres. This is what removes the "orcs snap to grid lines" look.
     */
    sample(wx, wz, out = { x: 0, z: 0 }) {
      const fx = wx / TILE - 0.5, fz = wz / TILE - 0.5;
      const x0 = Math.floor(fx), z0 = Math.floor(fz);
      const tx = fx - x0, tz = fz - z0;
      let sx = 0, sz = 0, wsum = 0;
      for (let j = 0; j <= 1; j++) {
        for (let k = 0; k <= 1; k++) {
          const i = at(x0 + k, z0 + j);
          if (i < 0 || !isFinite(dist[i])) continue;
          const wgt = (k ? tx : 1 - tx) * (j ? tz : 1 - tz);
          sx += dirX[i] * wgt; sz += dirZ[i] * wgt; wsum += wgt;
        }
      }
      if (wsum < 1e-4) return this.dirAt(Math.round(fx), Math.round(fz), out);
      const len = Math.hypot(sx, sz) || 1;
      out.x = sx / len; out.z = sz / len;
      return out;
    },
    /** True when no route exists from this cell — used to reject wall-off placements. */
    unreachable(gx, gz) { return !isFinite(this.distAt(gx, gz)); },
  };
}

function emptyField(grid) {
  return {
    grid,
    distAt: () => Infinity,
    dirAt: (gx, gz, out = { x: 0, z: 0 }) => { out.x = 0; out.z = 0; return out; },
    sample: (x, z, out = { x: 0, z: 0 }) => { out.x = 0; out.z = 0; return out; },
    unreachable: () => true,
  };
}
