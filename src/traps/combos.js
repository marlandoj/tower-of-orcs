import { applyDamage, status, recomputeStatusMods } from '../shared/Damage.js';
import { TILE } from '../world/Grid.js';
import { v0 } from '../shared/scratch.js';

/**
 * Trap interactions — the part of *Orcs Must Die!* that turns a row of traps into a
 * machine you designed. A trap on its own is a number; a trap that sets up the next
 * trap is a plan, and the game has to pay you for having one.
 *
 * Every trap deals damage through `trapDamage()` instead of calling `applyDamage`
 * directly, so the coating on the victim (tar, oil, ice, "launched") can rewrite the
 * hit before it lands. Damage itself still goes through the one funnel — this only
 * decides the numbers and the statuses that go in.
 *
 * The five that matter:
 *   tar    + fire      -> TAR FIRE   the tar burns, and it burns for much longer
 *   tar    + lightning -> CONDUCTED  wet tar conducts; the chain hits harder and further
 *   oil    + fire      -> OIL BLAST  acid/oil film detonates and is consumed
 *   ice    + crush     -> SHATTER    a frozen orc does not get crushed, it explodes
 *   spring + anything  -> AERIAL     airborne orcs cannot brace; and pits eat them
 *
 * And one deliberate anti-combo: fire on a frozen target thaws it for reduced damage.
 * Punishing a bad order is what makes the good order feel like knowledge.
 */

const has = (e, kind) => {
  const st = e.statuses;
  for (let i = 0; i < st.length; i++) if (st[i].kind === kind) return true;
  return false;
};
const drop = (e, kind) => {
  const st = e.statuses;
  for (let i = st.length - 1; i >= 0; i--) if (st[i].kind === kind) st.splice(i, 1);
};

/** True while an orc is off the ground because a trap put it there. */
export function isLaunched(e) {
  return !e.airborne && (has(e, 'launched') || e.position.y > 1.1);
}

const COMBO_STYLE = {
  'TAR FIRE':  { color: [1.0, 0.45, 0.08], kind: 'fire' },
  'CONDUCTED': { color: [0.65, 0.85, 1.0], kind: 'lightning' },
  'OIL BLAST': { color: [0.8, 1.0, 0.25], kind: 'fire' },
  'SHATTER':   { color: [0.65, 0.95, 1.0], kind: 'ice' },
  'AERIAL':    { color: [0.6, 1.0, 0.7], kind: 'crit' },
  'PITFALL':   { color: [0.9, 0.7, 0.4], kind: 'crit' },
};

/**
 * The trap damage funnel. Returns the damage actually dealt.
 * `spec` is the same shape `applyDamage` takes; we may rewrite amount and statuses.
 */
export function trapDamage(game, trap, enemy, spec) {
  if (!enemy || enemy.dead) return 0;
  const type = spec.type || 'physical';
  let mult = 1;
  let statuses = spec.statuses || null;
  const fired = [];

  // --- coating reactions ---------------------------------------------------
  if (type === 'fire') {
    if (has(enemy, 'tar') && !enemy.has('fire-immune')) {
      mult *= 1.75;
      // Tar clings: the burn outlives the trap that lit it, which is the whole point.
      statuses = extendBurn(statuses, 2.6, 1.4);
      fired.push('TAR FIRE');
    }
    if (has(enemy, 'oiled') && !enemy.has('fire-immune')) {
      mult *= 2.0;
      drop(enemy, 'oiled');
      fired.push('OIL BLAST');
    }
    if (has(enemy, 'freeze')) {
      // Wrong order on purpose: the fire wastes itself thawing the ice.
      mult *= 0.7;
      drop(enemy, 'freeze');
      recompute(enemy);
    }
  } else if (type === 'lightning' && has(enemy, 'tar')) {
    mult *= 1.6;
    fired.push('CONDUCTED');
  } else if ((type === 'crush' || type === 'physical') && has(enemy, 'freeze')) {
    mult *= 2.4;
    drop(enemy, 'freeze');
    recompute(enemy);
    fired.push('SHATTER');
  }

  // Anything hitting an orc that a spring put in the air hits a target that cannot brace.
  if (isLaunched(enemy) && spec.amount > 0) {
    mult *= 1.5;
    fired.push('AERIAL');
  }

  const dealt = applyDamage(enemy, {
    ...spec,
    amount: spec.amount * Math.min(mult, 4),
    statuses: credit(statuses, spec.source),
  }, game);

  if (fired.length && dealt > 0) {
    for (const name of fired) award(game, trap, enemy, name);
    if (fired.includes('SHATTER')) {
      game.fx.frost(enemy.position, 1.6, 22);
      game.audio.play('death.shatter', { position: enemy.position });
      if (enemy.dead) game.fx.gib(enemy.position, null, 9, [0.55, 0.85, 1.0]);
    }
    if (fired.includes('OIL BLAST')) {
      game.fx.fire(enemy.position, 1.5, 16);
      game.audio.play('death.burn', { position: enemy.position });
    }
    if (fired.includes('TAR FIRE')) game.fx.fire(enemy.position, 1.1, 8);
  }
  return dealt;
}

/** Statuses removed by a combo must be reflected immediately, or a shattered orc stays rooted. */
function recompute(e) {
  if (e.statuses && e.statusMods) recomputeStatusMods(e);
}

/**
 * Damage-over-time ticks are dealt by the enemy itself, and default to a `{kind:'status'}`
 * source — so an orc that burns to death after leaving the brimstone counts as nobody's
 * kill. Stamping the trap onto the status makes the kill feed and `trapKills` honest.
 */
function credit(statuses, source) {
  if (!statuses || !source) return statuses;
  let out = statuses;
  for (let i = 0; i < statuses.length; i++) {
    const s = statuses[i];
    if ((s.kind !== 'burn' && s.kind !== 'poison') || s.extra?.source) continue;
    if (out === statuses) out = statuses.slice();
    out[i] = { ...s, extra: { ...(s.extra || {}), source } };
  }
  return out;
}

function extendBurn(statuses, durMul, powMul) {
  // Copy: the caller reuses one status array across every victim in an AoE.
  const out = statuses ? statuses.map((s) => ({ ...s })) : [];
  let found = false;
  for (const s of out) {
    if (s.kind === 'burn') { s.duration *= durMul; s.power *= powMul; found = true; }
  }
  if (!found) out.push(status('burn', 3.2, 14));
  return out;
}

const BONUS = { 'TAR FIRE': 120, 'CONDUCTED': 140, 'OIL BLAST': 180, 'SHATTER': 200, 'AERIAL': 90, 'PITFALL': 260 };
const _seen = new Set();
let _toastCd = 0;

/** Pay the player for the interaction, loudly enough that they notice they did it. */
export function award(game, trap, enemy, name) {
  const style = COMBO_STYLE[name] || { color: [1, 0.9, 0.5], kind: 'crit' };
  const bonus = BONUS[name] ?? 100;
  game.scoring?.addScore?.(bonus);
  game.fx.ring(enemy?.position ?? trap.world, 1.1, style.color, 14);
  game.bus.emit('trap:combo', { name, trap, enemy, bonus, position: enemy?.position ?? trap.world });

  // Teach it once, then stop lecturing: the first time a combo lands it gets a toast,
  // after that the score pop and the ring carry it.
  if (!_seen.has(name) && game.clock.elapsed > _toastCd) {
    _seen.add(name);
    _toastCd = game.clock.elapsed + 1.2;
    game.ui?.toast?.(`COMBO — ${name}  +${bonus}`, 'info');
  }
}
export function resetComboTeaching() { _seen.clear(); }

// --- spring launches -------------------------------------------------------
/**
 * Anything a spring throws is tracked until it lands. Two payoffs: a pit under the
 * landing point is an instant kill, and landing on another trap is what the whole
 * spring-into-spikes fantasy is made of.
 */
const _flights = [];

export function launch(game, trap, enemy, vx, vy, vz) {
  if (enemy.has('unstoppable')) return false;
  enemy.applyImpulse(vx, vy, vz);
  enemy.addStatus(status('launched', 1.4, 1), game);
  enemy.addStatus(status('stun', 0.55, 1), game);

  // Predict where it comes down. Enemy._integrate rescues anything standing on a pit
  // cell, so a pit kill can never be observed after the fact — it is decided at launch.
  // Gravity is 26/s², horizontal impulse decays by 0.02^dt, hence the integral below.
  const t = Math.max(0.25, (2 * vy) / 26);
  const k = (1 - Math.pow(0.02, t)) / 3.912;
  const lx = enemy.position.x + vx * k;
  const lz = enemy.position.z + vz * k;
  const cell = game.grid.cell(Math.floor(lx / TILE), Math.floor(lz / TILE));
  const intoPit = !!cell && (cell.kind === 'void' || cell.flags.has('pit'));
  _flights.push({ e: enemy, trap, t: 0, life: Math.max(0.35, Math.min(t, 1.1)), intoPit, lx, lz });
  return true;
}

/** Ticked once per frame by TrapManager. */
export function updateFlights(game, dt) {
  for (let i = _flights.length - 1; i >= 0; i--) {
    const f = _flights[i];
    f.t += dt;
    if (f.e.dead) { _flights.splice(i, 1); continue; }
    if (f.t < f.life) continue;
    _flights.splice(i, 1);
    if (f.intoPit) {
      v0.set(f.lx, 0, f.lz);
      applyDamage(f.e, {
        amount: 100000, type: 'physical',
        source: { kind: 'trap', id: f.trap.def.id, trap: f.trap }, position: v0,
      }, game);
      if (f.e.dead) {
        f.trap.kills++;
        award(game, f.trap, f.e, 'PITFALL');
        game.fx.dust(v0, 1.4, 16, [0.35, 0.3, 0.26]);
        game.audio.play('orc.death', { position: v0, pitch: 0.7 });
      }
    }
  }
}
export function clearFlights() { _flights.length = 0; }
