/**
 * Measurement harness for the campaign curve. Not part of the shipped game loop —
 * nothing imports it, it is loaded on demand from the console:
 *
 *   await import('/src/director/devHarness.js'); __BOT__.runAll()
 *
 * It exists because the difficulty curve has to be *measured*, not guessed. It plays
 * every level with a deterministic "competent build" bot (layered traps ranked by
 * flow-distance to the rift, spending exactly the coin the level actually grants) and
 * reports per-wave clear time, leaks, score and rift damage.
 *
 * The bot never fires the player's weapon, so every number here is a LOWER bound:
 * what the level does to a player who builds well and then stands still.
 */

import * as THREE from 'three';
import { applyDamage } from '../shared/Damage.js';
import { GeoAcc } from '../world/Props.js';
import { parBuildTime } from './Difficulty.js';

const B = {};

/**
 * Decor geometry is purely cosmetic, but a merge failure in it throws inside
 * `Level.build()` and takes the whole level down. While other modules are mid-edit that
 * would block every measurement, so the harness degrades it to an empty mesh instead.
 * Simulation only — reload the page to get the real decor back.
 */
B.tolerateDecor = function () {
  const P = GeoAcc.prototype;
  if (P.__harnessPatched) return;
  const orig = P.build;
  P.__harnessPatched = true;
  P.build = function () {
    try { const r = orig.call(this); if (r) return r; } catch { /* fall through */ }
    for (const p of this.parts) p.dispose?.();
    this.parts.length = 0;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(9), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(9), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(9), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(6), 2));
    g.computeBoundingSphere();
    return g;
  };
};

/**
 * A tab that never composites has a zero-size canvas at construction, so the camera
 * aspect is NaN and every downstream vector (aim, focus, audio pan) becomes NaN.
 * Re-derive them once before stepping.
 */
B.fixCam = function () {
  const G = window.__GAME__;
  if (!isFinite(G.camera.aspect)) G.engine.resize();
  G.rig.lookahead.set(0, 0, 0);
  G.rig.target.copy(G.player.position);
  G.rig.focus.copy(G.player.position);
  G.rig.update(1 / 60);
  G.camera.updateMatrixWorld();
  G.input.updateAim(G.camera, 0);
};

/**
 * `dbg.step()` restarts its clock from `performance.now()` on every call, so two
 * consecutive calls hand the engine a *negative* dt. Keep a monotonic cursor instead.
 */
B.step = function (n) {
  const g = window.__GAME__;
  let t = g.engine._last;
  for (let i = 0; i < n; i++) { t += 1000 / 60; g.engine._frame(t, g); }
};

/**
 * The kill corridor: the cells orcs actually walk over, found by following the flow
 * field from every spawn to the rift. Ranking every buildable cell by distance instead
 * spreads traps sideways across rooms where nothing ever steps on them — which models a
 * bad player, not a competent one.
 */
B.rank = function (game) {
  const grid = game.grid;
  const flow = grid.riftFlow();
  const seen = new Map();
  // Build only on the gates the *next* wave actually opens. Spreading the purse over
  // six doors when two are live is how the old bot lost level 10 in wave 1, and it is
  // information the player has too (see WaveDirector.preview().gates).
  const preview = game.director.preview();
  const live = preview?.gates?.length ? preview.gates : grid.spawns;
  const add = (gx, gz) => {
    const c = grid.cell(gx, gz);
    if (!c || !grid.isWalkable(gx, gz) || c.flags.has('no-build')) return;
    const d = flow.distAt(gx, gz);
    if (!isFinite(d) || d <= 0) return;
    if (!seen.has(c)) seen.set(c, d);
  };
  for (const sp of live) {
    let gx = sp.gx, gz = sp.gz, steps = 0;
    while (steps++ < grid.w * grid.h) {
      add(gx, gz);
      // One cell either side of the path too: wall/ceiling mounts and the width a horde
      // actually spreads to in a 3-wide hall.
      add(gx + 1, gz); add(gx - 1, gz); add(gx, gz + 1); add(gx, gz - 1);
      const dir = flow.dirAt(gx, gz, { x: 0, z: 0 });
      if (!dir.x && !dir.z) break;
      gx += Math.round(dir.x); gz += Math.round(dir.z);
      if (flow.distAt(gx, gz) <= 0) { add(gx, gz); break; }
    }
  }
  return [...seen.entries()].map(([c, d]) => ({ c, d })).sort((a, b) => a.d - b.d);
};

/**
 * Does `B.rank()` actually name the cells orcs walk over?
 *
 * This exists because a verified bug elsewhere in the project was "the `dist` gradient is
 * not the enemy route": walking the 8-neighbour minimum of `riftFlow().dist` by hand
 * produces a *different* path from the one orcs take, so traps laid along it never fire.
 * Every measured number in this module depends on the bot's traps being in the way, so
 * the claim has to be checked rather than believed.
 *
 * Three candidate routes are compared against ground truth — 40 real grunts released
 * from every gate and stepped to the rift, with each orc's occupancy weighted by dwell
 * time, so a cell an orc stands in for two seconds counts twice what one it clips counts:
 *
 *   covRank  the cells `B.rank()` would buy — the bot's actual build set
 *   covDir   a walk of `dirAt` (the field enemies steer by)
 *   covDist  a walk of the `dist` minimum (the broken method)
 *
 * `covRank` is the number that matters; the other two are the diagnosis.
 */
B.pathAudit = function (levels = [0, 3, 4, 6, 9]) {
  const g = window.__GAME__, d = window.dbg;
  B.tolerateDecor();
  g.audio.enabled = false;
  const NEI = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const out = [];
  for (const L of levels) {
    d.load(L); B.fixCam(); B.headless(true); B.installAutoPlayer(0);
    const grid = g.grid, flow = grid.riftFlow();
    // `rankAll`, not `rank`: the audit releases orcs from *every* gate, whereas `rank`
    // deliberately buys only on the gates the next wave opens. Comparing the two would
    // measure that policy rather than the route.
    const rank = new Set(B.rankAll(g).map((r) => `${r.c.gx},${r.c.gz}`));
    const distSet = new Set(), dirSet = new Set();
    for (const sp of grid.spawns) {
      let gx = sp.gx, gz = sp.gz;
      for (let s = 0; s < 2000; s++) {
        distSet.add(`${gx},${gz}`);
        let bd = flow.distAt(gx, gz), bx = 0, bz = 0;
        for (const [dx, dz] of NEI) {
          if (!grid.isWalkable(gx + dx, gz + dz)) continue;
          const nd = flow.distAt(gx + dx, gz + dz);
          if (nd < bd) { bd = nd; bx = dx; bz = dz; }
        }
        if (!bx && !bz) break;
        gx += bx; gz += bz;
        if (flow.distAt(gx, gz) <= 0) { distSet.add(`${gx},${gz}`); break; }
      }
      gx = sp.gx; gz = sp.gz;
      for (let s = 0; s < 2000; s++) {
        dirSet.add(`${gx},${gz}`);
        const dr = flow.dirAt(gx, gz, { x: 0, z: 0 });
        if (!dr.x && !dr.z) break;
        gx += Math.round(dr.x); gz += Math.round(dr.z);
        if (flow.distAt(gx, gz) <= 0) { dirSet.add(`${gx},${gz}`); break; }
      }
    }
    g.engine._last = performance.now();
    for (let i = 0; i < 40; i++) g.enemies.spawnAtMarker('orc-grunt', grid.spawns[i % grid.spawns.length]);
    const seen = new Map();
    for (let f = 0; f < 3600 && g.enemies.aliveCount() > 0; f += 10) {
      B.step(10);
      for (const e of g.enemies.list.items) {
        if (e.dead) continue;
        const k = `${Math.floor(e.position.x / 4)},${Math.floor(e.position.z / 4)}`;
        seen.set(k, (seen.get(k) || 0) + 1);
      }
    }
    const tot = [...seen.values()].reduce((a, b) => a + b, 0) || 1;
    const cov = (S) => { let hit = 0; for (const [k, v] of seen) if (S.has(k)) hit += v; return +(hit / tot).toFixed(3); };
    out.push({
      lv: L + 1, gates: grid.spawns.length, walked: seen.size, rankCells: rank.size,
      covRank: cov(rank), covDir: cov(dirSet), covDist: cov(distSet),
    });
    g.enemies.clear();
  }
  try { localStorage.setItem('director.pathAudit', JSON.stringify(out)); } catch { /* quota */ }
  return out;
};

/**
 * Buildable corridor length per live gate, per level. The economy is only meaningful
 * against this: coin you cannot physically place is not income. Reported as cells on the
 * route (the same set `B.rank` buys) divided by the gates that are ever live.
 */
B.geometry = function () {
  const g = window.__GAME__, d = window.dbg;
  B.tolerateDecor();
  g.audio.enabled = false;
  const out = [];
  for (let L = 0; L < 10; L++) {
    d.load(L); B.fixCam(); B.headless(true);
    const cells = B.rankAll(g);
    let floor = 0, wall = 0, ceil = 0;
    for (const { c } of cells) {
      const s = g.grid.surfaces(c.gx, c.gz);
      if (s.floor) floor++;
      if (s.wall.length) wall++;
      if (s.ceiling) ceil++;
    }
    const gates = g.grid.spawns.length;
    out.push({
      lv: L + 1, gates, cells: cells.length, floor, wall, ceil,
      slots: floor + wall + ceil, perGate: +((floor + wall + ceil) / gates).toFixed(1),
    });
  }
  try { localStorage.setItem('director.geometry', JSON.stringify(out)); } catch { /* quota */ }
  return out;
};

/** `rank()` over *every* gate rather than only the ones the next wave opens. */
B.rankAll = function (game) {
  const saved = game.director.preview;
  game.director.preview = () => null;
  try { return B.rank(game); } finally { game.director.preview = saved; }
};

/**
 * What a competent player actually buys. Not "the most expensive thing unlocked": the
 * backbone is cheap tar + spikes (tar doubles the value of everything else, spikes are
 * the best damage per coin in the game), with one premium tile mixed in every few
 * squares for the damage type the cheap traps cannot cover. Buying a wall of 900-coin
 * brimstone on a fire-immune level is a *bad* build, and modelling one would have made
 * the campaign look harder than it is.
 */
B.plan = function (avail) {
  const has = (id) => avail.indexOf(id) >= 0;
  const pick = (ids) => ids.filter(has);
  const premium = pick(['arcane-obelisk', 'grinder', 'ice-vent', 'brimstone'])[0];
  const floor = pick(['tar-pit', 'spike-floor', 'spike-floor']);
  if (premium) floor.push(premium);
  return {
    floor: floor.length ? floor : pick(['spike-floor']),
    ceil: pick(['ceiling-pounder', 'lightning-rod']),
    wall: pick(['arrow-wall', 'wall-blades', 'acid-sprayer']),
    guard: pick(['guardian-archer', 'guardian-paladin', 'guardian-hunter']),
  };
};

/**
 * Pinch the corridors before buying anything else.
 *
 * The barricade changes what a competent build *is*, so a bot that does not place them is
 * no longer modelling a competent player — it is modelling the game as it was before the
 * object existed. What a player actually does with them is narrow the hall: find the
 * cross-section of the route, brick all but one cell of it, and turn a three-wide
 * approach the horde spreads across into a single file that every trap on the tile hits.
 *
 * So that is what this does. Walk the route from each live gate; at each step measure the
 * walkable run perpendicular to the direction of travel; if it is wider than one cell,
 * brick it down to one. `TrapManager.canPlace` refuses anything that would leave a spawn
 * unable to reach the rift, so the route can be narrowed and never severed — the rule is
 * enforced by the object, not by this heuristic being careful.
 *
 * Pinches are placed from ~30% of the way along each lane rather than at the mouth: a
 * barricade at the gate just moves the fight, whereas one inside the killbox makes the
 * tiles you already own hit everything that walks.
 *
 * ── MEASURED, AND IT DOES NOT WORK ───────────────────────────────────────────
 *
 * A/B against the identical bot with barricades off and on:
 *
 *   lv  barricades  traps at the end  result
 *    5      0             17          lost, 11 leaks
 *    5      6             17          lost, 13 leaks   (worse)
 *    7      0             38          WON,   2 leaks, 10/15 rift
 *    7      5             20          lost, 10 leaks   (much worse)
 *
 * Narrowing a corridor is not what a barricade is for, and this heuristic proves it by
 * doing exactly that and nothing else. Five barricades on Frostwatch cost 3,500 coin —
 * eighteen traps — and bought a hall one cell narrower, which the horde simply queues
 * through. The object's actual value is *route authorship*: closing a lane so that six
 * gates deliver into two killboxes instead of six, which changes how many corridors you
 * have to stock rather than how wide one of them is. That is a different algorithm (search
 * over which lanes to merge, evaluated on the resulting shared-route length) and it is not
 * this one.
 *
 * So the published curve is still the no-barricade curve, and it is the right conservative
 * baseline: a player who authors the route well will find the campaign *easier* than these
 * numbers, never harder. Left in place, wired to `opts.funnel` and off by default, because
 * the negative result is worth keeping and the next attempt starts here.
 */
B.funnel = function (game, budget = Infinity) {
  const T = window.dbg;
  const grid = game.grid;
  const def = (game.traps.available || []).includes('barricade');
  if (!def) return 0;
  const preview = game.director.preview();
  const live = preview?.gates?.length ? preview.gates : grid.spawns;
  let placed = 0, spent = 0;
  for (const sp of live) {
    const flow = grid.riftFlow();
    // Walk the lane first so we know how long it is, then pinch the middle of it.
    const path = [];
    let gx = sp.gx, gz = sp.gz;
    for (let s = 0; s < grid.w * grid.h; s++) {
      path.push([gx, gz]);
      const d = flow.dirAt(gx, gz, { x: 0, z: 0 });
      if (!d.x && !d.z) break;
      gx += Math.round(d.x); gz += Math.round(d.z);
      if (flow.distAt(gx, gz) <= 0) break;
    }
    const from = Math.floor(path.length * 0.3), to = Math.floor(path.length * 0.75);
    for (let i = from; i < to && placed < 12 && spent < budget; i++) {
      const [cx, cz] = path[i];
      const nx = path[i + 1] ? path[i + 1][0] - cx : 1;
      const nz = path[i + 1] ? path[i + 1][1] - cz : 0;
      // Perpendicular to travel.
      const px = -nz, pz = nx;
      if (!px && !pz) continue;
      const run = [];
      for (let k = -2; k <= 2; k++) {
        const ax = cx + px * k, az = cz + pz * k;
        if (grid.isWalkable(ax, az)) run.push([ax, az]);
      }
      if (run.length < 2) continue;
      // Keep the cell the route actually uses; brick the rest of the cross-section.
      for (const [ax, az] of run) {
        if (ax === cx && az === cz) continue;
        if (placed >= 12 || spent >= budget) break;
        if (game.scoring.coin < 700) break;
        if (T.placeTrap('barricade', ax, az, 'S').ok) { placed++; spent += 700; }
      }
      i += 2;   // leave a gap between pinches so the horde has somewhere to bunch up
    }
  }
  return placed;
};

/** Spend down to `reserve`, layering wall + ceiling + floor from the rift outward. */
B.build = function (game, reserve = 0, opts = {}) {
  const T = window.dbg;
  // Shape the route before stocking it — a trap bought before the pinch is a trap bought
  // for a corridor that is about to change.
  if (opts.funnel) B.funnel(game, opts.funnelBudget);
  const p = B.plan(game.traps.available);
  const ranked = B.rank(game);
  let placed = 0, guards = 0, fi = 0, ci = 0, wi = 0;
  for (let pass = 0; pass < 3; pass++) {
    for (const { c } of ranked) {
      if (game.scoring.coin <= reserve) break;
      const s = game.grid.surfaces(c.gx, c.gz);
      if (p.guard.length && guards < 3 && pass === 0 && (placed % 7) === 3 && s.floor) {
        if (T.placeTrap(p.guard[guards % p.guard.length], c.gx, c.gz, 'S').ok) { guards++; placed++; continue; }
      }
      if (s.wall.length && p.wall.length && T.placeTrap(p.wall[wi % p.wall.length], c.gx, c.gz, s.wall[0]).ok) { wi++; placed++; }
      if (game.scoring.coin <= reserve) break;
      if (s.ceiling && p.ceil.length && T.placeTrap(p.ceil[ci % p.ceil.length], c.gx, c.gz, 'S').ok) { ci++; placed++; }
      if (game.scoring.coin <= reserve) break;
      if (s.floor && p.floor.length && T.placeTrap(p.floor[fi % p.floor.length], c.gx, c.gz, 'S').ok) { fi++; placed++; }
    }
  }

  // Upgrades, once the route is full.
  //
  // This is not a refinement, it is a correctness fix. Measured on The Forge: the bot
  // reached wave 5 with twenty-one traps and 2,418 coin, and then bought *nothing* for the
  // boss wave — not because it could not afford anything but because every placeable cell
  // on the live gates already had a trap on it. A player in that position upgrades, and a
  // bot that cannot systematically understates every late-level defence in the campaign.
  //
  // Upgrades go to the tiles nearest the rift first, which is where the throughput is
  // needed and where a trap that survives is worth most.
  const upgradable = game.traps.list
    .filter((t) => !t.destroyed && t.def.upgrade?.costs)
    .map((t) => ({ t, d: game.grid.riftFlow().distAt(t.gx, t.gz) }))
    .sort((a, b) => a.d - b.d);
  for (let pass = 0; pass < 2; pass++) {
    for (const { t } of upgradable) {
      if (game.scoring.coin <= reserve) break;
      if (game.traps.upgrade(t).ok) placed++;
    }
  }
  return placed;
};

/**
 * Line of sight, the same rule the real crossbow now obeys.
 *
 * ── ROUND 3 CORRECTION ───────────────────────────────────────────────────────
 * PLAYER's `hitscan()` had no geometry test at all: the crossbow shot through solid rock
 * for its full 30 m. That has been fixed there, but this stand-in never went through
 * `hitscan()` — it resolves damage directly with `applyDamage`, deliberately, so the
 * measurement does not depend on FX plumbing other agents are editing. Which means the
 * stand-in inherited the *bug's* behaviour and kept it after the fix: it was shooting
 * through walls in every number this file has ever published.
 *
 * So the march is mirrored here (Amanatides–Woo over the grid, `kind === 'wall'` stops
 * the ray, airborne targets are exempt because they are above the walls). Any run
 * measured before this is a trap-vs-player kill split that cannot be trusted.
 */
B.losClear = function (grid, origin, target) {
  if (target.airborne) return true;
  const TILE = 4;
  const dx = target.position.x - origin.x, dz = target.position.z - origin.z;
  const range = Math.hypot(dx, dz);
  if (range < 0.001) return true;
  const nx = dx / range, nz = dz / range;
  let gx = Math.floor(origin.x / TILE), gz = Math.floor(origin.z / TILE);
  const stepX = nx > 0 ? 1 : -1, stepZ = nz > 0 ? 1 : -1;
  const invX = nx !== 0 ? 1 / Math.abs(nx) : Infinity;
  const invZ = nz !== 0 ? 1 / Math.abs(nz) : Infinity;
  let tMaxX = nx !== 0 ? ((nx > 0 ? (gx + 1) * TILE - origin.x : origin.x - gx * TILE)) * invX : Infinity;
  let tMaxZ = nz !== 0 ? ((nz > 0 ? (gz + 1) * TILE - origin.z : origin.z - gz * TILE)) * invZ : Infinity;
  const tDeltaX = TILE * invX, tDeltaZ = TILE * invZ;
  let t = 0;
  for (let i = 0; i < 512 && t <= range; i++) {
    if (tMaxX < tMaxZ) { gx += stepX; t = tMaxX; tMaxX += tDeltaX; }
    else { gz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
    if (t > range) break;
    const c = grid.cell(gx, gz);
    if (!c || c.kind === 'wall') return false;
  }
  return true;
};

/**
 * A stand-in for the hero, using PLAYER's locked numbers: crossbow 38 physical every
 * 0.24s (158 dps, infinite, hits air) and the Lightning Ring at 72 with x0.80 per jump
 * over 7 links, on a 1s cooldown and 30 mana. Measuring with an idle player only ever
 * produces a lower bound, and the crossbow alone is a third of a good player's output.
 *
 * `skill` brackets the range: 0 = never fires, 1 = a frame-perfect aimbot. 0.6 is the
 * number the published curve uses — a competent player who holds the killbox, reacquires
 * targets with a beat of delay, and misses about a third of their shots. That produces a
 * ~75/25 trap-to-player kill split, which matches PLAYER's measured 77/23 for a hero who
 * holds their traps rather than pushing forward of them.
 *
 * Every shot is now line-of-sight gated (`B.losClear`). Before that, the stand-in could
 * delete a wave through a wall exactly as the shipped crossbow could.
 */
B.installAutoPlayer = function (skill = 0.6, range = 20) {
  const g = window.__GAME__;
  if (B._auto) g.engine.removeSystem(B._auto);
  if (skill <= 0) {
    // "No hero" has to mean *no hero*, not "a hero who does not shoot".
    //
    // The harness holds the player invulnerable so that survival stays a separate axis.
    // Combined with ORCS' aggro rework that is not a neutral bystander, it is an immortal
    // decoy: kobolds have `aggroChance 0.7` and a 32 m leash, so they peel off the rift to
    // chew on something that cannot die and never reach the crystal at all. Measured on
    // The Gatehouse, the standing decoy was worth six fewer leaks than an empty map — it
    // made the unattended run look *better* than it is. So the idle brackets park the
    // hero far outside the world and leave them there.
    B._auto = g.engine.addSystem({
      order: 15,
      update() {
        const p = g.player;
        if (!p) return;
        p.invulnerable = true;
        p.position.set(-9999, 0, -9999);
        p.velocity?.set?.(0, 0, 0);
      },
    });
    return;
  }
  let reacquire = 0, target = null, lastBolt = -99, crossbowCd = 0;
  B._auto = g.engine.addSystem({
    order: 15,
    update(dt) {
      if (g.state !== 'wave') return;
      const p = g.player;
      if (!p || p.dead) return;
      p.invulnerable = true;               // hero survival is a separate axis; hold it constant
      reacquire -= dt;
      if (!target || target.dead || reacquire <= 0) {
        // Engagement range, not weapon range. The crossbow reaches 30m, but a hero who
        // snipes the entire corridor from the rift kills everything before it touches a
        // trap — measured, that produced a 0/100 trap/player split, which is not how the
        // game is played. 20m is roughly what a cursor-aimed shot lands reliably at this
        // camera height, and it puts the hero inside their own killbox rather than
        // upstream of it.
        // Bosses first. A real player does not keep shooting grubs while the Orc King
        // walks past them, and modelling one that does made the finale look unwinnable.
        const los = (e) => B.losClear(g.grid, p.position, e);
        target = g.enemies.nearest(p.position, range + 12, (e) => e.has?.('boss') && los(e))
              || g.enemies.nearest(p.position, range, los);
        reacquire = 0.22;
      }
      if (!target || target.dead) return;
      // Re-check every frame, not just on reacquire: a target that walks behind a pillar
      // must break the shot, or the fix only holds for the instant of acquisition.
      if (!B.losClear(g.grid, p.position, target)) { target = null; return; }
      p.aimAngle = Math.atan2(target.position.x - p.position.x, target.position.z - p.position.z);
      // The Lightning Ring is the roster's armour answer and a competent player swaps to
      // it. Modelled on its own cooldown and mana cost rather than by swapping weapons,
      // so the measurement does not depend on PLAYER's input plumbing.
      if (p.mana >= 30 && g.clock.elapsed - lastBolt > 1.0 && (target.armor > 0 || target.shield)) {
        lastBolt = g.clock.elapsed;
        p.mana -= 30;
        let dmg = 72;
        const chained = new Set();
        let cur = target;
        for (let i = 0; i < 7 && cur; i++) {
          chained.add(cur);
          applyDamage(cur, {
            amount: dmg, type: 'lightning', position: p.position,
            source: { kind: 'player', id: 'lightning' },
          }, g);
          dmg *= 0.80;
          cur = g.enemies.nearest(cur.position, 7, (e) => !chained.has(e));
        }
        return;
      }

      if (crossbowCd > 0) { crossbowCd -= dt; return; }
      crossbowCd = 0.24;
      if (Math.random() > skill) return;  // a miss still costs the shot
      // Resolved through applyDamage rather than the weapon's own fire(), so the
      // measurement does not depend on the FX/projectile code other agents are editing.
      applyDamage(target, {
        amount: 38, type: 'physical', position: p.position,
        source: { kind: 'player', id: 'crossbow' },
      }, g);
    },
  });
};

/**
 * Strip the systems that cost wall-clock time and contribute nothing to a balance number:
 * particles, gore, decals, gib physics, coin homing, music polling, and the whole HUD.
 *
 * This matters more than it sounds. The dev server reloads the tab every time any agent
 * saves a file, and a full campaign measurement is thirty level runs; if a level takes
 * longer than the gap between two reloads, the campaign can never be measured at all. Lean
 * mode roughly halves the wall cost of a stepped run.
 *
 * Only *presentation* systems are removed. Enemies, traps, the director, the player stand
 * -in and the level itself all keep ticking, so every number the harness reports is
 * produced by the same simulation the player would get.
 */
B.lean = function (on) {
  const g = window.__GAME__;
  if (on) {
    if (B._lean) return;
    // Systems are identified by their update order (see Game's constructor): 50 is FX,
    // 90 is the HUD. Nothing else in the list is presentation-only.
    B._lean = g.engine._systems.filter((s) => s.order === 50 || s.order === 90);
    for (const s of B._lean) g.engine.removeSystem(s);
  } else if (B._lean) {
    for (const s of B._lean) g.engine.addSystem(s);
    B._lean = null;
  }
};

/** Rendering is ~90% of the wall cost of a stepped run and none of the simulation. */
B.headless = function (on) {
  const g = window.__GAME__;
  if (on) {
    if (!B._render) B._render = g.renderer.render.bind(g.renderer);
    g.renderer.render = () => {};
  } else if (B._render) {
    g.renderer.render = B._render;
    B._render = null;
  }
};

/**
 * Scale every coin payout by `mul` for the rest of the run.
 *
 * This is how the economy is measured rather than argued about: sweep `mul` per level and
 * find the smallest value at which the bot clears without leaking. That number *is* the
 * level's coin requirement, and the difference between it and 1.0 is exactly how far the
 * shipped economy is off. Patched on `Scoring.addCoin` rather than on the individual
 * payout sites so the starting purse, kill income and every bonus all move together.
 */
B._coinMul = function (mul) {
  const s = window.__GAME__.scoring;
  if (!s.__origAddCoin) s.__origAddCoin = s.addCoin.bind(s);
  if (mul === 1) { s.addCoin = s.__origAddCoin; return; }
  s.addCoin = (n, reason) => s.__origAddCoin(Math.round(n * mul), reason);
};

B.prepare = function (i, opts = {}) {
  const g = window.__GAME__, d = window.dbg;
  g.audio.enabled = false;
  // The harness holds the hero invulnerable on purpose (survival is a separate axis and
  // is held constant), but `dbg.god()` used to persist across `load()` and silently
  // invalidate runs. Assert the flag we actually intend, every run, and report it.
  d.god(false);
  if (opts.tolerateDecor !== false) B.tolerateDecor();
  d.load(i);
  B._coinMul(1);
  if (opts.coinMul && opts.coinMul !== 1) {
    // The opening purse is granted inside `load()`, so scale it by hand.
    const extra = Math.round(g.scoring.coin * (opts.coinMul - 1));
    if (extra) g.scoring.addCoin(extra, 'harness');
    B._coinMul(opts.coinMul);
  }
  // Opening purse only, income untouched — the two halves of the economy fail in
  // different ways and have to be swept separately. A level that collapses in wave 2 with
  // five traps on the board has an *opening* problem; one that collapses in wave 6 with
  // twenty has an income problem.
  if (opts.purse) g.scoring.addCoin(opts.purse, 'harness');
  B.fixCam();
  B.headless(opts.headless !== false);
  B.lean(opts.lean !== false);
  B.installAutoPlayer(opts.skill ?? 0.6, opts.range ?? 20);
  g.engine._last = performance.now();
  B.build(g, 0, opts);
  return {
    i, opts, def: d.LEVELS[i], rows: [], w: 0,
    t0: performance.now(), prev: { kills: 0, leaks: 0, score: 0 },
  };
};

/** Run exactly one wave of a prepared run. Returns false when the level is over. */
B.runWave = function (run) {
  const g = window.__GAME__;
  const maxFrames = run.opts.maxFrames || 10800;  // 180 s of sim, then call it a hang
  const waves = g.director.waveCount;
  // The dev server is shared: another agent calling `dbg.load()` in this tab swaps the map
  // out from under a run in flight, and the run happily keeps stepping — traps on the old
  // geometry, waves from the new level, every row well-formed and describing nothing.
  // Caught here rather than only at `finish` so a poisoned run costs one wave, not fifteen
  // seconds of wall clock, and can never reach the store.
  if (g.levelIndex !== run.i) { run.poisoned = g.levelIndex; return false; }
  if (run.w >= waves) return false;
  // `rebuild: false` means the opening build is the only build — no new tiles, no
  // upgrades, no repairs, for the whole level. See `BRACKETS.afk`.
  if (run.w > 0 && run.opts.rebuild !== false) B.build(g, 0, run.opts);
  // Burn build-phase time before starting. `early` is the fraction of the build phase
  // skipped: 0 = takes the full par time and earns no early-start bonus (this is the
  // run PAR is derived from), 1 = starts instantly and collects the whole bonus.
  const early = run.opts.early ?? 0;
  const idle = Math.max(0, parBuildTime(run.w) * (1 - early));
  if (idle > 0) B.step(Math.round(idle * 60));
  const traps = g.traps.list.length;
  const startElapsed = g.clock.elapsed;
  if (!g.director.startWave()) { run.rows.push({ w: run.w + 1, err: 'refused', st: g.state }); return false; }
  let frames = 0;
  while (g.director.running && frames < maxFrames
         && g.state !== 'defeat' && g.state !== 'victory') { B.step(60); frames += 60; }
  const hang = g.director.running && g.state === 'wave';
  const t = +(g.clock.elapsed - startElapsed).toFixed(1);
  let guard = 0;
  while (g.state === 'wave' && guard < 600) { B.step(20); guard += 20; }
  const s = g.scoring;
  run.rows.push({
    w: run.w + 1, boss: !!g.director.wave?.boss || undefined, traps, t,
    n: g.director.wave?.count ?? 0, hp: g.director.wave?.hp ?? 0,
    kills: s.kills - run.prev.kills, leaks: s.leaks - run.prev.leaks,
    score: s.score - run.prev.score, coin: s.coin, rift: g.level.rift.hp,
    alive: g.enemies.aliveCount(), culled: g.director.culled || undefined,
    hang: hang || undefined, st: g.state,
  });
  run.prev = { kills: s.kills, leaks: s.leaks, score: s.score };
  run.w++;
  return !(g.state === 'defeat' || g.state === 'victory') && run.w < waves;
};

B.finish = function (run) {
  const g = window.__GAME__;
  g.audio.enabled = true;
  B.headless(false);
  B.lean(false);
  B._coinMul(1);
  const s = g.scoring.summary();
  return {
    lv: run.i + 1, name: run.def.name, result: g.state,
    // Surfaced on every row: a balance number taken with the hero invulnerable *by the
    // debug switch* rather than by the harness is not the same measurement.
    god: !!window.dbg._god,
    rift: `${g.level.rift.hp}/${g.level.rift.max}`,
    score: s.score, skulls: s.skulls, axes: s.axes, limiter: s.limiter,
    par: s.par, parTime: s.parTime, time: s.time,
    r: { score: s.scoreRatio, rift: s.riftFrac, time: s.timeRatio },
    kills: s.kills, leaks: s.leaks, best: s.bestCombo,
    trapKills: s.trapKills, playerKills: s.playerKills,
    split: s.kills ? Math.round((s.trapKills / s.kills) * 100) : 0,
    bonus: s.bonusScore, coin: s.coin, culled: g.director.culled,
    plan: g.director.levelPlan ? (({ value, count, hp, gates, openingLanes }) =>
      ({ value, count, hp, gates, openingLanes }))(g.scoring.plan || {}) : null,
    ms: Math.round(performance.now() - run.t0), rows: run.rows,
  };
};

/**
 * The two bracketing runs the score axis is calibrated against, per level.
 *
 * IDLE    no hero at all. Must end in `defeat` on every level — see the note on the entry.
 * FLOOR   60% accuracy, no early starts, spends the whole build phase. A player who
 *         builds a real defence and then plays adequately. Lands around 1.05-1.45x par.
 * STRONG  95% accuracy, 26m engagement, waves started at once. Lands around 1.25-1.65x.
 * PERFECT the ceiling, and the run par is anchored to. Lands on `PAR_AT_PERFECT` (1.62)
 *         by construction, because `Difficulty.PERFECT_SCORE_MULT` is *this bracket's*
 *         measured `score / plan.value`, per level.
 *
 * So the check on the calibration is now a single line: run `perfect` and confirm each
 * level reports `r.score` near 1.62 and `skulls: 5`. If it does not, `PERFECT_SCORE_MULT`
 * in `Difficulty.js` is stale — most likely because a wave table moved under it.
 */
B.BRACKETS = {
  /**
   * No hero at all — but the *defence* keeps every advantage: it re-spends the full purse
   * between every wave, so anything an orc destroys is silently replaced and the row is
   * upgraded as income allows. That is deliberately generous, and it is the version the
   * rule is checked against: a level that defeats this bot defeats a genuinely idle
   * player by a wide margin, whereas the converse does not follow.
   *
   * The distinction matters because it is exactly what made an unattended killbox look
   * invincible in the first place. ORCS measured The Black Throne holding waves 1-5 with
   * no hero *if the traps are rebuilt for free between waves*, and falling in wave 3 with
   * a fixed 62-trap build, because wave 2's archers destroy 27 of the 62. Free repairs,
   * not trap power, were most of the illusion.
   *
   * This must never reach `victory` on any level.
   */
  idle: { skill: 0, range: 0, early: 0 },
  /** The honest article: build once out of the opening purse, then touch nothing, ever. */
  afk: { skill: 0, range: 0, early: 0, rebuild: false },
  floor: { skill: 0.6, range: 20, early: 0 },
  solid: { skill: 0.8, range: 22, early: 0.35 },
  strong: { skill: 0.95, range: 26, early: 1 },
  /**
   * The run the critic actually played on The Black Throne: money no object, every tile
   * on the route stocked and upgraded, a hero who does not miss, waves started at once.
   * `coinMul: 6` reproduces the 400,000-coin end state the critic reported. This is the
   * ceiling the score axis is anchored against — five skulls has to be *reachable* here
   * and nowhere below it.
   */
  perfect: { skill: 1.0, range: 30, early: 1, coinMul: 6 },
};

/**
 * One runner at a time, ever.
 *
 * Two of these loops driving the same engine interleave their `d.load()` calls, so run A
 * steps run B's level and both write their rows to the same store. Silently: every row
 * still looks well-formed, it is simply describing a different level from the one its key
 * says. That produced a table where level 3 reported a 25-point rift and level 10's par
 * time, and it is the kind of corruption that survives review because nothing throws.
 *
 * The guard is a token rather than a boolean because the tab reloads constantly (other
 * agents saving files trigger Vite HMR mid-run), so "is a run in flight" has to be
 * answerable after the page that started it is gone.
 */
B._claim = function (name) {
  // On `window`, deliberately: re-importing this module with a cache-busting query gives a
  // fresh module object, so a token held on `B` would not see the loop the *previous*
  // import is still running. The window survives re-imports and dies with the reload,
  // which is exactly the lifetime the claim needs.
  const held = window.__BOT_BUSY__;
  if (held && !held.done) return null;
  const token = { name, done: false, t0: Date.now() };
  window.__BOT_BUSY__ = token;
  return token;
};

/**
 * Re-arm the run described by `sessionStorage['director.autorun']` — `{ from, to, tags }`.
 *
 * The dev server is shared, so Vite full-reloads the tab every few seconds while the other
 * module owners work, and a campaign measurement is forty stepped level runs that cannot
 * survive that by hand. `calibrate` already resumes from its store; this is the one line
 * that has to run *after* the reload to restart it, so paste it into the console after
 * each one, or re-arm it from a `pageshow` listener while you are measuring:
 *
 *   sessionStorage.setItem('director.autorun', JSON.stringify({ from: 0, to: 9, tags: ['floor'] }));
 *   await import('/src/director/devHarness.js'); __BOT__.resume();
 *
 * `sessionStorage` rather than `localStorage` deliberately: the flag must not leak into
 * the other agents' tabs on the same origin, where it would turn their build into a bot
 * that loads levels and steps the clock under them.
 */
B.resume = function () {
  let spec = null;
  try { spec = JSON.parse(sessionStorage.getItem('director.autorun') || 'null'); } catch { /* bad json */ }
  if (!spec) return 'off';
  // Never clear the claim token here, however stale it looks.
  //
  // This was the bug that produced every corrupted row in the round-3 measurements. The
  // hook fires on any HMR re-evaluation of `WaveDirector.js`, not only on a true reload,
  // and re-importing this module hands back a *fresh* `B` while the previous import's
  // loop is still stepping the engine. Clearing the token then let both loops call
  // `d.load()` — run A stepping run B's level, every row well-formed and describing a
  // level it was not measured on. `_claim` is the whole defence; a page that really did
  // reload has no token to begin with.
  return B.calibrate(spec.from ?? 0, spec.to ?? 9, spec.tags ?? ['floor']);
};

B.calibrate = function (from = 0, to = 9, tags = ['floor', 'solid', 'strong']) {
  const token = B._claim('calibrate');
  if (!token) return `busy: ${window.__BOT_BUSY__.name} since ${((Date.now() - window.__BOT_BUSY__.t0) / 1000) | 0}s`;
  const store = () => { try { return JSON.parse(localStorage.getItem('director.calibrate') || '{}'); } catch { return {}; } };
  const res = { done: false, at: null, rows: [], error: null };
  window.__CAL__ = res;
  const yieldToHost = () => new Promise((r) => setTimeout(r, 0));
  (async () => {
    try {
      for (let i = from; i <= to; i++) {
        const saved = store();
        const row = saved[i] && saved[i].__v === 3 ? saved[i] : { lv: i + 1, __v: 3 };
        const queue = [...tags], retries = {};
        for (const tag of queue) {
          if (row[tag]) continue;   // resume across the Vite reloads other agents trigger
          const run = B.prepare(i, B.BRACKETS[tag]);
          let more = true;
          while (more) { more = B.runWave(run); res.at = { lv: i + 1, tag, wave: run.w }; await yieldToHost(); }
          const out = B.finish(run);
          // A row is only trustworthy if the run reached a terminal state on the level it
          // claims. A reload mid-run leaves a partial row that looks perfectly valid.
          if ((out.result !== 'victory' && out.result !== 'defeat')
              || run.poisoned !== undefined || window.__GAME__.levelIndex !== i) {
            (res.skipped ||= []).push({
              lv: i + 1, tag, state: out.result, at: window.__GAME__.levelIndex,
              poisoned: run.poisoned, waves: out.rows.length,
              hang: out.rows.some((r) => r.hang) || undefined,
              last: out.rows.at(-1),
            });
            // Retry, but bounded: if whoever is driving the tab never stops, an unbounded
            // re-queue is an infinite loop rather than a measurement.
            retries[tag] = (retries[tag] || 0) + 1;
            if (retries[tag] <= 2) queue.push(tag);
            continue;
          }
          row[tag] = {
            result: out.result, skulls: out.skulls, axes: out.axes, limiter: out.limiter,
            r: out.r, score: out.score, par: out.par, bonus: out.bonus, leaks: out.leaks,
            rift: out.rift, time: out.time, parTime: out.parTime, coin: out.coin, god: out.god,
            value: out.plan?.value ?? null,
            mult: out.plan?.value ? +(out.score / out.plan.value).toFixed(2) : null,
            // Actual vs predicted clear time, per wave — the fit `_estimateParTime` needs.
            wt: out.rows.map((r) => r.t),
            pt: (window.__GAME__.scoring.plan?.times) || [],
            // Per-wave rift and leaks. A level's *shape* is not visible in its final rift:
            // 5/20 could be five bad waves or one, and those are opposite problems. Round 2
            // trimmed The Forge's boss wave on exactly this evidence and had to reconstruct
            // it from raw rows every time, so it is stored now.
            rf: out.rows.map((r) => r.rift),
            lk: out.rows.map((r) => r.leaks),
            tr: out.rows.map((r) => r.traps),
            cn: out.rows.map((r) => r.coin),
          };
          const s = store(); s[i] = row;
          try { localStorage.setItem('director.calibrate', JSON.stringify(s)); } catch { /* quota */ }
        }
        res.rows.push(row);
      }
    } catch (e) { res.error = String((e && e.stack) || e); }
    res.done = true;
    token.done = true;
  })();
  return 'started';
};

/**
 * How much *opening* purse each level actually needs.
 *
 * Sweeps a flat top-up on top of `startCoin` and reports the smallest rung at which the
 * floor bot clears the level, and the smallest at which it clears without losing a rift
 * point. That pair is the level's real opening requirement, and the gap between it and
 * `startCoin` is how far the shipped economy is off — measured rather than reasoned about.
 */
B.purseSweep = function (levels = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], ladder = [0, 800, 1600, 2600, 3800, 5400, 7500]) {
  const token = B._claim('purseSweep');
  if (!token) return `busy: ${window.__BOT_BUSY__.name} since ${((Date.now() - window.__BOT_BUSY__.t0) / 1000) | 0}s`;
  const store = () => { try { return JSON.parse(localStorage.getItem('director.purse') || '{}'); } catch { return {}; } };
  const res = { done: false, at: null, error: null };
  window.__PURSE__ = res;
  const yieldToHost = () => new Promise((r) => setTimeout(r, 0));
  (async () => {
    try {
      for (const i of levels) {
        const s0 = store();
        if (s0[i]?.done) continue;
        const row = s0[i] || { lv: i + 1, tried: [], done: false };
        for (const purse of ladder) {
          if (row.tried.some((t) => t.purse === purse)) continue;
          const run = B.prepare(i, { ...B.BRACKETS.floor, purse });
          const start = window.__GAME__.scoring.coin;
          let more = true;
          while (more) { more = B.runWave(run); res.at = { lv: i + 1, purse, wave: run.w }; await yieldToHost(); }
          const out = B.finish(run);
          if (window.__GAME__.levelIndex !== i
              || (out.result !== 'victory' && out.result !== 'defeat')) continue;
          row.tried.push({ purse, start, result: out.result, leaks: out.leaks, rift: out.rift, traps: out.rows[0]?.traps ?? 0 });
          if (out.result === 'victory' && row.win === undefined) row.win = purse;
          if (out.result === 'victory' && out.leaks === 0) { row.clean = purse; row.done = true; }
          const s = store(); s[i] = row;
          try { localStorage.setItem('director.purse', JSON.stringify(s)); } catch { /* quota */ }
          if (row.done) break;
        }
        row.done = true;
        const s = store(); s[i] = row;
        try { localStorage.setItem('director.purse', JSON.stringify(s)); } catch { /* quota */ }
      }
    } catch (e) { res.error = String((e && e.stack) || e); }
    res.done = true;
    token.done = true;
  })();
  return 'started';
};

/** Compact view of whatever `calibrate` has managed to finish. */
B.calTable = function () {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('director.calibrate') || '{}'); } catch { /* none */ }
  return Object.keys(s).sort((a, b) => a - b).map((k) => {
    const r = s[k]; const o = { lv: r.lv };
    for (const t of ['floor', 'solid', 'strong']) {
      const x = r[t]; if (!x) continue;
      o[t] = `${x.result === 'victory' ? 'W' : 'L'} ${x.skulls}sk s${x.r.score} r${x.r.rift} t${x.r.time} m${x.mult} lk${x.leaks} [${x.limiter || '-'}]`;
    }
    return o;
  });
};

/**
 * Minimum coin multiplier at which a level clears without losing a rift point, per level.
 * Coarse ladder rather than a bisection: each rung is a full level run, and the answer
 * only needs to be good to ~15% for the economy to be re-derived from it.
 */
B.coinSweep = function (from = 0, to = 9, ladder = [0.7, 1.0, 1.3, 1.7, 2.2, 3.0]) {
  const token = B._claim('coinSweep');
  if (!token) return `busy: ${window.__BOT_BUSY__.name} since ${((Date.now() - window.__BOT_BUSY__.t0) / 1000) | 0}s`;
  const res = { done: false, at: null, rows: [], error: null };
  window.__SWEEP__ = res;
  const yieldToHost = () => new Promise((r) => setTimeout(r, 0));
  (async () => {
    try {
      for (let i = from; i <= to; i++) {
        const row = { lv: i + 1, tried: [] };
        for (const mul of ladder) {
          const run = B.prepare(i, { skill: 0.6, range: 20, early: 0, coinMul: mul });
          let more = true;
          while (more) { more = B.runWave(run); res.at = { lv: i + 1, mul, wave: run.w }; await yieldToHost(); }
          const out = B.finish(run);
          if (window.__GAME__.levelIndex !== i) continue;
          row.tried.push({ mul, result: out.result, leaks: out.leaks, rift: out.rift, traps: out.rows.at(-1)?.traps ?? 0 });
          if (out.result === 'victory' && out.leaks === 0) { row.clean = mul; break; }
          if (out.result === 'victory' && row.win === undefined) row.win = mul;
        }
        res.rows.push(row);
        try { localStorage.setItem('director.coinSweep', JSON.stringify(res.rows)); } catch { /* quota */ }
      }
    } catch (e) { res.error = String((e && e.stack) || e); }
    res.done = true;
    token.done = true;
  })();
  return 'started';
};

B.runLevel = function (i, opts = {}) {
  const run = B.prepare(i, opts);
  while (B.runWave(run));
  const out = B.finish(run);
  // Persist here too: the dev server reloads whenever any agent saves a file, and a
  // 30-second level run that is not written down never happened.
  try {
    const s = B.saved();
    s[i] = out;
    localStorage.setItem(STORE, JSON.stringify(s));
  } catch { /* quota */ }
  return out;
};

B.runAll = function (from = 0, to = 9, opts) {
  const out = [];
  for (let i = from; i <= to; i++) out.push(B.runLevel(i, opts));
  return out;
};

/**
 * Fire-and-forget campaign run. A full level can block the tab for a minute, which is
 * longer than a console round-trip survives, so results land in `window.__RES__` and
 * are polled instead of returned.
 */
const STORE = 'director.curve';
B.saved = () => { try { return JSON.parse(localStorage.getItem(STORE) || '{}'); } catch { return {}; } };
B.clearSaved = () => localStorage.removeItem(STORE);

/**
 * Resumable campaign run. Other agents editing their own files triggers a Vite reload
 * that kills the tab mid-run, so results are keyed by level in localStorage and
 * anything already measured is skipped. Re-invoke after a reload to make progress.
 */
B.runCampaign = function (opts = {}) {
  const store = B.saved();
  const todo = [];
  for (let i = 0; i <= 9; i++) if (!store[i] || opts.force) todo.push(i);
  if (!todo.length) return 'complete';
  const res = { done: false, at: null, levels: [], error: null, todo };
  window.__RES__ = res;
  const yieldToHost = () => new Promise((r) => setTimeout(r, 0));
  (async () => {
    try {
      for (const i of todo) {
        await yieldToHost();
        const run = B.prepare(i, opts);
        let more = true;
        while (more) {
          more = B.runWave(run);
          res.at = { lv: i + 1, wave: run.w };
          await yieldToHost();
        }
        const out = B.finish(run);
        res.levels.push(out);
        const s = B.saved();
        s[i] = out;
        try { localStorage.setItem(STORE, JSON.stringify(s)); } catch { /* quota */ }
      }
    } catch (e) {
      res.error = String((e && e.stack) || e);
    }
    res.done = true;
  })();
  return 'started ' + todo.join(',');
};

B.runAllAsync = function (from = 0, to = 9, opts = {}) {
  const res = { done: false, from, to, at: null, levels: [], error: null };
  window.__RES__ = res;
  // Yield after every *wave*: a level is minutes of blocking work, and a console
  // round-trip has to be able to land in between or the run is unobservable.
  const yieldToHost = () => new Promise((r) => setTimeout(r, 0));
  (async () => {
    try {
      for (let i = from; i <= to; i++) {
        await yieldToHost();
        const run = B.prepare(i, opts);
        let more = true;
        while (more) {
          more = B.runWave(run);
          res.at = { lv: i + 1, wave: run.w };
          await yieldToHost();
        }
        res.levels.push(B.finish(run));
        try { localStorage.setItem('director.curve', JSON.stringify(res.levels)); } catch { /* quota */ }
      }
    } catch (e) {
      res.error = String((e && e.stack) || e);
    }
    res.done = true;
  })();
  return 'started';
};

/** Compact one-line-per-wave table for the report. */
B.table = function (levels) {
  if (!levels) {
    const s = B.saved();
    levels = Object.keys(s).sort((a, b) => a - b).map((k) => s[k]);
  }
  return levels.map((l) => ({
    lv: l.lv, result: l.result, rift: l.rift, score: l.score, skulls: l.skulls,
    par: l.par, kills: l.kills, leaks: l.leaks, split: l.split, culled: l.culled,
    s: Math.round(l.ms / 1000),
    w: l.rows.map((r) => [r.w, r.n, r.hp, r.t, r.kills, r.leaks, r.traps, r.rift, r.hang ? 'HANG' : '']),
  }));
};

/** Static read of the authored tables — total HP, spawn span, rift damage at risk. */
B.tableStats = function () {
  const d = window.dbg;
  return d.LEVELS.map((l, i) => {
    const waves = l.waves.map((w, wi) => {
      let n = 0, hp = 0, score = 0, coin = 0, span = 0, riftDmg = 0;
      for (const grp of w.groups) {
        const def = d.ROSTER.find((r) => r.id === grp.id);
        n += grp.count; hp += def.hp * grp.count; score += def.score * grp.count;
        coin += def.coin * grp.count; riftDmg += (def.damageToRift || 1) * grp.count;
        span = Math.max(span, (grp.delay || 0) + (grp.count - 1) * (grp.interval ?? 0.6));
      }
      return {
        w: wi + 1, boss: !!w.boss || undefined, n, hp, score, coin,
        span: +span.toFixed(1), hps: +(hp / Math.max(1, span)).toFixed(0), riftDmg,
      };
    });
    const sum = (k) => waves.reduce((a, b) => a + b[k], 0);
    return {
      lv: i + 1, name: l.name, riftHp: l.riftHp, startCoin: l.startCoin, par: l.par.score,
      totalN: sum('n'), totalHp: sum('hp'), baseScore: sum('score'), totalCoin: sum('coin'), waves,
    };
  });
};

window.__BOT__ = B;
export default B;
