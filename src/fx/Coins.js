import * as THREE from 'three';
import { v0, v1, q0, e0, m0 } from '../shared/scratch.js';

/**
 * The payout. Coins and skulls burst off a corpse, arc, bounce once, then swoop to the
 * player and land with a ka-ching whose pitch climbs through the chain.
 *
 * This is the single loudest piece of feedback in the game: the trap kills, and then a
 * fistful of gold *comes to you*. The travel time is deliberate — roughly a third of a
 * second of arc before homing — because the delay is what turns one kill into a little
 * event with a beginning and an end.
 *
 * One InstancedMesh, unlit material so gold reads on a dark flagstone floor at any light
 * level, flat typed-array state, zero allocation per coin per frame.
 */
const CAP = 320;

export class CoinSystem {
  constructor(scene, { onCollect = null, onTrail = null } = {}) {
    this.capacity = CAP;
    this.cursor = 0;
    this.onCollect = onCollect;
    this.onTrail = onTrail;

    // Disc standing in the XY plane so a spin about Y flashes edge-on under a 52° camera.
    const geo = new THREE.CylinderGeometry(0.26, 0.26, 0.09, 10, 1).rotateX(Math.PI / 2);
    // Lit metal, not a flat sprite: the shaded rim against the bright face is what makes
    // a spinning disc read as *gold* rather than as a yellow blob.
    this.material = new THREE.MeshStandardMaterial({ metalness: 0.5, roughness: 0.42, flatShading: true });
    // ...plus per-instance self-illumination in its own hue, so a coin sailing through a
    // shadowed corridor is still the brightest thing on screen.
    this.material.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vColor * 0.32;',
      );
    };
    this.mesh = new THREE.InstancedMesh(geo, this.material, CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.mesh.count = 0;
    scene.add(this.mesh);

    this.px = new Float32Array(CAP); this.py = new Float32Array(CAP); this.pz = new Float32Array(CAP);
    this.vx = new Float32Array(CAP); this.vy = new Float32Array(CAP); this.vz = new Float32Array(CAP);
    this.spin = new Float32Array(CAP); this.phase = new Float32Array(CAP);
    this.scale = new Float32Array(CAP);
    this.cr = new Float32Array(CAP); this.cg = new Float32Array(CAP); this.cb = new Float32Array(CAP);
    this.age = new Float32Array(CAP).fill(1e9);
    this.arcT = new Float32Array(CAP);
    this.bounced = new Uint8Array(CAP);
    this.value = new Float32Array(CAP);
    this.live = 0;
    this._target = new THREE.Vector3();
  }

  setTarget(pos) { this._target.set(pos.x, pos.y + 1.0, pos.z); }

  /**
   * @param kind 'coin' (gold disc) | 'skull' (bigger, bone) — skulls mark elites and bosses
   */
  spray(pos, count, { kind = 'coin', value = 1, spread = 1 } = {}) {
    const gold = kind !== 'skull';
    for (let i = 0; i < count; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % CAP;
      const a = Math.random() * Math.PI * 2;
      const s = (2.6 + Math.random() * 4.2) * spread;
      this.px[k] = pos.x; this.py[k] = pos.y + 0.9; this.pz[k] = pos.z;
      this.vx[k] = Math.cos(a) * s;
      this.vy[k] = 6.5 + Math.random() * 5;
      this.vz[k] = Math.sin(a) * s;
      this.spin[k] = (12 + Math.random() * 14) * (Math.random() < 0.5 ? -1 : 1);
      this.phase[k] = Math.random() * 6.28;
      this.scale[k] = gold ? 0.9 + Math.random() * 0.35 : 1.9;
      // Values are pre-sRGB, so the green/blue have to sit low or gold comes out cream.
      const j = 0.85 + Math.random() * 0.3;
      if (gold) { this.cr[k] = 0.95 * j; this.cg[k] = 0.36 * j; this.cb[k] = 0.03 * j; }
      else { this.cr[k] = 0.78; this.cg[k] = 0.75; this.cb[k] = 0.58; }
      this.age[k] = 0;
      this.arcT[k] = 0.28 + Math.random() * 0.26;
      this.bounced[k] = 0;
      this.value[k] = value;
    }
  }

  update(dt, elapsed) {
    if (dt <= 0) dt = 1e-4;
    const mat = this.mesh.instanceMatrix.array;
    const col = this.mesh.instanceColor.array;
    const tx = this._target.x, ty = this._target.y, tz = this._target.z;
    let n = 0;

    for (let k = 0; k < CAP; k++) {
      let age = this.age[k];
      if (age > 1e8) continue;
      age += dt; this.age[k] = age;

      if (age < this.arcT[k]) {
        // --- arc: it has to leave the corpse before it can come to you ---
        this.vy[k] -= 30 * dt;
        this.px[k] += this.vx[k] * dt;
        this.py[k] += this.vy[k] * dt;
        this.pz[k] += this.vz[k] * dt;
        if (this.py[k] < 0.22 && this.vy[k] < 0) {
          this.py[k] = 0.22;
          this.vy[k] *= -0.42;
          this.vx[k] *= 0.7; this.vz[k] *= 0.7;
          this.bounced[k] = 1;
        }
      } else {
        // --- home: blend velocity toward the player so the path curves in, not snaps ---
        const dx = tx - this.px[k], dy = ty - this.py[k], dz = tz - this.pz[k];
        const d = Math.hypot(dx, dy, dz) || 1;
        if (d < 1.1 || age > 4.5) {
          this.age[k] = 1e9;
          this.onCollect?.(this.value[k], this.px[k], this.py[k], this.pz[k], this.scale[k] > 1.4);
          continue;
        }
        // Speed ramps with time in flight: slow pull, then a satisfying snap at the end.
        const t = age - this.arcT[k];
        const want = Math.min(30, 7 + t * 34);
        const blend = Math.min(1, dt * (5 + t * 9));
        this.vx[k] += ((dx / d) * want - this.vx[k]) * blend;
        this.vy[k] += ((dy / d) * want - this.vy[k]) * blend;
        this.vz[k] += ((dz / d) * want - this.vz[k]) * blend;
        this.px[k] += this.vx[k] * dt;
        this.py[k] += this.vy[k] * dt;
        this.pz[k] += this.vz[k] * dt;
        // Sparse sparkle trail — every 8th coin, so a big payout glitters without a haze.
        if (this.onTrail && (k & 7) === 0 && Math.random() < dt * 30) {
          this.onTrail(this.px[k], this.py[k], this.pz[k], this.cr[k], this.cg[k], this.cb[k]);
        }
      }

      const s = this.scale[k];
      e0.set(Math.sin(elapsed * 3 + this.phase[k]) * 0.5, elapsed * this.spin[k] + this.phase[k], 0);
      q0.setFromEuler(e0);
      v0.set(this.px[k], this.py[k], this.pz[k]);
      m0.compose(v0, q0, v1.set(s, s, s));
      m0.toArray(mat, n * 16);
      col[n * 3] = this.cr[k]; col[n * 3 + 1] = this.cg[k]; col[n * 3 + 2] = this.cb[k];
      n++;
    }

    this.live = n;
    this.mesh.count = n;
    if (n > 0 || this._wasLive) {
      this.mesh.instanceMatrix.needsUpdate = true;
      this.mesh.instanceColor.needsUpdate = true;
    }
    this._wasLive = n > 0;
  }

  clear() { this.age.fill(1e9); this.mesh.count = 0; this.live = 0; }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}
