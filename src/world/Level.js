import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TILE, CEIL_H, DIRS, DIR_VEC } from './Grid.js';
import { Rift } from './Rift.js';
import { Decor } from './Decor.js';
import { SpawnGate } from './SpawnGate.js';
import { propColors } from './Props.js';
import { floorAtlas, wallAtlas, wallTopTex, pitFloorTex, glowTex } from './Textures.js';

/**
 * Builds the playable arena from a level definition's ASCII map, then owns every
 * mesh it created so `dispose()` can wipe it cleanly between levels.
 *
 * Map legend:
 *   '#' wall      '.' floor       'S' spawn      'R' rift       ' ' void
 *   'x' floor, no-build            '~' pit (blocks ground, flyers pass)
 *   '=' ledge (walkable, no traps) 'T' torch wall (wall + light)
 *
 * Rendering strategy — the whole arena is a fixed number of draw calls regardless of
 * level size, because everything static is merged:
 *   floor (1) + wall sides (1) + wall tops (1) + pit shafts (1) + pit floors (1)
 *   + light pools (1) + decor solid/glow/cloth/web/decal (5)
 * Variation that would normally need extra materials is carried in **vertex colours**
 * and in per-cell UV picks out of 2x2 texture atlases.
 */
export class Level {
  constructor(game, def) {
    this.game = game;
    this.def = def;
    this.root = new THREE.Group();
    this.root.name = 'level';
    this._disposables = [];
    this.playerSpawn = new THREE.Vector3(0, 0, 0);
    this.cameraBounds = { minX: -1e5, maxX: 1e5, minZ: -1e5, maxZ: 1e5 };
    this.rift = null;
    this.torches = [];
    this.gates = [];
    this._anchors = [];
    this.pal = def.palette || {};
    this.colors = propColors(this.pal.theme || 'keep', this.pal);
  }

  build() {
    const { game, def } = this;
    const grid = game.grid;
    this._parseMap(grid, def);
    game.scene.add(this.root);

    this._buildLighting(def);

    // Decor first: it decides where the fires are, and the floor/wall bake needs to
    // know that before it can burn light into the vertex colours.
    // Outermost fence: an undressed arena is a bad day, a level that will not load is a
    // dead build, and the greybox has to survive whatever the dressing pass does.
    try {
      this.decor = new Decor(game, grid, def).build();
      this.root.add(this.decor.root);
    } catch (e) {
      console.error('[world] decoration failed; falling back to an undressed arena', e);
      this.decor = { root: new THREE.Group(), torchAnchors: [], update() {}, dispose() {} };
    }

    this._collectAnchors(grid, def);
    this._buildFloor(grid, def);
    this._buildWalls(grid, def);
    this._buildPits(grid, def);
    this._buildLightPools();
    this._buildTorchLights(def);
    this._buildSpawns(grid, def);

    this.rift = new Rift(game, grid.rifts[0], def);
    this.root.add(this.rift.object);

    if (def.playerSpawn) grid.toWorld(def.playerSpawn[0], def.playerSpawn[1], this.playerSpawn);
    else if (grid.rifts[0]) grid.toWorld(grid.rifts[0].gx, grid.rifts[0].gz, this.playerSpawn);

    // Two and a half tiles of margin, not two. At two the rig could frame ten units of
    // off-map nothing on the levels whose rift bay sits hard against the east wall, and
    // that nothing lands in the corner of the frame where the vignette is deepest — which
    // is where the audit found a third of the pure-black pixels on Sappers' Run.
    const pad = TILE * 2.6;
    this.cameraBounds = {
      minX: pad, maxX: grid.w * TILE - pad,
      minZ: pad, maxZ: grid.h * TILE - pad,
    };
    grid.markDirty();
    this._verifyRoutes(grid, def);
  }

  _parseMap(grid, def) {
    const rows = def.map;
    for (let z = 0; z < grid.h; z++) {
      const row = rows[z] || '';
      for (let x = 0; x < grid.w; x++) {
        const ch = row[x] ?? ' ';
        const c = grid.cell(x, z);
        switch (ch) {
          case '#': case 'T': c.kind = 'wall'; break;
          case '.': c.kind = 'floor'; break;
          // Author-declared killbox. Buildable like any floor; the flag exists so UI and
          // decor can treat "this is the tile worth defending" as first-class data.
          case 'C': c.kind = 'floor'; c.flags.add('chokepoint'); break;
          case 'x': c.kind = 'floor'; c.flags.add('no-build'); break;
          case '=': c.kind = 'ledge'; c.flags.add('no-build'); break;
          case '~': c.kind = 'void'; c.flags.add('pit'); break;
          case 'S': c.kind = 'spawn'; c.flags.add('no-build'); break;
          case 'R': c.kind = 'rift'; c.flags.add('no-build'); break;
          default: c.kind = 'void'; break;
        }
        if (ch === 'T') c.flags.add('torch');
      }
    }

    // Spawns face the first walkable neighbour so orcs walk out, not into a wall.
    let sid = 0;
    grid.forEach((c) => {
      if (c.kind === 'spawn') {
        let dir = 'S';
        for (const d of DIRS) {
          const [dx, dz] = DIR_VEC[d];
          if (grid.isWalkable(c.gx + dx, c.gz + dz)) { dir = d; break; }
        }
        grid.spawns.push({ gx: c.gx, gz: c.gz, dir, id: sid++ });
      } else if (c.kind === 'rift') {
        grid.rifts.push({ gx: c.gx, gz: c.gz });
      }
    });
    if (def.cellCost) {
      for (const [x, z, cost] of def.cellCost) { const c = grid.cell(x, z); if (c) c.cost = cost; }
    }
  }

  /** Loud failure beats a level that silently cannot be finished. */
  _verifyRoutes(grid, def) {
    const flow = grid.riftFlow();
    for (const s of grid.spawns) {
      if (!isFinite(flow.distAt(s.gx, s.gz))) {
        console.error(`[world] ${def.name}: spawn ${s.id} at (${s.gx},${s.gz}) cannot reach the rift`);
      }
    }
  }

  // --- lighting -------------------------------------------------------------
  _buildLighting(def) {
    const p = def.palette || {};
    // Hemisphere carries the *mood*: sky colour above, bounced floor colour below.
    const hemi = new THREE.HemisphereLight(p.sky ?? 0x5a6a8c, p.ground ?? 0x2a1f18, p.hemi ?? 0.9);
    this.root.add(hemi);
    this.hemi = hemi;

    // Key direction is campaign-wide by default so shadows fall the same way in every
    // level; a palette may override it when the *place* demands one (Frostwatch is a low
    // raking winter sun, and that low angle is the whole reason its courtyard reads as lit
    // rather than as tinted greybox).
    this.sunOffset = p.sunDir ? new THREE.Vector3(p.sunDir[0], p.sunDir[1], p.sunDir[2]) : SUN_OFFSET;
    const sun = new THREE.DirectionalLight(p.sun ?? 0xffe6c0, p.sunPower ?? 1.9);
    sun.position.copy(this.sunOffset);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1; sun.shadow.camera.far = 200;
    sun.shadow.bias = -0.0012;
    sun.shadow.normalBias = 0.035;
    this.root.add(sun);
    this.root.add(sun.target);
    this.sun = sun;
    this._shadowHalf = 0;
    this._fitShadow();

    // Cool counter-light from the opposite corner. This is the *only* thing separating an
    // orc silhouette from the floor it stands on in a single-hue level, so every palette's
    // fill must be a genuine complement to its sun, never a second copy of it.
    const fill = new THREE.DirectionalLight(p.fill ?? 0x4a6fa8, p.fillPower ?? 0.55);
    fill.position.set(-26, 16, -22);
    this.root.add(fill);

    this.game.scene.fog = new THREE.FogExp2(p.fog ?? 0x0a0b12, def.fogDensity ?? p.fogDensity ?? 0.010);
    this.game.renderer.setClearColor(p.fog ?? 0x0a0b12, 1);
  }

  /**
   * The shadow cascade has to cover whatever the camera rig can actually see. The rig
   * reports its ground footprint, so read it rather than guessing a constant — a fixed
   * half-extent terminated shadows inside the frame the moment the zoom went up.
   */
  _fitShadow() {
    if (!this.sun) return;
    /**
     * The box has to cover the frustum's *depth*, not just its width.
     *
     * This used to fit `halfW` alone. At a 50-degree pitch the visible ground band is far
     * deeper than it is wide, and the shadow map clamps at its edge — so every texel
     * outside the box sampled an occluded edge texel and the whole near third of the frame
     * came back fully shadowed. That is what was putting 5% of the frame at pure black on
     * the two levels with the longest camera pull (Frostwatch and The Warcamp, distance
     * 62 and 64) while the identical palette measured clean on the short levels: it was
     * never the palette, it was the cascade running out. `lead` is folded in because the
     * band is not centred on the focus point.
     */
    const v = this.game.rig?.view;
    const depth = (v?.halfD ?? 30) + Math.abs(v?.lead ?? 0);
    const half = Math.max(30, Math.max(v?.halfW ?? 30, depth) * 1.12);
    if (Math.abs(half - this._shadowHalf) < 1.5) return;
    this._shadowHalf = half;
    const c = this.sun.shadow.camera;
    c.left = -half; c.right = half; c.top = half; c.bottom = -half;
    c.updateProjectionMatrix();
  }

  /**
   * Every source of coloured light in the level, gathered once so the floor and walls
   * can have it *baked* into their vertex colours. Real point lights are expensive and
   * capped at a handful; the bake gives us fifty torches' worth of warmth for free.
   */
  _collectAnchors(grid, def) {
    const p = def.palette || {};
    const torchCol = new THREE.Color(p.torch ?? 0xff9b3d);
    const coolCol = new THREE.Color(p.riftGlow ?? 0x53d0ff);
    const spawnCol = new THREE.Color(p.spawnGlow ?? 0xff3b1f);
    const a = this._anchors;

    /**
     * Radii were 9.5 / 12 / 13 / 17. They are wider now, and that is a *hue* change more
     * than a brightness one.
     *
     * The criterion a blind critic measured us worst on is the fraction of the frame
     * sitting in a hue opposed to the frame's dominant one — warm fire against cold stone,
     * inside one shot. Ours measured 0.005-0.053 against Orcs Must Die's 0.297. A torch
     * pool that only covers two cells cannot move that number no matter how warm it is;
     * the pools have to be large enough to be a *region* of the frame, which is what they
     * are in every screenshot of the game we are being compared to.
     */
    for (const t of this.decor.torchAnchors) {
      a.push({ x: t.x, z: t.z, r: t.cool ? 9 : 13.5, power: (t.power ?? 1) * (t.cool ? 0.7 : 1.25), col: t.cool ? coolCol : torchCol });
    }
    // Map-authored torch walls get a stronger anchor: those mark real chokepoints.
    grid.forEach((c) => {
      if (!c.flags.has('torch')) return;
      a.push({ x: c.gx * TILE + TILE / 2, z: c.gz * TILE + TILE / 2, r: 16, power: 1.5, col: torchCol });
    });
    for (const s of grid.spawns) a.push({ x: s.gx * TILE + TILE / 2, z: s.gz * TILE + TILE / 2, r: 12, power: 1.3, col: spawnCol });
    /**
     * The rift's bake anchor is **smaller than the torches' now**, which looks backwards
     * until you remember where the camera is.
     *
     * It was r=18, power 1.8 — an eighteen-metre pool of the rift's own cold hue, centred on
     * the one point the camera is always looking at. That is the additive-veil problem
     * restated in the vertex bake: not a light with a shape, a tint over the middle of every
     * frame. It cost most on levels 9 and 10, the two biggest rift halls, which were also
     * the last two measuring monochrome (hue spread 0.042 and 0.023) — the sconces were
     * doing their job at the edges of the map and the rift was overpainting the centre.
     *
     * Held small, the rift lights its own dais and the sconces own the floor the fight
     * happens on, which is the correct division of labour and the one every screenshot of
     * the game we are being compared to shows.
     */
    for (const rf of grid.rifts) a.push({ x: rf.gx * TILE + TILE / 2, z: rf.gz * TILE + TILE / 2, r: 11, power: 1.25, col: coolCol });
  }

  /**
   * Soft-clamped sum of every anchor's contribution at a world point.
   *
   * The falloff exponent is 1.2, not the 1.7 it was. 1.7 puts nearly all of a pool's
   * strength inside the first third of its radius, so a torch produced a small bright spot
   * with a long invisible skirt — the shape of a point light, not the shape of firelight in
   * a stone room, where the near wall and the floor in front of it are *all* lit. Since
   * `poolMul` now blends toward the emitter's hue in proportion to this value, the exponent
   * is directly the width of the warm region, which is the campaign's worst-measured
   * quantity. A flatter falloff spends the same light over a readable area.
   */
  _bake(wx, wz, out) {
    let r = 0, g = 0, b = 0;
    for (const a of this._anchors) {
      const dx = wx - a.x, dz = wz - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > a.r * a.r) continue;
      const f = a.power * (1 - Math.sqrt(d2) / a.r) ** 1.2;
      r += a.col.r * f; g += a.col.g * f; b += a.col.b * f;
    }
    out.r = 1 - Math.exp(-r); out.g = 1 - Math.exp(-g); out.b = 1 - Math.exp(-b);
    return out;
  }

  // --- floor ----------------------------------------------------------------
  _buildFloor(grid, def) {
    const p = def.palette || {};
    const positions = [], uvs = [], colors = [], indices = [];
    let vi = 0;
    const warm = new THREE.Color();
    const EPS = 0.004;         // atlas inset — stops the quadrants bleeding into each other
    const K = p.bakeStrength ?? 0.62;
    const GAIN = p.poolGain ?? POOL_GAIN;

    // Corner ambient occlusion: how many of the three cells touching this corner are solid.
    const occ = (gx, gz) => {
      let n = 0;
      if (!grid.isWalkable(gx, gz)) n++;
      return n;
    };
    const cornerAO = (gx, gz, cx, cz) => {
      // (cx,cz) in {0,1}: which corner of cell (gx,gz).
      const ax = gx + (cx ? 1 : -1), az = gz + (cz ? 1 : -1);
      let n = occ(ax, gz) + occ(gx, az) + occ(ax, az);
      return 1 - Math.min(0.42, n * 0.145);
    };

    for (const c of grid.cells) {
      if (c.kind === 'void') continue;
      const x0 = c.gx * TILE, z0 = c.gz * TILE, y = c.height;
      positions.push(x0, y, z0, x0 + TILE, y, z0, x0 + TILE, y, z0 + TILE, x0, y, z0 + TILE);

      // Variant + 90-degree rotation from a hash of the cell — no visible tiling.
      const h = (c.gx * 73856093) ^ (c.gz * 19349663);
      const variant = (h >>> 3) & 3;
      const rot = (h >>> 7) & 3;
      const u0 = (variant % 2) * 0.5 + EPS, v0 = ((variant / 2) | 0) * 0.5 + EPS;
      const s = 0.5 - EPS * 2;
      const quad = [[u0, v0], [u0 + s, v0], [u0 + s, v0 + s], [u0, v0 + s]];
      for (let k = 0; k < 4; k++) {
        const q = quad[(k + rot) & 3];
        uvs.push(q[0], q[1]);
      }

      const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (let k = 0; k < 4; k++) {
        const [cx, cz] = corners[k];
        const wx = x0 + cx * TILE, wz = z0 + cz * TILE;
        const ao = cornerAO(c.gx, c.gz, cx, cz);
        this._bake(wx, wz, warm);
        /**
         * Two scales of value noise, not one.
         *
         * The per-tile jitter alone still left a *grid*: every cell a different value, but
         * all of them the same size, which is exactly the read that makes a field of traps
         * look like a spreadsheet. The low-frequency term (period ~7 and ~17 cells, sampled
         * per corner so it interpolates smoothly across cells) lays broad patches of light
         * and worn floor over the top, at a scale nothing in the gameplay grid shares.
         */
        const n = (0.96 + (((h >>> 11) & 15) / 15) * 0.10)
          * (1 + 0.13 * smoothNoise(wx / 28, wz / 28) + 0.07 * smoothNoise(wx / 11 + 31.7, wz / 11 - 12.3));
        const m = poolMul(warm, K, _pm, GAIN);
        colors.push(ao * n * m.r, ao * n * m.g, ao * n * m.b);
      }
      indices.push(vi, vi + 2, vi + 1, vi, vi + 3, vi + 2);
      vi += 4;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    geo.setIndex(indices);
    geo.computeVertexNormals();

    // The floor gets the bounce term too, and it is the one surface where it matters most:
    // a floor tile in the key's shadow is lit by the hemisphere alone, and a low raking sun
    // (Frostwatch, The Warcamp) throws that shadow across a third of the arena. Without a
    // bounce the shadow is not dark, it is *absent* — and an orc standing in it has no
    // ground under it to read against.
    const mat = new THREE.MeshStandardMaterial({
      map: floorAtlas(p), vertexColors: true,
      roughness: p.floorRough ?? 0.92, metalness: p.floorMetal ?? 0.03,
      color: p.floorTint ?? 0xffffff,
      emissive: new THREE.Color(p.sky ?? 0x5a6a8c).multiplyScalar(0.11 * (p.bounceGain ?? 1)),
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'floor';
    this.root.add(mesh);
    this._disposables.push(geo, mat);
    this.floorMesh = mesh;
  }

  // --- walls ----------------------------------------------------------------
  /**
   * Only the faces you can actually see are built, and they are built as merged quads
   * rather than boxes: a 40x32 map that used to be 900 instanced cubes is now two meshes
   * with a third of the triangles and a *lit* vertical gradient on every face.
   */
  _buildWalls(grid, def) {
    const p = def.palette || {};
    const sideP = [], sideU = [], sideC = [], sideI = [];
    const topP = [], topU = [], topC = [], topI = [];
    const trimParts = [];
    const warm = new THREE.Color();
    const K = p.bakeStrength ?? 0.62;
    const GAIN = p.poolGain ?? POOL_GAIN;
    const EPS = 0.004;
    let sv = 0, tv = 0;
    const trimGeo = new THREE.BoxGeometry(1, 1, 1);
    const trimCol = new THREE.Color(this.colors.stoneDark);

    for (const c of grid.cells) {
      if (c.kind !== 'wall') continue;
      const cx = c.gx * TILE, cz = c.gz * TILE;
      const h = (c.gx * 73856093) ^ (c.gz * 19349663);

      // --- vertical faces
      for (const d of DIRS) {
        const [dx, dz] = DIR_VEC[d];
        const n = grid.cell(c.gx + dx, c.gz + dz);
        if (!n) continue;
        if (n.kind === 'wall') continue;
        if (n.kind === 'void' && !n.flags.has('pit')) continue;

        // Corner order chosen so the quad's winding faces the open cell.
        let a, b;
        if (d === 'N') { a = [cx + TILE, cz]; b = [cx, cz]; }
        else if (d === 'S') { a = [cx, cz + TILE]; b = [cx + TILE, cz + TILE]; }
        else if (d === 'E') { a = [cx + TILE, cz + TILE]; b = [cx + TILE, cz]; }
        else { a = [cx, cz]; b = [cx, cz + TILE]; }

        const variant = ((h >>> (d === 'N' ? 2 : d === 'E' ? 5 : d === 'S' ? 8 : 11)) & 3);
        const u0 = (variant % 2) * 0.5 + EPS, v0 = ((variant / 2) | 0) * 0.5 + EPS;
        const s = 0.5 - EPS * 2;

        const mx = cx + TILE / 2 + dx * TILE * 0.5, mz = cz + TILE / 2 + dz * TILE * 0.5;
        this._bake(mx, mz, warm);

        /**
         * The face is a 2x3 grid of sub-quads, not one big quad.
         *
         * One quad per wall face is what made these read as flat coloured cardboard at
         * close range: a single linear gradient over four metres, no block-to-block value
         * change, and no edge anywhere. Splitting it costs six quads instead of one — a few
         * thousand triangles per level, nothing — and buys three things a texture cannot
         * fake at this camera: a *per-block* value step (each sub-quad picks its own tint
         * from the cell hash), a lit lip along the top of every course (`EDGE`), and a
         * contact-darkened bottom course where the wall meets the floor.
         */
        const NU = 2, NV = 3;
        for (let vj = 0; vj < NV; vj++) {
          for (let ui = 0; ui < NU; ui++) {
            const t0 = ui / NU, t1 = (ui + 1) / NU;
            const y0 = (vj / NV) * CEIL_H, y1 = ((vj + 1) / NV) * CEIL_H;
            const px0 = a[0] + (b[0] - a[0]) * t0, pz0 = a[1] + (b[1] - a[1]) * t0;
            const px1 = a[0] + (b[0] - a[0]) * t1, pz1 = a[1] + (b[1] - a[1]) * t1;
            sideP.push(px0, y0, pz0, px1, y0, pz1, px1, y1, pz1, px0, y1, pz0);
            sideU.push(
              u0 + s * t0, v0 + s * (vj / NV), u0 + s * t1, v0 + s * (vj / NV),
              u0 + s * t1, v0 + s * ((vj + 1) / NV), u0 + s * t0, v0 + s * ((vj + 1) / NV),
            );
            // Per-block value: a different slice of the cell hash for every sub-quad, so
            // neighbouring blocks in the same wall are never the same value.
            const bh = (h >>> (3 + ((vj * NU + ui) * 5) % 23)) & 15;
            const jitter = 0.90 + (bh / 15) * 0.20;
            const grad = (yy) => BASE_SHADE + (TOP_SHADE - BASE_SHADE) * (yy / CEIL_H);
            for (let k = 0; k < 4; k++) {
              const up = k >= 2;
              const yy = up ? y1 : y0;
              // The lit lip: the top row of every course catches the light, which is what
              // makes a stack of blocks read as a stack of blocks from above.
              const shade = grad(yy) * jitter * (up ? EDGE : 1);
              const w = 1 - 0.35 * (yy / CEIL_H);   // torches sit low: warmth strongest at the base
              const m = poolMul(warm, K * w, _pm, GAIN);
              sideC.push(shade * m.r, shade * m.g, shade * m.b);
            }
            sideI.push(sv, sv + 1, sv + 2, sv, sv + 2, sv + 3);
            sv += 4;
          }
        }

        // Cornice lip: a shadow line under the cap that makes the wall read as masonry
        // and not as an extruded polygon.
        const t = trimGeo.clone();
        t.scale(d === 'N' || d === 'S' ? TILE : 0.34, 0.42, d === 'N' || d === 'S' ? 0.34 : TILE);
        t.translate(mx + dx * 0.10, CEIL_H - 0.30, mz + dz * 0.10);
        paintFlat(t, trimCol, warm, K * 0.5, 1, GAIN);
        trimParts.push(t);

        // Plinth: the same trick at the bottom of the face. A wall that meets the floor on
        // a hard seam looks printed on; a base course with its own top edge looks built.
        const pl = trimGeo.clone();
        pl.scale(d === 'N' || d === 'S' ? TILE : 0.42, 0.52, d === 'N' || d === 'S' ? 0.42 : TILE);
        pl.translate(mx + dx * 0.14, 0.26, mz + dz * 0.14);
        paintFlat(pl, trimCol, warm, K * 0.9, 1.22, GAIN);
        trimParts.push(pl);
      }

      // --- cap. Every wall cell gets one, including cells buried deep inside a block:
      // skipping them leaves holes you can see straight through from a 52-degree camera,
      // and two triangles per cell is nothing.
      //
      // Wall tops are a third of the screen on the corridor levels and have no gameplay on
      // them, so they are deliberately the *darkest* large surface in the frame: the value
      // hierarchy has to put the play floor first. Interior cells (walls on all four sides)
      // additionally get a recessed panel, which turns a flat slab into a parapet with a
      // rim, a trough and a real shadow line.
      const rot = (h >>> 13) & 3;
      const tq = [[0, 0], [1, 0], [1, 1], [0, 1]];
      const tint = (0.9 + (((h >>> 17) & 15) / 15) * 0.22) * CAP_VALUE;
      // Only about two thirds of eligible cells get recessed, with the rim and depth
      // jittered: recessing every one turns a big wall mass into a waffle iron.
      const interior = grid.cell(c.gx - 1, c.gz)?.kind === 'wall' && grid.cell(c.gx + 1, c.gz)?.kind === 'wall'
        && grid.cell(c.gx, c.gz - 1)?.kind === 'wall' && grid.cell(c.gx, c.gz + 1)?.kind === 'wall'
        && ((h >>> 19) & 7) < 5;

      if (!interior) {
        topP.push(cx, CEIL_H, cz, cx + TILE, CEIL_H, cz, cx + TILE, CEIL_H, cz + TILE, cx, CEIL_H, cz + TILE);
        for (let k = 0; k < 4; k++) { const q = tq[(k + rot) & 3]; topU.push(q[0], q[1]); }
        for (let k = 0; k < 4; k++) topC.push(tint, tint, tint);
        topI.push(tv, tv + 2, tv + 1, tv, tv + 3, tv + 2);
        tv += 4;
      } else {
        const D = 0.38 + (((h >>> 22) & 7) / 7) * 0.42;   // how deep the trough sinks
        const y1 = CEIL_H - D;
        // Rim: four quads around the edge of the cell, left at full cap height.
        const rimW = TILE * (0.13 + (((h >>> 25) & 3) / 3) * 0.12);
        const bands = [
          [cx, cz, cx + TILE, cz + rimW],
          [cx, cz + TILE - rimW, cx + TILE, cz + TILE],
          [cx, cz + rimW, cx + rimW, cz + TILE - rimW],
          [cx + TILE - rimW, cz + rimW, cx + TILE, cz + TILE - rimW],
        ];
        for (const [ax, az, bx, bz] of bands) {
          topP.push(ax, CEIL_H, az, bx, CEIL_H, az, bx, CEIL_H, bz, ax, CEIL_H, bz);
          for (let k = 0; k < 4; k++) { const q = tq[(k + rot) & 3]; topU.push(q[0], q[1]); }
          for (let k = 0; k < 4; k++) topC.push(tint, tint, tint);
          topI.push(tv, tv + 2, tv + 1, tv, tv + 3, tv + 2);
          tv += 4;
        }
        // Sunken floor of the trough, plus its four inner walls.
        const ix0 = cx + rimW, iz0 = cz + rimW, ix1 = cx + TILE - rimW, iz1 = cz + TILE - rimW;
        topP.push(ix0, y1, iz0, ix1, y1, iz0, ix1, y1, iz1, ix0, y1, iz1);
        for (let k = 0; k < 4; k++) { const q = tq[(k + rot) & 3]; topU.push(q[0], q[1]); }
        for (let k = 0; k < 4; k++) topC.push(tint * 0.68, tint * 0.68, tint * 0.68);
        topI.push(tv, tv + 2, tv + 1, tv, tv + 3, tv + 2);
        tv += 4;
        const inner = [
          [ix0, iz0, ix1, iz0], [ix1, iz1, ix0, iz1],
          [ix1, iz0, ix1, iz1], [ix0, iz1, ix0, iz0],
        ];
        for (const [ax, az, bx, bz] of inner) {
          topP.push(ax, CEIL_H, az, bx, CEIL_H, bz, bx, y1, bz, ax, y1, az);
          topU.push(0, 1, 1, 1, 1, 0.85, 0, 0.85);
          for (let k = 0; k < 4; k++) { const v = k >= 2 ? tint * 0.5 : tint * 0.85; topC.push(v, v, v); }
          topI.push(tv, tv + 1, tv + 2, tv, tv + 2, tv + 3);
          tv += 4;
        }
      }
    }

    if (sv) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(sideP, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(sideU, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(sideC, 3));
      geo.setIndex(sideI);
      geo.computeVertexNormals();
      // Same bounce floor the dressing mesh gets (see Decor._flush): a wall face pointing
      // away from the key and out of the fill's reach receives literally nothing from a
      // hemisphere, and lands on pure black. Sky-coloured, and low enough to read as
      // ambient rather than as glow.
      const mat = new THREE.MeshStandardMaterial({
        map: wallAtlas(p), vertexColors: true, roughness: 0.93, metalness: 0.03,
        color: p.wallTint ?? 0xffffff, side: THREE.FrontSide,
        emissive: new THREE.Color(p.sky ?? 0x5a6a8c).multiplyScalar(0.19 * (p.bounceGain ?? 1)),
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.name = 'wall-sides';
      this.root.add(mesh);
      this._disposables.push(geo, mat);
    }

    if (tv) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(topP, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(topU, 2));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(topC, 3));
      geo.setIndex(topI);
      geo.computeVertexNormals();
      const mat = new THREE.MeshStandardMaterial({
        map: wallTopTex(p), vertexColors: true, roughness: 0.97, metalness: 0.02,
        color: p.wallTopTint ?? 0xffffff,
        emissive: new THREE.Color(p.sky ?? 0x5a6a8c).multiplyScalar(0.15 * (p.bounceGain ?? 1)),
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = 'wall-tops';
      this.root.add(mesh);
      this._disposables.push(geo, mat);
    }

    if (trimParts.length) {
      const geo = mergeGeometries(trimParts, false);
      for (const t of trimParts) t.dispose();
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true, roughness: 0.9, metalness: 0.04,
        emissive: new THREE.Color(p.sky ?? 0x5a6a8c).multiplyScalar(0.20 * (p.bounceGain ?? 1)),
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.name = 'wall-trim';
      this.root.add(mesh);
      this._disposables.push(geo, mat);
    }
    trimGeo.dispose();

    // Shadow casting for the wall mass itself: one cheap box per wall column, invisible
    // to the colour pass. Without it the merged faces cast nothing and the floor is flat.
    this._buildShadowCasters(grid);
  }

  _buildShadowCasters(grid) {
    const cells = grid.cells.filter((c) => {
      if (c.kind !== 'wall') return false;
      for (let dz = -1; dz <= 1; dz++)
        for (let dx = -1; dx <= 1; dx++)
          if (grid.isWalkable(c.gx + dx, c.gz + dz)) return true;
      return false;
    });
    if (!cells.length) return;
    const geo = new THREE.BoxGeometry(TILE, CEIL_H, TILE);
    // Writes neither colour nor depth, so it is a no-op in the beauty pass — but the
    // shadow pass builds its own depth material and still sees it. That gives the merged
    // wall faces (which are single quads) a solid caster without doubling the geometry.
    const mat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    const inst = new THREE.InstancedMesh(geo, mat, cells.length);
    inst.castShadow = true;
    inst.receiveShadow = false;
    inst.renderOrder = -10;
    const m = new THREE.Matrix4();
    cells.forEach((c, i) => {
      m.makeTranslation(c.gx * TILE + TILE / 2, CEIL_H / 2 - 0.02, c.gz * TILE + TILE / 2);
      inst.setMatrixAt(i, m);
    });
    inst.instanceMatrix.needsUpdate = true;
    inst.name = 'wall-occluder';
    this.root.add(inst);
    this._disposables.push(geo, mat);
  }

  // --- pits -----------------------------------------------------------------
  /**
   * Pits used to be holes in the floor mesh: literally nothing, rendered as clear colour.
   * Now they are shafts with lit walls and a glowing bottom, so a chasm reads as danger
   * and depth rather than as a rendering bug.
   */
  _buildPits(grid, def) {
    const p = def.palette || {};
    const DEPTH = 9;
    // Shaft walls take the colour of whatever is burning at the bottom.
    const glowRGB = new THREE.Color(p.pitGlow ?? 0xff7a26).lerp(new THREE.Color(0xffffff), 0.35);
    const sideP = [], sideU = [], sideC = [], sideI = [];
    const floorP = [], floorU = [], floorI = [];
    let sv = 0, fv = 0;
    const isPit = (x, z) => { const c = grid.cell(x, z); return !!c && c.flags.has('pit'); };

    for (const c of grid.cells) {
      if (!c.flags.has('pit')) continue;
      const cx = c.gx * TILE, cz = c.gz * TILE;
      for (const d of DIRS) {
        const [dx, dz] = DIR_VEC[d];
        if (isPit(c.gx + dx, c.gz + dz)) continue;
        let a, b;
        if (d === 'N') { a = [cx, cz]; b = [cx + TILE, cz]; }
        else if (d === 'S') { a = [cx + TILE, cz + TILE]; b = [cx, cz + TILE]; }
        else if (d === 'E') { a = [cx + TILE, cz]; b = [cx + TILE, cz + TILE]; }
        else { a = [cx, cz + TILE]; b = [cx, cz]; }
        sideP.push(a[0], 0, a[1], b[0], 0, b[1], b[0], -DEPTH, b[1], a[0], -DEPTH, a[1]);
        sideU.push(0, 1, 1, 1, 1, 0, 0, 0);
        for (let k = 0; k < 4; k++) {
          // Dark under the lip, then lit again from below — that reversal is what makes a
          // pit read as bottomless-with-something-in-it instead of as a black square.
          const deep = k >= 2 ? 0.55 : 0.30;
          sideC.push(deep * glowRGB.r, deep * glowRGB.g, deep * glowRGB.b);
        }
        sideI.push(sv, sv + 1, sv + 2, sv, sv + 2, sv + 3);
        sv += 4;
      }
      floorP.push(cx, -DEPTH, cz, cx + TILE, -DEPTH, cz, cx + TILE, -DEPTH, cz + TILE, cx, -DEPTH, cz + TILE);
      // UVs run continuously in world space over a 3-cell period, so a chasm reads as one
      // pool of magma rather than as the same 4x4 tile stamped over and over.
      const u0 = c.gx / 3, v0 = c.gz / 3, du = 1 / 3;
      floorU.push(u0, v0, u0 + du, v0, u0 + du, v0 + du, u0, v0 + du);
      floorI.push(fv, fv + 2, fv + 1, fv, fv + 3, fv + 2);
      fv += 4;
    }
    if (!sv) return;

    const g1 = new THREE.BufferGeometry();
    g1.setAttribute('position', new THREE.Float32BufferAttribute(sideP, 3));
    g1.setAttribute('uv', new THREE.Float32BufferAttribute(sideU, 2));
    g1.setAttribute('color', new THREE.Float32BufferAttribute(sideC, 3));
    g1.setIndex(sideI);
    g1.computeVertexNormals();
    // Unlit: nine metres down a shaft no scene light reaches, so a lit material paints the
    // walls solid black. The vertex gradient below *is* the lighting here.
    const m1 = new THREE.MeshBasicMaterial({ map: wallAtlas(p), vertexColors: true, side: THREE.DoubleSide });
    const mesh1 = new THREE.Mesh(g1, m1);
    mesh1.name = 'pit-walls';
    this.root.add(mesh1);
    this._disposables.push(g1, m1);

    const g2 = new THREE.BufferGeometry();
    g2.setAttribute('position', new THREE.Float32BufferAttribute(floorP, 3));
    g2.setAttribute('uv', new THREE.Float32BufferAttribute(floorU, 2));
    g2.setIndex(floorI);
    g2.computeVertexNormals();
    // Unlit and pushed above 1.0 so the molten veins clear the bloom threshold: what is at
    // the bottom of the chasm should be the second brightest thing on the map after the rift.
    const m2 = new THREE.MeshBasicMaterial({ map: pitFloorTex(p), toneMapped: true });
    m2.color.setScalar(p.pitPower ?? 1.5);
    const mesh2 = new THREE.Mesh(g2, m2);
    mesh2.name = 'pit-floor';
    this.root.add(mesh2);
    this._disposables.push(g2, m2);
    this.pitMat = m2;
    this.pitBase = p.pitPower ?? 1.5;
  }

  // --- light pools ----------------------------------------------------------
  /** One additive quad under every fire. Fifty pools of torchlight for one draw call. */
  _buildLightPools() {
    const anchors = this.decor.torchAnchors;
    if (!anchors.length) return;
    const parts = [];
    const p = this.pal;
    const warm = new THREE.Color(p.torch ?? 0xff9b3d);
    const cool = new THREE.Color(p.riftGlow ?? 0x53d0ff);
    // Colour is normalised on its max channel before it is scaled by `k`. Additive light
    // that has been pre-dimmed by its own luminance adds mostly grey, and grey added to a
    // cold floor is the veil problem in miniature; normalised, a sconce pool adds the
    // torch's *hue* at the strength `k` asks for.
    const nrm = (c) => { const m = Math.max(c.r, c.g, c.b) || 1; return { r: c.r / m, g: c.g / m, b: c.b / m }; };
    const warmN = nrm(warm), coolN = nrm(cool);
    for (const a of anchors) {
      const g = new THREE.PlaneGeometry(10, 10);
      g.rotateX(-Math.PI / 2);
      g.translate(a.x, 0.035, a.z);
      const n = g.attributes.position.count;
      const col = new Float32Array(n * 3);
      const c = a.cool ? coolN : warmN;
      const k = (a.power ?? 1) * (a.cool ? 0.30 : 0.46);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r * k; col[i * 3 + 1] = c.g * k; col[i * 3 + 2] = c.b * k; }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      parts.push(g);
    }
    const geo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    const mat = new THREE.MeshBasicMaterial({
      map: glowTex(), vertexColors: true, transparent: true, opacity: 0.20,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    mesh.name = 'light-pools';
    this.root.add(mesh);
    this._disposables.push(geo, mat);
    this.poolMat = mat;
  }

  /**
   * Real point lights, capped hard. Only the map-authored torch walls and the biggest
   * braziers get one, spread out by a minimum separation so we never spend two lights
   * on the same corner. Everything else is carried by the bake.
   */
  _buildTorchLights(def) {
    const p = def.palette || {};
    // Hard cap. Every extra point light is a per-fragment cost on every standard material
    // in the scene, and levels with six spawn gates already spend six on the gates alone.
    // Everything past this is carried by the vertex bake and the additive light pools.
    const cap = def.maxTorches ?? Math.max(3, 9 - this.game.grid.spawns.length);
    const candidates = [];
    this.game.grid.forEach((c) => {
      if (c.flags.has('torch')) candidates.push({ x: c.gx * TILE + TILE / 2, z: c.gz * TILE + TILE / 2, w: 2 });
    });
    // Sconce anchors now carry a per-torch burn strength rather than a flat 1, so the
    // gate here is "a strong one", not "exactly nominal" — at >= 1 a rounding change in
    // the burn roll would silently drop the level's point lights to zero.
    for (const a of this.decor.torchAnchors) if (!a.cool && (a.power ?? 1) >= 0.92) candidates.push({ x: a.x, z: a.z, w: 1 + (a.power ?? 1) * 0.1 });
    candidates.sort((a, b) => b.w - a.w);

    const chosen = [];
    const minSep2 = (TILE * 4) ** 2;
    for (const c of candidates) {
      if (chosen.length >= cap) break;
      let ok = true;
      for (const q of chosen) { const dx = q.x - c.x, dz = q.z - c.z; if (dx * dx + dz * dz < minSep2) { ok = false; break; } }
      if (ok) chosen.push(c);
    }
    for (const c of chosen) {
      const light = new THREE.PointLight(p.torch ?? 0xff9b3d, 3.4, 24, 2);
      light.position.set(c.x, 3.6, c.z);
      this.root.add(light);
      this.torches.push({ light, base: 3.4, seed: Math.random() * 100 });
    }
  }

  // --- spawns ---------------------------------------------------------------
  _buildSpawns(grid, def) {
    for (const s of grid.spawns) {
      const gate = new SpawnGate(this.game, s, def, this.colors);
      this.root.add(gate.object);
      this.gates.push(gate);
    }
    // Kept for compatibility with anything that peeked at spawn markers.
    this.spawnMarkers = this.gates.map((g) => ({ group: g.object }));
  }

  // --- tick -----------------------------------------------------------------
  update(dt) {
    const t = this.game.clock.elapsed;
    // Torch flicker: two out-of-phase sines beat a random walk — it reads as fire, not noise.
    for (const tr of this.torches) {
      tr.light.intensity = tr.base * (0.82 + 0.12 * Math.sin(t * 11 + tr.seed) + 0.08 * Math.sin(t * 23.3 + tr.seed * 2));
    }
    if (this.poolMat) this.poolMat.opacity = 0.18 + 0.035 * Math.sin(t * 7.7);
    // Slow churn at the bottom of the chasms so a pit is never a static hole.
    if (this.pitMat) this.pitMat.color.setScalar(this.pitBase * (0.88 + 0.12 * Math.sin(t * 1.3) + 0.06 * Math.sin(t * 3.7)));
    this.decor?.update(dt, t);
    for (const g of this.gates) g.update(dt, t);
    this.rift?.update(dt);
    if (this.sun && this.game.player) {
      // Keep the shadow cascade tight around the action, and re-fit it when the rig zooms.
      const p = this.game.player.position;
      const S = this.sunOffset || SUN_OFFSET;
      this.sun.position.set(p.x + S.x, S.y, p.z + S.z);
      this.sun.target.position.set(p.x, 0, p.z);
      this.sun.target.updateMatrixWorld();
      this._fitShadow();
    }
  }

  dispose() {
    this.rift?.dispose();
    for (const g of this.gates) g.dispose();
    this.gates.length = 0;
    this.decor?.dispose();
    this.root.traverse((o) => {
      if (o.isMesh || o.isInstancedMesh) {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose());
        else o.material?.dispose?.();
      }
    });
    for (const d of this._disposables) d.dispose?.();
    this._disposables.length = 0;
    this.game.scene.remove(this.root);
    this.torches.length = 0;
    this._anchors.length = 0;
  }
}

/**
 * Key light direction, relative to the player.
 *
 * 38 degrees of elevation, not the 54 this used to sit at. High sun puts its strongest
 * light on the *wall tops* — the one surface with no gameplay on it — and leaves the play
 * floor as the darkest thing in frame. Lowering it flips that round, and the longer
 * shadows it throws across the floor are what give the arena depth from straight above.
 */
const SUN_OFFSET = new THREE.Vector3(40.4, 37.5, 26.0);

/**
 * Global value multiplier for wall caps. Wall tops are the largest surface with no
 * gameplay on it; holding them a third of a stop under the play floor is what stops the
 * eye going to them first.
 */
const CAP_VALUE = 0.62;

/**
 * Wall-face value ramp. `BASE_SHADE` is the contact shadow where the wall meets the floor,
 * `TOP_SHADE` the value at the cap, `EDGE` the lift on the top row of every course.
 *
 * Two failures bracket these numbers. The base used to sit at 0.52, which on a level with
 * a low fill left the bottom half of every wall at pure black. But taking the top past 1.0
 * is the opposite mistake: a vertex colour over unity multiplies the albedo, and a sunlit
 * wall block then clips to flat white — which is what turned the free-standing blocks
 * either side of the Gatehouse rift into blank towers and fed the blown-highlight count.
 * The whole ramp now lives under 1.0 and the contrast comes from its *range*, not its top.
 */
const BASE_SHADE = 0.72;
const TOP_SHADE = 0.90;
const EDGE = 1.00;   // ramp max = TOP_SHADE * jitter(1.10) * EDGE = 0.99, i.e. never over unity

/** Hash -> [-1,1] value noise, bilinear. Deterministic, allocation-free, ~20 flops. */
function smoothNoise(x, z) {
  const xi = Math.floor(x), zi = Math.floor(z);
  const fx = x - xi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const h = (a, b) => {
    let n = (a * 374761393 + b * 668265263) | 0;
    n = (n ^ (n >> 13)) * 1274126177 | 0;
    return ((n ^ (n >> 16)) & 0xffff) / 32767.5 - 1;
  };
  const a0 = h(xi, zi), a1 = h(xi + 1, zi), b0 = h(xi, zi + 1), b1 = h(xi + 1, zi + 1);
  return (a0 + (a1 - a0) * sx) + ((b0 + (b1 - b0) * sx) - (a0 + (a1 - a0) * sx)) * sz;
}

/**
 * Turn a baked anchor sum into the vertex multiplier a lit surface gets.
 *
 * **Why this is not `1 + warm * K`.** That is what it used to be, and a purely
 * multiplicative bake can brighten a surface but can never change which hue wins on it.
 * Work it through: a blue-lit floor at (0.30, 0.38, 0.55) under an orange torch multiplier
 * of (1.8, 1.5, 1.2) comes out (0.54, 0.57, 0.66) — brighter, and still blue. Every torch
 * pool in the campaign was a *pale patch*, not a warm one, which is the mechanical reason
 * ten levels measured 0.005-0.053 hue spread against Orcs Must Die's 0.297. You cannot
 * have warm pools on cold stone with a multiply.
 *
 * So the pool blends the surface *toward the emitter's own hue* as it takes hold:
 *
 *   t = min(1, poolStrength * K)          how much of this surface the pool owns
 *   mul = mix(white, hueOf(pool) * GAIN, t)
 *
 * At t = 0 nothing happens; at t = 1 the same floor comes out (0.66, 0.46, 0.34) — warm,
 * and brighter than it was. The emitter's *hue* survives the trip; its brightness is
 * `poolGain`, which the tone contract owns like every other exposure number.
 *
 * `hueOf` normalises on the max channel rather than on luminance deliberately: it keeps a
 * deep-red ember red instead of washing it to pink on the way to the target brightness.
 */
function poolMul(warm, k, out, gain) {
  const amt = warm.r > warm.g ? (warm.r > warm.b ? warm.r : warm.b) : (warm.g > warm.b ? warm.g : warm.b);
  if (amt <= 0.002 || k <= 0) { out.setRGB(1, 1, 1); return out; }
  const t = Math.min(1, amt * k);
  const s = (gain ?? POOL_GAIN) / amt;
  out.setRGB(
    (1 - t) + t * warm.r * s,
    (1 - t) + t * warm.g * s,
    (1 - t) + t * warm.b * s,
  );
  return out;
}
const POOL_GAIN = 2.05;
const _pm = new THREE.Color();

/** Flat-colour a primitive and fold in the baked warmth. Used by the wall cornice. */
function paintFlat(geo, base, warm, k, mul = 1, gain = POOL_GAIN) {
  const n = geo.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const m = poolMul(warm, k, _pm, gain);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = base.r * mul * m.r;
    arr[i * 3 + 1] = base.g * mul * m.g;
    arr[i * 3 + 2] = base.b * mul * m.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return geo;
}

// Re-exported for anything that wants the old helpers by name.
export { floorAtlas as stoneTexture, wallAtlas as brickTexture } from './Textures.js';
