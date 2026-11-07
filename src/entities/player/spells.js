import * as THREE from 'three';
import { applyDamage, status } from '../../shared/Damage.js';

/**
 * Three spells, one per problem the roster creates that no weapon solves:
 *
 *   Frost Nova    the horde is *on* you, or a runner is two tiles from the rift.
 *                 Roots everything that is not frost-immune and makes it take 50% more.
 *   Blink         an archer line, a boss charge, a corner you backed yourself into.
 *                 The only true escape, and it detonates where you left.
 *   Arcane Lance  a shaman behind eight bodies, or a boss that ignores knockback.
 *                 Arcane is untouched by armour, and it pierces the whole line.
 *
 * All three are cooldown-only (no mana) so they stay readable next to the two magic
 * weapons that *do* cost mana. Cooldowns tick on `game.clock.dt`, so pause, hitstop and
 * slow-motion all hold them — nothing here touches a timer.
 */

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

const spellDmg = (player) => player.mods?.dmg?.spell ?? 1;

export const SPELLS = [
  {
    id: 'frost-nova', name: 'Frost Nova', key: 'KeyF', icon: '❄', keyLabel: 'F',
    cooldown: 10, color: [0.55, 0.85, 1.0],
    description: 'Roots and chills everything around you, and makes it take 50% more damage.',
    cast(player, game) {
      const at = _a.copy(player.position); at.y = 0.5;
      const radius = 7.5 * (player.mods?.blast ?? 1);

      // Every point-source burst additive-blends into one white ball at this camera
      // distance, which taught players nothing about the radius. So the edge is drawn as
      // an actual ring of frost puffs stamped *at* `radius`, and only a small core is
      // emitted from the centre.
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2;
        _b.set(at.x + Math.cos(a) * radius * 0.86, 0.4, at.z + Math.sin(a) * radius * 0.86);
        game.fx.frost(_b, 1.5, 9);
      }
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 + 0.3;
        _b.set(at.x + Math.cos(a) * radius * 0.45, 0.4, at.z + Math.sin(a) * radius * 0.45);
        game.fx.frost(_b, 1.1, 6);
      }
      game.fx.ring(at, radius * 0.5, [0.5, 0.85, 1], 24);
      game.fx.flash('#8fd8ff', 0.25, 0.18);
      game.fx.shake(0.35, 0.25);
      game.audio.play('trap.tar', { position: at, pitch: 1.4 });
      game.engine.hitstop(0.05);

      let n = 0;
      for (const e of game.enemies.queryRadius(at, radius)) {
        applyDamage(e, {
          amount: 45 * spellDmg(player), type: 'ice',
          source: { kind: 'player', id: 'frost-nova', hitsAir: true }, position: at,
          // freeze is refused for frost-immune orcs by Enemy.addStatus, so the slow is
          // the floor: even a Frostling is inconvenienced, it just is not stopped.
          statuses: [status('freeze', 2.2, 1), status('slow', 4.0, 0.55)],
        }, game);
        game.fx.frost(e.position, 0.4, 3);
        n++;
      }
      if (n) game.fx.damageNumber(at, n, 'lightning');
      return true;
    },
  },

  {
    id: 'blink', name: 'Blink', key: 'KeyC', icon: '✦', keyLabel: 'C',
    cooldown: 6, color: [0.75, 0.55, 1.0],
    description: 'Teleport toward your cursor. Detonates where you were, shoving the crowd off you.',
    cast(player, game) {
      const grid = game.grid;
      const dist = 11;
      const dx = Math.sin(player.aimAngle), dz = Math.cos(player.aimAngle);
      const from = _a.copy(player.position);

      // March out in short steps and stop at the last legal cell — a teleport that can
      // drop you inside a wall is worse than no teleport at all.
      let travelled = 0;
      for (let s = 0.5; s <= dist; s += 0.5) {
        const x = from.x + dx * s, z = from.z + dz * s;
        if (grid && !grid.isWalkable(Math.floor(x / 4), Math.floor(z / 4))) break;
        travelled = s;
      }
      if (travelled < 0.5) return false;   // nose against a wall: do not burn the cooldown

      // Departure blast: this is what makes Blink an escape and not just a dash.
      for (const e of game.enemies.queryRadius(from, 3.6)) {
        const ex = e.position.x - from.x, ez = e.position.z - from.z;
        const d = Math.hypot(ex, ez) || 0.001;
        applyDamage(e, {
          amount: 40 * spellDmg(player), type: 'arcane',
          source: { kind: 'player', id: 'blink', hitsAir: true }, position: from,
          knockback: { x: (ex / d) * 30, y: 3, z: (ez / d) * 30 },
        }, game);
      }
      game.fx.ring(from, 2.0, [0.8, 0.5, 1], 34);
      game.fx.dust(from, 1.2, 14);

      player.position.x = from.x + dx * travelled;
      player.position.z = from.z + dz * travelled;
      player.velocity.multiplyScalar(0.35);
      player.iframes = Math.max(player.iframes, 0.45);
      player.blinkFlash = 0.35;

      game.fx.ring(player.position, 1.6, [0.8, 0.5, 1], 28);
      game.fx.flash('#b070ff', 0.18, 0.22);
      game.audio.play('magic.shot', { position: player.position, pitch: 1.9 });
      game.rig.focus.lerp(player.position, 0.55);   // keep the camera glued to the arrival
      return true;
    },
  },

  {
    id: 'arcane-lance', name: 'Arcane Lance', key: 'KeyV', icon: '⟶', keyLabel: 'V',
    cooldown: 14, color: [1.0, 0.45, 0.95],
    description: 'A piercing beam. Ignores armour, hits everything in the line, marks it.',
    cast(player, game) {
      const origin = _a.set(player.position.x, 1.3, player.position.z);
      const a = player.aimAngle;
      const dx = Math.sin(a), dz = Math.cos(a);
      const RANGE = 32, HALF_WIDTH = 1.5;

      let n = 0;
      // Snapshot: a kill swap-removes from the live list, which would skip the enemy moved
      // into the dead one's slot.
      for (const e of Array.from(game.enemies.list)) {
        if (e.dead) continue;
        const ex = e.position.x - origin.x, ez = e.position.z - origin.z;
        const t = ex * dx + ez * dz;
        if (t < -1 || t > RANGE) continue;
        const px = ex - dx * t, pz = ez - dz * t;
        const r = e.radius + HALF_WIDTH;
        if (px * px + pz * pz > r * r) continue;
        const dealt = applyDamage(e, {
          amount: 230 * spellDmg(player), type: 'arcane',
          source: { kind: 'player', id: 'arcane-lance', hitsAir: true }, position: origin,
          knockback: { x: dx * 14, y: 2, z: dz * 14 },
          statuses: [status('vulnerable', 5, 0.25)],
        }, game);
        _b.set(e.position.x, e.airborne ? e.position.y + 0.9 : 1.3, e.position.z);
        game.fx.hit(_b, null, { count: 20, color: [1, 0.5, 1], speed: 12 });
        game.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : 'crit');
        n++;
      }

      // A fat, slow-fading beam: the one moment the player gets to feel like the boss.
      const proj = player.projectiles;
      proj.tracer(origin.x, origin.z, dx, dz, RANGE, [1, 0.45, 0.95], { width: 7, life: 0.3, opacity: 1, y: 1.3 });
      proj.tracer(origin.x, origin.z, dx, dz, RANGE, [1, 0.9, 1.0], { width: 3, life: 0.22, opacity: 1, y: 1.3 });
      game.fx.flash('#ff70e0', 0.22, 0.3);
      game.fx.shake(0.55, 0.35);
      game.audio.play('magic.shot', { position: origin, pitch: 0.5 });
      game.engine.hitstop(n ? 0.09 : 0.04);
      return true;
    },
  },
];

export const SPELL_BY_ID = new Map(SPELLS.map((s) => [s.id, s]));

/**
 * Runtime spell state. Kept out of Player so the cooldown bookkeeping and the input
 * binding live in one place, and so the hero rig can read `list` straight through for
 * the ready-lights on the ground ring.
 */
export class Spellbook {
  constructor(game, player) {
    this.game = game;
    this.player = player;
    this.list = SPELLS.map((def) => ({ def, cd: 0, ready: true }));
    // Register our own binds rather than reusing spell1..spell8: the HUD already owns
    // Digit1-9 for the trap bar, and a key that does two things is a key that does neither.
    for (const s of this.list) game.input.binds[this._action(s.def)] = [s.def.key];
  }

  _action(def) { return `spell:${def.id}`; }

  reset() { for (const s of this.list) { s.cd = 0; s.ready = true; } }

  update(dt, allowInput) {
    const g = this.game;
    for (const s of this.list) {
      if (s.cd > 0) {
        s.cd -= dt;
        if (s.cd <= 0) {
          s.cd = 0; s.ready = true;
          g.audio.play('ui.hover', { pitch: 1.7, gain: 0.35 });
        }
      }
      if (!allowInput || !s.ready) continue;
      if (!g.input.pressed(this._action(s.def))) continue;
      this.cast(s);
    }
  }

  cast(slot) {
    const g = this.game;
    if (!slot.ready) return false;
    if (slot.def.cast(this.player, g) === false) return false;
    slot.cd = slot.def.cooldown * (this.player.mods?.spellCd ?? 1);
    slot.ready = false;
    g.bus.emit('player:spell', { id: slot.def.id, cooldown: slot.cd });
    return true;
  }

  /** Cast by id — used by the debug harness and by any future UI button. */
  castById(id) {
    const slot = this.list.find((s) => s.def.id === id);
    return slot ? this.cast(slot) : false;
  }

  /** 0..1 readiness per spell, for the hero's ground ring and (eventually) the HUD. */
  readiness(out = []) {
    out.length = 0;
    for (const s of this.list) {
      out.push(s.ready ? 1 : 1 - s.cd / (s.def.cooldown * (this.player.mods?.spellCd ?? 1)));
    }
    return out;
  }
}
