import { TRAPS } from '../traps/roster.js';
import { trapIcon, trapAccent, SKULL, skullRow } from './icons.js';
import { trapCadence } from './threat.js';

/**
 * The between-levels progression screen.
 *
 * `game.save.data.spellbook` already existed and nothing read it. This gives it a
 * meaning: `spellbook[trapId] = tier` (0–3), bought with the skulls the campaign pays
 * out for beating par. The currency is skulls rather than coin on purpose — coin is the
 * *inside* of a level, skulls are the *between*, so upgrading never competes with
 * building and the two economies stay legible.
 *
 * Tier N costs N skulls (1 + 2 + 3 = 6 to master a trap) and maps straight onto the
 * existing `trap.level` field, which the trap roster already uses to scale damage by
 * +35% a tier. UI applies it on `trap:placed` — see index.js.
 */

export const MAX_TIER = 3;
export const TIER_NAMES = ['', 'Reinforced', 'Runed', 'Mastered'];

/** Cost in skulls to go from `tier` to `tier + 1`. */
export const stepCost = (tier) => tier + 1;
/** Total skulls sunk into a trap at `tier`. */
export const sunkCost = (tier) => (tier * (tier + 1)) / 2;

export function book(save) {
  const d = save?.data;
  if (!d) return {};
  if (!d.spellbook || typeof d.spellbook !== 'object') d.spellbook = {};
  return d.spellbook;
}

export function tierOf(save, id) {
  const t = book(save)[id];
  return Number.isFinite(t) ? Math.max(0, Math.min(MAX_TIER, t)) : 0;
}

export function spentSkulls(save) {
  let n = 0;
  for (const id of Object.keys(book(save))) n += sunkCost(tierOf(save, id));
  return n;
}

export function earnedSkulls(save) {
  // totalSkulls is maintained by Save.recordResult; recompute defensively in case a
  // save predates it.
  const best = save?.data?.best ?? {};
  const summed = Object.values(best).reduce((s, r) => s + (r?.skulls ?? 0), 0);
  return Math.max(save?.data?.totalSkulls ?? 0, summed);
}

export function availableSkulls(save) {
  return Math.max(0, earnedSkulls(save) - spentSkulls(save));
}

export function canUpgrade(save, id) {
  const tier = tierOf(save, id);
  return tier < MAX_TIER && availableSkulls(save) >= stepCost(tier);
}

export function upgrade(save, id) {
  if (!canUpgrade(save, id)) return false;
  const b = book(save);
  b[id] = tierOf(save, id) + 1;
  save.flush();
  return true;
}

/** Give every skull back. Respec has to exist or players will not spend the first one. */
export function respec(save) {
  const d = save?.data;
  if (!d) return;
  d.spellbook = {};
  save.flush();
}

/** Damage bonus a tier grants, matching the roster's own `(level - 1) * 0.35`. */
export const tierBonus = (tier) => Math.round(tier * 35);

// ------------------------------------------------------------------ rendering
export function renderSpellbook(game, { context = 'menu' } = {}) {
  const save = game.save;
  const unlocked = (save?.unlockedLevel ?? 0) + 1;
  const avail = availableSkulls(save);
  const list = Array.isArray(TRAPS) ? TRAPS : [];

  const cards = list.map((def) => {
    const tier = tierOf(save, def.id);
    const locked = (def.unlockLevel ?? 1) > unlocked;
    const cost = stepCost(tier);
    const maxed = tier >= MAX_TIER;
    const affordable = !maxed && avail >= cost;
    return `
      <div class="sb-card ${locked ? 'locked' : ''} ${tier ? 'owned' : ''}" style="--acc:${trapAccent(def)}">
        <div class="sb-icon">${trapIcon(def)}</div>
        <div class="sb-body">
          <div class="sb-name">${esc(def.name)}</div>
          <div class="sb-meta">${esc(cap(def.surface))} · ${esc(trapCadence(def))} · <b>◈${def.cost}</b></div>
          <div class="sb-pips">${pips(tier)}<span class="sb-tier">${tier ? `${TIER_NAMES[tier]} · +${tierBonus(tier)}% damage` : 'Unenchanted'}</span></div>
        </div>
        ${locked
          ? `<div class="sb-buy locked-note">Unlocks level ${def.unlockLevel ?? 1}</div>`
          : maxed
            ? `<div class="sb-buy maxed">MASTERED</div>`
            : `<button class="btn tiny sb-buy ${affordable ? '' : 'poor'}" data-action="sb-upgrade" data-trap="${def.id}"
                 ${affordable ? '' : 'disabled'}>${cost} <span class="sk">${SKULL}</span></button>`}
      </div>`;
  }).join('');

  return `
    <div class="sheet spellbook-sheet">
      <div class="sheet-head">
        <h2 class="ornate">THE SPELLBOOK</h2>
        <p class="sheet-sub">Skulls earned across the campaign buy permanent enchantments. Every tier is +35% damage.</p>
      </div>
      <div class="sb-purse">
        <span class="sk big">${SKULL}</span>
        <span class="sb-count">${avail}</span>
        <span class="sb-of">of ${earnedSkulls(save)} skulls unspent</span>
        <button class="btn tiny ghost" data-action="sb-respec">REFUND ALL</button>
      </div>
      <div class="sb-grid scroll-y">${cards || '<p class="empty">No traps in the roster.</p>'}</div>
      <div class="menu">
        <button class="btn primary" data-action="${context === 'results' ? 'next' : 'back'}">
          ${context === 'results' ? 'ONWARD' : 'BACK'}
        </button>
      </div>
    </div>`;
}

function pips(tier) {
  let s = '';
  for (let i = 1; i <= MAX_TIER; i++) s += `<i class="pip ${i <= tier ? 'on' : ''}"></i>`;
  return s;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]
));

export { skullRow };
