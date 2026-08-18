/**
 * The 10-level wave campaign, authored as *beats* rather than as a flat list of timers.
 *
 * Wave composition is this module's job (see ARCHITECTURE §2), but the tables have
 * historically lived in `src/world/LevelDefs.js`, which the WORLD module owns. These
 * tables are the recommended replacement, in the declarative format `WaveComposer`
 * executes; `WaveDirector.load()` uses them until `LevelDefs` carries beat-format waves
 * of its own, at which point the level file wins automatically and this file becomes a
 * fallback. Nothing here touches geometry, palettes, unlocks or economy — those stay
 * the level's.
 *
 * The shape every wave is built from:
 *
 *   OPENING   something you can beat with what you already own. Establishes the lane.
 *   LULL      2.5–5s of nothing, gated on the opening being mostly dead. This is the
 *             beat that makes you walk somewhere — and therefore the beat the next one
 *             punishes you for.
 *   FLANK     from the door you just left. `lane: 'flank'` resolves to the spawn
 *             furthest from the one the previous beat opened on, so it is geometry,
 *             not flavour.
 *   PUSH      the real wave, gated on the flank so it lands while you are still busy.
 *   BOSS      telegraph -> entrance -> adds released on the boss's own health bar.
 *
 * The curve escalates on three axes independently — geometry (WORLD), roster (ORCS)
 * and *pressure* (here): how many lanes are live at once, how much overlap between
 * beats, and how little room the gates leave between them.
 *
 * `lanes: n` on a wave is the most important of those, and it is set in the GATES table
 * at the bottom. A level with six gates that opens all six in wave 1 is not hard, it is
 * unbuildable: the whole purse buys one trap per gate and the rift is gone before the
 * economy starts. Measured — with every gate live from wave 1, levels 8, 9 and 10 lost
 * the rift inside two waves on every run.
 *
 * Wave sizes here are the ones the simulated campaign converged on (see the module
 * report); they are *not* the sizes that read best on paper. In particular levels 5–10
 * are 15–20% lighter than the tables they replace, because the coin those levels grant
 * buys far fewer traps than their old wave sizes assumed.
 *
 * ── Round 2: the ramp *inside* a level ───────────────────────────────────────
 *
 * The campaign escalated between levels and not within them. Measured across the ten
 * tables, level 9 opened at 40% of its own peak wave HP with a wave made entirely of
 * Ironhides and Shieldbearers, and levels 8 and 10 opened *with* the archetype they were
 * supposed to be teaching. A wave 1 that asks the question before it teaches the answer
 * is not difficulty, it is a reading comprehension test with a rift attached.
 *
 * Two rules now govern every table here, and both are checkable from the tables alone:
 *
 *   WAVE 1 TEACHES. Its first beat is something the player already owns an answer to —
 *   grunts, near enough always. The level's signature threat arrives in the *third* beat,
 *   after the lull, in a dose small enough that losing to it costs a rift point rather
 *   than the level, and carrying the label that names it. No level opens above ~30% of
 *   its own peak wave HP.
 *
 *   NO BACKWARD STEPS. An ordinary wave never drops more than ~8% in total HP below the
 *   one before it. The exception is a *swarm relief* wave — thirty kobolds, six thousand
 *   HP spread across bodies that die to anything — which changes the texture rather than
 *   the pressure, and there is at most one per level. Boss waves are exempt: the spike is
 *   the point.
 */

// --- authoring helpers ------------------------------------------------------
/** A spawn stream: `s('orc-grunt', 12, { gap: 0.4, lane: 'flank' })`. */
const s = (id, count, opts) => (opts ? [id, count, opts] : [id, count]);
/** A beat: concurrent streams plus its pacing. */
const b = (spawn, opts = {}) => ({ spawn, ...opts });
/** Silence. `gate` decides what has to be true before the next beat may open. */
const lull = (hold, gate = { dead: 0.6 }) => ({ spawn: [], hold, gate });
/**
 * A boss entrance: dread, then the thing itself.
 *
 * Always *one* boss. Measured: with a skilled defence, levels 8, 9 and 10 held every
 * ordinary wave without losing a single rift point — and then lost the level outright on
 * the boss wave, every time, because a Warlord that reaches the rift costs 8 of it and
 * those levels only have 12-15. Two bosses is therefore not "twice as hard", it is a coin
 * flip on the whole level. The escalation lives in the adds, which are rationed against
 * the boss's own health bar.
 */
const entrance = (spawn, opts = {}) => ({
  spawn, telegraph: 3.2, boss: true, lane: 'far',
  gate: { alive: 8 }, label: 'THE GROUND SHAKES', ...opts,
});
const w = (beats, opts = {}) => ({ beats, ...opts });

export const CAMPAIGN = [

  // ═══════════════════════════════════════════════════════════ 1 · The Gatehouse
  // One lane, one enemy, one idea: traps kill, you clean up. The only thing wave 3
  // adds is *speed*, so the player feels the difference between HP and pressure.
  //
  // ── Round 3: speed is what makes the hero necessary here ─────────────────────
  // Measured with the no-hero bracket, The Gatehouse *cleared itself*: 18 leaks and a
  // 2/20 rift, but a win. A level a trap row finishes unattended has no hero in it, and
  // this is the level that teaches what a hero is for.
  //
  // The answer had to come out of what level 1 already owns, because introducing an
  // archetype here would cost the level its one idea. It is the kobold. At speed 6.4 a
  // runner crosses a spike tile inside its 1.2s cooldown, so a *pack* of them is not more
  // health for the row to chew — it is bodies arriving in the window the row is spent.
  // The counts below are the smallest that flip the unattended run to a defeat, and the
  // competent bracket still clears at 20/20.
  [
    w([
      b([s('orc-grunt', 5, { gap: 1.0 })]),
      lull(3.0),
      b([s('orc-grunt', 5, { gap: 0.75 })]),
    ]),
    w([
      b([s('orc-grunt', 6, { gap: 0.8 })]),
      lull(3.0),
      b([s('orc-grunt', 10, { gap: 0.5 })], { gate: { dead: 0.5 } }),
    ]),
    w([
      b([s('orc-grunt', 6, { gap: 0.7 })]),
      lull(2.6),
      b([s('kobold-runner', 10, { gap: 0.12 }),
         s('kobold-runner', 10, { gap: 0.12, delay: 0.1 })], { label: 'They are running.' }),
      b([s('orc-grunt', 8, { gap: 0.55 })], { gate: { dead: 0.5 } }),
    ]),
    // It is *burst*, not count, that decides this. Measured: taking the wave-4 runners
    // from 12 to 20 changed the unattended run's leak total by nothing at all — eighteen
    // both times — because a corridor kills at a fixed rate and a longer queue simply
    // waits its turn. Two streams opened together at a 0.1s gap put twenty-eight bodies
    // into the hall inside a second and a half, which is shorter than a spike tile's
    // cooldown, and that is what a row with nobody standing in it cannot answer.
    w([
      b([s('orc-grunt', 8, { gap: 0.6 })]),
      lull(2.4),
      b([s('kobold-runner', 12, { gap: 0.1 }),
         s('kobold-runner', 12, { gap: 0.1, delay: 0.1 })]),
      b([s('orc-grunt', 10, { gap: 0.4 }),
         s('kobold-runner', 16, { gap: 0.1, delay: 1.5 }),
         s('kobold-runner', 16, { gap: 0.1, delay: 1.6 })],
        { gate: { dead: 0.45 }, hold: 0.4 }),
    ]),
  ],

  // ═══════════════════════════════════════════════════════════ 2 · Twin Approach
  // The second door opens in wave 2, not wave 1. From then on every wave opens on one
  // gate and closes on the other: the lull becomes a trap, because walking to the fight
  // is how you lose the lane you left.
  [
    // Wave 1 teaches: the road, and that the far end of it is where you want the traps.
    // It is deliberately still a *one-gate* wave — the second door is wave 2's reveal, and
    // a beat labelled "the other gate" that opens on the same gate teaches the opposite of
    // what it says.
    w([
      b([s('orc-grunt', 8, { gap: 0.7, lane: 0 })]),
      lull(3.2),
      b([s('orc-grunt', 8, { gap: 0.6, lane: 0 })], { label: 'Again, from the same road.' }),
    ]),
    w([
      b([s('orc-grunt', 8, { gap: 0.6, lane: 0 })]),
      lull(2.8),
      b([s('kobold-runner', 12, { gap: 0.25, lane: 'flank' })], { label: 'The other gate.' }),
      b([s('orc-grunt', 10, { gap: 0.5, lane: 'all' })], { gate: { dead: 0.5 } }),
    ]),
    w([
      b([s('orc-brute', 4, { gap: 2.0, lane: 0 })], { label: 'Something heavier.' }),
      lull(3.0, { dead: 0.7 }),
      b([s('orc-grunt', 14, { gap: 0.45, lane: 'flank' })]),
      b([s('orc-brute', 3, { gap: 2.2, lane: 'all' })], { gate: { dead: 0.5 } }),
    ]),
    w([
      b([s('orc-grunt', 12, { gap: 0.45, lane: 'all' })]),
      lull(2.6),
      b([s('kobold-runner', 16, { gap: 0.2, lane: 'flank' })]),
      b([s('orc-grunt', 10, { gap: 0.4, lane: 'all' }), s('orc-brute', 5, { gap: 1.6, lane: 'random', delay: 3 })],
        { gate: { dead: 0.45 } }),
    ]),
    w([
      b([s('orc-brute', 5, { gap: 1.3, lane: 'all' })]),
      lull(2.4, { dead: 0.55 }),
      b([s('orc-grunt', 16, { gap: 0.35, lane: 'flank' })]),
      b([s('orc-grunt', 10, { gap: 0.4, lane: 'all' }), s('orc-brute', 4, { gap: 1.5, lane: 'flank' })],
        { gate: { dead: 0.4 }, hold: 0.5 }),
    ]),
  ],

  // ═══════════════════════════════════════════════════════════ 3 · The Long Descent
  // Armour. Wave 1 shows it inside a grunt wave you can still beat; wave 2 makes it the
  // whole wave; by wave 4 a shaman is healing it back faster than arrows remove it.
  [
    w([
      b([s('orc-grunt', 10, { gap: 0.5 })]),
      lull(3.0),
      b([s('orc-armored', 5, { gap: 1.3 })], { label: 'Arrows will not do it.' }),
    ]),
    w([
      b([s('orc-armored', 6, { gap: 1.1 })]),
      lull(2.8),
      b([s('kobold-runner', 12, { gap: 0.28 })]),
      b([s('orc-armored', 6, { gap: 0.9 })], { gate: { dead: 0.5 } }),
    ]),
    w([
      b([s('orc-grunt', 12, { gap: 0.45 })]),
      lull(2.6),
      // Four brutes, not six. Wave 3 used to peak above wave 4 and then hand the player a
      // 17% quieter shaman wave, which reads as the level running out of ideas rather
      // than as relief.
      b([s('orc-brute', 4, { gap: 1.4 })]),
      b([s('orc-armored', 10, { gap: 0.8 }), s('orc-grunt', 8, { gap: 0.5, delay: 2 })],
        { gate: { dead: 0.45 } }),
    ]),
    // ── Round 3 ────────────────────────────────────────────────────────────────
    // The Long Descent was the campaign's other unattended clear: no hero at all, four
    // leaks, 14 of 18 rift, a win. It is the easiest level in the game to automate because
    // it is one long corridor — every coin buys a tile that everything walks over, and the
    // measured score-to-value ratio is identical (3.3x) whether the player is a bot with
    // no weapon or a money-no-object aimbot. Nothing the *player* does moves it.
    //
    // So the level's own stated lesson has to be made true rather than decorative: "by
    // wave 4 a shaman is healing it back faster than arrows remove it." Shamans arrive in
    // packs now, and behind the armour rather than in front of it, so a static row is
    // topping up a health bar it cannot out-damage while the column walks. Killing the
    // healers is a target-priority decision, and a trap has no opinion about priority.
    w([
      b([s('orc-shaman', 5, { gap: 1.9 })], { label: 'Kill the shamans first.' }),
      lull(2.4, { dead: 0.5 }),
      b([s('orc-armored', 12, { gap: 0.7 })]),
      b([s('orc-grunt', 16, { gap: 0.4 }), s('orc-shaman', 7, { gap: 1.3, delay: 4 })],
        { gate: { dead: 0.45 } }),
    ]),
    w([
      b([s('orc-armored', 10, { gap: 0.7 })]),
      lull(2.2, { dead: 0.5 }),
      b([s('orc-brute', 8, { gap: 1.1 }), s('orc-shaman', 8, { gap: 1.3, delay: 2 })]),
      b([s('orc-armored', 16, { gap: 0.45 }), s('orc-shaman', 6, { gap: 1.8, delay: 3 })],
        { gate: { dead: 0.4 }, hold: 0.5 }),
    ]),
  ],

  // ═══════════════════════════════════════════════════════════ 4 · Chasm Bridge
  // Leapers hop the floor row, so the wave shape puts them *after* the lull, when your
  // best tiles are already on cooldown. Wave 6 introduces the ogre: a health bar that
  // walks, and the first thing that deletes traps just by standing on them.
  [
    // Wave 1 teaches: leapers. It used to be twelve grunts and twelve kobolds — 24 bodies
    // and not one new idea — while the leaper, the whole reason this level exists, waited
    // until wave 2. Four of them, after a lull, against a row you have already watched
    // work on grunts, is the smallest dose that still lands the lesson: the thing you
    // built is not a wall.
    w([
      b([s('orc-grunt', 10, { gap: 0.5 })]),
      lull(2.8),
      b([s('orc-leaper', 4, { gap: 1.2 })], { label: 'They jump.' }),
    ]),
    // Eight kobolds, not twelve. Measured: wave 2 is where this level is won or lost —
    // the bot held waves 3, 4 and 5 with 0-1 leaks and still lost the rift here, because
    // twelve kobolds at speed 6.4 and eight leapers arriving together is a *bodies*
    // problem and the opening purse only ever bought six traps to answer it.
    w([
      b([s('orc-grunt', 12, { gap: 0.45 })]),
      lull(2.8),
      b([s('kobold-runner', 8, { gap: 0.24 })]),
      b([s('orc-leaper', 8, { gap: 0.9 })], { gate: { dead: 0.5 }, label: 'Over the top again.' }),
    ]),
    w([
      b([s('orc-armored', 9, { gap: 0.8 })]),
      lull(2.6),
      b([s('orc-leaper', 10, { gap: 0.7 })]),
      b([s('orc-armored', 5, { gap: 0.7 })], { gate: { dead: 0.5 } }),
    ]),
    w([
      b([s('orc-brute', 5, { gap: 1.3 })]),
      lull(2.4, { dead: 0.5 }),
      b([s('kobold-runner', 14, { gap: 0.19 })]),
      b([s('orc-leaper', 11, { gap: 0.62 }), s('orc-brute', 3, { gap: 1.8, delay: 3 })],
        { gate: { dead: 0.45 } }),
    ]),
    w([
      b([s('orc-armored', 10, { gap: 0.55 })]),
      lull(2.2, { dead: 0.5 }),
      b([s('orc-shaman', 4, { gap: 2.0 }), s('orc-leaper', 9, { gap: 0.6, delay: 2 })]),
      b([s('orc-armored', 9, { gap: 0.5 })], { gate: { dead: 0.4 } }),
    ]),
    // Round 3: Chasm Bridge lost eight of its eighteen rift in this one wave and nothing
    // anywhere else — measured per wave, the floor bracket read 18,18,18,17,17,9. A level
    // whose whole difficulty is its last thirty seconds is a coin flip with a preamble,
    // the same shape round 2 pulled out of The Forge. The ogres stay; what comes off is
    // the crowd walking in with them, so the pair arrive into a corridor the player can
    // still see the floor of.
    w([
      b([s('orc-grunt', 14, { gap: 0.38 })]),
      lull(2.5, { dead: 0.6 }),
      entrance([s('ogre', 2, { gap: 6 })], { label: 'OGRES', telegraph: 2.6 }),
      b([s('orc-armored', 8, { gap: 0.55 })], { gate: { dead: 0.35 } }),
      b([s('orc-leaper', 7, { gap: 0.55 })], { gate: { dead: 0.6 }, hold: 0.4 }),
    ]),
  ],

  // ═══════════════════════════════════════════════════════════ 5 · The Forge
  // Fire immunity, and the campaign's first real boss. Wave 1 is still a single door:
  // the second one opens in wave 2, once the first row of traps is paid for.
  [
    // Wave 1 teaches: fire immunity. One gate, one familiar opening, then four Cinder Orcs
    // walking through the brimstone you just paid for. `lane: 0` and not `flank`, because
    // wave 1 only has one door open and a flank that resolves onto the door you are
    // already standing in teaches nothing.
    w([
      b([s('orc-grunt', 11, { gap: 0.4, lane: 0 })]),
      lull(2.8),
      b([s('orc-firewalker', 4, { gap: 1.1, lane: 0 })], { label: 'Fire will not save you.' }),
    ]),
    w([
      b([s('orc-firewalker', 6, { gap: 0.8, lane: 0 })]),
      lull(2.6),
      b([s('orc-armored', 8, { gap: 0.7, lane: 'flank' })], { label: 'The second gate.' }),
      b([s('orc-firewalker', 2, { gap: 0.8, lane: 'all' })], { gate: { dead: 0.5 } }),
    ]),
    w([
      b([s('kobold-runner', 12, { gap: 0.3, lane: 'random' })]),
      lull(2.4, { dead: 0.65 }),
      b([s('orc-brute', 5, { gap: 1.2, lane: 'all' })]),
      b([s('orc-shaman', 2, { gap: 2.4, lane: 'flank' })], { gate: { dead: 0.45 } }),
    ]),
    w([
      // Leapers appear here only as a garnish. The Forge's kill zone is one short shared
      // choke, and a leaper clears the *whole* of it in a single hop — measured, a wave
      // built around them leaked 37% regardless of size, which is a geometry problem
      // rather than a difficulty one. Chasm Bridge is where leapers are the lesson.
      b([s('orc-firewalker', 8, { gap: 0.55, lane: 'all' })]),
      lull(2.4, { dead: 0.5 }),
      b([s('orc-leaper', 4, { gap: 0.9, lane: 'flank' })]),
      b([s('orc-firewalker', 5, { gap: 0.6, lane: 'all' })], { gate: { dead: 0.4 } }),
    ]),
    w([
      b([s('orc-grunt', 15, { gap: 0.32, lane: 'all' })]),
      lull(2.2, { dead: 0.6 }),
      // One ogre, not two. An ogre leak costs four rift, and this level only has sixteen.
      entrance([s('ogre', 1, { gap: 5 })], { label: 'AN OGRE', telegraph: 2.6 }),
      b([s('orc-armored', 6, { gap: 0.55, lane: 'all' })], { gate: { dead: 0.35 } }),
    ]),
    // ── Round 3: The Forge is still the campaign's spike, and now it is measured ───
    // With the crossbow's line-of-sight bug fixed, the hero contributes far less than
    // every round-2 number assumed — the stand-in had been shooting through the level's
    // own walls. Re-measured on the fixed build, The Forge is the one level a competent
    // build *loses on points*: the floor bracket finished at 5 of 20 rift and even the
    // money-no-object bracket finished at 15 of 20, while every other level in the
    // campaign ends flawless at that bracket. A level that punishes a perfect run harder
    // than the finale does is not the campaign's fifth-hardest level, it is a bug in the
    // curve. Wave 5 and the Warlord's escort come down ~20%; the Warlord does not.
    w([
      b([s('orc-armored', 7, { gap: 0.6, lane: 'all' })]),
      // `alive: 3`, not 10. Measured per wave, every point of rift The Forge takes off a
      // money-no-object run is taken here — 20,20,20,20,20,15 — and it is taken while the
      // player is still clearing the opener with a 3,200hp Warlord already in the hall.
      // Emptying the corridor first does not make the Warlord weaker; it makes the fight
      // legible, which is the difference between a hard boss and an ambush.
      //
      // It is worth being straight about what this does and does not fix. Re-measured at
      // `alive: 6` with a 134-trap killbox and a hero who does not miss, the Warlord still
      // *walked through* — two leaks, five of the level's twenty rift, and that is one
      // unit's `damageToRift: 4` plus an escort. Composition can decide what else is in
      // the hall when he arrives; it cannot decide whether 3,200hp behind 18 armour dies
      // in transit at level 5's trap unlocks. Reported to ORCS/TRAPS.
      lull(3.0, { alive: 3 }),
      entrance([s('orc-warlord', 1)], { label: 'THE WARLORD COMES' }),
      // The Warlord is 3200hp behind 18 armour, so he takes the better part of a minute
      // to bring down. The escort is therefore rationed against *his* health bar rather
      // than dumped on the field: each act is a fresh problem, not a bigger one.
      // Trimmed 11% in round 2. The Forge was the campaign's weakest link on measurement:
      // waves 1-5 were held with *zero* leaks in every run, and then this wave alone took
      // five to thirteen rift out of the level's sixteen, losing two runs in three. A level
      // whose entire difficulty is one wave is not a hard level, it is a coin flip with a
      // long preamble. The escort comes down; the Warlord does not.
      b([s('orc-firewalker', 5, { gap: 0.65, lane: 'all' })], { gate: { bossHp: 0.62 } }),
      b([s('orc-armored', 5, { gap: 0.6, lane: 'flank' })], { gate: { bossHp: 0.36 } }),
      b([s('orc-brute', 2, { gap: 1.2, lane: 'all' })], { gate: { bossHp: 0.15 }, label: 'He is calling them.' }),
    ], { boss: true }),
  ],

  // ═══════════════════════════════════════════════════════════ 6 · Sappers' Run
  // Sappers eat the front row, so the push beats arrive while your best tiles are
  // *gone*, not merely on cooldown. The answer the level wants is depth, not density.
  [
    // Wave 1 teaches: sappers eat traps. Twelve grunts to prove the row works, then five
    // sappers to take it away from you — the lesson only lands if you got to watch the row
    // do its job first.
    w([
      b([s('orc-grunt', 12, { gap: 0.35 })]),
      lull(2.8),
      b([s('orc-sapper', 5, { gap: 1.1 })], { label: 'They came for your traps.' }),
    ]),
    w([
      b([s('orc-sapper', 8, { gap: 0.8 })]),
      lull(2.6),
      b([s('orc-armored', 10, { gap: 0.6 })]),
      b([s('orc-sapper', 6, { gap: 0.7 })], { gate: { dead: 0.5 } }),
    ]),
    w([
      b([s('orc-leaper', 14, { gap: 0.45 })]),
      lull(2.4, { dead: 0.55 }),
      b([s('orc-grunt', 20, { gap: 0.28 })]),
      b([s('orc-sapper', 8, { gap: 0.8 })], { gate: { dead: 0.45 } }),
    ]),
    w([
      b([s('orc-shaman', 6, { gap: 1.5 })]),
      lull(2.2, { dead: 0.5 }),
      // Bloaters land here on purpose: by level 6 the player owns brimstone and has just
      // unlocked the grinder, so they are fully committed to wide sustained damage — and
      // wide sustained damage is exactly what turns one Bloated Orc into four problems.
      b([s('orc-bloater', 7, { gap: 1.2 })], { label: 'Do not pop them in a crowd.' }),
      b([s('orc-sapper', 12, { gap: 0.65 })], { gate: { dead: 0.4 } }),
    ]),
    w([
      b([s('orc-armored', 14, { gap: 0.45 })]),
      lull(2.4, { dead: 0.6 }),
      entrance([s('ogre', 3, { gap: 4 })], { label: 'OGRES', telegraph: 2.6 }),
      b([s('orc-firewalker', 10, { gap: 0.5 }), s('orc-bloater', 4, { gap: 1.4, delay: 3 })],
        { gate: { dead: 0.35 } }),
    ]),
    w([
      b([s('orc-sapper', 12, { gap: 0.5 })]),
      lull(3.0, { alive: 10 }),
      entrance([s('orc-warlord', 1)], { label: 'THE WARLORD COMES' }),
      b([s('orc-grunt', 16, { gap: 0.25 })], { gate: { bossHp: 0.7 } }),
      b([s('orc-sapper', 8, { gap: 0.5 }), s('orc-bloater', 4, { gap: 1.5 })], { gate: { bossHp: 0.45 } }),
      b([s('orc-brute', 5, { gap: 0.9 })], { gate: { bossHp: 0.2 }, label: 'He is calling them.' }),
    ], { boss: true }),
  ],

  // ═══════════════════════════════════════════════════════════ 7 · Frostwatch
  // Three doors, opened one per wave, and the first enemy that ignores the floor
  // entirely. Flyers always arrive on the flank, because the point is that you cannot
  // stand under all three doors at once.
  [
    // Wave 1 teaches: things that ignore the floor. One gate, fourteen grunts to establish
    // the ground row, then five gargoyles straight over it.
    w([
      b([s('orc-grunt', 14, { gap: 0.3, lane: 'all' })]),
      lull(2.8),
      b([s('gargoyle', 5, { gap: 1.1, lane: 'all' })], { label: 'Look up.' }),
    ]),
    w([
      b([s('gargoyle', 10, { gap: 0.7, lane: 'all' })]),
      lull(2.6),
      b([s('orc-armored', 10, { gap: 0.5, lane: 'flank' })]),
      b([s('gargoyle', 3, { gap: 0.6, lane: 'random' })], { gate: { dead: 0.5 } }),
    ]),
    w([
      b([s('orc-frostling', 12, { gap: 0.55, lane: 'all' })]),
      lull(2.4, { dead: 0.55 }),
      b([s('orc-leaper', 14, { gap: 0.45, lane: 'flank' })]),
      b([s('orc-frostling', 6, { gap: 0.5, lane: 'all' })], { gate: { dead: 0.45 } }),
    ]),
    w([
      b([s('orc-brute', 6, { gap: 0.75, lane: 'all' })]),
      lull(2.2, { dead: 0.5 }),
      // Stalkers arrive the level *after* guardians become the obvious answer to three
      // gates you cannot personally cover. They are invisible to every guardian until
      // they land the first hit, so a defence you fully automated is a defence with a
      // hole in it.
      b([s('shadow-stalker', 4, { gap: 1.2, lane: 'flank' })], { label: 'Something you cannot see.' }),
      b([s('gargoyle', 10, { gap: 0.55, lane: 'all' })], { gate: { dead: 0.45 } }),
      b([s('orc-sapper', 8, { gap: 0.55, lane: 'all' })], { gate: { dead: 0.4 } }),
    ]),
    // ── Round 3: which units actually punish an absent player ───────────────────
    // Frostwatch cleared itself. No hero at all, and the unattended row finished the level
    // on 1 of 20 rift — a win, and the rule is that no level may be won that way.
    //
    // The instructive part is *why the first attempt failed*. Stalkers and gargoyles were
    // added across levels 8-10 because they are the two archetypes that cross lanes and
    // come looking for the hero, which is a real and separate problem. But a unit that
    // hunts the hero does nothing at all when there is no hero: it walks the same route as
    // everything else and dies to the same tiles. The anti-idle archetypes are the ones
    // that attack the *defence* — sappers, which eat the floor row, and ogres, whose slam
    // wrecks whatever is under it. Frostwatch had eight sappers in one wave out of seven.
    // It now has them in three, and they arrive with the ogres rather than instead.
    w([
      b([s('orc-frostling', 12, { gap: 0.4, lane: 'all' })]),
      lull(2.4, { dead: 0.6 }),
      entrance([s('ogre', 3, { gap: 3.5 })], { label: 'OGRES', telegraph: 2.6 }),
      b([s('gargoyle', 10, { gap: 0.55, lane: 'flank' }),
         s('orc-sapper', 8, { gap: 0.6, lane: 'all' })], { gate: { dead: 0.35 } }),
    ]),
    w([
      b([s('orc-shaman', 6, { gap: 1.3, lane: 'all' })]),
      lull(2.2, { dead: 0.5 }),
      b([s('orc-armored', 12, { gap: 0.35, lane: 'flank' }), s('shadow-stalker', 3, { gap: 2.0, lane: 'random' })]),
      b([s('gargoyle', 16, { gap: 0.45, lane: 'all' }),
         s('orc-sapper', 10, { gap: 0.55, lane: 'all' })], { gate: { dead: 0.4 } }),
    ]),
    w([
      b([s('orc-frostling', 14, { gap: 0.4, lane: 'all' })]),
      lull(3.0, { alive: 10 }),
      entrance([s('frost-warlord', 1)], { label: 'THE FROST WARLORD' }),
      b([s('orc-frostling', 16, { gap: 0.4, lane: 'all' }),
         s('orc-sapper', 10, { gap: 0.5, lane: 'all' })], { gate: { bossHp: 0.8 } }),
      b([s('gargoyle', 14, { gap: 0.4, lane: 'flank' })], { gate: { bossHp: 0.5 } }),
      b([s('orc-brute', 8, { gap: 0.8, lane: 'all' }), s('ogre', 2, { gap: 3, lane: 'random' })],
        { gate: { bossHp: 0.25 }, label: 'The traps are freezing.' }),
    ], { boss: true }),
  ],

  // ═══════════════════════════════════════════════════════════ 8 · The Warcamp
  // Four doors around a central rift, opened two at a time, so "flank" is genuinely
  // behind you. Shields block the front; archers shoot the guardians you put there to
  // fix that.
  [
    // Wave 1 teaches: shields, and that they only face one way.
    //
    // It used to open *on* the Shieldbearers and then hand you twenty-two grunts, which is
    // backwards twice over: the new archetype arrived before there was anything to compare
    // it to, and the label that names the answer was attached to the beat made of grunts.
    // Now the grunts establish the two lanes, and the Shieldbearers walk into a row you
    // have already watched work — so "it did not die this time" is legible instead of
    // being one more thing happening at once.
    w([
      b([s('orc-grunt', 16, { gap: 0.32, lane: 'all' })]),
      lull(2.8),
      b([s('orc-shieldbearer', 5, { gap: 0.9, lane: 'flank' })], { label: 'Hit them from the side.' }),
    ]),
    w([
      b([s('orc-shieldbearer', 6, { gap: 0.7, lane: 'all' }),
         s('orc-warchanter', 3, { gap: 2.2, lane: 'all', delay: 2 })],
        { label: 'The drums shield the whole rank.' }),
      lull(2.6),
      // Ten, not fourteen. ORCS measured six archers and twenty archers doing the *same*
      // damage to a hero — the hero's 0.35s invulnerability window caps it — so the back
      // fourteen of a twenty-archer beat are wasted on the player and land entirely on
      // undefended masonry instead. Archers are rationed and spread from here on.
      b([s('orc-archer', 10, { gap: 0.6, lane: 'flank' })], { label: 'Archers. They outrange you.' }),
    ]),
    w([
      b([s('orc-armored', 14, { gap: 0.35, lane: 'all' })]),
      lull(2.4, { dead: 0.55 }),
      b([s('gargoyle', 8, { gap: 0.5, lane: 'flank' }),
         s('shadow-stalker', 4, { gap: 1.6, lane: 'random' })],
        { label: 'Something is hunting you.' }),
      b([s('orc-archer', 8, { gap: 0.5, lane: 'random' })], { gate: { dead: 0.45 } }),
    ]),
    w([
      b([s('orc-warchanter', 5, { gap: 1.4, lane: 'all' }), s('orc-shaman', 4, { gap: 1.4, lane: 'all', delay: 1 })]),
      lull(2.2, { dead: 0.5 }),
      b([s('orc-shieldbearer', 8, { gap: 0.55, lane: 'flank' })]),
      b([s('orc-sapper', 10, { gap: 0.55, lane: 'all' }), s('shadow-stalker', 5, { gap: 1.5, lane: 'random' })],
        { gate: { dead: 0.4 } }),
    ]),
    // ── Round 3 ────────────────────────────────────────────────────────────────
    // The Warcamp is one of the two levels the critic could not finish with the build
    // that walked The Black Throne, and the diagnosed cause was geometry rather than
    // waves: its rift stands in an open room, so the barricades that turn levels 9 and 10
    // into a one-tile spine buy nothing here and the money spent on them is simply gone.
    // WORLD owns that. What this file owes the level is the other half — it should not
    // also be the third-hardest wave table in the game while the room is being fixed. The
    // back three waves come down ~12%, and the ogre escort from three to two.
    // The back three waves were cut ~12% in the first round-3 pass, on the theory that The
    // Warcamp should not also be a hard wave table while WORLD fixes its room. Measured,
    // that went too far in the wrong currency: the level became an *unattended clear at
    // full rift* — no hero, 20 of 20, 8,686 coin spare. The cut had come out of the
    // ogres and archers, which are the units that break an unrepaired row, and the
    // stalkers added in their place hunt a hero who is not there. Bulk and counters are
    // not interchangeable. The counters are restored to their original strength and the
    // stalkers are additional rather than instead.
    w([
      b([s('orc-frostling', 14, { gap: 0.36, lane: 'all' })]),
      lull(2.4, { dead: 0.6 }),
      entrance([s('ogre', 3, { gap: 3 })], { label: 'OGRES', telegraph: 2.6 }),
      b([s('orc-archer', 12, { gap: 0.45, lane: 'flank' }),
         s('orc-sapper', 8, { gap: 0.55, lane: 'all' }),
         s('shadow-stalker', 4, { gap: 1.6, lane: 'random' })], { gate: { dead: 0.35 } }),
    ]),
    w([
      b([s('orc-shieldbearer', 12, { gap: 0.45, lane: 'all' })]),
      lull(2.2, { dead: 0.5 }),
      b([s('orc-leaper', 14, { gap: 0.36, lane: 'flank' }),
         s('shadow-stalker', 5, { gap: 1.5, lane: 'random' })]),
      b([s('gargoyle', 14, { gap: 0.42, lane: 'random' }),
         s('orc-sapper', 10, { gap: 0.5, lane: 'all' })], { gate: { dead: 0.4 } }),
    ]),
    w([
      b([s('orc-shieldbearer', 12, { gap: 0.45, lane: 'all' })]),
      lull(3.0, { alive: 12 }),
      entrance([s('orc-warlord', 1)], { label: 'THE WARLORD' }),
      b([s('orc-shieldbearer', 12, { gap: 0.45, lane: 'all' }), s('orc-warchanter', 5, { gap: 1.6, lane: 'all' })],
        { gate: { bossHp: 0.7 } }),
      b([s('orc-archer', 12, { gap: 0.4, lane: 'flank' }),
         s('orc-sapper', 10, { gap: 0.5, lane: 'all' }),
         s('shadow-stalker', 5, { gap: 1.5, lane: 'random' })], { gate: { bossHp: 0.45 } }),
      b([s('ogre', 3, { gap: 2.5, lane: 'random' })], { gate: { bossHp: 0.2 }, label: 'He is calling them.' }),
    ], { boss: true }),
  ],

  // ═══════════════════════════════════════════════════════════ 9 · Sundered Halls
  // Everything at once, and the first level where beats deliberately *overlap*: the push
  // gates open at 35% dead, so the previous beat is still walking when the next lands.
  //
  // ── Round 3: it was harder than the finale ───────────────────────────────────
  // Re-measured on the line-of-sight-fixed build, the competent bracket finished Sundered
  // Halls at 6 of 22 rift and The Black Throne at 19 of 25. The penultimate level cannot
  // be the campaign's hardest — it takes the finale's job, and the player who loses here
  // never sees the Orc King. The overlap *shape* is the level's identity and is untouched;
  // what comes down is the weight it lands with, roughly 15% across waves 3-8.
  [
    // Wave 1 teaches: beats overlap here.
    //
    // This was the worst opening in the campaign — sixteen Ironhides and ten Shieldbearers
    // with no grunt in sight, 40% of the level's own peak wave HP, arriving before the
    // player had bought a single trap. Measured, it was the largest wave-1-to-peak ratio
    // of any level by a factor of two.
    //
    // Sundered Halls has no signature *archetype* to teach — its identity is that the
    // pushes land while the last beat is still walking. So wave 1 teaches that instead,
    // once, slowly: a familiar opening, a lull, the heavies, and then a third beat gated
    // at 35% dead so it arrives on top of them. Same lesson as the rest of the level, at a
    // third of the weight.
    w([
      b([s('orc-grunt', 14, { gap: 0.35, lane: 'all' })]),
      lull(2.6),
      b([s('orc-armored', 8, { gap: 0.6, lane: 'flank' })]),
      b([s('orc-shieldbearer', 4, { gap: 0.9, lane: 'all' })],
        { gate: { dead: 0.35 }, label: 'They are not waiting for each other.' }),
    ]),
    w([
      b([s('gargoyle', 12, { gap: 0.45, lane: 'all' })]),
      lull(2.4, { dead: 0.55 }),
      b([s('orc-archer', 10, { gap: 0.5, lane: 'flank' }),
         s('gargoyle', 6, { gap: 0.8, lane: 'random', delay: 3 })]),
    ]),
    w([
      b([s('kobold-runner', 24, { gap: 0.15, lane: 'random' })]),
      lull(2.2, { dead: 0.65 }),
      b([s('orc-leaper', 14, { gap: 0.34, lane: 'flank' }),
         s('shadow-stalker', 4, { gap: 1.6, lane: 'random' })]),
      // A swarm wave, then bloaters into the same killbox. Whatever cleared the kobolds
      // is exactly the wrong tool for what comes next.
      b([s('orc-sapper', 10, { gap: 0.48, lane: 'all' }), s('orc-bloater', 5, { gap: 1.2, lane: 'all' })],
        { gate: { dead: 0.4 } }),
    ]),
    w([
      b([s('orc-shaman', 7, { gap: 1.0, lane: 'all' }), s('orc-warchanter', 5, { gap: 1.4, lane: 'all' })]),
      lull(2.2, { dead: 0.5 }),
      b([s('orc-firewalker', 14, { gap: 0.4, lane: 'flank' }),
         s('shadow-stalker', 4, { gap: 1.6, lane: 'random' })]),
      entrance([s('ogre', 2, { gap: 3 })], { label: 'OGRES', telegraph: 2.4, gate: { dead: 0.4 } }),
    ]),
    w([
      b([s('orc-frostling', 15, { gap: 0.34, lane: 'all' })]),
      lull(2.0, { dead: 0.5 }),
      b([s('orc-shieldbearer', 12, { gap: 0.45, lane: 'flank' }),
         s('shadow-stalker', 5, { gap: 1.5, lane: 'random' })]),
      b([s('gargoyle', 10, { gap: 0.45, lane: 'random' })], { gate: { dead: 0.35 } }),
    ]),
    w([
      b([s('orc-armored', 17, { gap: 0.3, lane: 'all' })]),
      lull(2.2, { dead: 0.55 }),
      entrance([s('troll', 2, { gap: 4 })], { label: 'CAVE TROLLS', telegraph: 2.4 }),
      b([s('orc-archer', 9, { gap: 0.5, lane: 'flank' }),
         s('shadow-stalker', 5, { gap: 1.5, lane: 'random' }),
         s('gargoyle', 6, { gap: 0.7, lane: 'random', delay: 4 })], { gate: { dead: 0.35 } }),
    ]),
    w([
      b([s('orc-sapper', 12, { gap: 0.42, lane: 'all' }), s('shadow-stalker', 4, { gap: 1.7, lane: 'random' })]),
      lull(3.0, { alive: 12 }),
      entrance([s('orc-warlord', 1)], { label: 'THE WARLORD' }),
      b([s('ogre', 2, { gap: 2.5, lane: 'random' })], { gate: { bossHp: 0.6 } }),
      b([s('orc-sapper', 10, { gap: 0.42, lane: 'flank' }), s('orc-warchanter', 4, { gap: 1.7, lane: 'all' })],
        { gate: { bossHp: 0.3 } }),
    ], { boss: true }),
    w([
      b([s('orc-shieldbearer', 12, { gap: 0.42, lane: 'all' }), s('orc-warchanter', 4, { gap: 1.8, lane: 'all' })]),
      lull(2.4, { dead: 0.5 }),
      entrance([s('troll', 2, { gap: 3 })], { label: 'CAVE TROLLS', telegraph: 2.6 }),
      b([s('gargoyle', 14, { gap: 0.35, lane: 'flank' }), s('shadow-stalker', 4, { gap: 1.6, lane: 'random' })],
        { gate: { dead: 0.35 } }),
      b([s('orc-leaper', 14, { gap: 0.32, lane: 'all' }), s('orc-bloater', 5, { gap: 1.2, lane: 'all' })],
        { gate: { dead: 0.45 }, hold: 0.5 }),
    ], { boss: true }),
  ],

  // ═══════════════════════════════════════════════════════════ 10 · The Black Throne
  // Six gates, and the campaign spends eight waves handing them over. The finale is a
  // three-act fight: the King arrives alone and telegraphed, then every act of his own
  // health bar opens another door.
  [
    // Wave 1 teaches: two of the six doors, and what is going to come out of them.
    //
    // Already the gentlest opening in the back half by HP, but it opened *with* twelve
    // Ironhides — the level's first impression was a wall of armour arriving before the
    // player owned an answer to armour on this map. The grunts go first now, so the
    // Ironhides read as an escalation rather than as the baseline, and the Shieldbearers
    // are a taste rather than a beat.
    w([
      b([s('orc-grunt', 14, { gap: 0.3, lane: 'all' })]),
      lull(2.6),
      b([s('orc-armored', 8, { gap: 0.45, lane: 'flank' })]),
      b([s('orc-shieldbearer', 4, { gap: 0.5, lane: 'all' })], { gate: { dead: 0.4 } }),
    ]),
    // ── Round 3: the finale had almost nothing that came looking for you ─────────
    // ORCS measured a hero holding a good post on The Black Throne through seven waves at
    // 150/150 hp — untouched — with 41 player hits total across four waves and a closest
    // approach of 17.6 m. On a six-gate map the hero can only stand in one place, so a
    // table made of units that walk the shortest path to the rift simply never meets them.
    // Stalkers (20 m notice, 34 m leash) and gargoyles (which dive to 1.4 m and ignore
    // geometry) are the two archetypes that cross lanes, and they now appear in every wave
    // from three onward rather than in two of eight. The twenty-strong gargoyle and archer
    // beats are broken up in the same pass: twenty archers do the same damage to a hero as
    // six, and the surplus lands on unattended traps instead of on the player.
    w([
      b([s('gargoyle', 12, { gap: 0.4, lane: 'all' })]),
      lull(2.4, { dead: 0.55 }),
      b([s('orc-archer', 10, { gap: 0.45, lane: 'flank' }),
         s('gargoyle', 8, { gap: 0.7, lane: 'random', delay: 3 })]),
    ]),
    w([
      b([s('orc-sapper', 12, { gap: 0.45, lane: 'all' }), s('orc-bloater', 5, { gap: 1.2, lane: 'all' }),
         s('shadow-stalker', 4, { gap: 1.6, lane: 'random', delay: 4 })]),
      lull(2.4, { dead: 0.55 }),
      // No trolls, no ogres before wave 6 on this level. The Black Throne has twelve rift
      // and anything with damageToRift 4 turns one slip into a third of the level. The
      // heavy units arrive in wave 6, once the player can afford forty traps.
      b([s('orc-armored', 14, { gap: 0.35, lane: 'flank' })]),
    ]),
    w([
      b([s('orc-shaman', 10, { gap: 0.8, lane: 'all' }), s('orc-warchanter', 6, { gap: 1.3, lane: 'all' })]),
      lull(2.2, { dead: 0.5 }),
      b([s('orc-firewalker', 16, { gap: 0.32, lane: 'flank' }),
         s('shadow-stalker', 5, { gap: 1.5, lane: 'random' })]),
      b([s('orc-frostling', 16, { gap: 0.32, lane: 'random' })], { gate: { dead: 0.35 } }),
    ]),
    w([
      b([s('kobold-runner', 30, { gap: 0.12, lane: 'random' })]),
      lull(2.0, { dead: 0.7 }),
      b([s('orc-leaper', 20, { gap: 0.28, lane: 'flank' }), s('shadow-stalker', 6, { gap: 1.4, lane: 'random' })]),
      b([s('orc-frostling', 16, { gap: 0.32, lane: 'all' }),
         s('gargoyle', 8, { gap: 0.6, lane: 'random' })], { gate: { dead: 0.4 } }),
    ]),
    // Two boss waves on this level, not three. A Warlord that walks past you costs 8 of
    // the level's 12 rift and the campaign's own defences cannot reliably kill 3200hp
    // behind 18 armour in transit, so every extra boss is another whole-level coin flip.
    // Wave 6 is therefore the heaviest *ordinary* wave in the game instead: the horde
    // without a nameplate on it.
    w([
      b([s('orc-shieldbearer', 18, { gap: 0.32, lane: 'all' })]),
      lull(2.6, { alive: 14 }),
      b([s('orc-armored', 22, { gap: 0.28, lane: 'flank' }), s('orc-warchanter', 6, { gap: 1.5, lane: 'all' })]),
      entrance([s('ogre', 2, { gap: 2.6 })], { label: 'OGRES', telegraph: 2.4, gate: { dead: 0.4 } }),
      b([s('gargoyle', 12, { gap: 0.36, lane: 'flank' }),
         s('shadow-stalker', 6, { gap: 1.4, lane: 'random' })], { gate: { dead: 0.45 } }),
    ]),
    // The Black Throne has exactly one boss, and it is the King. A Frost Warlord here
    // was an automatic loss and not an interesting one: it freezes every trap within ten
    // metres for four seconds out of every six, so it walks a corridor that is switched
    // off, and it costs 8 of this level's 12 rift when it arrives. Measured, that ended
    // the run on wave 7 every time, whoever was playing. It stays the boss of Frostwatch,
    // where the rift can absorb it.
    w([
      // The breath before the King. It steps *down* from wave 6 on purpose — but by 20%,
      // not the 29% it used to, because a drop that deep reads as the level having peaked
      // early rather than as the room going quiet.
      b([s('orc-armored', 20, { gap: 0.25, lane: 'all' })]),
      lull(2.4, { dead: 0.5 }),
      entrance([s('troll', 3, { gap: 3 })], { label: 'CAVE TROLLS', telegraph: 2.6 }),
      b([s('orc-frostling', 18, { gap: 0.32, lane: 'flank' }),
         s('shadow-stalker', 6, { gap: 1.4, lane: 'random' }),
         s('gargoyle', 6, { gap: 0.7, lane: 'random', delay: 5 })], { gate: { dead: 0.4 } }),
    ]),
    w([
      b([s('orc-shieldbearer', 18, { gap: 0.3, lane: 'all' })]),
      lull(3.5, { alive: 12 }),
      entrance([s('orc-king', 1)], { telegraph: 4.5, label: 'THE ORC KING' }),
      b([s('ogre', 3, { gap: 2.2, lane: 'random' }), s('orc-warchanter', 5, { gap: 1.6, lane: 'all' })],
        { gate: { bossHp: 0.85 } }),
      b([s('gargoyle', 16, { gap: 0.3, lane: 'flank' }), s('shadow-stalker', 6, { gap: 1.4, lane: 'random' })],
        { gate: { bossHp: 0.62 }, label: 'The sky opens.' }),
      b([s('orc-sapper', 14, { gap: 0.32, lane: 'all' }), s('orc-bloater', 8, { gap: 1.0, lane: 'all' })],
        { gate: { bossHp: 0.40 }, label: 'They are eating your walls.' }),
      b([s('orc-shieldbearer', 14, { gap: 0.3, lane: 'random' }), s('ogre', 2, { gap: 3, lane: 'flank' })],
        { gate: { bossHp: 0.18 }, label: 'EVERYTHING HE HAS LEFT' }),
    ], { boss: true, finale: true }),
  ],
];

/**
 * How many of a level's spawn gates are live, wave by wave. Kept as a table rather than
 * inline so the escalation is legible as a *shape*: every multi-gate level opens on one
 * or two doors and earns its way up to all of them. `null` = single-gate level.
 *
 * Gate counts resolve to markers spread as far apart as the map allows (see
 * `WaveComposer._laneSubset`), so "two gates" always means opposite ends, never adjacent.
 */
const GATES = [
  null,                          // 1  one road in
  [1, 2, 2, 2, 2],               // 2  the second door opens in wave 2
  null,                          // 3
  null,                          // 4
  [1, 2, 2, 2, 2, 2],            // 5
  null,                          // 6
  // Note the floor of *two* on levels 8-10. Counter-intuitively, funnelling a big wave
  // down a single corridor is harder than splitting it across two, because trap
  // throughput is capped by cooldown per tile: one lane saturates while the other row
  // sits idle. Measured, forcing wave 1 of The Warcamp to one gate tripled its leaks.
  [1, 2, 2, 3, 3, 3, 3],         // 7  three gates, earned
  [2, 2, 3, 3, 4, 4, 4],         // 8
  [2, 2, 3, 3, 4, 4, 4, 4],      // 9
  [2, 3, 3, 4, 4, 5, 5, 6],      // 10 all six only for the King
];
GATES.forEach((g, i) => {
  if (!g) return;
  CAMPAIGN[i].forEach((wave, j) => { if (g[j]) wave.lanes = g[j]; });
});

export default CAMPAIGN;
