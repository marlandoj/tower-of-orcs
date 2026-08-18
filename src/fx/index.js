import * as THREE from 'three';
import { ParticleSystem } from './Particles.js';
import { GibSystem } from './Gibs.js';
import { CoinSystem } from './Coins.js';
import { Music } from './Music.js';
import { v0, v1, v2 } from '../shared/scratch.js';

/**
 * The juice facade. Everything that makes a hit feel like a hit lives behind this.
 *
 * The shape of a kill, in order:
 *   damage type decides the *flavour*  ->  chunks + decal + type sound
 *   the corpse pays out               ->  coins arc, then swoop to you, ka-ching rising
 *   the combo escalates               ->  denser particles, brighter screen, higher pitch
 *
 * Subsystems: two GPU particle systems (additive for light, normal for gore/smoke), a
 * pooled gib-chunk mesh, a pooled coin mesh, a tinted decal pool, pooled DOM damage
 * numbers, screen flash + vignette, and the procedural score.
 *
 * FX also listens to the bus rather than waiting to be called, so death flavour, trap
 * signatures and combo escalation land without every other module having to opt in.
 */
export class FX {
  constructor(game) {
    this.game = game;
    this.scene = game.scene;

    this.sparks = new ParticleSystem(this.scene, { capacity: 6000, additive: true, gravity: 26, renderOrder: 12 });
    this.gore = new ParticleSystem(this.scene, { capacity: 4000, additive: false, gravity: 30, renderOrder: 11 });

    this.settings = game.save?.setting ?? { shake: 1, damageNumbers: true, blood: 1 };

    this._decals = new DecalPool(this.scene, 300);
    this.gibs = new GibSystem(this.scene, {
      // A chunk hitting the floor should stain it. This is where layered gore comes from:
      // every bounce paints, so a killing field builds up over a wave instead of resetting.
      onLand: (p, r, g, b) => {
        if ((this.settings.blood ?? 1) <= 0) return;
        const x = p.x, z = p.z;
        this._decals.splat(p, 0.8 + Math.random() * 0.7, r * 0.62, g * 0.62, b * 0.62, 20);
        this.gore.emit(x, 0.15, z, (Math.random() - 0.5) * 2, 1.4, (Math.random() - 0.5) * 2,
          r, g, b, 1, 0.11, 0.28, 0);
      },
    });
    this.coins = new CoinSystem(this.scene, {
      onCollect: (value, x, y, z, isSkull) => this._collect(value, x, y, z, isSkull),
      onTrail: (x, y, z, r, g, b) => this.sparks.emit(x, y, z, 0, 0.6, 0, r, g, b, 1, 0.13, 0.22, 0),
    });

    this.music = new Music(game.audio);

    // --- screen layers ------------------------------------------------------
    const root = document.getElementById('ui-root');
    this._numLayer = document.createElement('div');
    this._numLayer.className = 'fx-numbers';
    root?.appendChild(this._numLayer);

    this._flash = document.createElement('div');
    this._flash.className = 'fx-flash';
    root?.appendChild(this._flash);

    // Vignettes are pure inline style so they need no CSS of their own.
    this._vigCombo = makeVignette(root, 'rgba(255,168,40,.85)');
    this._vigHit = makeVignette(root, 'rgba(255,26,26,.9)');

    this._numbers = [];
    this._numPool = [];
    this._proj = new THREE.Vector3();
    this._flashA = 0; this._flashDur = 0.12;
    this._trails = [];

    // --- combo / escalation state -------------------------------------------
    this.combo = 0;
    this.multiplier = 1;
    this.tier = 0;            // 0..4, one rung per multiplier step
    this._comboPulse = 0;
    this._hitPulse = 0;

    // --- payout chain -------------------------------------------------------
    this._chain = 0;          // consecutive collects inside the window; drives ka-ching pitch
    this._chainAt = -9;
    this._coinBank = 0;       // batched into one floating "+N" so 30 coins != 30 numbers
    this._coinBankT = 0;
    this._coinBankPos = new THREE.Vector3();

    // Kill bursts are fired from the bus; EnemyManager's own gib/blood call for the same
    // corpse would double them, so it is swallowed for that frame at that spot.
    this._killFrame = -1;
    this._killPos = new THREE.Vector3();

    this._trapFxAt = new WeakMap();   // per-trap FX throttle for the passive/fast traps
    this._musicPoll = 0;

    this._wire(game.bus);
  }

  // =========================================================================
  // bus wiring
  // =========================================================================
  _wire(bus) {
    bus.on('enemy:killed', (p) => this._onKill(p));
    bus.on('enemy:shield-broken', (p) => this.shieldBreak(p.position ?? p.enemy?.position));
    bus.on('combo:changed', (p) => this._onCombo(p));
    bus.on('trap:triggered', (p) => this.trapSignature(p.trap, p.victims));
    bus.on('rift:damaged', () => { this._hitPulse = 1; });
    bus.on('wave:start', (p) => this.music.setMode(p.boss ? 'boss' : 'wave'));
    bus.on('phase:build', () => this.music.setMode('build'));
    bus.on('level:load', () => { this.music.setMode('build'); this.music.setIntensity(0); });
    bus.on('game:victory', () => this.music.setMode('quiet'));
    bus.on('game:defeat', () => this.music.setMode('quiet'));
  }

  // =========================================================================
  // impact
  // =========================================================================
  hit(pos, normal = null, opts = {}) {
    const n = Math.round((opts.count ?? 10) * this.density);
    const c = opts.color ?? [1.0, 0.85, 0.45];
    const spd = opts.speed ?? 7;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 0.9;
      const s = spd * (0.4 + Math.random());
      this.sparks.emit(
        pos.x, pos.y, pos.z,
        Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s * 1.1 + 2, Math.sin(a) * Math.cos(e) * s,
        c[0], c[1], c[2], 1,
        0.07 + Math.random() * 0.07, 0.14 + Math.random() * 0.18, 1,
      );
    }
    // A brief flash core sells the moment of contact — small and fast, or it smears into
    // a white cloud the instant more than a couple of traps fire at once.
    this.sparks.emit(pos.x, pos.y, pos.z, 0, 0, 0, c[0], c[1], c[2], 0.85, 0.38, 0.05, 0);
  }

  blood(pos, dir = null, amount = 1) {
    const mul = this.settings.blood ?? 1;
    if (mul <= 0) return;
    if (this._suppressed(pos)) return;
    const n = Math.round(14 * amount * mul * this.density);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random();
      const s = 5 * (0.3 + Math.random()) * (0.6 + amount * 0.5);
      const bx = dir ? dir.x * 3 : 0, bz = dir ? dir.z * 3 : 0;
      const d = 0.17 + Math.random() * 0.17;
      this.gore.emit(
        pos.x, pos.y + 0.6, pos.z,
        Math.cos(a) * s + bx, Math.abs(Math.sin(e)) * s * 0.8 + 2.5, Math.sin(a) * s + bz,
        d, d * 0.12, d * 0.10, 1,
        0.17 + Math.random() * 0.2, 0.5 + Math.random() * 0.5, 0,
      );
    }
    if (amount > 0.8) this.splat(pos, 1.4 + Math.random() * 1.1);
  }

  /** Ground stain. Tint defaults to blood; scorch/frost/acid pass their own. */
  splat(pos, size = 1.5, color = null, life = 22) {
    if ((this.settings.blood ?? 1) <= 0) return;
    const c = color ?? BLOOD;
    this._decals.splat(pos, size, c[0], c[1], c[2], life);
  }

  gib(pos, dir = null, count = 7, tint = null) {
    if (this._suppressed(pos)) return;
    const mul = this.settings.blood ?? 1;
    const n = Math.round(count * Math.max(0.35, mul));
    const col = tint ?? [0.15, 0.024, 0.021];
    this.gibs.burst(pos, dir, Math.min(18, Math.round(n * 0.55)), { color: col, size: 0.3 });
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 6 + Math.random() * 7;
      this.gore.emit(
        pos.x, pos.y + 0.6, pos.z,
        Math.cos(a) * s + (dir?.x ?? 0) * 4, 5 + Math.random() * 7, Math.sin(a) * s + (dir?.z ?? 0) * 4,
        col[0], col[1], col[2], 1,
        0.22 + Math.random() * 0.26, 1.0 + Math.random() * 0.7, 0,
      );
    }
    this.blood(pos, dir, 1.6);
    this.splat(pos, 2.4);
  }

  dust(pos, r = 1, count = 10, color = [0.55, 0.5, 0.44]) {
    const n = Math.round(count * this.density);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = r * (0.6 + Math.random() * 1.4);
      this.gore.emit(
        pos.x + Math.cos(a) * r * 0.4, pos.y + 0.1, pos.z + Math.sin(a) * r * 0.4,
        Math.cos(a) * s, 0.6 + Math.random() * 1.2, Math.sin(a) * s,
        color[0], color[1], color[2], 0.34,
        // Puff size has to track the radius the caller asked for. Smoke-mode particles
        // grow 3.2x over their life, so a fixed ~1 m puff becomes a 3 m white cloud, and
        // twenty traps firing at once turn the corridor into fog.
        r * (0.28 + Math.random() * 0.34), 0.7 + Math.random() * 0.7, 2,
      );
    }
  }

  fire(pos, r = 1, count = 12) {
    const n = Math.round(count * this.density);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = r * (0.3 + Math.random());
      const heat = 0.6 + Math.random() * 0.4;
      this.sparks.emit(
        pos.x + Math.cos(a) * r * 0.3, pos.y + 0.2, pos.z + Math.sin(a) * r * 0.3,
        Math.cos(a) * s * 0.6, 3 + Math.random() * 3, Math.sin(a) * s * 0.6,
        1.0, heat * 0.5, heat * 0.10, 1,
        r * (0.34 + Math.random() * 0.36), 0.35 + Math.random() * 0.35, 0,
      );
    }
    this.dust(pos, r * 0.8, 4, [0.16, 0.14, 0.13]);
  }

  /**
   * A real explosion: white-hot core, orange body, dark-red trailing edge, black smoke,
   * and a ground-hugging dust ring. Three shells with staggered lifetimes is what makes
   * a fireball look like it is *cooling* instead of like an orange sprite fading out.
   */
  fireball(pos, r = 3, opts = {}) {
    const dm = this.density;
    const g = opts.gore !== false;

    // Core: a couple of huge, very short flashes. This is the frame that reads as "boom".
    for (let i = 0; i < 3; i++) {
      this.sparks.emit(pos.x, pos.y + 0.9 + i * 0.4, pos.z, 0, 2, 0,
        1.0, 0.92, 0.70, 1, r * (1.5 - i * 0.25), 0.07 + i * 0.02, 0);
    }
    // Body: orange, expanding, medium life.
    for (let i = 0; i < Math.round(38 * dm); i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 0.8;
      const s = r * (0.9 + Math.random() * 1.5);
      this.sparks.emit(
        pos.x + Math.cos(a) * r * 0.25, pos.y + 0.5 + Math.random() * 1.2, pos.z + Math.sin(a) * r * 0.25,
        Math.cos(a) * Math.cos(e) * s, 2.5 + Math.sin(e) * s * 0.9, Math.sin(a) * Math.cos(e) * s,
        1.0, 0.42 + Math.random() * 0.22, 0.06, 1,
        r * (0.34 + Math.random() * 0.3), 0.26 + Math.random() * 0.24, 0,
      );
    }
    // Edge: the cooler, slower shell that lingers a beat behind the body.
    for (let i = 0; i < Math.round(20 * dm); i++) {
      const a = Math.random() * Math.PI * 2;
      const s = r * (0.5 + Math.random() * 0.9);
      this.sparks.emit(
        pos.x, pos.y + 0.8 + Math.random() * 1.6, pos.z,
        Math.cos(a) * s, 2.2 + Math.random() * 3, Math.sin(a) * s,
        0.85, 0.14, 0.03, 1,
        r * (0.45 + Math.random() * 0.4), 0.5 + Math.random() * 0.35, 0,
      );
    }
    // Fast radial sparks give the blast an edge that the soft puffs cannot.
    for (let i = 0; i < Math.round(24 * dm); i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 1.1;
      const s = r * (2.4 + Math.random() * 2.6);
      this.sparks.emit(pos.x, pos.y + 0.7, pos.z,
        Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + 3, Math.sin(a) * Math.cos(e) * s,
        1.0, 0.72, 0.24, 1, 0.09 + Math.random() * 0.09, 0.35 + Math.random() * 0.4, 1);
    }
    this.smoke(pos, r * 0.7, Math.round(12 * dm), [0.10, 0.09, 0.088]);
    this.shockwave(pos, r * 1.1, [0.5, 0.42, 0.34], Math.round(34 * dm));
    if (g) this.splat(pos, r * 1.1, SCORCH, 34);
    this.flash('#ff8a30', 0.26, Math.min(0.38, 0.18 + this.tier * 0.03));
  }

  /** Fast bright motes that rise and die — what fire leaves behind, not fire itself. */
  ember(pos, r = 1, count = 10, color = [1, 0.55, 0.12]) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit(
        pos.x + Math.cos(a) * r * 0.5, pos.y + 0.3 + Math.random() * 0.8, pos.z + Math.sin(a) * r * 0.5,
        Math.cos(a) * 0.8, 2.2 + Math.random() * 3.4, Math.sin(a) * 0.8,
        color[0], color[1], color[2], 1,
        0.05 + Math.random() * 0.06, 0.7 + Math.random() * 0.9, 1,
      );
    }
  }

  /** A slow dark column. Reads as aftermath; use it sparingly or the level fogs up. */
  smoke(pos, r = 1, count = 6, color = [0.13, 0.12, 0.12]) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      this.gore.emit(
        pos.x + Math.cos(a) * r * 0.35, pos.y + 0.4, pos.z + Math.sin(a) * r * 0.35,
        Math.cos(a) * 0.5, 1.4 + Math.random() * 1.6, Math.sin(a) * 0.5,
        color[0], color[1], color[2], 0.55,
        0.9 + Math.random() * 1.1, 1.2 + Math.random() * 1.2, 2,
      );
    }
  }

  frost(pos, r = 1, count = 12) {
    const n = Math.round(count * this.density);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit(
        pos.x, pos.y + 0.4, pos.z,
        Math.cos(a) * r * 2, 1 + Math.random() * 2, Math.sin(a) * r * 2,
        0.55, 0.85, 1.0, 1,
        0.08 + Math.random() * 0.12, 0.4 + Math.random() * 0.4, 1,
      );
    }
  }

  lightning(from, to, color = [0.7, 0.85, 1.0]) {
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const x = from.x + (to.x - from.x) * t + (Math.random() - 0.5) * 0.8;
      const y = from.y + (to.y - from.y) * t + (Math.random() - 0.5) * 0.8;
      const z = from.z + (to.z - from.z) * t + (Math.random() - 0.5) * 0.8;
      this.sparks.emit(x, y, z, 0, 0, 0, color[0], color[1], color[2], 1, 0.2, 0.1, 0);
    }
  }

  ring(pos, radius, color = [1, 0.8, 0.4], count = 28) {
    const n = Math.round(count * this.density);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      this.sparks.emit(
        pos.x, pos.y + 0.2, pos.z,
        Math.cos(a) * radius * 2.6, 1.2, Math.sin(a) * radius * 2.6,
        color[0], color[1], color[2], 1, 0.2, 0.34, 1,
      );
    }
  }

  /** A flat expanding disc of dust hugging the floor. Reads as force, not as sparkle. */
  shockwave(pos, radius = 3, color = [0.6, 0.55, 0.48], count = 30) {
    const n = Math.round(count * this.density);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
      const s = radius * (2.0 + Math.random() * 0.8);
      this.gore.emit(
        pos.x + Math.cos(a) * 0.3, 0.15, pos.z + Math.sin(a) * 0.3,
        Math.cos(a) * s, 0.5 + Math.random() * 0.8, Math.sin(a) * s,
        color[0], color[1], color[2], 0.6,
        0.8 + Math.random() * 0.8, 0.5 + Math.random() * 0.4, 2,
      );
    }
  }

  shieldBreak(pos) {
    if (!pos) return;
    this.game.audio.play('shield.break', { position: pos });
    this.ring(pos, 1.2, [0.5, 0.8, 1.0], 22);
    this.gibs.burst(pos, null, 5, { color: [0.35, 0.6, 0.95], size: 0.2, spin: 2, wet: false, up: 6 });
  }

  /**
   * A fading streak behind a moving object (projectile, charging boss, thrown orc).
   * Returns a handle; call `.stop()` or let it expire.
   */
  trail(obj, opts = {}) {
    const h = {
      obj, t: 0, rate: opts.rate ?? 0.02, life: opts.life ?? 3,
      color: opts.color ?? [1, 0.7, 0.3], size: opts.size ?? 0.16,
      mode: opts.mode ?? 1, yOff: opts.yOff ?? 0.6,
      stop() { h.life = 0; },
    };
    if (this._trails.length < 24) this._trails.push(h);
    return h;
  }

  // =========================================================================
  // camera / screen
  // =========================================================================
  shake(intensity, duration = 0.2) {
    // The combo raises the ceiling on impact, not the floor — small hits stay small.
    this.game.rig.shake(intensity * (1 + this.tier * 0.1) * (this.settings.shake ?? 1), duration);
  }
  hitstop(seconds) { this.game.engine.hitstop(seconds); }
  slowmo(scale, seconds) { this.game.engine.slowmo(scale, seconds); }

  /** Full-screen tint. Decays on the real clock so it works with hitstop and headless. */
  flash(color = '#fff', duration = 0.12, alpha = 0.5) {
    this._flash.style.background = color;
    this._flash.style.transition = 'none';
    this._flashDur = Math.max(0.04, duration);
    this._flashA = Math.max(this._flashA, alpha);
    this._flash.style.opacity = String(this._flashA);
  }

  // =========================================================================
  // damage numbers
  // =========================================================================
  damageNumber(pos, amount, kind = 'normal') {
    if (!(this.settings.damageNumbers ?? true)) return;
    if (this._numbers.length > 56) return;
    const el = this._numPool.pop() ?? document.createElement('div');
    // Tier class lets a 5x-combo number read twice the size of a 1x one.
    el.className = `dmg dmg-${kind}${this.tier ? ` dmg-t${Math.min(4, this.tier)}` : ''}`;
    el.textContent = kind === 'immune' ? 'IMMUNE' : Math.round(amount);
    el.style.opacity = '1';
    this._numLayer.appendChild(el);
    this._numbers.push({
      el, life: kind === 'crit' ? 1.1 : 0.85, age: 0,
      x: pos.x, y: pos.y + 1.4, z: pos.z,
      vx: (Math.random() - 0.5) * 1.6, vy: 3.2 + Math.random(), vz: (Math.random() - 0.5) * 1.6,
    });
  }

  /** Free-floating label used for payouts and combo callouts. */
  floatText(pos, text, kind = 'coin', life = 1.0) {
    if (!(this.settings.damageNumbers ?? true)) return;
    if (this._numbers.length > 60) return;
    const el = this._numPool.pop() ?? document.createElement('div');
    el.className = `dmg dmg-${kind}`;
    el.textContent = text;
    el.style.opacity = '1';
    this._numLayer.appendChild(el);
    this._numbers.push({
      el, life, age: 0, x: pos.x, y: pos.y + 1.6, z: pos.z,
      vx: 0, vy: 2.6, vz: 0,
    });
  }

  // =========================================================================
  // combo escalation
  // =========================================================================
  /** Particle-count multiplier. One knob, so escalation is consistent everywhere. */
  get density() { return 1 + this.tier * 0.22; }

  _onCombo({ combo, multiplier }) {
    const prev = this.multiplier;
    this.combo = combo;
    this.multiplier = multiplier;
    this.tier = Math.max(0, Math.min(4, Math.floor(multiplier - 1)));   // 1x..5x -> 0..4
    this.music.setIntensity((multiplier - 1) / 4);

    if (multiplier > prev) {
      const p = this.game.player?.position;
      this._comboPulse = 1;
      if (multiplier >= 5) {
        // Top of the ladder. This is the moment the game should feel like a jackpot.
        this.game.audio.play('combo.max');
        this.flash('#ffd870', 0.4, 0.28);
        if (p) { this.ring(p, 3.4, [1, 0.82, 0.3], 54); this.ring(p, 2.2, [1, 0.55, 0.15], 34); }
        this.shake(0.3, 0.25);
      } else {
        this.game.audio.play('combo.up', { pitch: 1 + (multiplier - 1) * 0.22 });
        if (p) this.ring(p, 1.6 + multiplier * 0.4, [1, 0.78, 0.32], 18 + multiplier * 6);
      }
      if (p) this.floatText(p, `${multiplier}x`, `combo dmg-t${Math.min(4, this.tier)}`, 0.9);
    }
  }

  // =========================================================================
  // death
  // =========================================================================
  /**
   * True when a corpse at this spot has already been handled by `_death` this frame, so
   * EnemyManager's generic follow-up gib/blood is swallowed. `_bursting` exempts the
   * death burst's own internal blood() call from its own suppression.
   */
  _suppressed(pos) {
    if (this._bursting) return false;
    return this.game.clock.frame === this._killFrame && this._killPos.distanceToSquared(pos) < 4;
  }

  /**
   * How much effect this corpse gets, 0..1.
   *
   * A wall of 250 orcs can die in a single frame (a boom barrel in a packed lane, a
   * wipe). Giving every one of them the full burst puts thousands of metre-wide alpha
   * quads on screen at once and the frame goes to fill rate, not to feel. So the first
   * handful of deaths in a frame are full price and the rest degrade — visually it still
   * reads as a massacre, because nobody can pick one corpse out of eighty anyway.
   */
  _deathLod() {
    const f = this.game.clock.frame;
    if (f !== this._deathFrame) { this._deathFrame = f; this._deathCount = 0; }
    const i = this._deathCount++;
    if (i < 6) return 1;
    if (i < 20) return 0.45;
    if (i < 60) return 0.18;
    return 0.06;
  }

  _onKill({ enemy, position }) {
    const e = enemy;
    const pos = position ?? e.position;
    // Claim this corpse: EnemyManager's generic gib/blood for it is swallowed, because the
    // typed burst below already covers it and doubling reads as mush.
    this._killFrame = this.game.clock.frame;
    this._killPos.copy(pos);

    const dir = e.velocity && e.velocity.lengthSq() > 0.01
      ? v2.copy(e.velocity).setY(0).normalize()
      : v2.set(Math.random() - 0.5, 0, Math.random() - 0.5).normalize();

    const boss = e.has?.('boss');
    const big = e.hpMax > 500;
    const scale = e.def?.scale ?? 1;
    const kind = this._deathKind(e);
    // Bosses and elites are never budgeted away — they are the moments the run is about.
    const lod = boss || big ? 1 : this._deathLod();

    this._bursting = true;
    if (boss) this._bossDeath(e, pos, dir);
    else this._death(kind, pos, dir, scale, big, lod);
    this._bursting = false;

    // --- payout ------------------------------------------------------------
    const worth = e.def?.coin ?? 20;
    if (boss) {
      this.coins.spray(pos, 6, { kind: 'skull', value: 4, spread: 1.4 });
      this.coins.spray(pos, 34, { value: 3, spread: 1.8 });
    } else if (big) {
      this.coins.spray(pos, 2, { kind: 'skull', value: 2, spread: 1.1 });
      this.coins.spray(pos, Math.min(16, 5 + (worth / 14) | 0), { value: 1.5 });
    } else {
      // Coins keep a floor of two even at the lowest LOD: the payout is the point, and a
      // corpse that pays nothing reads as a bug rather than as a culled effect.
      const n = Math.max(5, Math.min(12, 4 + (worth / 10) | 0));
      this.coins.spray(pos, Math.max(2, Math.round(n * lod)), { value: 1 / Math.max(0.2, lod) });
    }
    if (lod > 0.4) this.game.audio.play('coin.spray', { position: pos, gain: boss ? 1 : 0.6 });
  }

  /** What killed it, in priority order: lingering status first, then the killing blow. */
  _deathKind(e) {
    const st = e.statuses;
    if (st) {
      for (const s of st) {
        if (s.kind === 'freeze') return 'ice';
        if (s.kind === 'burn') return 'fire';
      }
    }
    const t = e.lastHitType || 'physical';
    return t === 'crush' || t === 'fire' || t === 'ice' || t === 'lightning'
      || t === 'poison' || t === 'arcane' ? t : 'physical';
  }

  _death(kind, pos, dir, scale = 1, big = false, lod = 1) {
    const mul = this.settings.blood ?? 1;
    const a = this.game.audio;
    const dm = this.density * lod;
    const n = (x) => Math.max(1, Math.round(x * scale * (big ? 1.6 : 1) * Math.max(0.35, mul) * dm));
    // Below half LOD the corpse gets chunks and a stain and nothing that costs fill rate:
    // no smoke column, no expanding rings, no screen work.
    const rich = lod > 0.4;

    // Gore turned all the way off means *off* — no chunks, no stains. The kill still has
    // to read, so it becomes a puff of dust and a ring: the timing and the sound survive.
    if (mul <= 0) {
      this.dust(pos, 1.2 * scale, Math.round(10 * lod), [0.5, 0.46, 0.4]);
      if (rich) this.ring(pos, 1.1 * scale, [0.75, 0.72, 0.66], Math.round(16 * lod));
      a.play(kind === 'physical' ? 'orc.death' : `death.${DEATH_SOUND[kind]}`, { position: pos, pitch: 1 / scale });
      this.hitstop(big ? 0.05 : 0.02);
      this.shake(big ? 0.34 : 0.1, 0.14);
      return;
    }

    switch (kind) {
      case 'fire': {
        // Burned: what is left is charcoal with the heat still in it, and it keeps smoking.
        this.gibs.burst(pos, dir, n(5), { color: [0.16, 0.055, 0.020], size: 0.27 * scale, spin: 1.3, wet: false });
        this.ember(pos, 1.1 * scale, n(18));
        if (rich) { this.smoke(pos, 0.9 * scale, n(6)); this.fire(pos, 1.3 * scale, n(10)); }
        this.splat(pos, 1.9 * scale, SCORCH, 30);
        a.play('death.burn', { position: pos, pitch: 1 / scale });
        break;
      }
      case 'ice': {
        // Frozen: it does not bleed, it comes apart into shards and a puff of vapour.
        this.gibs.burst(pos, dir, n(9), { color: [0.62, 0.95, 1.25], size: 0.24 * scale, spin: 2.2, wet: false, up: 8 });
        this.frost(pos, 1.4 * scale, n(22));
        if (rich) this.ring(pos, 1.4 * scale, [0.7, 0.92, 1.0], n(20));
        this.sparks.emit(pos.x, pos.y + 1, pos.z, 0, 0, 0, 0.8, 0.95, 1, 0.9, 1.1 * scale, 0.09, 0);
        this.splat(pos, 1.5 * scale, FROST, 10);
        a.play('death.shatter', { position: pos, pitch: 1 / scale });
        break;
      }
      case 'crush': {
        // Crushed: nothing flies far. It spreads out flat and the floor takes the print.
        this.gibs.burst(pos, dir, n(6), { color: [0.14, 0.02, 0.019], size: 0.4 * scale, flat: 1, up: 2.4, spread: 1.7 });
        this.blood(pos, dir, 1.9 * scale);
        this.splat(pos, 3.2 * scale, BLOOD, 26);
        this.splat(pos, 2.1 * scale, BLOOD, 26);
        if (rich) { this.shockwave(pos, 1.5 * scale, [0.45, 0.35, 0.3], n(16)); this.shake(0.16 * scale, 0.16); }
        a.play('death.crush', { position: pos, pitch: 1 / scale });
        break;
      }
      case 'lightning': {
        // Electrocuted: it flashes white, twitches apart, and the arcs outlive the body.
        this.gibs.burst(pos, dir, n(4), { color: [0.32, 0.20, 0.16], size: 0.26 * scale, spin: 3.4, up: 9 });
        for (let i = 0; i < (rich ? 4 : 1); i++) {
          v0.set(pos.x, pos.y + 0.4, pos.z);
          v1.set(pos.x + (Math.random() - 0.5) * 5, pos.y + 1.4 + Math.random() * 2, pos.z + (Math.random() - 0.5) * 5);
          this.lightning(v0, v1, [0.8, 0.92, 1.0]);
        }
        this.sparks.emit(pos.x, pos.y + 1, pos.z, 0, 0, 0, 0.85, 0.95, 1, 1, 1.5 * scale, 0.08, 0);
        this.blood(pos, dir, 0.7);
        this.splat(pos, 1.4 * scale, SCORCH, 18);
        a.play('death.zap', { position: pos, pitch: 1 / scale });
        break;
      }
      case 'poison': {
        this.gibs.burst(pos, dir, n(5), { color: [0.24, 0.40, 0.12], size: 0.28 * scale, up: 4 });
        for (let i = 0; i < n(12); i++) {
          const ang = Math.random() * Math.PI * 2;
          this.gore.emit(pos.x, pos.y + 0.5, pos.z,
            Math.cos(ang) * 4, 2 + Math.random() * 3, Math.sin(ang) * 4,
            0.30, 0.62, 0.14, 1, 0.2 + Math.random() * 0.25, 0.8 + Math.random() * 0.6, 0);
        }
        this.splat(pos, 2.2 * scale, ACID, 18);
        a.play('death.melt', { position: pos, pitch: 1 / scale });
        break;
      }
      case 'arcane': {
        // Unmade rather than killed: no gore, an inrush, and a violet hole for a moment.
        this.ring(pos, 2.0 * scale, [0.72, 0.42, 1.0], n(30));
        if (rich) this.ring(pos, 1.1 * scale, [0.9, 0.7, 1.0], n(18));
        this.sparks.emit(pos.x, pos.y + 1, pos.z, 0, 0, 0, 0.72, 0.4, 1, 1, 1.6 * scale, 0.16, 0);
        for (let i = 0; i < n(10); i++) {
          const ang = Math.random() * Math.PI * 2;
          this.sparks.emit(pos.x, pos.y + 0.6, pos.z, Math.cos(ang) * 2, 5 + Math.random() * 5, Math.sin(ang) * 2,
            0.78, 0.5, 1.0, 1, 0.09, 0.6, 1);
        }
        a.play('death.arcane', { position: pos, pitch: 1 / scale });
        break;
      }
      default: {
        // Physical: the honest one. Meat, bone, and a spreading pool. Two overlapping
        // splats of different sizes read as a pool with an edge, not as a decal.
        this.gibs.burst(pos, dir, n(8), { color: [0.135, 0.021, 0.019], size: 0.34 * scale });
        this.blood(pos, dir, 1.7 * scale * lod);
        this.splat(pos, 3.0 * scale);
        if (rich) this.splat(pos, 1.7 * scale);
        a.play('death.gib', { position: pos, pitch: 1 / scale });
      }
    }

    // Every kill gets a beat of stop; a big one gets more. This is what makes a pile of
    // simultaneous deaths feel like a drum roll instead of a smear.
    this.hitstop(big ? 0.05 : 0.02 + this.tier * 0.002);
    if (!big) this.shake(0.1 + this.tier * 0.02, 0.12);
    else this.shake(0.34, 0.2);

    // High combo tiers put a gold burst on the corpse itself. The HUD number tells you
    // the multiplier; this tells you without looking away from the fight.
    // Only the first couple of corpses per frame get one: additive cores stack to white,
    // and eight of them at once turns a gold accent into a bleached hole in the screen.
    if (this.tier >= 2 && rich && this._deathCount <= 2) {
      this.ring(pos, 0.7 + this.tier * 0.3, GOLD, 8 + this.tier * 4);
      this.sparks.emit(pos.x, pos.y + 1, pos.z, 0, 0, 0, GOLD[0], GOLD[1], GOLD[2], 0.7,
        0.32 + this.tier * 0.07, 0.08, 0);
    }
  }

  _bossDeath(e, pos, dir) {
    const s = e.def?.scale ?? 1.7;
    this.game.audio.play('death.boss', { position: pos });

    // The corpse is huge and stays on screen, so the effect has to go *up* and *out* past
    // it — anything that plays only at floor level is hidden behind the body.
    // Centred on the boss's chest, not its feet: a floor-level blast is entirely hidden
    // behind a three-metre corpse.
    v0.set(pos.x, pos.y + 1.9 * s, pos.z);
    this.fireball(v0, 5.5 * (s / 1.7), { gore: false });
    this.splat(pos, 6 * (s / 1.7), SCORCH, 40);
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit(pos.x + Math.cos(a) * 0.8, pos.y + 0.5, pos.z + Math.sin(a) * 0.8,
        Math.cos(a) * 1.6, 13 + Math.random() * 11, Math.sin(a) * 1.6,
        1.0, 0.55, 0.18, 1, 0.7 + Math.random() * 0.9, 0.7 + Math.random() * 0.5, 0);
    }
    this.gibs.burst(pos, dir, 26, { color: [0.16, 0.024, 0.028], size: 0.6 * s, spread: 3.0, up: 14 });
    this.gibs.burst(pos, dir, 12, { color: [0.5, 0.38, 0.11], size: 0.36 * s, spread: 3.4, up: 16, wet: false });
    this.blood(pos, dir, 3);
    for (let i = 0; i < 9; i++) {
      v0.set(pos.x + (Math.random() - 0.5) * 7, 0, pos.z + (Math.random() - 0.5) * 7);
      this.splat(v0, 2.5 + Math.random() * 3.5, BLOOD, 45);
    }
    // Three rings at three heights read as a shockwave with volume, not a flat disc.
    this.ring(pos, 6.5, [1, 0.42, 0.15], 80);
    v0.set(pos.x, pos.y + 1.6, pos.z); this.ring(v0, 4.5, [1, 0.7, 0.3], 56);
    v0.set(pos.x, pos.y + 3.2, pos.z); this.ring(v0, 2.6, [1, 0.92, 0.65], 36);
    this.smoke(pos, 3.0, 18);
    this.flash('#ffddaa', 0.55, 0.6);
    this.shake(1.0, 0.6);
    this.slowmo(0.25, 1.2);
    this._hitPulse = 0.6;
  }

  // =========================================================================
  // payout
  // =========================================================================
  _collect(value, x, y, z, isSkull) {
    const now = this.game.clock.elapsed;
    // Chain resets after a short gap, so the ka-ching climbs *within* a payout and starts
    // over on the next one instead of running away to a dog whistle.
    if (now - this._chainAt > 0.55) this._chain = 0;
    this._chainAt = now;
    const step = Math.min(this._chain, 11);
    this._chain++;

    // Semitone ladder, offset up by the combo tier. Rising pitch is the payout.
    const pitch = Math.pow(2, (step + this.tier * 1.5) / 12);
    this.game.audio.play(isSkull ? 'coin.get' : 'coin.get', {
      pitch: isSkull ? pitch * 0.62 : pitch,
      gain: isSkull ? 1.0 : 0.75,
    });
    this.sparks.emit(x, y, z, 0, 1.2, 0, 1.3, 0.9, 0.35, 1, 0.3, 0.16, 0);

    this._coinBank += value;
    this._coinBankPos.set(x, y, z);
    if (this._coinBankT <= 0) this._coinBankT = 0.22;
  }

  /** Ask FX to throw a payout for something that is not a corpse (bonus, sell refund). */
  payout(pos, count = 6, kind = 'coin') {
    this.coins.spray(pos, count, { kind });
    this.game.audio.play('coin.spray', { position: pos });
  }

  // =========================================================================
  // trap signatures
  // =========================================================================
  /**
   * Every trap gets an unmistakable read. Wired to `trap:triggered` so it lands without
   * the trap roster having to opt in, and exposed as named methods so it can.
   */
  trapSignature(trap, victims) {
    if (!trap?.def) return;
    // Passive and fast-cycling traps (tar, brimstone, grinder) fire this several times a
    // second; throttle per trap so their signature stays a punctuation, not a drone.
    const now = this.game.clock.elapsed;
    const min = SIG_THROTTLE[trap.def.id];
    if (min !== undefined) {
      const last = this._trapFxAt.get(trap) ?? -9;
      if (now - last < min) return;
      this._trapFxAt.set(trap, now);
    }
    const fn = this[SIG_METHOD[trap.def.id]];
    if (fn) fn.call(this, trap.world, trap, victims);
  }

  trapSpike(w) {
    // Steel coming up through stone: a tight vertical spray plus grit at the seams.
    for (let i = 0; i < Math.round(14 * this.density); i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit(w.x + Math.cos(a) * 1.4, 0.1, w.z + Math.sin(a) * 1.4,
        Math.cos(a) * 1.2, 7 + Math.random() * 6, Math.sin(a) * 1.2,
        1.0, 0.92, 0.62, 1, 0.06, 0.16 + Math.random() * 0.1, 1);
    }
    // Grit kicked out of the seams — hard specks, not smoke. A spike trap does not puff.
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      this.gore.emit(w.x + Math.cos(a) * 1.6, 0.12, w.z + Math.sin(a) * 1.6,
        Math.cos(a) * 2.4, 2 + Math.random() * 2.5, Math.sin(a) * 2.4,
        0.22, 0.19, 0.16, 1, 0.09 + Math.random() * 0.08, 0.4, 0);
    }
  }

  trapArrow(w, trap) {
    const d = DIR_VEC[trap?.dir] ?? { x: 0, z: 1 };
    for (let i = 0; i < Math.round(10 * this.density); i++) {
      this.sparks.emit(w.x - d.x * 1.6, 1.2 + Math.random() * 1.4, w.z - d.z * 1.6,
        d.x * (14 + Math.random() * 10), (Math.random() - 0.5) * 2, d.z * (14 + Math.random() * 10),
        1.0, 0.88, 0.55, 1, 0.07, 0.22, 1);
    }
    v0.set(w.x - d.x * 1.7, 1.4, w.z - d.z * 1.7);
    this.dust(v0, 0.6, 4, [0.4, 0.36, 0.3]);
  }

  trapBoom(w) {
    // Barrels leave staves and hoops behind, and the blast pushes dust out flat.
    this.fireball(w, 3.4);
    this.gibs.burst(w, null, 10, { color: [0.28, 0.19, 0.11], size: 0.3, spin: 2.4, up: 12, spread: 2, wet: false });
    this.ember(w, 2.6, 26);
  }

  trapPound(w) {
    this.game.audio.play('trap.pound', { position: w });
    this.shockwave(w, 2.6, [0.6, 0.56, 0.5], 34);
    this.gibs.burst(w, null, 7, { color: [0.42, 0.4, 0.37], size: 0.26, spin: 1.6, up: 7, wet: false });
    this.splat(w, 2.6, DUSTMARK, 26);
    this.shake(0.22, 0.18);
  }

  trapSpring(w, trap) {
    this.game.audio.play('trap.spring', { position: w });
    const d = DIR_VEC[trap?.dir] ?? { x: 0, z: 1 };
    for (let i = 0; i < Math.round(18 * this.density); i++) {
      this.sparks.emit(w.x, 0.3, w.z,
        d.x * (6 + Math.random() * 10) + (Math.random() - 0.5) * 3, 9 + Math.random() * 7,
        d.z * (6 + Math.random() * 10) + (Math.random() - 0.5) * 3,
        0.35, 1.0, 0.6, 1, 0.09, 0.4, 1);
    }
    this.dust(w, 1.4, 8, [0.35, 0.7, 0.5]);
  }

  trapBlades(w, trap) {
    this.game.audio.play('trap.blades', { position: w });
    const d = DIR_VEC[trap?.dir] ?? { x: 0, z: 1 };
    // Sparks thrown off the arc, tangent to the sweep.
    for (let i = 0; i < Math.round(16 * this.density); i++) {
      const t = Math.random();
      const px = w.x + d.x * t * 3.4, pz = w.z + d.z * t * 3.4;
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit(px, 0.6 + Math.random() * 1.8, pz,
        Math.cos(a) * 7, 3 + Math.random() * 5, Math.sin(a) * 7,
        1.0, 0.85, 0.5, 1, 0.055, 0.2, 1);
    }
  }

  trapBrimstone(w) {
    this.ember(w, 1.4, 12);
    this.smoke(w, 1.0, 3, [0.2, 0.13, 0.1]);
    this.splat(w, 2.0, SCORCH, 14);
  }

  trapGrinder(w) {
    this.game.audio.play('trap.grind', { position: w });
    // Blood thrown up out of the well plus the metal complaining.
    for (let i = 0; i < Math.round(16 * this.density); i++) {
      const a = Math.random() * Math.PI * 2;
      this.gore.emit(w.x, 0.4, w.z, Math.cos(a) * 5, 6 + Math.random() * 7, Math.sin(a) * 5,
        0.58, 0.1, 0.08, 1, 0.14 + Math.random() * 0.14, 0.6, 0);
    }
    for (let i = 0; i < 6; i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit(w.x, 0.4, w.z, Math.cos(a) * 6, 5 + Math.random() * 4, Math.sin(a) * 6,
        1.0, 0.8, 0.45, 1, 0.05, 0.18, 1);
    }
    this.splat(w, 2.2, BLOOD, 24);
  }

  trapIce(w) {
    this.game.audio.play('trap.ice', { position: w });
    // A column of vapour, then shards falling back out of it.
    for (let i = 0; i < Math.round(22 * this.density); i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit(w.x + Math.cos(a) * 0.6, 0.2, w.z + Math.sin(a) * 0.6,
        Math.cos(a) * 2.2, 8 + Math.random() * 7, Math.sin(a) * 2.2,
        0.6, 0.88, 1.0, 1, 0.11, 0.55, 0);
    }
    this.gibs.burst(w, null, 6, { color: [0.6, 0.85, 1.0], size: 0.2, spin: 2, up: 8, wet: false });
    this.ring(w, 1.8, [0.6, 0.9, 1.0], 26);
    this.splat(w, 2.6, FROST, 8);
  }

  trapBolt(w) {
    this.game.audio.play('trap.zap', { position: w });
    v0.set(w.x, 4.4, w.z);
    this.sparks.emit(w.x, 4.4, w.z, 0, 0, 0, 0.75, 0.9, 1, 1, 1.6, 0.1, 0);
    for (let i = 0; i < 3; i++) {
      v1.set(w.x + (Math.random() - 0.5) * 3, 0.2, w.z + (Math.random() - 0.5) * 3);
      this.lightning(v0, v1, [0.8, 0.92, 1.0]);
    }
    this.flash('#a8d8ff', 0.14, 0.10 + this.tier * 0.01);
  }

  trapAcid(w, trap) {
    this.game.audio.play('trap.acid', { position: w });
    const d = DIR_VEC[trap?.dir] ?? { x: 0, z: 1 };
    for (let i = 0; i < Math.round(20 * this.density); i++) {
      const t = Math.random();
      this.gore.emit(w.x + d.x * t * 8, 1.2 + (Math.random() - 0.5) * 1.2, w.z + d.z * t * 8,
        d.x * 6 + (Math.random() - 0.5) * 3, -1 + Math.random() * 2, d.z * 6 + (Math.random() - 0.5) * 3,
        0.34, 0.72, 0.16, 0.9, 0.3 + Math.random() * 0.4, 0.6 + Math.random() * 0.5, 2);
    }
    v0.set(w.x + d.x * 4, 0, w.z + d.z * 4);
    this.splat(v0, 2.6, ACID, 12);
  }

  trapObelisk(w) {
    this.game.audio.play('trap.obelisk', { position: w });
    // A pillar of violet going up, and two rings going out. Reads as *force*, not fire.
    for (let i = 0; i < Math.round(20 * this.density); i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit(w.x + Math.cos(a) * 0.5, 0.2, w.z + Math.sin(a) * 0.5,
        Math.cos(a) * 1.2, 10 + Math.random() * 9, Math.sin(a) * 1.2,
        0.72, 0.42, 1.0, 1, 0.13, 0.5, 0);
    }
    this.ring(w, 2.4, [0.75, 0.45, 1.0], 34);
    this.ring(w, 1.3, [0.92, 0.75, 1.0], 20);
  }

  trapTar(w) {
    // Deliberately almost nothing: tar's identity is that it is *quiet* and everything
    // else gets louder because of it.
    for (let i = 0; i < 3; i++) {
      const a = Math.random() * Math.PI * 2;
      this.gore.emit(w.x + Math.cos(a) * 1.2, 0.1, w.z + Math.sin(a) * 1.2,
        0, 0.8 + Math.random(), 0, 0.09, 0.07, 0.05, 0.9, 0.35, 0.7, 0);
    }
  }

  // =========================================================================
  // frame
  // =========================================================================
  update(dt) {
    const raw = this.game.clock.rawDt || dt;
    this.sparks.update(dt);
    this.gore.update(dt);
    this._decals.update(dt);
    this.gibs.update(dt);

    const p = this.game.player?.position;
    if (p) this.coins.setTarget(p);
    this.coins.update(dt, this.game.clock.elapsed);

    // Music runs off the audio clock; it only needs a nudge to keep its queue full.
    this._musicPoll -= raw;
    if (this._musicPoll <= 0) { this._musicPoll = 0.05; this.music.update(); }

    this._updateTrails(dt);
    this._updateScreen(raw);
    this._updateNumbers(dt, raw);
  }

  _updateTrails(dt) {
    for (let i = this._trails.length - 1; i >= 0; i--) {
      const h = this._trails[i];
      h.life -= dt;
      if (h.life <= 0 || !h.obj || h.obj.parent === null) { this._trails.splice(i, 1); continue; }
      h.t += dt;
      if (h.t < h.rate) continue;
      h.t = 0;
      const o = h.obj.position ?? h.obj;
      this.sparks.emit(o.x, o.y + h.yOff, o.z, 0, 0.4, 0,
        h.color[0], h.color[1], h.color[2], 1, h.size, 0.3, h.mode);
    }
  }

  _updateScreen(raw) {
    if (this._flashA > 0) {
      this._flashA = Math.max(0, this._flashA - raw / this._flashDur);
      this._flash.style.opacity = String(this._flashA);
    }
    // Combo vignette: a warm frame that tightens as the multiplier climbs. Held, not
    // pulsed, so the player can feel the tier without watching the HUD number.
    const want = this.tier > 0 ? Math.min(0.42, 0.06 + this.tier * 0.09) : 0;
    this._comboPulse = Math.max(0, this._comboPulse - raw * 2.2);
    const a = want + this._comboPulse * 0.25;
    this._vigCombo.style.opacity = a.toFixed(3);
    if (this._hitPulse > 0) {
      this._hitPulse = Math.max(0, this._hitPulse - raw * 1.6);
      this._vigHit.style.opacity = (this._hitPulse * 0.75).toFixed(3);
    } else if (this._vigHit.style.opacity !== '0') {
      this._vigHit.style.opacity = '0';
    }
  }

  _updateNumbers(dt, raw) {
    // Batched payout label: 30 coins landing should read "+42", not thirty overlapping 1s.
    if (this._coinBankT > 0) {
      this._coinBankT -= raw;
      if (this._coinBankT <= 0 && this._coinBank > 0) {
        this.floatText(this._coinBankPos, `+${Math.round(this._coinBank * 8)}`, 'coin', 0.85);
        this._coinBank = 0;
      }
    }

    if (!this._numbers.length) return;
    const cam = this.game.camera;
    const w = this.game.renderer.domElement.clientWidth || this.game.renderer.domElement.width;
    const h = this.game.renderer.domElement.clientHeight || this.game.renderer.domElement.height;
    for (let i = this._numbers.length - 1; i >= 0; i--) {
      const n = this._numbers[i];
      n.age += dt;
      if (n.age >= n.life) {
        n.el.remove();
        if (this._numPool.length < 80) this._numPool.push(n.el);
        this._numbers.splice(i, 1);
        continue;
      }
      n.vy -= 9 * dt;
      n.x += n.vx * dt; n.y += n.vy * dt; n.z += n.vz * dt;
      this._proj.set(n.x, n.y, n.z).project(cam);
      const t = n.age / n.life;
      n.el.style.transform =
        `translate3d(${((this._proj.x * 0.5 + 0.5) * w) | 0}px, ${((-this._proj.y * 0.5 + 0.5) * h) | 0}px, 0) translate(-50%,-50%) scale(${1 + (1 - t) * 0.25})`;
      n.el.style.opacity = String(t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3);
    }
  }

  clear() {
    this.sparks.clear(); this.gore.clear(); this._decals.clear();
    this.gibs.clear(); this.coins.clear();
    for (const n of this._numbers) n.el.remove();
    this._numbers.length = 0;
    this._trails.length = 0;
    this._chain = 0; this._coinBank = 0; this._coinBankT = 0;
    this._flashA = 0; this._flash.style.opacity = '0';
    this._comboPulse = 0; this._hitPulse = 0;
    this._vigCombo.style.opacity = '0'; this._vigHit.style.opacity = '0';
    this.tier = 0; this.multiplier = 1; this.combo = 0;
  }
}

// Decal tints, kept as module constants so no array is allocated per splat.
// These are pre-sRGB and deliberately dark: the flagstones are pale sandstone, so a
// bright red reads as pink paint. Real spatter is nearly black at the centre.
const BLOOD = [0.115, 0.009, 0.007];
const SCORCH = [0.045, 0.038, 0.038];
const FROST = [0.62, 0.86, 1.0];
const ACID = [0.32, 0.68, 0.14];
const DUSTMARK = [0.34, 0.31, 0.28];
const GOLD = [1.0, 0.72, 0.22];

/** Damage type -> death recipe suffix, used by the bloodless path. */
const DEATH_SOUND = {
  fire: 'burn', ice: 'shatter', crush: 'crush', lightning: 'zap',
  poison: 'melt', arcane: 'arcane', physical: 'gib',
};

const DIR_VEC = { N: { x: 0, z: -1 }, E: { x: 1, z: 0 }, S: { x: 0, z: 1 }, W: { x: -1, z: 0 } };

/** trap id -> FX facade method. The single place a trap's identity is declared. */
const SIG_METHOD = {
  'spike-floor': 'trapSpike',
  'arrow-wall': 'trapArrow',
  'boom-barrel': 'trapBoom',
  'ceiling-pounder': 'trapPound',
  'spring-trap': 'trapSpring',
  'wall-blades': 'trapBlades',
  'brimstone': 'trapBrimstone',
  'grinder': 'trapGrinder',
  'ice-vent': 'trapIce',
  'lightning-rod': 'trapBolt',
  'acid-sprayer': 'trapAcid',
  'arcane-obelisk': 'trapObelisk',
  'tar-pit': 'trapTar',
};

/** Minimum seconds between signature bursts, for traps that tick rather than fire. */
const SIG_THROTTLE = {
  'tar-pit': 0.9,
  'brimstone': 0.55,
  'grinder': 0.22,
};

function makeVignette(root, color) {
  const el = document.createElement('div');
  // Inline-styled so the vignette owns no CSS surface of its own.
  el.style.cssText = 'position:absolute;inset:0;pointer-events:none;opacity:0;' +
    'mix-blend-mode:screen;background:radial-gradient(ellipse 78% 68% at 50% 50%,' +
    `rgba(0,0,0,0) 42%, ${color} 100%);`;
  root?.appendChild(el);
  return el;
}

/**
 * Ground splats as a single instanced quad mesh. Colour is per instance so blood, scorch,
 * frost and acid all share one draw call, and the fade multiplies the tint so old marks
 * sink into the floor instead of popping out.
 */
class DecalPool {
  constructor(scene, capacity) {
    this.capacity = capacity;
    this.cursor = 0;
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const tex = makeSplatTexture();
    this.material = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false, opacity: 1,
      blending: THREE.NormalBlending, color: 0xffffff,
    });
    this.mesh = new THREE.InstancedMesh(geo, this.material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    this.mesh.count = capacity;
    this.ages = new Float32Array(capacity).fill(1e9);
    this.lives = new Float32Array(capacity).fill(22);
    this.base = new Float32Array(capacity * 3).fill(1);
    this._m = new THREE.Matrix4();
    // Private scale vector: callers routinely pass a shared scratch vector as `pos`, and
    // borrowing v0 here would overwrite the position before we read it.
    this._sv = new THREE.Vector3();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, this._hidden);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3).fill(1), 3);
    this.mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.mesh);
  }

  splat(pos, size = 1.5, r = 0.62, g = 0.07, b = 0.055, life = 22) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.capacity;
    this._m.makeRotationY(Math.random() * Math.PI * 2);
    this._m.scale(this._sv.set(size, 1, size));
    // Stagger the height by slot so overlapping splats layer instead of z-fighting.
    this._m.setPosition(pos.x + (Math.random() - 0.5) * 0.6, 0.03 + (i % 24) * 0.0012, pos.z + (Math.random() - 0.5) * 0.6);
    this.mesh.setMatrixAt(i, this._m);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.ages[i] = 0;
    this.lives[i] = life;
    this.base[i * 3] = r; this.base[i * 3 + 1] = g; this.base[i * 3 + 2] = b;
    const c = this.mesh.instanceColor.array;
    c[i * 3] = r; c[i * 3 + 1] = g; c[i * 3 + 2] = b;
    this.mesh.instanceColor.needsUpdate = true;
  }

  update(dt) {
    let dirty = false;
    const c = this.mesh.instanceColor.array;
    for (let i = 0; i < this.capacity; i++) {
      const a = this.ages[i];
      const life = this.lives[i];
      if (a > life) continue;
      this.ages[i] = a + dt;
      const t = Math.min(1, this.ages[i] / life);
      const f = 1 - t * t;
      c[i * 3] = this.base[i * 3] * f;
      c[i * 3 + 1] = this.base[i * 3 + 1] * f;
      c[i * 3 + 2] = this.base[i * 3 + 2] * f;
      dirty = true;
      if (this.ages[i] > life) { this.mesh.setMatrixAt(i, this._hidden); this.mesh.instanceMatrix.needsUpdate = true; }
    }
    if (dirty) this.mesh.instanceColor.needsUpdate = true;
  }

  clear() {
    for (let i = 0; i < this.capacity; i++) { this.mesh.setMatrixAt(i, this._hidden); this.ages[i] = 1e9; }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

function makeSplatTexture(size = 128) {
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, size, size);
  g.fillStyle = '#fff';
  // A cluster of overlapping blobs reads as a splat, not a circle.
  for (let i = 0; i < 16; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() ** 1.6 * size * 0.34;
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r;
    const rad = size * (0.04 + Math.random() * 0.13);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.65, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  // A few thrown droplets outside the main mass — the detail that makes it read as spatter.
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = size * (0.28 + Math.random() * 0.2);
    const x = size / 2 + Math.cos(a) * r;
    const y = size / 2 + Math.sin(a) * r;
    const rad = size * (0.008 + Math.random() * 0.022);
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.beginPath(); g.arc(x, y, rad, 0, Math.PI * 2); g.fill();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
