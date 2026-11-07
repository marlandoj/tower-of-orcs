import { buildEnemyModel } from './models.js';
import { status } from '../../shared/Damage.js';
import { v0 } from '../../shared/scratch.js';
import {
  updatePhase, charge, beginCharge, summon, shieldAllies,
  partTheCrowd, pulse, splitInto, shootBest, archerTarget,
  beginSlam, slamWindup, structuresIn, SLAM_RADIUS, SLAM_WRECK,
  siegeBlocker, wreckTrap, losClear, heroDist2,
} from './abilities.js';

/** Seconds before the same orc can be healed again by any shaman (see Blood Shaman). */
const HEAL_LOCKOUT = 4.0;

/**
 * The orc roster. Every entry must answer one question: *what does this one make the
 * player do differently?* An enemy that only has more HP is not a new enemy.
 *
 *   grunt        — the baseline
 *   runner       — fast, cheap, floods; punishes single-target defences
 *   brute        — soaks; punishes low DPS
 *   armored      — flat physical reduction; forces elemental/crush answers
 *   shaman       — heals and hastes the pack; a priority target
 *   leaper       — jumps floor traps and pits; punishes floor-only builds
 *   firewalker   — fire immune; punishes brimstone monoculture
 *   sapper       — chews the floor trap it touches, and *walks to* barricades to break them
 *   gargoyle     — flies; ignores every floor trap
 *   frostling    — frost immune, shrugs off ice vents
 *   shieldbearer — frontal damage block; forces flanking or crush
 *   archer       — outranges you and shoots your guardians
 *   warchanter   — shields the pack on a drum beat; the anti-burst unit
 *   bloater      — bursts into grubs when killed; punishes clumped, all-or-nothing damage
 *   stalker      — invisible to guardians until it strikes; punishes turtling behind them
 *   ogre         — huge, knockback-immune, telegraphed slam that wrecks traps in a ring
 *   troll        — regenerates unless burned
 *   warlord      — boss: rally -> telegraphed charge -> enrage
 *   frost-warlord— boss: freeze traps -> frost nova -> ice armour + escort
 *   orc-king     — finale: summons, horde shield, shockwaves, three phases
 *
 * ## The `damageToRift` ladder
 *
 * Rift pools run 12–25 across the campaign (WORLD owns the per-level number; levels 8–10
 * are 20/22/25). Leak cost is authored as a *fraction of the smallest pool a unit can
 * appear against*, never as an absolute, so that no single body can end a run on its own:
 *
 *   1  trash          — grunt, runner, grub, archer, caster, flyer
 *   2  heavy trash    — brute, shieldbearer, bloater, stalker
 *   3  elite          — ogre, troll
 *   4  boss           — warlord, frost-warlord
 *   6  finale         — the Orc King
 *
 * The rule the ladder encodes: **a boss leak must hurt, not decide.** The King at 6 against
 * a 25-point rift costs 24% of the run and leaves four more chances; at its old value of 12
 * against a 12-point rift it was a scripted defeat — DIRECTOR simulated a flawless build
 * (69 traps, rift untouched through wave 7) and still lost 100% of the rift to one crossing,
 * because 9,000 HP behind 24 armour cannot be removed in the time it takes to walk the map.
 * If a boss ever needs to feel more dangerous, raise its HP or its speed, not this number.
 *
 * ## The aggression ladder
 *
 * Three optional fields decide whether an archetype comes for the hero, and they are the
 * difference between a horde and a parade. `Enemy._threat` documents the machinery; this
 * is the authored shape of it:
 *
 *   `aggroChance`  probability, rolled once per orc at spawn, that this one will divert
 *                  from the rift to fight you at all. Support units are low (they have a
 *                  job and it is not you), skirmishers are high, bosses are 1.
 *   `aggro`        how far away it notices you, in metres, with line of sight.
 *   `huntTime`     how long it commits before remembering the rift.
 *
 * The ladder, and why each rung sits where it does:
 *
 *   0.10-0.20  shaman, chanter, sapper   — they have work to do; killing them is *your*
 *                                          job, not the reverse
 *   0.35-0.45  brute, ironhide, shieldbearer, ogre, troll, firewalker, frostling
 *                                        — the wall. Enough turn to make a post cost
 *                                          health; most keep walking at the rift
 *   0.55-0.75  grunt, grub, bloater, gargoyle, runner
 *                                        — the cheap bodies. This is where the pressure
 *                                          on a stationary hero actually comes from
 *   1.00       leaper, stalker, every boss
 *                                        — units whose entire identity is "it is coming
 *                                          for you"
 *
 * Defaults live in `Enemy.spawn` (0.5 / 7.5m / 4.5s) so an archetype that says nothing
 * still behaves like an orc rather than like scenery.
 */

const model = (id) => () => buildEnemyModel(id);

export const ROSTER = [
  {
    id: 'orc-grunt', name: 'Orc Grunt', tier: 1,
    hp: 70, speed: 3.3, radius: 0.55, mass: 1, accel: 20,
    damageToRift: 1, coin: 24, score: 100,
    attackDamage: 9, attackRate: 1.15, attackRange: 1.5,
    aggroChance: 0.55, aggro: 8,
    flags: [],
    build: model('orc-grunt'),
  },
  {
    id: 'kobold-runner', name: 'Kobold Runner', tier: 1,
    hp: 34, speed: 6.4, radius: 0.4, mass: 0.5, accel: 30,
    damageToRift: 1, coin: 14, score: 70,
    attackDamage: 5, attackRate: 0.75, attackRange: 1.2, attackAnim: 0.45,
    // Faster than the hero is not, so a runner that turns on you is the one thing in the
    // roster you genuinely cannot walk away from. Cheap, but it is the harasser.
    aggroChance: 0.7, aggro: 11, huntTime: 5,
    flags: [],
    build: model('kobold-runner'),
  },
  {
    id: 'orc-brute', name: 'Orc Brute', tier: 2,
    hp: 260, speed: 2.5, radius: 0.8, mass: 2.4, accel: 14,
    damageToRift: 2, coin: 60, score: 280,
    attackDamage: 22, attackRate: 1.6, attackRange: 1.9, attackAnim: 0.95,
    aggroChance: 0.45, aggro: 8,
    flags: [],
    build: model('orc-brute'),
  },
  {
    id: 'orc-armored', name: 'Ironhide Orc', tier: 2,
    hp: 180, speed: 2.9, radius: 0.62, mass: 1.7, accel: 17,
    armor: 14, resist: { physical: 0.55, crush: 1.35, lightning: 1.25 },
    damageToRift: 1, coin: 48, score: 220,
    attackDamage: 14, attackRate: 1.2, attackRange: 1.6,
    aggroChance: 0.4, aggro: 7.5,
    flags: ['armored'],
    build: model('orc-armored'),
  },
  {
    id: 'orc-shaman', name: 'Blood Shaman', tier: 3,
    hp: 130, speed: 3.0, radius: 0.55, mass: 1, accel: 18,
    damageToRift: 1, coin: 70, score: 340,
    attackDamage: 8, attackRate: 1.4, attackRange: 2.0, attackAnim: 0.8,
    abilityCooldown: 4.5,
    // Support hangs back. A shaman that runs at you is a shaman that is not healing.
    aggroChance: 0.12, aggro: 6,
    flags: ['healer', 'buffer'],
    build: model('orc-shaman'),
    ai: {
      update(e, game, dt) {
        if (e.abilityCd > 0) return false;
        e.abilityCd = 4.5;
        e.state = 'attack'; e.stateT = 0;   // the cast animation is the tell
        // Heal + haste the pack. A shaman left alive doubles the wave's effective HP.
        //
        // Heals do not stack. Each orc can be healed once per HEAL_LOCKOUT whoever casts,
        // and shamans heal each other for half. Without that, the 12-14 shamans of Level 3's
        // last waves each topped up every ally in range — and each other — every 4.5s,
        // which no killbox the level's purse can buy was able to out-damage.
        const now = game.clock.elapsed;
        const n = pulse(e, game, 9, (o) => {
          if (now - (o._healedAt ?? -99) < HEAL_LOCKOUT) return;
          o._healedAt = now;
          const amount = o.hpMax * 0.18 * (o.has('healer') ? 0.5 : 1);
          o.hp = Math.min(o.hpMax, o.hp + amount);
          o.addStatus(status('haste', 3.0, 0.30), game);
          game.fx.ring(o.position, 0.6, [1, 0.25, 0.5], 6);
        }, [1, 0.2, 0.45], 14);
        if (n) game.audio.play('magic.shot', { position: e.position, pitch: 0.6 });
        return false;
      },
    },
  },
  {
    id: 'orc-leaper', name: 'Gnoll Leaper', tier: 2,
    hp: 95, speed: 4.4, radius: 0.5, mass: 0.8, accel: 26,
    damageToRift: 1, coin: 40, score: 200,
    attackDamage: 12, attackRate: 0.9, attackRange: 1.4, attackAnim: 0.55,
    abilityCooldown: 2.4,
    // The leaper is a closer. It always comes, and it comes from further away than
    // anything else its size, because the leap is what makes the distance meaningless.
    aggroChance: 1, aggro: 12, huntTime: 6,
    flags: ['leaper'],
    build: model('orc-leaper'),
    ai: {
      /**
       * Two leaps, and the second one is the point of the unit.
       *
       * The first is the old one: hop whatever hazard is directly ahead — floor trap,
       * tar, pit — which is what makes floor-only builds leak.
       *
       * The second is a **pounce at the hero**. "Leapers should close distance" was the
       * one-line brief and it was not true before: a leaper only ever jumped along its
       * route, so a player who kept four metres of air between themselves and the horde
       * was as safe from a Gnoll as from a barrel. Now, from four to twelve metres with a
       * clear line, it launches, and it lands *on* you — the touchdown is its own small
       * hit, so the pounce costs health even if the follow-up swing misses. The
       * three-second cooldown is what keeps it a punctuation mark rather than a blender.
       */
      update(e, game, dt) {
        if (e.leapT > 0) {
          e.leapT -= dt;
          e.position.x += e.leapVX * dt;
          e.position.z += e.leapVZ * dt;
          e.leapVY -= 24 * dt;
          e.position.y = Math.max(0, e.position.y + e.leapVY * dt);
          if (e.leapT <= 0 || e.position.y <= 0) {
            e.position.y = 0; e.leapT = 0;
            game.fx.dust(e.position, 0.9, 8);
            if (e.leapPounce) {
              e.leapPounce = false;
              const p = game.player;
              if (p && !p.dead && p.position.distanceToSquared(e.position) < 6.25) {
                p.takeDamage(e.attackDamage * 0.8, e);
                game.fx.shake(0.3, 0.18);
              }
            }
          }
          e._render(dt, game);
          return true;
        }
        if (e.abilityCd > 0) return false;
        const grid = game.grid;

        // Pounce first: a leaper with the hero in its sights does not care what tile it
        // was about to step on.
        const p = game.player;
        if (p && !p.dead) {
          const d2 = heroDist2(e, game);
          if (d2 > 16 && d2 < 144
              && losClear(grid, e.position.x, e.position.z, p.position.x, p.position.z)) {
            const d = Math.sqrt(d2);
            const dx = (p.position.x - e.position.x) / d, dz = (p.position.z - e.position.z) / d;
            e.abilityCd = 3.0;
            e.leapT = Math.min(0.85, 0.28 + d / 18);
            e.leapPounce = true;
            // Sized so the arc lands *on* the hero rather than short of them.
            e.leapVX = dx * (d / e.leapT) * 0.92; e.leapVZ = dz * (d / e.leapT) * 0.92;
            e.leapVY = 9.5;
            e.facing = Math.atan2(dx, dz);
            e.reveal?.();
            game.fx.dust(e.position, 1.2, 12);
            game.audio.play('orc.growl', { position: e.position, pitch: 1.5 });
            return false;
          }
        }

        const dir = grid.riftFlow().sample(e.position.x, e.position.z, { x: 0, z: 0 });
        const ax = Math.floor((e.position.x + dir.x * 4) / 4);
        const az = Math.floor((e.position.z + dir.z * 4) / 4);
        const c = grid.cell(ax, az);
        const hazard = c && (c.floorTrap || c.flags.has('pit') || c.cost > 1.5);
        if (!hazard) return false;
        e.abilityCd = 2.4;
        e.leapT = 0.62;
        e.leapPounce = false;
        e.leapVX = dir.x * 11; e.leapVZ = dir.z * 11; e.leapVY = 8.5;
        game.fx.dust(e.position, 1.1, 10);
        game.audio.play('orc.growl', { position: e.position, pitch: 1.4 });
        return false;
      },
    },
  },
  {
    id: 'orc-firewalker', name: 'Cinder Orc', tier: 3,
    hp: 150, speed: 3.4, radius: 0.58, mass: 1.2, accel: 20,
    resist: { fire: 0, ice: 1.5 },
    damageToRift: 1, coin: 52, score: 260,
    attackDamage: 13, attackRate: 1.1, attackRange: 1.6,
    aggroChance: 0.45, aggro: 8,
    flags: ['fire-immune'],
    build: model('orc-firewalker'),
    ai: {
      update(e, game, dt) {
        // Trails embers, so "the fire trap did nothing" is visible before you waste a
        // second volley on it.
        if ((game.clock.frame + e.__idx) % 12 === 0 && !e.culled) game.fx.fire(e.position, 0.35, 2);
        return false;
      },
    },
  },
  {
    id: 'orc-sapper', name: 'Sapper', tier: 3,
    hp: 110, speed: 4.0, radius: 0.5, mass: 0.9, accel: 24,
    damageToRift: 1, coin: 58, score: 300,
    attackDamage: 10, attackRate: 1.0, attackRange: 1.4, attackAnim: 0.6,
    // It is here for the walls, not for you. Low aggression is what keeps a sapper pack
    // a *structural* threat that you have to leave your post to answer.
    aggroChance: 0.15, aggro: 6,
    flags: ['trap-disarm'],
    build: model('orc-sapper'),
    ai: {
      /**
       * Two jobs, and the second one is new.
       *
       * 1. **Floor traps.** Chews whatever it is standing on. Layered defences survive;
       *    single rows do not. The damage is applied in quarter-second bites through
       *    `traps.wreck` rather than by writing `hp` directly — one, because durability is
       *    TRAPS' to own, and two, because `wreck` is what plays the hit and emits
       *    `trap:damaged`, and doing that sixty times a second would be a jackhammer.
       *
       * 2. **Barricades.** It now *walks to them.* The barricade is the object that lets
       *    the player author the path, and a sapper is one of its two designed counters —
       *    but the horde steers by a flow field that routes politely around the wall, so
       *    before this the counter only fired on the sappers who happened to be shoved
       *    against one. A sapper that will not go to the wall is not a counter; it is a
       *    rumour. Now it leaves its route for up to four tiles, plants, and swings.
       */
      update(e, game, dt) {
        const c = game.grid.cellAtWorld(e.position);
        if (c?.floorTrap && !c.floorTrap.destroyed) {
          e._chew = (e._chew ?? 0) + dt;
          if (e._chew >= 0.25) {
            wreckTrap(game, c.floorTrap, 260 * e._chew, { kind: 'enemy', id: e.id, enemy: e });
            e._chew = 0;
          }
          game.fx.hit(e.position, null, { count: 3, color: [0.3, 1, 0.75], speed: 4 });
          e.velocity.multiplyScalar(0.2);
          e.state = 'attack'; e.stateT = Math.min(e.stateT, 0.3);
          return false;
        }
        e._chew = 0;
        return siegeBlocker(e, game, dt);
      },
    },
  },
  {
    id: 'gargoyle', name: 'Gargoyle', tier: 3,
    hp: 120, speed: 3.9, radius: 0.55, mass: 1, accel: 18,
    flyHeight: 3.4,
    damageToRift: 1, coin: 55, score: 300,
    attackDamage: 12, attackRate: 1.2, attackRange: 2.0,
    resist: { crush: 0.6 },
    // Nothing on the ground can reach it, so it is free to come at you; and it is the
    // unit that most punishes a defence built entirely out of floor tiles.
    aggroChance: 0.6, aggro: 14, huntTime: 6,
    flags: ['flying'],
    build: model('gargoyle'),
    ai: {
      /**
       * Cruise height is 3.4 metres, which is *above the hero's head* — and since reach
       * is measured in three dimensions, a gargoyle at cruise physically could not land a
       * blow on the player no matter how directly it flew at them. It was a threat to the
       * rift and to nothing else. So a gargoyle that has committed to the hero dives:
       * 1.4m, inside its own two-metre reach, and it climbs back to the rafters when it
       * loses interest.
       */
      update(e, game, dt) {
        const want = e.hunt > 0 ? 1.4 : (e.def.flyHeight ?? 3.2);
        e.flyHeight += (want - e.flyHeight) * Math.min(1, dt * 3.5);
        return false;
      },
    },
  },
  {
    id: 'orc-frostling', name: 'Frostling', tier: 3,
    hp: 140, speed: 3.5, radius: 0.55, mass: 1.1, accel: 20,
    resist: { ice: 0, fire: 1.5 },
    damageToRift: 1, coin: 52, score: 270,
    attackDamage: 12, attackRate: 1.1, attackRange: 1.6,
    aggroChance: 0.45, aggro: 8,
    flags: ['frost-immune'],
    build: model('orc-frostling'),
  },
  {
    id: 'orc-shieldbearer', name: 'Shieldbearer', tier: 4,
    hp: 200, speed: 2.6, radius: 0.66, mass: 2.0, accel: 15,
    armor: 8,
    shield: { hp: 260, absorb: 0.9, arc: 130 },
    damageToRift: 2, coin: 72, score: 380,
    attackDamage: 16, attackRate: 1.3, attackRange: 1.7, attackAnim: 0.85,
    resist: { crush: 1.4 },
    aggroChance: 0.35, aggro: 7,
    flags: ['shielded'],
    build: model('orc-shieldbearer'),
    ai: {
      update(e, game, dt) {
        // Once the shield is gone the pose opens up — the player can see it is now soft.
        if (e.shield && e.shield.hp <= 0 && !e._shieldBroken) {
          e._shieldBroken = true;
          e.speedBase *= 1.25;
          game.fx.hit(e.position, null, { count: 12, color: [0.8, 0.85, 1], speed: 8 });
        }
        return false;
      },
    },
  },
  {
    id: 'orc-archer', name: 'Orc Archer', tier: 4,
    hp: 95, speed: 3.2, radius: 0.5, mass: 0.9, accel: 20,
    damageToRift: 1, coin: 56, score: 320,
    attackDamage: 12, attackRate: 2.0, attackRange: 15, attackAnim: 0.9,
    // 2.1s, not the 1.7 this was first tuned to. Measured with the new targeting: six
    // archers at 1.7s put 15 damage per second into a stationary hero, which kills a
    // full-health War Mage in ten seconds and made wave 2 of The Black Throne — twenty
    // archers — an execution. The volley is supposed to move you off your post, not
    // delete you from it.
    abilityCooldown: 2.1,
    // An archer never chases. Its threat is that it does not have to.
    aggroChance: 0, aggro: 0,
    flags: ['ranged'],
    build: model('orc-archer'),
    ai: {
      /**
       * The unit that is supposed to make standing still expensive.
       *
       * It did not, for three separate reasons, all of which are fixed here:
       *
       *   1. **It preferred your guardians.** The old rule took a guardian at 85% of the
       *      distance over the player, so anyone who owned hired help was simply never
       *      shot at. The hero is the first priority now (see `archerTarget`).
       *   2. **It did not lead the shot.** It aimed at where you were when it loosed, and
       *      a hero moves 9.4 metres a second, so the arrow landed a body-length behind
       *      anything that was walking. Now it leads — which means a *moving* player is
       *      still safe and a planted one is not. That is exactly the price we want on
       *      standing in the killbox.
       *   3. **It walked into melee.** Range 15 is meaningless if the unit closes to two
       *      metres and dies to the same shot as a grunt. It now plants at range while it
       *      has a shot, and physically backs away from a hero who closes on it — so
       *      answering an archer pack costs you *repositioning*, which is the currency
       *      the whole design is short of.
       *
       * The retreat goes through `pressX/pressZ`, the same world-space channel the crowd
       * model already uses to shove orcs around, so a backing-off archer still queues,
       * still separates, and still cannot reverse through a wall.
       */
      update(e, game, dt) {
        const p = game.player;
        e.speedMul = 1;

        if (e.abilityCd <= 0 && shootBest(e, game, e.attackRange)) {
          e.abilityCd = e.def.abilityCooldown;
          e.state = 'attack'; e.stateT = 0;
        } else {
          const t = archerTarget(e, game, e.attackRange);
          // Has a shot lined up but is between arrows: hold the line rather than closing.
          // Not for masonry, though — an archer that plants to shoot a trap never arrives
          // anywhere, and twenty of them doing it is how an unattended killbox went from
          // "loses ground" to "is deleted". Structures get shot in passing.
          if (t && !t.structure) e.speedMul = 0.3;
        }

        if (p && !p.dead) {
          const dx = e.position.x - p.position.x, dz = e.position.z - p.position.z;
          const d = Math.hypot(dx, dz);
          if (d > 0.01 && d < 8) {
            // Kite. Strong enough to beat the flow field, not so strong it outruns a hero.
            const k = 2.4 * (1 - d / 8) + 0.9;
            e.pressX += (dx / d) * k; e.pressZ += (dz / d) * k;
            e.speedMul = 1;
          }
        }
        return false;
      },
    },
  },
  {
    id: 'orc-warchanter', name: 'War Chanter', tier: 4,
    hp: 165, speed: 2.9, radius: 0.58, mass: 1.3, accel: 17,
    damageToRift: 1, coin: 78, score: 400,
    attackDamage: 11, attackRate: 1.4, attackRange: 1.6, attackAnim: 0.8,
    abilityCooldown: 5.5,
    aggroChance: 0.12, aggro: 6,
    flags: ['shielder', 'buffer'],
    build: model('orc-warchanter'),
    ai: {
      update(e, game, dt) {
        if (e.abilityCd > 0) return false;
        e.abilityCd = 5.5;
        e.state = 'attack'; e.stateT = 0;
        // A drum beat wraps the pack in a shield. Burst damage stops one-shotting the
        // front rank, so you have to break the chant first.
        const n = shieldAllies(e, game, 90, 10, 0.7);
        pulse(e, game, 10, (o) => o.addStatus(status('haste', 2.5, 0.15), game), [1, 0.8, 0.3], 20);
        if (n) game.audio.play('horde', { position: e.position, pitch: 1.1, gain: 0.5 });
        return false;
      },
    },
  },
  {
    id: 'orc-bloater', name: 'Bloated Orc', tier: 4,
    hp: 210, speed: 2.7, radius: 0.75, mass: 1.6, accel: 15,
    resist: { fire: 1.4, poison: 0 },
    damageToRift: 2, coin: 64, score: 340,
    attackDamage: 14, attackRate: 1.5, attackRange: 1.7, attackAnim: 0.9,
    // It wants to die next to you: `splitInto` puts eight damage on anyone inside three
    // metres of the burst, so a bloater that reaches the hero is a small bomb.
    aggroChance: 0.6, aggro: 8,
    flags: ['splitter'],
    build: model('orc-bloater'),
    // Killing it is only half the job: it bursts into three grubs that keep coming.
    onDeath: (e, game) => splitInto(e, game, 'blight-grub', 3),
  },
  {
    id: 'blight-grub', name: 'Blight Grub', tier: 1,
    hp: 26, speed: 5.2, radius: 0.33, mass: 0.35, accel: 28,
    resist: { poison: 0 },
    damageToRift: 1, coin: 6, score: 40,
    attackDamage: 4, attackRate: 0.7, attackRange: 1.1, attackAnim: 0.4,
    aggroChance: 0.65, aggro: 9,
    flags: [],
    build: model('blight-grub'),
  },
  {
    id: 'shadow-stalker', name: 'Shadow Stalker', tier: 5,
    hp: 150, speed: 4.6, radius: 0.48, mass: 0.8, accel: 26,
    resist: { physical: 0.85 },
    damageToRift: 2, coin: 90, score: 450,
    attackDamage: 26, attackRate: 1.5, attackRange: 1.5, attackAnim: 0.5,
    ambushMult: 2.5,   // the opening strike from stealth; see Enemy._tryAttack
    // The only unit in the roster that crosses a room to find you. Twenty metres of
    // notice, a twelve-second commitment, and a leash long enough that walking away is
    // not an answer — you have to turn round and kill it.
    aggroChance: 1, aggro: 20, huntTime: 12, leash: 34,
    flags: ['stealth'],
    build: model('shadow-stalker'),
    ai: {
      /**
       * An ambusher, which is a different thing from an invisible orc.
       *
       * Guardians cannot see it until it commits, so a wall of turrets is not an answer.
       * That part already worked. What did not is that it walked the same route as
       * everything else, so it was invisible *on its way past you* — its opening strike
       * only ever landed on a player who happened to be standing on the lane. It hunts
       * now, from across the room, and it closes faster while it is still unseen: the
       * stalk is the tell you get, and it is the only one.
       */
      update(e, game, dt) {
        // The 2.5x opening strike is `ambushMult`, applied in Enemy._tryAttack at the
        // moment the swing is committed (while still stealthed).
        // Faster while unseen and committed; ordinary once it has shown itself.
        e.speedMul = e.stealthed && e.hunt > 0 ? 1.3 : 1;
        return false;
      },
    },
  },
  {
    id: 'ogre', name: 'Ogre', tier: 5,
    hp: 900, speed: 2.1, radius: 1.15, mass: 6, accel: 10,
    armor: 10,
    resist: { physical: 0.8, crush: 1.2 },
    damageToRift: 3, coin: 180, score: 900,
    attackDamage: 42, attackRate: 2.2, attackRange: 2.6, attackAnim: 1.15,
    scale: 1.55, abilityCooldown: 6,
    aggroChance: 0.5, aggro: 10, huntTime: 6,
    flags: ['unstoppable'],
    build: model('ogre'),
    ai: {
      /**
       * Wades through its own horde, and wrecks the killbox it walks into.
       *
       * What this used to be: the instant it stood on a floor trap it called
       * `traps.destroy()` on every floor trap in a 3×3 — no wind-up, no damage roll, no
       * cost, every six seconds. That single line is why the Ogre looked like it had one
       * legal answer: it was not resisting your floor traps, it was deleting them before
       * they could fire.
       *
       * What it is now: it commits when it is *inside* the blast radius of something
       * breakable, rears back for 0.85s with the ring and every doomed trap lit up, and
       * then rolls SLAM_WRECK against durability. 300 at the impact tile, halving to 150
       * at the edge. Against level 1 traps (240 hp) the tile it lands on is gone and the
       * ring around it survives one hit; level 2 (324) and level 3 (437) traps walk away
       * from the whole thing. Cost to a killbox went from "everything in a 3×3, free" to
       * "one cheap trap per six seconds, and you saw it coming".
       *
       * And it goes *to* barricades. `unstoppable` is one of the two flags the barricade
       * names as its counter, but an ogre steers by the same flow field as everything
       * else, which routes it politely round the wall — measured: an ogre spawned five
       * units from a barricade walked past it and never touched it. So it takes the same
       * detour a sapper does, then does what an ogre does when it arrives.
       */
      update(e, game, dt) {
        if ((game.clock.frame & 15) === 0) partTheCrowd(e, game, 3.2, 10);
        if (slamWindup(e, game, dt)) return true;
        // Commit on what the ring will actually cover, not on the one tile underfoot —
        // an ogre that only slams when it is standing on a trap can never threaten a
        // barricade, which is the other structure it is supposed to be the answer to.
        //
        // And on the hero. An ogre that has come for you and then only swings when it
        // happens to be standing on masonry is an ogre you can stand next to; 26 damage
        // inside a 5.2m ring with a 0.85s tell is a dodge, and a dodge is a decision.
        const onHero = e.hunt > 0 && heroDist2(e, game) < (SLAM_RADIUS + 1) * (SLAM_RADIUS + 1);
        if (e.abilityCd <= 0 && (onHero || structuresIn(game, e.position, SLAM_RADIUS))) {
          e.abilityCd = 6;
          beginSlam(e, game, SLAM_RADIUS, 26, SLAM_WRECK);
          return true;
        }
        return siegeBlocker(e, game, dt);
      },
    },
  },
  {
    id: 'troll', name: 'Cave Troll', tier: 5,
    hp: 1100, speed: 2.4, radius: 1.0, mass: 5,
    resist: { fire: 1.8, physical: 0.75 },
    damageToRift: 3, coin: 200, score: 1000,
    attackDamage: 38, attackRate: 1.8, attackRange: 2.4, attackAnim: 1.05,
    scale: 1.4,
    aggroChance: 0.5, aggro: 10, huntTime: 6,
    flags: ['unstoppable', 'regen'],
    build: model('troll'),
    ai: {
      update(e, game, dt) {
        // Regenerates unless it was burned in the last few seconds.
        const burning = e.statuses.some((s) => s.kind === 'burn');
        if (!burning && e.hp < e.hpMax) {
          e.hp = Math.min(e.hpMax, e.hp + e.hpMax * 0.07 * dt);
          if ((game.clock.frame + e.__idx) % 20 === 0 && !e.culled) {
            game.fx.hit(e.position, null, { count: 2, color: [0.4, 1, 0.35], speed: 2 });
          }
        }
        return false;
      },
    },
  },

  /* ------------------------------- bosses ------------------------------- */
  {
    id: 'orc-warlord', name: 'Orc Warlord', tier: 6,
    hp: 3200, speed: 2.8, radius: 1.2, mass: 8,
    armor: 18,
    resist: { physical: 0.7, fire: 0.85, ice: 0.85 },
    damageToRift: 4, coin: 500, score: 3000,
    attackDamage: 55, attackRate: 1.6, attackRange: 3.0, attackAnim: 1.1,
    scale: 1.7, abilityCooldown: 7,
    // A boss hunts the hero, full stop. Twenty-six metres of notice and a leash long
    // enough to follow you off the lane — but only for seven seconds at a time, and then
    // it remembers the rift for a few. That alternation is deliberate: a boss that hunts
    // forever can be kited round a pillar for the whole wave, and a boss that never hunts
    // is a slow-moving wall you shoot from behind a corner. It has to be able to do both.
    aggroChance: 1, aggro: 26, huntTime: 7, leash: 46,
    flags: ['boss', 'unstoppable', 'buffer', 'armored', 'summoner'],
    build: model('orc-warlord'),
    ai: {
      /**
       * Three real fights, not one health bar:
       *   1. Rally  — enrages the horde; kill the adds or drown.
       *   2. Charge — stops rallying and comes for *you*, telegraphed and dodgeable.
       *   3. Both, faster, plus a bodyguard every cast.
       */
      update(e, game, dt) {
        if (updatePhase(e, game, [0.66, 0.33], (b, g, p) => {
          if (p >= 1) b.speedBase = b.def.speed * 1.2;
          if (p >= 2) { b.attackRate = b.def.attackRate * 0.65; b.speedBase = b.def.speed * 1.35; }
        })) { e._render(dt, game); return true; }

        if (charge(e, game, dt)) return true;
        if (e.abilityCd > 0) return false;

        if (e.phase === 0 || (e.phase === 2 && (e._alt = !e._alt))) {
          e.abilityCd = e.phase === 2 ? 4.5 : 7;
          e.state = 'attack'; e.stateT = 0;
          for (const o of game.enemies.list.items) {
            if (o === e || o.dead) continue;
            o.addStatus(status('rage', 5, 1), game);
          }
          if (e.phase === 2) summon(e, game, 'orc-armored', 3, 4);
          game.fx.ring(e.position, 4, [1, 0.25, 0.1], 46);
          game.fx.shake(0.7, 0.4);
          game.audio.play('horde', { position: e.position, pitch: 0.7 });
        } else {
          e.abilityCd = e.phase === 2 ? 5 : 6.5;
          beginCharge(e, 0.7);
        }
        return false;
      },
    },
  },
  {
    id: 'frost-warlord', name: 'Frost Warlord', tier: 6,
    hp: 3600, speed: 2.7, radius: 1.2, mass: 8,
    armor: 16,
    resist: { ice: 0, physical: 0.7, fire: 1.2 },
    damageToRift: 4, coin: 520, score: 3200,
    attackDamage: 52, attackRate: 1.6, attackRange: 3.0, attackAnim: 1.1,
    scale: 1.7, abilityCooldown: 6,
    aggroChance: 1, aggro: 26, huntTime: 7, leash: 46,
    flags: ['boss', 'unstoppable', 'frost-immune', 'shielder', 'summoner'],
    build: model('frost-warlord'),
    ai: {
      /**
       *   1. Deep Freeze — silences your traps in a radius; you have to fight for a bit.
       *   2. Frost Nova  — hurts and shoves you off the choke you were holding.
       *   3. Ice Armour  — shields itself and the horde, escorted by frostlings.
       */
      update(e, game, dt) {
        if (updatePhase(e, game, [0.66, 0.33], (b, g, p) => {
          if (p === 2) { b.shield = { hp: 1200, absorb: 0.6, arcCos: -1, max: 1200 }; }
        })) { e._render(dt, game); return true; }

        if (e.abilityCd > 0) return false;
        e.state = 'attack'; e.stateT = 0;

        if (e.phase === 0 || (e.phase > 0 && (e._alt = !e._alt))) {
          e.abilityCd = 6 - e.phase;
          let n = 0;
          for (const t of game.traps.list) {
            if (t.destroyed) continue;
            const w = game.grid.toWorld(t.gx, t.gz, v0);
            if (w.distanceToSquared(e.position) < 100) { t.frozen = 4.0; n++; }
          }
          game.fx.ring(e.position, 5, [0.5, 0.85, 1], 46);
          game.fx.frost(e.position, 3, 30);
          game.audio.play('trap.tar', { position: e.position, pitch: 0.5 });
          if (n) game.ui.toast('Traps frozen!', 'error');
        } else if (e.phase === 1) {
          e.abilityCd = 5;
          const p = game.player;
          if (p && !p.dead && p.position.distanceToSquared(e.position) < 64) {
            p.takeDamage(30, e);
            const dx = p.position.x - e.position.x, dz = p.position.z - e.position.z;
            const d = Math.hypot(dx, dz) || 1;
            p.velocity.x += (dx / d) * 26; p.velocity.z += (dz / d) * 26;
          }
          game.fx.ring(e.position, 8, [0.6, 0.9, 1], 70);
          game.fx.frost(e.position, 5, 50);
          game.fx.shake(0.8, 0.4);
        } else {
          e.abilityCd = 7;
          shieldAllies(e, game, 220, 12, 0.75);
          summon(e, game, 'orc-frostling', 3, 4);
        }
        return false;
      },
    },
  },
  {
    id: 'orc-king', name: 'The Orc King', tier: 7,
    hp: 9000, speed: 2.6, radius: 1.5, mass: 12,
    armor: 24,
    resist: { physical: 0.6, fire: 0.8, ice: 0.8, arcane: 0.9 },
    damageToRift: 6, coin: 1200, score: 12000,
    attackDamage: 70, attackRate: 1.5, attackRange: 3.6, attackAnim: 1.2,
    scale: 2.1, abilityCooldown: 5,
    aggroChance: 1, aggro: 30, huntTime: 8, leash: 52,
    flags: ['boss', 'unstoppable', 'summoner', 'shielder', 'armored'],
    build: model('orc-king'),
    ai: {
      /**
       *   1. The Guard    — a detachment of Ironhides, every few seconds.
       *   2. The Aegis    — shields his entire horde, and shockwaves you off the line.
       *   3. The Last War — all of it, faster, plus charges through his own army.
       */
      update(e, game, dt) {
        if (updatePhase(e, game, [0.66, 0.33], (b, g, p) => {
          if (p >= 1) b.attackRate = b.def.attackRate * 0.85;
          if (p >= 2) { b.attackRate = b.def.attackRate * 0.65; b.speedBase = b.def.speed * 1.3; }
        })) { e._render(dt, game); return true; }

        if (charge(e, game, dt)) return true;
        if (slamWindup(e, game, dt)) return true;
        if (e.abilityCd > 0) return false;

        const roll = (e._cycle = ((e._cycle ?? -1) + 1) % 3);
        e.abilityCd = 5 - e.phase * 1.2;
        e.state = 'attack'; e.stateT = 0;

        if (roll === 0 || e.phase === 0) {
          summon(e, game, 'orc-armored', 4 + e.phase * 2, 3.6);
          game.audio.play('horde', { position: e.position, pitch: 0.55 });
        } else if (roll === 1) {
          shieldAllies(e, game, 200 + e.phase * 60, 14);
          game.fx.ring(e.position, 6, [0.6, 0.4, 1], 60);
          game.audio.play('magic.shot', { position: e.position, pitch: 0.5 });
        } else if (e.phase === 2) {
          beginCharge(e, 0.8);
          return false;
        } else {
          // The King's shockwave now wrecks rather than deletes, and it telegraphs like
          // an ogre's — a wider ring (7) that he rears back into for a beat first.
          beginSlam(e, game, 7, 45, SLAM_WRECK);
          return true;
        }
        game.fx.shake(0.9, 0.5);
        return false;
      },
    },
  },
];

// Index + flag sets, computed once.
export const ENEMY_BY_ID = new Map();
for (const def of ROSTER) {
  def._flagSet = new Set(def.flags || []);
  ENEMY_BY_ID.set(def.id, def);
}

export function getEnemyDef(id) {
  const d = ENEMY_BY_ID.get(id);
  if (!d) console.warn('unknown enemy id', id);
  return d;
}
