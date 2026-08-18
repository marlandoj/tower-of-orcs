import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { TILE, CEIL_H } from './Grid.js';
import { runeRingTex, riftPoolTex, portalTex } from './Textures.js';
import { propColors, GeoAcc } from './Props.js';

/**
 * The thing you are defending.
 *
 * Design rules, in priority order:
 *  1. Findable from anywhere — a sky beam and a floor pool nothing else on the map has.
 *  2. Precious — carved dais, rune ring, guardian pylons, chains. It looks *built for*,
 *     not dropped in. You should not want to lose it before you know the rules.
 *  3. Legible health — a segmented ring at the base is a literal HP bar you read from
 *     across the arena, and each lost point visibly wrecks the shrine: a pylon topples,
 *     the runes go dark, the light turns from its palette colour to arterial red.
 *
 * ---
 *
 * ### The additive stack, and why it is now the size it is
 *
 * This was the single element a blind critic ranked worst in the game: *"a translucent
 * screen-space veil that fogs and desaturates everything behind it — a milky slab fogging
 * the entire right half."* It was the one emissive surface still outside the campaign tone
 * contract; pits and portals had been brought in, this never was.
 *
 * The mechanism is worth writing down, because it is not obvious and it recurs. Five
 * additive, `depthWrite:false` planes were stacked over the same patch of arena — a
 * 14-metre floor pool, a 26-metre double-sided beam, the membrane disc, the rune ring and
 * the HP ring — each at low alpha and each with soft edges reaching all the way to its own
 * quad border. Additively that sums to a sheet: it lifts the black point of everything
 * under it and pulls every channel toward the glow colour, so measured saturation *drops*
 * across the region. Low alpha over large area is fog. There is no alpha low enough to fix
 * it, because area is the term that is wrong.
 *
 * Three rules now hold the stack, and any new layer has to obey all three:
 *
 *   1. **Area is the budget, not alpha.** The pool went 14.4m -> 8.4m and the beam lost its
 *      `DoubleSide` (which was silently doubling its contribution on every pixel).
 *   2. **Every additive surface must reach zero before its own edge.** `riftPoolTex` has a
 *      hard vignette and the beam has a vertex-colour ramp to black at the top — under
 *      additive blending a black vertex is exactly alpha zero, and it costs nothing.
 *   3. **Light is spent on structure.** Rings, rays, and a hot small hub, not a gaussian.
 *      The same photons arranged as edges read as a light source; spread flat they read as
 *      a dirty lens.
 *
 * And the colour itself is now on the ladder: `palette.riftColor` and `palette.riftPower`
 * come out of `tone()` like every other emitter, so the rift can no longer be a stop and a
 * half brighter than the level it stands in just because nobody re-measured it.
 */
export class Rift {
  constructor(game, cell, def) {
    this.game = game;
    this.max = def.riftHp ?? 20;
    this.hp = this.max;
    this.object = new THREE.Group();
    this.object.name = 'rift';
    if (cell) game.grid.toWorld(cell.gx, cell.gz, this.object.position);
    this.cell = cell;

    const p = def.palette || {};
    const c = propColors(p.theme || 'keep', p);
    // `riftColor` is the contracted one; `riftGlow` is the authored hue it was cut from.
    // Falling back to the latter keeps a hand-built def without a toned palette working.
    const glow = p.riftColor ?? p.riftGlow ?? 0x53d0ff;
    this.power = p.riftPower ?? 1;
    this.glowColor = new THREE.Color(glow);
    this.hurtColor = new THREE.Color(0xff2a14);
    this._mats = [];
    this._geos = [];

    this._buildDais(c, glow);
    this._buildPylons(c, glow);
    this._buildCore(glow);
    this._buildHpRing(glow);
    this._buildBeam(glow);

    // Range came down from 34. At 34 the point light alone reached most of a rift hall,
    // which is a second, invisible copy of the same veil: every surface in the room tinted
    // one hue with no falloff you could read as a shape.
    this.light = new THREE.PointLight(glow, 4.2 * this.power, 26, 2);
    this.light.position.y = 2.6;
    this.object.add(this.light);

    this._shakeT = 0;
    this._flashT = 0;
    this._t = 0;
    this._basePos = this.object.position.clone();

    this._un = [game.bus.on('enemy:leaked', (ev) => this.damage(ev.cost ?? 1))];
  }

  /** Three stepped octagonal tiers with a glowing rune ring inlaid in the top. */
  _buildDais(c, glow) {
    // One vertex-coloured mesh for all three tiers. The rift is on screen for the whole
    // level, so every mesh it does not need is a draw call the orcs get to spend instead.
    const acc = new GeoAcc('rift-dais');
    const tier = (rTop, rBot, h, y, col) => {
      const g = new THREE.CylinderGeometry(rTop, rBot, 1, 8).translate(0, 0.5, 0);
      acc.add(g, col, { y, sy: h });
      g.dispose();
    };
    // Kept just over one cell wide: big enough to read as a shrine, small enough that
    // orcs converging on the rift do not visibly wade through the masonry.
    tier(TILE * 0.74, TILE * 0.80, 0.24, 0, c.stoneDark);
    tier(TILE * 0.62, TILE * 0.68, 0.26, 0.24, c.stone);
    tier(TILE * 0.50, TILE * 0.56, 0.28, 0.50, c.stoneDark);
    const daisMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.89, metalness: 0.05 });
    const dais = new THREE.Mesh(acc.build(), daisMat);
    dais.castShadow = true; dais.receiveShadow = true;
    this.object.add(dais);
    this._geos.push(dais.geometry); this._mats.push(daisMat);

    // Rune ring inlaid into the top tier — additive so it survives the fog.
    this.runeMat = new THREE.MeshBasicMaterial({
      map: runeRingTex(), color: glow, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const runes = new THREE.Mesh(new THREE.PlaneGeometry(TILE * 1.5, TILE * 1.5), this.runeMat);
    runes.rotation.x = -Math.PI / 2;
    runes.position.y = 0.79;
    runes.renderOrder = 2;
    this.object.add(runes);
    this.runes = runes;
    this._mats.push(this.runeMat);

    // Floor pool: the halo that tells you where the rift is from off screen. Two thirds of
    // its old width and a structured texture — rings and rays that stop dead well inside
    // the quad — instead of a gaussian that reached the border at non-zero alpha.
    this.poolMat = new THREE.MeshBasicMaterial({
      map: riftPoolTex(), color: glow, transparent: true, opacity: 0.42,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const pool = new THREE.Mesh(new THREE.PlaneGeometry(TILE * 2.1, TILE * 2.1), this.poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.y = 0.025;
    pool.renderOrder = 1;
    this.object.add(pool);
    this.pool = pool;
    this._mats.push(this.poolMat);

    // The breach membrane sitting in the well of the dais.
    this.discMat = new THREE.MeshBasicMaterial({
      map: portalTex(), color: glow, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(TILE * 0.58, 32), this.discMat);
    this.disc.rotation.x = -Math.PI / 2;
    this.disc.position.y = 0.82;
    this.disc.renderOrder = 3;
    this.object.add(this.disc);
    this._mats.push(this.discMat);
  }

  /** Four guardian pylons, chained to the core. They fall as the rift dies. */
  _buildPylons(c, glow) {
    this.pylons = [];
    const stone = new THREE.MeshStandardMaterial({ color: c.stoneDark, roughness: 0.85, metalness: 0.08 });
    const capMat = new THREE.MeshStandardMaterial({ color: glow, emissive: glow, emissiveIntensity: 1.1, roughness: 0.35 });
    this._mats.push(stone, capMat);
    // On the diagonals, straddling the corner where four cells meet — the one spot on
    // the board that no orc's flow vector routes through.
    const R = TILE * 0.80;
    // Shaft and cap share one mesh per pylon: each pylon still needs its own transform
    // (they topple independently as the rift dies) but not two draw calls to do it.
    const shaftGeo = new THREE.CylinderGeometry(0.26, 0.42, 3.6, 5).translate(0, 1.8, 0);
    const capGeo = new THREE.OctahedronGeometry(0.42, 0).translate(0, 3.9, 0);
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const g = new THREE.Group();
      g.position.set(Math.cos(a) * R, 0.2, Math.sin(a) * R);
      g.rotation.y = -a;
      const shaft = new THREE.Mesh(shaftGeo, stone);
      shaft.castShadow = true;
      g.add(shaft);
      const cap = new THREE.Mesh(capGeo, capMat);
      g.add(cap);
      this.object.add(g);
      this.pylons.push({ group: g, cap, baseY: 0.2, fallen: false, seed: i * 1.7, angle: a });
    }
    this._geos.push(shaftGeo, capGeo);
  }

  /** Floating core plus counter-rotating rings, the only fast motion on the board. */
  _buildCore(glow) {
    this.coreMat = new THREE.MeshStandardMaterial({
      color: glow, emissive: glow, emissiveIntensity: 1.02, roughness: 0.2, metalness: 0.1,
    });
    this._mats.push(this.coreMat);
    this.core = new THREE.Mesh(new THREE.OctahedronGeometry(0.8, 1), this.coreMat);
    this.core.position.y = 2.6;
    this.object.add(this.core);
    this._geos.push(this.core.geometry);

    this.shardMat = new THREE.MeshStandardMaterial({
      color: glow, emissive: glow, emissiveIntensity: 1.2, roughness: 0.3,
    });
    this._mats.push(this.shardMat);
    // Six orbiting shards baked into one mesh that spins as a unit. Individually animated
    // shards were six draw calls for motion nobody can read apart at this camera distance;
    // the varied radii and heights survive the merge, which is what actually sells it.
    const parts = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const r = 1.7 + (i % 3) * 0.35;
      const g = new THREE.ConeGeometry(0.17, 0.6, 4);
      g.rotateZ(a * 0.7);
      g.translate(Math.cos(a) * r, 2.1 + (i % 2) * 0.9, Math.sin(a) * r);
      parts.push(g);
    }
    const shardGeo = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    this.shards = new THREE.Mesh(shardGeo, this.shardMat);
    this.object.add(this.shards);
    this._geos.push(shardGeo);

    // Two counter-rotating ring assemblies rather than three independent rings: two is
    // enough for the counter-rotation to read, and it costs one draw call each.
    this.rings = [];
    const ringMat = () => new THREE.MeshStandardMaterial({ color: glow, emissive: glow, emissiveIntensity: 1.5, roughness: 0.3 });
    const bands = [[0, 2], [1]];   // which radii ride on which assembly
    for (let a = 0; a < bands.length; a++) {
      const parts = [];
      for (const i of bands[a]) {
        const g = new THREE.TorusGeometry(TILE * (0.5 + i * 0.13), 0.08, 6, 30);
        g.rotateX(Math.PI / 2 + (i - 1) * 0.24);
        g.translate(0, 1.5 + i * 0.85, 0);
        parts.push(g);
      }
      const geo = parts.length > 1 ? mergeGeometries(parts, false) : parts[0];
      if (parts.length > 1) for (const g of parts) g.dispose();
      const m = ringMat();
      const r = new THREE.Mesh(geo, m);
      this.object.add(r);
      this._geos.push(geo); this._mats.push(m);
      this.rings.push({ mesh: r, mat: m, speed: a ? -0.75 : 0.5 });
    }
  }

  /**
   * The HP bar, as architecture: one lit segment per remaining rift point, laid in a ring
   * around the dais. Segments are quads in a single geometry whose vertex colours we
   * rewrite on damage, so the whole readout is one draw call.
   */
  _buildHpRing(glow) {
    const n = Math.min(this.max, 24);
    this.hpSegments = n;
    const r0 = TILE * 0.86, r1 = TILE * 1.02;
    const pos = [], col = [], idx = [];
    const gap = 0.16;
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2 + gap / 2;
      const a1 = ((i + 1) / n) * Math.PI * 2 - gap / 2;
      const v = pos.length / 3;
      pos.push(Math.cos(a0) * r0, 0, Math.sin(a0) * r0);
      pos.push(Math.cos(a1) * r0, 0, Math.sin(a1) * r0);
      pos.push(Math.cos(a1) * r1, 0, Math.sin(a1) * r1);
      pos.push(Math.cos(a0) * r1, 0, Math.sin(a0) * r1);
      for (let k = 0; k < 4; k++) col.push(1, 1, 1);
      idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    this.hpMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.hpRing = new THREE.Mesh(geo, this.hpMat);
    this.hpRing.position.y = 0.06;
    this.hpRing.renderOrder = 4;
    this.object.add(this.hpRing);
    this._geos.push(geo); this._mats.push(this.hpMat);
    this._paintHp();
  }

  _paintHp() {
    const g = this.hpRing.geometry;
    const col = g.attributes.color;
    const n = this.hpSegments;
    const lit = Math.ceil((this.hp / this.max) * n);
    const c = this.glowColor;
    for (let i = 0; i < n; i++) {
      const on = i < lit;
      const r = on ? c.r : 0.10, gg = on ? c.g : 0.06, b = on ? c.b : 0.08;
      for (let k = 0; k < 4; k++) {
        const v = i * 4 + k;
        col.setXYZ(v, r, gg, b);
      }
    }
    col.needsUpdate = true;
  }

  /** Sky beam. Narrow and steady when healthy, wide and stuttering when dying. */
  _buildBeam(glow) {
    /**
     * Three things were wrong with this and all three were area, not brightness.
     *
     * It was 26 metres tall, so at a 50-degree camera it swept a long diagonal band across
     * the frame; it was `DoubleSide`, so every pixel of that band got the additive
     * contribution *twice*, front wall and back wall; and it had uniform opacity top to
     * bottom, so it had a hard end in mid-air that the eye reads as a sheet rather than as
     * light leaving the ground.
     *
     * Now: shorter, single-sided, and the vertex colours ramp to black at the top. Under
     * additive blending a black vertex contributes exactly nothing, so this is a real alpha
     * gradient for the price of a buffer attribute and no second material.
     */
    const H = 17;
    const geo = new THREE.CylinderGeometry(TILE * 0.10, TILE * 0.26, H, 14, 4, true);
    const pos = geo.attributes.position;
    const col = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      // y runs -H/2 .. +H/2 on the cylinder; 1 at the base, 0 by two thirds of the way up.
      const t = (pos.getY(i) + H / 2) / H;
      const k = Math.max(0, 1 - t / 0.66) ** 1.6;
      col[i * 3] = k; col[i * 3 + 1] = k; col[i * 3 + 2] = k;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.beamMat = new THREE.MeshBasicMaterial({
      color: glow, transparent: true, opacity: 0.09, vertexColors: true,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.beam = new THREE.Mesh(geo, this.beamMat);
    this.beam.position.y = H / 2 + 0.6;
    this.object.add(this.beam);
    this._geos.push(geo); this._mats.push(this.beamMat);
  }

  damage(n) {
    if (this.hp <= 0) return;
    this.hp = Math.max(0, this.hp - n);
    this._shakeT = 0.45;
    this._flashT = 0.55;
    this._paintHp();

    // Distress escalates in visible steps: a pylon topples at each quarter lost.
    const frac = this.hp / this.max;
    const shouldStand = Math.ceil(frac * 4);
    for (let i = 0; i < this.pylons.length; i++) {
      const p = this.pylons[i];
      if (!p.fallen && i >= shouldStand) {
        p.fallen = true;
        p.fallT = 0;
        this.game.fx?.dust?.(
          this.object.position.clone().add(new THREE.Vector3(Math.cos(p.angle) * TILE * 0.92, 0.4, Math.sin(p.angle) * TILE * 0.92)),
          2.4,
        );
      }
    }

    this.game.fx.shake(0.5, 0.3);
    this.game.audio.play('rift.hit', { position: this.object.position });
    this.game.fx.flash('#ff2b12', 0.25, 0.28);
    this.game.bus.emit('rift:damaged', { remaining: this.hp, max: this.max });
    if (this.hp <= 0) {
      this.game.bus.emit('game:defeat', { levelIndex: this.game.levelIndex, reason: 'rift' });
    }
  }

  update(dt) {
    const t = (this._t += dt);
    const frac = this.hp / this.max;
    const urgency = 1 - frac;

    for (const r of this.rings) r.mesh.rotation.y += dt * r.speed * (1 + urgency * 1.6);
    this.core.rotation.y += dt * 0.6;
    this.core.rotation.x += dt * 0.23;
    this.core.position.y = 2.6 + Math.sin(t * 1.4) * 0.16;

    this.shards.rotation.y += dt * 0.8 * (1 + urgency);
    this.shards.position.y = Math.sin(t * 1.7) * 0.22;

    // Pylons fall over the first second after they break, then stay down.
    for (const p of this.pylons) {
      if (!p.fallen) continue;
      p.fallT = Math.min(1, (p.fallT ?? 0) + dt * 1.6);
      const e = 1 - Math.pow(1 - p.fallT, 3);
      p.group.rotation.z = e * 1.42;
      p.group.position.y = p.baseY - e * 0.15;
      p.cap.visible = p.fallT < 0.8;
    }

    const pulse = 0.82 + Math.sin(t * (2 + urgency * 9)) * (0.10 + urgency * 0.16);
    this.disc.scale.setScalar(1 + Math.sin(t * 2.2) * 0.04);
    this.disc.rotation.z += dt * (0.3 + urgency * 1.2);
    this.runes.rotation.z -= dt * 0.12;

    // Health drives colour: palette glow -> arterial red as it dies.
    const mixT = Math.max(urgency * 0.9, this._flashT > 0 ? Math.min(1, this._flashT * 2) : 0);
    const col = _tmpCol.copy(this.glowColor).lerp(this.hurtColor, Math.min(1, mixT));
    this.discMat.color.copy(col);
    this.beamMat.color.copy(col);
    this.poolMat.color.copy(col);
    this.runeMat.color.copy(col);
    this.light.color.copy(col);
    this.coreMat.color.copy(col); this.coreMat.emissive.copy(col);
    this.shardMat.color.copy(col); this.shardMat.emissive.copy(col);
    for (const r of this.rings) { r.mat.color.copy(col); r.mat.emissive.copy(col); }

    // A dying rift gets *dimmer* as well as redder. Holding emissive flat while the colour
    // shifted made the death state the brightest thing in the campaign, which is backwards:
    // the light you are protecting should visibly be going out.
    // Emissive is held well under what it used to be. At 1.7 the core cleared the bloom
    // threshold by so much that the mip chain painted a white disc a fifth of the frame
    // wide: the rift stopped being an object and became an exposure problem, blowing the
    // highlights and dragging measured saturation *below* the campaign band because so
    // many pixels clipped to white. It still has to be the brightest thing on the board —
    // just by a stop, not by four.
    /**
     * The solid, *lit* half of the rift keeps its brightness — the core, the shards and
     * the rings are objects with edges and a silhouette, and they are what should be doing
     * the "this is the brightest thing on the board" job.
     *
     * The unlit additive half gets less. Concentrating the same read into a smaller,
     * structured pool means the alpha can come down without the rift getting quieter:
     * pool 0.11-0.22 -> 0.15-0.30 on a quad with a third of the area and a texture that
     * hits zero before its edge, and the beam a shade under what it was on a mesh that is
     * single-sided and ramps out. `power` folds in the contract's `riftPower` so a dark
     * level's rift is not a hole burned in the frame.
     */
    const P = this.power;
    const power = (0.35 + frac * 0.85) * P;
    this.coreMat.emissiveIntensity = 1.10 * power;
    this.shardMat.emissiveIntensity = 0.86 * power;
    for (const r of this.rings) r.mat.emissiveIntensity = 1.02 * power;
    this.light.intensity = 3.0 * P * pulse * (0.30 + frac * 0.70);
    this.discMat.opacity = (0.30 + Math.sin(t * 3.1) * 0.06) * (0.5 + frac * 0.5);
    this.runeMat.opacity = (0.22 + frac * 0.30) * pulse;
    this.poolMat.opacity = 0.15 + frac * 0.15;
    // A dying beam flickers: intermittent dropouts read as "about to go out".
    const stutter = urgency > 0.4 && Math.sin(t * 27) > 0.75 ? 0.25 : 1;
    this.beamMat.opacity = (0.05 + frac * 0.055) * pulse * stutter;
    this.beam.scale.set(1 + urgency * 0.5, 1, 1 + urgency * 0.5);

    if (this._flashT > 0) this._flashT -= dt;
    if (this._shakeT > 0) {
      this._shakeT -= dt;
      const s = this._shakeT * 1.3;
      this.object.position.set(
        this._basePos.x + (Math.random() - 0.5) * s,
        this._basePos.y,
        this._basePos.z + (Math.random() - 0.5) * s,
      );
      if (this._shakeT <= 0) this.object.position.copy(this._basePos);
    }
  }

  dispose() {
    for (const u of this._un) u();
    for (const g of this._geos) g.dispose?.();
    for (const m of this._mats) m.dispose?.();
    this._geos.length = 0; this._mats.length = 0;
    this.object.parent?.remove(this.object);
  }
}

const _tmpCol = new THREE.Color();
