import { applyDamage, status } from '../../shared/Damage.js';
import { clamp, damp } from '../../shared/rng.js';
import { v0, v1, v4, v5 } from '../../shared/scratch.js';
import { TILE } from '../../world/Grid.js';

/**
 * Shared enemy behaviours. Anything that more than one archetype does, or that is too
 * stateful to read inline in the roster, lives here.
 *
 * House rule: damage to *enemies* always goes through `applyDamage`. Damage to the player
 * goes through `player.takeDamage`, which is what owns their i-frames — the same
 * convention the rest of the game already uses.
 */

/* =============================== threat & sight =============================== */

/**
 * How many grounded orcs may be actively hunting the hero at once.
 *
 * This is the single most important number in the file, because it is what keeps
 * "the horde threatens you" from collapsing into "the horde forgets the rift". The
 * player's own i-frames (0.35s) already cap incoming damage at roughly one blow every
 * third of a second no matter how many orcs are swinging, so a *larger* number does not
 * make the game harder — it only makes contact more reliable, and it drains the wave
 * away from the thing it is supposed to be attacking. Eighteen is enough to surround a
 * stationary hero from every side in a heavy wave and still leave the bulk of a
 * hundred-orc push walking at the rift.
 *
 * Bosses are exempt: there is only ever one, and hunting you is its whole personality.
 */
export const MAX_HUNTERS = 18;

/**
 * Unobstructed straight line on the floor plane?
 *
 * Sampled every 0.45 of a tile, which cannot skip a wall (a wall is a whole tile) and
 * costs about a dozen array lookups at aggro range. Barricades set their cell to `wall`,
 * so a player standing behind one is genuinely out of sight — which is what makes the
 * blocker worth its 700 coin from the *hero's* side as well as the horde's.
 *
 * Both ends are excluded on purpose: an orc mid-shove can be a hair inside a wall cell,
 * and failing its own line of sight because of that reads as the AI randomly going blind.
 */
export function losClear(grid, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const dist = Math.hypot(dx, dz);
  if (dist < TILE * 0.5) return true;
  const steps = Math.min(48, Math.ceil(dist / (TILE * 0.45)));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (!grid.isWalkable(Math.floor((ax + dx * t) / TILE), Math.floor((az + dz * t) / TILE))) return false;
  }
  return true;
}

/** Squared horizontal distance from `e` to the hero. Infinity if there is no hero. */
export function heroDist2(e, game) {
  const p = game.player;
  if (!p || p.dead) return Infinity;
  const dx = p.position.x - e.position.x, dz = p.position.z - e.position.z;
  return dx * dx + dz * dz;
}

/* ============================ crowd-facing helpers ============================ */

/** Shove every nearby orc out of the way. Bosses part their own horde. */
export function partTheCrowd(e, game, radius = 4, force = 20) {
  for (const o of game.enemies.queryNear(e.position, radius)) {
    if (o === e || o.dead || o.mass > e.mass * 0.6) continue;
    const dx = o.position.x - e.position.x, dz = o.position.z - e.position.z;
    const d = Math.hypot(dx, dz) || 1;
    o.applyImpulse((dx / d) * force, 2.5, (dz / d) * force);
  }
}

export function summon(e, game, id, count, radius = 3.2) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + game.clock.elapsed;
    game.enemies.spawn(id,
      e.position.x + Math.cos(a) * radius,
      e.position.z + Math.sin(a) * radius,
      { summoned: true });
  }
  game.fx.ring(e.position, radius, [1, 0.2, 0.5], 34);
}

export function shieldAllies(e, game, amount, radius, absorb = 0.8) {
  let n = 0;
  for (const o of game.enemies.queryNear(e.position, radius)) {
    if (o === e || o.dead) continue;
    o.shield = o.shield || { hp: 0, absorb, arcCos: -1, max: amount };
    o.shield.max = Math.max(o.shield.max, amount);
    o.shield.hp = Math.max(o.shield.hp, amount);
    if (++n > 30) break;
  }
  if (n) game.fx.ring(e.position, radius * 0.6, [0.55, 0.45, 1], 44);
  return n;
}

/* ------------------------------- ground slam ------------------------------- */

/**
 * Structural damage a ground slam does to whatever is standing on the tile it lands on.
 *
 * 300 is not a free number: it is `TrapManager.WRECK`, the value TRAPS balanced trap
 * durability against ("a level 1 trap at 240 hp still evaporates under one slam — the
 * Ogre keeps its identity — while a level 2 at 324 or a level 3 at 437 walks away from
 * it"). Keeping the two equal is what makes the upgrade track mean *survivability* and
 * not just damage, so a chewed front row can be answered by upgrading it as well as by
 * building deeper.
 *
 * This replaces `game.traps.destroy()`, which the slam used to call on every floor trap
 * in a 3×3 — instantly, free, every six seconds, straight past the `hp` field. Measured
 * consequence: 4,400 coin of floor traps deleted for **0 damage dealt**, which is why the
 * Ogre appeared to have exactly one legal answer in the whole game. It was not resistant
 * to floor traps; it was deleting them.
 */
export const SLAM_WRECK = 300;

/** How long the ogre rears back before a wrecking slam lands. */
export const SLAM_WIND = 0.85;

/**
 * Radius, in world units, of a wrecking slam. 5.2 = 1.3 tiles, chosen so that the four
 * orthogonal neighbours (4.0 away) are inside and the diagonals (5.66) are not: the blast
 * is a plus, not a 3×3 block, and the ring FX is drawn at exactly this number from exactly
 * the impact point. What you see is what breaks — the old version drew a 5-unit ring and
 * then hit a square whose corners reached 5.66.
 */
export const SLAM_RADIUS = 5.2;

/**
 * Every structure a slam centred on `pos` would touch, with its normalised distance.
 *
 * Shared by the telegraph and the hit on purpose: the warning ring, the pips on the
 * doomed traps and the damage roll all walk the same set, so they can never disagree
 * about what is inside the blast.
 */
export function forEachStructure(game, pos, radius, fn) {
  const grid = game.grid;
  const c = grid.cellAtWorld(pos);
  if (!c) return 0;
  const r = Math.ceil(radius / TILE);
  let n = 0;
  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const cc = grid.cell(c.gx + dx, c.gz + dz);
      if (!cc) continue;
      // A barricade sets its cell to `wall`, so it can never also hold a floor trap.
      const t = cc.floorTrap || cc.blocker;
      if (!t || t.destroyed) continue;
      const w = grid.toWorld(cc.gx, cc.gz, v4);
      const d = Math.hypot(w.x - pos.x, w.z - pos.z);
      if (d > radius) continue;
      n++;
      // The tile it is *standing on* is the epicentre, whatever the sub-tile geometry
      // says. Without this the falloff is decided by where inside a tile the ogre's feet
      // happened to land, and "the trap you slammed dies" stops being true half the time.
      fn(t, w, dx === 0 && dz === 0 ? 0 : d / radius);
    }
  }
  return n;
}

const NOOP = () => {};

/**
 * Structural damage from an enemy to something in the traps module.
 *
 * Always `TrapManager.wreck` — that is the contract, and `destroy()` from out here means
 * "this is gone", not "an orc hit it". A lethal blow to a barricade is routed by
 * `destroy()` to `_barricadeCollapse`, so the crush and stun on whoever broke it happen
 * whether the last point of hp came from an orc or from anything else. (This used to clamp
 * blocker damage to `hp - 1` as a workaround from before that routing existed.)
 */
export function wreckTrap(game, t, amount, source) {
  if (amount <= 0 || !t || t.destroyed) return 0;
  const dealt = Math.min(amount, Math.max(0, t.hp));
  game.traps.wreck(t, amount, source);
  return dealt;   // what actually landed, so a floating number can never lie
}

/** How many traps/barricades a slam of this radius would touch. No allocation. */
export function structuresIn(game, pos, radius) {
  return forEachStructure(game, pos, radius, NOOP);
}

/**
 * A ground slam. Hurts the player, launches the crowd, and — when `wreck` is non-zero —
 * puts real structural damage into every trap and barricade under the ring.
 *
 * `wreck` defaults to 0. A slam is not automatically a demolition: the callers that
 * should break your defences say so with a number, and the ones that are just a shockwave
 * say nothing.
 *
 * Falloff is what makes *depth* an answer again, and the constant is picked so the ladder
 * lands exactly on trap durability. The impact tile takes the full 300 and a level 1 trap
 * (240 hp) dies. The nearest a *neighbouring* tile centre can ever be is 2.0 units — one
 * tile edge — which is k = 0.385, so at `1 - 0.6k` it takes at most 231 and survives.
 * One trap per slam, per six seconds, and you watched it happen.
 */
export function slam(e, game, radius, damage, wreck = 0) {
  const p = game.player;
  if (p && !p.dead && p.position.distanceToSquared(e.position) < radius * radius) {
    p.takeDamage(damage, e);
    const dx = p.position.x - e.position.x, dz = p.position.z - e.position.z;
    const d = Math.hypot(dx, dz) || 1;
    p.velocity.x += (dx / d) * 22; p.velocity.z += (dz / d) * 22;
  }
  partTheCrowd(e, game, radius, 26);

  if (wreck > 0) {
    // Structural damage goes through `TrapManager.wreck`, never `destroy`. `destroy`
    // means "this is gone"; only the trap's own hp gets to decide that.
    const src = { kind: 'enemy', id: e.id, enemy: e };
    forEachStructure(game, e.position, radius, (t, w, k) => {
      const dealt = wreckTrap(game, t, Math.round(wreck * (1 - 0.6 * k)), src);
      // The player watched a trap die for free for ten levels. Now they see the number.
      if (dealt > 0) game.fx.damageNumber(w, dealt, 'crush');
    });
  }

  game.fx.ring(e.position, radius, [1, 0.55, 0.2], 52);
  game.fx.shockwave(e.position, radius * 0.8, [0.55, 0.42, 0.3], 34);
  game.fx.dust(e.position, radius * 0.5, 22);
  game.fx.shake(0.7, 0.35);
  game.audio.play('trap.boom', { position: e.position, pitch: 0.55 });
}

/**
 * Commit to a slam `wind` seconds from now. The unit plants and rears back for the whole
 * wind-up; nothing is destroyed until it lands.
 */
export function beginSlam(e, game, radius, damage, wreck, wind = SLAM_WIND) {
  e.slamT = wind;
  e.slamWind = wind;
  e.slamR = radius;
  e.slamDamage = damage;
  e.slamWreck = wreck;
  e.slamMark = 99;          // fire the first pip on the very next frame
  e.state = 'attack';
  e.stateT = 0;
  game.audio.play('orc.growl', { position: e.position, pitch: 0.45, gain: 0.9 });
}

/**
 * Drive the wind-up. Returns true while the slam owns the frame.
 *
 * The tell is three things at once, because one of them alone is not readable in a
 * two-hundred-orc frame:
 *
 *  1. **the pose** — the rig's attack anticipation is *stretched* across the whole
 *     wind-up (`stateT` is driven to 42% of the swing, the frame the strike lands) so the
 *     ogre visibly rears back and holds instead of snapping through it in 0.4s;
 *  2. **the ring**, pulsing at exactly `slamR` from exactly where the ogre is standing —
 *     the shape that is about to be hit, not an approximation of it;
 *  3. **a pip on every trap inside the ring**, five times a second. This is the part that
 *     matters: the player does not have to judge a radius by eye, the doomed traps light
 *     up individually and they can count them.
 *
 * 0.85s is long enough to break line and reposition, and long enough for a burst to
 * matter — an Ogre at 900 hp is killable inside the tell by a fed killbox.
 */
export function slamWindup(e, game, dt) {
  if (!(e.slamT > 0)) return false;
  // Anything that takes an ogre off its feet takes the slam with it. `unstoppable` units
  // are immune to stun, so this is not a get-out for the Ogre itself — but it means the
  // ability is interruptible by design rather than by accident.
  if (e.statusMods.stunned || e.state === 'stagger') { e.slamT = 0; return false; }

  e.slamT -= dt;
  e.velocity.multiplyScalar(Math.pow(0.0004, dt));

  const anim = e.attackAnim || 0.9;
  const f = clamp(1 - e.slamT / e.slamWind, 0, 1);
  e.state = 'attack';
  e.stateT = anim * 0.42 * f;

  if (!e.culled) {
    if ((game.clock.frame & 3) === 0) {
      game.fx.ring(e.position, e.slamR, [1, 0.3 + 0.4 * f, 0.1], 14 + Math.round(20 * f));
    }
    // A floor-hugging ring that converges on the real radius. The airborne ring alone
    // gets lost in a crowd; this one is on the ground plane the blast is measured on.
    e.slamMark += dt;
    if (e.slamMark >= 0.22 - 0.13 * f) {     // and it speeds up as the swing comes down
      e.slamMark = 0;
      game.fx.shockwave(e.position, e.slamR * (0.45 + 0.55 * f), [0.95, 0.5, 0.16], 22);
      // Amber, deliberately not the pink-red the traps' own cooldown rings use: the
      // player has to be able to tell "this trap is arming" from "this trap is about to
      // be hit" at a glance, and they are the same tiles.
      forEachStructure(game, e.position, e.slamR, (t, w) => game.fx.ring(w, 1.3, [1, 0.78, 0.2], 12));
    }
  }

  if (e.slamT <= 0) {
    e.slamT = 0;
    slam(e, game, e.slamR, e.slamDamage, e.slamWreck);
    // Hand the rig back mid-strike so the follow-through plays out of the impact, and
    // stop the normal melee from swinging on the same beat.
    e.stateT = anim * 0.42;
    e.attackCd = Math.max(e.attackCd, e.attackRate * 0.9);
  }
  e._integrate(dt, game);
  return true;
}

/* ========================== siege: barricades ============================= */

/**
 * Barricade-breaking, as an *AI behaviour* rather than an aura.
 *
 * `TrapManager` already models incoming siege damage: anything standing next to a
 * barricade chews on it, sappers five times faster than a grunt. That is a fine model
 * for the orcs who happen to end up there — but it can only ever fire on orcs who
 * *arrive*, and orcs steer by the rift flow field, which routes them politely around
 * the wall. So the counter-unit for the game's one blocking object never actually walked
 * up to one unless the detour was enormous. TRAPS flagged exactly this: "a sapper will
 * bypass a low-detour wall rather than finish it. Real targeting would be better."
 *
 * This is the targeting. A sapper leaves the flow field, walks to the wall, plants, and
 * takes swings at it on its own attack rate. That is what makes the barricade a
 * *decision* — 700 coin buys you a shaped route until the sappers arrive — instead of a
 * permanent wall that the horde politely ignores.
 */

const NEIGH = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** How far a sapper will leave its route to go and hit a wall, in tiles. */
export const SIEGE_SEEK = 4;

/**
 * Centre-to-centre distance at which a unit is pressed against the wall's face and can
 * swing. Body-relative, because it has to be: a wall face is two units from the tile
 * centre, so a sapper (r 0.55) physically cannot get closer than ~2.55 and an ogre
 * (r 1.15) cannot get closer than ~3.15. A flat number tuned on the sapper meant ogres
 * stood a hair outside their own reach and never landed a single swing.
 */
const siegeReach = (e) => TILE * 0.5 + e.radius + 0.55;

/**
 * Damage per swing against a blocker.
 *
 * Sized against a 1,400 hp level 1 barricade at one swing per `attackRate` second: a
 * lone sapper is a slow, visible problem, a pack is the answer the barricade is supposed
 * to have. See the note in the Sapper's roster entry for how this stacks with the damage
 * `TrapManager._barricadeIncoming` already applies to the same orc.
 */
export const SIEGE_SWING = 34;

/**
 * The blocker most worth walking to, or null.
 *
 * Two filters and a tie-break:
 *   - **it is not behind me.** A wall is only in your way while you are on the wrong side
 *     of it; nobody doubles back to punch something they already walked round. The near
 *     side of the wall is the cheapest route-distance among its walkable neighbours, and
 *     if my own route-distance is already shorter than that, the wall is history.
 *   - **it is within `SIEGE_SEEK` tiles.** A sapper diverts to a wall it can see itself
 *     walking into, not to one across the level.
 *   - **prefer the wall that is actually costing the horde something.** The spread between
 *     the cheapest and dearest walkable neighbour is how many tiles of detour the wall is
 *     buying the player, so it discounts distance. Unlike the grunts' rule this is only a
 *     preference: a sapper will still finish a low-detour wall, which is the whole point.
 */
export function findBlocker(e, game, tiles = SIEGE_SEEK) {
  const grid = game.grid;
  const c = grid.cellAtWorld(e.position);
  if (!c) return null;
  const flow = grid.riftFlow();
  const myD = flow.distAt(c.gx, c.gz);
  let best = null, bestScore = Infinity;

  for (let dz = -tiles; dz <= tiles; dz++) {
    for (let dx = -tiles; dx <= tiles; dx++) {
      const cc = grid.cell(c.gx + dx, c.gz + dz);
      const t = cc?.blocker;
      if (!t || t.destroyed) continue;

      let lo = Infinity, hi = -Infinity;
      for (const [ax, az] of NEIGH) {
        const d = flow.distAt(cc.gx + ax, cc.gz + az);
        if (!isFinite(d)) continue;
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      if (!isFinite(lo)) continue;                       // walled in on every side
      if (isFinite(myD) && myD < lo - 0.5) continue;     // already past it

      const detour = isFinite(hi) ? hi - lo : 0;
      const score = Math.hypot(dx, dz) - detour * 0.55;
      if (score < bestScore) { bestScore = score; best = t; }
    }
  }
  return best;
}

/**
 * Walk to `e.siegeTarget` and take it apart. Returns true while the siege owns the frame.
 *
 * The approach is hand-steered rather than flow-field steered — the flow field's whole
 * job is to route *around* this tile — but it keeps the crowd separation term, so a pack
 * of sappers queues along the wall instead of fusing into one orc.
 */
export function siegeBlocker(e, game, dt) {
  const grid = game.grid;
  e.siegeCheck = (e.siegeCheck ?? 0) - dt;
  let t = e.siegeTarget;
  if (t && (t.destroyed || grid.cell(t.gx, t.gz)?.blocker !== t)) t = e.siegeTarget = null;
  if (e.siegeCheck <= 0) {
    e.siegeCheck = 0.3 + ((e.__idx ?? 0) % 7) * 0.02;  // de-phased: 14 sappers never scan together
    t = e.siegeTarget = findBlocker(e, game);
  }
  if (!t) return false;

  const w = grid.toWorld(t.gx, t.gz, v5);
  const dx = w.x - e.position.x, dz = w.z - e.position.z;
  const dist = Math.hypot(dx, dz) || 1;
  // It is working, not wedged: don't let the anti-stuck nudge shove it off the wall.
  e._stuckT = 0;

  if (dist > siegeReach(e)) {
    let sx = 0, sz = 0;
    const near = game.enemies.queryNear(e.position, e.radius + 0.9);
    for (let i = 0; i < near.length && i < 8; i++) {
      const o = near[i];
      if (o === e || o.dead || o.airborne) continue;
      const ox = e.position.x - o.position.x, oz = e.position.z - o.position.z;
      const d2 = ox * ox + oz * oz, want = e.radius + o.radius;
      if (d2 > want * want || d2 < 1e-5) continue;
      const d = Math.sqrt(d2), push = (want - d) / want;
      sx += (ox / d) * push; sz += (oz / d) * push;
    }
    let vx = dx / dist + sx * 0.9, vz = dz / dist + sz * 0.9;
    const l = Math.hypot(vx, vz) || 1;
    const spd = e.speedBase * (e.statusMods.speed ?? 1) * (e.state === 'attack' ? 0.12 : 1);
    const accel = Math.exp(-(e.def.accel ?? 22));
    e.velocity.x = damp(e.velocity.x, (vx / l) * spd, accel, dt);
    e.velocity.z = damp(e.velocity.z, (vz / l) * spd, accel, dt);
  } else {
    // Planted. Square up and swing on the normal attack rate, so the wall comes apart at
    // a rhythm the player can hear and count rather than as a silent drain.
    e.velocity.multiplyScalar(Math.pow(0.001, dt));
    e.facing = Math.atan2(dx, dz);
    e.siegeCd = (e.siegeCd ?? 0) - dt;
    if (e.siegeCd <= 0) {
      e.siegeCd = e.attackRate;
      e.state = 'attack'; e.stateT = 0;
      e.siegeHit = e.attackAnim * 0.42;
      game.audio.play('orc.growl', { position: e.position, pitch: 1.25, gain: 0.35 });
    }
    if (e.siegeHit > 0 && (e.siegeHit -= dt) <= 0) {
      e.siegeHit = 0;
      // Through `wreck`, never `destroy` — the wall's hp is the only thing allowed to
      // decide that the wall is gone, and its own collapse is what finishes it.
      wreckTrap(game, t, SIEGE_SWING * (e.statusMods.damageDealt ?? 1),
        { kind: 'enemy', id: e.id, enemy: e });
      game.fx.hit(w, null, { count: 8, color: [0.35, 1, 0.75], speed: 6 });
    }
  }

  e._integrate(dt, game);
  return true;
}

/* ============================ boss scaffolding ============================ */

/**
 * Phase machine. Bosses are not "more HP" — each threshold changes what the fight *is*,
 * and every transition costs the boss a beat of invulnerable roaring so the player can
 * see the rules change before it hits them with the new ones.
 */
export function updatePhase(e, game, thresholds, onEnter) {
  if (e.phaseLock > 0) {
    e.phaseLock -= game.clock.dt;
    e.invulnerable = e.phaseLock > 0;
    if (e.phaseLock <= 0) e.invulnerable = false;
    return true;   // the roar owns the frame
  }
  const frac = e.hp / e.hpMax;
  let want = 0;
  for (let i = 0; i < thresholds.length; i++) if (frac <= thresholds[i]) want = i + 1;
  if (want === e.phase) return false;

  e.phase = want;
  e.phaseLock = 1.1;
  e.invulnerable = true;
  e.abilityCd = 0.6;
  e.state = 'attack'; e.stateT = 0;      // rears back for the roar
  game.fx.ring(e.position, 6, [1, 0.35, 0.1], 70);
  game.fx.shake(1.0, 0.6);
  game.fx.flash('#ffb060', 0.3, 0.3);
  game.engine.slowmo(0.45, 0.5);
  game.audio.play('horde', { position: e.position, pitch: 0.5 });
  game.ui.toast(`${e.def.name} — phase ${want + 1}`, 'error');
  onEnter?.(e, game, want);
  return true;
}

/**
 * Telegraphed charge: 0.7s of visible wind-up (it stops, it faces you, the ground rings),
 * then a fast straight run that flattens whatever it touches. Dodgeable on purpose.
 */
export function charge(e, game, dt) {
  const p = game.player;
  if (e.chargeT === undefined) e.chargeT = 0;

  if (e.chargeState === 'wind') {
    e.chargeT -= dt;
    e.velocity.multiplyScalar(Math.pow(0.001, dt));
    if (p) e.facing = Math.atan2(p.position.x - e.position.x, p.position.z - e.position.z);
    if ((game.clock.frame & 7) === 0) game.fx.ring(e.position, 1.6, [1, 0.3, 0.1], 12);
    if (e.chargeT <= 0) {
      e.chargeState = 'run';
      e.chargeT = 1.15;
      e.chargeDX = Math.sin(e.facing); e.chargeDZ = Math.cos(e.facing);
      game.audio.play('orc.growl', { position: e.position, pitch: 0.55 });
    }
    e._render(dt, game);
    return true;
  }

  if (e.chargeState === 'run') {
    e.chargeT -= dt;
    const spd = e.speedBase * 3.6;
    e.velocity.set(e.chargeDX * spd, 0, e.chargeDZ * spd);
    e._integrate(dt, game);
    game.fx.dust(e.position, 1.2, 3);
    partTheCrowd(e, game, e.radius + 2.2, 30);
    if (p && !p.dead && p.position.distanceToSquared(e.position) < 9 && e.chargeHit !== true) {
      e.chargeHit = true;
      p.takeDamage(e.attackDamage * 1.6, e);
      p.velocity.x += e.chargeDX * 30; p.velocity.z += e.chargeDZ * 30;
      game.fx.shake(0.8, 0.3);
    }
    if (e.chargeT <= 0) {
      e.chargeState = null;
      e.chargeHit = false;
      // The charge *is* the telegraph — 0.7s of wind-up plus a straight run you can see
      // coming across the room — so the terminal slam is allowed to wreck without a
      // second tell of its own.
      slam(e, game, 6, e.attackDamage * 0.8, SLAM_WRECK);
    }
    e._render(dt, game);
    return true;
  }
  return false;
}

export function beginCharge(e, wind = 0.7) {
  e.chargeState = 'wind';
  e.chargeT = wind;
  e.chargeHit = false;
}

/* ============================ ordinary abilities ============================ */

/** Shaman/warchanter support pulse. Returns how many allies it touched. */
export function pulse(e, game, radius, fn, colour, cap = 16) {
  let n = 0;
  for (const o of game.enemies.queryNear(e.position, radius)) {
    if (o === e || o.dead) continue;
    fn(o);
    if (++n >= cap) break;
  }
  if (n) game.fx.ring(e.position, radius * 0.5, colour, 30);
  return n;
}

/** Splitter payload: burst into children, with a poison puff so it reads as a *burst*. */
export function splitInto(e, game, id, count) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + Math.random();
    const child = game.enemies.spawn(id,
      e.position.x + Math.cos(a) * 1.1,
      e.position.z + Math.sin(a) * 1.1,
      { summoned: true });
    // Thrown outward by the burst rather than politely walking out of the corpse.
    child?.applyImpulse(Math.cos(a) * 9, 4, Math.sin(a) * 9);
  }
  game.fx.ring(e.position, 2.2, [0.55, 1, 0.25], 40);
  game.fx.dust(e.position, 1.6, 16, [0.4, 0.7, 0.2]);
  game.audio.play('gib', { position: e.position, pitch: 1.2 });
  const p = game.player;
  if (p && !p.dead && p.position.distanceToSquared(e.position) < 9) p.takeDamage(8, e);
}

const _aim = { x: 0, y: 0, z: 0 };

/**
 * What an archer should be shooting, in strict priority order.
 *
 * 1. **The hero**, whenever they are in range with a clear line. This is a reversal: the
 *    old rule preferred a guardian at 85% of the distance, which in practice meant a
 *    player who built any hired help at all was never shot at. "Ranged units should
 *    punish a stationary player" is not a preference the archer gets to weigh — it is
 *    what the archer is *for*, and the player is the only target that can shoot back.
 * 2. **A guardian.** Hired help is what actually stops the wave; killing it is real work.
 * 3. **A trap.** Only when there is no hero and no guardian to shoot — i.e. only when the
 *    defence is standing unattended. Twenty archers walking into a killbox nobody is
 *    home to defend will take it apart, which is the whole point: a wave that clears
 *    itself while the player is elsewhere is a wave that did not need a player.
 *
 * Every candidate needs line of sight. Arrows are stopped by walls in flight now, so
 * without this the archer would spend its cooldown firing into masonry.
 */
export function archerTarget(e, game, range) {
  const grid = game.grid;
  const r2 = range * range;
  const p = game.player;
  const see = (x, z) => losClear(grid, e.position.x, e.position.z, x, z);

  if (p && !p.dead && p.position.distanceToSquared(e.position) < r2
      && see(p.position.x, p.position.z)) {
    return { pos: p.position, vel: p.velocity, guardian: null, structure: null };
  }

  let guard = null, gd = r2, wreckable = null, wd = r2 * 0.6;
  for (const t of game.traps.list) {
    if (t.destroyed) continue;
    const d = t.world.distanceToSquared(e.position);
    if (t.def.guardian) {
      if (d < gd && see(t.world.x, t.world.z)) { gd = d; guard = t; }
    } else if (!guard && d < wd && t.hp > 0 && see(t.world.x, t.world.z)) {
      wd = d; wreckable = t;
    }
  }
  if (guard) return { pos: guard.world, vel: null, guardian: guard, structure: null };
  if (wreckable) return { pos: wreckable.world, vel: null, guardian: null, structure: wreckable };
  return null;
}

/**
 * Loose a single arrow, led onto a moving target.
 *
 * Without the lead an archer aims where the hero *was*, which at 9.4 units/second is
 * roughly three body-widths behind them: the shot is unmissable against a statue and
 * literally impossible to land on anything walking. Leading is what turns "stand still
 * and shoot" into a priced decision instead of a free one — a moving player still
 * dodges, a planted one gets hit.
 */
export function shootBest(e, game, range) {
  const t = archerTarget(e, game, range);
  if (!t) return false;
  const speed = 22;
  const dist = Math.hypot(t.pos.x - e.position.x, t.pos.z - e.position.z);
  _aim.x = t.pos.x; _aim.y = t.pos.y ?? 0; _aim.z = t.pos.z;
  if (t.vel) {
    const flight = dist / speed;
    _aim.x += t.vel.x * flight * 0.8;
    _aim.z += t.vel.z * flight * 0.8;
    // Scatter, growing with range. A perfectly-led arrow from fifteen metres is not a
    // threat, it is a tax: eight archers would take a stationary hero from full to dead
    // in ten seconds with nothing they could do about it but leave. The spread is 5% of
    // the distance, so point-blank is near-certain and the back of the pack is a
    // nuisance — and, crucially, a hero who is *moving* eats the lead error as well as
    // the spread, which is the difference the whole unit is supposed to teach.
    const s = dist * 0.05;
    const a = (game.rng ? game.rng() : Math.random()) * Math.PI * 2;
    _aim.x += Math.cos(a) * s;
    _aim.z += Math.sin(a) * s;
  }
  game.enemies.spawnProjectile(e, _aim, {
    damage: e.attackDamage, speed, color: 0xffd070,
    trap: t.guardian,
    // Structural hits go through `wreck`, same as every other enemy-to-trap path.
    //
    // 1.8x the flesh damage. The ladder was walked in both directions: at 1.0 the lever
    // never fired (ten archers took twelve seconds per level-1 trap, slower than the
    // killbox killed them), and at 2.5 it fired far too well — an unattended Black Throne
    // lost 12,000 points of masonry and the whole rift inside two waves. 1.8 leaves an
    // idle defence visibly losing ground without deleting it, and an attended one never
    // sees a single arrow, because an archer with a hero or a guardian in range shoots
    // that instead.
    structure: t.structure, wreck: t.structure ? e.attackDamage * 1.8 : 0,
  });
  game.audio.play('bow.shot', { position: e.position, pitch: 0.85 });
  return true;
}

export { status, applyDamage, clamp, v0, v1 };
