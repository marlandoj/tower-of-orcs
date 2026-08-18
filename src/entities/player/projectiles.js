import * as THREE from 'three';
import { v0 } from '../../shared/scratch.js';

/**
 * Everything the player launches into the world — fireballs, hitscan tracers, beams —
 * pooled and ticked off `game.clock.dt`.
 *
 * Why this exists: the first pass drove fireballs (and tracer fades) on their own
 * `requestAnimationFrame` chains. That meant they ignored pause, ignored hitstop and
 * slow-motion, kept simulating after a level teardown, and allocated a mesh + a
 * PointLight per shot that was then disposed on impact. Anything that moves in world
 * space has to share the game clock, or it desyncs from the thing it is meant to hit.
 *
 * Everything here is fixed-capacity: at the cap we recycle the oldest rather than grow,
 * so a stuck fire button can never leak.
 */

const MAX_PROJECTILES = 48;
const MAX_TRACERS = 64;
const MAX_GLOW_LIGHTS = 3;

/** Projectile archetypes. Weapons and spells register their own at module load. */
const KINDS = new Map();

/**
 * @param {string} id
 * @param {object} def {
 *   color, emissive, radius, geometry(), hitRadius, gravity, glow, glowColor, glowRange,
 *   trail(game, p, dt), onImpact(game, p, enemy|null, hitWall:boolean)
 * }
 */
export function registerProjectile(id, def) { KINDS.set(id, def); }

export class PlayerProjectiles {
  constructor(game) {
    this.game = game;
    this.root = new THREE.Group();
    this.root.name = 'player-projectiles';
    game.scene.add(this.root);

    this.active = [];
    this._free = [];                 // recycled record objects
    this._meshPools = new Map();     // kind id -> THREE.Mesh[]

    // A tiny fixed set of lights, handed to the newest glowing projectiles. Per-shot
    // PointLights are the fastest way to blow the forward renderer's light budget.
    this._lights = [];
    for (let i = 0; i < MAX_GLOW_LIGHTS; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 14, 2);
      l.visible = false;
      this.root.add(l);
      this._lights.push(l);
    }

    this.tracers = new TracerPool(this.root);

    game.bus.on('level:load', () => this.clear());
  }

  // --- projectiles ----------------------------------------------------------
  /**
   * @param {string} kindId
   * @param {number} x @param {number} y @param {number} z
   * @param {number} vx @param {number} vy @param {number} vz
   * @param {object} params  per-shot payload (damage, radius multipliers, source tag)
   */
  spawn(kindId, x, y, z, vx, vy, vz, params) {
    const kind = KINDS.get(kindId);
    if (!kind) { console.warn('unknown player projectile', kindId); return null; }
    // At the cap, retire the oldest instead of growing — a held trigger must not leak.
    if (this.active.length >= MAX_PROJECTILES) this._retire(0, null, false);

    const p = this._free.pop() ?? {};
    p.kind = kind;
    p.kindId = kindId;
    p.x = x; p.y = y; p.z = z;
    p.vx = vx; p.vy = vy; p.vz = vz;
    p.life = kind.life ?? 1.8;
    p.age = 0;
    p.params = params;
    p.mesh = this._takeMesh(kindId, kind);
    p.mesh.position.set(x, y, z);
    p.mesh.visible = true;
    p.light = null;
    this.active.push(p);
    if (kind.glow) this._assignLights();
    return p;
  }

  update(dt) {
    this.tracers.update(dt);
    if (!this.active.length) return;
    const g = this.game;
    const grid = g.grid;

    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      const k = p.kind;
      p.age += dt;
      p.life -= dt;

      if (k.gravity) p.vy -= k.gravity * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.mesh.position.set(p.x, p.y, p.z);
      if (k.spin) p.mesh.rotation.set(p.age * k.spin, p.age * k.spin * 0.7, 0);
      if (p.light) { p.light.position.set(p.x, p.y, p.z); }

      k.trail?.(g, p, dt);

      // --- collision ---
      let hit = null;
      if (k.hitRadius) {
        v0.set(p.x, p.y, p.z);
        hit = g.enemies.nearest(v0, k.hitRadius + (p.params?.hitBonus ?? 0), k.filter ?? null);
      }
      const inWall = grid ? !grid.isWalkable(Math.floor(p.x / 4), Math.floor(p.z / 4)) : false;
      const grounded = p.y <= 0.15;

      if (hit || inWall || grounded || p.life <= 0) {
        this._retire(i, hit, inWall || grounded);
      }
    }
  }

  _retire(i, hit, hitWall) {
    const p = this.active[i];
    this.active.splice(i, 1);
    p.kind.onImpact?.(this.game, p, hit, hitWall);
    p.mesh.visible = false;
    this._giveMesh(p.kindId, p.mesh);
    if (p.light) { p.light.visible = false; p.light.intensity = 0; p.light = null; }
    p.mesh = null; p.params = null; p.kind = null;
    this._free.push(p);
    this._assignLights();
  }

  /** Newest glowing projectiles win the limited light slots. */
  _assignLights() {
    for (const l of this._lights) { l.visible = false; l.intensity = 0; }
    let slot = 0;
    for (let i = this.active.length - 1; i >= 0 && slot < this._lights.length; i--) {
      const p = this.active[i];
      if (!p.kind.glow) continue;
      const l = this._lights[slot++];
      l.color.setHex(p.kind.glowColor ?? p.kind.color ?? 0xffffff);
      l.distance = p.kind.glowRange ?? 13;
      l.intensity = p.kind.glowIntensity ?? 6;
      l.visible = true;
      l.position.set(p.x, p.y, p.z);
      p.light = l;
    }
  }

  _takeMesh(kindId, kind) {
    let pool = this._meshPools.get(kindId);
    if (!pool) { pool = []; this._meshPools.set(kindId, pool); }
    let m = pool.pop();
    if (!m) {
      m = new THREE.Mesh(
        kind.geometry ? kind.geometry() : new THREE.IcosahedronGeometry(kind.radius ?? 0.3, 1),
        new THREE.MeshBasicMaterial({ color: kind.color ?? 0xffffff, toneMapped: false }),
      );
      m.frustumCulled = false;
      this.root.add(m);
    }
    return m;
  }
  _giveMesh(kindId, mesh) { this._meshPools.get(kindId).push(mesh); }

  clear() {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      this.active.splice(i, 1);
      p.mesh.visible = false;
      this._giveMesh(p.kindId, p.mesh);
      p.mesh = null; p.params = null; p.kind = null; p.light = null;
      this._free.push(p);
    }
    for (const l of this._lights) { l.visible = false; l.intensity = 0; }
    this.tracers.clear();
  }

  // --- tracers (convenience passthrough) ------------------------------------
  tracer(x, z, dx, dz, len, color, opts) { this.tracers.add(x, z, dx, dz, len, color, opts); }
}

/**
 * Hitscan tracers and beams. One stretched, additive quad-ish cylinder per shot,
 * pooled and faded on the game clock so hitstop holds the streak on screen — which is
 * exactly when you want to see it.
 */
class TracerPool {
  constructor(root) {
    this.root = root;
    this.items = [];
    this._free = [];
    // Unit-length along +Z with the origin at the near end, so scale.z == world length.
    this._geo = new THREE.CylinderGeometry(0.05, 0.014, 1, 6, 1, true)
      .rotateX(Math.PI / 2).translate(0, 0, 0.5);
  }

  add(x, z, dx, dz, len, color, opts = {}) {
    if (this.items.length >= MAX_TRACERS) this._release(0);
    let t = this._free.pop();
    if (!t) {
      const mesh = new THREE.Mesh(this._geo, new THREE.MeshBasicMaterial({
        transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false,
      }));
      mesh.frustumCulled = false;
      this.root.add(mesh);
      t = { mesh, life: 0, maxLife: 0.09, w: 1 };
    }
    const y = opts.y ?? 1.2;
    t.mesh.material.color.setRGB(color[0], color[1], color[2]);
    t.mesh.material.opacity = opts.opacity ?? 0.95;
    t.mesh.position.set(x, y, z);
    t.mesh.lookAt(x + dx * 10, y, z + dz * 10);
    t.w = opts.width ?? 1;
    t.mesh.scale.set(t.w, t.w, Math.max(0.4, len));
    t.mesh.visible = true;
    t.maxLife = opts.life ?? 0.09;
    t.life = t.maxLife;
    t.alpha = opts.opacity ?? 0.95;
    this.items.push(t);
  }

  update(dt) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const t = this.items[i];
      t.life -= dt;
      if (t.life <= 0) { this.items.splice(i, 1); this._release(-1, t); continue; }
      const k = 1 - t.life / t.maxLife;
      t.mesh.material.opacity = t.alpha * (1 - k);
      const w = t.w * (1 - k * 0.65);
      t.mesh.scale.x = w; t.mesh.scale.y = w;
    }
  }

  _release(index, item = null) {
    const t = item ?? this.items.splice(index, 1)[0];
    if (!t) return;
    t.mesh.visible = false;
    this._free.push(t);
  }

  clear() {
    for (const t of this.items) { t.mesh.visible = false; this._free.push(t); }
    this.items.length = 0;
  }
}
