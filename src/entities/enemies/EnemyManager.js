import * as THREE from 'three';
import { Enemy } from './Enemy.js';
import { getEnemyDef, ROSTER } from './roster.js';
import { MODEL_HEIGHT } from './models.js';
import { ActiveList, Pool } from '../../core/Pool.js';
import { buildFlowField } from '../../world/Flow.js';
import { applyDamage } from '../../shared/Damage.js';
import { wreckTrap } from './abilities.js';
import { v0, v1 } from '../../shared/scratch.js';

// World units per spatial-hash cell. Sized to roughly two orc diameters: at BUCKET = 4 a
// packed corridor put ~13 orcs in every cell and the 3x3 neighbourhood scan for separation
// touched over a hundred candidates per orc per frame, which was the single biggest cost in
// a 250-orc wave.
const BUCKET = 2;

/** Stand-in for a flow field when there is no grid at all (menu, mid-level-swap). */
const EMPTY_FLOW = {
  distAt: () => Infinity,
  dirAt: (gx, gz, out = { x: 0, z: 0 }) => { out.x = 0; out.z = 0; return out; },
  sample: (x, z, out = { x: 0, z: 0 }) => { out.x = 0; out.z = 0; return out; },
  unreachable: () => true,
};

/**
 * Owns every enemy: pooling, spawning, the spatial hash used for separation and
 * area-of-effect queries, health bars, and enemy projectiles.
 */
export class EnemyManager {
  constructor(game) {
    this.game = game;
    this.list = new ActiveList();
    this.root = new THREE.Group();
    this.root.name = 'enemies';
    game.scene.add(this.root);

    this._pools = new Map();     // enemy id -> Pool<Enemy>
    this._buckets = new Map();   // hash -> Enemy[]
    this._queryOut = [];
    this._corpses = [];
    this.hpScale = 1;
    this.speedScale = 1;

    // How many grounded orcs have currently committed to hunting the hero. Recounted
    // once a frame from the live list rather than incremented and decremented on every
    // state change, because a counter that drifts by one every time an orc dies mid-hunt
    // would silently close the gate on the whole rest of the level.
    this.hunters = 0;
    this._heroFlow = null;
    this._heroCell = -1;
    this._heroAt = -99;

    this.projectiles = new ProjectilePool(game, this.root);
    this.bars = new HealthBars(game, this.root);

    // Culling scratch: off-screen orcs skip their animation rig entirely.
    this._frustum = new THREE.Frustum();
    this._fm = new THREE.Matrix4();
    this._sphere = new THREE.Sphere(new THREE.Vector3(), 1);

    // The rig needs to know *where* a hit came from to flinch away from it, and the
    // damage funnel is the only place that knows. Listening beats threading it through.
    game.bus.on('enemy:damaged', (p) => p.enemy?.onDamaged?.(p));
  }

  get count() { return this.list.length; }
  aliveCount() { let n = 0; for (const e of this.list) if (!e.dead) n++; return n; }

  _pool(id) {
    let p = this._pools.get(id);
    if (!p) {
      const def = getEnemyDef(id);
      p = new Pool(() => {
        const e = new Enemy(this.game);
        const { group, rig } = def.build({ game: this.game });
        e.object.add(group);
        e.rig = rig;
        this.root.add(e.object);
        return e;
      });
      this._pools.set(id, p);
    }
    return p;
  }

  spawn(id, x, z, opts = {}) {
    const def = getEnemyDef(id);
    if (!def) return null;
    const e = this._pool(id).take();
    e.spawn(def, x, z, { hpScale: this.hpScale, speedScale: this.speedScale, ...opts });
    this.list.add(e);
    // No book-keeping for summons here on purpose. DIRECTOR ends a wave by querying
    // `aliveCount()` rather than by tracking a decrementing integer, so king's guards,
    // splitter children and debug spawns all count themselves simply by existing.
    this.game.bus.emit('enemy:spawn', { enemy: e });
    return e;
  }

  spawnAtMarker(id, marker, opts = {}) {
    const w = this.game.grid.toWorld(marker.gx, marker.gz, v0);
    // Jitter inside the portal so a group does not emerge as a single point.
    return this.spawn(id, w.x + (Math.random() - 0.5) * 2.4, w.z + (Math.random() - 0.5) * 2.4, opts);
  }

  /**
   * Leaving the active list is not the same as leaving the screen. Unless the orc was
   * obliterated outright, it stays as a corpse for ~1.8s so the death actually *plays* —
   * jolt, fall, settle, sink — and only then goes back to the pool. Corpses are capped,
   * so a 250-orc wipe still costs a bounded number of animated bodies.
   */
  despawn(e, spec = null, silent = false) {
    this.list.remove(e);
    if (silent || !e.rig?.beginDeath) { this._retire(e); return; }

    // Presentation — gore, sound, hitstop, shake — belongs to JUICE, which owns the
    // `enemy:killed` handler and varies it by damage type. All this module decides is
    // whether a body is left behind at all.
    if (e.gibbed || this._corpses.length >= 26) { this._retire(e); return; }

    const kx = spec?.knockback ? spec.knockback.x : (spec?.position ? e.position.x - spec.position.x : e.velocity.x);
    const kz = spec?.knockback ? spec.knockback.z : (spec?.position ? e.position.z - spec.position.z : e.velocity.z);
    const d = Math.hypot(kx, kz) || 1;
    e.rig.beginDeath(kx / d, kz / d, e.facing);
    e.object.visible = true;
    this._corpses.push(e);
  }

  _retire(e) {
    e.object.visible = false;
    this._pool(e.id).give(e);
  }

  _updateCorpses(dt) {
    for (let i = this._corpses.length - 1; i >= 0; i--) {
      const e = this._corpses[i];
      if (!e.rig.deathUpdate(dt)) {
        this._corpses.splice(i, 1);
        this._retire(e);
      }
    }
  }


  spawnProjectile(from, targetPos, opts) {
    this.projectiles.fire(from, targetPos, opts);
  }

  // --- spatial hash --------------------------------------------------------
  _hash(x, z) { return ((x / BUCKET) | 0) * 73856093 ^ ((z / BUCKET) | 0) * 19349663; }

  _rebuildHash() {
    this._buckets.clear();
    let hunters = 0;
    for (const e of this.list) {
      if (e.dead) continue;
      if (e.hunt > 0 && !e.has('boss')) hunters++;
      const h = this._hash(e.position.x, e.position.z);
      let b = this._buckets.get(h);
      if (!b) { b = []; this._buckets.set(h, b); }
      b.push(e);
    }
    this.hunters = hunters;
  }

  /**
   * A flow field that leads to the hero instead of to the rift.
   *
   * One field serves every hunter on the map, the same deal the rift field already gets,
   * so a pack chasing you costs the same as one orc — this is emphatically not
   * A*-per-enemy (ARCHITECTURE §3). The rebuild is gated twice: the hero has to have
   * changed *tile*, and a quarter-second has to have passed. A sprinting player crosses a
   * tile about twice a second, so on the largest map in the game (42x32 = 1,344 cells)
   * that is a couple of small Dijkstra sweeps per second, against 250 orcs that would
   * otherwise each need their own path.
   *
   * The half-second staleness ceiling exists for barricades: one can come down mid-wave
   * and the route to the hero changes with it.
   */
  heroFlow() {
    const g = this.game;
    const grid = g.grid;
    const p = g.player;
    if (!grid) return EMPTY_FLOW;
    if (!p || p.dead) return grid.riftFlow();
    const gx = Math.floor(p.position.x / 4), gz = Math.floor(p.position.z / 4);
    if (!grid.isWalkable(gx, gz)) return this._heroFlow ?? grid.riftFlow();
    const cell = gz * grid.w + gx;
    const now = g.clock.elapsed;
    const stale = now - this._heroAt;
    if (this._heroFlow && (cell === this._heroCell ? stale < 0.5 : stale < 0.25)) return this._heroFlow;
    this._heroFlow = buildFlowField(grid, [{ gx, gz }]);
    this._heroCell = cell;
    this._heroAt = now;
    return this._heroFlow;
  }

  /** Neighbours within `r`. Result array is reused — copy it if you need to keep it. */
  queryNear(pos, r) {
    const out = this._queryOut;
    out.length = 0;
    const steps = Math.max(1, Math.ceil(r / BUCKET));
    const r2 = r * r;
    for (let dz = -steps; dz <= steps; dz++) {
      for (let dx = -steps; dx <= steps; dx++) {
        const b = this._buckets.get(this._hash(pos.x + dx * BUCKET, pos.z + dz * BUCKET));
        if (!b) continue;
        for (const e of b) {
          if (e.dead) continue;
          const ex = e.position.x - pos.x, ez = e.position.z - pos.z;
          if (ex * ex + ez * ez <= r2) out.push(e);
        }
      }
    }
    return out;
  }

  /** Everything in a cylinder, sorted nearest-first. Allocates — for one-off AoE only. */
  queryRadius(pos, r, filter = null) {
    const res = [];
    for (const e of this.list) {
      if (e.dead) continue;
      if (filter && !filter(e)) continue;
      const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
      if (dx * dx + dz * dz <= r * r) res.push(e);
    }
    res.sort((a, b) => a.position.distanceToSquared(pos) - b.position.distanceToSquared(pos));
    return res;
  }

  /**
   * The enemy a targeting system should pick: closest to `pos` within `r`.
   * Stealthed units are invisible here — that *is* the stealth flag. Area effects go
   * through queryRadius and still catch them, so a fireball is the answer to a stalker.
   */
  nearest(pos, r, filter = null) {
    let best = null, bd = r * r;
    for (const e of this.list) {
      if (e.dead || e.stealthed) continue;
      if (filter && !filter(e)) continue;
      const dx = e.position.x - pos.x, dz = e.position.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = e; }
    }
    return best;
  }

  /**
   * Flag every enemy that the camera cannot see. Six plane tests per orc is nothing next
   * to the animation and matrix work it saves: in a real wave most of the field is queued
   * up a corridor nobody is looking at.
   */
  _cull() {
    const cam = this.game.camera;
    this._fm.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    this._frustum.setFromProjectionMatrix(this._fm);
    const s = this._sphere;
    const cp = cam.position;
    for (const e of this.list) {
      const scale = e.def?.scale ?? 1;
      s.center.set(e.position.x, e.position.y + scale, e.position.z);
      s.radius = 2.2 * scale;
      e.culled = !this._frustum.intersectsSphere(s);
      // Distance is a stand-in for on-screen size; big units keep their limbs for longer.
      // 2400 ≈ 49 units, which is past the far edge of the screen at the default camera
      // distance — so at normal zoom nothing the player is looking at is ever LOD'd.
      const dx = e.position.x - cp.x, dy = e.position.y - cp.y, dz = e.position.z - cp.z;
      e.lodFar = (dx * dx + dy * dy + dz * dz) > 2400 * scale * scale;
    }
  }

  update(dt) {
    if (this.game.state === 'paused') return;
    this._rebuildHash();
    this._cull();
    const items = this.list.items;
    // Backwards: enemies remove themselves during update.
    for (let i = items.length - 1; i >= 0; i--) items[i]?.update(dt, this.game);
    this._updateCorpses(dt);
    this.projectiles.update(dt);
    this.bars.update(dt, this.list);
  }

  clear() {
    this._heroFlow = null; this._heroCell = -1; this._heroAt = -99;
    this.hunters = 0;
    for (const e of Array.from(this.list.items)) this.despawn(e, null, true);
    for (const e of this._corpses) this._retire(e);
    this._corpses.length = 0;
    this.list.clear();
    this.projectiles.clear();
    this.bars.clear();
  }
}

/** Enemy projectiles (archer arrows, shaman bolts). Instanced, pooled, cheap. */
class ProjectilePool {
  constructor(game, root) {
    this.game = game;
    this.items = [];
    const geo = new THREE.ConeGeometry(0.09, 0.7, 6).rotateX(Math.PI / 2);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
      color: 0xffd070, emissive: 0xffa030, emissiveIntensity: 1.6, roughness: 0.4,
    }), 128);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    root.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  fire(from, targetPos, opts) {
    if (this.items.length >= 128) return;
    const p = from.position;
    const d = v0.copy(targetPos).sub(p);
    d.y += 0.8;
    const dist = d.length();
    d.normalize();
    this.items.push({
      x: p.x, y: p.y + 1.2, z: p.z,
      vx: d.x * (opts.speed ?? 20), vy: d.y * (opts.speed ?? 20) * 0.6 + dist * 0.12,
      vz: d.z * (opts.speed ?? 20),
      life: 3, damage: opts.damage ?? 10, source: from,
      trap: opts.trap ?? null,     // archers shoot guardians, not just the player
      // A trap (not a guardian) this arrow will *wreck* on contact. Only ever set when
      // there was no hero and no guardian to shoot at — see `archerTarget`.
      structure: opts.structure ?? null, wreck: opts.wreck ?? 0,
    });
  }

  update(dt) {
    const g = this.game;
    const player = g.player;
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life -= dt;
      p.vy -= 11 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      let hit = false;
      if (player && !player.dead) {
        const dx = p.x - player.position.x, dz = p.z - player.position.z;
        const dy = p.y - (player.position.y + 1);
        if (dx * dx + dz * dz + dy * dy < 1.3) { player.takeDamage(p.damage, p.source); hit = true; }
      }
      if (!hit && p.trap && !p.trap.destroyed) {
        const dx = p.x - p.trap.world.x, dz = p.z - p.trap.world.z;
        if (dx * dx + dz * dz < 1.6 && p.y < 2.4) {
          g.traps.damageGuardian(p.trap, p.damage);
          g.fx.hit({ x: p.x, y: p.y, z: p.z }, null, { count: 5, color: [1, 0.8, 0.5] });
          hit = true;
        }
      }
      if (!hit && p.structure && !p.structure.destroyed && p.wreck > 0) {
        const dx = p.x - p.structure.world.x, dz = p.z - p.structure.world.z;
        if (dx * dx + dz * dz < 2.6 && p.y < 2.0) {
          wreckTrap(g, p.structure, p.wreck, { kind: 'enemy', id: p.source?.id ?? 'orc-archer', enemy: p.source });
          g.fx.hit({ x: p.x, y: p.y, z: p.z }, null, { count: 5, color: [1, 0.8, 0.5] });
          hit = true;
        }
      }
      // Arrows are stopped by masonry, exactly as the crossbow now is. Without this an
      // archer parked behind a wall shoots straight through it, which is the same bug
      // that made the player's own weapon read as the entire defence.
      if (!hit && g.grid && !g.grid.isWalkable(Math.floor(p.x / 4), Math.floor(p.z / 4)) && p.y < 5) {
        g.fx.hit({ x: p.x, y: p.y, z: p.z }, null, { count: 3, color: [0.7, 0.65, 0.6], speed: 3 });
        hit = true;
      }
      if (p.y < 0.05) { g.fx.dust({ x: p.x, y: 0.1, z: p.z }, 0.4, 4); hit = true; }
      if (hit || p.life <= 0) this.items.splice(i, 1);
    }

    const n = Math.min(this.items.length, 128);
    for (let i = 0; i < n; i++) {
      const p = this.items[i];
      this._m.lookAt(
        v0.set(p.x, p.y, p.z),
        v1.set(p.x + p.vx, p.y + p.vy, p.z + p.vz),
        { x: 0, y: 1, z: 0 },
      );
      this._m.setPosition(p.x, p.y, p.z);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() { this.items.length = 0; this.mesh.count = 0; }
}

/**
 * Health bars as a single instanced quad billboard pair. Only drawn for damaged or
 * elite enemies, so a 250-orc wave does not become 250 floating rectangles.
 */
class HealthBars {
  constructor(game, root) {
    this.game = game;
    const geo = new THREE.PlaneGeometry(1, 0.12);
    this.bg = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0x120a0a, transparent: true, opacity: 0.75, depthTest: false }), 300);
    this.fg = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xff4030, depthTest: false }), 300);
    for (const m of [this.bg, this.fg]) {
      m.frustumCulled = false; m.count = 0; m.renderOrder = 20;
      root.add(m);
    }
    this.fg.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(300 * 3).fill(1), 3);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
  }

  update(dt, list) {
    const cam = this.game.camera;
    cam.getWorldQuaternion(this._q);
    let n = 0;
    const col = this.fg.instanceColor.array;
    for (const e of list) {
      if (e.dead || e.culled || e.stealthed || n >= 300) continue;
      const frac = e.hp / e.hpMax;
      const elite = e.has('boss') || e.hpMax > 400;
      if (frac > 0.999 && !elite) continue;

      const w = elite ? 2.6 : 1.3;
      // Sit the bar above the *measured* crown of this archetype, not above a constant.
      // 2.35 is right for a grunt and draws a red line across the Orc King's face, which
      // was doing real damage to how the finale reads.
      const y = e.position.y + ((MODEL_HEIGHT[e.id] ?? 2.0) + 0.42) * (e.def.scale ?? 1);
      this._p.set(e.position.x, y, e.position.z);

      this._s.set(w, 1, 1);
      this._m.compose(this._p, this._q, this._s);
      this.bg.setMatrixAt(n, this._m);

      this._s.set(w * frac, 0.72, 1);
      this._p.x -= (w * (1 - frac)) / 2;
      this._m.compose(this._p, this._q, this._s);
      this.fg.setMatrixAt(n, this._m);

      // Green -> yellow -> red as it dies; shielded units read blue.
      const shielded = e.shield && e.shield.hp > 0;
      col[n * 3] = shielded ? 0.45 : 1;
      col[n * 3 + 1] = shielded ? 0.75 : frac * 0.9;
      col[n * 3 + 2] = shielded ? 1 : 0.18;
      n++;
    }
    this.bg.count = n; this.fg.count = n;
    this.bg.instanceMatrix.needsUpdate = true;
    this.fg.instanceMatrix.needsUpdate = true;
    this.fg.instanceColor.needsUpdate = true;
  }

  clear() { this.bg.count = 0; this.fg.count = 0; }
}
