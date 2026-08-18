import * as THREE from 'three';
import { applyDamage, status } from '../../shared/Damage.js';
import { registerProjectile } from './projectiles.js';
import { clamp, angleDelta } from '../../shared/rng.js';

// Module-local scratch rather than shared/scratch.js: `origin` is itself a long-lived
// vector that survives the whole call, and weapon code nests several helpers deep, so
// borrowing the global v0/v1 here would let a helper stomp its own caller's origin.
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

/**
 * Four weapons, four jobs. The rule the roster forces on us:
 *
 *   armour       -> flat subtraction on physical/crush, so raw arrows fall off a cliff
 *   fire-immune  -> the staff is a dead weapon against Cinder Orcs
 *   flying       -> a ground-arcing fireball cannot reach a gargoyle
 *   unstoppable  -> knockback does nothing to ogres, trolls and bosses
 *
 * So each weapon is deliberately *bad* at something:
 *
 *   Crossbow     precision single target, infinite, the only always-available anti-air.
 *                Falls apart against plate (38 physical x0.55 resist, then -14 armour, is 7).
 *   Blunderbuss  a wall of buckshot in a 12m cone that shoves the whole front rank
 *                backwards — into your traps. Five shells, then a real reload.
 *   Staff        the pack answer: an arcing fireball with a burn. Ground only, and
 *                completely useless against fire-immune orcs.
 *   Lightning    ignores armour entirely (armour is physical/crush only), chains, and
 *                stuns. Expensive in mana, so it is a decision, not a spam button.
 *
 * Nothing here resolves over time except the fireball, which is a real pooled
 * projectile on the game clock (see projectiles.js). At this camera distance a slow
 * shot reads as sluggish, so hitscan carries the fast weapons and the *tracer* carries
 * the visual weight.
 */

// --- shared helpers ---------------------------------------------------------

/** Per-weapon damage multiplier from the upgrade tree; 1 when there is no progression. */
const mul = (player, id) => player.mods?.dmg?.[id] ?? 1;

/**
 * How far a ray travels from `origin` along (dx,dz) before a wall stops it.
 *
 * Amanatides–Woo grid march. This was missing entirely, and its absence was the single
 * most damaging bug in the game: hitscan consulted only enemy positions, never geometry,
 * so the crossbow shot **through solid walls** for its full 30-unit range. A player could
 * stand behind cover and delete a wave before it ever reached a trap — measured at 82
 * player kills to 0 trap kills on level 1, which is precisely why a reviewer called the
 * trap layer decorative. Line of sight is what makes the killbox load-bearing.
 */
function rayBlockedAt(grid, origin, dx, dz, range) {
  const TILE = 4;
  let gx = Math.floor(origin.x / TILE), gz = Math.floor(origin.z / TILE);
  const stepX = dx > 0 ? 1 : -1, stepZ = dz > 0 ? 1 : -1;
  const invX = dx !== 0 ? 1 / Math.abs(dx) : Infinity;
  const invZ = dz !== 0 ? 1 / Math.abs(dz) : Infinity;
  // Distance along the ray to the first cell boundary on each axis.
  let tMaxX = dx !== 0
    ? ((dx > 0 ? (gx + 1) * TILE - origin.x : origin.x - gx * TILE)) * invX : Infinity;
  let tMaxZ = dz !== 0
    ? ((dz > 0 ? (gz + 1) * TILE - origin.z : origin.z - gz * TILE)) * invZ : Infinity;
  const tDeltaX = TILE * invX, tDeltaZ = TILE * invZ;

  let t = 0;
  // Bounded so a degenerate direction can never spin: range/TILE cells plus slack.
  for (let i = 0; i < 512 && t <= range; i++) {
    if (tMaxX < tMaxZ) { gx += stepX; t = tMaxX; tMaxX += tDeltaX; }
    else { gz += stepZ; t = tMaxZ; tMaxZ += tDeltaZ; }
    if (t > range) break;
    const c = grid.cell(gx, gz);
    // Out of bounds and solid rock both stop a bolt. A barricade sets kind = 'wall',
    // so shooting your own wall is correctly blocked too.
    if (!c || c.kind === 'wall') return t;
  }
  return range;
}

/**
 * Instant ray along `angle`. Flyers are only candidates when the weapon says so —
 * see `airRange` (0 = never, Infinity = always).
 */
function hitscan(game, player, origin, angle, opts) {
  const {
    range, damage, type, pierce = 1, spread = 0, knockback = 0, crit = 0.12, critMul = 2.3,
    color = [0.5, 0.9, 1], statuses = null, source, airRange = 0, tracerWidth = 1, tracerLife = 0.09,
  } = opts;

  const a = angle + (game.rng() - 0.5) * spread;
  const dx = Math.sin(a), dz = Math.cos(a);
  const hits = _hitScratch;
  hits.length = 0;

  // Geometry stops the bolt before anything else is considered. Flyers are exempt: they
  // are above the walls, which is the whole point of them.
  const wallT = rayBlockedAt(game.grid, origin, dx, dz, range);

  for (const e of game.enemies.list) {
    if (e.dead) continue;
    // Project the enemy onto the ray; keep it if it is ahead and inside its radius.
    const ex = e.position.x - origin.x, ez = e.position.z - origin.z;
    const t = ex * dx + ez * dz;
    if (t < 0 || t > range) continue;
    if (!e.airborne && t > wallT) continue;
    if (e.airborne && t > airRange) continue;
    const px = ex - dx * t, pz = ez - dz * t;
    // Slightly generous: the cursor lives on the floor plane, so a flyer's real body is
    // never quite where you are pointing.
    const r = e.radius + (e.airborne ? 0.75 : 0.4);
    if (px * px + pz * pz > r * r) continue;
    hits.push(e, t);
  }

  // Insertion sort over the flat [enemy, t, ...] pairs — hit counts here are tiny and
  // this keeps the hot path allocation-free.
  for (let i = 2; i < hits.length; i += 2) {
    const e = hits[i], t = hits[i + 1];
    let j = i - 2;
    while (j >= 0 && hits[j + 1] > t) { hits[j + 2] = hits[j]; hits[j + 3] = hits[j + 1]; j -= 2; }
    hits[j + 2] = e; hits[j + 3] = t;
  }

  const critChance = crit + (player?.mods?.critChance ?? 0);
  const critScale = critMul + (player?.mods?.critMul ?? 0);
  const kbScale = player?.mods?.knockback ?? 1;

  // The tracer terminates at the wall, so a shot into cover visibly stops there rather
  // than drawing a beam through solid rock.
  let endT = Math.min(range, wallT);
  let n = 0;
  for (let i = 0; i < hits.length && n < pierce; i += 2) {
    const e = hits[i], t = hits[i + 1];
    const isCrit = game.rng() < critChance;
    const amount = damage * (isCrit ? critScale : 1);
    const dealt = applyDamage(e, {
      amount, type, source, crit: isCrit, position: origin,
      knockback: knockback ? { x: dx * knockback * kbScale, y: 0, z: dz * knockback * kbScale } : null,
      statuses,
    }, game);
    _a.set(origin.x + dx * t, e.airborne ? e.position.y + 0.8 : 1.2, origin.z + dz * t);
    game.fx.hit(_a, null, { count: isCrit ? 18 : 8, color, speed: isCrit ? 11 : 7 });
    if (dealt > 0) game.fx.blood(_a, { x: dx, z: dz }, 0.5);
    game.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : isCrit ? 'crit' : 'normal');
    game.audio.play(dealt === 0 ? 'immune' : isCrit ? 'hit.crit' : (e.armor > 6 ? 'hit.armor' : 'hit.flesh'), { position: _a });
    if (isCrit) game.engine.hitstop(0.03);
    endT = t;
    n++;
  }
  // Nothing left to pierce: the bolt runs on to whatever stopped it — the wall if there
  // is one, otherwise its full range.
  if (n < pierce) endT = Math.min(range, wallT);
  game.player.projectiles.tracer(origin.x, origin.z, dx, dz, endT, color, { width: tracerWidth, life: tracerLife });
  return n;
}
const _hitScratch = [];

// --- fireball projectile ----------------------------------------------------

registerProjectile('fireball', {
  color: 0xffb040,
  radius: 0.46,      // needs to read as a *ball* at 32 units, not a spark
  life: 1.5,
  hitRadius: 1.5,
  gravity: 5.5,          // a shallow arc; enough to read as "lobbed", not as a mortar
  spin: 9,
  glow: true, glowColor: 0xff7a20, glowIntensity: 7, glowRange: 13,
  // A ground-hugging fireball simply cannot reach something 3.4m up. That is the whole
  // reason the crossbow and the ring exist.
  filter: (e) => !e.airborne,

  trail(game, p) {
    game.fx.fire({ x: p.x, y: p.y, z: p.z }, 0.3, 2);
  },

  onImpact(game, p) {
    const params = p.params;
    const at = _a.set(p.x, 0.6, p.z);
    const r = params.radius;
    // The blast has to read at the size it actually damages, otherwise players learn the
    // wrong radius. Two rings: a fast bright edge at r, a slower body inside it.
    game.fx.fire(at, r * 0.5, 60);
    game.fx.ring(at, r * 0.95, [1, 0.72, 0.25], 48);
    game.fx.ring(at, r * 0.45, [1, 0.42, 0.1], 26);
    game.fx.dust(at, r * 0.7, 16, [0.22, 0.16, 0.13]);
    game.fx.shake(0.34, 0.22);
    game.audio.play('trap.boom', { position: at, pitch: 1.3 });

    let hits = 0;
    for (const e of game.enemies.queryRadius(at, r, (e) => !e.airborne)) {
      const d = e.position.distanceTo(at);
      // Never below 32% at the rim — a splash that does nothing at the edge reads as a miss.
      const falloff = clamp(1 - (d / r) * 0.68, 0.32, 1);
      const dealt = applyDamage(e, {
        amount: params.damage * falloff, type: 'fire',
        source: params.source, position: at,
        knockback: { x: (e.position.x - at.x) * 4.5, y: 2.2, z: (e.position.z - at.z) * 4.5 },
        statuses: [status('burn', 4, params.burn)],
      }, game);
      game.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : 'fire');
      if (dealt > 0) hits++;
    }
    game.engine.hitstop(hits > 2 ? 0.06 : 0.035);
  },
});

// --- the roster -------------------------------------------------------------

export const WEAPONS = [
  {
    id: 'crossbow', name: 'Arcane Crossbow', icon: '🏹', role: 'Precision · Anti-air',
    cooldown: 0.24, auto: true, recoil: 1.1, recoilAnim: 0.6, shake: 0.05, swapTime: 0.14,
    magazine: Infinity, mana: 0, range: 30, color: [0.45, 0.9, 1.0], hitsAir: true,
    description: 'Fast, accurate, endless, and the answer to anything with wings. Plate armour eats it.',
    fire(player, origin, angle, game) {
      game.audio.play('bow.shot', { position: origin });
      hitscan(game, player, origin, angle, {
        range: 30, damage: 38 * mul(player, 'crossbow'), type: 'physical',
        pierce: 1, spread: 0.012, knockback: 8, crit: 0.18, critMul: 2.3,
        color: [0.45, 0.9, 1], airRange: Infinity, tracerWidth: 1, tracerLife: 0.085,
        source: { kind: 'player', id: 'crossbow', hitsAir: true },
      });
    },
  },

  {
    id: 'blunderbuss', name: 'Blunderbuss', icon: '💥', role: 'Crowd shove',
    cooldown: 0.85, auto: false, recoil: 6.5, recoilAnim: 1.0, shake: 0.3, swapTime: 0.22,
    magazine: 5, reloadTime: 1.55, mana: 0, range: 12, color: [1, 0.75, 0.35], hitsAir: 'close',
    description: 'A 12m cone of buckshot that physically shoves the front rank back onto your traps.',
    fire(player, origin, angle, game) {
      game.audio.play('gun.shot', { position: origin });
      const g = game;
      const dmgScale = mul(player, 'blunderbuss');
      const kbScale = player.mods?.knockback ?? 1;
      const critChance = 0.12 + (player.mods?.critChance ?? 0);
      const RANGE = 12, HALF = 0.40, AIR_RANGE = 7;

      // Muzzle blast.
      g.fx.hit(_b.set(origin.x + Math.sin(angle) * 1.2, 1.2, origin.z + Math.cos(angle) * 1.2), null,
        { count: 22, color: [1, 0.8, 0.4], speed: 14 });

      // One cone sweep, not eight independent rays. Eight rays meant an orc standing in
      // the middle took eight separate knockback impulses and was launched across the
      // level; here every victim is shoved exactly once.
      let hits = 0;
      for (const e of g.enemies.queryRadius(origin, RANGE)) {
        const ex = e.position.x - origin.x, ez = e.position.z - origin.z;
        const dist = Math.hypot(ex, ez) || 0.001;
        if (e.airborne && dist > AIR_RANGE) continue;
        const off = Math.abs(angleDelta(angle, Math.atan2(ex, ez)));
        // Widen the cone up close so a point-blank panic shot never whiffs.
        const half = HALF + clamp((3.5 - dist) * 0.16, 0, 0.5);
        if (off > half) continue;

        const near = clamp(1 - dist / RANGE, 0, 1);
        const edge = 1 - (off / half) * 0.35;
        const isCrit = g.rng() < critChance;
        // 110 in your face, 34 at the far lip. Measured at 130/44 one shell deleted an
        // entire rank of grunts, which turned "shove them back into the traps" into
        // "you do not need the traps". A grunt now dies point-blank and survives at range.
        const amount = (34 + 76 * near * near) * edge * dmgScale * (isCrit ? 2.0 + (player.mods?.critMul ?? 0) : 1);
        // Measured: ~3 world units of shove on a mass-1 grunt at 34, which is under a
        // tile. 46 puts the front rank a clear tile and a half back — far enough to
        // re-trigger a spike floor they had already walked over.
        const push = (46 * (0.45 + near * 0.55)) * kbScale;
        const dealt = applyDamage(e, {
          amount, type: 'physical', crit: isCrit, position: origin,
          source: { kind: 'player', id: 'blunderbuss', hitsAir: true },
          knockback: { x: (ex / dist) * push, y: 2.5, z: (ez / dist) * push },
        }, g);
        _c.set(e.position.x, 1.15, e.position.z);
        g.fx.hit(_c, null, { count: 10, color: [1, 0.75, 0.35], speed: 9 });
        if (dealt > 0) g.fx.blood(_c, { x: ex / dist, z: ez / dist }, 0.7);
        g.fx.damageNumber(e.position, dealt, dealt === 0 ? 'immune' : isCrit ? 'crit' : 'normal');
        hits++;
      }
      g.audio.play(hits ? 'hit.flesh' : 'gun.shot', { position: origin, pitch: 0.8 });

      // Buckshot streaks — purely visual, so they are cheap and can be many.
      for (let i = 0; i < 9; i++) {
        const a = angle + (g.rng() - 0.5) * HALF * 2;
        g.player.projectiles.tracer(origin.x, origin.z, Math.sin(a), Math.cos(a),
          RANGE * (0.55 + g.rng() * 0.45), [1, 0.72, 0.3], { width: 0.7, life: 0.075 });
      }
      g.engine.hitstop(hits ? 0.06 : 0.03);
    },
  },

  {
    id: 'staff', name: 'Staff of Cinders', icon: '🔥', role: 'Pack clear',
    cooldown: 0.70, auto: true, recoil: 0.6, recoilAnim: 0.55, shake: 0.1, swapTime: 0.18,
    magazine: Infinity, mana: 16, range: 26, color: [1, 0.55, 0.18], hitsAir: false,
    description: 'A lobbed fireball: splash plus a burn. Answers a packed corridor. Ignores the sky.',
    fire(player, origin, angle, game) {
      game.audio.play('magic.shot', { position: origin });
      const speed = 30;
      game.player.projectiles.spawn('fireball',
        origin.x, 1.25, origin.z,
        Math.sin(angle) * speed, 2.4, Math.cos(angle) * speed,
        {
          // Measured: at 90 damage in a 4m circle one fireball wiped ten packed grunts,
          // and the staff alone out-cleared an eleven-trap corridor. 70 in 3.2m still
          // deletes kobolds and leaves grunts burning, without replacing the killbox.
          damage: 70 * mul(player, 'staff'),
          radius: 3.2 * (player.mods?.blast ?? 1),
          burn: 14 * (player.mods?.burn ?? 1),
          source: { kind: 'player', id: 'staff', hitsAir: false },
        });
    },
  },

  {
    id: 'lightning', name: 'Lightning Ring', icon: '⚡', role: 'Armour breaker',
    cooldown: 1.0, auto: false, recoil: 0, recoilAnim: 0.35, shake: 0.2, swapTime: 0.18,
    magazine: Infinity, mana: 30, range: 17, color: [0.7, 0.88, 1.0], hitsAir: true,
    description: 'Chains between packed targets and stuns. Armour is a physical stat — this is not.',
    fire(player, origin, angle, game) {
      game.audio.play('magic.shot', { position: origin, pitch: 1.6 });
      const maxChains = 7 + (player.mods?.chains ?? 0);
      let from = _b.copy(origin); from.y = 1.35;

      // The first link is aimed; every link after it is proximity.
      let current = game.enemies.nearest(origin, 17, (e) =>
        Math.abs(angleDelta(angle, Math.atan2(e.position.x - origin.x, e.position.z - origin.z))) < 0.95);
      if (!current) {
        // Whiff: still show the discharge so the mana is not spent in silence.
        game.player.projectiles.tracer(origin.x, origin.z, Math.sin(angle), Math.cos(angle), 8,
          [0.45, 0.75, 1.0], { width: 1.4, life: 0.14, y: 1.25, opacity: 0.8 });
        return;
      }

      const chained = _chainScratch;
      chained.clear();
      let damage = 72 * mul(player, 'lightning');
      for (let i = 0; i < maxChains && current; i++) {
        chained.add(current);
        _a.set(current.position.x, current.airborne ? current.position.y + 0.9 : 1.2, current.position.z);
        // Particle forks alone read as one white smear from 32 units up. A hard bolt per
        // link is what makes "it chained to four orcs" legible at a glance.
        const lx = _a.x - from.x, lz = _a.z - from.z;
        const ll = Math.hypot(lx, lz) || 0.001;
        game.player.projectiles.tracer(from.x, from.z, lx / ll, lz / ll, ll,
          [0.45, 0.75, 1.0], { width: 1.9, life: 0.17, y: 1.25, opacity: 1 });
        const dealt = applyDamage(current, {
          amount: damage, type: 'lightning',
          source: { kind: 'player', id: 'lightning', hitsAir: true },
          position: from, statuses: [status('stun', 0.45, 1)],
        }, game);
        game.fx.damageNumber(current.position, dealt, dealt === 0 ? 'immune' : 'lightning');
        game.fx.hit(_a, null, { count: 7, color: [0.75, 0.9, 1], speed: 8 });
        game.audio.play('hit.armor', { position: current.position, pitch: 1.5 });
        from = _b.copy(_a);
        damage *= 0.80;
        current = game.enemies.nearest(current.position, 7.5, (e) => !chained.has(e));
      }
      if (chained.size) game.engine.hitstop(clamp(0.02 * chained.size, 0.03, 0.08));
      game.fx.shake(0.12 + chained.size * 0.02, 0.18);
    },
  },
];
const _chainScratch = new Set();

export const WEAPON_BY_ID = new Map(WEAPONS.map((w) => [w.id, w]));
