import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TILE, CEIL_H } from './Grid.js';
import { portalTex, glowTex } from './Textures.js';
import { propColors, glowGeo, GeoAcc } from './Props.js';

// Primitives for the gate frame, authored origin-on-floor to match GeoAcc's convention.
const BOX = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
const CONE4 = new THREE.ConeGeometry(0.5, 1, 4).translate(0, 0.5, 0);
const CONE6 = new THREE.ConeGeometry(0.5, 1, 6).translate(0, 0.5, 0);
const CYL8 = new THREE.CylinderGeometry(0.5, 0.26, 1, 8).translate(0, 0.5, 0);
const ICO = new THREE.IcosahedronGeometry(0.5, 0).translate(0, 0.5, 0);

/**
 * A spawn is not a marker, it is a *gate*: a walled-up arch with a breach hanging in it,
 * flanked by braziers and warning skulls, with a runway of glowing floor stripes pointing
 * the way the horde will run.
 *
 * It has three states and you must be able to tell them apart from across the map:
 *   dormant  (build phase) — dim, slow, cold, closed
 *   charging (wave telegraph, ~2s) — spins up, brightens, ground pulses outward
 *   open     (wave running) — full brightness, fast churn, embers spitting
 */
export class SpawnGate {
  constructor(game, marker, def, colors) {
    this.game = game;
    this.marker = marker;
    this.def = def;
    const p = def.palette || {};
    this.pal = p;
    const c = colors || propColors(p.theme || 'keep', p);
    this.glow = new THREE.Color(p.spawnGlow ?? 0xff3b1f);

    this.object = new THREE.Group();
    game.grid.toWorld(marker.gx, marker.gz, this.object.position);
    // Face the direction orcs walk out of, so the arch frames the route.
    const dirAngle = { N: Math.PI, E: Math.PI / 2, S: 0, W: -Math.PI / 2 };
    this.object.rotation.y = dirAngle[marker.dir] ?? 0;

    this.state = 'dormant';
    this._t = 0;
    this._charge = 0;
    this._seed = marker.id * 7.3;

    this._buildFrame(c);
    this._buildMembrane();
    this._buildRunway();

    this.light = new THREE.PointLight(this.glow, 3.0, 22, 2);
    this.light.position.set(0, 2.4, 0.4);
    this.object.add(this.light);

    this._un = [
      game.bus.on('wave:start', () => this.setState('charging')),
      game.bus.on('phase:build', () => this.setState('dormant')),
      game.bus.on('wave:clear', () => this.setState('dormant')),
    ];
  }

  /**
   * Stone arch, jambs, iron teeth and a pair of flame bowls — all seventeen pieces baked
   * into **one** vertex-coloured mesh.
   *
   * This used to be seventeen separate meshes, which on The Black Throne's six gates alone
   * was a hundred draw calls of scenery that never moves. Vertex colours let stone and iron
   * share one material, so the whole gate is one call, and the flames one more.
   */
  _buildFrame(c) {
    const acc = new GeoAcc('spawn-gate');
    // Jambs sit exactly on the cell boundary so they intrude only 0.35u into the
    // neighbouring cell — the mouth stays 3.3u wide, four orc-diameters of clearance.
    const W = TILE * 0.5, H = CEIL_H - 0.4;
    for (const s of [-1, 1]) {
      acc.add(BOX, c.stoneDark, { x: s * W, y: 0, sx: 0.7, sy: H, sz: 1.5, shadeY: 0.35 });
      acc.add(BOX, c.stone, { x: s * W, y: H, sx: 1.0, sy: 0.5, sz: 1.9 });
      // Teeth flanking the mouth — the "do not stand here" cue.
      for (let i = 0; i < 3; i++) {
        acc.add(CONE4, c.ironDark, { x: s * (W - 0.5), y: 0.45 + i * 1.5, z: 0.75, sx: 0.32, sy: 0.9, rx: -0.5 });
      }
      // Flame bowl on top of each jamb.
      acc.add(CYL8, c.iron, { x: s * W, y: H + 0.2, sx: 1.0, sy: 0.4 });
    }
    // Lintel, stepped.
    for (let k = 0; k < 3; k++) {
      acc.add(BOX, k === 1 ? c.ironDark : c.stoneDark, {
        y: H + 0.55 + k * 0.34, sx: W * 2.3 - k * 0.7, sy: 0.34, sz: 1.7 - k * 0.2,
      });
    }
    acc.add(ICO, c.stone, { y: H + 0.15, z: 0.5, sx: 0.84 });

    this.stoneMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.12 });
    this._mats = [this.stoneMat];
    const frame = new THREE.Mesh(acc.build(), this.stoneMat);
    frame.castShadow = true; frame.receiveShadow = true;
    this.object.add(frame);
    this.frame = frame;

    // Both bowl flames in one mesh: they burn in sync anyway, and the pulse is carried by
    // the shared material rather than by per-mesh scale.
    //
    // Built from the same nested-shell flame as every sconce in the level, not a cone: a
    // single additive cone is uniformly emissive over its own surface, so all of its
    // apparent structure comes from the tone curve and the bloom halo rather than from
    // the flame. The shells carry a hot core and a cool envelope in the geometry itself.
    // Note this cannot go through GeoAcc: `add()` bakes one flat colour over the whole
    // part, which is exactly the gradient we are here to keep. The shells are authored in
    // near-neutral values so the material's own `color` (the gate's glow) still carries
    // the hue, and the geometry carries the heat.
    const fGeo = glowGeo('flame', { glow: 0xffffff, ember: 0xff9a5a });
    const fParts = [];
    for (const s of [-1, 1]) {
      const g = fGeo.clone();
      g.applyMatrix4(new THREE.Matrix4().makeScale(1.9, 1.5, 1.9).setPosition(s * W, H + 0.5, 0));
      fParts.push(g);
    }
    fGeo.dispose();
    this.flameMat = new THREE.MeshBasicMaterial({
      color: this.glow, transparent: true, opacity: 0.9, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this._mats.push(this.flameMat);
    const fMerged = mergeGeometries(fParts, false);
    for (const g of fParts) g.dispose();
    this.flames = new THREE.Mesh(fMerged ?? CONE6.clone(), this.flameMat);
    this.flames.renderOrder = 3;
    this.object.add(this.flames);
  }

  /** The breach itself: a churning disc set back inside the arch. */
  _buildMembrane() {
    const tex = portalTex();
    this.memMat = new THREE.MeshBasicMaterial({
      map: tex, color: this.glow, transparent: true, opacity: 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this._mats.push(this.memMat);
    this.membrane = new THREE.Mesh(new THREE.PlaneGeometry(TILE * 1.15, CEIL_H - 0.9), this.memMat);
    this.membrane.position.set(0, (CEIL_H - 0.9) / 2, -0.35);
    this.membrane.renderOrder = 3;
    this.object.add(this.membrane);

    // A second, counter-rotating copy sells depth without a shader.
    this.memMat2 = this.memMat.clone();
    this.memMat2.opacity = 0.5;
    this._mats.push(this.memMat2);
    this.membrane2 = new THREE.Mesh(new THREE.PlaneGeometry(TILE * 0.8, CEIL_H - 1.6), this.memMat2);
    this.membrane2.position.set(0, (CEIL_H - 0.9) / 2, -0.2);
    this.membrane2.renderOrder = 4;
    this.object.add(this.membrane2);
  }

  /** Glowing floor stripes running out of the gate — reads as "they come from here". */
  _buildRunway() {
    const tex = glowTex();
    this.runMat = new THREE.MeshBasicMaterial({
      map: tex, color: this.glow, transparent: true, opacity: 0.0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._mats.push(this.runMat);
    // Four stripes, one mesh. Scaling the mesh as a whole makes the runway *grow* down the
    // route, which telegraphs the direction better than four independently pulsing cards.
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const g = new THREE.PlaneGeometry(TILE * 1.1, TILE * (0.5 - i * 0.06));
      g.rotateX(-Math.PI / 2);
      g.translate(0, 0.04, TILE * (0.7 + i * 0.85));
      parts.push(g);
    }
    const runGeo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    this.runway = new THREE.Mesh(runGeo, this.runMat);
    this.runway.renderOrder = 2;
    this.object.add(this.runway);

    // A pool of light on the floor directly under the arch, always on.
    this.poolMat = new THREE.MeshBasicMaterial({
      map: tex, color: this.glow, transparent: true, opacity: 0.4,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._mats.push(this.poolMat);
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(TILE * 2.4, TILE * 2.4), this.poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.03;
    pool.renderOrder = 1;
    this.object.add(pool);
    this.pool = pool;
  }

  setState(s) {
    if (this.state === s) return;
    this.state = s;
    if (s === 'charging') this._charge = 0;
  }

  update(dt, t) {
    this._t += dt;
    // Charge ramps to 1 over ~1.6s then latches open for the rest of the wave.
    const want = this.state === 'dormant' ? 0 : 1;
    this._charge += (want - this._charge) * Math.min(1, dt * (want ? 1.6 : 3.0));
    const k = this._charge;

    const spin = 0.35 + k * 2.4;
    const pump = 1 + Math.sin(this._t * (2 + k * 6) + this._seed) * (0.03 + k * 0.05);
    this.membrane.scale.set(pump, pump, 1);
    this.membrane2.scale.set(2 - pump, 2 - pump, 1);
    this.membrane2.rotation.z -= dt * spin * 0.6;
    this.membrane.rotation.z += dt * spin * 0.35;

    this.memMat.opacity = 0.35 + k * 0.6;
    this.memMat2.opacity = 0.18 + k * 0.45;
    this.poolMat.opacity = 0.16 + k * 0.42;

    // The runway breathes outward down the route while a wave is live.
    this.runMat.opacity = k * 0.5;
    const chase = 0.86 + 0.14 * Math.sin(this._t * 2.6);
    this.runway.scale.set(1, 1, chase * (0.85 + k * 0.25));

    // Flicker lives entirely in the shared material: the two flames are one merged mesh, so
    // scaling it would slide them along the lintel instead of making them dance.
    const flick = 0.8 + 0.2 * Math.sin(this._t * 12 + this._seed);
    this.flameMat.opacity = (0.45 + k * 0.5) * flick;

    this.light.intensity = (1.2 + k * 4.5) * flick;
    this.light.distance = 16 + k * 12;
  }

  dispose() {
    for (const u of this._un) u();
    this.object.traverse((o) => { o.geometry?.dispose?.(); });
    for (const m of this._mats) m.dispose();
    this.object.parent?.remove(this.object);
  }
}
