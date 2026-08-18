/**
 * The campaign's tuning constants, in one place, so the curve can be argued about
 * instead of guessed at.
 *
 * Everything here was set from simulation, not taste: `src/director/devHarness.js`
 * plays every level end-to-end with a deterministic "competent build" bot (traps
 * layered from the rift outward along the *actual* enemy route, spending exactly the
 * coin the level grants) and a crossbow stand-in for the hero, and reports clear time,
 * leaks, rift and score per wave. See the module report for the measured tables.
 *
 * ── Round 2: why the numbers here moved ──────────────────────────────────────
 *
 * Three findings drove this file's rewrite, and all three were the same mistake in
 * different clothes — a single scalar standing in for a shape.
 *
 *   1. `skulls()` was `score / par` and nothing else. One axis cannot produce a rating
 *      worth chasing: whatever the threshold, the player either clears it every time or
 *      never, and either way there is no second run. Measured on the shipped build, a
 *      casual level-1 clear scored 1.9-2.2x par and level 3 hit 3.4x — five skulls was
 *      the *default* outcome. The rating is now the minimum of three axes that pull
 *      against each other (below).
 *
 *   2. Coin scaled with lane count as `1 + 0.2*(lanes-1)`, which is close to not scaling
 *      at all. Measured across the campaign, coin per point of enemy HP *per live lane*
 *      fell 6.6x from level 1 to level 10 (0.97 -> 0.15) while the number of doors you
 *      have to stock went 1 -> 6. See `laneFactor`.
 *
 *   3. Wave sizes escalated between levels but not inside them, so a level's opening wave
 *      was sized like its closing one. That is a `campaign.js` problem, fixed there.
 */

// ═══════════════════════════════════════════════════════════════ the skull rating

/**
 * Five skulls, on three axes that fight each other.
 *
 * The rating is `min(scoreTier, riftTier, timeTier)`. Not a weighted sum — a sum lets a
 * huge score paper over a shredded rift, which is exactly the failure the old single-axis
 * rating had. A minimum means the rating names your *weakest* discipline, and the results
 * screen can tell you which one to fix. That is the replay driver.
 *
 * The three axes are antagonistic by construction, because the build phase has no timer:
 *
 *   RIFT   rewards spending longer in the build phase and starting waves only when the
 *          next row is finished and paid for.
 *   TIME   is the whole-level clock, build phases included. Every second you spend
 *          deliberating is on it. It rewards starting waves before you are ready.
 *   SCORE  is bought with combo, and combo is bought by standing in the killbox while
 *          the wave is thick — which is where you leak from if you guessed wrong.
 *
 * So five skulls means: you did not lose a single rift point, you did it on a clock that
 * assumes you skipped half your build phases, and you held a high combo throughout. Any
 * two of those are reachable; all three at once is the run you replay for.
 *
 * Each row is the threshold for 5, 4, 3, 2, 1 skulls in that order.
 *
 * ── Round 3: the score axis was dominant and dead ────────────────────────────
 *
 * The `min()` was right and the axis was broken. A hostile critic played all ten levels
 * and every single win came back `skulls: 1, limiter: "score"` — ten for ten. The decisive
 * measurement was a flawless, money-no-object clear of The Black Throne: 400,000 coin, 80
 * fully-upgraded traps, 0 leaks, 25/25 rift, 500 kills, 0.68x par time. It read
 * `scoreRatio: 0.50`. Five skulls needed 1.55, so the fifth skull was three times the
 * score of a literally perfect run: unreachable, on every level, forever.
 *
 * The cause was an anchor that was never checked against a playthrough. `PAR_SCORE_MULT`
 * was 4.0 and `PAR_SCORE_TWEAK` was *already* the per-level achieved multiplier normalised
 * to level 1 — so par came out at almost exactly twice what the campaign's own best run
 * scores, everywhere, by construction. Every level therefore read ~0.50 and the minimum
 * named `score` every time.
 *
 * It is now anchored on measurement and on the *top* of the range rather than a guess at
 * the middle. `devHarness.BRACKETS` plays each level four ways — no hero at all, a
 * competent build with 60% accuracy, a strong run, and a money-no-object aimbot that
 * reproduces the critic's own end state — and par is set so the last of those lands at
 * 1.62. See `PAR_SCORE_MULT` for the derivation and the resulting spread.
 */
export const SKULL_AXES = {
  /**
   * score / par.score — higher is better.
   *
   * Re-spaced in round 3 onto the measured range. Against the four brackets, averaged
   * across the campaign, the ratios land at roughly 0.55 / 1.17 / 1.28 / 1.62 — so the
   * rungs below sit *between* brackets rather than above all of them.
   */
  score: [1.50, 1.25, 1.05, 0.75, 0.42],
  /** rift.hp / rift.max at victory — higher is better. 5 skulls is *flawless*. */
  rift: [1.00, 0.86, 0.62, 0.34, 0.01],
  /** levelTime / par.time — LOWER is better, so this row reads as a ceiling. */
  time: [0.88, 1.02, 1.24, 1.60, Infinity],
};

export const AXIS_LABEL = { score: 'SCORE', rift: 'RIFT', time: 'TIME' };

/**
 * Resolve the three measured ratios into a rating plus its reason.
 *
 * `limiter` is the axis that held the rating down — it is the single most useful thing
 * the results screen can say, and the reason a player runs the level again.
 */
export function rate({ scoreRatio, riftFrac, timeRatio, won }) {
  const tierOf = (row, v, lower) => {
    for (let i = 0; i < row.length; i++) {
      if (lower ? v <= row[i] : v >= row[i]) return 5 - i;
    }
    return 0;
  };
  const axes = {
    score: tierOf(SKULL_AXES.score, scoreRatio, false),
    rift: tierOf(SKULL_AXES.rift, riftFrac, false),
    time: tierOf(SKULL_AXES.time, timeRatio, true),
  };
  // Losing the level is zero skulls whatever the score was; winning is worth at least one.
  const raw = Math.min(axes.score, axes.rift, axes.time);
  let skulls = raw;
  if (!won) skulls = 0;
  else skulls = Math.max(1, skulls);

  // Match the limiter against the *unfloored* minimum. Matching the floored rating meant
  // that any run with a zero-tier axis reported `limiter: null` — the exact runs that most
  // need to be told what went wrong — and the results screen then congratulated a
  // one-skull clear as flawless.
  let limiter = null;
  if (won && skulls < 5) {
    for (const k of ['rift', 'time', 'score']) if (axes[k] === raw) { limiter = k; break; }
  }
  return { skulls, axes, limiter };
}

// ═══════════════════════════════════════════════════════════════ par

/**
 * Par score is *derived*, not tabled.
 *
 * The old `PAR[]` array was a list of ten numbers copied out of ten bot runs, which meant
 * every wave-table edit silently invalidated it and nobody could tell by reading the file.
 * Par is now a multiple of the level's own base score value — the sum of `def.score` over
 * every orc the level will ever spawn, which `WaveDirector.levelPlan()` computes by
 * compiling all of the waves at load. Edit a wave and par moves with it.
 *
 * The multiple is what a good run *extracts* from that base: the combo multiplier on every
 * kill, plus the wave bonuses.
 *
 * ── Round 3: anchored on the ceiling, not on a guess at the middle ────────────
 *
 * The previous shape of this was `PAR_SCORE_MULT * PAR_SCORE_TWEAK[level]`, and it was
 * broken in a way that reading it could not reveal: the tweak table was *already* each
 * level's measured achieved multiplier normalised to level 1, and the 4.0 was supposed to
 * be an independent anchor. Multiplying them squared the calibration. Par came out at
 * about twice what the campaign's own best run can score, on every level, so the fifth
 * skull sat at three times a perfect clear and `score` was the limiter for every rating
 * the game has ever produced.
 *
 * Par is now one number per level and one constant, and both are directly interpretable:
 *
 *   PERFECT_SCORE_MULT[i]   what a perfect clear of that level actually scores, as a
 *                           multiple of the level's own base value. Measured.
 *   PAR_AT_PERFECT          where that perfect clear should land on the ladder.
 *
 *   par = value * PERFECT_SCORE_MULT[i] / PAR_AT_PERFECT
 *
 * There is nothing left to square, and the failure mode is now legible: if par is wrong,
 * exactly one of those two numbers is wrong, and the harness measures the first of them
 * directly.
 */

/**
 * Where a perfect clear lands on the score axis.
 *
 * 1.62 sits just above the fifth skull's 1.50, so a flawless money-no-object run scores
 * five and has a little room to spare — "near the top of the ladder", not pinned to its
 * last rung, because a threshold you can only hit exactly is a threshold you miss.
 */
export const PAR_AT_PERFECT = 1.62;

/**
 * The measured score ceiling of each level, as `score / plan.value`.
 *
 * From `devHarness.BRACKETS.perfect`: a hero who does not miss, engaging to the crossbow's
 * full 30 m, waves started the instant the shop opens, and six times the coin — which
 * reproduces the end state the critic reached on The Black Throne by hand (they finished
 * with 400,000 coin and 80 fully-upgraded traps; the bracket finishes with 178,000 and
 * 134). All ten runs are victories and all but The Forge are flawless.
 *
 * These are not all the same number for a reason worth keeping in view: score is base
 * value times the live combo, and combo is bought with kill *rate*. A level whose waves
 * arrive thick and continuously into one shared killbox hands the same player a far higher
 * average multiplier than one that is mostly walking. The Black Throne affords 7.38x its
 * own base value; The Forge affords 2.11x. Without a per-level ceiling the axis would
 * mostly be reporting which level you picked.
 *
 * They are stable to about ±3% run to run, and the fifth skull sits 0.12 below the anchor,
 * so a stale entry has to be ~8% out before it changes a rating. Re-measure after any
 * material wave-table edit: `BRACKETS.perfect` on the level, and read `mult` off the row.
 *
 * The Forge is the outlier and it is an honest one: even this bracket leaks twice there
 * (see the level's note in `campaign.js`), and a leak wipes the combo outright, so its
 * ceiling is genuinely lower than its neighbours'. It is left measured rather than
 * smoothed — if the Warlord stops walking through a 134-trap killbox, this number moves.
 */
export const PERFECT_SCORE_MULT = [
  5.26, // 1  The Gatehouse       20/20   5 skulls
  3.06, // 2  Twin Approach       20/20   5
  3.84, // 3  The Long Descent    18/18   5
  3.52, // 4  Chasm Bridge        18/18   5
  2.11, // 5  The Forge           15/20   3 — the Warlord walks through; limiter RIFT
  3.90, // 6  Sappers' Run        20/20   5
  3.58, // 7  Frostwatch          20/20   5
  4.56, // 8  The Warcamp         19/20   4 — one ogre through; limiter RIFT
  4.52, // 9  Sundered Halls      22/22   5
  7.38, // 10 The Black Throne    25/25   5 — 0.50x par time, axes all 5, limiter null
];

export function parScore(levelIndex, levelValue) {
  // The fallback is the campaign mean, so a level added without a measurement gets a
  // sane par instead of a silent 1.0 that would hand out five skulls.
  const ceiling = PERFECT_SCORE_MULT[levelIndex] ?? 3.9;
  return Math.max(1000, Math.round((levelValue * ceiling) / PAR_AT_PERFECT));
}

/**
 * How long the build phase "should" take before wave `waveIndex`. Starting earlier than
 * this pays the early-start bonus; there is no *penalty* for taking longer, because a
 * countdown on a tower defence punishes exactly the deliberation the genre is about.
 * Later waves get more time because there is more to spend and more to re-plan.
 */
export function parBuildTime(waveIndex) {
  return Math.min(45, 16 + waveIndex * 3.5);
}

/**
 * Par for the *whole level's* clock, which is what the time axis is measured against.
 *
 * Built from the waves' own par times plus half of each build phase's par. The half is
 * deliberate and it is where the axis gets its teeth: par assumes a player who has already
 * decided what to buy before the shop opens. A player who takes the full build time every
 * wave and clears every wave exactly on its par lands at roughly 1.15-1.20x, which is
 * three skulls on this axis — the honest result of a careful, unhurried first clear.
 */
export const PAR_TIME_BUILD_FRACTION = 0.5;

export function parLevelTime(waveParTimes) {
  let t = 0;
  for (let i = 0; i < waveParTimes.length; i++) {
    t += waveParTimes[i] + parBuildTime(i) * PAR_TIME_BUILD_FRACTION;
  }
  return Math.max(30, Math.round(t));
}

// ═══════════════════════════════════════════════════════════════ economy

/**
 * How much a wave's payout scales with the number of doors that were live for it.
 *
 * A four-gate wave is not four times the orcs. It is the *same* orcs spread over four
 * corridors you each have to stock — and a defence is priced per corridor, because a trap
 * on the north road does nothing about the south one. The old factor was
 * `1 + 0.2*(lanes-1)`, i.e. six doors were worth twice one door. Measured, that produced a
 * campaign where coin per point of enemy HP per live lane fell from 0.97 at level 1 to
 * 0.15 at level 10 while the roster's HP per orc quadrupled.
 *
 * It is not linear either, and this is the part the "6x the lanes needs 6x the coin"
 * reading gets wrong: the lanes *converge*. Measured on the built maps, the number of
 * placeable trap slots on the route per live gate only falls from 75 (one gate, level 1)
 * to 52.5 (six gates, level 10) — the private stretch of each new lane is short and the
 * shared approach to the rift is paid for once. So the exponent is sub-linear, and it is
 * fitted to that slot count rather than to the gate count.
 *
 * ── Round 3: it was fitted to slots, and the slots were not the constraint ────
 *
 * The 0.8 exponent was fitted to *placeable slots per gate*, on the reasoning that a
 * lane you cannot stock is a lane you have not paid for. Measured end-to-end on the
 * line-of-sight-fixed build, that reasoning over-shot badly, because the constraint at
 * the top of the campaign turned out not to be slots either — it is that a player runs
 * out of *route* to spend on long before they run out of coin. Unspent coin at victory,
 * competent bracket / money-no-object bracket:
 *
 *   lv          1     4     6     7      8      9     10
 *   floor     1.4k  2.1k  4.2k  9.9k   7.9k   9.3k  21.4k
 *   perfect   8.6k   20k   35k   73k    96k     —      —
 *
 * Twenty-one thousand coin unspent on The Black Throne, ninety-six on The Warcamp. That
 * is not a defence you could not afford, it is a shop you had stopped visiting — and a
 * build phase with nothing to decide is the thing the whole economy exists to create.
 * The exponent comes down to 0.62 and the bonus lines with it (see `BONUS`).
 *
 *   lanes:   1     2     3     4     5     6
 *   0.80:    1.00  1.74  2.41  3.03  3.62  4.19    (round 2)
 *   0.62:    1.00  1.54  2.00  2.37  2.71  3.02
 */
export function laneFactor(lanes) {
  return Math.pow(Math.max(1, lanes || 1), 0.62);
}

/**
 * The opening purse floor.
 *
 * `LevelDefs.startCoin` is WORLD's number and is authoritative; this is a floor under it,
 * derived from the level's own shape so it cannot silently go stale when a level gains a
 * gate or a wave table is retimed. It buys `LANE_KIT` on every door wave 1 actually opens
 * (not every door on the map — the campaign hands those over one at a time) plus a shared
 * reserve for the approach to the rift.
 *
 * Measured, with the harness bot's opening build and `startCoin` exactly as shipped:
 *
 *   lv  startCoin  opening traps  outcome
 *   1     1,800          5        clean, 20/20
 *   2     2,750          6        won, 2 leaks — clean only at +800
 *   3     2,600          5        clean, 18/18 (one long corridor; 174 trap slots)
 *   4     3,000          5        LOST — rift gone in wave 2 with six traps down
 *
 * Level 4 is the shape of the problem and it is not a wave-size problem: waves 3, 4 and 5
 * were all held with 0-1 leaks once the bot had eleven to fifteen traps. It lost in wave 2
 * because the purse only ever bought six, and by the time kill income had paid for the
 * seventh the rift was at seven of eighteen. An opening that cannot survive long enough to
 * earn is not difficulty, it is an unpayable bill.
 *
 * `LANE_KIT` is one lane's first workable layer: tar (350) + two spikes (800) + an arrow
 * wall (500). `KIT_GROWTH` is how much more that layer costs each level as the roster
 * hardens — by level 7 a lane holding only spikes does not stop a Frostling, and the
 * premium tiles that answer it cost two to four times what a spike does.
 *
 * When WORLD's `startCoin` already clears this the floor is a no-op, which is the intended
 * steady state and is where levels 7 and 10 already sit. The report lists both columns.
 *
 * ── Round 3: the opening was right at level 4 and rich at level 1 ────────────
 *
 * The critic finished The Gatehouse with 1,185 of 2,700 coin unspent — 44% of the purse,
 * on the level whose entire subject is "what does a trap cost". `openingPurse(1, 0)` is
 * exactly that 2,700, so the floor *was* the number, and it was too big. It comes down to
 * 2,200 at level 1 while the per-level growth goes up, so the mid-campaign openings the
 * floor was actually built for (level 4 lost the rift in wave 2 without it) barely move.
 *
 *   lv           1      4       7       10
 *   round 2   2,700  4,740  10,262  17,565
 *   round 3   2,200  4,190   8,254  12,946
 */
export const LANE_KIT = 1450;
export const KIT_GROWTH = 0.46;
export const CORE_RESERVE = 750;

/**
 * `earlyLanes` — the door that opens in wave 2 has to be paid for in wave 1.
 *
 * The floor was priced off wave 1's lane count alone, and that is wrong for every level
 * whose gate table reads `[1, 2, 2, ...]`. The Forge is the clearest case and it is the
 * campaign's worst level on measurement: it opens on one door, so it drew a one-lane
 * purse, and then wave 2 opens a second door that nothing has paid for. Measured, the
 * competent bracket arrived at wave 3 with *thirteen traps* spread over two corridors and
 * leaked nine times across waves 3 and 4 — a level lost on 4 of 20 rift with 1,781 coin in
 * hand at the end, which is not a wave-size problem and no amount of trimming orcs fixed
 * it. Cutting the wave 20% moved the result by nothing.
 *
 * So the floor now also covers the gates that open by wave 3, at half a kit each: half,
 * because a lane you will need shortly is worth stocking early but is not yet costing you
 * anything, and the second half is what the wave-1 and wave-2 clear bonuses are for.
 */
export const EARLY_LANE_SHARE = 0.5;

export function openingPurse(openingLanes, levelIndex = 0, earlyLanes = openingLanes) {
  const kit = LANE_KIT * (1 + KIT_GROWTH * levelIndex);
  const soon = Math.max(0, laneFactor(earlyLanes) - laneFactor(openingLanes));
  return Math.round(CORE_RESERVE + kit * (laneFactor(openingLanes) + soon * EARLY_LANE_SHARE));
}

/**
 * Fractions of a wave's own value paid out as bonuses, so every payout scales with the
 * campaign instead of needing a table.
 *
 * The coin lines are what make the build phase a real decision. Kill income alone funds
 * roughly one new trap per wave, which is nowhere near enough once a level has four or
 * six gates to cover; the difference has to be *earned*. Playing clean and starting
 * early is worth up to +95% income, and that is the whole risk/reward loop: start the
 * wave before your row is finished, hold it anyway, and you can afford the next row.
 *
 * The score lines are deliberately *not* generous. Score now feeds a rating that is gated
 * on two other axes, so inflating it no longer buys skulls — it only decides which of the
 * three axes is your limiter. Bonuses that used to be there to make the number go up have
 * been cut back to the ones that describe how the wave went.
 *
 * Round 3 cut the three coin lines by ~22%. Same evidence as `laneFactor`: measured to the
 * end of every level, the campaign was paying for defences the map has no room for, and
 * the surplus was largest exactly where the build phase is supposed to be hardest. The
 * *ratio* between them is untouched, because it is that ratio — clear < flawless+early —
 * that makes "start it before the row is finished and hold it anyway" the paying line.
 */
export const BONUS = {
  earlyCoin: 0.26,      // of the wave's total coin value, at a full skip
  earlyScore: 0.18,     // of the wave's total score value, at a full skip
  clearCoin: 0.30,      // paid for clearing at all
  flawlessCoin: 0.26,   // paid again for clearing without a single leak
  clear: 0.08,          // score: flat wave-clear payout
  flawless: 0.14,       // score: no leaks this wave
  variety: 0.03,        // score: per distinct trap type that landed a killing blow
  speed: 0.09,          // score: full value at half the wave's par time, zero at par
  riftIntact: 0.10,     // score: of the whole level's value, scaled by rift left
};

/** Combo ladder. `at` is the kill count needed to reach `mult`. */
export const COMBO_LADDER = [
  { at: 0, mult: 1.0 },
  { at: 5, mult: 1.5 },
  { at: 10, mult: 2.0 },
  { at: 18, mult: 2.5 },
  { at: 28, mult: 3.0 },
  { at: 40, mult: 3.5 },
  { at: 55, mult: 4.0 },
  { at: 72, mult: 4.5 },
  { at: 90, mult: 5.0 },
];

/**
 * The combo window tightens as the multiplier climbs: 1x is forgiving so the feedback
 * starts immediately, 5x has to be actively defended. Expiry costs one rung, not
 * everything — a cliff makes players stop caring the moment they slip. Only a leak
 * wipes it, which is what makes a leak hurt more than the rift damage does.
 */
export function comboWindow(mult) {
  return 3.2 - (mult - 1) * 0.24;
}

/** Score multipliers for simultaneous kills. Index = number killed in one beat. */
export const MULTIKILL = { 2: 1.15, 3: 1.4, 4: 1.7, 5: 2.1, 6: 2.6 };
export const MULTIKILL_WINDOW = 0.35;

/** Killing with the type an archetype is vulnerable to. */
export const COUNTER_BONUS = 0.35;

/** A chain of this many *different* traps in a row pays out. */
export const CHAIN_LENGTH = 3;
export const CHAIN_BONUS = 0.5;

/**
 * Damage type each damage-dealing trap actually applies. Derived from the trap roster's
 * tags, but pinned here because the director must not depend on tag ordering staying
 * stable in a file it does not own.
 */
export const TRAP_DAMAGE_TYPE = {
  'spike-floor': 'physical',
  'arrow-wall': 'physical',
  'boom-barrel': 'fire',
  'ceiling-pounder': 'crush',
  'wall-blades': 'physical',
  'brimstone': 'fire',
  'grinder': 'physical',
  'ice-vent': 'ice',
  'lightning-rod': 'lightning',
  'acid-sprayer': 'poison',
  'arcane-obelisk': 'arcane',
  'guardian-archer': 'physical',
  'guardian-paladin': 'crush',
  'guardian-hunter': 'poison',
};
