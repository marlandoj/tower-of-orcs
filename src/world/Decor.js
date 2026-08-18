import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TILE, CEIL_H, DIRS, DIR_VEC } from './Grid.js';
import { propGeo, glowGeo, propColors, GeoAcc } from './Props.js';
import { webTex, bannerTex, decalAtlas, glowTex } from './Textures.js';
import { makeRng } from '../shared/rng.js';

/**
 * Turns a solved grid into a dressed fortress.
 *
 * The whole pass is *read-only with respect to pathing*: it never writes `kind`, `cost`
 * or `flags`, so a decorated level and a bare level have byte-identical flow fields.
 * Where a prop physically stands is chosen so it does not lie in the walking lane:
 * bulky things hug wall faces in wide cells, narrow chokepoints get only flat decals
 * and wall-mounted dressing, and anything tall is anchored to a wall corner.
 *
 * Everything ends up in five merged meshes — solid, glow, cloth, web, decal — so the
 * entire decoration pass costs five draw calls no matter how many objects are on screen.
 */

// Per-theme dressing recipes. This is the table that makes the ice keep not the forge.
const THEMES = {
  keep: {
    big: ['barrel', 'crate', 'crate', 'sack', 'cart', 'weaponRack'],
    small: ['rubble', 'bones', 'sack', 'rubble'],
    column: 'pillar',
    wall: [['sconce', 0.55], ['banner', 0.16], ['chain', 0.08], ['web', 0.05]],
    top: ['rubble'],
    decalMix: [0.22, 0.20, 0.20, 0.38],   // crack / stain / growth / chips
    glow: 'flame', vent: 0, crystal: 0,
    density: 1.0,
  },
  dungeon: {
    big: ['barrel', 'crate', 'cage', 'rubble', 'pillarBroken', 'bones'],
    small: ['bones', 'rubble', 'bones', 'spike'],
    column: 'pillarBroken',
    wall: [['sconce', 0.45], ['chain', 0.18], ['web', 0.22], ['banner', 0.05]],
    top: ['rubble', 'spike'],
    decalMix: [0.28, 0.16, 0.34, 0.22],
    glow: 'flame', vent: 0, crystal: 0.05,
    density: 1.1,
  },
  forge: {
    big: ['anvil', 'heap', 'barrel', 'crate', 'cart', 'heap'],
    small: ['rubble', 'heap', 'bones', 'rubble'],
    column: 'pillar',
    wall: [['sconce', 0.60], ['chain', 0.16], ['banner', 0.10]],
    top: ['rubble'],
    decalMix: [0.32, 0.34, 0.10, 0.24],
    glow: 'flame', vent: 0.05, crystal: 0,
    density: 1.05,
  },
  ice: {
    big: ['crate', 'barrel', 'brazier', 'spike', 'rubble', 'cart', 'spike'],
    small: ['spike', 'rubble', 'bones', 'spike'],
    column: 'pillar',
    // Ice ran the campaign's thinnest sconce roll (0.40) *and* its brightest ambient, so
    // the two snowfield levels measured 2% of the frame warm against 73% cool — the worst
    // hue spread in the game after the fix landed everywhere else. A garrison in a blizzard
    // is the one place that should be burning the most fuel, not the least.
    wall: [['sconce', 0.62], ['banner', 0.13], ['chain', 0.07]],
    top: ['spike', 'rubble'],
    decalMix: [0.26, 0.14, 0.42, 0.18],
    glow: 'flame', vent: 0, crystal: 0.09,
    density: 0.95,
  },
  throne: {
    big: ['obelisk', 'skullPile', 'brazier', 'rubble', 'pillarBroken', 'skullPile'],
    small: ['skullPile', 'bones', 'rubble', 'bones'],
    column: 'obelisk',
    wall: [['sconce', 0.62], ['banner', 0.22], ['chain', 0.14], ['web', 0.06]],
    top: ['rubble', 'skullPile'],
    decalMix: [0.30, 0.18, 0.32, 0.20],
    glow: 'flame', vent: 0.04, crystal: 0.10,
    density: 1.15,
  },
};

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _sc = new THREE.Vector3();
const _tint = new THREE.Color();

export class Decor {
  constructor(game, grid, def) {
    this.game = game;
    this.grid = grid;
    this.def = def;
    this.pal = def.palette || {};
    this.theme = this.pal.theme || 'keep';
    this.recipe = THEMES[this.theme] || THEMES.keep;
    this.colors = propColors(this.theme, this.pal);
    this.root = new THREE.Group();
    this.root.name = 'decor';
    this.rng = makeRng(0xD3C0 ^ (def.width * 977 + def.height * 31 + (def.seed ?? 0)));
    this._geoCache = new Map();
    this._buckets = { solid: [], glow: [], cloth: [], web: [], decal: [] };
    this._disposables = [];
    this.torchAnchors = [];   // world positions worth putting a real point light on
    this.counts = {};

    /**
     * The stone the *architecture* is cut from — arches, ribs, clerestory, colonnade.
     *
     * It is deliberately not `colors.stone`. The prop set's stone is a theme constant, a
     * near-neutral grey that reads as a rock you tripped over; the wall the arch is
     * physically set into is `pal.wallA`, which the exposure contract has already placed
     * on the campaign's luminance ladder and which carries the level's hue. Quoting the
     * wall is what stops built architecture from sitting *on top of* the palette as a
     * separate, brighter, greyer object. Mixed rather than copied, so an arch still reads
     * as dressed stone against rubble masonry instead of vanishing into the wall.
     */
    // The mix is 0.40, not the 0.78 it was, because `propColors` now does most of this
    // job itself: the prop set's `stone` is already pulled 72% of the way to `wallA` (see
    // the masonry note there), so quoting the wall a second time at 0.78 would land arches
    // and columns on the wall's hue to within a couple of points and dissolve the
    // distinction between built architecture and the mass it is set into.
    const wallA = hexOf(this.pal.wallA, 0x6a6258);
    const wallB = hexOf(this.pal.wallB, 0x413b34);
    this.archStone = mixHex(this.colors.stone, wallA, 0.40);
    this.archDark = mixHex(this.colors.stoneDark, wallB, 0.40);
  }

  // --- grid analysis -------------------------------------------------------
  /**
   * Precomputes, per cell: whether it is walkable, how open it is (walkable cells in a
   * 5x5 window — the proxy for "is this a corridor or a room"), and its distance from
   * the rift. Openness is what decides whether a cell may hold a barrel or only a stain.
   */
  _analyse() {
    const { grid } = this;
    const n = grid.w * grid.h;
    this.open = new Uint8Array(n);
    this.edge = new Uint8Array(n);     // walkable and touching a wall
    for (let z = 0; z < grid.h; z++) {
      for (let x = 0; x < grid.w; x++) {
        const i = z * grid.w + x;
        if (!grid.isWalkable(x, z)) continue;
        let cnt = 0;
        for (let dz = -2; dz <= 2; dz++)
          for (let dx = -2; dx <= 2; dx++)
            if (grid.isWalkable(x + dx, z + dz)) cnt++;
        this.open[i] = cnt;
        for (const d of DIRS) {
          const [dx, dz] = DIR_VEC[d];
          const c = grid.cell(x + dx, z + dz);
          if (!c || c.kind === 'wall') { this.edge[i] = 1; break; }
        }
      }
    }
    // Distance from the rift, used to keep the approach to the rift ceremonial and the
    // far ends of the map derelict.
    const flow = grid.riftFlow();
    this.dist = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const d = flow.dist ? flow.dist[i] : Infinity;
      this.dist[i] = isFinite(d) ? d : -1;
    }
    this.maxDist = 1;
    for (let i = 0; i < n; i++) if (this.dist[i] > this.maxDist) this.maxDist = this.dist[i];
  }

  /** Cached canonical geometry for a prop name. */
  _geo(name, glow = false) {
    const key = (glow ? 'g:' : 's:') + name;
    let g = this._geoCache.get(key);
    if (g === undefined) {
      g = glow ? glowGeo(name, this.colors) : propGeo(name, this.colors);
      this._geoCache.set(key, g);
    }
    return g;
  }

  /** Stamp one copy of a prop into a merge bucket. */
  _emit(bucket, geo, { x = 0, y = 0, z = 0, ry = 0, rx = 0, rz = 0, s = 1, sy = null, tint = 1, hue = null }) {
    if (!geo) return;
    const c = geo.clone();
    _e.set(rx, ry, rz, 'YXZ');
    _q.setFromEuler(_e);
    _p.set(x, y, z);
    _sc.set(s, sy ?? s, s);
    _m.compose(_p, _q, _sc);
    c.applyMatrix4(_m);
    const col = c.attributes.color;
    if (col && (tint !== 1 || hue)) {
      const arr = col.array;
      if (hue) _tint.set(hue);
      for (let i = 0; i < arr.length; i += 3) {
        arr[i] *= tint * (hue ? _tint.r : 1);
        arr[i + 1] *= tint * (hue ? _tint.g : 1);
        arr[i + 2] *= tint * (hue ? _tint.b : 1);
      }
    }
    this._buckets[bucket].push(c);
    this.counts[bucket] = (this.counts[bucket] || 0) + 1;
  }

  /** A textured quad, used for banners, cobwebs and floor decals. */
  _quad(bucket, w, h, tf, uv = null) {
    const g = new THREE.PlaneGeometry(w, h);
    if (uv) {
      const a = g.attributes.uv.array;
      for (let i = 0; i < a.length; i += 2) {
        a[i] = uv.x + a[i] * uv.w;
        a[i + 1] = uv.y + a[i + 1] * uv.h;
      }
    }
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const b = tf.tint ?? 1;
    _tint.set(tf.hue ?? 0xffffff);
    for (let i = 0; i < n; i++) { col[i * 3] = _tint.r * b; col[i * 3 + 1] = _tint.g * b; col[i * 3 + 2] = _tint.b * b; }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    _e.set(tf.rx || 0, tf.ry || 0, tf.rz || 0, 'YXZ');
    _q.setFromEuler(_e);
    _p.set(tf.x || 0, tf.y || 0, tf.z || 0);
    _sc.set(1, 1, 1);
    _m.compose(_p, _q, _sc);
    g.applyMatrix4(_m);
    this._buckets[bucket].push(g);
    this.counts[bucket] = (this.counts[bucket] || 0) + 1;
  }

  // --- placement passes ----------------------------------------------------
  /**
   * Every pass is individually fenced. Decoration is the least important thing in the
   * build and it has twice taken level loading down with it; a pass that throws now costs
   * you a pile of bones, not the level. The same fence wraps `_flush`, so even a bad merge
   * leaves a playable arena behind.
   */
  build() {
    const pass = (name, fn) => {
      try { fn.call(this); }
      catch (e) { console.error(`[world] decor pass "${name}" failed; continuing undecorated for that pass`, e); }
    };
    pass('analyse', this._analyse);
    if (!this.open) return this;          // analysis failed: nothing downstream can run
    pass('columns', this._passColumns);
    pass('floorProps', this._passFloorProps);
    pass('wallFaces', this._passWallFaces);
    pass('wallTops', this._passWallTops);
    pass('decals', this._passDecals);
    pass('arches', this._passArches);
    pass('ceiling', this._passCeiling);
    pass('flush', this._flush);
    return this;
  }

  /**
   * Columns go on convex corners of wall masses inside big rooms. Anchoring them to a
   * corner means half the column is buried in the wall and the walking lane is untouched,
   * which is exactly how a real hall is built.
   */
  _passColumns() {
    const { grid, rng } = this;
    const name = this.recipe.column;
    const geo = this._geo(name);
    const used = [];
    const minSep = 3;
    for (let z = 1; z < grid.h - 1; z++) {
      for (let x = 1; x < grid.w - 1; x++) {
        const i = z * grid.w + x;
        if (!grid.isWalkable(x, z) || this.open[i] < 15) continue;
        // Convex corner: walls on two perpendicular sides.
        const wN = !grid.isWalkable(x, z - 1), wS = !grid.isWalkable(x, z + 1);
        const wW = !grid.isWalkable(x - 1, z), wE = !grid.isWalkable(x + 1, z);
        const nx = wW ? -1 : wE ? 1 : 0;
        const nz = wN ? -1 : wS ? 1 : 0;
        if (!nx || !nz) continue;
        if (this.dist[i] < 0) continue;
        let near = false;
        for (const u of used) if (Math.abs(u[0] - x) + Math.abs(u[1] - z) < minSep) { near = true; break; }
        if (near || !rng.chance(0.55)) continue;
        used.push([x, z]);
        const wx = x * TILE + TILE / 2 + nx * TILE * 0.30;
        const wz = z * TILE + TILE / 2 + nz * TILE * 0.30;
        // Held well under the stone's own value: a free-standing column is a four-metre
        // sunlit cylinder in the middle of the play floor, and at full value it is the
        // brightest thing in frame after the rift — pointed straight at the least
        // interesting object on screen.
        this._emit('solid', geo, { x: wx, z: wz, ry: rng.range(0, 6.283), s: rng.range(0.95, 1.15), tint: rng.range(0.60, 0.80) });
      }
    }
  }

  /**
   * Bulky clutter. Only ever placed in a cell that touches a wall, always shoved into
   * the corner farthest from the walking lane, and never in a cell narrow enough to be
   * a chokepoint (openness gate) — those want to stay legible for the player.
   */
  _passFloorProps() {
    const { grid, rng, recipe } = this;
    const big = recipe.big, small = recipe.small;
    const d = recipe.density;
    for (let z = 0; z < grid.h; z++) {
      for (let x = 0; x < grid.w; x++) {
        const i = z * grid.w + x;
        const cell = grid.cell(x, z);
        if (!cell || !grid.isWalkable(x, z)) continue;
        if (cell.kind === 'rift' || cell.kind === 'spawn') continue;
        if (!this.edge[i]) continue;
        if (this.dist[i] < 0) continue;

        // Which way is the wall? Push the prop that way.
        let nx = 0, nz = 0;
        for (const dir of DIRS) {
          const [dx, dz] = DIR_VEC[dir];
          if (!grid.isWalkable(x + dx, z + dz)) { nx += dx; nz += dz; }
        }
        const len = Math.hypot(nx, nz) || 1;
        nx /= len; nz /= len;

        const wide = this.open[i] >= 14;
        const roll = rng();
        const chance = (wide ? 0.52 : 0.28) * d;
        if (roll > chance) continue;

        const name = wide && rng.chance(0.55) ? rng.pick(big) : rng.pick(small);
        const geo = this._geo(name);
        if (!geo) continue;
        // 0.3 of a tile out from centre keeps the prop's footprint against the wall.
        const push = wide ? 0.30 : 0.36;
        const jitter = wide ? 0.55 : 0.30;
        const wx = x * TILE + TILE / 2 + nx * TILE * push + (rng() - 0.5) * jitter;
        const wz = z * TILE + TILE / 2 + nz * TILE * push + (rng() - 0.5) * jitter;
        const facing = Math.atan2(-nx, -nz);
        this._emit('solid', geo, {
          x: wx, z: wz,
          ry: name === 'weaponRack' || name === 'cart' || name === 'anvil' ? facing + rng.range(-0.2, 0.2) : rng.range(0, 6.283),
          // Chunky. The rig sits 52-68 units back over 4-metre tiles, so a life-size barrel
          // would be under ten pixels; props are authored oversized on purpose.
          s: rng.range(1.3, 1.75),
          tint: rng.range(0.82, 1.12),
        });
        if (name === 'brazier') {
          this._emit('glow', this._geo('flame', true), { x: wx, y: 1.55, z: wz, s: rng.range(0.8, 1.1) });
          this.torchAnchors.push({ x: wx, y: 2.1, z: wz, power: 1.0 });
        }
        if (name === 'heap' && this.theme === 'forge') {
          this._emit('glow', this._geo('vent', true), { x: wx, y: 0, z: wz, s: 0.5, tint: 0.8 });
        }
      }
    }

    // Standalone glow features: crystal clusters and floor vents, sparse and always
    // against a wall so they read as scenery rather than as a trap.
    if (recipe.crystal || recipe.vent) {
      for (let z = 0; z < grid.h; z++) {
        for (let x = 0; x < grid.w; x++) {
          const i = z * grid.w + x;
          if (!grid.isWalkable(x, z) || !this.edge[i] || this.dist[i] < 0) continue;
          const cell = grid.cell(x, z);
          if (cell.kind !== 'floor') continue;
          const wx = x * TILE + TILE / 2, wz = z * TILE + TILE / 2;
          if (recipe.crystal && rng.chance(recipe.crystal)) {
            this._emit('glow', this._geo('crystal', true), { x: wx + rng.range(-1, 1), z: wz + rng.range(-1, 1), ry: rng.range(0, 6.3), s: rng.range(0.7, 1.3) });
            this.torchAnchors.push({ x: wx, y: 1.4, z: wz, power: 0.5, cool: true });
          } else if (recipe.vent && rng.chance(recipe.vent)) {
            this._emit('glow', this._geo('vent', true), { x: wx, z: wz, ry: rng.range(0, 6.3), s: rng.range(0.8, 1.4), tint: 0.9 });
          }
        }
      }
    }
  }

  /**
   * Wall dressing. Every exposed wall face facing a walkable cell is a candidate for a
   * sconce, a banner, a chain or a cobweb. These hang off the face and cost nothing in
   * gameplay terms, but they are what stops a corridor from being a corridor test.
   */
  _passWallFaces() {
    const { grid, rng, recipe } = this;
    // Rotating +Z (the sconce's forward) onto the direction the face looks.
    const faceAngle = { N: Math.PI, E: Math.PI / 2, S: 0, W: -Math.PI / 2 };
    // Fires need breathing room. Rolling per face means an inside corner can light four
    // torches on one cell, which blows out to a single white blob at this camera.
    const lit = new Set();
    const tooClose = (gx, gz) => {
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (lit.has((gz + dz) * grid.w + (gx + dx))) return true;
      return false;
    };
    /**
     * Per-level torch density.
     *
     * Fire is the only thing in the dressing that writes directly into the frame's hot
     * tail, so the number of sconces a level hangs *is* an exposure decision, and one
     * that no tone curve can undo without darkening the level as a whole. Measured across
     * the campaign, the night keep was the outlier: it lit 0.91% of the frame above 240
     * against roughly 0.4% for its neighbours, purely because the keep recipe rolls
     * sconces at 0.55 and that level is wall-dense. `def.torchDensity` thins the roll for
     * exactly that level rather than moving the campaign's exposure to hide it.
     */
    const td = this.def.torchDensity ?? 1;
    for (let z = 0; z < grid.h; z++) {
      for (let x = 0; x < grid.w; x++) {
        const c = grid.cell(x, z);
        if (!c || c.kind !== 'wall') continue;
        for (const dir of DIRS) {
          const [dx, dz] = DIR_VEC[dir];
          const nb = grid.cell(x + dx, z + dz);
          if (!nb || !grid.isWalkable(x + dx, z + dz)) continue;
          if (this.dist[(z + dz) * grid.w + (x + dx)] < 0) continue;
          // Face plane: centre of the wall cell pushed half a tile toward the floor.
          const fx = x * TILE + TILE / 2 + dx * TILE * 0.5;
          const fz = z * TILE + TILE / 2 + dz * TILE * 0.5;
          const ry = faceAngle[dir];

          let roll = rng();
          for (const [what0, p0] of recipe.wall) {
            const what = what0;
            const p = what === 'sconce' ? p0 * td : p0;
            if (roll < p) {
              if (what === 'sconce') {
                if (tooClose(x, z)) break;
                lit.add(z * grid.w + x);
              }
              this._wallProp(what, fx, fz, ry, dx, dz);
              break;
            }
            roll -= p;
          }
        }
      }
    }
  }

  _wallProp(what, fx, fz, ry, dx, dz) {
    const rng = this.rng;
    switch (what) {
      case 'sconce': {
        const y = 2.9 + rng.range(-0.2, 0.3);
        const s = 1.75;
        this._emit('solid', this._geo('sconce'), { x: fx, y, z: fz, ry, s });
        /**
         * Flame scale is held down deliberately. These are additive and they clear the
         * bloom threshold, so an oversized one stops being a flame and becomes a white
         * disc with a sconce under it — the detail in the shells is the whole point.
         *
         * The *spread* matters as much as the mean. A wall of torches all burning at one
         * intensity is a row of identical hot blobs; skewing the roll so most torches are
         * guttering and only a few are roaring gives the same lit wall a value hierarchy
         * and takes a third off the frame's hot tail for free.
         */
        const r = rng();
        const burn = 0.62 + r * r * 0.62;          // skewed low: many small, few large
        this._emit('glow', this._geo('flame', true), {
          x: fx + dx * 0.75, y: y + 1.05, z: fz + dz * 0.75,
          s: 0.72 + burn * 0.34, tint: 0.74 + burn * 0.28,
        });
        this.torchAnchors.push({ x: fx + dx * 1.1, y: y + 1.2, z: fz + dz * 1.1, power: 0.72 + burn * 0.34 });
        break;
      }
      case 'banner': {
        // Hangs from just under the wall cap; 2.6 tall so it never blocks the doorway.
        const h = rng.range(2.4, 3.2), w = 1.5;
        this._quad('cloth', w, h, { x: fx + dx * 0.10, y: CEIL_H - 0.55 - h / 2, z: fz + dz * 0.10, ry, tint: rng.range(0.8, 1.1) });
        this._emit('solid', this._geo('chain'), { x: fx + dx * 0.12, y: CEIL_H - 0.25, z: fz + dz * 0.12, s: 0.5, sy: 0.35, tint: 0.9 });
        break;
      }
      case 'chain': {
        this._emit('solid', this._geo('chain'), { x: fx + dx * 0.3, y: CEIL_H - 0.4, z: fz + dz * 0.3, ry, s: rng.range(0.8, 1.2), tint: rng.range(0.7, 1.0) });
        break;
      }
      case 'web': {
        // Strung across the top corner of the face, angled into the room.
        const s = rng.range(1.1, 1.9);
        this._quad('web', s, s, { x: fx + dx * s * 0.34, y: CEIL_H - 0.2 - s * 0.34, z: fz + dz * s * 0.34, ry, rx: -Math.PI / 4, tint: rng.range(0.7, 1.0) });
        break;
      }
      default: break;
    }
  }

  /**
   * Wall tops. From a fixed 52-degree camera these are a third of the screen, so they get
   * crenellation blocks, rubble and (per theme) snow caps or skulls rather than staying flat.
   */
  _passWallTops() {
    const { grid, rng, recipe } = this;
    const capGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    const merlonColor = this.colors.stone;
    for (let z = 0; z < grid.h; z++) {
      for (let x = 0; x < grid.w; x++) {
        const c = grid.cell(x, z);
        if (!c || c.kind !== 'wall') continue;
        // Only decorate tops that a player can actually see next to open floor.
        let exposed = 0;
        for (let dz = -1; dz <= 1; dz++)
          for (let dx = -1; dx <= 1; dx++)
            if (grid.isWalkable(x + dx, z + dz)) exposed++;
        if (!exposed) continue;
        const cx = x * TILE + TILE / 2, cz = z * TILE + TILE / 2;

        // Merlons: a broken parapet, offset so long walls do not read as a ruler.
        if (((x * 5 + z * 3) % 4 === 0) && rng.chance(0.7)) {
          const n = 2;
          for (let k = 0; k < n; k++) {
            const ox = (rng() - 0.5) * TILE * 0.55, oz = (rng() - 0.5) * TILE * 0.55;
            this._emit('solid', this._geoBox(capGeo), {
              x: cx + ox, y: CEIL_H, z: cz + oz,
              s: rng.range(0.9, 1.5), sy: rng.range(0.35, 0.9), ry: rng.range(0, 6.283),
              tint: rng.range(0.8, 1.05), hue: merlonColor,
            });
          }
        } else if (rng.chance(0.30)) {
          const name = rng.pick(recipe.top);
          this._emit('solid', this._geo(name), {
            x: cx + (rng() - 0.5) * TILE * 0.5, y: CEIL_H, z: cz + (rng() - 0.5) * TILE * 0.5,
            ry: rng.range(0, 6.283), s: rng.range(0.5, 0.95), tint: rng.range(0.8, 1.05),
          });
        }
      }
    }
    this._disposables.push(capGeo);
  }

  /** Wraps a bare primitive so `_emit` can colour it like a prop. */
  _geoBox(geo) {
    if (!geo.attributes.color) {
      const n = geo.attributes.position.count;
      const arr = new Float32Array(n * 3).fill(1);
      geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    return geo;
  }

  /**
   * Floor decals. Cracks, stains, growth and chips, chosen by where you are: soot and
   * blood near the spawns, arcane bleed near the rift, moss/frost in the quiet corners.
   */
  _passDecals() {
    const { grid, rng, recipe } = this;
    const spawnCells = grid.spawns;
    const riftCell = grid.rifts[0];
    for (let z = 0; z < grid.h; z++) {
      for (let x = 0; x < grid.w; x++) {
        const i = z * grid.w + x;
        if (!grid.isWalkable(x, z)) continue;
        if (this.dist[i] < 0) continue;
        if (!rng.chance(0.34)) continue;

        // Bias the decal type by context rather than rolling flat.
        let mix = recipe.decalMix.slice();
        let nearSpawn = 1e9, nearRift = 1e9;
        for (const s of spawnCells) nearSpawn = Math.min(nearSpawn, Math.abs(s.gx - x) + Math.abs(s.gz - z));
        if (riftCell) nearRift = Math.abs(riftCell.gx - x) + Math.abs(riftCell.gz - z);
        if (nearSpawn < 5) { mix = [0.20, 0.52, 0.10, 0.18]; }
        else if (nearRift < 4) { mix = [0.32, 0.10, 0.42, 0.16]; }
        else if (!this.edge[i]) { mix = [0.30, 0.24, 0.12, 0.34]; }

        let roll = rng(), k = 0;
        for (; k < 4; k++) { if (roll < mix[k]) break; roll -= mix[k]; }
        if (k > 3) k = 3;
        const uv = { x: (k % 2) * 0.5, y: ((k / 2) | 0) * 0.5, w: 0.5, h: 0.5 };
        const size = TILE * rng.range(0.75, 1.25);
        this._quad('decal', size, size, {
          x: x * TILE + TILE / 2 + (rng() - 0.5) * TILE * 0.35,
          y: 0.022,
          z: z * TILE + TILE / 2 + (rng() - 0.5) * TILE * 0.35,
          rx: -Math.PI / 2, rz: rng.range(0, 6.283),
          tint: rng.range(0.7, 1.05),
        }, uv);
      }
    }
  }

  /**
   * Arched doorways at every wall gap a route passes through. This is the single biggest
   * readability win in the level: a chokepoint stops being "three tiles of floor" and
   * becomes a door you can see from across the map and choose to defend.
   */
  _passArches() {
    const { grid, rng } = this;
    const acc = new GeoAcc();
    let n = 0;
    for (let z = 1; z < grid.h - 1; z++) {
      for (let x = 1; x < grid.w - 1; x++) {
        const i = z * grid.w + x;
        if (!grid.isWalkable(x, z) || this.dist[i] < 0) continue;
        const wW = !grid.isWalkable(x - 1, z), wE = !grid.isWalkable(x + 1, z);
        const wN = !grid.isWalkable(x, z - 1), wS = !grid.isWalkable(x, z + 1);
        // A doorway is walls on one axis and open floor on the other, with a *change*
        // in openness across it — otherwise every corridor tile would get an arch.
        let axis = null;
        if (wW && wE && !wN && !wS) axis = 'z';
        else if (wN && wS && !wW && !wE) axis = 'x';
        if (!axis) continue;
        const aOpen = axis === 'z' ? this.open[(z - 1) * grid.w + x] : this.open[i - 1];
        const bOpen = axis === 'z' ? this.open[(z + 1) * grid.w + x] : this.open[i + 1];
        if (Math.max(aOpen, bOpen) - Math.min(aOpen, bOpen) < 4) continue;
        if (n > 22) continue;
        n++;
        const cx = x * TILE + TILE / 2, cz = z * TILE + TILE / 2;
        const ry = axis === 'z' ? 0 : Math.PI / 2;
        // Per-doorway value drift. Every arch is built from the same ladder, so without
        // this a corridor of five doorways is one stamp repeated — and a repeated stamp is
        // what makes geometry read as placed rather than as built.
        this._arch(acc, cx, cz, ry, 0.88 + rng() * 0.20);
      }
    }
    if (n) this._buckets.solid.push(acc.build());
  }

  /**
   * One doorway frame: two jambs, a stepped voussoir and a keystone. Everything sits
   * *inside* the wall line and above head height, so the mouth stays wide open — the arch
   * has to mark the door, never narrow it.
   *
   * **Everything here is cut on a value ladder, and nothing on it is at 1.0.** The
   * dressing mesh carries no texture map — one merged vertex-coloured mesh is what makes
   * two hundred props cost one draw call — so an untextured slab has literally nothing in
   * it, and a doorway frame is a lot of slab. At the stone's own value these came out as
   * the brightest non-emissive thing in frame: blank white posts standing on the play
   * floor, pulling the eye off the killbox onto the least interesting object on screen.
   *
   * Three things put material back into it, and they are the same three every other prop
   * in this file already had:
   *
   *  1. **A course every 0.9 units** with its own value, each shaded down toward its own
   *     base (`shadeY`), and a recessed dark bed joint between — a hard shadow line at
   *     every joint instead of one continuous face.
   *  2. **Lit arrises.** A thin bright strip on the outer top edge of alternating courses
   *     and along the crown of each voussoir. This is the only geometry allowed near the
   *     top of the ladder, it is 0.1 units wide, and it is what makes the frame read as
   *     *carved* rather than as extruded.
   *  3. **The wall's own hue** (`archStone`), so the frame sits into the palette rather
   *     than on top of it as a grey object.
   */
  _arch(acc, cx, cz, ry, drift = 1) {
    const s = Math.sin(ry), c = Math.cos(ry);
    const at = (ox, oy, oz) => ({ x: cx + ox * c + oz * s, y: oy, z: cz - ox * s + oz * c });
    const H = CEIL_H - 1.1;
    const base = this.archStone, bDark = this.archDark;
    const V = (k) => shadeHex(base, k * drift);
    const D = (k) => shadeHex(bDark, k * drift);
    for (const side of [-1, 1]) {
      const p = at(side * (TILE * 0.5 - 0.14), 0, 0);
      const N = 5, ch = H / N;
      for (let c2 = 0; c2 < N; c2++) {
        const y0 = (c2 / N) * H;
        // Course value: a repeating but non-periodic ladder, drifting a little lighter
        // with height because the key rakes the upper courses and the lower ones sit in
        // the doorway's own shadow.
        const v = (0.86 + ((c2 * 7 + (side + 1) * 3) % 5) / 5 * 0.28) * (0.84 + 0.16 * (c2 / N));
        const wide = !(c2 & 1);
        const sx = wide ? 0.58 : 0.50, sz = TILE * (wide ? 0.58 : 0.62);
        acc.add(boxGeo(), V(v), { x: p.x, y: y0, z: p.z, sx, sy: ch - 0.16, sz, ry, shadeY: 0.26 });
        // Recessed bed joint: inset on both axes so it reads as a shadow, not a band.
        acc.add(boxGeo(), D(0.72), { x: p.x, y: y0 + ch - 0.16, z: p.z, sx: sx - 0.10, sy: 0.10, sz: sz - 0.10, ry });
        // Lit arris on the outer top edge of every other course.
        if (wide) {
          const lp = at(side * (TILE * 0.5 - 0.14 + sx * 0.5 - 0.05), 0, 0);
          acc.add(boxGeo(), V(1.14), { x: lp.x, y: y0 + ch - 0.30, z: lp.z, sx: 0.10, sy: 0.12, sz: sz * 0.92, ry });
        }
      }
      const cap = at(side * (TILE * 0.5 - 0.14), H, 0);
      acc.add(boxGeo(), V(0.84), { x: cap.x, y: cap.y, z: cap.z, sx: 0.78, sy: 0.26, sz: TILE * 0.78, ry, shadeY: 0.24 });
      acc.add(boxGeo(), V(1.08), { x: cap.x, y: cap.y + 0.26, z: cap.z, sx: 0.60, sy: 0.08, sz: TILE * 0.62, ry });
      // Corbel bracket springing off the jamb toward the middle of the opening.
      const cb = at(side * (TILE * 0.32), H + 0.32, 0);
      acc.add(boxGeo(), V(0.86), { x: cb.x, y: cb.y, z: cb.z, sx: TILE * 0.30, sy: 0.34, sz: TILE * 0.5, ry, rz: -side * 0.32, shadeY: 0.30 });
      acc.add(boxGeo(), D(0.66), { x: cb.x, y: cb.y - 0.08, z: cb.z, sx: TILE * 0.24, sy: 0.10, sz: TILE * 0.42, ry, rz: -side * 0.32 });
    }
    // Voussoir courses, stepped and shrinking, so the top-down silhouette is an arch
    // rather than one flat bar. Alternating values read as separate wedges of stone.
    for (let k = 0; k < 3; k++) {
      const p = at(0, H + 0.62 + k * 0.30, 0);
      const w = TILE * (1.02 - k * 0.13), d = TILE * (0.58 - k * 0.05);
      acc.add(boxGeo(), V(k === 1 ? 0.74 : 0.88 - k * 0.06), { x: p.x, y: p.y, z: p.z, sx: w, sy: 0.24, sz: d, ry, shadeY: 0.28 });
      acc.add(boxGeo(), D(0.70), { x: p.x, y: p.y + 0.24, z: p.z, sx: w - 0.22, sy: 0.06, sz: d - 0.22, ry });
      // Crown arris: the lit edge of the wedge, and the only thing here near the top.
      acc.add(boxGeo(), V(1.12), { x: p.x, y: p.y + 0.24, z: p.z, sx: w * 0.96, sy: 0.07, sz: 0.14, ry });
    }
    const kp = at(0, H + 0.55, 0);
    acc.add(boxGeo(), V(1.00), { x: kp.x, y: kp.y, z: kp.z, sx: 0.9, sy: 0.82, sz: TILE * 0.62, ry, shadeY: 0.30 });
    acc.add(boxGeo(), V(1.24), { x: kp.x, y: kp.y + 0.82, z: kp.z, sx: 0.72, sy: 0.10, sz: TILE * 0.50, ry });
  }

  // --- upper frame ---------------------------------------------------------
  /**
   * Everything above head height. The arenas used to be open-topped dioramas: walls one
   * block tall, nothing over them, and the top third of every frame spent on bare floor
   * or on the flat grey caps of the wall mass. That single fact is the biggest
   * compositional gap between these frames and an *Orcs Must Die!* interior, where a hall
   * always has a ceiling *somewhere* in shot — a vault at the frame edge, a rib crossing
   * the corridor, a chandelier hanging over the killbox — while the killbox floor itself
   * stays completely legible.
   *
   * Three rules keep it from eating the game:
   *
   *  1. **Mass only over non-play cells.** The upper storey is built exclusively on wall
   *     cells with no walkable neighbour in their 3x3 — the nearest floor is a full tile
   *     away, and at this camera a 3-unit riser reaches about 2.3 units up-screen, so it
   *     can never cover a tile an orc can stand on.
   *  2. **Anything crossing the play area springs from the wall cap and arcs *up*.** A rib
   *     never dips below `CEIL_H`, so it is physically above every orc in the game, and it
   *     is a 0.5-unit bar, not a slab: it draws a line across the corridor rather than
   *     roofing it.
   *  3. **Hanging pieces are open frames.** A chandelier is a ring, four chains and some
   *     candles. You can see the floor through it, and it pays its way by adding a real
   *     light anchor over the spot it hangs above.
   */
  _passCeiling() {
    const { grid, rng } = this;
    const acc = new GeoAcc('ceiling');
    /**
     * Upper architecture is the *same* stone as the wall, barely lifted.
     *
     * The temptation is to brighten it — it sits above the wall caps, the key rakes past
     * most of it, and its vertical faces get only the hemisphere. But brightening it is how
     * you get styrofoam: at +30% toward white these read as a row of blank white boxes
     * stacked on the fortress, louder than the play floor and with no material left in
     * them. The black-point problem they used to cause is fixed properly, by the sky-
     * coloured bounce term on the dressing material (see `_flush`), which lifts the faces
     * that receive nothing without touching the ones that are already lit.
     */
    const stone = lighten(this.archStone, 0.06);
    const dark = lighten(this.archDark, 0.10);
    const iron = lighten(this.colors.ironDark, 0.14);
    /** Per-cell value jitter, so a long run of upper storey is never one flat value. */
    const jit = (hex, k) => {
      const m = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
      return (m((hex >> 16) & 255) << 16) | (m((hex >> 8) & 255) << 8) | m(hex & 255);
    };
    const walk = (x, z) => grid.isWalkable(x, z);
    const isWall = (x, z) => grid.cell(x, z)?.kind === 'wall';
    /**
     * May this wall cell grow a second storey?
     *
     * The test is one cell, and it is a proof rather than a taste call. The camera looks
     * down the +Z axis at 50 degrees, so a piece of geometry only ever hides floor that is
     * *north* of it, and it hides a band 0.84 x its height deep. A plain six-unit wall
     * therefore already hides five units — more than the four-unit cell directly north of
     * it. So if the cell to the north is itself a wall, that wall's own occlusion band
     * already covers every floor tile this one could reach, and stacking another four units
     * on top costs the player exactly nothing. If the cell to the north is floor, we do not
     * touch it.
     *
     * That single rule is why this pass can be aggressive at the frame edges — where wall
     * runs are deep — and completely absent around the killbox, where they are one thick.
     */
    const raiseable = (x, z) => isWall(x, z) && isWall(x, z - 1);
    /** A freestanding one-cell block in the middle of a hall — the `pillars` op's output. */
    const freestanding = (x, z) => isWall(x, z)
      && walk(x - 1, z) && walk(x + 1, z) && walk(x, z - 1) && walk(x, z + 1);

    // --- 1. clerestory: a second storey on the deep wall mass -----------------
    // This is what puts real vertical architecture at the edges of the frame. Heights are
    // jittered and roughly one cell in seven is skipped, so a long run reads as a battered
    // upper gallery rather than as one extruded slab.
    let storeys = 0, columns = 0;
    for (let z = 1; z < grid.h - 1; z++) {
      for (let x = 1; x < grid.w - 1; x++) {
        const h = ((x * 73856093) ^ (z * 19349663)) >>> 0;
        const cx = x * TILE + TILE / 2, cz = z * TILE + TILE / 2;

        if (freestanding(x, z)) {
          // Hypostyle columns. A `pillars` grid is the flattest thing in the game from
          // above — a field of identical 6-unit stumps. Growing a slender shaft and a
          // capital out of each one turns it into a colonnade, and because the shaft is
          // narrow it only ever draws a thin bar across the floor rather than roofing it.
          const H = 3.4 + ((h >>> 4) & 7) / 7 * 1.6;
          // Columns keep more of their value than the clerestory does — they are vertical,
          // so the key rakes their sides rather than flooding a top face, and they are the
          // one piece of upper architecture the eye is *meant* to follow down to the floor.
          // But "more value" is not "one value": a 5-metre untextured shaft is a blank
          // white post, so the shaft is cut into drums with a recessed joint between each
          // and a lit arris under the capital.
          const k = (0.88 + ((h >>> 11) & 15) / 15 * 0.22) * 0.80;
          const yaw = ((h >>> 7) & 1) * 0.26;
          acc.add(boxGeo(), jit(dark, k), { x: cx, y: CEIL_H - 0.1, z: cz, sx: 2.0, sy: 0.34, sz: 2.0 });
          acc.add(boxGeo(), jit(stone, k * 1.16), { x: cx, y: CEIL_H + 0.16, z: cz, sx: 1.72, sy: 0.10, sz: 1.72, ry: yaw });
          const DR = 4;
          for (let d = 0; d < DR; d++) {
            const dy = CEIL_H + 0.26 + (d / DR) * H, dh = H / DR;
            const dv = k * (0.90 + ((d * 5 + (h >>> 3)) % 4) / 4 * 0.26);
            acc.add(boxGeo(), jit(stone, dv), { x: cx, y: dy, z: cz, sx: 1.42 - d * 0.05, sy: dh - 0.12, sz: 1.42 - d * 0.05, shadeY: 0.26, ry: yaw });
            acc.add(boxGeo(), jit(dark, k * 0.94), { x: cx, y: dy + dh - 0.12, z: cz, sx: 1.30 - d * 0.05, sy: 0.12, sz: 1.30 - d * 0.05, ry: yaw });
          }
          acc.add(boxGeo(), jit(stone, k * 1.34), { x: cx, y: CEIL_H + 0.20 + H, z: cz, sx: 1.66, sy: 0.12, sz: 1.66, ry: yaw });
          acc.add(boxGeo(), jit(stone, k * 0.94), { x: cx, y: CEIL_H + 0.32 + H, z: cz, sx: 2.1, sy: 0.34, sz: 2.1 });
          acc.add(boxGeo(), jit(dark, k), { x: cx, y: CEIL_H + 0.66 + H, z: cz, sx: 1.55, sy: 0.5, sz: 1.55, shadeY: 0.22 });
          columns++;
          continue;
        }

        if (!raiseable(x, z)) continue;
        if ((h & 3) === 0) continue;                     // broken parapet
        const H = 1.6 + ((h >>> 4) & 7) / 7 * 1.7;
        // Three courses, not one box: a string course flush with the wall below it, the
        // storey set back off that, and a cap that oversails again. Two shadow lines per
        // cell is the difference between an upper gallery and a crate.
        //
        // Note the value. The *top* face of an upper storey takes the key at full strength
        // and has no gameplay on it — the same argument that holds wall caps at CAP_VALUE
        // holds here, and harder, because these sit above everything else in frame. At the
        // stone's own value they came out as a row of white boxes brighter than the play
        // floor, which inverted the whole value hierarchy the tone contract had just fixed.
        const k = (0.86 + ((h >>> 11) & 15) / 15 * 0.26) * 0.64;
        acc.add(boxGeo(), jit(dark, k * 1.05), { x: cx, y: CEIL_H - 0.05, z: cz, sx: TILE + 0.12, sy: 0.44, sz: TILE + 0.12 });
        // Two courses with a set-back band between them, for the same reason the arch jambs
        // are five: an untextured slab this big has nothing in it at all.
        acc.add(boxGeo(), jit(stone, k), { x: cx, y: CEIL_H + 0.39, z: cz, sx: TILE - 0.86, sy: H * 0.52, sz: TILE - 0.86, shadeY: 0.20 });
        acc.add(boxGeo(), jit(dark, k * 1.1), { x: cx, y: CEIL_H + 0.39 + H * 0.52, z: cz, sx: TILE - 1.16, sy: H * 0.14, sz: TILE - 1.16 });
        acc.add(boxGeo(), jit(stone, k * 0.92), { x: cx, y: CEIL_H + 0.39 + H * 0.66, z: cz, sx: TILE - 0.94, sy: H * 0.34, sz: TILE - 0.94 });
        acc.add(boxGeo(), jit(dark, k * 0.9), { x: cx, y: CEIL_H + 0.39 + H, z: cz, sx: TILE - 0.34, sy: 0.30, sz: TILE - 0.34 });
        storeys++;
        // A hanging brazier every so often, out over the drop where the mass meets floor.
        if (((h >>> 9) & 15) === 3 && !isWall(x, z + 1)) {
          this._hanging(acc, cx, CEIL_H + H - 0.2, cz, 0.7, iron, dark, 2.0);
        }
      }
    }

    // --- 2. vault ribs across corridors ---------------------------------------
    // Span is measured off the grid, so a rib always lands exactly wall-cap to wall-cap.
    const span = (x, z, ax) => {
      let a = ax ? x : z, b = a;
      while (walk(ax ? a - 1 : x, ax ? z : a - 1)) a--;
      while (walk(ax ? b + 1 : x, ax ? z : b + 1)) b++;
      return [a, b];
    };
    let ribs = 0;
    for (let z = 1; z < grid.h - 1; z++) {
      for (let x = 1; x < grid.w - 1; x++) {
        if (!walk(x, z) || this.dist[z * grid.w + x] < 0) continue;
        const c = grid.cell(x, z);
        if (c.flags.has('chokepoint')) continue;         // never clutter the killbox
        const [x0, x1] = span(x, z, true);
        const [z0, z1] = span(x, z, false);
        const wX = x1 - x0 + 1, wZ = z1 - z0 + 1;
        // A corridor: short across, long along. Ribs go across the short axis, spaced out
        // along the long one, and only from the *first* cell of the span so one rib is
        // emitted per row rather than one per cell.
        let axis = null;
        if (wX <= 5 && wZ >= wX + 3 && x === x0) axis = 'x';
        else if (wZ <= 5 && wX >= wZ + 3 && z === z0) axis = 'z';
        if (!axis) continue;
        const along = axis === 'x' ? z : x;
        if (along % 4 !== 1) continue;
        if (!rng.chance(0.82)) continue;
        if (ribs > 46) continue;
        ribs++;
        const drift = 0.88 + rng() * 0.20;   // no two ribs in a run at the same value
        if (axis === 'x') this._rib(acc, x0 * TILE, (x1 + 1) * TILE, z * TILE + TILE / 2, true, drift);
        else this._rib(acc, z0 * TILE, (z1 + 1) * TILE, x * TILE + TILE / 2, false, drift);
      }
    }

    // --- 3. chandeliers over the big halls -------------------------------------
    // Deliberately few and deliberately open. Placed on the most open cells in the level,
    // far apart, never on the rift, a spawn or a declared killbox.
    const cands = [];
    for (let z = 2; z < grid.h - 2; z++) {
      for (let x = 2; x < grid.w - 2; x++) {
        const i = z * grid.w + x;
        if (!walk(x, z) || this.dist[i] < 0) continue;
        const c = grid.cell(x, z);
        if (c.kind !== 'floor' || c.flags.has('chokepoint')) continue;
        if (this.open[i] < 22) continue;
        cands.push([this.open[i], x, z]);
      }
    }
    cands.sort((a, b) => b[0] - a[0]);
    const hung = [];
    for (const [, x, z] of cands) {
      if (hung.length >= 4) break;
      let ok = true;
      for (const [hx, hz] of hung) if (Math.abs(hx - x) + Math.abs(hz - z) < 9) { ok = false; break; }
      if (!ok) continue;
      hung.push([x, z]);
      // Ring at 5.2 — under the wall caps, so it reads as hanging *inside* a hall, but
      // still comfortably clear of the tallest thing in the roster.
      this._hanging(acc, x * TILE + TILE / 2, CEIL_H + 4.2, z * TILE + TILE / 2, 1.35, iron, dark, 5.0);
    }

    if (storeys || ribs || columns || hung.length) this._buckets.solid.push(acc.build());
    this.counts.ceiling = storeys + ribs + columns + hung.length;
  }

  /**
   * One transverse vault rib. Seven stepped voussoirs following a shallow parabola from
   * one wall cap to the other, plus a springer corbel at each end so it visibly *lands* on
   * the wall instead of floating over it. Lowest point is exactly `CEIL_H`.
   */
  _rib(acc, a0, a1, cross, alongX, drift = 1) {
    const W = (a1 - a0) / 2, mid = (a0 + a1) / 2;
    const RISE = Math.min(2.2, 0.42 + W * 0.20);
    const N = 7;
    const V = (k) => shadeHex(this.archStone, k * drift);
    const D = (k) => shadeHex(this.archDark, k * drift);
    for (let k = 0; k < N; k++) {
      const u = ((k + 0.5) / N) * 2 - 1;
      const pos = mid + u * W;
      const y = CEIL_H + RISE * (1 - u * u);
      const slope = Math.atan2(-2 * RISE * u / W, 1);
      const seg = (2 * W / N) * 1.14;
      /**
       * A rib is the highest geometry in the level and its top face takes the key at full
       * strength with no gameplay under it, so it is the piece most able to become a
       * white bar drawn across the frame — which is exactly what it was. Held on the same
       * ladder as the clerestory, with a per-wedge value so seven voussoirs read as seven
       * stones, and its own lit arris along the crown so the *edge* carries the highlight
       * instead of the whole face.
       */
      const v = 0.84 + ((k * 5) % 3) / 2 * 0.17;
      const t = { y: y - 0.16, sy: 0.40 };
      const lip = { y: y + 0.24, sy: 0.09 };
      const bed = { y: y - 0.22, sy: 0.07 };
      if (alongX) {
        t.x = lip.x = bed.x = pos; t.z = lip.z = bed.z = cross;
        t.sx = seg; t.sz = 1.05; t.rz = slope;
        lip.sx = seg * 0.90; lip.sz = 0.34; lip.rz = slope;
        bed.sx = seg * 0.96; bed.sz = 0.80; bed.rz = slope;
      } else {
        t.z = lip.z = bed.z = pos; t.x = lip.x = bed.x = cross;
        t.sz = seg; t.sx = 1.05; t.rx = -slope;
        lip.sz = seg * 0.90; lip.sx = 0.34; lip.rx = -slope;
        bed.sz = seg * 0.96; bed.sx = 0.80; bed.rx = -slope;
      }
      acc.add(boxGeo(), V(k === (N >> 1) ? v * 0.82 : v), { ...t, shadeY: 0.34 });
      acc.add(boxGeo(), D(0.74), bed);                       // shadowed underside chamfer
      acc.add(boxGeo(), V(k === (N >> 1) ? 1.22 : 1.04), lip);  // lit crown, keystone brightest
    }
    // Springers: the block the arc rests on, sitting on the wall cap at each end.
    for (const s of [-1, 1]) {
      const pos = mid + s * (W + 0.5);
      const t = { y: CEIL_H - 0.5, sy: 1.05, shadeY: 0.28 };
      const cap = { y: CEIL_H + 0.55, sy: 0.12 };
      if (alongX) {
        t.x = cap.x = pos; t.z = cap.z = cross;
        t.sx = 1.5; t.sz = 1.5; cap.sx = 1.16; cap.sz = 1.16;
      } else {
        t.z = cap.z = pos; t.x = cap.x = cross;
        t.sz = 1.5; t.sx = 1.5; cap.sz = 1.16; cap.sx = 1.16;
      }
      acc.add(boxGeo(), D(0.94), t);
      acc.add(boxGeo(), V(0.92), cap);
    }
  }

  /**
   * A hanging light: four chains, an octagonal iron ring and candles. The ring is drawn as
   * eight tangential bars with a hole in the middle — you read the floor straight through
   * it, which is the whole reason it is allowed to hang over a play area at all.
   *
   * It also registers a torch anchor, so the thing it hangs over gets a genuine pool of
   * light on the floor rather than just a silhouette in the air.
   */
  _hanging(acc, x, yTop, z, s, iron, dark, drop) {
    const R = 1.45 * s;
    const yr = yTop - drop;                      // ring height
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      acc.add(boxGeo(), dark, {
        x: x + Math.cos(a) * R * 0.5, y: yr, z: z + Math.sin(a) * R * 0.5,
        sx: 0.10, sy: drop, sz: 0.10, rx: Math.sin(a) * 0.24, rz: -Math.cos(a) * 0.24,
      });
    }
    const N = 8;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      acc.add(boxGeo(), iron, {
        x: x + Math.cos(a) * R, y: yr, z: z + Math.sin(a) * R,
        sx: R * 0.86, sy: 0.24, sz: 0.20, ry: -a + Math.PI / 2,
      });
      if (i % 2 === 0) {
        acc.add(boxGeo(), dark, {
          x: x + Math.cos(a) * R, y: yr + 0.24, z: z + Math.sin(a) * R,
          sx: 0.20, sy: 0.5 * s, sz: 0.20,
        });
        this._emit('glow', this._geo('flame', true), {
          x: x + Math.cos(a) * R, y: yr + 0.24 + 0.5 * s, z: z + Math.sin(a) * R, s: 0.62 * s,
        });
      }
    }
    this.torchAnchors.push({ x, y: yr, z, power: 0.95 * s });
  }

  // --- flush ---------------------------------------------------------------
  _flush() {
    const mk = (name, parts, mat) => {
      if (!parts.length) return null;
      const geo = mergeGeometries(parts, false);
      for (const p of parts) p.dispose();
      parts.length = 0;
      if (!geo) return null;
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mat);
      mesh.name = 'decor-' + name;
      this.root.add(mesh);
      this._disposables.push(geo, mat);
      return mesh;
    };

    /**
     * A bounce floor, standing in for the light a hemisphere cannot deliver.
     *
     * A `HemisphereLight` only lights a face by how far its normal points *up*, and the
     * key and fill are two opposed directional lights — so any vertical face that points
     * away from the key and is not reached by the fill receives, exactly, nothing. On the
     * dressed levels that is a lot of geometry: props shadowing props, and the upper storey
     * shadowing itself along a run. Measured on Frostwatch, the dressing mesh alone
     * accounted for 5.4 of the frame's 6.1% pure-black pixels, and turning the key's shadow
     * off took it to 0.5 — the black was shadow, not exposure.
     *
     * The honest fix is a bounce term, and the honest colour for it is the sky, because
     * that is what the bounce would be coming off. Held low enough that nothing reads as
     * emissive; high enough that no face in the level can reach zero.
     */
    // `bounceGain` is the tone contract's black-point guard: it is the reciprocal of most
    // of the campaign's exposure move, so this term stays near constant in absolute terms
    // whether the level is a snowfield or a basalt crypt. Without it, giving the campaign a
    // real brightness ladder would have put the bottom three rungs straight back into the
    // crushed-black failure the ladder's predecessor was written to fix.
    const bounce = new THREE.Color(this.pal.sky ?? 0x5a6a8c)
      .multiplyScalar(0.36 * (this.pal.bounceGain ?? 1));
    this.solidMesh = mk('solid', this._buckets.solid, new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.86, metalness: 0.06,
      emissive: bounce, emissiveIntensity: 1,
    }));
    if (this.solidMesh) { this.solidMesh.castShadow = true; this.solidMesh.receiveShadow = true; }

    this.glowMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: true,
    });
    this.glowMesh = mk('glow', this._buckets.glow, this.glowMat);
    if (this.glowMesh) this.glowMesh.renderOrder = 3;

    const bTex = bannerTex(this.pal);
    this.clothMesh = mk('cloth', this._buckets.cloth, new THREE.MeshStandardMaterial({
      map: bTex, vertexColors: true, transparent: true, alphaTest: 0.35,
      side: THREE.DoubleSide, roughness: 0.95, metalness: 0,
    }));
    if (this.clothMesh) this.clothMesh.castShadow = false;

    this.webMesh = mk('web', this._buckets.web, new THREE.MeshBasicMaterial({
      map: webTex(), vertexColors: true, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide, depthWrite: false,
    }));
    if (this.webMesh) this.webMesh.renderOrder = 2;

    this.decalMesh = mk('decal', this._buckets.decal, new THREE.MeshStandardMaterial({
      map: decalAtlas(this.pal), vertexColors: true, transparent: true,
      roughness: 1, metalness: 0, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }));
    if (this.decalMesh) this.decalMesh.renderOrder = 1;
  }

  /** Flames and crystals breathe together; per-object flicker would cost a draw call each. */
  update(dt, t) {
    if (this.glowMat) {
      const f = 0.86 + 0.10 * Math.sin(t * 9.3) + 0.06 * Math.sin(t * 21.7 + 1.3);
      this.glowMat.color.setScalar(f);
    }
  }

  dispose() {
    for (const g of this._geoCache.values()) g?.dispose?.();
    this._geoCache.clear();
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
    this.root.parent?.remove(this.root);
  }
}

/** Scale a hex's value. Used to hold sunlit upper stone under the play floor. */
function shadeHex(hex, k) {
  const m = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (m((hex >> 16) & 255) << 16) | (m((hex >> 8) & 255) << 8) | m(hex & 255);
}

/** Palettes carry colours as either `0xrrggbb` or `'#rrggbb'`; normalise to a number. */
function hexOf(v, fallback = 0x6a6258) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') { const n = parseInt(v.replace('#', ''), 16); return Number.isFinite(n) ? n : fallback; }
  return fallback;
}

/** Mix two hexes in sRGB byte space. Good enough for tinting one substance toward another. */
function mixHex(a, b, t) {
  const m = (s, d) => Math.round(s + (d - s) * t);
  return (m((a >> 16) & 255, (b >> 16) & 255) << 16)
    | (m((a >> 8) & 255, (b >> 8) & 255) << 8)
    | m(a & 255, b & 255);
}

/** Mix a hex toward white. Used to hold the upper-frame stone above the wall value. */
function lighten(hex, t) {
  const r = (hex >> 16) & 255, g = (hex >> 8) & 255, b = hex & 255;
  const m = (v) => Math.round(v + (255 - v) * t);
  return (m(r) << 16) | (m(g) << 8) | m(b);
}

// A module-level unit box for the arch builder (GeoAcc clones what it is given).
let _boxGeo = null;
function boxGeo() {
  if (!_boxGeo) _boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  return _boxGeo;
}
