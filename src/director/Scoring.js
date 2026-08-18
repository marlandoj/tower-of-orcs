import { clamp } from '../shared/rng.js';
import {
  rate, parScore, parLevelTime, laneFactor, openingPurse,
  BONUS, COMBO_LADDER, comboWindow,
  MULTIKILL, MULTIKILL_WINDOW, COUNTER_BONUS, CHAIN_LENGTH, CHAIN_BONUS, TRAP_DAMAGE_TYPE,
} from './Difficulty.js';

/**
 * Coin (build currency), score, and the combo multiplier.
 *
 * The combo is meant to be a *resource the player defends*, not a counter that ticks up
 * because kills happened. So it pays attention to how you killed, not just how often:
 *
 *   multi-kill    two or more inside 0.35s — one barrel, one grinder tile, one volley
 *   trap chain    consecutive kills by three *different* traps — the reward for layering
 *   counter kill  the killing blow used a type the archetype is vulnerable to
 *                 (crush into plate, fire into a Frostling, ice into a Cinder Orc)
 *   variety       distinct trap types that scored at all, paid at the end of the wave
 *
 * And it can be lost: the window tightens as the multiplier climbs, expiry costs one
 * rung rather than everything, and a leak wipes it to nothing. That asymmetry is what
 * makes a leak hurt more than the rift damage does.
 */
export class Scoring {
  constructor(game) {
    this.game = game;
    this.coin = 0;
    this.score = 0;
    this.combo = 0;
    this.comboTimer = 0;
    this.comboWindow = 3.2;
    this.multiplier = 1;
    this.kills = 0;
    this.leaks = 0;
    this.trapKills = 0;
    this.playerKills = 0;
    this.bestCombo = 0;
    this.bonusScore = 0;
    this.par = { score: 10000, time: 300 };
    this.levelTime = 0;
    this.plan = null;
    this.purseFloorPaid = 0;

    // Per-wave, reset by beginWave().
    this._wave = null;
    this._waveLeaks = 0;
    this._waveTrapTypes = new Set();
    // Combo texture.
    this._mkN = 0;
    this._mkT = 0;
    this._chain = [];

    game.bus.on('enemy:killed', (p) => this._onKill(p));
    game.bus.on('enemy:leaked', (p) => this._onLeak(p));
    game.engine.addSystem({ order: 45, update: (dt) => this._tick(dt) });
  }

  /**
   * Called from `Game.loadLevel` *before* the director loads, so nothing here may look at
   * the wave tables. Par and the opening-purse floor both need them and are therefore
   * finished in `setLevelPlan()`, which `WaveDirector.load()` calls a line later.
   */
  reset(def) {
    this.startCoin = def.startCoin ?? 2000;
    this.coin = this.startCoin;
    this.purseFloorPaid = 0;
    this.score = 0; this.combo = 0; this.comboTimer = 0; this.multiplier = 1;
    this.kills = 0; this.leaks = 0; this.trapKills = 0; this.playerKills = 0;
    this.bestCombo = 0; this.bonusScore = 0;
    this.levelTime = 0;
    this.plan = null;
    this._wave = null; this._waveLeaks = 0; this._waveTrapTypes.clear();
    this._mkN = 0; this._mkT = 0; this._chain.length = 0;
    this.par = { score: 10000, time: 300 };
    this.levelScoreValue = 0;
    this.game.bus.emit('coin:changed', { coin: this.coin, delta: 0, reason: 'reset' });
    this.game.bus.emit('score:changed', { score: 0, delta: 0 });
    this.game.bus.emit('combo:changed', { combo: 0, multiplier: 1 });
  }

  /**
   * Bind the compiled level to the scoring contract. Two things depend on it:
   *
   * PAR. Both par figures are derived from the level's own compiled waves rather than
   * tabled, so editing a wave moves par with it and a stale table cannot silently
   * misrepresent a rating. `plan.value` is the sum of every orc's base score; `plan.times`
   * is each wave's par clear time.
   *
   * THE PURSE FLOOR. `startCoin` is WORLD's number and wins whenever it is big enough.
   * The floor underneath it is derived from the doors wave 1 actually opens, so a level
   * that gains a gate cannot end up funding half a defence without anyone noticing. When
   * the two agree — the intended steady state — this pays nothing.
   */
  setLevelPlan(plan) {
    this.plan = plan;
    this.par = {
      score: parScore(this.game.levelIndex, plan.value),
      time: parLevelTime(plan.times),
    };
    const floor = openingPurse(plan.openingLanes, this.game.levelIndex, plan.earlyLanes);
    if (floor > this.coin) {
      this.purseFloorPaid = floor - this.coin;
      this.addCoin(this.purseFloorPaid, 'garrison');
    }
  }

  // --- currency --------------------------------------------------------------

  addCoin(n, reason = 'kill') {
    this.coin += n;
    this.game.bus.emit('coin:changed', { coin: this.coin, delta: n, reason });
  }
  spend(n) {
    if (this.coin < n) return false;
    this.coin -= n;
    this.game.bus.emit('coin:changed', { coin: this.coin, delta: -n, reason: 'spend' });
    return true;
  }
  canAfford(n) { return this.coin >= n; }

  /** Multiplied by the live combo — this is what the combo is *for*. */
  addScore(n) {
    const gained = Math.round(n * this.multiplier);
    this.score += gained;
    this.game.bus.emit('score:changed', { score: this.score, delta: gained });
    return gained;
  }
  /** Bonuses are flat, so their value is legible instead of luck-of-the-combo. */
  addFlatScore(n) {
    const gained = Math.round(n);
    if (!gained) return 0;
    this.score += gained;
    this.bonusScore += gained;
    this.game.bus.emit('score:changed', { score: this.score, delta: gained });
    return gained;
  }

  awardBonus({ coin = 0, score = 0, label = null, toast = true }) {
    if (coin) this.addCoin(coin, 'bonus');
    if (score) this.addFlatScore(score);
    if (label && toast) {
      const bits = [];
      if (score) bits.push(`+${score.toLocaleString()}`);
      if (coin) bits.push(`+${coin.toLocaleString()}◈`);
      this.game.ui.toast(`${label}  ${bits.join('  ')}`, 'info', 2400);
    }
  }

  // --- wave hooks (called by WaveDirector) -----------------------------------

  beginWave(wave) {
    this._wave = wave;
    this._waveLeaks = 0;
    this._waveTrapTypes.clear();
    this.levelScoreValue += wave.score;
  }

  /**
   * Payouts that reward *how* the wave went rather than how many orcs were in it:
   * clearing at all, clearing clean, clearing fast, and clearing with a varied defence.
   * All priced off the wave's own score value so they scale with the campaign.
   */
  endWave({ time, wave }) {
    const w = wave || this._wave;
    if (!w) return;
    const base = w.score || 0;
    const purse = w.coin || 0;
    // Coin payouts scale with how many gates were live. A four-gate wave is not four
    // times the orcs, it is the *same* orcs spread over four corridors you each have to
    // stock — and a defence is priced per corridor. Measured without this, levels 7–10
    // could never afford a second row on any lane, and shrinking the waves made it worse
    // rather than better, because the kill income shrank with them.
    const lanes = w.spawns?.length || 1;
    const lf = laneFactor(lanes);
    let total = Math.round(base * BONUS.clear);
    let coin = Math.round(purse * BONUS.clearCoin * lf);
    const parts = ['WAVE CLEAR'];

    if (this._waveLeaks === 0) {
      total += Math.round(base * BONUS.flawless);
      coin += Math.round(purse * BONUS.flawlessCoin * lf);
      parts.push('FLAWLESS');
    }
    const variety = this._waveTrapTypes.size;
    if (variety >= 2) {
      total += Math.round(base * BONUS.variety * variety);
      parts.push(`${variety} TRAP TYPES`);
    }
    const par = w.parTime || 60;
    const speed = clamp((par - time) / (par * 0.5), 0, 1);
    if (speed > 0.05) {
      total += Math.round(base * BONUS.speed * speed);
      parts.push('SWIFT');
    }
    this.awardBonus({ score: total, coin, label: parts.join(' · ') });
  }

  endLevel() {
    const rift = this.game.level?.rift;
    if (!rift || !this.levelScoreValue) return;
    const frac = clamp(rift.hp / rift.max, 0, 1);
    const bonus = Math.round(this.levelScoreValue * BONUS.riftIntact * frac);
    if (bonus > 0) this.awardBonus({ score: bonus, label: `RIFT ${Math.round(frac * 100)}% INTACT` });
  }

  // --- kills -----------------------------------------------------------------

  _onKill(p) {
    const e = p.enemy;
    const def = e.def || {};
    this.kills++;
    if (p.byTrap) this.trapKills++; else this.playerKills++;
    if (p.byTrap && p.trapId) this._waveTrapTypes.add(p.trapId);

    const base = def.score ?? 100;
    let comboGain = 1;
    let extraScore = 0;
    const now = this.game.clock.elapsed;

    // --- multi-kill: everything that died in the same beat as the last one ---
    this._mkN = (now - this._mkT <= MULTIKILL_WINDOW) ? this._mkN + 1 : 1;
    this._mkT = now;
    if (this._mkN >= 2) {
      const mul = MULTIKILL[Math.min(this._mkN, 6)] ?? 2.6;
      extraScore += base * (mul - 1);
      if (this._mkN === 3) comboGain += 1;
      if (this._mkN >= 5) comboGain += 1;
    }

    // --- trap chain: three different traps in a row means your layers are working ---
    if (p.byTrap && p.trapId) {
      if (this._chain[this._chain.length - 1] === p.trapId) this._chain.length = 0;
      this._chain.push(p.trapId);
      if (this._chain.length >= CHAIN_LENGTH) {
        extraScore += base * CHAIN_BONUS;
        comboGain += 1;
        this._chain.length = 0;
      }
    } else {
      this._chain.length = 0;
    }

    // --- counter kill: the right answer to this archetype ---
    const type = e.lastHitType || TRAP_DAMAGE_TYPE[p.trapId] || null;
    const resist = def.resist || null;
    if (type && resist && (resist[type] ?? 1) > 1) {
      extraScore += base * COUNTER_BONUS;
      comboGain += 1;
    }

    this._bumpCombo(comboGain);

    // Coin follows the combo, but gently: at 5x you are funding your next layer 25%
    // faster, which is a reason to take the risk without breaking the economy.
    const coinMul = 1 + 0.25 * (this.multiplier - 1) / 4;
    this.addCoin(Math.round((def.coin ?? 20) * coinMul));
    this.addScore(base);
    if (extraScore > 0) this.addFlatScore(extraScore * this.multiplier);
  }

  _bumpCombo(n) {
    this.combo += n;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.multiplier = multiplierFor(this.combo);
    this.comboWindow = comboWindow(this.multiplier);
    this.comboTimer = this.comboWindow;
    this.game.bus.emit('combo:changed', { combo: this.combo, multiplier: this.multiplier });
  }

  _onLeak() {
    this.leaks++;
    this._waveLeaks++;
    // A leak is the only thing that wipes the combo outright. Everything else costs a rung.
    this.combo = 0; this.multiplier = 1; this.comboTimer = 0;
    this._chain.length = 0; this._mkN = 0;
    this.game.bus.emit('combo:changed', { combo: 0, multiplier: 1 });
  }

  _tick(dt) {
    // The level clock, and it runs during the *build* phase too. That is the entire
    // reason the time axis has teeth: the build phase has no timer and never will, so
    // the only cost of deliberating is the one charged here.
    const st = this.game.state;
    if (st === 'build' || st === 'wave') this.levelTime += dt;

    if (this.comboTimer <= 0) return;
    this.comboTimer -= dt;
    if (this.comboTimer > 0) return;
    if (this.combo <= 0) return;
    // Drop one rung instead of to zero: a cliff makes players stop caring the instant
    // they slip, a rung makes them fight to climb back.
    const rung = previousRung(this.combo);
    this.combo = rung;
    this.multiplier = multiplierFor(this.combo);
    this.comboWindow = comboWindow(this.multiplier);
    this.comboTimer = this.combo > 0 ? this.comboWindow : 0;
    this.game.bus.emit('combo:changed', { combo: this.combo, multiplier: this.multiplier });
  }

  /**
   * The three measured ratios the rating is built from. Split out from `rating()` so the
   * HUD can show them live during a run — a player who can see the rift bar and the clock
   * against par is a player who can *decide* between them, which is the whole point.
   */
  ratios() {
    const rift = this.game.level?.rift;
    return {
      scoreRatio: this.score / (this.par.score || 10000),
      riftFrac: rift ? clamp(rift.hp / rift.max, 0, 1) : 1,
      timeRatio: this.levelTime / (this.par.time || 300),
    };
  }

  /**
   * 0-5 skulls plus the axis that held it there. See `Difficulty.rate()` for why it is a
   * minimum over three antagonistic axes rather than one score threshold.
   */
  rating(won = this.game.state === 'victory') {
    return rate({ ...this.ratios(), won });
  }

  /** Kept as the short form the rest of the game already calls. */
  skulls() { return this.rating().skulls; }

  summary() {
    const r = this.rating();
    const q = this.ratios();
    const rift = this.game.level?.rift;
    return {
      score: this.score, skulls: r.skulls, axes: r.axes, limiter: r.limiter,
      kills: this.kills, leaks: this.leaks,
      trapKills: this.trapKills, playerKills: this.playerKills, bestCombo: this.bestCombo,
      bonusScore: this.bonusScore, coin: this.coin,
      par: this.par.score, parTime: this.par.time,
      time: Math.round(this.levelTime),
      rift: rift ? rift.hp : null, riftMax: rift ? rift.max : null,
      scoreRatio: +q.scoreRatio.toFixed(2),
      riftFrac: +q.riftFrac.toFixed(2),
      timeRatio: +q.timeRatio.toFixed(2),
    };
  }
}

function multiplierFor(combo) {
  let m = 1;
  for (const rung of COMBO_LADDER) if (combo >= rung.at) m = rung.mult;
  return m;
}

/** The kill count at the bottom of the rung below the one `combo` currently sits on. */
function previousRung(combo) {
  for (let i = COMBO_LADDER.length - 1; i >= 0; i--) {
    if (combo >= COMBO_LADDER[i].at) return i > 0 ? COMBO_LADDER[i - 1].at : 0;
  }
  return 0;
}
