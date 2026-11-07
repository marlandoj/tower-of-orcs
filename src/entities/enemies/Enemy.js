import * as THREE from 'three';
import { applyDamage, recomputeStatusMods } from '../../shared/Damage.js';
import { clamp, damp, angleDelta } from '../../shared/rng.js';
import { v0, v1 } from '../../shared/scratch.js';
import { losClear, MAX_HUNTERS } from './abilities.js';

const _dir = { x: 0, z: 0 };
const _cell = { gx: 0, gz: 0 };

/**
 * One orc. Pooled: `spawn()` reinitialises, `release()` returns it to the manager.
 *
 * Steering is flow-field + a crowd model, not just separation. The difference between a
 * queue and a *horde* is what happens when they cannot all fit:
 *
 *   - shoves are mass-weighted, so a brute walks through kobolds and a kobold bounces off;
 *   - an orc that is genuinely behind another in the queue stops trying to overtake and
 *     instead pushes it forward (front-rank pressure), which is what makes a doorway
 *     compress into a plug rather than dissolve into a swirl;
 *   - lateral avoidance is damped in narrow cells so they form a column at chokepoints;
 *   - anything that stays blocked long enough stops shuffling and starts *hitting* the
 *     thing in its way — the player, a guardian, whatever.
 */
export class Enemy {
  constructor(game) {
    this.game = game;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.impulse = new THREE.Vector3();
    this.object = new THREE.Group();
    this.object.visible = false;
    this.statuses = [];
    this.statusMods = {};
    this.dead = true;
    this.def = null;
    this.rig = null;
    this.facing = 0;
    this.__idx = undefined;
    // Crowd scratch — plain floats so the hot loop never allocates.
    this.pressX = 0; this.pressZ = 0;
    this.goalDist = Infinity;
    this.culled = false;
  }

  // --- lifecycle ------------------------------------------------------------
  spawn(def, x, z, opts = {}) {
    this.def = def;
    this.id = def.id;
    this.hpMax = Math.round((def.hp ?? 60) * (opts.hpScale ?? 1));
    this.hp = this.hpMax;
    this.speedBase = (def.speed ?? 3.2) * (opts.speedScale ?? 1);
    this.radius = def.radius ?? 0.55;
    this.mass = def.mass ?? 1;
    this.armor = def.armor ?? 0;
    this.resist = def.resist ?? null;
    this.flagSet = def._flagSet;
    this.damageToRift = def.damageToRift ?? 1;
    this.attackDamage = def.attackDamage ?? 10;
    this._baseAttack = this.attackDamage;
    this.attackRate = def.attackRate ?? 1.1;
    this.attackRange = def.attackRange ?? 1.6;
    this.attackAnim = def.attackAnim ?? 0.72;
    this.dead = false;
    this.invulnerable = false;
    this.grounded = true;
    this.airborne = !!def._flagSet.has('flying');
    this.flyHeight = def.flyHeight ?? 3.2;
    this.state = 'walk';
    this.stateT = 0;
    this.attackCd = 0;
    this.abilityCd = def.abilityCooldown ?? 0;
    this.target = null;
    this.attackTarget = null;
    this.pendingHit = -1;
    this.staggerDur = 0.5;
    this.leapT = 0;
    this.blockedT = 0;
    this.pressX = 0; this.pressZ = 0;
    this.phase = 0;                 // boss phase index, owned by boss AI
    this.phaseLock = 0;             // invulnerable roar between phases
    this.chargeState = null;
    this._alt = false;
    this._cycle = -1;
    this._shieldBroken = false;
    // Transient state owned by archetype abilities (abilities.js / roster.js). Enemies are
    // pooled, so anything an ability leaves behind would otherwise carry into the next
    // life: an Ogre killed mid-windup used to resume that old slam on respawn. Reset to
    // `undefined`, which is exactly what a never-used enemy starts with.
    this.slamT = this.slamWind = this.slamR = this.slamDamage = this.slamWreck = this.slamMark = undefined;
    this.chargeT = this.chargeDX = this.chargeDZ = this.chargeHit = undefined;
    this.leapPounce = this.leapVX = this.leapVY = this.leapVZ = undefined;
    this.siegeCd = this.siegeCheck = this.siegeHit = this.siegeTarget = undefined;
    this._chew = undefined;
    this._healedAt = undefined;
    this.statuses.length = 0;
    recomputeStatusMods(this);

    this.shield = def.shield ? { hp: def.shield.hp, absorb: def.shield.absorb ?? 0.85, arcCos: Math.cos((def.shield.arc ?? 100) * Math.PI / 360), max: def.shield.hp } : null;

    this.position.set(x, this.airborne ? this.flyHeight : 0, z);
    this.velocity.set(0, 0, 0);
    this.impulse.set(0, 0, 0);
    this.facing = opts.facing ?? 0;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.wobbleSeed = Math.random() * 100;

    // Stealth units arrive already faded; they solidify the moment they commit.
    this.stealthed = this.flagSet.has('stealth');
    this.revealT = 0;

    // --- threat ------------------------------------------------------------
    // Whether this particular orc is one of the ones that will turn on the hero is
    // rolled once, here, off the seeded RNG. Rolling it per-orc rather than deciding it
    // per-archetype is what makes a wave feel like a crowd with opinions instead of a
    // switch: the same twelve grunts split into some that come for you and some that
    // walk past you to the rift, and which is which is stable for that orc's whole life.
    this.aggro = def.aggro ?? 7.5;
    // The floor of 32 is the crossbow's reach with a little slack. An orc that can be
    // shot has to be an orc that can arrive, or `provoke` is a rumour: a chase that
    // gives up at 19 metres against a weapon that reaches 30 never leaves the ground.
    this.leash = def.leash ?? Math.max(this.aggro * 2.4, 32);
    this.huntTime = def.huntTime ?? 4.5;
    this.aggressive = (this.game.rng ? this.game.rng() : Math.random()) < (def.aggroChance ?? 0.5);
    this.hunt = 0;
    this.huntCd = 0;
    this.huntSpent = 0;
    this.hunting = false;
    this.threatT = 0;
    this.speedMul = 1;

    this.object.position.copy(this.position);
    this.object.visible = true;
    this.object.scale.setScalar(def.scale ?? 1);
    this.culled = false;
    this.rig?.reset?.();
    this.rig?.setStealth?.(this.stealthed);
    def.onSpawn?.(this, this.game);
    return this;
  }

  has(flag) { return this.flagSet.has(flag); }

  addStatus(spec, game) {
    // Refresh rather than stack duplicates, except for damage-over-time.
    const existing = this.statuses.find((s) => s.kind === spec.kind);
    if (existing && spec.kind !== 'burn' && spec.kind !== 'poison') {
      existing.duration = Math.max(existing.duration, spec.duration);
      existing.power = Math.max(existing.power, spec.power);
    } else {
      if (spec.kind === 'freeze' && this.has('frost-immune')) return;
      if (spec.kind === 'burn' && this.has('fire-immune')) return;
      if ((spec.kind === 'stun' || spec.kind === 'web') && this.has('unstoppable')) return;
      this.statuses.push({ ...spec });
    }
    recomputeStatusMods(this);
  }

  applyImpulse(x, y, z) {
    this.impulse.x += x; this.impulse.y += y; this.impulse.z += z;
    if (y > 0.5) this.grounded = false;
    // A shove big enough to move an orc should visibly cost it its footing.
    const mag = Math.hypot(x, z);
    if (mag > 5 && !this.has('unstoppable') && this.state !== 'dead') {
      this.state = 'stagger';
      this.stateT = 0;
      this.staggerDur = clamp(mag / 34, 0.28, 0.9);
      this.pendingHit = -1;
    }
  }

  /**
   * Turn on whoever just hit us, if we are the sort of orc that does.
   *
   * This is the half of the threat model that proximity alone could not supply, and the
   * measurement that forced it is stark: with aggro-on-sight only, across four waves of
   * The Forge behind a real killbox, **the closest any orc ever came to the hero was 22
   * metres.** The crossbow reaches 30 and kills a grunt in two shots, so a player parked
   * at the back of their own corridor simply deleted everything from outside the radius
   * at which anything could decide to care. "Aggro range" cannot be shorter than "weapon
   * range" or it never fires.
   *
   * So: shooting an orc is *how you get its attention*, at any range you can reach it
   * from. It costs nothing to a player who is already in the fight, and it is the entire
   * price of sniping the corridor from safety — which is exactly the free lunch the
   * review found. The `aggressive` roll still gates it, so a wave that is being shot at
   * splits rather than turning as one body, and `MAX_HUNTERS` still caps the pack.
   *
   * Traps are deliberately not a provocation. An orc dying in a spike floor has nobody to
   * blame, and if traps pulled aggro the player could bait the whole horde with masonry.
   */
  provoke(game) {
    if (this.dead || !this.aggressive) return;
    const p = game.player;
    if (!p || p.dead) return;
    if (this.hunt > 0) { this.hunt = Math.max(this.hunt, this.huntTime * 0.6); return; }
    if (this.huntSpent >= 14) return;              // already had its turn this episode
    const dx = p.position.x - this.position.x, dz = p.position.z - this.position.z;
    if (dx * dx + dz * dz > this.leash * this.leash) return;
    const boss = this.has('boss');
    if (!boss && game.enemies.hunters >= MAX_HUNTERS) return;
    this.hunt = this.huntTime;
    this.huntCd = 0;
    if (!boss) game.enemies.hunters++;
  }

  /** Called by EnemyManager off the `enemy:damaged` bus so the rig can react. */
  onDamaged(p) {
    if (p.amount <= 0 || this.dead) return;
    if (this.stealthed) this.reveal();
    if (p.source?.kind === 'player') this.provoke(this.game);
    if (!this.rig || this.culled) return;
    const src = p.position;
    let dx = 0, dz = 1;
    if (src) { dx = this.position.x - src.x; dz = this.position.z - src.z; }
    const d = Math.hypot(dx, dz) || 1;
    this.rig.flinch(dx / d, dz / d, clamp(p.amount / Math.max(20, this.hpMax * 0.25), 0.3, 1.4), this.facing);
  }

  /** Stealth drops the moment it strikes or is struck; it fades back in after a lull. */
  reveal(seconds = 4) {
    this.revealT = Math.max(this.revealT, seconds);
    if (this.stealthed) { this.stealthed = false; this.rig?.setStealth?.(false); }
  }

  kill(spec, game) {
    if (this.dead) return;
    this.dead = true;
    this.state = 'dead';
    const g = game || this.game;
    const byTrap = spec?.source?.kind === 'trap';
    // Decided before the event so JUICE's death handler can match its visuals to what the
    // body actually does: an obliterated orc leaves gibs and no corpse, a normal kill
    // crumples and lies there. Bosses never leave a body — the blast needs the space.
    const overkill = spec ? spec.amount / Math.max(1, this.hpMax) : 0;
    this.gibbed = overkill > 0.5 || this.has('boss');
    g.bus.emit('enemy:killed', {
      enemy: this, killer: spec?.source, position: this.position.clone(),
      byTrap, trapId: byTrap ? spec.source.id : null, gibbed: this.gibbed,
    });
    this.def.onDeath?.(this, g, spec);
    g.enemies.despawn(this, spec);
  }

  // --- per-frame ------------------------------------------------------------
  update(dt, game) {
    if (this.dead) return;

    // --- statuses ---
    if (this.statuses.length) {
      let changed = false;
      for (let i = this.statuses.length - 1; i >= 0; i--) {
        const s = this.statuses[i];
        s.duration -= dt;
        if (s.kind === 'burn' || s.kind === 'poison') {
          s._acc = (s._acc || 0) + dt;
          if (s._acc >= 0.35) {
            s._acc -= 0.35;
            applyDamage(this, {
              amount: s.power * 0.35, type: s.kind === 'burn' ? 'fire' : 'poison',
              source: s.extra?.source ?? { kind: 'status' }, position: this.position,
            }, game);
            if (this.dead) return;
          }
        }
        if (s.duration <= 0) { this.statuses.splice(i, 1); changed = true; }
      }
      if (changed) recomputeStatusMods(this);
    }

    const mods = this.statusMods;
    this.stateT += dt;
    if (this.attackCd > 0) this.attackCd -= dt;
    if (this.abilityCd > 0) this.abilityCd -= dt;
    if (this.revealT > 0 && (this.revealT -= dt) <= 0 && this.has('stealth')) {
      this.stealthed = true;
      this.rig?.setStealth?.(true);
    }

    // Hard crowd control comes first. A stunned or frozen orc does not finish the swing it
    // was winding up, does not get to run its archetype AI (the archer would still shoot,
    // the sapper would still chew, the leaper would still steer itself), and does not
    // start a new attack. It only drifts to a stop.
    if (mods.stunned || mods.rooted) {
      if (this.pendingHit >= 0) { this.pendingHit = -1; this.attackTarget = null; }
      if (this.slamT > 0) this.slamT = 0;   // a slam wind-up is interrupted, not paused
      if (this.state === 'attack') this.state = 'walk';
      this._threat(dt, game);
      this.velocity.multiplyScalar(Math.pow(0.001, dt));
      this._integrate(dt, game);
      this._render(dt, game);
      return;
    }

    // A landed blow resolves mid-animation, not on a timer: hitstop and slow-mo have to
    // stretch the wind-up too or the tell stops matching the hit.
    if (this.pendingHit >= 0) {
      this.pendingHit -= dt;
      if (this.pendingHit <= 0) { this.pendingHit = -1; this._resolveAttack(game); }
    }
    if (this.state === 'attack' && this.stateT > this.attackAnim) this.state = 'walk';
    if (this.state === 'stagger' && this.stateT > this.staggerDur) this.state = 'walk';

    // Decided before the archetype AI runs, so an ability can read `e.hunt` and behave
    // differently when it has committed to the hero — the Ogre slams at you, the
    // Gargoyle drops out of the roof, the Leaper pounces.
    this._threat(dt, game);

    // Custom AI gets first refusal; if it returns true it fully handled this frame.
    if (this.def.ai?.update?.(this, game, dt)) { this._render(dt, game); return; }

    this._steer(dt, game);
    this._integrate(dt, game);
    this._tryAttack(dt, game);
    this._render(dt, game);
  }

  /**
   * Does this orc come for the hero?
   *
   * The gap this closes is the one that made the whole trap layer optional: orcs steered
   * by the rift flow field and nothing else, so they walked *past* the player and only
   * swung if the player happened to be inside a two-and-a-half-metre reach as they went.
   * A reviewer finished seven of ten levels — including an eight-wave finale with 507
   * kills — at full health. If standing anywhere is free, there is no reason to build a
   * maze, and no decision to price with coin or score.
   *
   * The rule now, and the reason for each half of it:
   *
   *   - **A fraction of the horde diverts.** `aggroChance` is rolled per orc at spawn, so
   *     a wave splits into hunters and rift-runners. If *everything* turned the game
   *     would stop being a tower defence — you could pull the entire wave off the rift by
   *     standing in a corner — and if nothing did we are back where we started.
   *   - **Line of sight is required.** You cannot be aggroed through a wall or through
   *     your own barricade, which is what makes cover and the blocker mean something from
   *     the hero's side too. Inside three metres it is waived: at that range they can
   *     smell you.
   *   - **`MAX_HUNTERS` caps the pack.** See the note on the constant.
   *   - **It expires.** `huntTime` seconds of committed chase, refreshed while you are
   *     within six metres, but never more than `huntSpent` seconds in total per episode —
   *     after which the orc remembers the rift and walks off. Without that ceiling a
   *     hero who out-runs the horde forever also parks it forever, and the wave never
   *     resolves.
   */
  _threat(dt, game) {
    if (this.huntCd > 0) this.huntCd -= dt;
    const p = game.player;
    if (!p || p.dead) { this.hunt = 0; return; }

    const dx = p.position.x - this.position.x, dz = p.position.z - this.position.z;
    const d2 = dx * dx + dz * dz;

    if (this.hunt > 0) {
      this.hunt -= dt;
      this.huntSpent += dt;
      // Still on top of them: stay engaged rather than politely disengaging mid-swing.
      if (d2 < 36 && this.huntSpent < 14) this.hunt = Math.max(this.hunt, 1.2);
      if (d2 > this.leash * this.leash || this.huntSpent >= 14) { this.hunt = 0; this.huntCd = 4; }
      else if (this.hunt <= 0) { this.hunt = 0; this.huntCd = 2.2; }
      return;
    }

    this.threatT -= dt;
    if (this.threatT > 0) return;
    // De-phased so two hundred orcs never run their sight check on the same frame.
    this.threatT = 0.2 + ((this.__idx ?? 0) % 7) * 0.02;
    this.huntSpent = 0;
    if (this.huntCd > 0 || !this.aggressive) return;
    if (d2 > this.aggro * this.aggro) return;
    const boss = this.has('boss');
    if (!boss && game.enemies.hunters >= MAX_HUNTERS) return;
    // Bosses do not need to see you. Measured at 24 metres on The Gatehouse, both
    // Warlords failed their sight check on a corridor bend and spent the whole fight
    // walking at the rift instead — which is the one thing a boss must never do. They
    // path to you on the hero flow field, so a wall is a detour, not an excuse.
    if (d2 > 9 && !boss
        && !losClear(game.grid, this.position.x, this.position.z, p.position.x, p.position.z)) return;
    this.hunt = this.huntTime;
    if (!boss) game.enemies.hunters++;
  }

  _steer(dt, game) {
    const grid = game.grid;
    const hunting = this.hunt > 0 && game.player && !game.player.dead;
    const target = hunting ? game.player.position : game.level?.rift?.object.position;

    // A hunter walks the hero's own flow field — one field for every hunter on the map,
    // rebuilt only when the hero changes tile. That is what lets an orc come round a
    // corner after you instead of grinding its face into the wall between you.
    const flow = hunting && !this.airborne
      ? game.enemies.heroFlow()
      : (this.airborne ? grid.riftFlowAir() : grid.riftFlow());
    flow.sample(this.position.x, this.position.z, _dir);

    // Flyers ignore the grid entirely once they have line of sight to their target.
    // Inside six metres a hunter drops the field and goes straight at you too: the field
    // points at the centre of the tile you are standing in, and at knife range that is
    // the difference between a landed blow and a swing at the floor beside you.
    if (target) {
      const dx = target.x - this.position.x, dz = target.z - this.position.z;
      const d2 = dx * dx + dz * dz;
      if (this.airborne || (hunting && d2 < 36)) {
        const d = Math.sqrt(d2) || 1;
        _dir.x = dx / d; _dir.z = dz / d;
      }
    }

    grid.toCell(this.position, _cell);
    this.goalDist = flow.distAt(_cell.gx, _cell.gz);
    this.hunting = hunting;

    const speed = this.speedBase * (this.statusMods.speed ?? 1) * this.speedMul
      // Mid-swing an orc plants its feet. Nothing sells a telegraph like the charge stopping.
      * (this.state === 'attack' ? 0.12 : this.state === 'stagger' ? 0.35 : 1);
    const gx = _dir.x, gz = _dir.z;
    let dx = gx, dz = gz;

    // --- crowd -------------------------------------------------------------
    // Only overlapping neighbours matter, and only the first dozen of them: past that the
    // pushes cancel out anyway, and in a crush the loop would otherwise be the frame.
    let sx = 0, sz = 0, contacts = 0;
    const near = game.enemies.queryNear(this.position, this.radius + 0.95);
    for (let i = 0; i < near.length && contacts < 12; i++) {
      const o = near[i];
      if (o === this || o.dead) continue;
      if (o.airborne !== this.airborne) continue;
      const ox = this.position.x - o.position.x;
      const oz = this.position.z - o.position.z;
      const d2 = ox * ox + oz * oz;
      const want = this.radius + o.radius;
      if (d2 > want * want || d2 < 1e-5) continue;
      const d = Math.sqrt(d2);
      const push = (want - d) / want;
      contacts++;
      // Mass ratio: a kobold bounces off an ogre, an ogre barely notices the kobold.
      const w = (o.mass / (this.mass + o.mass)) * 2;

      const ahead = (-ox * gx - oz * gz) / d;   // +1 = directly in front of me
      // `goalDist` is only comparable between two orcs walking the *same* field, and a
      // hunter is walking the hero's. Mixing them would have half a jam shoving the
      // other half backwards on numbers that mean different things.
      if (ahead > 0.35 && o.hunting === hunting && o.goalDist <= this.goalDist) {
        // It is genuinely ahead of me in the queue. Do not swerve around it — lean on it.
        // Its own update consumes this as forward pressure, so the front rank of a jam is
        // pushed through the doorway by everything stacked behind it.
        o.pressX += gx * push * this.mass * 0.55;
        o.pressZ += gz * push * this.mass * 0.55;
        sx += (ox / d) * push * w * 0.35;
        sz += (oz / d) * push * w * 0.35;
      } else {
        sx += (ox / d) * push * w;
        sz += (oz / d) * push * w;
      }
    }

    // In a narrow gap, stop trying to walk side by side. Orcs queue; they do not swirl.
    const lateral = this._narrow(grid, gx, gz) ? 0.45 : 1.25;
    dx += sx * lateral; dz += sz * lateral;

    // Pressure from the rank behind, applied in world space and then spent.
    dx += this.pressX / Math.max(0.5, this.mass);
    dz += this.pressZ / Math.max(0.5, this.mass);
    this.pressX = 0; this.pressZ = 0;

    const len = Math.hypot(dx, dz) || 1;
    const tx = (dx / len) * speed, tz = (dz / len) * speed;

    // Accelerate toward the desired velocity — instant turns look robotic.
    const accel = this.def.accel ?? 22;
    this.velocity.x = damp(this.velocity.x, tx, Math.exp(-accel), dt);
    this.velocity.z = damp(this.velocity.z, tz, Math.exp(-accel), dt);

    // How much of the desired motion is actually happening? Sustained failure means
    // something is in the way, and that is when an orc stops shuffling and swings.
    const real = Math.hypot(this.velocity.x, this.velocity.z);
    this.blockedT = real < speed * 0.55 && speed > 0.5 ? this.blockedT + dt : 0;
  }

  /** True when the two cells either side of the travel direction are not walkable. */
  _narrow(grid, gx, gz) {
    const px = -gz, pz = gx;
    const c = this.position;
    const a = grid.isWalkable(Math.floor((c.x + px * 2.2) / 4), Math.floor((c.z + pz * 2.2) / 4));
    const b = grid.isWalkable(Math.floor((c.x - px * 2.2) / 4), Math.floor((c.z - pz * 2.2) / 4));
    return !(a && b);
  }

  _integrate(dt, game) {
    const grid = game.grid;

    // Horizontal knockback is folded into the same swept move as walking, so a trap
    // launch can never punt an orc through a wall and strand it in solid rock.
    let dx = this.velocity.x, dz = this.velocity.z;
    if (this.impulse.x !== 0 || this.impulse.z !== 0) {
      dx += this.impulse.x; dz += this.impulse.z;
      const decay = Math.pow(0.02, dt);
      this.impulse.x *= decay; this.impulse.z *= decay;
      if (Math.abs(this.impulse.x) < 0.05) this.impulse.x = 0;
      if (Math.abs(this.impulse.z) < 0.05) this.impulse.z = 0;
    }

    const nx = this.position.x + dx * dt;
    const nz = this.position.z + dz * dt;

    if (this.airborne) {
      this.position.x = nx; this.position.z = nz;
      this.position.y = damp(this.position.y, this.flyHeight + Math.sin(game.clock.elapsed * 3 + this.wobbleSeed) * 0.35, 0.02, dt);
    } else {
      // Airborne-from-knockback units clear low walls; grounded ones slide along them.
      const flying = this.position.y > 1.2;
      const pass = (x, z) => flying ? grid.isFlyable(Math.floor(x / 4), Math.floor(z / 4))
                                    : grid.isWalkable(Math.floor(x / 4), Math.floor(z / 4));
      if (pass(nx + Math.sign(dx) * this.radius, this.position.z)) this.position.x = nx;
      else { this.velocity.x *= -0.15; this.impulse.x *= -0.3; }
      if (pass(this.position.x, nz + Math.sign(dz) * this.radius)) this.position.z = nz;
      else { this.velocity.z *= -0.15; this.impulse.z *= -0.3; }

      if (this.position.y > 0.001 || this.impulse.y !== 0) {
        this.impulse.y -= 26 * dt;
        this.position.y += this.impulse.y * dt;
        if (this.position.y <= 0) {
          this.position.y = 0; this.impulse.y = 0; this.grounded = true;
          // Landed inside geometry after a long flight: shove back to open floor.
          if (!grid.isWalkable(Math.floor(this.position.x / 4), Math.floor(this.position.z / 4))) this._unstick(game);
        }
      }
      this._stuckCheck(dt, game);
    }

    // Rift contact = leak.
    const rift = game.grid.rifts[0];
    if (rift) {
      const rc = game.grid.toWorld(rift.gx, rift.gz, v0);
      // Measured in the ground plane: a 3D sphere at floor height excluded every flyer
      // cruising above 3 m, so Gargoyles hovered over the rift and could never leak.
      const dx = this.position.x - rc.x, dz = this.position.z - rc.z;
      if (dx * dx + dz * dz < 9) this._leak(game);
    }
  }

  /**
   * Safety net. Anything that leaves an orc unable to make progress — a bad flow-field
   * frame, a crowd crush in a doorway, an unreachable cell — would otherwise hang the
   * wave forever, because the director waits for the field to clear. So: if an orc is
   * standing on an unreachable cell, or has barely moved for three seconds, unstick it.
   */
  _stuckCheck(dt, game) {
    const gx = Math.floor(this.position.x / 4), gz = Math.floor(this.position.z / 4);
    if (!game.grid.isWalkable(gx, gz)) { this._unstick(game); return; }

    const moved = Math.hypot(this.position.x - (this._lastX ?? this.position.x),
                             this.position.z - (this._lastZ ?? this.position.z));
    this._stuckT = moved < 0.02 ? (this._stuckT || 0) + dt : 0;
    this._lastX = this.position.x; this._lastZ = this.position.z;

    // Longer fuse than before: a real pile-up at a doorway is *wanted* behaviour now, and
    // orcs in one are busy attacking whatever plugged it.
    if (this._stuckT > 4.5) {
      this._stuckT = 0;
      const d = game.grid.riftFlow().dirAt(gx, gz, { x: 0, z: 0 });
      this.position.x += d.x * 1.2; this.position.z += d.z * 1.2;
      if (game.grid.riftFlow().unreachable(gx, gz)) this._unstick(game);
    }
  }

  /** Teleport to the nearest walkable cell that can actually reach the rift. */
  _unstick(game) {
    const grid = game.grid;
    const gx = Math.floor(this.position.x / 4), gz = Math.floor(this.position.z / 4);
    const flow = grid.riftFlow();
    let best = null, bd = Infinity;
    for (let r = 1; r <= 4 && !best; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const x = gx + dx, z = gz + dz;
          if (!grid.isWalkable(x, z) || flow.unreachable(x, z)) continue;
          const d = dx * dx + dz * dz;
          if (d < bd) { bd = d; best = { x, z }; }
        }
      }
    }
    if (best) {
      grid.toWorld(best.x, best.z, v1);
      this.position.x = v1.x; this.position.z = v1.z; this.position.y = 0;
      this.impulse.set(0, 0, 0);
      this._stuckT = 0;
    } else {
      // Genuinely nowhere to go — better to remove it than hang the wave.
      this._leak(game);
    }
  }

  _leak(game) {
    if (this.dead) return;
    this.dead = true;
    game.bus.emit('enemy:leaked', { enemy: this, cost: this.damageToRift });
    game.fx.ring(this.position, 1.2, [1, 0.3, 0.15], 20);
    game.enemies.despawn(this, null, true);
  }

  // --- melee ---------------------------------------------------------------
  /**
   * Pick something to hit. The player always wins if they are in reach — but an orc that
   * has been stuck behind a guardian for half a second will turn on it, which is what
   * stops a blocked wave from jittering against a wall of paladins forever.
   */
  /**
   * How far this orc's *melee* swing reaches. Ranged archetypes carry their shooting range
   * in `attackRange`; reusing that for the generic swing gave archers an invisible 16 m
   * melee hit that ignored walls. They get a short knife-reach instead.
   */
  get meleeRange() {
    return this.def.meleeRange ?? (this.has('ranged') ? 1.4 : this.attackRange);
  }

  _pickTarget(game) {
    const p = game.player;
    const reach = this.meleeRange + this.radius + 0.5;
    if (p && !p.dead && this.position.distanceToSquared(p.position) < reach * reach) return p;
    // A guardian standing in the horde's path gets hit. Without this a wall of paladins is
    // a free win: the orcs would just jitter against it forever.
    const t = game.traps.list;
    const r2 = (reach + 1.4) * (reach + 1.4);
    for (let i = 0; i < t.length; i++) {
      const g = t[i];
      if (!g.def.guardian || g.destroyed) continue;
      if (g.world.distanceToSquared(this.position) < r2) return g;
    }
    return null;
  }

  _tryAttack(dt, game) {
    if (this.attackCd > 0 || this.state === 'stagger') return;
    const target = this._pickTarget(game);
    if (!target) return;
    this.attackCd = this.attackRate;
    this.state = 'attack';
    this.stateT = 0;
    this.attackTarget = target;
    // The hit lands 40% into the swing — after the wind-up, on the way through.
    this.pendingHit = this.attackAnim * 0.42;
    // An archetype's opening-strike bonus has to be locked in *before* the reveal below,
    // or it can never see the stealthed state it depends on.
    this.attackDamage = (this.def.ambushMult && this.stealthed)
      ? this._baseAttack * this.def.ambushMult
      : this._baseAttack;
    if (this.stealthed) this.reveal();
    // Square up to what we are about to hit; a swing at nothing reads as a bug.
    const tp = target.position || target.world;
    this.facing = Math.atan2(tp.x - this.position.x, tp.z - this.position.z);
    game.audio.play('orc.growl', { position: this.position, pitch: 1 / Math.max(0.6, this.def.scale ?? 1), gain: 0.5 });
  }

  _resolveAttack(game) {
    const t = this.attackTarget;
    this.attackTarget = null;
    if (!t || this.dead) return;
    const dmg = this.attackDamage * (this.statusMods.damageDealt ?? 1);
    const tp = t.position || t.world;
    const reach = this.meleeRange + this.radius + 1.1;
    if (tp.distanceToSquared(this.position) > reach * reach) return;   // it moved: whiff
    if (t.def?.guardian) {
      if (t.destroyed) return;   // another orc's blow already felled it
      game.traps.damageGuardian(t, dmg);
      game.fx.hit(tp, null, { count: 6, color: [1, 0.8, 0.5], speed: 5 });
      game.audio.play('hit.armor', { position: tp, pitch: 0.9 });
    } else if (t.takeDamage) {
      t.takeDamage(dmg, this);
    }
  }

  _render(dt, game) {
    this.object.position.copy(this.position);

    // Face movement direction, but snap toward the player when attacking.
    const moving = this.velocity.lengthSq() > 0.05;
    if (moving && this.state !== 'attack') {
      const want = Math.atan2(this.velocity.x, this.velocity.z);
      this.facing += angleDelta(this.facing, want) * Math.min(1, dt * 11);
    }
    this.object.rotation.y = this.facing;

    // Off-screen orcs skip the rig entirely. At 250 units that is most of the field, and
    // the animation work is invisible by definition.
    if (this.culled) { this.object.visible = false; return; }
    this.object.visible = true;

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    this.walkPhase += dt * (2.4 + speed * 1.5);
    this.rig?.setLod?.(this.lodFar);
    this.rig?.animate?.(this, dt, speed);

    if (this.rig?.setTint) {
      const since = game.clock.elapsed - (this.lastHitAt ?? -10);
      this.rig.setTint(since < 0.09 ? 1 : 0, this.lastHitType);
    }
  }
}
