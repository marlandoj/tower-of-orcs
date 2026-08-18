import * as THREE from 'three';
import { v0, v1, q0, e0, m0 } from '../shared/scratch.js';

/**
 * Real gib chunks: one InstancedMesh, pooled slots, CPU rigid-body-lite.
 *
 * Particles read as *spray*; a lump of meat that tumbles, hits the flagstones, skips once
 * and comes to rest reads as *a body coming apart*. That difference is most of what makes
 * a kill land, so chunks get actual geometry, actual bounces and actual shadows-free
 * flat-shaded volume rather than a billboard.
 *
 * Budget: 240 chunks, one draw call, ~20 tris each. State lives in flat typed arrays and
 * nothing is allocated after construction — a 250-orc pile-up just overwrites the ring.
 */
const CAP = 240;

export class GibSystem {
  constructor(scene, { onLand = null } = {}) {
    this.capacity = CAP;
    this.cursor = 0;
    this.onLand = onLand;

    const geo = chunkGeometry();
    this.material = new THREE.MeshStandardMaterial({
      roughness: 0.68, metalness: 0.05, flatShading: true,
    });
    // Per-chunk self-illumination in the chunk's own hue. The corridors are dim enough
    // that unlit gore disappears, and a flat emissive uniform would tint ice shards red.
    // Four lines of shader patch keeps every chunk type readable in one draw call.
    this.material.onBeforeCompile = (s) => {
      s.fragmentShader = s.fragmentShader.replace(
        '#include <emissivemap_fragment>',
        '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vColor * 0.22;',
      );
    };
    this.mesh = new THREE.InstancedMesh(geo, this.material, CAP);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(CAP * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = false;      // 240 shadow casters is not worth the depth pass
    this.mesh.receiveShadow = true;
    this.mesh.count = 0;
    scene.add(this.mesh);

    this.px = new Float32Array(CAP); this.py = new Float32Array(CAP); this.pz = new Float32Array(CAP);
    this.vx = new Float32Array(CAP); this.vy = new Float32Array(CAP); this.vz = new Float32Array(CAP);
    this.rx = new Float32Array(CAP); this.ry = new Float32Array(CAP); this.rz = new Float32Array(CAP);
    this.wx = new Float32Array(CAP); this.wy = new Float32Array(CAP); this.wz = new Float32Array(CAP);
    this.sx = new Float32Array(CAP); this.sy = new Float32Array(CAP); this.sz = new Float32Array(CAP);
    this.cr = new Float32Array(CAP); this.cg = new Float32Array(CAP); this.cb = new Float32Array(CAP);
    this.age = new Float32Array(CAP).fill(1e9);
    this.life = new Float32Array(CAP);
    this.bounces = new Uint8Array(CAP);
    this.wet = new Uint8Array(CAP);    // leaves a splat where it lands
    this.live = 0;
  }

  /**
   * @param opts.color  [r,g,b] linear-ish tint
   * @param opts.size   base chunk radius in metres
   * @param opts.flat   squash on Y — crushed bodies come apart in slabs, not cubes
   * @param opts.spin   angular energy multiplier
   * @param opts.wet    whether landing leaves a decal
   */
  burst(pos, dir, count, opts = {}) {
    const col = opts.color ?? [0.44, 0.11, 0.10];
    const size = opts.size ?? 0.3;
    const spread = opts.spread ?? 1;
    const up = opts.up ?? 7;
    const flat = opts.flat ?? 0;
    const spin = opts.spin ?? 1;
    const wet = opts.wet !== false;
    const dx = dir?.x ?? 0, dz = dir?.z ?? 0;

    for (let i = 0; i < count; i++) {
      const k = this.cursor;
      this.cursor = (this.cursor + 1) % CAP;
      const a = Math.random() * Math.PI * 2;
      const s = (4 + Math.random() * 7) * spread;

      this.px[k] = pos.x + (Math.random() - 0.5) * 0.5;
      this.py[k] = pos.y + 0.7 + Math.random() * 0.7;
      this.pz[k] = pos.z + (Math.random() - 0.5) * 0.5;
      this.vx[k] = Math.cos(a) * s + dx * 5;
      this.vy[k] = up * (0.5 + Math.random());
      this.vz[k] = Math.sin(a) * s + dz * 5;
      this.rx[k] = Math.random() * 6.28; this.ry[k] = Math.random() * 6.28; this.rz[k] = Math.random() * 6.28;
      this.wx[k] = (Math.random() - 0.5) * 22 * spin;
      this.wy[k] = (Math.random() - 0.5) * 22 * spin;
      this.wz[k] = (Math.random() - 0.5) * 22 * spin;

      // Wide size spread — a burst of identically sized lumps reads as debris, whereas a
      // couple of big pieces among a scatter of small ones reads as a body.
      const g = size * (0.42 + Math.random() ** 2 * 1.5);
      this.sx[k] = g * (0.8 + Math.random() * 0.7);
      this.sy[k] = g * (0.8 + Math.random() * 0.7) * (1 - flat * 0.72);
      this.sz[k] = g * (0.8 + Math.random() * 0.7);

      // Per-chunk value jitter so a burst is a spread of tones, not one flat colour.
      const j = 0.72 + Math.random() * 0.5;
      this.cr[k] = col[0] * j; this.cg[k] = col[1] * j; this.cb[k] = col[2] * j;

      this.age[k] = 0;
      // Long enough to still be lying there when the next rank walks over it, short
      // enough that the ring buffer never has to evict a chunk that is still in flight.
      this.life[k] = 5.5 + Math.random() * 3.5;
      this.bounces[k] = 0;
      this.wet[k] = wet ? 1 : 0;
    }
  }

  update(dt) {
    if (dt <= 0) dt = 1e-4;
    const mat = this.mesh.instanceMatrix.array;
    const col = this.mesh.instanceColor.array;
    let n = 0;

    for (let k = 0; k < CAP; k++) {
      let age = this.age[k];
      if (age > this.life[k]) continue;
      age += dt;
      this.age[k] = age;
      if (age > this.life[k]) continue;

      const settled = this.bounces[k] >= 200;
      if (!settled) {
        this.vy[k] -= 34 * dt;
        this.px[k] += this.vx[k] * dt;
        this.py[k] += this.vy[k] * dt;
        this.pz[k] += this.vz[k] * dt;
        this.rx[k] += this.wx[k] * dt; this.ry[k] += this.wy[k] * dt; this.rz[k] += this.wz[k] * dt;

        const rest = this.sy[k] * 0.6;
        if (this.py[k] <= rest) {
          this.py[k] = rest;
          if (this.bounces[k] === 0 && this.wet[k] && this.onLand) {
            v0.set(this.px[k], 0, this.pz[k]);
            this.onLand(v0, this.cr[k], this.cg[k], this.cb[k]);
          }
          this.bounces[k]++;
          if (this.vy[k] < -1.4 && this.bounces[k] < 4) {
            this.vy[k] *= -0.34;               // skip, don't stick — meat is not a brick
            this.vx[k] *= 0.62; this.vz[k] *= 0.62;
            this.wx[k] *= 0.5; this.wy[k] *= 0.5; this.wz[k] *= 0.5;
          } else {
            // Come to rest lying down, slightly flattened. Chunks standing on a corner
            // look like debris; chunks lying flat look like remains.
            this.bounces[k] = 200;
            this.vx[k] = this.vy[k] = this.vz[k] = 0;
            this.wx[k] = this.wy[k] = this.wz[k] = 0;
            this.rx[k] = Math.PI * 0.5 * Math.round(this.rx[k] / (Math.PI * 0.5));
            this.rz[k] = 0;
            this.sy[k] *= 0.72;
            this.py[k] = this.sy[k] * 0.6;
          }
        }
      }

      // Shrink out over the last 0.7 s so nothing ever pops.
      const left = this.life[k] - age;
      const f = left < 0.7 ? left / 0.7 : 1;

      e0.set(this.rx[k], this.ry[k], this.rz[k]);
      q0.setFromEuler(e0);
      v0.set(this.px[k], this.py[k], this.pz[k]);
      v1.set(this.sx[k] * f, this.sy[k] * f, this.sz[k] * f);
      m0.compose(v0, q0, v1);
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

  clear() {
    this.age.fill(1e9);
    this.mesh.count = 0;
    this.live = 0;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.parent?.remove(this.mesh);
  }
}

/** One irregular 20-tri lump. Per-instance non-uniform scale supplies the variety. */
function chunkGeometry() {
  // Polyhedron geometries already come back non-indexed, and calling toNonIndexed() on
  // one just logs a warning. Guard it so a real merge warning is never lost in the noise.
  const base = new THREE.IcosahedronGeometry(0.5, 0);
  const g = base.index ? base.toNonIndexed() : base;
  const p = g.attributes.position;
  // Jitter the shared source shape once so chunks never read as tiny spheres.
  const seen = new Map();
  for (let i = 0; i < p.count; i++) {
    const key = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    let j = seen.get(key);
    if (!j) {
      j = [0.42 + Math.random() * 1.05, 0.42 + Math.random() * 1.05, 0.42 + Math.random() * 1.05];
      seen.set(key, j);
    }
    p.setXYZ(i, p.getX(i) * j[0], p.getY(i) * j[1], p.getZ(i) * j[2]);
  }
  g.computeVertexNormals();
  return g;
}
