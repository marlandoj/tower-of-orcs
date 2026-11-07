import { getEnemyDef } from '../entities/enemies/roster.js';
import { WaveComposer } from './WaveComposer.js';
import { CAMPAIGN } from './campaign.js';
import { parBuildTime, laneFactor, BONUS } from './Difficulty.js';
import { clamp } from '../shared/rng.js';

/**
 * Runs the level's waves. The rhythm is the whole game:
 *
 *   BUILD (no timer, player-triggered)  ->  WAVE  ->  short breather  ->  BUILD ...
 *
 * The player starts every wave themselves. Forcing a countdown on a tower defence
 * punishes exactly the deliberation the genre is about; starting early is *rewarded*
 * instead, with a bonus that scales with how much of the build phase was skipped.
 *
 * Inside a wave, spawning is driven by `WaveComposer`: a sequence of beats with
 * telegraphs, lulls and gates, rather than a flat list of stopwatch timers.
 *
 * ── Accounting ───────────────────────────────────────────────────────────────
 * A wave used to end when a hand-kept `aliveFromWave` counter hit zero. Any enemy the
 * director did not personally spawn — the Orc King's summons, a splitter's children —
 * decremented that counter without ever incrementing it, so the wave could "clear"
 * with a live horde on the field. There is no counter any more: a wave is over when
 * the field is *actually* empty (`enemies.aliveCount() === 0`) and nothing is queued.
 * That is impossible to drift. The remaining failure mode — an orc that is alive but
 * cannot make progress — is covered by the stall watchdog below, which nudges and then
 * culls, so a wave can never hang.
 */
export class WaveDirector {
  constructor(game) {
    this.game = game;
    this.composer = new WaveComposer(game);
    this.def = null;
    this.waves = [];
    this.waveIndex = -1;
    this.running = false;
    this.finished = false;

    this.wave = null;          // compiled wave
    this.beatIndex = 0;
    this.beat = null;
    this.phase = 'idle';       // 'telegraph' | 'spawning' | 'hold' | 'gate'
    this.phaseT = 0;
    this.streams = [];
    this.spawnedThisWave = 0;
    this.waveTime = 0;
    this.breather = 0;
    this.beatLane = -1;
    this.prevBeatLane = -1;
    this.boss = null;
    this.buildStartedAt = 0;
    this.earlyBonusPaid = null;

    // Stall watchdog state.
    this._stallT = 0;
    this._stallHp = Infinity;
    this._stallAlive = -1;
    this._stallProbe = 0;
    this.culled = 0;

    this._previewCache = new Map();
    game.bus.on('phase:build', () => { this.buildStartedAt = game.clock.elapsed; });
  }

  /**
   * Wave composition is DIRECTOR's job (ARCHITECTURE §2), so `campaign.js` is
   * authoritative and `LevelDefs.waves` is the fallback for anything the campaign does not
   * cover. This precedence was the other way round for one round, after the beat tables
   * were copied into `LevelDefs.js`; the copy is byte-identical to the round-1 tables and
   * has since diverged, so the copy in `LevelDefs.js` is now dead weight and should be
   * deleted — see the module report.
   */
  load(def) {
    this.def = def;
    const authored = CAMPAIGN[this.game.levelIndex];
    this.waves = authored || def.waves || [];

    this.waveIndex = -1;
    this.running = false;
    this.finished = false;
    this.wave = null;
    this.streams.length = 0;
    this.breather = 0;
    this.boss = null;
    this.culled = 0;
    this.buildStartedAt = this.game.clock.elapsed;
    this._previewCache.clear();
    this.game.scoring.setLevelPlan(this.levelPlan());
  }

  /**
   * Compile every wave once, at load, and roll the level up. This is the level's *shape*
   * as a few numbers, and both par figures and the opening-purse floor are derived from
   * it rather than tabled — so a wave edit moves the scoring contract with it and a stale
   * table cannot quietly misrepresent a rating.
   *
   * `value` is the base score of every orc the level will ever spawn, before any combo or
   * bonus. `times` is each wave's par clear time. `openingLanes` is how many doors wave 1
   * actually opens, which is what the opening purse has to stock.
   */
  levelPlan() {
    const spawns = this.game.grid?.spawns ?? [];
    let value = 0, coin = 0, count = 0, hp = 0;
    const times = [];
    for (let i = 0; i < this.waves.length; i++) {
      const c = this.composer.compile(this.waves[i], i, spawns);
      this._previewCache.set(i, c);
      value += c.score; coin += c.coin; count += c.count; hp += c.hp;
      times.push(c.parTime);
    }
    const first = this._previewCache.get(0);
    const openingLanes = first?.spawns?.length || Math.max(1, spawns.length);
    // How wide the level gets *soon*. The purse floor needs this as well as wave 1's
    // count, because a door that opens in wave 2 has to be stocked out of wave 1's money
    // — see `openingPurse`. Three waves, because that is how long the clear and flawless
    // bonuses take to pay for a lane on their own.
    let earlyLanes = openingLanes;
    for (let i = 1; i < Math.min(3, this.waves.length); i++) {
      earlyLanes = Math.max(earlyLanes, this._previewCache.get(i)?.spawns?.length || 0);
    }
    return {
      waves: this.waves.length, value, coin, count, hp, times,
      gates: spawns.length,
      openingLanes, earlyLanes,
    };
  }

  get waveCount() { return this.waves.length; }
  get currentWave() { return this.waves[this.waveIndex] ?? null; }

  /** How many are still to come this wave — drives the HUD's "orcs remaining". */
  get remaining() {
    let queued = 0;
    for (const s of this.streams) queued += s.remaining;
    if (this.wave) {
      // The current beat's streams are already live unless it is still telegraphing,
      // in which case they have not been opened yet and must be counted here.
      const from = this.phase === 'telegraph' ? this.beatIndex : this.beatIndex + 1;
      for (let i = Math.max(0, from); i < this.wave.beats.length; i++) {
        for (const s of this.wave.beats[i].streams) queued += s.count;
      }
    }
    return queued + this.game.enemies.aliveCount();
  }

  /** Everything the UI needs to show a wave preview during the build phase. */
  preview(index = this.waveIndex + 1) {
    const w = this.waves[index];
    if (!w) return null;
    let c = this._previewCache.get(index);
    if (!c) {
      c = this.composer.compile(w, index, this.game.grid.spawns);
      this._previewCache.set(index, c);
    }
    return {
      index, total: this.waves.length, boss: c.boss, finale: c.finale,
      hp: c.hp, count: c.count,
      // Which gates actually open. A wave that uses two of a level's six doors is a
      // completely different build problem from one that uses all six, and the player
      // cannot make that decision from a list of orc portraits. UI: please surface this
      // — marker cells are `{ gx, gz }` and can be highlighted on the board.
      gates: c.spawns.map((sp) => ({ gx: sp.gx, gz: sp.gz })),
      laneCount: c.spawns.length,
      entries: [...c.byId.entries()].map(([id, count]) => ({ def: getEnemyDef(id), count }))
        .sort((a, b) => (b.def?.tier ?? 0) - (a.def?.tier ?? 0)),
    };
  }

  // --- wave lifecycle --------------------------------------------------------

  startWave() {
    if (this.running || this.finished) return false;
    const next = this.waveIndex + 1;
    if (next >= this.waves.length) return false;
    const g = this.game;

    this.waveIndex = next;
    this.wave = this.composer.compile(this.waves[next], next, g.grid.spawns);
    this._previewCache.set(next, this.wave);

    this.running = true;
    this.waveTime = 0;
    this.spawnedThisWave = 0;
    this.streams.length = 0;
    this.beatIndex = -1;
    this.beat = null;
    this.beatLane = -1;
    this.prevBeatLane = -1;
    this.boss = null;
    this._resetStall();

    g.scoring.beginWave(this.wave);
    this._payEarlyStart();

    g.state = 'wave';
    g.ui.setPhase('wave');
    g.audio.play('wave.start');
    g.audio.play('horde', { gain: 0.6 });
    g.fx.shake(0.25, 0.4);
    g.bus.emit('wave:start', {
      waveIndex: next, waveCount: this.waves.length,
      composition: this.preview(next), boss: this.wave.boss,
    });

    this._nextBeat();
    return true;
  }

  /**
   * Starting before the build phase's par time pays out. This is the only lever that
   * makes the build phase a *decision* rather than an untimed shopping trip: every extra
   * second of planning is bought with score and coin you could have had.
   */
  _payEarlyStart() {
    const g = this.game;
    const par = parBuildTime(this.waveIndex);
    const spent = Math.max(0, g.clock.elapsed - this.buildStartedAt);
    const skipped = clamp(1 - spent / par, 0, 1);
    this.earlyBonusPaid = null;
    if (skipped < 0.05) return;
    const lanes = this.wave.spawns?.length || 1;
    const coin = Math.round(this.wave.coin * BONUS.earlyCoin * laneFactor(lanes) * skipped);
    const score = Math.round(this.wave.score * BONUS.earlyScore * skipped);
    if (coin <= 0 && score <= 0) return;
    this.earlyBonusPaid = { skipped, coin, score };
    g.scoring.awardBonus({
      coin, score,
      label: `EARLY START +${Math.round(skipped * 100)}%`,
    });
  }

  update(dt) {
    const g = this.game;
    if (g.state === 'paused' || g.state === 'menu' || g.state === 'defeat'
        || g.state === 'victory' || this.finished) return;

    if (g.state === 'build') {
      if (g.input.pressed('startWave')) this.startWave();
      return;
    }
    if (!this.running) {
      if (this.breather > 0) {
        this.breather -= dt;
        if (this.breather <= 0) this._toBuild();
      }
      return;
    }

    this.waveTime += dt;
    this._runBeats(dt);
    this._pumpStreams(dt);
    this._watchdog(dt);

    if (this.beatIndex >= this.wave.beats.length && this.streams.length === 0
        && g.enemies.aliveCount() === 0) {
      this._clearWave();
    }
  }

  // --- beats -----------------------------------------------------------------

  _nextBeat() {
    this.beatIndex++;
    this.beat = this.wave.beats[this.beatIndex] ?? null;
    if (!this.beat) { this.phase = 'idle'; return; }

    if (this.beat.label) this.game.ui.toast(this.beat.label, this.beat.boss ? 'error' : 'info', 2200);

    if (this.beat.telegraph > 0) {
      this.phase = 'telegraph';
      this.phaseT = this.beat.telegraph;
      this._teleTick = 0;
      if (this.beat.boss) this.game.audio.play('horde', { gain: 0.9, pitch: 0.5 });
    } else {
      this._openStreams();
    }
  }

  _openStreams() {
    // "Flank" means the door you are *not* standing in, so it resolves against the lane
    // the previous beat opened on — not against whichever marker the round-robin last
    // happened to touch.
    this.prevBeatLane = this.beatLane;
    this.beatLane = -1;
    for (const s of this.beat.streams) {
      this.streams.push({ ...s, remaining: s.count, t: s.delay, rr: -1 });
    }
    this.phase = 'spawning';
  }

  _runBeats(dt) {
    if (!this.beat) return;
    const g = this.game;

    if (this.phase === 'telegraph') {
      this.phaseT -= dt;
      // Escalating rumble: the tell has to build, or it is just a pause.
      const f = 1 - clamp(this.phaseT / Math.max(0.01, this.beat.telegraph), 0, 1);
      this._teleTick -= dt;
      if (this._teleTick <= 0) {
        this._teleTick = 0.55 - f * 0.3;
        g.fx.shake(0.12 + f * 0.5, 0.3);
        g.audio.play('rift.hit', { gain: 0.35 + f * 0.4, pitch: 0.5 + f * 0.3 });
      }
      if (this.phaseT <= 0) {
        if (this.beat.boss) {
          g.fx.flash('#ff5522', 0.5, 0.45);
          g.fx.shake(1.0, 0.7);
          g.engine.slowmo(0.35, 1.2);
          g.audio.play('trap.boom', { pitch: 0.4 });
        }
        this._openStreams();
      }
      return;
    }

    if (this.phase === 'spawning') {
      if (this.streams.length === 0) {
        this.phase = 'hold';
        this.phaseT = this.beat.hold;
        this._gateT = 0;
      }
      return;
    }

    if (this.phase === 'hold') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) { this.phase = 'gate'; this._gateT = 0; }
      return;
    }

    if (this.phase === 'gate') {
      this._gateT += dt;
      // A gate is a pacing device, never a lock. Two reasons for the cap:
      //   correctness — a condition that can no longer be met must not stall the wave;
      //   *feel* — the campaign's lanes are 20–120s of walking, so "60% of them are
      //   dead" can be unreachable for half a minute through no fault of the player,
      //   and a lull that outlives its own tension is just dead air.
      // Caps are therefore short and kind-specific, and a wave is bounded by
      // (beats x cap) no matter what happens on the field.
      if (this._gateSatisfied(this.beat.gate) || this._gateT >= gateCap(this.beat.gate)) {
        this._nextBeat();
      }
    }
  }

  _gateSatisfied(gate) {
    if (!gate) return true;
    const g = this.game;
    if (gate.dead !== undefined) {
      if (this.spawnedThisWave === 0) return true;
      const gone = this.spawnedThisWave - g.enemies.aliveCount();
      return gone / this.spawnedThisWave >= gate.dead;
    }
    if (gate.alive !== undefined) return g.enemies.aliveCount() <= gate.alive;
    if (gate.bossHp !== undefined) {
      if (!this.boss || this.boss.dead) return true;
      return this.boss.hp / this.boss.hpMax <= gate.bossHp;
    }
    return true;
  }

  _pumpStreams(dt) {
    const g = this.game;
    for (let i = this.streams.length - 1; i >= 0; i--) {
      const s = this.streams[i];
      s.t -= dt;
      if (s.t > 0) continue;
      const { marker, index } = this.composer.resolve(s.lane, this.wave.spawns, s, this.prevBeatLane, g.rng);
      if (marker) {
        const e = g.enemies.spawnAtMarker(s.id, marker);
        if (e) {
          this.spawnedThisWave++;
          if (e.has?.('boss')) this.boss = e;
        }
        if (index >= 0 && this.beatLane < 0) this.beatLane = index;
      }
      s.remaining--;
      s.t = s.gap;
      if (s.remaining <= 0) this.streams.splice(i, 1);
    }
  }

  // --- stall watchdog --------------------------------------------------------

  _resetStall() {
    this._stallT = 0;
    this._stallHp = Infinity;
    this._stallDist = Infinity;
    this._stallAlive = -1;
    this._stallProbe = 0;
  }

  /**
   * Progress is any of: an orc died, an orc lost health, or the horde got *closer to the
   * rift*. That last one matters — the campaign's longest lane is over two minutes of
   * walking, so "no kills for a while" is a completely normal wave, not a stall.
   * Closeness is measured on the flow field, not as the crow flies, because the route
   * doubles back on itself and Euclidean distance would read a corridor as a stall.
   *
   * 20s with none of the three and we nudge everything along the field (a doorway crush,
   * a bad knockback landing); 45s and we remove the survivors outright — silently, with
   * no score and no rift damage, because a watchdog firing is a bug, not a play outcome.
   * The one thing it must never do is let the wave sit there forever.
   */
  _watchdog(dt) {
    const g = this.game;
    if (this.streams.length > 0 || this.phase === 'telegraph') { this._resetStall(); return; }

    this._stallProbe -= dt;
    // Time is credited once per probe (below), not per frame as well — doing both ran the
    // stall clock at about twice real time, so the 20 s nudge fired at ~10 s.
    if (this._stallProbe > 0) return;
    this._stallProbe = 1.0;

    const items = g.enemies.list.items;
    const flow = g.grid.riftFlow();
    let hp = 0, alive = 0, dist = 0;
    for (const e of items) {
      if (e.dead) continue;
      hp += e.hp;
      alive++;
      const d = flow.distAt(Math.floor(e.position.x / 4), Math.floor(e.position.z / 4));
      dist += isFinite(d) ? d : 0;
    }

    const progressed = alive !== this._stallAlive
      || hp < this._stallHp * 0.995
      || dist < this._stallDist - 0.05 * Math.max(1, alive);
    this._stallHp = hp;
    this._stallAlive = alive;
    this._stallDist = dist;
    if (progressed || alive === 0) { this._stallT = 0; return; }

    this._stallT += 1.0;
    if (this._stallT > 45) {
      for (const e of Array.from(items)) {
        if (e.dead) continue;
        e.dead = true;
        g.enemies.despawn(e, null, true);
        this.culled++;
      }
      this._resetStall();
    } else if (this._stallT > 20) {
      for (const e of items) {
        if (e.dead) continue;
        const gx = Math.floor(e.position.x / 4), gz = Math.floor(e.position.z / 4);
        const d = flow.dirAt(gx, gz, { x: 0, z: 0 });
        e.position.x += d.x * 2.5;
        e.position.z += d.z * 2.5;
      }
    }
  }

  // --- transitions -----------------------------------------------------------

  _clearWave() {
    this.running = false;
    const g = this.game;
    g.scoring.endWave({ index: this.waveIndex, time: this.waveTime, wave: this.wave });
    g.bus.emit('wave:clear', { waveIndex: this.waveIndex });

    if (this.waveIndex + 1 >= this.waves.length) {
      this.finished = true;
      g.scoring.endLevel();
      g.state = 'victory';
      const summary = g.scoring.summary();
      g.save.recordResult(g.levelIndex, summary);
      g.audio.play('victory');
      g.engine.slowmo(0.4, 1.4);
      g.bus.emit('game:victory', { levelIndex: g.levelIndex, ...summary });
      return;
    }
    // A short beat before the shop opens — the moment to watch the last corpse fall.
    this.breather = 1.6;
    g.audio.play('ui.confirm');
  }

  _toBuild() {
    this.game.state = 'build';
    this.game.ui.setPhase('build');
    this.game.bus.emit('phase:build', { nextWaveIndex: this.waveIndex + 1 });
  }
}

/**
 * How long a gate may hold the next beat. Short for the pacing gates, because a lull is
 * meant to be a held breath and not an intermission; long for boss-health gates, where
 * the wait *is* the fight and the cap only exists so a boss the player refuses to engage
 * cannot freeze the wave.
 */
function gateCap(gate) {
  if (!gate) return 0;
  if (gate.maxWait !== undefined) return gate.maxWait;
  // 25s for a boss act, so a four-act boss wave cannot spend more than 100s in gates
  // even if the player never touches the boss. Measured at 40s, the Warlord waves ran
  // past 150 seconds, which is a different problem from being hard.
  if (gate.bossHp !== undefined) return 25;
  if (gate.alive !== undefined) return 10;
  return 8;   // { dead: f }
}
