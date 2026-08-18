import * as THREE from 'three';
import { buildHero } from './heroModel.js';
import { WEAPONS } from './weapons.js';
import { PlayerProjectiles } from './projectiles.js';
import { Spellbook } from './spells.js';
import { Progression } from './upgrades.js';
import { applyDamage, recomputeStatusMods } from '../../shared/Damage.js';
import { clamp, damp, angleDelta } from '../../shared/rng.js';

/**
 * The War Mage.
 *
 * Design line: the traps are the damage, you are the *answer to whatever the traps
 * missed*. So this controller is tuned entirely for response, not for output —
 * instant acceleration, a short stop-slide, a dodge with real distance and real
 * i-frames, and weapons that fire on the input edge with nothing between the click and
 * the damage. A 60-75% trap kill share is the target; the rest is you.
 *
 * Timing rules: every clock in here is `game.clock.dt`. No setTimeout, no rAF. That is
 * what makes pause, hitstop and slow-motion apply to the player as well as the horde.
 */

// Movement constants live here rather than as magic numbers in update() so they can be
// read as a group — this is the feel budget.
const MOVE = {
  speed: 9.4,
  accel: 90,        // as an exponential rate: effectively instant. "No lag on start."
  friction: 14,     // ~0.2s of slide when you let go. Enough weight to feel like a body.
  dodgeTime: 0.30,
  dodgeBoost: 30,   // integrates to ~6.0 units, a tile and a half
  dodgeCd: 0.75,
  dodgeIframeTail: 0.06,  // i-frames end slightly before the roll does: no free landing
  inputBuffer: 0.15,      // a dodge or a shot pressed during cooldown still lands
  radius: 0.55,
  crowdPush: 4.0,   // enemies nudge you aside but can never wall you in
};

export class Player {
  constructor(game) {
    this.game = game;
    this.kind = 'player';
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.aimPoint = new THREE.Vector3();
    this.facing = 0;
    this.aimAngle = 0;

    // --- damage model (mirrors the Enemy contract so applyDamage() works on us) ---
    this.hpBase = 150;
    this.hp = this.hpBase;
    this.dead = false;
    this.invulnerable = false;
    this.armor = 0;
    this.shield = null;
    this.mass = 1;
    this.resist = null;
    this.statuses = [];
    this.statusMods = {};
    recomputeStatusMods(this);
    this.iframes = 0;
    this.hurtAt = -10;
    this.regenDelay = 0;
    this.respawnTime = 3.0;
    this.respawnT = 0;

    this.speed = MOVE.speed;
    this.accel = MOVE.accel;
    this.friction = MOVE.friction;
    this.dodgeTime = MOVE.dodgeTime;
    this.dodgeCd = 0;
    this.dodgeT = 0;
    this.dodgeDir = new THREE.Vector3();
    this._dodgeBuffer = 0;
    this._fireBuffer = 0;
    this.blinkFlash = 0;

    this.manaBase = 100;
    this.mana = this.manaBase;
    this.manaRegenBase = 12;

    this.weaponIndex = 0;
    this.weapons = WEAPONS.map((w) => ({
      def: w, cooldown: 0, ammo: w.magazine ?? Infinity, reloading: 0,
    }));
    this.swapT = 0;
    this.meleeCd = 0;

    // Order matters: progression fills `mods`, which weapons and spells read.
    this.progression = new Progression(game);
    this.mods = this.progression.mods;
    this.projectiles = new PlayerProjectiles(game);
    this.spells = new Spellbook(game, this);

    const { group, rig } = buildHero();
    this.object = group;
    this.rig = rig;
    game.scene.add(this.object);
    this.rig.setWeapon(this.weapon.def.id);

    this._move = { x: 0, y: 0 };
    this._aimStick = { x: 0, y: 0 };
    this._lastFireAt = -10;
    this._wallT = 0;

    game.bus.on('level:load', () => this.reset());
    this.onModsChanged();
  }

  // --- derived stats --------------------------------------------------------
  get weapon() { return this.weapons[this.weaponIndex]; }
  get hpMax() { return this.hpBase + (this.mods?.hpMax ?? 0); }
  get manaMax() { return this.manaBase + (this.mods?.manaMax ?? 0); }
  get manaRegen() { return this.manaRegenBase + (this.mods?.manaRegen ?? 0); }
  get regenRate() { return 7 + (this.mods?.regen ?? 0); }

  /** Called by Progression whenever a rank is bought, so live stats pick it up at once. */
  onModsChanged() {
    this.speed = MOVE.speed * (this.mods?.speed ?? 1);
    this.hp = Math.min(this.hp, this.hpMax);
    this.mana = Math.min(this.mana, this.manaMax);
  }

  has() { return false; }         // no enemy ability flags apply to the player
  applyImpulse(x, y, z) { this.velocity.x += x; this.velocity.z += z; }
  addStatus(spec) {
    const existing = this.statuses.find((s) => s.kind === spec.kind);
    if (existing) { existing.duration = Math.max(existing.duration, spec.duration); }
    else this.statuses.push({ ...spec });
    recomputeStatusMods(this);
  }

  reset() {
    this.hp = this.hpMax;
    this.mana = this.manaMax;
    this.dead = false;
    this.iframes = 0;
    this.respawnT = 0;
    this.statuses.length = 0;
    recomputeStatusMods(this);
    this.velocity.set(0, 0, 0);
    this.dodgeT = 0; this.dodgeCd = 0; this.swapT = 0; this.meleeCd = 0;
    for (const w of this.weapons) { w.cooldown = 0; w.ammo = w.def.magazine ?? Infinity; w.reloading = 0; }
    this.spells.reset();
    this.projectiles.clear();
    this.object.visible = true;
    this.rig.reset();
  }

  spawnAt(v) {
    this.position.copy(v);
    this.position.y = 0;
    this.object.position.copy(this.position);
    this.game.rig.focus.copy(this.position);
    this.reset();
  }

  // --- damage ---------------------------------------------------------------
  /**
   * The entry point enemies and enemy projectiles call. Mitigation itself goes through
   * the shared `applyDamage` funnel so resistances, shields and statuses behave exactly
   * as they do for orcs — but with `game` omitted, because that funnel emits
   * `enemy:damaged`, and the player is not an enemy. We emit `player:damaged` instead.
   */
  takeDamage(amount, source) {
    if (this.dead || this.iframes > 0 || this.invulnerable) return 0;
    const g = this.game;
    const dealt = applyDamage(this, {
      amount, type: 'physical', source, position: source?.position ?? this.position,
    });
    if (dealt <= 0) return 0;

    this.iframes = 0.35;
    this.hurtAt = g.clock.elapsed;
    this.regenDelay = 5;
    g.fx.shake(clamp(dealt / 40, 0.15, 0.6), 0.25);
    g.fx.flash('#c81414', 0.2, clamp(dealt / 90, 0.15, 0.55));
    g.fx.blood(this.position, null, 0.5);
    g.audio.play('hit.flesh', { position: this.position, pitch: 1.3 });
    g.bus.emit('player:damaged', { amount: dealt, remaining: this.hp });
    return dealt;
  }

  /** Called by applyDamage when hp hits zero. */
  kill() {
    if (this.dead) return;
    const g = this.game;
    this.hp = 0;
    this.dead = true;
    this.respawnT = this.respawnTime;
    this.velocity.set(0, 0, 0);
    this.dodgeT = 0;
    g.fx.gib(this.position, null, 12, [0.5, 0.15, 0.15]);
    g.fx.shake(0.8, 0.5);
    g.fx.flash('#c81414', 0.5, 0.65);
    g.bus.emit('player:died', {});
  }

  _respawn() {
    const g = this.game;
    if (g.state === 'defeat' || g.state === 'victory') return;
    const l = g.level;
    if (l) this.position.copy(l.playerSpawn);
    this.hp = this.hpMax * 0.6;
    this.mana = this.manaMax * 0.5;
    this.dead = false;
    this.iframes = 2;
    this.velocity.set(0, 0, 0);
    this.object.visible = true;
    g.rig.focus.copy(this.position);
    g.fx.ring(this.position, 2, [0.4, 0.8, 1], 40);
    g.audio.play('magic.shot', { position: this.position, pitch: 0.7 });
  }

  // --- frame ----------------------------------------------------------------
  update(dt) {
    const g = this.game;
    if (g.state === 'menu') return;

    // Projectiles tick before anything can consume them, and keep ticking while the
    // player is dead — a fireball already in the air still has to land.
    this.projectiles.update(dt);
    if (g.state === 'paused') return;

    if (this.blinkFlash > 0) this.blinkFlash = Math.max(0, this.blinkFlash - dt);

    if (this.dead) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) this._respawn();
      this.object.position.copy(this.position);
      this.rig.animate(this, dt, 0);
      return;
    }

    const input = g.input;
    if (this.iframes > 0) this.iframes -= dt;
    if (this.dodgeCd > 0) this.dodgeCd -= dt;
    if (this.swapT > 0) this.swapT -= dt;
    if (this.meleeCd > 0) this.meleeCd -= dt;
    if (this._dodgeBuffer > 0) this._dodgeBuffer -= dt;
    if (this._fireBuffer > 0) this._fireBuffer -= dt;

    this._tickStatuses(dt);

    // Passive regen once you have been out of trouble for a moment.
    if (this.regenDelay > 0) this.regenDelay -= dt;
    else if (this.hp < this.hpMax) this.hp = Math.min(this.hpMax, this.hp + this.regenRate * dt);
    this.mana = Math.min(this.manaMax, this.mana + this.manaRegen * dt);

    // --- aim ---------------------------------------------------------------
    const stick = input.aimStick(this._aimStick);
    if (stick) {
      this.aimAngle = Math.atan2(stick.x, stick.y);
      this.aimPoint.set(this.position.x + stick.x * 14, 0, this.position.z + stick.y * 14);
    } else {
      this.aimPoint.copy(input.aimWorld);
      this.aimAngle = Math.atan2(this.aimPoint.x - this.position.x, this.aimPoint.z - this.position.z);
    }

    // --- movement ----------------------------------------------------------
    input.moveVector(this._move);
    // Screen-relative: W is "up the screen", which is what a top-down player expects.
    const yaw = g.rig.yaw;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    const mx = this._move.x * cs - this._move.y * sn;
    const mz = -this._move.x * sn - this._move.y * cs;

    if (input.pressed('dodge')) this._dodgeBuffer = MOVE.inputBuffer;

    if (this.dodgeT > 0) {
      this.dodgeT -= dt;
      const t = 1 - this.dodgeT / this.dodgeTime;
      const boost = MOVE.dodgeBoost * (1 - t * t);
      this.velocity.x = this.dodgeDir.x * boost;
      this.velocity.z = this.dodgeDir.z * boost;
      this.iframes = Math.max(this.iframes, this.dodgeT - MOVE.dodgeIframeTail);
    } else {
      if (this._dodgeBuffer > 0 && this.dodgeCd <= 0) { this._dodgeBuffer = 0; this._dodge(mx, mz); }
      const moving = mx !== 0 || mz !== 0;
      const target = this.speed * (this.statusMods.speed ?? 1);
      const r = Math.exp(-(moving ? this.accel : this.friction));
      this.velocity.x = damp(this.velocity.x, mx * target, r, dt);
      this.velocity.z = damp(this.velocity.z, mz * target, r, dt);
    }

    this._collide(dt);
    this._crowd(dt);

    // --- weapons -----------------------------------------------------------
    this._handleSwap(input);
    for (const w of this.weapons) {
      if (w.cooldown > 0) w.cooldown -= dt;
      if (w.reloading > 0) {
        w.reloading -= dt;
        if (w.reloading <= 0) {
          w.ammo = w.def.magazine;
          g.audio.play('ui.click', { pitch: 0.7 });
          if (w === this.weapon) g.fx.ring(this.position, 1.1, w.def.color, 14);
        }
      }
    }

    const w = this.weapon;
    const buildMode = g.traps.buildMode;
    if (!buildMode) {
      if (w.def.auto ? input.mouseDown(0) : input.mouseClicked(0)) this._fireBuffer = MOVE.inputBuffer;
      if (this._fireBuffer > 0 && this.swapT <= 0 && w.cooldown <= 0 && w.reloading <= 0) this._tryFire(w);
      if (input.mouseClicked(2)) this._melee();
    }
    if (input.pressed('reload') && w.ammo < (w.def.magazine ?? 0) && w.reloading <= 0) {
      w.reloading = w.def.reloadTime ?? 1.2;
      g.audio.play('ui.click', { pitch: 0.55 });
    }

    // --- spells ------------------------------------------------------------
    this.spells.update(dt, !buildMode);

    // --- render ------------------------------------------------------------
    this.object.position.copy(this.position);
    // Always face the cursor. The earlier version faced the movement direction when not
    // shooting, which meant the hat point, the chest chevron, the weapon and the floor
    // lance could all disagree — four cues, four answers. Movement is read from the legs
    // and the cloak instead; direction is read from exactly one place.
    this.facing += angleDelta(this.facing, this.aimAngle) * Math.min(1, dt * 20);
    this.object.rotation.y = this.facing;
    this.rig.animate(this, dt, Math.hypot(this.velocity.x, this.velocity.z));

    g.rig.follow(this.position, this.aimPoint);
  }

  _tickStatuses(dt) {
    if (!this.statuses.length) return;
    let changed = false;
    for (let i = this.statuses.length - 1; i >= 0; i--) {
      const s = this.statuses[i];
      s.duration -= dt;
      if (s.duration <= 0) { this.statuses.splice(i, 1); changed = true; }
    }
    if (changed) recomputeStatusMods(this);
  }

  // --- weapons --------------------------------------------------------------
  _handleSwap(input) {
    const n = this.weapons.length;
    let dir = 0;
    // The old expression added `len - 1` on a keypress *and* `1` on the line below,
    // which is `+n` — a no-op. Q genuinely did nothing. One branch, one direction.
    if (input.pressed('swapWeapon')) dir = 1;
    else if (input.mouse.wheel) dir = input.mouse.wheel > 0 ? 1 : -1;
    if (!dir) return;
    this.setWeapon((this.weaponIndex + dir + n) % n);
  }

  setWeapon(i) {
    if (i === this.weaponIndex || i < 0 || i >= this.weapons.length) return;
    this.weaponIndex = i;
    const def = this.weapon.def;
    // A short swap lockout: it costs almost nothing but it makes the choice feel real
    // instead of letting you alternate weapons to dodge every cooldown.
    this.swapT = def.swapTime ?? 0.16;
    this.rig.setWeapon(def.id);
    this.game.audio.play('ui.click', { pitch: 1.4 });
    this.game.bus.emit('player:weapon', { id: def.id, index: i });
  }

  _tryFire(w) {
    const g = this.game;
    const def = w.def;
    if (w.ammo <= 0) {
      w.reloading = def.reloadTime ?? 1.2;
      g.audio.play('ui.click', { pitch: 0.55 });
      return;
    }
    if (def.mana > 0 && this.mana < def.mana) {
      // Dry-fire tell: a short lockout plus a red gauge, so "out of mana" is not silence.
      w.cooldown = 0.28;
      this._fireBuffer = 0;
      g.audio.play('ui.hover', { pitch: 0.4, gain: 0.4 });
      return;
    }
    this._fireBuffer = 0;
    this._fire(w);
  }

  _fire(w) {
    const g = this.game;
    const def = w.def;
    w.cooldown = def.cooldown;
    if (w.ammo !== Infinity) w.ammo--;
    if (def.mana > 0) this.mana -= def.mana;
    this._lastFireAt = g.clock.elapsed;

    // Muzzle sits at chest height, slightly ahead, so a point-blank shot does not
    // originate behind the orc that is already inside your hitbox.
    _origin.set(
      this.position.x + Math.sin(this.aimAngle) * 0.7, 1.25,
      this.position.z + Math.cos(this.aimAngle) * 0.7,
    );
    def.fire(this, _origin, this.aimAngle, g);

    // Recoil: a backward shove sells weight without fighting the player.
    const kick = def.recoil ?? 0;
    this.velocity.x -= Math.sin(this.aimAngle) * kick;
    this.velocity.z -= Math.cos(this.aimAngle) * kick;
    this.rig.recoil(def.recoilAnim ?? 0.5);
    g.fx.shake(def.shake ?? 0.06, 0.1);

    if (w.ammo === 0) w.reloading = def.reloadTime ?? 1.2;
  }

  _melee() {
    const g = this.game;
    if (this.meleeCd > 0) return;
    this.meleeCd = 0.55;
    this.rig.swing();
    g.audio.play('bow.shot', { position: this.position, pitch: 0.55 });
    const reach = 3.6;
    const hits = g.enemies.queryRadius(this.position, reach);
    const dmg = 55 * (this.mods?.dmg?.melee ?? 1);
    let n = 0;
    for (const e of hits) {
      // 160 degree frontal arc — wide enough to be the panic button it needs to be.
      const a = Math.atan2(e.position.x - this.position.x, e.position.z - this.position.z);
      if (Math.abs(angleDelta(this.aimAngle, a)) > 1.4) continue;
      const dealt = applyDamage(e, {
        amount: dmg, type: 'crush', source: { kind: 'player', id: 'melee' },
        position: this.position,
        knockback: {
          x: Math.sin(a) * 30 * (this.mods?.knockback ?? 1), y: 3.5,
          z: Math.cos(a) * 30 * (this.mods?.knockback ?? 1),
        },
      }, g);
      g.fx.hit(e.position, null, { count: 10, color: [1, 0.9, 0.6] });
      g.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : 'normal');
      n++;
    }
    if (n) { g.engine.hitstop(0.04); g.fx.shake(0.25, 0.15); }
  }

  // --- movement helpers -----------------------------------------------------
  _dodge(mx, mz) {
    const len = Math.hypot(mx, mz);
    // No stick input? Roll where you are looking, not where you are facing — during a
    // firefight the body lags the cursor and rolling "backwards" would feel broken.
    if (len < 0.1) this.dodgeDir.set(Math.sin(this.aimAngle), 0, Math.cos(this.aimAngle));
    else this.dodgeDir.set(mx / len, 0, mz / len);
    this.dodgeT = this.dodgeTime;
    // Grant i-frames on the *starting* frame, not on the next one. Measured: without
    // this there is a one-frame window at the very start of the roll where a hit still
    // lands, which is exactly the frame a player presses dodge to avoid.
    this.iframes = Math.max(this.iframes, this.dodgeTime - MOVE.dodgeIframeTail);
    this.dodgeCd = Math.max(0.35, MOVE.dodgeCd + (this.mods?.dodgeCd ?? 0));
    this._wallT = 0;
    this.game.fx.dust(this.position, 1.0, 12);
    this.game.audio.play('ui.hover', { pitch: 0.6 });
  }

  _collide(dt) {
    const grid = this.game.grid;
    if (!grid) return;
    const r = MOVE.radius;
    const nx = this.position.x + this.velocity.x * dt;
    const nz = this.position.z + this.velocity.z * dt;
    const pass = (x, z) => grid.isWalkable(Math.floor(x / 4), Math.floor(z / 4));

    // Axis-separated so running along a wall slides instead of stopping dead.
    let blocked = 0;
    if (pass(nx + Math.sign(this.velocity.x) * r, this.position.z)) this.position.x = nx;
    else { this.velocity.x = 0; blocked++; }
    if (pass(this.position.x, nz + Math.sign(this.velocity.z) * r)) this.position.z = nz;
    else { this.velocity.z = 0; blocked++; }

    // A dodge into a wall should end, not grind you against it for a third of a second.
    if (this.dodgeT > 0 && blocked === 2) {
      this._wallT += dt;
      if (this._wallT > 0.05) { this.dodgeT = 0; this._wallT = 0; }
    } else this._wallT = 0;

    // Knockback or a bad blink can still deposit us inside geometry; walk back out.
    if (!pass(this.position.x, this.position.z)) this._unstick(grid);
  }

  _unstick(grid) {
    for (let r = 1; r <= 3; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = this.position.x + dx * 4, z = this.position.z + dz * 4;
          if (!grid.isWalkable(Math.floor(x / 4), Math.floor(z / 4))) continue;
          this.position.x = x; this.position.z = z;
          this.velocity.set(0, 0, 0);
          return;
        }
      }
    }
  }

  /**
   * Soft crowd pressure. Orcs nudge you out of their volume so a mob feels physical,
   * but it is a positional push with a hard per-frame cap and no velocity coupling —
   * a wall of orcs can never pin you. A dodge phases through entirely, which is the
   * whole point of having one.
   */
  _crowd(dt) {
    if (this.dodgeT > 0) return;
    const g = this.game;
    if (!g.enemies) return;
    const near = g.enemies.queryNear(this.position, 2.6);
    let px = 0, pz = 0;
    for (const e of near) {
      if (e.dead || e.airborne) continue;
      const dx = this.position.x - e.position.x;
      const dz = this.position.z - e.position.z;
      const d2 = dx * dx + dz * dz;
      const want = MOVE.radius + e.radius;
      if (d2 > want * want || d2 < 1e-4) continue;
      const d = Math.sqrt(d2);
      const k = (want - d) / want;
      px += (dx / d) * k; pz += (dz / d) * k;
    }
    const mag = Math.hypot(px, pz);
    if (mag < 1e-4) return;
    const push = Math.min(mag, 1) * MOVE.crowdPush * dt;
    const nx = this.position.x + (px / mag) * push;
    const nz = this.position.z + (pz / mag) * push;
    const grid = g.grid;
    if (!grid || grid.isWalkable(Math.floor(nx / 4), Math.floor(nz / 4))) {
      this.position.x = nx; this.position.z = nz;
    }
  }

  // --- read-only surface for the HUD / debug harness ------------------------
  /** Everything a weapon widget needs, without reaching into internals. */
  weaponInfo() {
    return this.weapons.map((w, i) => ({
      id: w.def.id, name: w.def.name, icon: w.def.icon, role: w.def.role,
      selected: i === this.weaponIndex,
      ammo: w.ammo, magazine: w.def.magazine, reloading: w.reloading,
      mana: w.def.mana, ready: w.cooldown <= 0 && w.reloading <= 0,
      // Semi-auto weapons swallow a held trigger with no feedback, which a critic called
      // "undiscoverable". The HUD needs this to label them, so expose it rather than
      // making the UI reach into `weapons[i].def`.
      auto: !!w.def.auto,
    }));
  }
  /** Spell id / key / 0-1 readiness, for a cooldown row in the HUD. */
  spellInfo() {
    return this.spells.list.map((s) => ({
      id: s.def.id, name: s.def.name, icon: s.def.icon, key: s.def.keyLabel,
      ready: s.ready, cooldown: s.def.cooldown, remaining: +s.cd.toFixed(2),
    }));
  }
}

// Persistent, not borrowed from shared/scratch: `origin` stays live for the whole
// duration of a weapon's fire() call, which itself borrows scratch vectors.
const _origin = new THREE.Vector3();
