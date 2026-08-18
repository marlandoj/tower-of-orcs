import { clamp, damp, lerp, angleDelta, TAU } from '../../shared/rng.js';

/**
 * Procedural animation for a five-node orc. No keyframes, no skinning — but the goal is
 * still *weight*, which a sine wave cannot give you:
 *
 *   - the foot is planted for 60% of the cycle and swings through in 40%, so the orc
 *     pushes off the ground instead of paddling above it;
 *   - the body drops a few centimetres on each touchdown (two dips per cycle) and rolls
 *     onto the supporting leg;
 *   - hips and shoulders counter-rotate, and the torso *lags* the hips — the heavier the
 *     archetype, the more it lags, which is most of what "lumbering" actually is;
 *   - attacks have anticipation (slow coil back), a fast strike, and follow-through that
 *     overshoots and settles.
 *
 * Everything is per-frame arithmetic on seven Object3D nodes. No allocation.
 */

const SUPPORT = 0.6;   // fraction of the cycle the foot stays planted

/** Hip angle over one cycle. Linear sweep while planted, fast smooth swing through. */
function stride(t) {
  if (t < SUPPORT) return 0.5 - (t / SUPPORT);
  const u = (t - SUPPORT) / (1 - SUPPORT);
  // Overshoot at the end of the swing: the foot reaches ahead before it plants.
  return -0.5 + (u * u * (3 - 2 * u)) + Math.sin(u * Math.PI) * 0.14;
}
/** Foot clearance. Zero while planted — that is the whole point. */
function lift(t) {
  if (t < SUPPORT) return 0;
  return Math.sin(((t - SUPPORT) / (1 - SUPPORT)) * Math.PI);
}
/** Body drop right after touchdown: the weight arriving. */
function impact(t) {
  return t < 0.18 ? Math.sin((t / 0.18) * Math.PI) : 0;
}
const frac = (x) => x - Math.floor(x);

export class OrcRig {
  constructor(parts) {
    Object.assign(this, parts);
    const p = this.profile || {};
    this.strideAmp = p.stride ?? 1;
    this.rate = p.rate ?? 1;
    this.weight = p.weight ?? 1;
    this.lumber = p.lumber ?? 1;
    this.bobAmp = p.bob ?? 1;
    this.flying = !!p.flying;
    this.attackStyle = p.attack || 'swing';
    // A braced arm (tower shield, drawn bow, planted totem) barely swings.
    this.guardL = !!p.guardL;
    this.guardR = !!p.guardR;

    this.phase = Math.random();
    this.lagYaw = 0;
    this.lastFacing = 0;
    this.hurtT = 0;
    this.hurtX = 0; this.hurtZ = 0;
    this.deathT = -1;
    this.deathFall = 1;
    this.deathSpin = 0;
    this._mat = this.base;
    this._stealth = false;
    this._tint = 0;
    this._far = false;
    this.limbs = [this.torso, this.armL, this.armR, this.legL, this.legR, this.wingL, this.wingR].filter(Boolean);
    this.hipX = this.hips.position.x;
    this.hipY = this.hips.position.y;
    this.hipZ = this.hips.position.z;
    this._legLY = this.legL ? this.legL.position.y : 0;
    this._legRY = this.legR ? this.legR.position.y : 0;
  }

  reset() {
    this.phase = Math.random();
    this.lagYaw = 0;
    this.hurtT = 0;
    this.deathT = -1;
    this._stealth = false;
    this.hips.position.set(this.hipX, this.hipY, this.hipZ);
    this.hips.rotation.set(0, 0, 0);
    for (const n of [this.torso, this.armL, this.armR, this.legL, this.legR, this.wingL, this.wingR]) {
      if (n) n.rotation.set(0, 0, 0);
    }
    if (this.legL) this.legL.position.y = this._legLY;
    if (this.legR) this.legR.position.y = this._legRY;
    this._far = true; this.setLod(false);
    this._tint = -1;
    this.setTint(0);
  }

  /** A hit landed. `dx,dz` point from the attacker to us, in world space. */
  flinch(dx, dz, power, facing) {
    const s = Math.sin(facing), c = Math.cos(facing);
    // Into the orc's own frame, so the recoil goes the right way whichever way it faces.
    this.hurtZ = dx * s + dz * c;
    this.hurtX = dx * c - dz * s;
    this.hurtT = Math.min(0.26, (this.hurtT || 0) + 0.18);
    this.hurtPower = clamp(power, 0.25, 1.4);
  }

  /** Start the crumple. `dx,dz` is the direction the killing blow travelled. */
  beginDeath(dx, dz, facing) {
    const s = Math.sin(facing), c = Math.cos(facing);
    const fwd = dx * s + dz * c;
    // Shot in the back -> falls forward; met head-on -> falls backward onto its arse.
    this.deathFall = fwd >= 0 ? 1 : -1;
    this.deathSpin = (dx * c - dz * s) * 0.5 + (Math.random() - 0.5) * 0.5;
    this.deathT = 0;
    this.setTint(0);
  }

  /** Advance the death crumple. Returns false once the body is done and can be pooled. */
  deathUpdate(dt) {
    if (this.deathT < 0) return false;
    // Clamp: the debug stepper can hand out a negative dt when it rewinds the clock, and a
    // corpse that ages backwards trips the "not dying" sentinel and pops out of existence.
    const t = (this.deathT += dt > 0 ? dt : 0);
    const hips = this.hips, torso = this.torso;
    const f = this.deathFall;

    if (t < 0.12) {
      // The jolt: it knows it is dead before it falls.
      const u = t / 0.12;
      hips.position.y = this.hipY + Math.sin(u * Math.PI) * 0.14;
      torso.rotation.x = -f * u * 0.5;
      if (this.armL) this.armL.rotation.z = -1.1 * u;
      if (this.armR) this.armR.rotation.z = 1.1 * u;
    } else if (t < 0.62) {
      // The fall: pivot over the feet, accelerating like something with mass.
      const u = (t - 0.12) / 0.5;
      const e = u * u;
      hips.rotation.x = f * e * 1.5;
      hips.position.y = lerp(this.hipY, this.hipY * 0.28, e);
      hips.rotation.z = this.deathSpin * e;
      torso.rotation.x = -f * (0.5 - e * 0.9);
      if (this.legL) this.legL.rotation.x = -f * e * 0.9;
      if (this.legR) this.legR.rotation.x = -f * e * 0.5;
    } else if (t < 1.35) {
      // Settle with one small bounce, then lie still for a beat.
      const u = (t - 0.62) / 0.73;
      const b = Math.max(0, Math.sin(u * Math.PI * 2)) * (1 - u) * 0.12;
      hips.rotation.x = f * (1.5 + b);
      hips.position.y = this.hipY * 0.28 + b * 0.3;
    } else {
      // Sink out of sight rather than pop: the corpse has to leave, but not blink away.
      const u = clamp((t - 1.35) / 0.45, 0, 1);
      hips.position.y = this.hipY * 0.28 - u * 1.4;
      if (u >= 1) return false;
    }
    return true;
  }

  /**
   * Swap between the five-node rig and the single-mesh distant LOD. Below ~25px on screen
   * the limb animation is not visible but still costs four draw calls and four matrix
   * updates per orc, which is the entire difference between 50 and 60fps in a big wave.
   */
  setLod(far) {
    if (!this.farMesh || far === this._far) return;
    this._far = far;
    this.farMesh.visible = far;
    for (const n of this.limbs) n.visible = !far;
  }

  animate(enemy, dt, speed) {
    if (this.deathT >= 0) return;
    if (this._far) { this._animateFar(enemy, dt, speed); return; }

    const moving = speed > 0.25;
    const rel = clamp(speed / Math.max(0.5, enemy.speedBase), 0, 1.6);
    const stunned = enemy.statusMods.stunned || enemy.statusMods.rooted;

    // Cycle rate scales with actual speed, not desired speed, so a shoved or slowed orc
    // visibly labours instead of moon-walking.
    if (!stunned) this.phase = frac(this.phase + dt * (0.55 + rel * 0.85) * this.rate);
    const t = this.phase;
    const amp = this.strideAmp * (0.35 + rel * 0.75) * (stunned ? 0.05 : 1);

    const tR = t, tL = frac(t + 0.5);
    const hips = this.hips, torso = this.torso;

    // --- legs: plant, sweep, lift ------------------------------------------
    // Rigid legs, so the hip lifts as well as rotates: that keeps the planted foot on the
    // floor through the support phase, which is the whole illusion.
    if (this.legR) {
      this.legR.rotation.x = stride(tR) * 1.5 * amp;
      this.legR.position.y = this._legRY + lift(tR) * 0.16 * amp;
    }
    if (this.legL) {
      this.legL.rotation.x = stride(tL) * 1.5 * amp;
      this.legL.position.y = this._legLY + lift(tL) * 0.16 * amp;
    }

    // --- hips: drop on each footfall, roll onto the planted leg ------------
    const drop = (impact(tR) + impact(tL)) * 0.055 * this.weight * this.bobAmp * amp;
    const rise = Math.abs(Math.sin(t * TAU)) * 0.03 * this.bobAmp * amp;
    hips.position.y = this.hipY + rise - drop;
    hips.rotation.z = Math.sin(t * TAU) * 0.075 * this.weight * amp;
    hips.rotation.y = -Math.sin(t * TAU) * 0.14 * amp;

    // --- torso: counter-rotate, and lag behind every turn -------------------
    const turn = angleDelta(this.lastFacing, enemy.facing);
    this.lastFacing = enemy.facing;
    // A heavy body cannot change direction as fast as its feet: hold the old heading for
    // a moment and let it whip round after. This is most of what reads as "mass".
    this.lagYaw = damp(this.lagYaw - turn * (0.55 + this.lumber * 0.35), 0, 0.0005, dt);
    this.lagYaw = clamp(this.lagYaw, -0.9, 0.9);

    let ty = this.lagYaw + Math.sin(t * TAU) * 0.17 * amp;
    let tx = 0.02 + rel * 0.09 * this.lumber - drop * 0.6;
    let tz = -hips.rotation.z * 0.5;

    // --- arms: opposite the legs, with a lumbering outward flare ------------
    // Small swing on purpose. These arms are rigid and carry heavy things; a walk-cycle
    // amplitude that looks fine on an empty hand throws an axe or a tower shield through
    // a 60° arc and the whole silhouette falls apart.
    const swingAmp = 0.42 * amp;
    let aR = -stride(tR) * swingAmp * (this.guardR ? 0.25 : 1);
    let aL = -stride(tL) * swingAmp * (this.guardL ? 0.25 : 1);
    let flare = 0.1 + this.lumber * 0.07;
    let armRz = this.guardR ? 0.02 : flare, armLz = this.guardL ? -0.02 : -flare;

    // --- attack: anticipation, strike, follow-through -----------------------
    if (enemy.state === 'attack' && enemy.stateT < (enemy.attackAnim ?? 0.75)) {
      const at = enemy.stateT / (enemy.attackAnim ?? 0.75);
      const style = this.attackStyle;
      if (style === 'shoot') {
        // Draw, hold, release, recover — the hold is the tell you can react to.
        const draw = clamp(at / 0.45, 0, 1);
        const rel2 = clamp((at - 0.5) / 0.2, 0, 1);
        aR = -1.0 - draw * 0.5 + rel2 * 1.3;
        aL = -1.35;
        armRz = 0.5 - rel2 * 0.35; armLz = -0.2;
        ty = this.lagYaw + 0.45 * (1 - rel2 * 0.6);
      } else if (style === 'cast') {
        const up = clamp(at / 0.4, 0, 1);
        const down = clamp((at - 0.45) / 0.3, 0, 1);
        aR = -2.3 * up + down * 1.2;
        armRz = 0.15;
        tx += -0.12 * up + 0.2 * down;
      } else {
        // Coil away slowly (0 -> 0.42), whip through fast (0.42 -> 0.55), settle.
        let swing;
        if (at < 0.42) { const u = at / 0.42; swing = -1.9 * (u * u); }
        else if (at < 0.56) { const u = (at - 0.42) / 0.14; swing = -1.9 + u * 3.3; }
        else { const u = (at - 0.56) / 0.44; swing = 1.4 - u * 1.4 - Math.sin(u * Math.PI) * 0.25; }
        aR = swing;
        armRz = 0.32;
        aL = -swing * 0.3 - 0.2;
        // Whole body drives the blow: coil the shoulders back, then throw them through.
        ty = this.lagYaw + (at < 0.42 ? -0.55 * (at / 0.42) : 0.6 * clamp((at - 0.42) / 0.2, 0, 1) - 0.55 * clamp(1 - (at - 0.42) / 0.2, 0, 1));
        tx += at < 0.42 ? -0.18 * (at / 0.42) : 0.3 * Math.sin(clamp((at - 0.42) / 0.5, 0, 1) * Math.PI);
        hips.position.y -= at < 0.42 ? 0.06 * (at / 0.42) : 0;
      }
    }

    // --- stagger: knocked off balance, arms out, feet scrabbling ------------
    if (enemy.state === 'stagger') {
      const u = clamp(enemy.stateT / (enemy.staggerDur || 0.55), 0, 1);
      const k = Math.sin((1 - u) * Math.PI * 0.5);
      tx -= 0.55 * k;
      tz += this.deathSpin * 0.2;
      aR = -1.2 * k; aL = -1.2 * k;
      armRz = flare + 0.7 * k; armLz = -flare - 0.7 * k;
      hips.rotation.z += 0.2 * k * Math.sin(enemy.stateT * 22);
    }

    // --- flinch: a short, sharp jerk away from the blow ---------------------
    if (this.hurtT > 0) {
      this.hurtT -= dt;
      const k = clamp(this.hurtT / 0.26, 0, 1);
      const j = Math.sin(k * Math.PI * 2.2) * k * this.hurtPower;
      tx += this.hurtZ * j * 0.5;
      tz += this.hurtX * j * 0.4;
      ty += this.hurtX * j * 0.3;
      hips.position.y -= Math.abs(j) * 0.05;
      armRz += j * 0.4; armLz += j * 0.4;
    }

    torso.rotation.set(tx, ty, tz);
    if (this.armR) { this.armR.rotation.x = aR; this.armR.rotation.z = armRz; }
    if (this.armL) { this.armL.rotation.x = aL; this.armL.rotation.z = armLz; }

    // --- wings: a flyer's whole silhouette is the flap ----------------------
    if (this.wingL) {
      const w = Math.sin(enemy.walkPhase * 4.2);
      this.wingL.rotation.z = -0.25 - w * 0.55;
      this.wingR.rotation.z = 0.25 + w * 0.55;
      this.wingL.rotation.x = this.wingR.rotation.x = w * 0.18;
      hips.position.y = this.hipY + w * 0.12;
      // Legs tuck up while airborne instead of running on nothing.
      if (this.legL) this.legL.rotation.x = this.legR.rotation.x = 0.5 + w * 0.1;
    }
  }

  /** Distant LOD: one mesh, so all that is left is the bounce and the lean. Still enough
   *  motion that a far-off column reads as marching rather than sliding. */
  _animateFar(enemy, dt, speed) {
    const rel = clamp(speed / Math.max(0.5, enemy.speedBase), 0, 1.6);
    this.phase = frac(this.phase + dt * (0.55 + rel * 0.85) * this.rate);
    const t = this.phase;
    this.hips.position.y = this.hipY + Math.abs(Math.sin(t * Math.PI)) * 0.06 * this.bobAmp * rel;
    this.hips.rotation.z = Math.sin(t * TAU) * 0.06 * this.weight * rel;
    this.hips.rotation.x = 0.03 + rel * 0.06 * this.lumber;
  }

  /** t = 0..1 hit flash. Material swap, not a clone: shared materials stay shared. */
  setTint(t, type) {
    if (t === this._tint) return;
    this._tint = t;
    const want = t > 0.3
      ? (this.flash[type] || this.flash.default)
      : (this._stealth ? this.stealth : this.base);
    if (want === this._mat) return;
    this._mat = want;
    for (const m of this.meshes) m.material = want;
  }

  /** Stealth units render as a ghost until they strike. */
  setStealth(on) {
    if (on === this._stealth) return;
    this._stealth = on;
    this._tint = -1;      // force the next setTint through
    this.setTint(0);
  }
}
