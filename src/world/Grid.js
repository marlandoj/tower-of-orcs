import * as THREE from 'three';
import { buildFlowField } from './Flow.js';

export const TILE = 4;
export const CEIL_H = 6;
export const DIRS = ['N', 'E', 'S', 'W'];
export const DIR_VEC = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
export const DIR_ANGLE = { N: Math.PI, E: -Math.PI / 2, S: 0, W: Math.PI / 2 };

function makeCell(gx, gz, kind) {
  return {
    gx, gz, kind,
    height: 0,
    cost: 1,
    floorTrap: null,
    wallTraps: { N: null, E: null, S: null, W: null },
    ceilTrap: null,
    /**
     * A placed Barricade. Declared here rather than being attached on demand so every
     * cell in the game has the same shape, and so `cell.blocker` is always `null` or a
     * trap and never `undefined`.
     *
     * Placing one also flips `kind` to `'wall'`, which is why nothing in this file needs
     * to know barricades exist: `isWalkable`, `surfaces` and the flow field all read
     * `kind`. The consequence for everyone else is that **`kind` is not static after
     * `build()`** — any per-cell geometry or reachability state cached at load time must
     * be invalidated through `markDirty()`, which is what placing and selling a barricade
     * calls.
     */
    blocker: null,
    flags: new Set(),
  };
}

/**
 * The authoritative spatial model of a level. Everything — pathing, trap placement,
 * spawn/rift lookup, enemy bucketing — reads from here.
 */
export class Grid {
  constructor(w, h) {
    this.w = w; this.h = h;
    this.cells = new Array(w * h);
    for (let z = 0; z < h; z++)
      for (let x = 0; x < w; x++)
        this.cells[z * w + x] = makeCell(x, z, 'void');

    this.spawns = [];   // [{ gx, gz, dir, id }]
    this.rifts = [];    // [{ gx, gz }]
    this._flowCache = new Map();
    this._dirty = true;
    /** Spatial hash of enemies, rebuilt each frame by EnemyManager. */
    this.buckets = new Map();
  }

  idx(gx, gz) { return gz * this.w + gx; }
  inBounds(gx, gz) { return gx >= 0 && gz >= 0 && gx < this.w && gz < this.h; }
  cell(gx, gz) { return this.inBounds(gx, gz) ? this.cells[gz * this.w + gx] : null; }

  toWorld(gx, gz, out = new THREE.Vector3()) {
    return out.set(gx * TILE + TILE * 0.5, this.cell(gx, gz)?.height ?? 0, gz * TILE + TILE * 0.5);
  }
  toCell(v, out = { gx: 0, gz: 0 }) {
    out.gx = Math.floor(v.x / TILE);
    out.gz = Math.floor(v.z / TILE);
    return out;
  }
  cellAtWorld(v) {
    return this.cell(Math.floor(v.x / TILE), Math.floor(v.z / TILE));
  }

  isWalkable(gx, gz) {
    const c = this.cell(gx, gz);
    if (!c) return false;
    return c.kind === 'floor' || c.kind === 'spawn' || c.kind === 'rift' || c.kind === 'ledge';
  }
  /** Flyers ignore pits and lava but still respect walls. */
  isFlyable(gx, gz) {
    const c = this.cell(gx, gz);
    return !!c && c.kind !== 'wall';
  }

  /** Which surfaces at this cell can accept a trap right now. */
  surfaces(gx, gz) {
    const c = this.cell(gx, gz);
    if (!c) return { floor: false, wall: [], ceiling: false };
    const buildable = this.isWalkable(gx, gz) && !c.flags.has('no-build');
    const wall = [];
    if (buildable) {
      for (const d of DIRS) {
        const [dx, dz] = DIR_VEC[d];
        const n = this.cell(gx + dx, gz + dz);
        if ((!n || n.kind === 'wall') && !c.wallTraps[d]) wall.push(d);
      }
    }
    return {
      floor: buildable && !c.floorTrap && c.kind !== 'rift' && c.kind !== 'spawn',
      wall,
      ceiling: buildable && !c.ceilTrap && c.kind !== 'rift' && c.kind !== 'spawn',
    };
  }

  markDirty() { this._dirty = true; this._flowCache.clear(); }

  /**
   * Flow field toward a set of target cells. Cached per target-key and invalidated by
   * markDirty(). Cost-aware, so tar pits and lava push paths away naturally.
   */
  flowTo(targets, opts = {}) {
    const key = (opts.key || 'default') + '|' + targets.map(t => `${t.gx},${t.gz}`).join(';');
    let f = this._flowCache.get(key);
    if (!f) { f = buildFlowField(this, targets, opts); this._flowCache.set(key, f); }
    return f;
  }

  /** Flow field to the rift(s) — the one every ground orc uses. */
  riftFlow() { return this.flowTo(this.rifts, { key: 'rift' }); }
  riftFlowAir() { return this.flowTo(this.rifts, { key: 'rift-air', fly: true }); }

  forEach(fn) { for (const c of this.cells) fn(c); }
}
