import * as THREE from 'three';
import { status } from '../shared/Damage.js';
import { TILE } from '../world/Grid.js';
import { v0, v1 } from '../shared/scratch.js';
import { trapDamage, launch } from './combos.js';
import {
  M, GEO, lamp, glow, instance, box, cyl, boltedPlate, gear, spikeBed,
  floorFrame, marker, ringMesh, runeBand, greebles, stripeMat, statusBulb, approach, bar,
  TrapLight,
} from './parts.js';

/**
 * The trap roster. The design rule: no trap is strictly better than another. Each one
 * answers a specific orc ability, and the campaign unlocks the answer one level after
 * it introduces the problem — so you always feel the gap before you fill it.
 *
 *   barricade        blocks the tile, deals no damage -> beaten by sappers and ogres
 *   spike-floor      cheap, fast, physical            -> beaten by armour, flyers, sappers
 *   tar-pit          slows, no damage                 -> multiplies everything else
 *   arrow-wall       ranged, hits air                 -> beaten by armour
 *   boom-barrel      one-shot burst, fire             -> beaten by fire-immune
 *   ceiling-pounder  crush, ignores armour            -> slow, single target
 *   spring-trap      launches into pits/other traps   -> pure setup, zero damage
 *   wall-blades      sweeping physical, wide arc      -> beaten by shields from the front
 *   brimstone        sustained fire, burns            -> beaten by fire-immune
 *   grinder          continuous physical, wide        -> expensive, short cooldown
 *   ice-vent         freezes, +50% damage taken       -> beaten by frost-immune
 *   lightning-rod    chains, ignores armour           -> loves tar and packed lanes
 *   acid-sprayer     strips armour and shields        -> low direct damage
 *   arcane-obelisk   pierces all resistances          -> very expensive
 *   guardian-*       hired allies that hold a lane    -> can be killed by archers
 *
 * ---------------------------------------------------------------------------
 * Every trap declares four things beyond its numbers, because a trap the player
 * cannot *read* is a trap they cannot plan around:
 *
 *   sense    { kind:'tile'|'lane', radius, length, air, plate }
 *            what counts as "something is in my kill zone". `plate:true` means the
 *            victim must be on the tile proper, not merely near it — pressure plate.
 *   group    { want, patience }
 *            hold fire for up to `patience` seconds waiting for `want` bodies. This is
 *            what makes a Ceiling Pounder feel like it *chose* the moment.
 *   windup   seconds of visible tell before it commits. Kills have to be earned.
 *   upgrade  { costs:[l2,l3], notes:[..] } — see TrapManager.upgrade().
 *   counters [orc ability flags this trap is the answer to] — the UI reads this for its
 *            threat tooltips, so it must be *true*, not aspirational. An empty array
 *            means "no special answer, it just does damage".
 *
 * `build()` returns an Object3D whose `userData.rig` implements any of:
 *   wind(p, trap)  fire(trap, game)  tick(dt, trap, game)  charge(f)  setLevel(n)
 * TrapManager drives all of them; defs only handle the actual damage.
 */

const DIR_TO_VEC = { N: { x: 0, z: -1 }, E: { x: 1, z: 0 }, S: { x: 0, z: 1 }, W: { x: -1, z: 0 } };
export const OPPOSITE = { N: 'S', S: 'N', E: 'W', W: 'E' };

/** Which way a trap actually shoots. Wall traps mount ON dir and fire AWAY from it. */
export function aimVec(trap) {
  const d = trap.def.surface === 'wall' ? OPPOSITE[trap.dir] : trap.dir;
  return DIR_TO_VEC[d] || DIR_TO_VEC.S;
}

/** Damage/utility scaling per upgrade level. Level 3 is roughly double a level 1. */
export function power(trap) { return 1 + (trap.level - 1) * 0.45; }

/** Standard tile AoE used by most traps. Routed through the combo funnel. */
function hitCell(game, trap, opts) {
  const { radius = TILE * 0.7, amount, type, statuses, knockUp = 0, filter, airborne = false, center } = opts;
  const w = center || trap.world;
  const victims = [];
  for (const e of game.enemies.queryRadius(w, radius)) {
    if (!airborne && e.airborne) continue;
    if (filter && !filter(e)) continue;
    // Pure-utility traps (tar, spring) deal no damage, and `applyDamage` returns early on
    // a zero-damage spec — statuses included. So they apply their coating directly instead
    // of pretending to be a damage source.
    if (amount === 0) {
      if (statuses) for (const s of statuses) e.addStatus(s, game);
      victims.push(e);
      continue;
    }
    const dealt = trapDamage(game, trap, e, {
      amount: amount * power(trap), type,
      source: { kind: 'trap', id: trap.def.id, trap },
      position: w, statuses,
      knockback: knockUp ? { x: (e.position.x - w.x) * 2, y: knockUp, z: (e.position.z - w.z) * 2 } : null,
    });
    if (dealt > 0 || amount === 0) victims.push(e);
    if (amount > 0) game.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : type);
  }
  if (victims.length) trap.kills += victims.filter((e) => e.dead).length;
  return victims;
}

/** Sweep along the trap's firing lane, `len` tiles deep. Wall traps live on this. */
function hitLane(game, trap, len, opts) {
  const dv = aimVec(trap);
  const w = trap.world;
  const victims = [];
  const seen = new Set();
  for (let step = opts.from ?? 0; step <= len; step++) {
    v1.set(w.x + dv.x * step * TILE, opts.y ?? 1.0, w.z + dv.z * step * TILE);
    for (const e of game.enemies.queryRadius(v1, opts.radius ?? TILE * 0.7)) {
      if (seen.has(e)) continue;
      if (!opts.airborne && e.airborne) continue;
      seen.add(e);
      const dealt = trapDamage(game, trap, e, {
        amount: opts.amount * power(trap) * (e.airborne ? (opts.airMult ?? 1) : 1), type: opts.type,
        source: { kind: 'trap', id: trap.def.id, trap }, position: w,
        statuses: opts.statuses,
        knockback: opts.knock ? { x: dv.x * opts.knock, y: opts.knockUp ?? 0, z: dv.z * opts.knock } : null,
      });
      game.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : opts.type);
      victims.push(e);
      if (opts.pierce && victims.length >= opts.pierce) break;
    }
  }
  if (victims.length) trap.kills += victims.filter((e) => e.dead).length;
  return victims;
}

// ===========================================================================
export const TRAPS = [
  // ------------------------------------------------------------------ spikes
  {
    id: 'spike-floor', name: 'Spike Floor', surface: 'floor',
    cost: 400, cooldown: 1.15, unlockLevel: 1,
    tags: ['physical', 'damage'],
    counters: [],
    blurb: 'Barbs slam up through the grate. Cheap, fast, and useless against plate.',
    sense: { kind: 'tile', radius: TILE * 0.5, plate: true },
    windup: 0.16,
    upgrade: { costs: [320, 520], notes: ['+45% damage, side barbs', '+90% damage, hardened tips'] },
    build() {
      const g = new THREE.Group();
      g.add(floorFrame());
      // Dark well the spikes live in — depth is what makes them read as *inside* the floor.
      g.add(box(TILE * 0.78, 0.5, TILE * 0.78, M.stone, 0, -0.24, 0));
      const bars = [];
      for (let i = -1; i <= 1; i++) {
        bars.push({ p: [0, 0.1, i * 1.05], s: [TILE * 0.78, 0.07, 0.16] });
        bars.push({ p: [i * 1.05, 0.1, 0], s: [0.16, 0.07, TILE * 0.78] });
      }
      g.add(instance(GEO.box, M.steel, bars));

      const rammer = new THREE.Group();
      const bed = spikeBed(3, 2.5, 1.15, M.steel, 0.25);
      bed.position.y = 0.05;
      rammer.add(bed);
      rammer.add(box(2.7, 0.16, 2.7, M.darkSteel, 0, 0, 0));
      // Barbs that only appear at level 2 — an upgrade you can see from the camera.
      const barbs = spikeBed(2, 3.1, 0.7, M.steel, 0);
      barbs.rotation.y = Math.PI / 4;
      barbs.visible = false;
      rammer.add(barbs);
      rammer.position.y = -0.85;  // tips sit proud of the grate: the trap reads as loaded
      g.add(rammer);

      // Ratchet: the mechanism that explains where the force comes from.
      const ratchet = gear(0.44, 10, 0.18, M.brass);
      ratchet.position.set(TILE * 0.4, 0.34, TILE * 0.3);
      ratchet.rotation.y = Math.PI / 2;
      g.add(ratchet);
      const pistons = instance(GEO.cyl8, M.steel, [
        { p: [-1.35, 0.2, -1.35], s: [0.18, 0.55, 0.18] }, { p: [1.35, 0.2, -1.35], s: [0.18, 0.55, 0.18] },
        { p: [-1.35, 0.2, 1.35], s: [0.18, 0.55, 0.18] }, { p: [1.35, 0.2, 1.35], s: [0.18, 0.55, 0.18] },
      ]);
      g.add(pistons);

      const tipMat = M.steel;
      g.userData.rig = {
        y: -0.85, want: -0.85,
        wind(p) { this.want = -0.85 + p * 0.3; ratchet.rotation.x -= 0.25 * p; },
        fire() { this.want = 0.55; rammer.position.y = 0.55; },
        charge(f) { ratchet.rotation.x += 0.02 * (1 - f); },
        tick(dt, trap) {
          if (trap.phase !== 'fire') this.want = trap.phase === 'wind' ? this.want : -0.85;
          const rate = rammer.position.y < this.want ? 34 : 7;
          rammer.position.y = approach(rammer.position.y, this.want, rate, dt);
        },
        setLevel(n) {
          barbs.visible = n >= 2;
          bed.material = n >= 3 ? M.gold : tipMat;
        },
      };
      return g;
    },
    onTrigger(trap, game) {
      const v = hitCell(game, trap, {
        amount: trap.level >= 3 ? 66 : 58, type: 'physical', knockUp: 3.2, radius: TILE * 0.6,
      });
      game.audio.play('trap.spike', { position: trap.world });
      game.fx.hit(trap.world, null, { count: 9, color: [0.85, 0.9, 1.0], speed: 6 });
      if (v.length) game.fx.blood(trap.world, null, 0.7);
      return v;
    },
  },

  // -------------------------------------------------------------------- tar
  {
    id: 'tar-pit', name: 'Tar Pit', surface: 'floor',
    cost: 350, cooldown: 0, unlockLevel: 2, passive: true,
    tags: ['control', 'coating'],
    counters: [],
    blurb: 'No damage. Halves their speed, and the tar clings — anything you burn within a tile or two of it takes far more.',
    sense: { kind: 'tile', radius: TILE * 0.5 },
    upgrade: { costs: [260, 420], notes: ['Wider pool', 'Bitumen: longer coating and an extra 30% slow'] },
    build() {
      const g = new THREE.Group();
      const rim = new THREE.Mesh(new THREE.TorusGeometry(TILE * 0.46, 0.16, 5, 22).rotateX(Math.PI / 2), M.darkStone);
      rim.position.y = 0.09;
      g.add(rim);
      const surf = new THREE.Mesh(new THREE.CircleGeometry(TILE * 0.46, 22).rotateX(-Math.PI / 2), M.tar);
      surf.position.y = 0.055;
      g.add(surf);
      const sheenMat = glow(0x4a3524, 0.28);
      const sheen = new THREE.Mesh(new THREE.CircleGeometry(TILE * 0.4, 20).rotateX(-Math.PI / 2), sheenMat);
      sheen.position.y = 0.07;
      g.add(sheen);

      // The spilled barrel explains the puddle. Set dressing is characterisation.
      const barrel = cyl(0.42, 1.2, M.darkWood, TILE * 0.36, 0.34, -TILE * 0.3);
      barrel.rotation.z = Math.PI / 2.1;
      g.add(barrel);
      g.add(instance(GEO.link, M.rust, [
        { p: [TILE * 0.36, 0.34, -TILE * 0.3], r: [0, 0, Math.PI / 2.1], s: [1.3, 1.3, 1.3] },
      ]));

      // Four bubbles in one instanced mesh, re-posed each frame: the pit has to look alive
      // or it reads as a stain, but not at four draw calls a tile.
      const seeds = [0, 0.6, 1.2, 1.8];
      const bubbles = instance(GEO.sphere, M.tar, seeds.map((_, i) => {
        const a = (i / 4) * Math.PI * 2;
        return { p: [Math.cos(a) * 0.9, 0.06, Math.sin(a) * 0.9], s: [0.4, 0.4, 0.4] };
      }));
      g.add(bubbles);
      const _bm = new THREE.Matrix4();
      const _bp = new THREE.Vector3();
      const _bs = new THREE.Vector3();
      const _bq = new THREE.Quaternion();

      g.userData.rig = {
        tick(dt, trap) {
          for (let i = 0; i < 4; i++) {
            seeds[i] += dt * (0.8 + trap.level * 0.25);
            const p = (seeds[i] % 2.2) / 2.2;
            const swell = 0.25 + Math.sin(p * Math.PI) * 0.55;
            const a = (i / 4) * Math.PI * 2;
            _bp.set(Math.cos(a) * 0.9, 0.05 + Math.sin(p * Math.PI) * 0.16, Math.sin(a) * 0.9);
            _bs.setScalar(swell);
            bubbles.setMatrixAt(i, _bm.compose(_bp, _bq, _bs));
          }
          bubbles.instanceMatrix.needsUpdate = true;
          sheenMat.opacity = 0.22 + Math.sin(trap._t * 1.7) * 0.08;
        },
        setLevel(n) {
          const s = 1 + (n - 1) * 0.06;
          surf.scale.set(s, 1, s); rim.scale.set(s, 1, s);
          sheenMat.color.setHex(n >= 3 ? 0x6a4a20 : 0x4a3524);
        },
      };
      return g;
    },
    onArm(trap, game) {
      // Only a *nudge* in the flow field. At the old cost of 2.6 the horde simply walked
      // around the tar in any corridor wider than one tile, which made the trap that every
      // other trap depends on worthless. Orcs should step in it and regret it.
      const c = game.grid.cell(trap.gx, trap.gz);
      if (c) { c.cost = 1.15; game.grid.markDirty(); }
    },
    onRemove(trap, game) {
      const c = game.grid.cell(trap.gx, trap.gz);
      if (c) { c.cost = 1; game.grid.markDirty(); }
    },
    onTick(trap, game, dt) {
      trap._t = (trap._t || 0) + dt;
      trap._acc = (trap._acc || 0) + dt;
      if (trap._acc < 0.15) return;
      trap._acc = 0;
      // Level 3 bitumen adds a separate 30% slow on top of the tar and coats for longer.
      //
      // The lingering window is the whole combo system, and it was measurably too short.
      // A tarred orc moves at 0.45 speed, i.e. ~2.8s to cross one tile, so a 1.6s coating
      // wore off after *half a tile*: a Brimstone one tile behind a Tar Pit dealt exactly
      // the same 1,013 damage as a Brimstone with no tar at all, while one placed directly
      // adjacent dealt 4,226. The combo was binary — perfect adjacency or nothing — which
      // is indistinguishable from "combos don't pay" for anyone building a real killbox.
      // 3.4s covers a full tile of tarred travel plus slack, so the payoff now degrades
      // smoothly with distance instead of falling off a cliff.
      const st = trap.level >= 3
        ? [status('tar', 4.4, 1), status('slow', 4.4, 0.3)]
        : [status('tar', 3.4, 1)];
      hitCell(game, trap, { amount: 0, type: 'physical', radius: TILE * (0.5 + trap.level * 0.03), statuses: st });
    },
  },

  // ------------------------------------------------------------- arrow wall
  {
    id: 'arrow-wall', name: 'Arrow Wall', surface: 'wall',
    cost: 500, cooldown: 1.7, unlockLevel: 1,
    tags: ['physical', 'ranged', 'anti-air'],
    counters: ['flying', 'trap-disarm'],
    blurb: 'A four-bolt volley down the lane. Hits flyers, which floor traps never will.',
    sense: { kind: 'lane', length: 5, radius: TILE * 0.66, air: true },
    group: { want: 2, patience: 0.45 },
    windup: 0.3,
    upgrade: { costs: [400, 650], notes: ['Six bolts, longer lane', 'Bodkin heads: targets take +20% damage for 2.5s'] },
    build() {
      const g = new THREE.Group();
      // Everything hangs off the wall at local -Z; the lane runs toward local +Z.
      const backZ = -TILE * 0.44;
      g.add(boltedPlate(TILE * 0.82, 2.7, 0.3, M.iron, M.steel).translateY(1.6).translateZ(backZ));
      const drum = new THREE.Group();
      drum.position.set(0, 1.5, backZ + 0.42);
      g.add(drum);
      const hull = cyl(0.52, TILE * 0.7, M.darkSteel);
      hull.rotation.z = Math.PI / 2;
      drum.add(hull);
      const tubes = [];
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        tubes.push({ p: [Math.cos(a) * 0.3, Math.sin(a) * 0.3, 0], r: [Math.PI / 2, 0, 0], s: [0.2, TILE * 0.72, 0.2] });
      }
      drum.add(instance(GEO.cyl8, M.steel, tubes));
      const heads = instance(GEO.cone5, lamp(0xffd070, 0.8), [
        { p: [-1.0, 0.3, 0.34], r: [Math.PI / 2, 0, 0], s: [0.16, 0.4, 0.16] },
        { p: [-0.35, -0.3, 0.34], r: [Math.PI / 2, 0, 0], s: [0.16, 0.4, 0.16] },
        { p: [0.35, 0.3, 0.34], r: [Math.PI / 2, 0, 0], s: [0.16, 0.4, 0.16] },
        { p: [1.0, -0.3, 0.34], r: [Math.PI / 2, 0, 0], s: [0.16, 0.4, 0.16] },
      ]);
      drum.add(heads);

      // Draw bar = the bowstring. It slides back as it winds and snaps forward on fire.
      const bar = box(TILE * 0.76, 0.14, 0.14, M.brass, 0, 1.5, backZ + 0.95);
      g.add(bar);
      const crank = gear(0.4, 9, 0.16, M.brass);
      crank.position.set(TILE * 0.42, 1.5, backZ + 0.4);
      crank.rotation.y = Math.PI / 2;
      g.add(crank);
      g.add(greebles(6, TILE * 0.7, 2.0, 0.2, M.darkSteel, 3).translateY(1.6).translateZ(backZ + 0.2));

      // Bright top cap + bulb: from a 52° camera a wall trap is mostly its top face.
      g.add(box(TILE * 0.86, 0.18, 0.62, M.brass, 0, 3.0, backZ + 0.18));
      const bulb = statusBulb(3.25, backZ + 0.18);
      g.add(bulb);

      // The lane it covers, drawn faintly on the floor. You should never have to guess.
      const lane = marker(0.5, TILE * 5, 0xffcc60, 0.10);
      lane.position.z = TILE * 2.5;
      g.add(lane);

      g.userData.rig = {
        wind(p) {
          bar.position.z = backZ + 0.95 - p * 0.55;
          drum.rotation.z = -p * 1.05;
          lane.material.opacity = 0.1 + p * 0.35;
          heads.material.emissiveIntensity = 0.8 + p * 2.2;
          bulb.userData.set(0xff8420, 1 + p * 3);
        },
        fire() { bar.position.z = backZ + 1.15; lane.material.opacity = 0.6; },
        charge(f) {
          // The crank winds the string back as the cooldown fills — state you can read.
          crank.rotation.x = f * 6;
          bar.position.z = backZ + 1.15 - f * 0.2;
          lane.material.opacity = 0.06 + f * 0.06;
          heads.material.emissiveIntensity = 0.3 + f * 0.7;
          bulb.userData.set(f >= 1 ? 0x40ff90 : 0xff4030, 0.5 + f * 1.1);
        },
        setLevel(n) {
          drum.scale.setScalar(1 + (n - 1) * 0.1);
          lane.scale.z = 1 + (n - 1) * 0.2;
          if (n >= 3) heads.material.color.setHex(0xfff0b0);
        },
      };
      return g;
    },
    onTrigger(trap, game) {
      const dv = aimVec(trap);
      const w = trap.world;
      const len = trap.level >= 2 ? 6 : 5;
      const v = hitLane(game, trap, len, {
        from: 1, amount: 34, type: 'physical', radius: TILE * 0.62, airborne: true,
        knock: 5, y: 1.2,
        // Bodkins: level 3 punches through the armour this trap normally loses to.
        statuses: trap.level >= 3 ? [status('vulnerable', 2.5, 0.2)] : null,
      });
      for (let i = 0; i < 4; i++) {
        const off = (i - 1.5) * 0.5;
        game.fx.lightning(
          v0.set(w.x - dv.x * TILE * 0.3 + dv.z * off, 1.5, w.z - dv.z * TILE * 0.3 + dv.x * off),
          v1.set(w.x + dv.x * len * TILE, 1.1, w.z + dv.z * len * TILE), [1, 0.85, 0.5],
        );
      }
      game.audio.play('trap.arrow', { position: w });
      return v;
    },
  },

  // ------------------------------------------------------------- boom barrel
  {
    id: 'boom-barrel', name: 'Boom Barrel', surface: 'floor',
    cost: 550, cooldown: 0, unlockLevel: 2, oneShot: true,
    tags: ['fire', 'burst'],
    counters: ['shielded', 'splitter'],
    blurb: 'Detonates once, hugely. Put it where the horde bunches — or in a tar pit.',
    sense: { kind: 'tile', radius: TILE * 0.85, air: true },
    group: { want: 3, patience: 0.9 },
    windup: 0.42,
    upgrade: { costs: [420, 700], notes: ['Bigger charge, wider blast', 'Shrapnel jacket: bleeds survivors'] },
    build() {
      const g = new THREE.Group();
      g.add(marker(TILE * 0.86, TILE * 0.86, 0xff7a20, 0.07));
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.05, 0.2, 12), stripeMat());
      base.position.y = 0.1;
      g.add(base);
      const keg = new THREE.Mesh(new THREE.CylinderGeometry(0.72, 0.8, 1.6, 12), M.wood);
      keg.position.y = 1.0;
      g.add(keg);
      g.add(instance(new THREE.TorusGeometry(0.78, 0.07, 5, 16).rotateX(Math.PI / 2), M.rust, [
        { p: [0, 0.5, 0] }, { p: [0, 1.5, 0] },
      ]));
      // A cage of straps: reads as "dangerous cargo", not "barrel of ale".
      const straps = [];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        straps.push({ p: [Math.cos(a) * 0.78, 1.0, Math.sin(a) * 0.78], r: [0, -a, 0], s: [0.1, 1.7, 0.1] });
      }
      g.add(instance(GEO.box, M.darkSteel, straps));

      const fuseMat = lamp(0xff6a20, 1.6);
      const fuse = new THREE.Mesh(GEO.sphere, fuseMat);
      fuse.position.set(0, 2.0, 0);
      fuse.scale.setScalar(0.22);
      g.add(fuse);
      const cord = cyl(0.05, 0.7, M.darkWood, 0, 1.95, 0);
      cord.rotation.z = 0.4;
      g.add(cord);
      const light = new TrapLight(0xff6a20, 1.2, 7, 2);
      light.position.set(0, 2.0, 0);
      g.add(light);

      g.userData.rig = {
        wind(p, trap) {
          // The fuse burns down and the keg starts shaking. You get ~0.4s to run.
          fuse.position.y = 2.0 - p * 0.5;
          fuse.scale.setScalar(0.22 + p * 0.3);
          light.intensity = 1.2 + p * 9;
          keg.position.x = (Math.random() - 0.5) * p * 0.16;
          keg.position.z = (Math.random() - 0.5) * p * 0.16;
        },
        tick(dt, trap, game) {
          const t = game.clock.elapsed;
          fuse.scale.setScalar(0.2 + Math.sin(t * 9) * 0.05);
          if (trap.phase !== 'wind') { keg.position.x = 0; keg.position.z = 0; light.intensity = 1.2; }
        },
        setLevel(n) { keg.scale.setScalar(1 + (n - 1) * 0.15); },
      };
      return g;
    },
    onTrigger(trap, game) {
      const w = trap.world;
      const r = TILE * (1.5 + (trap.level - 1) * 0.28);
      const v = hitCell(game, trap, {
        amount: 190, type: 'fire', radius: r, knockUp: 8, airborne: true,
        statuses: trap.level >= 3
          ? [status('burn', 3.5, 20), status('vulnerable', 4, 0.25)]
          : [status('burn', 3, 18)],
      });
      game.fx.fire(w, 3.4, 52);
      game.fx.ring(w, r * 0.8, [1, 0.6, 0.2], 46);
      game.fx.shake(0.6, 0.32);
      game.fx.flash('#ff9040', 0.2, 0.28);
      game.engine.hitstop(0.055);
      game.audio.play('trap.boom', { position: w });
      game.traps.destroy(trap, true);
      return v;
    },
  },

  // --------------------------------------------------------- ceiling pounder
  {
    id: 'ceiling-pounder', name: 'Ceiling Pounder', surface: 'ceiling',
    cost: 700, cooldown: 2.6, unlockLevel: 3,
    tags: ['crush', 'anti-armour', 'anti-air'],
    counters: ['armored', 'shielded', 'flying'],
    blurb: 'A spiked block on a winch. Crush damage laughs at plate — and shatters anything frozen. Swats flyers on the way down.',
    // `air`: the block falls from the ceiling straight through flying height, so a
    // Gargoyle over the plate both trips it and gets hit.
    sense: { kind: 'tile', radius: TILE * 0.55, plate: true, air: true },
    group: { want: 2, patience: 0.7 },
    windup: 0.34,
    upgrade: { costs: [560, 900], notes: ['Heavier block, faster winch', 'Iron maiden: spikes on all faces'] },
    build() {
      const g = new THREE.Group();
      const frame = new THREE.Group();
      frame.position.y = 5.7;
      g.add(frame);
      frame.add(box(TILE * 0.8, 0.35, TILE * 0.8, M.iron));
      const winch = cyl(0.34, TILE * 0.62, M.darkSteel, 0, -0.34, 0);
      winch.rotation.z = Math.PI / 2;
      frame.add(winch);
      const cog = gear(0.42, 12, 0.16, M.brass);
      cog.position.set(TILE * 0.34, -0.34, 0);
      cog.rotation.y = Math.PI / 2;
      frame.add(cog);

      // All four chains in one instanced batch; the rig stretches the whole batch in Y,
      // which pays out and reels in every link for the price of a single draw call.
      const links = [];
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        for (let i = 0; i < 7; i++) {
          links.push({
            p: [sx * 0.75, -0.6 * (i + 0.5), sz * 0.75],
            r: [i % 2 ? 0 : Math.PI / 2, 0, Math.PI / 2],
            s: [0.9, 0.9, 0.9],
          });
        }
      }
      const chains = instance(GEO.link, M.darkSteel, links);
      chains.position.y = 5.7;
      g.add(chains);

      const block = new THREE.Group();
      block.position.y = 4.6;
      g.add(block);
      // Kept narrower than the tile: a ceiling block big enough to fill the tile just
      // reads as a hole in the floor from the top-down camera. The bright banded cap does
      // the rest of that work — from above you see a steel weight, not a void.
      block.add(box(TILE * 0.6, 1.05, TILE * 0.6, M.stone));
      block.add(box(TILE * 0.64, 0.16, TILE * 0.64, M.steel, 0, 0.58, 0));
      block.add(instance(GEO.box, M.brass, [
        { p: [0, 0.66, 0], s: [TILE * 0.66, 0.1, 0.22] },
        { p: [0, 0.66, 0], s: [0.22, 0.1, TILE * 0.66] },
      ]));
      block.add(instance(GEO.rivet, M.steel, [
        { p: [-1.2, 0.6, -1.2], s: [0.24, 0.2, 0.24] }, { p: [1.2, 0.6, -1.2], s: [0.24, 0.2, 0.24] },
        { p: [-1.2, 0.6, 1.2], s: [0.24, 0.2, 0.24] }, { p: [1.2, 0.6, 1.2], s: [0.24, 0.2, 0.24] },
      ]));
      const teeth = spikeBed(3, 2.0, 0.55, M.steel, 0.2);
      teeth.rotation.x = Math.PI;
      teeth.position.y = -0.58;
      block.add(teeth);
      const sideTeeth = spikeBed(2, 2.6, 0.5, M.steel, 0);
      sideTeeth.position.y = 0.75;
      sideTeeth.visible = false;
      block.add(sideTeeth);

      // The tile it will flatten, painted on the floor. Non-negotiable for readability.
      const target = marker(TILE * 0.8, TILE * 0.8, 0xffa040, 0.10);
      g.add(target);
      const brackets = instance(GEO.box, glow(0xffa040, 0.35), [
        { p: [-1.6, 0.06, -1.6], s: [0.7, 0.02, 0.16] }, { p: [-1.6, 0.06, -1.6], s: [0.16, 0.02, 0.7] },
        { p: [1.6, 0.06, 1.6], s: [0.7, 0.02, 0.16] }, { p: [1.6, 0.06, 1.6], s: [0.16, 0.02, 0.7] },
      ]);
      g.add(brackets);

      g.userData.rig = {
        wind(p) {
          block.position.y = 4.6 + p * 0.45;
          target.material.opacity = 0.10 + p * 0.55;
          brackets.material.opacity = 0.4 + p * 0.5;
          cog.rotation.x -= 0.4 * p;
        },
        fire(trap) { trap._phase2 = 'drop'; },
        charge(f) { target.material.opacity = 0.06 + f * 0.05; brackets.material.opacity = 0.18 + f * 0.15; },
        tick(dt, trap, game) {
          if (trap._phase2 === 'drop') {
            block.position.y -= 36 * dt;
            if (block.position.y <= 0.62) {
              block.position.y = 0.62;
              trap._phase2 = 'up';
              trap.def.impact(trap, game);
            }
          } else if (trap._phase2 === 'up') {
            block.position.y += (5.5 + trap.level * 1.4) * dt;
            cog.rotation.x += dt * 5;
            if (block.position.y >= 4.6) { block.position.y = 4.6; trap._phase2 = null; }
          }
          // Chains pay out and reel in with the block — the winch has to look like it works.
          chains.scale.y = Math.max(0.04, (5.7 - block.position.y - 0.55) / 4.2);
        },
        setLevel(n) {
          sideTeeth.visible = n >= 3;
          block.scale.setScalar(1 + (n - 1) * 0.08);
        },
      };
      return g;
    },
    // The block leaves the ceiling on trigger but lands a beat later, so its signature has
    // to wait for the impact rather than the release. TrapManager honours this flag.
    deferTrigger: true,
    /** Called by the rig at the bottom of the swing — the damage belongs to the impact. */
    impact(trap, game) {
      const v = hitCell(game, trap, { amount: 115, type: 'crush', radius: TILE * 0.68, knockUp: 2, airborne: true });
      game.fx.dust(trap.world, 1.8, 22);
      game.fx.shake(0.45, 0.22);
      game.engine.hitstop(0.04);
      game.bus.emit('trap:triggered', { trap, victims: v });
    },
    onTrigger() { return []; },
  },

  // -------------------------------------------------------------- barricade
  /**
   * The one object in the game that is not a trap: it does no damage and it cannot be
   * triggered. It closes a tile.
   *
   * Everything else here answers the question "what happens when an orc walks over this
   * tile?". The barricade answers the one that comes first — *which tiles does an orc
   * walk over at all?* Without it, a level with six lanes is six separate problems and
   * eight traps cannot cover them; with it, six lanes become one lane and eight traps are
   * a killbox. That is the whole build phase of this genre, and it is why the object is
   * gated four different ways rather than being a cheap staple:
   *
   *   1. it unlocks at level 4, after the player has felt three levels of not having it;
   *   2. it costs 700 — one barricade or one good trap, never both;
   *   3. there is a hard cap of 12 placed, so you can shape a route but never seal one;
   *   4. it is destructible, and the two orcs the roster already had *are its counters*:
   *      a Sapper chews it five times faster than a grunt, an Ogre six times faster.
   *
   * And the fifth gate, enforced in TrapManager.canPlace: a placement that leaves any
   * spawn unable to reach the rift is refused outright. You may bend the path into any
   * shape you like. You may never delete it — otherwise the player character, and the
   * whole reason this is an action game, stops mattering.
   *
   * When it finally goes down it does not just vanish: it collapses on whatever broke it.
   * That is the second answer to Ogres, and it is one the player *built*.
   */
  {
    id: 'barricade', name: 'Barricade', surface: 'blocker',
    // `passive` only so the UI's cadence line reads "Always on" instead of "Instant";
    // TrapManager branches on `blocker` before it ever looks at `passive`.
    cost: 700, cooldown: 0, unlockLevel: 4, blocker: true, passive: true, cap: 12,
    tags: ['blocker', 'structure'],
    // Deliberately empty. A barricade is not the answer to an orc ability — it is the
    // answer to the *map*, and the threat tooltips must never claim otherwise.
    counters: [],
    blurb: 'No damage. It closes the tile — six lanes become one. Sappers and ogres come for it first, and it falls on them when it goes.',
    sense: { kind: 'tile', radius: TILE * 0.5 },
    barricade: { hp: 1400, collapse: 190 },
    upgrade: {
      costs: [520, 860],
      notes: ['Banded timber: +65% hp, the spikes bleed whoever hacks at it',
              'Iron-shod: +160% hp, and the collapse crushes the whole tile'],
    },
    build() {
      const g = new THREE.Group();

      // Footing. A barricade is *built*, not grown: it starts with a rubble plinth so it
      // reads as something dragged into place rather than part of the level.
      g.add(box(TILE * 0.98, 0.34, TILE * 0.98, M.darkStone, 0, 0.17, 0));
      g.add(instance(GEO.ico, M.stone, [
        { p: [-1.7, 0.22, 1.6], r: [0.3, 0.8, 0.1], s: [0.55, 0.4, 0.55] },
        { p: [1.75, 0.2, -1.5], r: [0.1, 2.1, 0.4], s: [0.48, 0.34, 0.48] },
        { p: [1.5, 0.18, 1.8], r: [0.5, 1.2, 0.2], s: [0.4, 0.3, 0.4] },
      ]));

      // The wall itself: two staggered courses of block, so the silhouette from directly
      // above is a chequer and not a flat grey square.
      const body = new THREE.Group();
      body.position.y = 0.34;
      g.add(body);

      const lower = new THREE.Group();
      body.add(lower);
      lower.add(instance(GEO.box, M.stone, [
        { p: [-1.2, 0.42, 0], s: [1.1, 0.8, TILE * 0.9] },
        { p: [0, 0.42, 0], s: [1.1, 0.8, TILE * 0.9] },
        { p: [1.2, 0.42, 0], s: [1.1, 0.8, TILE * 0.9] },
      ]));

      const top = new THREE.Group();
      top.position.y = 1.24;
      body.add(top);
      top.add(instance(GEO.box, M.stone, [
        { p: [-0.62, 0.4, 0], s: [1.14, 0.78, TILE * 0.9] },
        { p: [0.62, 0.4, 0], s: [1.14, 0.78, TILE * 0.9] },
      ]));

      // Timber and iron: four uprights, two bands, and a pair of braces leaning on each
      // face. This is the read that separates "the player put this here" from "level wall".
      body.add(instance(GEO.box, M.darkWood, [
        { p: [-1.72, 0.9, -1.6], s: [0.3, 1.9, 0.3] }, { p: [1.72, 0.9, -1.6], s: [0.3, 1.9, 0.3] },
        { p: [-1.72, 0.9, 1.6], s: [0.3, 1.9, 0.3] }, { p: [1.72, 0.9, 1.6], s: [0.3, 1.9, 0.3] },
      ]));
      const braces = instance(GEO.box, M.wood, [
        { p: [-0.9, 0.62, -1.95], r: [0.62, 0, 0], s: [0.26, 2.1, 0.26] },
        { p: [0.9, 0.62, 1.95], r: [-0.62, 0, 0], s: [0.26, 2.1, 0.26] },
      ]);
      body.add(braces);
      const bands = instance(GEO.box, M.rust, [
        { p: [0, 0.78, 0], s: [TILE * 0.99, 0.2, TILE * 0.95] },
        { p: [0, 1.62, 0], s: [TILE * 0.99, 0.18, TILE * 0.95] },
      ]);
      body.add(bands);
      body.add(instance(GEO.rivet, M.steel, [
        { p: [-1.5, 0.78, -1.85], s: [0.28, 0.24, 0.28] }, { p: [1.5, 0.78, -1.85], s: [0.28, 0.24, 0.28] },
        { p: [-1.5, 1.62, -1.85], s: [0.28, 0.24, 0.28] }, { p: [1.5, 1.62, -1.85], s: [0.28, 0.24, 0.28] },
        { p: [-1.5, 0.78, 1.85], s: [0.28, 0.24, 0.28] }, { p: [1.5, 0.78, 1.85], s: [0.28, 0.24, 0.28] },
        { p: [-1.5, 1.62, 1.85], s: [0.28, 0.24, 0.28] }, { p: [1.5, 1.62, 1.85], s: [0.28, 0.24, 0.28] },
      ]));

      // Cap: the flattest, warmest surface, because from a 52° camera the top face is most
      // of what you see. Timber and rust rather than brass — it has to read instantly as
      // *the player's* wall against cold grey level stone, without competing with the
      // emissive state rings that every actual trap is signalling with.
      const cap = box(TILE * 0.96, 0.24, TILE * 0.96, M.wood, 0, 2.12, 0);
      body.add(cap);
      body.add(instance(GEO.box, M.rust, [
        { p: [-1.3, 2.26, 0], s: [0.3, 0.1, TILE * 0.96] },
        { p: [1.3, 2.26, 0], s: [0.3, 0.1, TILE * 0.96] },
      ]));

      // Level tells. Spikes at 2, iron plate at 3 — both visible from the play camera.
      const spikes = spikeBed(2, TILE * 0.72, 0.62, M.steel, 0.12);
      spikes.position.y = 2.22;
      spikes.visible = false;
      body.add(spikes);
      const plates = instance(GEO.box, M.steel, [
        { p: [-1.74, 1.2, 0], s: [0.16, 1.9, TILE * 0.9] },
        { p: [1.74, 1.2, 0], s: [0.16, 1.9, TILE * 0.9] },
      ]);
      plates.visible = false;
      body.add(plates);

      // Damage read: a hot crack that opens through the courses as the hp drops. Cheaper
      // and far more legible from above than swapping in a cracked texture.
      const crackMat = glow(0xff5a28, 0);
      const cracks = instance(GEO.box, crackMat, [
        { p: [-0.6, 1.1, -1.92], r: [0, 0, 0.35], s: [0.14, 2.0, 0.06] },
        { p: [0.75, 1.1, 1.92], r: [0, 0, -0.5], s: [0.14, 2.0, 0.06] },
        { p: [0, 2.24, 0], s: [0.16, 0.06, TILE * 0.9] },
      ]);
      body.add(cracks);

      // Health bar. A destructible object with no visible health is a rug-pull.
      const hb = bar(2.6, 0xc0a070);
      hb.position.y = 3.15;
      hb.visible = false;
      g.add(hb);
      g.userData.bar = hb;

      g.userData.rig = {
        tick(dt, trap) {
          const f = trap.hpMax ? Math.max(0, trap.hp / trap.hpMax) : 1;
          // It sags and splits as it goes. You should be able to triage a wall of these
          // at a glance and decide which one to spend coin repairing... or abandon.
          top.position.y = 1.24 - (1 - f) * 0.26;
          top.rotation.z = (1 - f) * 0.05 * Math.sin(trap._t * 1.1);
          crackMat.opacity = (1 - f) * 0.55;
          const shake = trap._sieged > 0 ? 0.08 : 0;
          body.position.x = shake ? (Math.random() - 0.5) * shake : body.position.x * 0.5;
          body.position.z = shake ? (Math.random() - 0.5) * shake : body.position.z * 0.5;
          hb.visible = f < 0.999;
          hb.userData.set(f);
        },
        setLevel(n) {
          spikes.visible = n >= 2;
          plates.visible = n >= 3;
          braces.material = n >= 2 ? M.darkSteel : M.wood;
          cap.material = n >= 3 ? M.steel : M.wood;
        },
      };
      return g;
    },
  },

  // ------------------------------------------------------------ spring trap
  {
    id: 'spring-trap', name: 'Spring Trap', surface: 'floor',
    cost: 400, cooldown: 1.5, unlockLevel: 4,
    tags: ['control', 'setup'],
    counters: ['unstoppable'],
    blurb: 'Zero damage. Flings them where it points — into a pit, or into your spikes.',
    sense: { kind: 'tile', radius: TILE * 0.45, plate: true },
    windup: 0.14,
    upgrade: { costs: [320, 520], notes: ['Longer throw', 'Catapult: throws brutes and ogres too'] },
    build() {
      const g = new THREE.Group();
      g.add(floorFrame(TILE * 0.94, 0.34, true));
      g.add(box(TILE * 0.8, 0.14, TILE * 0.8, M.darkStone, 0, 0.07, 0));

      // Coil built from stacked links: an actual spring, not a torus knot.
      const coil = new THREE.Group();
      const links = [];
      for (let i = 0; i < 7; i++) links.push({ p: [0, 0.12 + i * 0.14, 0], r: [Math.PI / 2, 0, 0], s: [1.5, 1.5, 1.5] });
      coil.add(instance(GEO.link, M.steel, links));
      g.add(coil);

      const hinge = new THREE.Group();
      hinge.position.set(0, 0.2, -TILE * 0.36);
      g.add(hinge);
      const plate = box(TILE * 0.76, 0.18, TILE * 0.72, M.darkSteel, 0, 0, TILE * 0.36);
      hinge.add(plate);
      const tread = box(TILE * 0.6, 0.06, TILE * 0.5, stripeMat(), 0, 0.12, TILE * 0.36);
      hinge.add(tread);
      g.add(instance(GEO.cyl8, M.brass, [
        { p: [-TILE * 0.38, 0.2, -TILE * 0.36], r: [0, 0, Math.PI / 2], s: [0.16, 0.4, 0.16] },
        { p: [TILE * 0.38, 0.2, -TILE * 0.36], r: [0, 0, Math.PI / 2], s: [0.16, 0.4, 0.16] },
      ]));

      // Chevrons: the launch direction has to be legible without selecting the trap.
      const chevMat = glow(0x40ff90, 0.34);
      const chevrons = instance(GEO.box, chevMat, [
        { p: [-0.42, 0.05, TILE * 0.56], r: [0, Math.PI / 4, 0], s: [0.75, 0.02, 0.2] },
        { p: [0.42, 0.05, TILE * 0.56], r: [0, -Math.PI / 4, 0], s: [0.75, 0.02, 0.2] },
        { p: [-0.42, 0.05, TILE * 0.82], r: [0, Math.PI / 4, 0], s: [0.75, 0.02, 0.2] },
        { p: [0.42, 0.05, TILE * 0.82], r: [0, -Math.PI / 4, 0], s: [0.75, 0.02, 0.2] },
      ]);
      g.add(chevrons);

      g.userData.rig = {
        wind(p) { hinge.rotation.x = p * 0.12; coil.scale.y = 1 - p * 0.5; chevMat.opacity = 0.5 + p * 0.5; },
        fire() { hinge.rotation.x = -1.15; coil.scale.y = 1.6; },
        charge(f) { chevMat.opacity = 0.2 + f * 0.35; },
        tick(dt) {
          hinge.rotation.x = approach(hinge.rotation.x, 0, 7, dt);
          coil.scale.y = approach(coil.scale.y, 1, 8, dt);
        },
        setLevel(n) { chevMat.color.setHex(n >= 3 ? 0xffd050 : 0x40ff90); },
      };
      return g;
    },
    onTrigger(trap, game) {
      const dv = aimVec(trap);
      const throwPower = 26 + trap.level * 7;
      const victims = [];
      for (const e of game.enemies.queryRadius(trap.world, TILE * 0.6)) {
        if (e.airborne) continue;
        // A level 3 catapult is heavy enough to throw what "unstoppable" normally protects
        // (never a boss; see combos.launch).
        const catapult = trap.level >= 3;
        if (e.has('unstoppable') && !catapult) continue;
        const heavy = e.mass > 3;
        if (heavy && !catapult) continue;
        if (launch(game, trap, e, dv.x * throwPower, 11 + trap.level, dv.z * throwPower, { force: catapult })) victims.push(e);
      }
      game.fx.dust(trap.world, 1.3, 14, [0.4, 0.9, 0.6]);
      return victims;
    },
  },

  // ------------------------------------------------------------- wall blades
  {
    id: 'wall-blades', name: 'Wall Blades', surface: 'wall',
    cost: 800, cooldown: 1.25, unlockLevel: 4,
    tags: ['physical', 'sweep'],
    counters: ['shielded', 'trap-disarm'],
    blurb: 'A spinning arc that sweeps two tiles. Shields block it — so hit them from behind. Clips low flyers for half damage.',
    sense: { kind: 'lane', length: 1, radius: TILE * 0.62, air: true },
    windup: 0.26,
    upgrade: { costs: [640, 1040], notes: ['Third blade, deeper reach', 'Serrated: sweeps twice per trigger'] },
    build() {
      const g = new THREE.Group();
      const backZ = -TILE * 0.44;
      g.add(boltedPlate(TILE * 0.7, 2.4, 0.3, M.iron, M.steel).translateY(1.5).translateZ(backZ));
      const housing = new THREE.Group();
      housing.position.set(0, 1.5, backZ + 0.4);
      g.add(housing);
      housing.add(box(TILE * 0.55, 1.0, 0.7, M.darkSteel));
      const cog = gear(0.36, 10, 0.14, M.brass);
      cog.position.set(TILE * 0.32, 0, 0.1);
      cog.rotation.y = Math.PI / 2;
      housing.add(cog);

      const arm = new THREE.Group();
      housing.add(arm);
      const shaft = cyl(0.14, 1.6, M.steel, 0, 0, 0.8);
      shaft.rotation.x = Math.PI / 2;
      arm.add(shaft);
      const spinner = new THREE.Group();
      spinner.position.z = 1.4;
      arm.add(spinner);
      const bladeMats = [];
      const blades = [];
      for (let i = 0; i < 3; i++) {
        const b = new THREE.Mesh(GEO.box, M.steel);
        b.scale.set(0.09, 2.1, 0.42);
        b.rotation.z = (i / 3) * Math.PI * 2;
        b.position.set(Math.sin((i / 3) * Math.PI * 2) * 0.0, 0, 0);
        blades.push(b);
        spinner.add(b);
      }
      blades[2].visible = false;   // the third blade is the level 2 upgrade
      const guard = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.09, 4, 14, Math.PI), M.iron);
      guard.position.z = 1.4;
      guard.rotation.y = Math.PI / 2;
      arm.add(guard);

      g.add(box(TILE * 0.74, 0.18, 0.6, M.brass, 0, 2.75, backZ + 0.2));
      const bulb = statusBulb(3.0, backZ + 0.2);
      g.add(bulb);

      const lane = marker(TILE * 0.7, TILE * 1.9, 0xffaa60, 0.1);
      lane.position.z = TILE * 0.5;
      g.add(lane);

      g.userData.rig = {
        spin: 1.5,
        wind(p) {
          this.spin = 1.5 + p * 34; arm.position.z = p * 0.5;
          lane.material.opacity = 0.1 + p * 0.4;
          bulb.userData.set(0xff8420, 1 + p * 3);
        },
        fire() { this.spin = 40; arm.position.z = 0.9; },
        charge(f) {
          lane.material.opacity = 0.08 + f * 0.08; cog.rotation.x += 0.05;
          bulb.userData.set(f >= 1 ? 0x40ff90 : 0xff4030, 0.5 + f * 1.1);
        },
        tick(dt, trap) {
          spinner.rotation.z += this.spin * dt;
          this.spin = approach(this.spin, trap.phase === 'ready' ? 2.4 : this.spin, 1.6, dt);
          arm.position.z = approach(arm.position.z, trap.phase === 'wind' ? arm.position.z : 0, 5, dt);
        },
        setLevel(n) {
          spinner.scale.setScalar(1 + (n - 1) * 0.12);
          blades[2].visible = n >= 2;
          if (n >= 3) for (const b of blades) b.material = M.gold;
          lane.scale.z = 1 + (n - 1) * 0.25;
        },
      };
      return g;
    },
    onTrigger(trap, game) {
      const len = trap.level >= 2 ? 2 : 1;
      const v = hitLane(game, trap, len, {
        from: 0, amount: 72, type: 'physical', radius: TILE * 0.62, knock: 9, knockUp: 1.2,
        airborne: true, airMult: 0.5,
      });
      for (const e of v) game.fx.blood(e.position, aimVec(trap), 1.1);
      // Serrated: a second bite half a beat later catches whoever stepped into the gap.
      if (trap.level >= 3) trap._second = 0.22;
      return v;
    },
    onTick(trap, game, dt) {
      if (trap._second > 0) {
        trap._second -= dt;
        if (trap._second <= 0) {
          trap._second = 0;
          hitLane(game, trap, 2, { from: 0, amount: 42, type: 'physical', radius: TILE * 0.62, knock: 6, airborne: true, airMult: 0.5 });
          game.fx.trapBlades(trap.world, trap);
        }
      }
    },
  },

  // -------------------------------------------------------------- brimstone
  {
    id: 'brimstone', name: 'Brimstone', surface: 'floor',
    cost: 850, cooldown: 0, unlockLevel: 5, passive: true,
    tags: ['fire', 'sustained'],
    counters: ['regen'],
    blurb: 'A patch of hell. Everything standing on it burns — and tar makes it burn far longer.',
    sense: { kind: 'tile', radius: TILE * 0.5 },
    upgrade: { costs: [680, 1100], notes: ['Hotter coals', 'Hellmouth: gouts of flame, wider patch'] },
    build() {
      const g = new THREE.Group();
      g.add(floorFrame(TILE * 0.94, 0.3, false));
      const pit = new THREE.Mesh(new THREE.CircleGeometry(TILE * 0.42, 20).rotateX(-Math.PI / 2), M.darkStone);
      pit.position.y = 0.03;
      g.add(pit);

      // Coals: instanced rocks with their own emissive material so they can breathe.
      const coalMat = lamp(0xff4a08, 1.1);
      const coals = [];
      for (let i = 0; i < 14; i++) {
        const a = (i * 2.399);
        const r = 0.35 + (i % 5) * 0.26;
        coals.push({ p: [Math.cos(a) * r, 0.12, Math.sin(a) * r], r: [a, a * 2, 0], s: [0.34 + (i % 3) * 0.1, 0.24, 0.34] });
      }
      g.add(instance(GEO.ico, coalMat, coals));

      // Four vents so it reads as plumbing, not a puddle of paint.
      const vents = [];
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        vents.push({ p: [Math.cos(a) * TILE * 0.36, 0.2, Math.sin(a) * TILE * 0.36], s: [0.34, 0.4, 0.34] });
      }
      g.add(instance(GEO.cyl8, M.iron, vents));

      const glowMat = glow(0xff5a10, 0.55);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(TILE * 0.44, 20).rotateX(-Math.PI / 2), glowMat);
      disc.position.y = 0.08;
      g.add(disc);
      const light = new TrapLight(0xff5a10, 3, 11, 2);
      light.position.y = 0.9;
      g.add(light);

      g.userData.rig = {
        tick(dt, trap, game) {
          const t = game.clock.elapsed;
          const p = 0.55 + Math.sin(t * 7 + trap.gx) * 0.2 + Math.sin(t * 13.3 + trap.gz) * 0.12;
          glowMat.opacity = p * (trap.level >= 3 ? 1.15 : 1);
          coalMat.emissiveIntensity = 0.8 + p * 1.1;
          light.intensity = 3 * p * (1 + (trap.level - 1) * 0.3);
        },
        setLevel(n) {
          const s = 1 + (n - 1) * 0.07;
          disc.scale.set(s, 1, s);
          coalMat.color.setHex(n >= 3 ? 0xffa020 : 0xff4a08);
        },
      };
      return g;
    },
    onTick(trap, game, dt) {
      trap._t = (trap._t || 0) + dt;
      if (Math.random() < dt * (22 + trap.level * 10)) game.fx.fire(trap.world, 1.1, trap.level >= 3 ? 4 : 2);
      trap._acc = (trap._acc || 0) + dt;
      if (trap._acc < 0.3) return;
      trap._acc = 0;
      const v = hitCell(game, trap, {
        amount: 17, type: 'fire', radius: TILE * (0.5 + (trap.level - 1) * 0.06),
        statuses: [status('burn', 2.4, 12)],
      });
      // Passive traps never go through TrapManager._fire, so this is where their
      // signature comes from — and only when something is actually burning in it.
      if (v.length) game.bus.emit('trap:triggered', { trap, victims: v });
    },
  },

  // ---------------------------------------------------------------- grinder
  {
    id: 'grinder', name: 'Floor Grinder', surface: 'floor',
    cost: 1100, cooldown: 0.4, unlockLevel: 6,
    tags: ['physical', 'sustained'],
    counters: ['splitter'],
    blurb: 'Two counter-rotating drums. Constant damage to everything that steps in.',
    sense: { kind: 'tile', radius: TILE * 0.5 },
    windup: 0,
    upgrade: { costs: [880, 1430], notes: ['Faster drums', 'Bone-shredder: +armour shred'] },
    build() {
      const g = new THREE.Group();
      g.add(floorFrame(TILE * 0.96, 0.36, true));
      g.add(box(TILE * 0.8, 0.7, TILE * 0.8, M.darkStone, 0, -0.34, 0));

      const drums = new THREE.Group();
      const drumMeshes = [];
      for (const sx of [-0.72, 0.72]) {
        const d = new THREE.Group();
        d.position.set(sx, 0.28, 0);
        const core = cyl(0.5, TILE * 0.74, M.darkSteel);
        core.rotation.z = Math.PI / 2;
        d.add(core);
        const teeth = [];
        for (let i = 0; i < 10; i++) {
          const a = (i / 10) * Math.PI * 2;
          for (let k = -1; k <= 1; k++) {
            teeth.push({
              p: [k * 0.9, Math.sin(a) * 0.52, Math.cos(a) * 0.52],
              r: [-a, 0, 0], s: [0.5, 0.22, 0.2],
            });
          }
        }
        d.add(instance(GEO.box, M.steel, teeth));
        drums.add(d);
        drumMeshes.push(d);
      }
      g.add(drums);
      const belt = gear(0.5, 12, 0.14, M.brass);
      belt.position.set(TILE * 0.44, 0.28, TILE * 0.3);
      belt.rotation.y = Math.PI / 2;
      g.add(belt);
      // Bones in the housing: the trap tells you what it has been doing.
      g.add(instance(GEO.cyl8, M.bone, [
        { p: [-1.5, 0.02, 1.4], r: [0, 0.7, Math.PI / 2], s: [0.09, 0.7, 0.09] },
        { p: [1.4, 0.02, -1.5], r: [0, -0.4, Math.PI / 2], s: [0.08, 0.5, 0.08] },
        { p: [0.2, 0.02, 1.7], r: [0, 1.4, Math.PI / 2], s: [0.07, 0.4, 0.07] },
      ]));

      g.userData.rig = {
        speed: 6,
        tick(dt, trap) {
          this.speed = approach(this.speed, trap.phase === 'ready' ? 6 : 22 + trap.level * 4, 4, dt);
          drumMeshes[0].rotation.x += this.speed * dt;
          drumMeshes[1].rotation.x -= this.speed * dt;
          belt.rotation.x += this.speed * 0.5 * dt;
        },
        setLevel(n) { drums.scale.y = 1 + (n - 1) * 0.1; },
      };
      return g;
    },
    onTrigger(trap, game) {
      const v = hitCell(game, trap, {
        amount: 28, type: 'physical', radius: TILE * 0.52,
        statuses: trap.level >= 3 ? [status('vulnerable', 2, 0.15)] : null,
      });
      if (v.length) {
        // Armour shred: the level 3 answer to the thing this trap normally loses to.
        if (trap.level >= 3) for (const e of v) e.armor = Math.max(0, (e.armor || 0) - 3);
        game.fx.blood(trap.world, null, 1.5);
      }
      return v;
    },
  },

  // --------------------------------------------------------------- ice vent
  {
    id: 'ice-vent', name: 'Ice Vent', surface: 'floor',
    cost: 750, cooldown: 2.2, unlockLevel: 7,
    tags: ['ice', 'control'],
    counters: ['leaper', 'unstoppable'],
    blurb: 'Freezes them solid: +50% damage taken, and a crush hit shatters them outright.',
    sense: { kind: 'tile', radius: TILE * 0.8 },
    group: { want: 2, patience: 0.55 },
    windup: 0.3,
    upgrade: { costs: [600, 975], notes: ['Longer freeze, wider cone', 'Deep freeze: chills neighbouring tiles'] },
    build() {
      const g = new THREE.Group();
      g.add(floorFrame(TILE * 0.94, 0.3, false));
      // Rime-crusted deck: an ice trap has to look cold before it does anything.
      const deck = new THREE.Mesh(new THREE.CircleGeometry(TILE * 0.44, 18).rotateX(-Math.PI / 2),
        new THREE.MeshStandardMaterial({ color: 0xbfe6f5, roughness: 0.35, metalness: 0.1 }));
      deck.position.y = 0.05;
      g.add(deck);
      const rime = [];
      for (let i = 0; i < 10; i++) {
        const a = i * 2.399;
        const r = 1.0 + (i % 4) * 0.24;
        rime.push({ p: [Math.cos(a) * r, 0.1, Math.sin(a) * r], r: [0.2, a, 0.15], s: [0.26, 0.5 + (i % 3) * 0.2, 0.26] });
      }
      g.add(instance(GEO.ico, M.glass, rime));

      const manifold = new THREE.Group();
      g.add(manifold);
      manifold.add(cyl(0.5, 0.5, M.darkSteel, 0, 0.3, 0, 8));
      manifold.add(cyl(0.22, 0.9, M.steel, 0, 0.7, 0, 8));
      // Three angled nozzles: the machine points at the tile it is going to freeze.
      const nozzles = [];
      const pipes = [];
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        nozzles.push({ p: [Math.cos(a) * 1.1, 0.62, Math.sin(a) * 1.1], r: [Math.PI / 2.6 * Math.cos(a + Math.PI / 2), 0, -Math.PI / 2.6 * Math.sin(a + Math.PI / 2)], s: [0.42, 0.75, 0.42] });
        pipes.push({ p: [Math.cos(a) * 0.6, 0.42, Math.sin(a) * 0.6], r: [Math.PI / 2, 0, -a], s: [0.18, 1.15, 0.18] });
      }
      manifold.add(instance(GEO.cone, M.steel, nozzles));
      manifold.add(instance(GEO.cyl8, M.copper, pipes));
      const tank = cyl(0.36, 1.3, M.copper, -TILE * 0.32, 0.72, TILE * 0.3);
      g.add(tank);
      g.add(instance(new THREE.TorusGeometry(0.4, 0.06, 4, 10).rotateX(Math.PI / 2), M.brass, [
        { p: [-TILE * 0.32, 0.35, TILE * 0.3] }, { p: [-TILE * 0.32, 1.1, TILE * 0.3] },
      ]));

      // Pressure gauge with a needle that actually tracks the cooldown. Best possible
      // "is it ready?" read: you can see the trap loading from across the room.
      const gaugeMat = lamp(0x8fe0ff, 0.8);
      const gauge = new THREE.Mesh(GEO.cyl, gaugeMat);
      gauge.scale.set(0.5, 0.1, 0.5);
      gauge.position.set(TILE * 0.32, 0.5, TILE * 0.3);
      gauge.rotation.x = Math.PI / 2.6;
      g.add(gauge);
      g.add(cyl(0.16, 0.5, M.iron, TILE * 0.32, 0.25, TILE * 0.3, 8));
      const needle = box(0.05, 0.26, 0.03, M.iron, 0, 0.09, 0);
      needle.position.y = 0.08;
      const needlePivot = new THREE.Group();
      needlePivot.add(needle);
      needle.position.set(0, 0.13, 0);
      needlePivot.position.copy(gauge.position);
      needlePivot.rotation.copy(gauge.rotation);
      g.add(needlePivot);

      const crystals = new THREE.Group();
      const crystalMat = new THREE.MeshStandardMaterial({
        color: 0xa8e8ff, transparent: true, opacity: 0.55, roughness: 0.1,
        emissive: 0x2a7aaa, emissiveIntensity: 0.5,
      });
      for (let i = 0; i < 5; i++) {
        const c = new THREE.Mesh(GEO.ico, crystalMat);
        const a = i * 1.6;
        c.position.set(Math.cos(a) * 0.75, 0.3, Math.sin(a) * 0.75);
        c.scale.set(0.5, 1.3, 0.5);
        c.rotation.set(0.2, a, 0.15);
        crystals.add(c);
      }
      crystals.scale.y = 0.45;
      g.add(crystals);
      const frostRing = ringMesh(TILE * 0.34, TILE * 0.46, 0x9fe4ff, 0.2);
      g.add(frostRing);

      g.userData.rig = {
        wind(p) {
          crystals.scale.y = 0.45 + p * 0.5;
          frostRing.material.opacity = 0.2 + p * 0.5;
        },
        fire() { crystals.scale.y = 1.6; frostRing.material.opacity = 0.85; },
        charge(f) { needlePivot.rotation.z = -f * Math.PI * 1.4; gaugeMat.emissiveIntensity = 0.25 + f * 1.1; },
        tick(dt, trap) {
          crystals.rotation.y += dt * 0.5;
          crystals.scale.y = approach(crystals.scale.y, trap.phase === 'wind' ? crystals.scale.y : 0.45, 4, dt);
          frostRing.material.opacity = approach(frostRing.material.opacity, 0.18, 3, dt);
        },
        setLevel(n) { crystalMat.emissiveIntensity = 0.3 + n * 0.25; frostRing.scale.setScalar(1 + (n - 1) * 0.1); },
      };
      return g;
    },
    onTrigger(trap, game) {
      const dur = 1.8 + (trap.level - 1) * 0.5;
      const v = hitCell(game, trap, {
        amount: 26, type: 'ice', radius: TILE * (0.8 + (trap.level - 1) * 0.12),
        statuses: [status('freeze', dur, 1)],
      });
      // Deep freeze chills the ring of tiles around it: sets up crush traps two tiles out.
      if (trap.level >= 3) {
        hitCell(game, trap, {
          amount: 8, type: 'ice', radius: TILE * 1.6,
          statuses: [status('slow', 2.5, 0.45)],
        });
      }
      game.fx.frost(trap.world, 1.6, 30);
      return v;
    },
  },

  // ---------------------------------------------------------- lightning rod
  {
    id: 'lightning-rod', name: 'Lightning Rod', surface: 'ceiling',
    cost: 1200, cooldown: 2.2, unlockLevel: 8,
    tags: ['lightning', 'chain', 'anti-air'],
    counters: ['flying', 'armored'],
    blurb: 'Chains through the pack, ignores armour, hits flyers. Tar conducts it.',
    sense: { kind: 'tile', radius: TILE * 1.3, air: true },
    group: { want: 3, patience: 0.8 },
    windup: 0.36,
    upgrade: { costs: [960, 1560], notes: ['+2 chain targets', 'Overcharge: stuns everything it touches'] },
    build() {
      const g = new THREE.Group();
      g.add(box(TILE * 0.55, 0.4, TILE * 0.55, M.iron, 0, 5.8, 0));
      g.add(cyl(0.16, 1.1, M.copper, 0, 5.2, 0));
      const rings = new THREE.Group();
      rings.position.y = 4.5;
      g.add(rings);
      const ringMats = [];
      for (let i = 0; i < 3; i++) {
        const m = lamp(0xb5683a, 0.6);
        ringMats.push(m);
        const r = new THREE.Mesh(new THREE.TorusGeometry(0.85 - i * 0.22, 0.07, 4, 16), m);
        r.rotation.x = Math.PI / 2 + i * 0.35;
        r.position.y = i * 0.24;
        rings.add(r);
      }
      const coreMat = lamp(0x70b0ff, 1.3);
      const core = new THREE.Mesh(GEO.ico1, coreMat);
      core.scale.setScalar(0.5);
      core.position.y = 4.5;
      g.add(core);
      const light = new TrapLight(0x70b0ff, 2.2, 15, 2);
      light.position.y = 4.4;
      g.add(light);
      const field = ringMesh(TILE * 1.2, TILE * 1.28, 0x70b0ff, 0.07);
      g.add(field);

      g.userData.rig = {
        wind(p) {
          core.scale.setScalar(0.5 + p * 0.55);
          coreMat.emissiveIntensity = 1.3 + p * 6;
          light.intensity = 2 + p * 12;
          field.material.opacity = 0.07 + p * 0.35;
          for (const m of ringMats) m.emissiveIntensity = 0.6 + p * 3.4;
        },
        fire() { core.scale.setScalar(1.3); light.intensity = 22; },
        charge(f) {
          coreMat.emissiveIntensity = 0.5 + f * 2.0;
          light.intensity = 0.6 + f * 2.2;
          field.material.opacity = 0.03 + f * 0.05;
          for (const m of ringMats) m.emissiveIntensity = 0.2 + f * 0.6;
        },
        tick(dt, trap) {
          rings.children[0].rotation.z += dt * (0.6 + trap.level * 0.4);
          rings.children[1].rotation.z -= dt * 1.1;
          rings.children[2].rotation.y += dt * 1.6;
          core.rotation.y += dt * 2;
          core.scale.setScalar(approach(core.scale.x, 0.5, 5, dt));
        },
        setLevel(n) { rings.scale.setScalar(1 + (n - 1) * 0.12); coreMat.color.setHex(n >= 3 ? 0xd0e8ff : 0x70b0ff); },
      };
      return g;
    },
    onTrigger(trap, game) {
      const w = trap.world;
      let from = v1.set(w.x, 4.2, w.z);
      let current = game.enemies.nearest(w, TILE * 1.5);
      const chained = new Set();
      const maxLinks = 4 + trap.level * 2;
      let dmg = 62 * power(trap);
      const victims = [];
      for (let i = 0; i < maxLinks && current; i++) {
        chained.add(current);
        game.fx.lightning(from, v0.set(current.position.x, current.position.y + 1, current.position.z));
        const dealt = trapDamage(game, trap, current, {
          amount: dmg, type: 'lightning',
          source: { kind: 'trap', id: trap.def.id, trap }, position: from,
          statuses: [status('stun', trap.level >= 3 ? 0.6 : 0.3, 1)],
        });
        game.fx.damageNumber(current.position, dealt, dealt === 0 ? 'immune' : 'lightning');
        victims.push(current);
        from = v1.set(current.position.x, current.position.y + 1, current.position.z);
        dmg *= 0.85;
        // Tar is conductive: the arc reaches further between tarred bodies.
        const reach = current.statuses.some((s) => s.kind === 'tar') ? 10 : 7;
        current = game.enemies.nearest(current.position, reach, (e) => !chained.has(e));
      }
      game.fx.ring(w, 1.6, [0.5, 0.75, 1], 20);
      trap.kills += victims.filter((e) => e.dead).length;
      return victims;
    },
  },

  // --------------------------------------------------------- acid sprayer
  {
    id: 'acid-sprayer', name: 'Acid Sprayer', surface: 'wall',
    cost: 800, cooldown: 1.6, unlockLevel: 8,
    tags: ['poison', 'anti-armour', 'anti-shield', 'coating'],
    counters: ['armored', 'shielded', 'trap-disarm'],
    blurb: 'Melts armour and shields, and leaves them slick — anything you burn next goes up.',
    sense: { kind: 'lane', length: 2, radius: TILE * 0.75, air: true },
    windup: 0.24,
    upgrade: { costs: [640, 1040], notes: ['Deeper cone, stronger shred', 'Vitriol: melts shields outright'] },
    build() {
      const g = new THREE.Group();
      const backZ = -TILE * 0.44;
      g.add(boltedPlate(TILE * 0.6, 2.3, 0.26, M.iron, M.brass).translateY(1.7).translateZ(backZ));

      // Glass tank whose fluid level *is* the cooldown bar. Cheapest honest UI there is.
      const tank = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 1.35, 12), M.glass);
      tank.position.set(0, 2.1, backZ + 0.5);
      g.add(tank);
      const fluidMat = lamp(0x7aff3a, 0.7);
      const fluid = new THREE.Mesh(GEO.cyl, fluidMat);
      fluid.scale.set(0.72, 1.2, 0.72);
      fluid.position.set(0, 2.1, backZ + 0.5);
      g.add(fluid);
      g.add(instance(new THREE.TorusGeometry(0.45, 0.06, 4, 12).rotateX(Math.PI / 2), M.brass, [
        { p: [0, 1.45, backZ + 0.5] }, { p: [0, 2.78, backZ + 0.5] },
      ]));

      const pump = cyl(0.2, 0.7, M.darkSteel, -0.7, 1.5, backZ + 0.5);
      g.add(pump);
      const piston = cyl(0.12, 0.5, M.steel, -0.7, 1.85, backZ + 0.5);
      g.add(piston);
      const hose = cyl(0.1, 1.2, M.darkWood, 0.55, 1.5, backZ + 0.5);
      hose.rotation.z = -0.6;
      g.add(hose);
      const nozzle = new THREE.Mesh(GEO.cone, M.brass);
      nozzle.scale.set(0.4, 0.6, 0.4);
      nozzle.position.set(0, 1.15, backZ + 0.95);
      nozzle.rotation.x = Math.PI / 2;
      g.add(nozzle);

      g.add(box(TILE * 0.62, 0.18, 0.6, M.brass, 0, 3.0, backZ + 0.2));
      const bulb = statusBulb(3.25, backZ + 0.2);
      g.add(bulb);

      const cone = marker(TILE * 1.15, TILE * 2.4, 0x8aff40, 0.055);
      cone.position.z = TILE * 1.0;
      g.add(cone);

      g.userData.rig = {
        wind(p) {
          piston.position.y = 1.85 - p * 0.3;
          cone.material.opacity = 0.055 + p * 0.3;
          fluidMat.emissiveIntensity = 0.7 + p * 1.4;
          bulb.userData.set(0xff8420, 1 + p * 3);
        },
        fire() { piston.position.y = 1.5; cone.material.opacity = 0.55; },
        charge(f) {
          // Tank refills as it recharges: the fluid level *is* the cooldown bar.
          fluid.scale.y = 0.15 + f * 1.05;
          fluid.position.y = 1.5 + fluid.scale.y * 0.5;
          piston.position.y = 1.55 + f * 0.3;
          cone.material.opacity = 0.06 + f * 0.06;
          bulb.userData.set(f >= 1 ? 0x40ff90 : 0xff4030, 0.5 + f * 1.1);
        },
        setLevel(n) { cone.scale.z = 1 + (n - 1) * 0.3; fluidMat.color.setHex(n >= 3 ? 0xd8ff40 : 0x7aff3a); },
      };
      return g;
    },
    onTrigger(trap, game) {
      const dv = aimVec(trap);
      const w = trap.world;
      const len = trap.level >= 2 ? 3 : 2;
      const victims = [];
      const seen = new Set();
      for (let step = 0; step <= len; step++) {
        v1.set(w.x + dv.x * step * TILE, 1.0, w.z + dv.z * step * TILE);
        game.fx.dust(v1, 1.3, 9, [0.4, 0.95, 0.2]);
        for (const e of game.enemies.queryRadius(v1, TILE * 0.78)) {
          if (seen.has(e)) continue;
          seen.add(e);
          // The point of this trap: strip defences and leave a film that fire loves.
          e.armor = Math.max(0, (e.armor || 0) - (8 + trap.level * 4));
          if (e.shield) e.shield.hp = trap.level >= 3 ? 0 : Math.max(0, e.shield.hp - 160);
          const dealt = trapDamage(game, trap, e, {
            amount: 22 * power(trap), type: 'poison',
            source: { kind: 'trap', id: trap.def.id, trap }, position: w,
            statuses: [status('poison', 4, 9), status('vulnerable', 4, 0.25), status('oiled', 5, 1)],
          });
          game.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : 'poison');
          victims.push(e);
        }
      }
      trap.kills += victims.filter((e) => e.dead).length;
      return victims;
    },
  },

  // -------------------------------------------------------- arcane obelisk
  {
    id: 'arcane-obelisk', name: 'Arcane Obelisk', surface: 'floor',
    cost: 1500, cooldown: 1.2, unlockLevel: 9,
    tags: ['arcane', 'true-damage'],
    counters: ['fire-immune', 'frost-immune', 'armored', 'boss'],
    blurb: 'Pure arcane force. Nothing in the horde resists it. Nothing about it is cheap.',
    sense: { kind: 'tile', radius: TILE * 1.1, air: true },
    windup: 0.22,
    upgrade: { costs: [1200, 1950], notes: ['Wider pulse', 'Singularity: pulls them in first'] },
    build() {
      const g = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.25, 0.42, 8), M.darkStone);
      base.position.y = 0.21;
      g.add(base);
      const step2 = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.95, 0.3, 8), M.stone);
      step2.position.y = 0.55;
      g.add(step2);
      const band = runeBand(0.98, 8, 0x9b5cff);
      band.position.y = 0.34;
      g.add(band);

      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.42, 2.6, 6), M.stone);
      shaft.position.y = 2.0;
      g.add(shaft);
      const coreMat = lamp(0x9b5cff, 1.5);
      const core = new THREE.Mesh(GEO.ico1, coreMat);
      core.scale.setScalar(0.62);
      core.position.y = 3.3;
      g.add(core);

      const shards = new THREE.Group();
      shards.position.y = 2.6;
      const shardMat = lamp(0xc090ff, 1.0);
      for (let i = 0; i < 3; i++) {
        const s = new THREE.Mesh(GEO.ico, shardMat);
        const a = (i / 3) * Math.PI * 2;
        s.position.set(Math.cos(a) * 1.15, Math.sin(a * 2) * 0.3, Math.sin(a) * 1.15);
        s.scale.set(0.24, 0.6, 0.24);
        shards.add(s);
      }
      g.add(shards);
      const light = new TrapLight(0x9b5cff, 3, 14, 2);
      light.position.y = 2.8;
      g.add(light);
      const field = ringMesh(TILE * 1.0, TILE * 1.08, 0x9b5cff, 0.08);
      g.add(field);

      g.userData.rig = {
        wind(p) {
          shards.scale.setScalar(1 - p * 0.55);
          coreMat.emissiveIntensity = 1.5 + p * 5;
          light.intensity = 3 + p * 10;
          field.material.opacity = 0.08 + p * 0.4;
        },
        fire() { shards.scale.setScalar(1.4); core.scale.setScalar(0.95); },
        charge(f) { field.material.opacity = 0.04 + f * 0.06; light.intensity = 1.5 + f * 2; },
        tick(dt, trap, game) {
          shards.rotation.y += dt * (1.2 + trap.level * 0.4);
          core.rotation.y += dt * 0.8;
          core.position.y = 3.3 + Math.sin(game.clock.elapsed * 2) * 0.12;
          shards.scale.setScalar(approach(shards.scale.x, 1, 4, dt));
          core.scale.setScalar(approach(core.scale.x, 0.62, 5, dt));
        },
        setLevel(n) { band.scale.setScalar(1 + (n - 1) * 0.1); shardMat.color.setHex(n >= 3 ? 0xffd0ff : 0xc090ff); },
      };
      return g;
    },
    onTrigger(trap, game) {
      // Singularity first: pull the pack into the pulse, then pulse. Reads as a *decision*.
      if (trap.level >= 3) {
        for (const e of game.enemies.queryRadius(trap.world, TILE * 2.2)) {
          if (e.has('unstoppable')) continue;
          const dx = trap.world.x - e.position.x, dz = trap.world.z - e.position.z;
          e.applyImpulse(dx * 3.2, 0, dz * 3.2);
        }
      }
      const v = hitCell(game, trap, {
        amount: 85, type: 'arcane', radius: TILE * (1.1 + (trap.level - 1) * 0.15), airborne: true,
        statuses: [status('vulnerable', 3, 0.2)],
      });
      game.fx.ring(trap.world, 2.3, [0.7, 0.4, 1], 34);
      return v;
    },
  },

  // --- guardians ------------------------------------------------------------
  {
    id: 'guardian-archer', name: 'Archer Guardian', surface: 'guardian',
    cap: 6,   // shared across all guardians; surfaced so the HUD can show 'N/6 placed'
    cost: 900, cooldown: 0.85, unlockLevel: 5,
    tags: ['ally', 'ranged', 'anti-air'],
    counters: ['flying'],
    blurb: 'Hired bow. Holds a lane on its own and shoots what flies. Orc archers shoot back.',
    upgrade: { costs: [700, 1150], notes: ['Longbow: +range, +damage', 'Fire arrows: ignites tar'] },
    guardian: {
      kind: 'archer', hp: 340, range: 16, damage: 30, type: 'physical',
      color: 0x3a6a3a, hitsAir: true, retreat: 4.5,
    },
  },
  {
    id: 'guardian-paladin', name: 'Paladin Guardian', surface: 'guardian',
    cap: 6,   // shared across all guardians; surfaced so the HUD can show 'N/6 placed'
    cost: 1300, cooldown: 1.3, unlockLevel: 6,
    tags: ['ally', 'melee', 'blocker'],
    counters: ['unstoppable'],
    blurb: 'A wall with a hammer. Physically holds the tile while it swings — they must go through him.',
    upgrade: { costs: [1000, 1650], notes: ['Heavier plate: +hp, +damage', 'Consecration: burns what it blocks'] },
    guardian: {
      kind: 'paladin', hp: 1500, range: 3.4, damage: 80, type: 'crush',
      color: 0xc0b070, blocker: true, blockRadius: 1.9,
    },
  },
  {
    id: 'guardian-hunter', name: 'Hunter Guardian', surface: 'guardian',
    cap: 6,   // shared across all guardians; surfaced so the HUD can show 'N/6 placed'
    cost: 1500, cooldown: 2.6, unlockLevel: 9,
    tags: ['ally', 'ranged', 'poison'],
    counters: ['armored', 'shielded'],
    blurb: 'Poisoned shot that pierces a whole rank and leaves them melting.',
    upgrade: { costs: [1200, 1950], notes: ['+1 pierce, faster draw', 'Toxin: leaves an oil film for your fire'] },
    guardian: {
      kind: 'hunter', hp: 440, range: 20, damage: 55, type: 'poison',
      color: 0x5a3a7a, hitsAir: true, pierce: 3, retreat: 6,
    },
  },
];

export const TRAP_BY_ID = new Map(TRAPS.map((t) => [t.id, t]));
export function getTrapDef(id) { return TRAP_BY_ID.get(id); }
export { DIR_TO_VEC };
