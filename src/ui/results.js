import { SKULL_AXES, AXIS_LABEL } from '../director/Difficulty.js';
import { SKULL, skullRow, COIN } from './icons.js';
import { esc, availableSkulls } from './spellbook.js';

/**
 * The results screen, rebuilt for the three-axis rating.
 *
 * The old screen showed one meter — score against par — which is now a third of the
 * story and, worse, the *least* likely axis to be the one that held you down. DIRECTOR's
 * rating is `min(scoreTier, riftTier, timeTier)`: a minimum names your weakest
 * discipline, and a rating that names your weakest discipline is a rating you replay.
 * So the screen's job is exactly two sentences:
 *
 *     "Three skulls."
 *     "Your limiter was TIME."
 *
 * and then the evidence for both, as three meters you can compare at a glance.
 *
 * Two decisions worth defending:
 *
 *   1. ALL THREE METERS FILL RIGHTWARD FOR "BETTER", including TIME, whose raw ratio is
 *      lower-is-better. A row of meters where one of them means the opposite of the other
 *      two cannot be read at a glance, and glanceability is the entire product here. The
 *      raw figure ("4:12 / par 5:00") is printed underneath so nothing is hidden.
 *   2. THE THRESHOLDS ARE DRAWN ON THE TRACK, from `SKULL_AXES` rather than from a copy.
 *      A meter without its thresholds tells you where you are but not what it would take
 *      to do better, and "what would it take" is the replay question.
 */

/** Display bounds per axis: [worst, best] in the axis's own raw units. */
const DOMAIN = {
  score: [0, 1.80],
  rift: [0, 1.00],
  time: [1.90, 0.60],     // reversed on purpose: lower ratio is better
};

const AXIS_BLURB = {
  rift: 'Five skulls is a flawless rift. Build another row before you press go.',
  time: 'The whole-level clock, build phases included. Start waves sooner.',
  score: 'Score is combo. Stand in the killbox while the wave is thick.',
};

const AXIS_NOTE = {
  rift: 'not one point lost',
  time: 'including build phases',
  score: 'combo × everything',
};

const frac = (axis, v) => {
  const [lo, hi] = DOMAIN[axis];
  const f = (v - lo) / (hi - lo);
  return Math.max(0, Math.min(1, f));
};

const mmss = (s) => {
  const n = Math.max(0, Math.round(s || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
};

/**
 * One axis meter. `SKULL_AXES[axis]` is ordered [5,4,3,2,1]; the Infinity entry on the
 * time row is the "you finished at all" threshold and has no place on a ruler, so it is
 * dropped rather than clamped to the end of the track.
 */
function axisMeter(axis, { value, tier, raw, limiter }) {
  const ticks = SKULL_AXES[axis]
    .map((t, i) => ({ t, skulls: 5 - i }))
    .filter((x) => Number.isFinite(x.t))
    .map((x) => `<i class="ax-tick ${x.skulls <= tier ? 'passed' : ''}" style="left:${frac(axis, x.t) * 100}%"
                    data-n="${x.skulls}"></i>`)
    .join('');

  return `
    <div class="ax ax-${axis} ${limiter ? 'limiter' : ''} tier-${tier}">
      <div class="ax-head">
        <span class="ax-name">${AXIS_LABEL[axis]}</span>
        <span class="ax-tier">${skullRow(tier)}</span>
      </div>
      <div class="ax-track">
        <div class="ax-fill" style="width:${frac(axis, value) * 100}%"></div>
        ${ticks}
      </div>
      <div class="ax-legend"><b>${raw}</b><i>${AXIS_NOTE[axis]}</i></div>
    </div>`;
}

export function renderResults(game, p, { levelName = '', last = false } = {}) {
  const s = game.scoring.summary();
  const axes = s.axes ?? { score: 0, rift: 0, time: 0 };
  const trapPct = s.kills ? Math.round((s.trapKills / s.kills) * 100) : 0;
  const riftTxt = s.riftMax != null ? `${s.rift} / ${s.riftMax}` : `${Math.round(s.riftFrac * 100)}%`;

  // On a loss the limiter is meaningless — you did not clear it, and the honest sentence
  // is "the rift broke", not "your weakest axis was score".
  //
  // And a repair: `rate()` floors a win to one skull but looks for the limiter by
  // matching the *floored* rating against the axis tiers, so a run with a zero-tier axis
  // comes back `skulls: 1, limiter: null` and the screen would then congratulate you on a
  // flawless run. Recover it from the raw minimum. Reported to DIRECTOR — this line goes
  // away when `rate()` matches against the unfloored minimum instead.
  let lim = p.win ? s.limiter : null;
  const worst = Math.min(axes.rift, axes.time, axes.score);
  if (p.win && !lim && worst < 5) {
    for (const k of ['rift', 'time', 'score']) if (axes[k] === worst) { lim = k; break; }
  }

  const meters = [
    axisMeter('rift', {
      value: s.riftFrac, tier: axes.rift, limiter: lim === 'rift',
      raw: riftTxt,
    }),
    axisMeter('time', {
      value: s.timeRatio, tier: axes.time, limiter: lim === 'time',
      raw: `${mmss(s.time)} <span>/ par ${mmss(s.parTime)}</span>`,
    }),
    axisMeter('score', {
      value: s.scoreRatio, tier: axes.score, limiter: lim === 'score',
      raw: `${s.score.toLocaleString()} <span>/ par ${(s.par || 0).toLocaleString()}</span>`,
    }),
  ].join('');

  const verdict = !p.win
    ? '<div class="res-verdict lose">The horde reached the rift. Nothing else on this screen matters.</div>'
    : lim
      ? `<div class="res-verdict">Your limiter was <b>${AXIS_LABEL[lim]}</b>.
           <i>${esc(AXIS_BLURB[lim])}</i></div>`
      // "Flawless" is claimed off the rating itself, never off the absence of a limiter:
      // a missing limiter is a bug shape, and congratulating a one-skull run on it is the
      // single worst thing this screen could say.
      : s.skulls >= 5
        ? '<div class="res-verdict perfect">Flawless on all three. There is nothing left to fix.</div>'
        : '<div class="res-verdict">The rift held. Compare the three meters — the shortest one is your next run.</div>';

  return `
    <div class="sheet results-sheet ${p.win ? 'win' : 'lose'}">
      <div class="sheet-head">
        <h2 class="ornate ${p.win ? 'win' : 'lose'}">${p.campaign ? 'CAMPAIGN COMPLETE' : p.win ? 'RIFT HELD' : 'RIFT BREACHED'}</h2>
        <div class="res-level">${esc(levelName)}</div>
      </div>

      <div class="skull-row">${skullRow(p.win ? s.skulls : 0)}</div>
      ${verdict}

      <div class="ax-grid">${meters}</div>

      <div class="res-stats">
        ${stat('Orcs killed', s.kills)}
        ${stat('By your traps', `${s.trapKills} <i>(${trapPct}%)</i>`)}
        ${stat('By your hand', s.playerKills)}
        ${stat('Best combo', `${s.bestCombo}×`)}
        ${stat('Leaks', s.leaks, s.leaks ? 'bad' : 'good')}
        ${stat('Coin left', `<span class="ico">${COIN}</span>${s.coin.toLocaleString()}`)}
      </div>

      <div class="menu">
        ${p.win && !last && !p.campaign ? '<button class="btn primary" data-action="next">NEXT LEVEL</button>' : ''}
        <button class="btn" data-action="skills">SKILLS</button>
        <button class="btn" data-action="spellbook">SPELLBOOK <span class="sk">${SKULL}</span>${availableSkulls(game.save)}</button>
        <button class="btn" data-action="retry">${p.win ? 'REPLAY' : 'TRY AGAIN'}</button>
        <button class="btn" data-action="quit">MENU</button>
      </div>
    </div>`;
}

const stat = (label, value, tone = '') =>
  `<div class="res-stat ${tone}"><span>${label}</span><b>${value}</b></div>`;
