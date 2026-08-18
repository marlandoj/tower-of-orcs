import { getEnemyDef } from '../entities/enemies/roster.js';
import { TILE } from '../world/Grid.js';

/**
 * Turns a *declarative* wave into an *executable* one.
 *
 * A flat list of groups on fixed timers is not a wave, it is a spreadsheet. Orcs Must
 * Die's campaign works because every wave has shape: an opening probe, a lull that
 * tempts you off your lane, a flank that punishes you for taking the bait, then the
 * real push. That shape is a sequence of *beats*, and beats advance on conditions —
 * time, kill fraction, boss health — not just on a stopwatch.
 *
 * ── Authoring vocabulary (pure data, so `LevelDefs.js` needs no imports) ──────
 *
 *   wave = {
 *     beats: [ beat, ... ],
 *     boss?: bool, finale?: bool,
 *     parTime?: seconds        // clearing under this pays a speed bonus
 *   }
 *
 *   beat = {
 *     spawn:  [ [enemyId, count, opts?], ... ]   // opts: { gap, delay, lane }
 *     lane:   0 | 'all' | 'random' | 'flank' | 'far' | 'near'   (default 'all')
 *     gap:    seconds between spawns inside a group   (default 0.5)
 *     hold:   seconds of silence after the beat finishes spawning   (default 0)
 *     gate:   { dead: 0..1 } | { alive: n } | { bossHp: 0..1 } | null
 *     telegraph: seconds of loud, empty dread before the beat spawns
 *     label:  short line shown to the player when the beat opens
 *   }
 *
 * `lane: 'flank'` is the load-bearing one: it resolves to the spawn marker *furthest*
 * from the one the previous beat used, so "a flank" is geometry, not decoration.
 *
 * Legacy waves that only carry `groups` are still accepted and are choreographed
 * automatically (see `_fromLegacy`) — the campaign plays with rhythm today, and the
 * hand-authored beat tables in `campaign.js` replace it level by level.
 */

const DEFAULT_GAP = 0.5;

export class WaveComposer {
  constructor(game) {
    this.game = game;
  }

  /** @returns {CompiledWave} */
  compile(waveDef, waveIndex, allSpawns) {
    // A level with six gates should not open all six in wave 1. `lanes` is how the
    // campaign hands them over one at a time — the same escalation the roster and the
    // geometry get, applied to the thing that actually decides how thin you are spread.
    const spawns = this._laneSubset(allSpawns, waveDef.lanes);
    const beats = waveDef.beats
      ? waveDef.beats.map((b) => this._compileBeat(b))
      : this._fromLegacy(waveDef, waveIndex);

    // Roll up totals once: the HUD preview, the score bonuses and the early-start
    // bonus all price themselves off the wave's own content.
    let count = 0, hp = 0, score = 0, coin = 0;
    const byId = new Map();
    let boss = !!waveDef.boss;
    for (const b of beats) {
      for (const s of b.streams) {
        const def = getEnemyDef(s.id);
        if (!def) continue;
        count += s.count;
        hp += (def.hp ?? 60) * s.count;
        score += (def.score ?? 100) * s.count;
        coin += (def.coin ?? 20) * s.count;
        byId.set(s.id, (byId.get(s.id) || 0) + s.count);
        if (def._flagSet?.has('boss')) boss = true;
      }
    }

    return {
      index: waveIndex,
      beats,
      boss,
      finale: !!waveDef.finale,
      count, hp, score, coin,
      byId,
      // A wave you clear in well under this was clearly over-defended for it; a wave
      // that runs long was a grind. Derived, so it tracks any table edit.
      parTime: waveDef.parTime ?? this._estimateParTime(beats, hp, spawns),
      spawns,
    };
  }

  /** `n` gates, spread as far apart as the level allows rather than taken in order. */
  _laneSubset(spawns, n) {
    if (!n || !spawns || n >= spawns.length) return spawns;
    if (n <= 1) return [spawns[0]];
    const out = [];
    for (let i = 0; i < n; i++) out.push(spawns[Math.round((i * (spawns.length - 1)) / (n - 1))]);
    return [...new Set(out)];
  }

  _compileBeat(b) {
    const gap = b.gap ?? DEFAULT_GAP;
    const lane = b.lane ?? 'all';
    const streams = (b.spawn || []).map(([id, count, opts = {}]) => ({
      id,
      count,
      remaining: count,
      delay: opts.delay ?? 0,
      gap: opts.gap ?? gap,
      lane: opts.lane ?? lane,
      t: opts.delay ?? 0,
      rr: -1,
    }));
    return {
      streams,
      hold: b.hold ?? 0,
      gate: b.gate ?? null,
      telegraph: b.telegraph ?? 0,
      label: b.label ?? null,
      boss: !!b.boss,
    };
  }

  /**
   * Choreograph a flat `groups` list. The shape we impose, in order:
   *
   *   1. OPENING  the lead group, at ~60% of its count and a slightly lazy gap — a probe
   *              you are meant to beat comfortably.
   *   2. LULL     2.5–4.5s of nothing. Long enough to make you walk somewhere.
   *   3. FLANK    the fastest remaining group, on the far spawn, at its authored rate.
   *   4. PUSH     everything left, gated on the flank being mostly dead, at full rate.
   *
   * A boss is always pulled out into its own telegraphed beat and the remainder becomes
   * HP-gated adds, so bosses read as an event even on an un-migrated table.
   */
  _fromLegacy(waveDef, waveIndex) {
    const groups = (waveDef.groups || []).map((g) => ({
      id: g.id, count: g.count,
      delay: g.delay ?? 0, gap: g.interval ?? DEFAULT_GAP,
      lane: g.spawn ?? 0,
      def: getEnemyDef(g.id),
    }));
    if (!groups.length) return [];

    const bossGroups = groups.filter((g) => g.def?._flagSet?.has('boss'));
    const mob = groups.filter((g) => !g.def?._flagSet?.has('boss'));

    const mk = (spawn, opts = {}) => this._compileBeat({ spawn, ...opts });
    const beats = [];

    if (!mob.length) {
      // Boss-only wave: telegraph and go.
      for (const b of bossGroups) {
        beats.push(mk([[b.id, b.count, { gap: Math.max(b.gap, 3) }]],
          { lane: b.lane, telegraph: 3.2, boss: true, label: 'THE GROUND SHAKES' }));
      }
      return beats;
    }

    // Lead group = the one authored to arrive first, tie-broken by size.
    mob.sort((a, b) => (a.delay - b.delay) || (b.count - a.count));
    const lead = mob[0];
    const openCount = Math.max(1, Math.round(lead.count * 0.6));
    const rest = mob.slice(1);

    beats.push(mk([[lead.id, openCount, { gap: lead.gap * 1.25 }]], {
      lane: lead.lane, label: null,
    }));

    // The lull scales with how big the wave is: bigger pushes deserve a longer breath.
    const total = mob.reduce((a, g) => a + g.count, 0);
    beats.push({
      streams: [], hold: Math.min(4.5, 2.4 + total * 0.03),
      gate: { dead: 0.55 }, telegraph: 0, label: null, boss: false,
    });

    // Flank: the fastest thing left, from the far side.
    if (rest.length) {
      rest.sort((a, b) => a.gap - b.gap);
      const fl = rest.shift();
      beats.push(mk([[fl.id, fl.count, { gap: fl.gap }]], {
        lane: 'flank', label: null,
      }));
    }

    // Push: the leftovers plus the half of the lead group we held back.
    const push = rest.map((g) => [g.id, g.count, { gap: g.gap, delay: g.delay * 0.4, lane: g.lane }]);
    if (lead.count - openCount > 0) push.unshift([lead.id, lead.count - openCount, { gap: lead.gap * 0.8, lane: lead.lane }]);
    if (push.length) {
      beats.push(mk(push, { gate: { dead: 0.5 }, hold: 0.6, lane: 'all' }));
    }

    // Boss last, telegraphed, with whatever is still walking as its escort.
    for (const b of bossGroups) {
      beats.push(mk([[b.id, b.count, { gap: Math.max(b.gap, 4) }]], {
        lane: b.lane === 0 ? 'far' : b.lane, telegraph: 3.2, boss: true,
        gate: { alive: 10 }, label: 'THE GROUND SHAKES',
      }));
    }
    return beats;
  }

  /**
   * How long this wave *should* take: the authored spawn span, plus how long the last orc
   * has to walk, plus how long the horde takes to actually die.
   *
   * The travel term used to be a flat 18 seconds — "about the length of a mid-campaign
   * lane". Measured against real runs it is nothing of the sort: the estimate came out
   * 25% optimistic on The Gatehouse and 71% optimistic on The Long Descent, whose lane is
   * three times as long. Since par time is now one of the three axes the skull rating is
   * built from, a travel term that varies 3x by level and is modelled as a constant makes
   * the rating say more about which level you picked than about how you played it.
   *
   * So it is measured off the map. `riftFlow().distAt(spawn)` is the walking distance from
   * a gate to the rift in grid steps; times `TILE` that is metres, and divided by an
   * ordinary orc's speed that is seconds. The *furthest* live gate sets the term, because
   * the wave is not over until its slowest lane is.
   */
  _estimateParTime(beats, hp, spawns) {
    let span = 0;
    for (const b of beats) {
      span += b.telegraph + b.hold;
      let longest = 0;
      for (const s of b.streams) longest = Math.max(longest, s.delay + (s.count - 1) * s.gap);
      span += longest;
    }
    let travel = 18;
    const flow = this.game.grid?.riftFlow?.();
    if (flow && spawns?.length) {
      let far = 0;
      for (const sp of spawns) {
        const d = flow.distAt(sp.gx, sp.gz);
        if (isFinite(d)) far = Math.max(far, d);
      }
      // TILE metres per grid step, ~3.2 m/s for a rank-and-file orc. The 1.15 is the tax
      // for separation jostling and doorway queueing, fitted to measured wave times.
      if (far > 0) travel = (far * TILE / 3.2) * 1.15;
    }
    // Grind: how long the defence needs to chew through the wave's health bar. Fitted at
    // 700 hp/s across the campaign's measured clear times rather than the 900 that was
    // there before, which under-counted every boss wave by half a minute.
    return Math.round(span + travel + hp / 700);
  }

  // --- lane resolution -------------------------------------------------------

  /**
   * Resolve a lane token to a spawn marker. `flank` is relative to `lastLane`, which the
   * director threads through, so a flank is always the door you are *not* standing in.
   */
  resolve(lane, spawns, stream, lastLane, rng) {
    if (!spawns.length) return { marker: null, index: -1 };
    let index;
    if (typeof lane === 'number') index = Math.min(lane, spawns.length - 1);
    else if (lane === 'random') index = Math.floor(rng() * spawns.length) % spawns.length;
    else if (lane === 'all') { stream.rr = (stream.rr + 1) % spawns.length; index = stream.rr; }
    else if (lane === 'near' || lane === 'far') index = this._byRiftDistance(spawns, lane === 'far');
    else if (lane === 'flank') index = this._furthestFrom(spawns, lastLane);
    else index = 0;
    return { marker: spawns[index], index };
  }

  _byRiftDistance(spawns, wantFar) {
    const flow = this.game.grid.riftFlow();
    let best = 0, bd = wantFar ? -Infinity : Infinity;
    for (let i = 0; i < spawns.length; i++) {
      const d = flow.distAt(spawns[i].gx, spawns[i].gz);
      if (!isFinite(d)) continue;
      if (wantFar ? d > bd : d < bd) { bd = d; best = i; }
    }
    return best;
  }

  _furthestFrom(spawns, fromIndex) {
    if (fromIndex < 0 || fromIndex >= spawns.length) return spawns.length - 1;
    const a = spawns[fromIndex];
    let best = 0, bd = -1;
    for (let i = 0; i < spawns.length; i++) {
      if (i === fromIndex) continue;
      const d = (spawns[i].gx - a.gx) ** 2 + (spawns[i].gz - a.gz) ** 2;
      if (d > bd) { bd = d; best = i; }
    }
    return best;
  }
}
