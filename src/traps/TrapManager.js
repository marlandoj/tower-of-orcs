import * as THREE from 'three';
import { TRAPS, getTrapDef, aimVec, power } from './roster.js';
import { TILE, DIRS } from '../world/Grid.js';
import { buildGuardian } from './guardianModel.js';
import { BuildGhost, angleFor } from './ghost.js';
import { trapDamage, updateFlights, clearFlights, resetComboTeaching } from './combos.js';
import { levelPips, disposeTrap, ringMesh } from './parts.js';
import { status } from '../shared/Damage.js';
import { v0, v1 } from '../shared/scratch.js';

/**
 * Placement, arming, triggering, upgrading and teardown for every trap and guardian.
 *
 * Two ideas run through this file.
 *
 * 1. **Every trap is a little state machine**: ready -> wind -> fire -> cool. The manager
 *    owns it, so all sixteen traps get a wind-up tell, a decisive commit and a visible
 *    recharge for free, and a player can read the state of a whole killbox at a glance
 *    from the ring under each tile. Defs only supply damage.
 *
 * 2. **Build mode is the other half of the game** and has to feel as good as shooting:
 *    the ghost snaps to the tile, shows the tiles it will actually cover and which way it
 *    shoots, prices itself, says *why* a placement is illegal — and, critically, refuses
 *    any placement that would wall the rift off, because a maze-lock trivialises a tower
 *    defence.
 */

const STATE_COLOR = {
  ready:  0x40ff90,
  wait:   0xffc040,
  wind:   0xff8420,
  fire:   0xffffff,
  cool:   0xff4030,
  frozen: 0x60c0ff,
  idle:   0x60ffd0,
};

/** Structural HP. Guardians and barricades use their spec; everything else is equally sappable. */
function hpFor(def, tier) {
  const base = def.guardian ? def.guardian.hp : def.barricade ? def.barricade.hp : 240;
  const scale = def.barricade ? 0.65 : 0.4;
  return Math.round(base * (1 + tier * scale));
}

/**
 * How much faster than a grunt each kind of orc chews through a barricade.
 *
 * This is where two archetypes that already existed stop being flavour and become the
 * counter-play the blocking object needs. A Sapper's whole identity is "destroys the
 * defence rather than fighting it", and an Ogre's is "goes through, not around" — before
 * there was anything to *go through*, both were just orcs with a gimmick aimed at floor
 * traps. Against a barricade they are the answer, and they arrive in the waves that
 * matter (Sappers from level 5, Ogres from level 8).
 */
function siegeMult(e) {
  if (e.has('trap-disarm')) return 5;
  if (e.has('boss')) return 8;
  if (e.has('unstoppable')) return 6;
  return 1;
}

/** Crossing a barricade has to save at least this many tiles before a grunt bothers. */
const SIEGE_DETOUR = 4;

export class TrapManager {
  constructor(game) {
    this.game = game;
    this.list = [];
    this.root = new THREE.Group();
    this.root.name = 'traps';
    game.scene.add(this.root);

    this.buildMode = false;
    this.selectedId = null;
    this.ghostDir = 'S';
    this.ghostValid = false;
    this.available = [];   // trap ids unlocked for the current level

    this._cellOut = { gx: 0, gz: 0 };
    this.ghost = new BuildGhost(game, this.root);
    this.ghost.setVisible(false);
    this._camQ = new THREE.Quaternion();

    game.bus.on('level:load', ({ level }) => this._onLevelLoad(level));
  }

  _onLevelLoad() {
    // Everything unlocked up to and including this level stays available.
    const idx = this.game.levelIndex;
    const set = new Set();
    for (const t of TRAPS) if ((t.unlockLevel ?? 1) <= idx + 1) set.add(t.id);
    this.available = TRAPS.filter((t) => set.has(t.id)).map((t) => t.id);
    this.selectedId = this.available[0] ?? null;
    resetComboTeaching();
  }

  // --- build mode ----------------------------------------------------------
  toggleBuild(force) {
    this.buildMode = force !== undefined ? force : !this.buildMode;
    this.ghost.setVisible(this.buildMode);
    this.game.bus.emit('build:mode', { on: this.buildMode, selected: this.selectedId });
    this.game.audio.play('ui.click', { pitch: this.buildMode ? 1.2 : 0.8 });
  }

  select(id) {
    if (!this.available.includes(id)) return false;
    this.selectedId = id;
    this.ghost.setModel(getTrapDef(id), (d) => this._buildBody(d));
    if (!this.buildMode) this.toggleBuild(true);
    this.game.bus.emit('build:select', { id });
    this.game.audio.play('ui.click');
    return true;
  }

  _buildBody(def) {
    return def.surface === 'guardian' ? buildGuardian(def.guardian) : def.build({ game: this.game });
  }

  // --- per-frame -----------------------------------------------------------
  update(dt) {
    const g = this.game;
    if (g.state === 'paused' || g.state === 'menu') return;

    updateFlights(g, dt);
    g.camera.getWorldQuaternion(this._camQ);

    for (let i = this.list.length - 1; i >= 0; i--) {
      const t = this.list[i];
      if (t.destroyed) continue;
      this._stepTrap(t, dt);
    }

    if (this.buildMode) this._updateGhost(dt);
  }

  _stepTrap(t, dt) {
    const g = this.game;
    const def = t.def;
    t._t += dt;

    // A frozen trap is inert and says so — that is the whole point of the Frost Warlord.
    if (t.frozen > 0) {
      t.frozen -= dt;
      this._setRing(t, 'frozen', 1);
      t.rig?.tick?.(dt, t, g);
      return;
    }

    if (t.cooldownLeft > 0) t.cooldownLeft = Math.max(0, t.cooldownLeft - dt);

    t.rig?.tick?.(dt, t, g);
    def.onTick?.(t, g, dt);

    if (def.guardian) { this._updateGuardian(t, dt); return; }
    if (def.blocker) { this._updateBarricade(t, dt); return; }
    if (def.passive) { this._setRing(t, 'idle', 1); return; }

    switch (t.phase) {
      case 'fire': {
        t.fireT -= dt;
        this._setRing(t, 'fire', 1);
        if (t.fireT <= 0) t.phase = t.cooldownLeft > 0 ? 'cool' : 'ready';
        break;
      }
      case 'cool': {
        const f = 1 - t.cooldownLeft / Math.max(0.001, this.cooldownOf(t));
        t.rig?.charge?.(f, t);
        this._setRing(t, 'cool', f);
        if (t.cooldownLeft <= 0) {
          t.phase = 'ready';
          g.audio.play('trap.arm', { position: t.world, gain: 0.3 });
        }
        break;
      }
      case 'wind': {
        t.windT += dt;
        const p = def.windup ? Math.min(1, t.windT / def.windup) : 1;
        t.rig?.wind?.(p, t);
        this._setRing(t, 'wind', p);
        if (p >= 1) this._fire(t);
        break;
      }
      default: {   // 'ready'
        const count = this._sense(t);
        const grp = def.group;
        if (count <= 0) {
          t._wait = 0;
          t.rig?.charge?.(1, t);
          this._setRing(t, 'ready', 1);
        } else if (grp && count < grp.want && t._wait < grp.patience) {
          // Hold for a better group. A trap that waits reads as a trap with an opinion.
          t._wait += dt;
          this._setRing(t, 'wait', t._wait / grp.patience);
        } else {
          t._wait = 0;
          t.windT = 0;
          t.phase = 'wind';
          if (def.windup) g.audio.play('trap.arm', { position: t.world, gain: 0.5, pitch: 1.4 });
        }
      }
    }
  }

  /** Effective cooldown — upgrades shorten it a little as well as hitting harder. */
  cooldownOf(t) { return t.def.cooldown * (1 - (t.level - 1) * 0.09); }

  _fire(t) {
    const g = this.game;
    t.phase = 'fire';
    t.fireT = t.def.fireTime ?? 0.18;
    t.cooldownLeft = this.cooldownOf(t);
    t.rig?.fire?.(t, g);
    const victims = t.def.onTrigger?.(t, g) || [];
    // One `trap:triggered` per actual firing — including a shot into empty air, which is
    // what FX hangs each trap's signature on. Traps whose payload lands later (the
    // Ceiling Pounder's drop) opt out and emit it themselves at the moment of impact.
    if (!t.def.deferTrigger) g.bus.emit('trap:triggered', { trap: t, victims });
  }

  /**
   * "Is something in my kill zone?" — a pressure plate, not a proximity blob.
   * `plate` traps need a body on the tile itself; lane traps look down their lane.
   */
  _sense(t) {
    const def = t.def;
    const s = def.sense || { kind: 'tile', radius: TILE * 0.55 };
    const air = !!s.air || (def.tags || []).includes('anti-air');
    let count = 0;

    if (s.kind === 'lane') {
      const dv = aimVec(t);
      const from = s.from ?? 0;
      for (let step = from; step <= (s.length ?? 1); step++) {
        v1.set(t.world.x + dv.x * step * TILE, 1.0, t.world.z + dv.z * step * TILE);
        for (const e of this.game.enemies.queryNear(v1, s.radius ?? TILE * 0.7)) {
          if (e.dead || (e.airborne && !air)) continue;
          count++;
        }
      }
      return count;
    }

    let onPlate = !s.plate;
    const plateR2 = (TILE * 0.46) * (TILE * 0.46);
    for (const e of this.game.enemies.queryNear(t.world, s.radius)) {
      if (e.dead || (e.airborne && !air)) continue;
      count++;
      if (!onPlate) {
        const dx = e.position.x - t.world.x, dz = e.position.z - t.world.z;
        if (dx * dx + dz * dz <= plateR2) onPlate = true;
      }
    }
    return onPlate ? count : 0;
  }

  /** The one indicator that makes a killbox readable: a state ring under every trap. */
  _setRing(t, state, p) {
    const r = t.ring;
    if (!r) return;
    const m = r.material;
    m.color.setHex(STATE_COLOR[state] ?? 0xffffff);
    switch (state) {
      case 'ready': {
        const b = 0.17 + Math.sin(t._t * 2.2) * 0.04;
        m.opacity = b; r.scale.setScalar(1);
        break;
      }
      case 'wait': m.opacity = 0.3 + Math.abs(Math.sin(t._t * 11)) * 0.45; r.scale.setScalar(1.02); break;
      case 'wind': m.opacity = 0.55 + p * 0.4; r.scale.setScalar(1 + p * 0.22); break;
      case 'fire': m.opacity = 0.95; r.scale.setScalar(1.3); break;
      case 'cool': m.opacity = 0.14 + p * 0.14; r.scale.setScalar(0.5 + p * 0.5); break;
      case 'frozen': m.opacity = 0.4 + Math.sin(t._t * 5) * 0.1; r.scale.setScalar(1); break;
      default: m.opacity = 0.12 + Math.sin(t._t * 1.4) * 0.04; r.scale.setScalar(1);
    }
  }

  // --- placement -----------------------------------------------------------
  /** @returns {{ok:boolean, reason?:string, dir?:string}} */
  canPlace(def, gx, gz, dir) {
    const g = this.game;
    if (g.state !== 'build' && g.state !== 'wave') return { ok: false, reason: 'Not now' };
    const c = g.grid.cell(gx, gz);
    if (!c) return { ok: false, reason: 'Out of bounds' };
    const s = g.grid.surfaces(gx, gz);
    const poor = !g.scoring.canAfford(def.cost);

    // A barricade is checked first because it is the only object that answers "occupied"
    // for a tile the grid now calls a wall — its own doing.
    if (def.blocker) {
      if (c.blocker) return { ok: false, reason: 'Barricade here', occupied: true };
      if (c.floorTrap) return { ok: false, reason: 'Tile occupied', occupied: true };
      if (c.flags.has('no-build')) return { ok: false, reason: 'No building here' };
      if (!s.floor) return { ok: false, reason: c.kind === 'wall' ? 'That is a wall' : 'Needs open floor' };
      const cap = def.cap ?? 12;
      if (this._blockerCount() >= cap) return { ok: false, reason: `Barricade limit (${cap}) reached` };
      // You cannot brick yourself into the geometry. Everything else about a barricade is
      // recoverable by selling it; being inside one is not.
      if (this._playerOn(gx, gz)) return { ok: false, reason: 'You are standing there' };
      // The load-bearing rule of the whole object.
      if (this._wouldSeal(gx, gz)) return { ok: false, reason: 'Would wall the rift off' };
      if (poor) return { ok: false, reason: 'Not enough coin' };
      return { ok: true, dir };
    }

    if (def.surface === 'floor') {
      if (c.floorTrap) return { ok: false, reason: 'Tile occupied', occupied: true };
      if (c.flags.has('no-build')) return { ok: false, reason: 'No building here' };
      if (!s.floor) return { ok: false, reason: c.kind === 'wall' ? 'That is a wall' : 'Needs open floor' };
    } else if (def.surface === 'ceiling') {
      if (c.ceilTrap) return { ok: false, reason: 'Ceiling occupied', occupied: true };
      if (c.flags.has('no-build')) return { ok: false, reason: 'No building here' };
      if (!s.ceiling) return { ok: false, reason: 'Nothing to hang it from' };
    } else if (def.surface === 'wall') {
      const mounted = DIRS.filter((d) => c.wallTraps[d]);
      if (s.wall.length === 0) {
        return mounted.length
          ? { ok: false, reason: 'Wall mount occupied', occupied: true }
          : { ok: false, reason: 'Needs an adjacent wall' };
      }
      // Snap to whichever wall the player is pointing at, or the first available.
      const dirOk = s.wall.includes(dir) ? dir : s.wall[0];
      if (poor) return { ok: false, reason: 'Not enough coin', dir: dirOk };
      return { ok: true, dir: dirOk };
    } else if (def.surface === 'guardian') {
      if (c.floorTrap) return { ok: false, reason: 'Tile occupied', occupied: true };
      if (!s.floor) return { ok: false, reason: 'Needs open floor' };
      // Read the cap off the def rather than hard-coding it, so the HUD can show "N/cap"
      // from the same source instead of special-casing guardians.
      const gCap = def.cap ?? 6;
      if (this._guardianCount() >= gCap) return { ok: false, reason: `Guardian limit (${gCap}) reached` };
      // A guardian stands in the lane, so it is the one placement that can seal the rift.
      if (this._wouldSeal(gx, gz)) return { ok: false, reason: 'Would block the only path' };
    }

    if (poor) return { ok: false, reason: 'Not enough coin', dir };
    return { ok: true, dir };
  }

  _guardianCount() { return this.list.filter((t) => t.def.guardian && !t.destroyed).length; }
  _blockerCount() { return this.list.filter((t) => t.def.blocker && !t.destroyed).length; }

  /** The player is a physical body too; a barricade dropped on their tile would trap them. */
  _playerOn(gx, gz) {
    const p = this.game.player;
    if (!p || p.dead) return false;
    const c = this.game.grid.toWorld(gx, gz, v1);
    const dx = p.position.x - c.x, dz = p.position.z - c.z;
    return Math.abs(dx) < TILE * 0.5 + 0.7 && Math.abs(dz) < TILE * 0.5 + 0.7;
  }

  /**
   * Temporarily mark the cell impassable and confirm every spawn still reaches the rift.
   *
   * With barricades this stopped being a formality and became the rule the whole object
   * hangs off, so it also stopped being free: the build ghost asks it every frame the
   * cursor sits on a legal tile, and answering costs three flow-field rebuilds. The memo
   * is keyed on the cell *and* on the identity of the current rift field, which
   * `markDirty()` replaces — so any real change to the board (a barricade placed, sold or
   * broken) invalidates it automatically and nothing else has to remember to.
   */
  _wouldSeal(gx, gz) {
    const grid = this.game.grid;
    const c = grid.cell(gx, gz);
    if (!c) return true;
    const key = gx + ',' + gz;
    const memo = this._sealMemo;
    if (memo && memo.key === key && memo.stamp === grid.riftFlow()) return memo.res;

    const prev = c.kind;
    c.kind = 'wall';
    grid.markDirty();
    const flow = grid.riftFlow();
    let sealed = false;
    for (const s of grid.spawns) {
      if (flow.unreachable(s.gx, s.gz)) { sealed = true; break; }
    }
    c.kind = prev;
    grid.markDirty();
    this._sealMemo = { key, stamp: grid.riftFlow(), res: sealed };
    return sealed;
  }

  place(def, gx, gz, dir = 'S') {
    const g = this.game;
    if (!g.scoring.spend(def.cost)) return null;
    const grid = g.grid;
    const c = grid.cell(gx, gz);

    const obj = this._buildBody(def);
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    grid.toWorld(gx, gz, v0);
    obj.position.set(v0.x, 0, v0.z);
    if (def.surface === 'wall' || def.surface === 'floor') obj.rotation.y = angleFor(def, dir);
    this.root.add(obj);

    // Spellbook tiers bought between levels are the trap's *starting* level; in-level
    // upgrades continue from there and still cap at 3. A player who has invested in
    // Spike Floors places them already barbed.
    const tier = Math.max(0, Math.min(2, g.save?.data?.spellbook?.[def.id] ?? 0));

    const trap = {
      def, gx, gz, dir, level: 1 + tier, object: obj, rig: obj.userData.rig || null,
      world: new THREE.Vector3(v0.x, 0, v0.z),
      cooldownLeft: 0, kills: 0, enabled: true, destroyed: false,
      hp: hpFor(def, tier), hpMax: hpFor(def, tier),
      frozen: 0, anim: 0, spent: def.cost,
      phase: def.passive ? 'idle' : 'ready', windT: 0, fireT: 0, _wait: 0, _t: Math.random() * 3,
    };

    // Cooldown ring under every trap — including wall and ceiling traps, because the
    // floor is the surface the top-down camera reads best.
    if (!def.guardian && !def.blocker) {
      // Sits just inside the kerb and above it, so the state colour is never clipped by
      // the trap's own frame when you look straight down at a corridor full of them.
      const ring = ringMesh(TILE * 0.36, TILE * 0.41, 0x40ff90, 0.3);
      ring.position.y = 0.22;
      obj.add(ring);
      trap.ring = ring;
    }
    const pips = levelPips(0, def.surface === 'ceiling' ? TILE * 0.3 : -TILE * 0.4);
    obj.add(pips);
    trap.pips = pips;

    if (def.blocker) {
      // The one placement that edits the map. `kind` is what every pathing, collision and
      // buildability query in the game reads, so flipping it is what makes the horde —
      // and the player — treat this tile as solid rock. The previous kind is remembered on
      // the trap itself so selling or losing it puts the level back exactly as it was.
      c.blocker = trap;
      trap.prevKind = c.kind;
      c.kind = 'wall';
      grid.markDirty();
    } else if (def.surface === 'floor') c.floorTrap = trap;
    else if (def.surface === 'ceiling') c.ceilTrap = trap;
    else if (def.surface === 'wall') c.wallTraps[dir] = trap;
    else if (def.surface === 'guardian') {
      c.floorTrap = trap;
      trap.gs = { cd: 0, repos: 0, hurtAcc: 0, blocking: false };
      // A blocker makes its tile expensive to path through, so the horde tries to go
      // around before it tries to go through him. It never becomes impassable, so the
      // seal check keeps its meaning.
      if (def.guardian.blocker) { c.cost = 6; grid.markDirty(); }
    }

    this.list.push(trap);
    trap.rig?.setLevel?.(trap.level);
    trap.pips.userData.set(trap.level);
    def.onArm?.(trap, g);
    g.audio.play('trap.place', { position: trap.world });
    g.fx.dust(trap.world, 1.2, 12);
    g.bus.emit('trap:placed', { trap });
    return trap;
  }

  // --- upgrades ------------------------------------------------------------
  /** Level 1 -> 3. Each level costs coin, changes the model, and really does more. */
  upgrade(trap) {
    const g = this.game;
    if (!trap || trap.destroyed) return { ok: false, reason: 'Gone' };
    const costs = trap.def.upgrade?.costs;
    if (!costs) return { ok: false, reason: 'Cannot be upgraded' };
    if (trap.level >= 3) return { ok: false, reason: 'Already level 3' };
    const cost = costs[trap.level - 1];
    if (!g.scoring.canAfford(cost)) return { ok: false, reason: 'Not enough coin' };
    g.scoring.spend(cost);

    trap.level++;
    trap.spent += cost;
    trap.hpMax = Math.round(trap.hpMax * 1.35);
    trap.hp = trap.hpMax;
    trap.rig?.setLevel?.(trap.level);
    trap.pips?.userData.set(trap.level);
    if (trap.def.guardian) {
      const spec = trap.def.guardian;
      trap.hpMax = Math.round(spec.hp * (1 + (trap.level - 1) * 0.5));
      trap.hp = trap.hpMax;
    }
    if (trap.def.blocker) {
      // Upgrading a barricade is a *repair* as well as a buff — which is the decision the
      // player should be making mid-wave when one of them is at a third health.
      trap.hpMax = Math.round(trap.def.barricade.hp * (1 + (trap.level - 1) * 0.65));
      trap.hp = trap.hpMax;
    }
    // Tar's pathing cost and other onArm side effects have to be re-applied at the new level.
    trap.def.onArm?.(trap, g);

    g.fx.ring(trap.world, 1.6, [1, 0.85, 0.3], 26);
    g.fx.dust(trap.world, 1.2, 10, [1, 0.85, 0.4]);
    g.audio.play('trap.place', { position: trap.world, pitch: 1.35 });
    g.ui.toast(`${trap.def.name} → Level ${trap.level}: ${trap.def.upgrade.notes[trap.level - 2]}`, 'info');
    g.bus.emit('trap:upgraded', { trap, level: trap.level, cost });
    return { ok: true, level: trap.level };
  }

  upgradeAt(gx, gz) {
    const t = this._trapAt(gx, gz);
    return t ? this.upgrade(t) : { ok: false, reason: 'Nothing there' };
  }

  // --- selling / destruction -----------------------------------------------
  sell(trap) {
    if (!trap || trap.destroyed) return;
    const refund = Math.round((trap.spent ?? trap.def.cost) * 0.7);
    this.game.scoring.addCoin(refund, 'sell');
    this.game.bus.emit('trap:sold', { trap, refund });
    this.game.ui.toast(`Sold ${trap.def.name} (+${refund})`, 'info');
    this.game.fx.dust(trap.world, 1.2, 10);
    this._remove(trap);
  }

  /**
   * Structural damage from the horde. Traps have had `hp` since day one and the Sapper
   * has always respected it; the Ogre's ground slam did not — it called `destroy()`
   * directly on every floor trap in a 3×3, instantly and free, every six seconds.
   *
   * Measured consequence: an Ogre took **exactly zero** damage from *any* all-floor build.
   * Spike Floor, Brimstone, Grinder, Tar Pit, Arcane Obelisk — 4,400 coin of traps, 0
   * damage dealt, because the traps were deleted before they could fire. That left
   * Ceiling Pounder as the only answer to the game's signature heavy, and one answer is
   * not a choice.
   *
   * So a wreck is now a damage roll against the trap's own durability, which means the
   * upgrade track finally buys survivability as well as damage: a level 1 trap (240 hp)
   * still evaporates under one slam — the Ogre keeps its identity — while a level 2 (324)
   * or level 3 (437) one walks away from it. "Build deep" becomes "build deep *or* build
   * tough", and that is a decision rather than a tax. `upgrade()` refills hp, so repairing
   * a chewed row between waves is the same button as improving it.
   */
  wreck(trap, amount, source = null) {
    if (!trap || trap.destroyed) return false;
    trap.hp -= amount;
    if (trap.hp > 0) {
      trap.rig?.hurt?.();
      this.game.fx.dust(trap.world, 1.0, 8, [0.55, 0.5, 0.45]);
      this.game.audio.play('hit.armor', { position: trap.world, pitch: 0.65 });
      this.game.bus.emit('trap:damaged', { trap, amount, source, remaining: trap.hp });
      return false;
    }
    this.destroy(trap);
    return true;
  }

  /** How much structural damage an unqualified `destroy()` from the horde represents. */
  static WRECK = 300;

  destroy(trap, silent = false) {
    if (!trap || trap.destroyed) return;
    // A caller outside this module asking for a trap to be "destroyed" is describing an
    // orc hitting it, not a fact. Route it through durability unless the trap is already
    // finished (the Sapper zeroes hp first) or this is the trap ending itself — a spent
    // Boom Barrel, which passes `silent`.
    if (!silent && trap.hp > 0 && !trap.def.guardian && !trap.def.blocker) {
      // `wreck` calls back into here once the hp actually runs out, so there is nothing
      // left to do on this pass either way.
      this.wreck(trap, TrapManager.WRECK, { kind: 'horde' });
      return;
    }
    // A barricade that runs out of hp must *collapse* — the crush AoE and stun on whoever
    // broke it are the whole payoff for spending 700 coin on a wall. Falling through to
    // the plain removal branch silently deleted that: an ogre could smash one and walk
    // away untouched. `wreck()` -> `destroy()` is the sanctioned damage path, so it is
    // exactly the route that must not lose it.
    if (!silent && trap.def.blocker) { this._barricadeCollapse(trap); return; }

    if (!silent) {
      this.game.fx.dust(trap.world, 1.8, 20, [0.5, 0.45, 0.4]);
      this.game.audio.play('gib', { position: trap.world, pitch: 0.7 });
      this.game.ui.toast(`${trap.def.name} destroyed!`, 'error');
      this.game.bus.emit('trap:destroyed', { trap });
    }
    this._remove(trap);
  }

  _remove(trap) {
    trap.destroyed = true;
    trap.def.onRemove?.(trap, this.game);
    const c = this.game.grid.cell(trap.gx, trap.gz);
    if (c) {
      if (c.floorTrap === trap) c.floorTrap = null;
      if (c.ceilTrap === trap) c.ceilTrap = null;
      for (const d of DIRS) if (c.wallTraps[d] === trap) c.wallTraps[d] = null;
      if (c.blocker === trap) {
        c.blocker = null;
        c.kind = trap.prevKind ?? 'floor';
        this.game.grid.markDirty();
      }
      if (trap.def.guardian?.blocker) { c.cost = 1; this.game.grid.markDirty(); }
    }
    this.root.remove(trap.object);
    disposeTrap(trap.object);
    const i = this.list.indexOf(trap);
    if (i >= 0) this.list.splice(i, 1);
  }

  // --- barricades ----------------------------------------------------------
  /**
   * A barricade has no state machine and nothing to trigger. All it does is stand there,
   * take a beating, and eventually fall on somebody.
   */
  _updateBarricade(t, dt) {
    t._sieged = Math.max(0, (t._sieged || 0) - dt);
    // Siege is evaluated a few times a second rather than every frame: it walks the
    // neighbourhood of every barricade, and twelve of those on a 250-orc frame is not
    // something to do sixty times a second for no extra fidelity.
    t._siegeAcc = (t._siegeAcc || 0) + dt;
    if (t._siegeAcc >= 0.2) {
      this._barricadeIncoming(t, t._siegeAcc);
      t._siegeAcc = 0;
    }
    if (t.hp <= 0) { this._barricadeCollapse(t); return; }

    const b = t.object.userData.bar;
    if (b) b.quaternion.copy(this._camQ);
  }

  /**
   * How much of an obstruction this barricade actually is, in tiles.
   *
   * The point of the number: a barricade dropped in the middle of a wide-open hall is
   * decoration — the horde walks round it without breaking stride and should not waste
   * its time hitting it. A barricade plugging a doorway is the *only* thing between the
   * horde and a short route, and they should tear it down. The gap between the cheapest
   * and dearest walkable neighbour is exactly that: how many tiles of detour the wall is
   * costing them. Cached against the identity of the rift flow field, which `markDirty()`
   * replaces whenever the board actually changes.
   */
  _barricadeDetour(t) {
    const flow = this.game.grid.riftFlow();
    if (t._detourStamp === flow) return t._detour;
    let lo = Infinity, hi = -Infinity;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const d = flow.distAt(t.gx + dx, t.gz + dz);
      if (!isFinite(d)) continue;
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    t._detourStamp = flow;
    t._detourLo = isFinite(lo) ? lo : 0;
    t._detour = isFinite(lo) && isFinite(hi) ? hi - lo : 0;
    return t._detour;
  }

  /**
   * Who is hitting this wall, and how hard.
   *
   * Modelled here rather than in the orcs' targeting for the same reason guardian damage
   * is: enemies steer by a flow field and swing at whatever is in front of them, and
   * teaching every archetype to path *to* a barricade would be a second, worse pathfinder.
   * What matters for feel is that the right orcs break it at the right speed:
   *
   *   - a grunt only bothers when the wall is genuinely costing the horde a detour, and
   *     only from the far side of it — nobody doubles back to punch a wall they passed;
   *   - a Sapper and an Ogre always bother. They are the counters, and a counter that
   *     only works on some walls is not one.
   */
  _barricadeIncoming(t, dt) {
    const g = this.game;
    const grid = g.grid;
    const constrained = this._barricadeDetour(t) >= SIEGE_DETOUR;
    const lo = t._detourLo;
    const flow = grid.riftFlow();
    const reflect = t.level >= 3 ? 34 : t.level >= 2 ? 18 : 0;
    const src = { kind: 'trap', id: t.def.id, trap: t };
    let dps = 0;

    for (const e of g.enemies.queryNear(t.world, TILE * 0.5 + 1.9)) {
      if (e.dead || e.airborne) continue;
      const mult = siegeMult(e);
      if (mult === 1 && !constrained) continue;
      // Already past it: the wall is behind them and no longer their problem.
      const d = flow.distAt(Math.floor(e.position.x / TILE), Math.floor(e.position.z / TILE));
      if (isFinite(d) && d < lo - 0.5) continue;

      dps += (e.attackDamage ?? 10) / Math.max(0.4, e.attackRate ?? 1.2) * mult;
      // Make it *read*: they stop and swing at the thing in their way.
      if (e.state === 'walk') {
        e.state = 'attack'; e.stateT = 0;
        e.facing = Math.atan2(t.world.x - e.position.x, t.world.z - e.position.z);
      }
      // Spiked and iron-shod barricades bleed whoever is hacking at them. Small, but it
      // is the difference between spending 700 coin on a speed bump and on a defence.
      if (reflect) {
        trapDamage(g, t, e, {
          amount: reflect * dt, type: 'physical', source: src, position: t.world,
        });
      }
    }

    if (dps <= 0) return;
    t.hp -= dps * dt;
    t._sieged = 0.5;
    t._hurtAcc = (t._hurtAcc || 0) + dps * dt;
    if (t._hurtAcc > t.hpMax * 0.06) {
      t._hurtAcc = 0;
      g.fx.dust(v0.set(t.world.x, 1.4, t.world.z), 1.1, 6, [0.55, 0.5, 0.44]);
      g.audio.play('hit.armor', { position: t.world, pitch: 0.6, gain: 0.5 });
    }
  }

  /**
   * It does not just disappear. Three tonnes of block and timber come down on whatever
   * was standing next to it, and the thing most likely to be standing next to it is the
   * Ogre that broke it. Crush, which is the one damage type an Ogre is *vulnerable* to,
   * and a stun the unstoppable shrug off — so it hurts them without trivialising them.
   */
  _barricadeCollapse(t) {
    const g = this.game;
    const spec = t.def.barricade;
    const amount = spec.collapse * (1 + (t.level - 1) * 1.0);
    // Wide enough to actually reach whatever was hitting it. The first version used
    // 0.85 tiles and measured *zero* damage against six Ogres that demolished it: an orc
    // stands in the neighbouring tile, four units from this tile's centre, and a rubble
    // radius smaller than one tile can never touch the thing that caused the rubble.
    const radius = TILE * (1.2 + (t.level - 1) * 0.2);
    const src = { kind: 'trap', id: t.def.id, trap: t };

    for (const e of g.enemies.queryRadius(t.world, radius)) {
      if (e.dead || e.airborne) continue;
      const dx = e.position.x - t.world.x, dz = e.position.z - t.world.z;
      const dealt = trapDamage(g, t, e, {
        amount, type: 'crush', source: src, position: t.world,
        knockback: { x: dx * 2.2, y: 2.5, z: dz * 2.2 },
        statuses: [status('stun', 1.1, 1)],
      });
      g.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : 'crush');
    }
    g.fx.dust(t.world, 2.4, 30, [0.5, 0.46, 0.4]);
    g.fx.ring(t.world, 2.0, [0.85, 0.7, 0.45], 26);
    g.fx.shake(0.5, 0.28);
    g.engine.hitstop(0.04);
    g.audio.play('trap.boom', { position: t.world, pitch: 0.5 });
    g.ui.toast(`${t.def.name} broken!`, 'error');
    g.bus.emit('trap:destroyed', { trap: t });
    this._remove(t);
  }

  // --- guardians -----------------------------------------------------------
  _updateGuardian(t, dt) {
    const g = this.game;
    const spec = t.def.guardian;
    const st = t.gs;
    // Clamped: a guardian that idles for a minute should get one shot off when a target
    // appears, not a minute's worth of banked cooldown.
    st.cd = Math.max(-0.2, st.cd - dt);
    st.repos -= dt;

    // Guardians are units, not furniture: the horde fights back.
    this._guardianIncoming(t, dt);
    if (t.hp <= 0) { this._guardianDeath(t); return; }

    // Blockers physically hold their tile. Everything else keeps its distance.
    st.blocking = spec.blocker ? this._block(t, spec) : false;

    const range = spec.range * (1 + (t.level - 1) * 0.15);
    const target = g.enemies.nearest(t.world, range, (e) => {
      if (!spec.hitsAir && e.airborne) return false;
      // Stealth units are invisible to hired help until they are close enough to swing.
      if (e.has('stealth') && e.position.distanceToSquared(t.world) > 25) return false;
      return true;
    });

    if (target) {
      const a = Math.atan2(target.position.x - t.world.x, target.position.z - t.world.z);
      t.object.rotation.y += ((a - t.object.rotation.y + Math.PI * 3) % (Math.PI * 2) - Math.PI) * Math.min(1, dt * 9);
      if (st.cd <= 0) {
        st.cd = t.def.cooldown * (1 - (t.level - 1) * 0.12);
        t.rig?.attack?.();
        this._guardianAttack(t, spec, target, a);
      }
    } else if (spec.retreat && st.repos <= 0) {
      st.repos = 1.2;
    }

    // Archers and hunters give ground rather than die — they are worth more alive.
    if (spec.retreat && st.repos <= 0) {
      const threat = g.enemies.nearest(t.world, spec.retreat, (e) => !e.airborne);
      if (threat) this._reposition(t, threat);
    }
    // Smoothly walk toward the tile the unit belongs to (repositioning, mostly).
    t.object.position.x += (t.world.x - t.object.position.x) * Math.min(1, dt * 4);
    t.object.position.z += (t.world.z - t.object.position.z) * Math.min(1, dt * 4);

    t.rig?.tick?.(dt, { hasTarget: !!target, hpFrac: t.hp / t.hpMax, blocking: st.blocking });
    // Billboard the health bar. The guardian turns to face its target, so the bar has to
    // undo its parent's rotation before taking the camera's.
    const bar = t.object.userData.bar;
    if (bar) bar.quaternion.copy(t.object.quaternion).invert().multiply(this._camQ);
  }

  _guardianAttack(t, spec, target, angle) {
    const g = this.game;
    const dmg = spec.damage * power(t);
    const src = { kind: 'trap', id: t.def.id, trap: t };

    if (spec.kind === 'paladin') {
      // A hammer swing catches the whole front rank, not one orc.
      g.audio.play('hit.armor', { position: t.world, pitch: 0.75 });
      g.fx.hit(target.position, null, { count: 12, color: [1, 0.9, 0.7] });
      g.fx.shake(0.12, 0.12);
      let hit = 0;
      for (const e of g.enemies.queryRadius(t.world, spec.range)) {
        if (e.airborne) continue;
        const dealt = trapDamage(g, t, e, {
          amount: dmg * (hit === 0 ? 1 : 0.6), type: 'crush', source: src, position: t.world,
          knockback: { x: Math.sin(angle) * 12, y: 1.5, z: Math.cos(angle) * 12 },
          // Consecration: level 3 sets the ground it holds alight.
          statuses: t.level >= 3 ? [status('burn', 2.5, 12)] : null,
        });
        g.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : 'crush');
        if (++hit >= 4) break;
      }
      t.kills += 0;
      return;
    }

    // Ranged guardians: a visible tracer, then the hit.
    g.fx.lightning(
      v0.set(t.world.x, 1.7, t.world.z),
      v1.copy(target.position).setY(target.position.y + 1.0),
      spec.kind === 'hunter' ? [0.6, 1, 0.3] : [1, 0.92, 0.7],
    );
    g.audio.play('bow.shot', { position: t.world, pitch: spec.kind === 'hunter' ? 0.75 : 0.95 });

    const pierce = spec.pierce ? spec.pierce + (t.level - 1) : 1;
    const targets = pierce > 1 ? g.enemies.queryRadius(target.position, 3.2).slice(0, pierce) : [target];
    for (const e of targets) {
      const statuses = [];
      if (spec.kind === 'hunter') {
        statuses.push(status('poison', 4, 10));
        // Toxin: leaves the oil film the fire traps are waiting for.
        if (t.level >= 3) statuses.push(status('oiled', 5, 1));
      } else if (t.level >= 3) {
        statuses.push(status('burn', 2.5, 10));   // fire arrows: they light tar
      }
      const dealt = trapDamage(g, t, e, {
        amount: dmg, type: t.level >= 3 && spec.kind === 'archer' ? 'fire' : spec.type,
        source: src, position: t.world, statuses: statuses.length ? statuses : null,
      });
      g.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : spec.type);
      if (e.dead) t.kills++;
    }
  }

  /** Push bodies out of a blocker's tile. This is what "holds the corridor" means. */
  _block(t, spec) {
    const g = this.game;
    let blocking = false;
    const r = spec.blockRadius ?? 1.8;
    for (const e of g.enemies.queryNear(t.world, r + 1.4)) {
      if (e.airborne || e.dead) continue;
      const dx = e.position.x - t.world.x, dz = e.position.z - t.world.z;
      const d = Math.hypot(dx, dz);
      const want = r + e.radius;
      if (d >= want || d < 1e-4) continue;
      const push = want - d;
      e.position.x += (dx / d) * push;
      e.position.z += (dz / d) * push;
      e.velocity.x *= 0.3; e.velocity.z *= 0.3;
      blocking = true;
    }
    return blocking;
  }

  /**
   * Incoming damage. Enemies only ever target the player directly, so the pressure a
   * guardian is under is modelled here: anything in melee range is hitting it, and
   * ranged orcs shoot it from the back of the pack — the documented counter to hired help.
   */
  _guardianIncoming(t, dt) {
    const g = this.game;
    const spec = t.def.guardian;
    let dps = 0;
    const melee = 2.4 + (spec.blockRadius ?? 0);
    for (const e of g.enemies.queryNear(t.world, melee)) {
      if (e.dead || e.airborne) continue;
      dps += (e.attackDamage ?? 10) / Math.max(0.4, e.attackRate ?? 1.2);
    }
    for (const e of g.enemies.queryNear(t.world, 14)) {
      if (e.dead || !e.has('ranged')) continue;
      dps += (e.attackDamage ?? 12) / Math.max(0.5, e.attackRate ?? 2) * 0.9;
    }
    if (dps <= 0) return;

    t.hp -= dps * dt;
    t.gs.hurtAcc += dps * dt;
    if (t.gs.hurtAcc > t.hpMax * 0.04) {
      t.gs.hurtAcc = 0;
      t.rig?.hurt?.();
      g.fx.hit(v0.set(t.world.x, 1.3, t.world.z), null, { count: 4, color: [1, 0.4, 0.35], speed: 4 });
    }
  }

  _guardianDeath(t) {
    const g = this.game;
    g.fx.gib(t.world, null, 10, [0.5, 0.2, 0.18]);
    g.fx.ring(t.world, 1.6, [1, 0.5, 0.3], 24);
    g.fx.shake(0.3, 0.2);
    g.audio.play('orc.death', { position: t.world, pitch: 0.85 });
    g.ui.toast(`${t.def.name} has fallen`, 'error');
    g.bus.emit('trap:destroyed', { trap: t });
    this._remove(t);
  }

  /** Step back one tile, away from whatever is closing in. */
  _reposition(t, threat) {
    const grid = this.game.grid;
    const cur = t.world.distanceTo(threat.position);
    let best = null, bestD = cur + 0.75;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = t.gx + dx, nz = t.gz + dz;
      const c = grid.cell(nx, nz);
      if (!c || !grid.isWalkable(nx, nz) || c.floorTrap || c.flags.has('no-build')) continue;
      grid.toWorld(nx, nz, v1);
      const d = v1.distanceTo(threat.position);
      if (d > bestD) { bestD = d; best = { nx, nz, x: v1.x, z: v1.z }; }
    }
    if (!best) return false;
    const old = grid.cell(t.gx, t.gz);
    if (old && old.floorTrap === t) old.floorTrap = null;
    t.gx = best.nx; t.gz = best.nz;
    grid.cell(t.gx, t.gz).floorTrap = t;
    t.world.set(best.x, 0, best.z);
    t.gs.repos = 2.2;
    this.game.fx.dust(t.world, 0.7, 5);
    return true;
  }

  damageGuardian(trap, amount) {
    if (!trap?.def.guardian) return;
    trap.hp -= amount;
    trap.rig?.hurt?.();
    if (trap.hp <= 0) this._guardianDeath(trap);
  }

  // --- build ghost ---------------------------------------------------------
  _updateGhost(dt) {
    const g = this.game;
    const def = getTrapDef(this.selectedId);
    if (!def) return;
    this.ghost.setModel(def, (d) => this._buildBody(d));

    const cell = g.grid.toCell(g.input.aimWorld, this._cellOut);
    const { gx, gz } = cell;

    if (g.input.pressed('rotate')) {
      this.ghostDir = DIRS[(DIRS.indexOf(this.ghostDir) + 1) % 4];
      g.audio.play('ui.hover', { pitch: 1.3 });
    }

    if (!g.grid.inBounds(gx, gz)) { this.ghost.setVisible(false); return; }
    this.ghost.setVisible(true);

    const check = this.canPlace(def, gx, gz, this.ghostDir);
    const existing = this._existingFor(def, gx, gz, check.dir ?? this.ghostDir);
    this.ghostValid = check.ok;

    g.grid.toWorld(gx, gz, v0);
    const upCheck = existing ? this._canUpgrade(existing) : null;
    this.ghost.update({
      def, gx, gz, dir: this.ghostDir, world: v0,
      check: existing ? upCheck : check,
      existing,
    });

    if (g.input.mouseClicked(0)) {
      if (existing) {
        const res = this.upgrade(existing);
        if (!res.ok) { g.audio.play('ui.error'); g.ui.toast(res.reason, 'error'); }
      } else if (check.ok) {
        this.place(def, gx, gz, check.dir ?? this.ghostDir);
      } else {
        g.audio.play('ui.error');
        g.ui.toast(check.reason, 'error');
      }
    }
    if (g.input.mouseClicked(2)) {
      const t = existing || this._trapAt(gx, gz);
      if (t) this.sell(t);
    }
  }

  _canUpgrade(trap) {
    if (trap.level >= 3) return { ok: false, reason: 'Already level 3' };
    const cost = trap.def.upgrade?.costs?.[trap.level - 1];
    if (cost === undefined) return { ok: false, reason: 'Cannot be upgraded' };
    if (!this.game.scoring.canAfford(cost)) return { ok: false, reason: 'Not enough coin' };
    return { ok: true };
  }

  /** The trap a click on this tile would act on, given what is currently selected. */
  _existingFor(def, gx, gz, dir) {
    const c = this.game.grid.cell(gx, gz);
    if (!c) return null;
    if (def.blocker) return c.blocker || null;
    if (def.surface === 'ceiling') return c.ceilTrap || null;
    if (def.surface === 'wall') return c.wallTraps[dir] || DIRS.map((d) => c.wallTraps[d]).find(Boolean) || null;
    return c.floorTrap || null;    // floor and guardian share the tile slot
  }

  _trapAt(gx, gz) {
    const c = this.game.grid.cell(gx, gz);
    if (!c) return null;
    return c.blocker || c.floorTrap || c.ceilTrap || DIRS.map((d) => c.wallTraps[d]).find(Boolean) || null;
  }

  clear() {
    for (const t of Array.from(this.list)) this._remove(t);
    this.list.length = 0;
    clearFlights();
    this.buildMode = false;
    this.ghost.setVisible(false);
  }
}
