import { weaponIcon, spellIcon } from './icons.js';
import { esc } from './spellbook.js';

/**
 * The player's own kit: weapons, spells, mana, and the between-levels skill tree.
 *
 * PLAYER shipped all four in round 1 with a read-only surface built for exactly this
 * (`weaponInfo()`, `spellInfo()`, `progression.available()`), and none of it had a pixel.
 * Three consequences, all of which this file exists to fix:
 *
 *   - Two of the four weapons cost mana and there was no mana bar, so running dry read as
 *     the game ignoring your clicks.
 *   - Three spells sat on F / C / V with no indication that they existed, let alone
 *     whether they were off cooldown.
 *   - Two weapons are semi-auto (`auto: false`) and holding the button does nothing. A
 *     review called them undiscoverable, and it was right: the fix is not a tuning change,
 *     it is a label. Every weapon chip now says AUTO or SEMI, and holding the button on a
 *     semi-auto weapon lights the word.
 *
 * The strip is deliberately icon-first and pinned to the bottom-left corner: it is a
 * glance target during a fight, not a thing to read.
 */

// ------------------------------------------------------------------- weapons
export function renderWeapons(game) {
  const p = game.player;
  if (!p?.weaponInfo) return '';
  const info = p.weaponInfo();
  return info.map((w, i) => {
    // `auto` is not on the weaponInfo() surface yet — see the module report. Read-only
    // peek at the def until it is, with a safe default of "automatic".
    const auto = p.weapons?.[i]?.def?.auto !== false;
    const ammo = w.magazine !== Infinity && Number.isFinite(w.magazine);
    return `<div class="wp ${w.selected ? 'on' : ''} ${w.reloading > 0 ? 'reloading' : ''}"
              data-w="${i}" title="${esc(w.name)} — ${esc(w.role ?? '')}">
      <span class="wp-ico">${weaponIcon(w.id, w.icon)}</span>
      <span class="wp-fire ${auto ? 'auto' : 'semi'}">${auto ? 'AUTO' : 'SEMI'}</span>
      ${ammo ? `<span class="wp-ammo">${w.ammo}<i>/${w.magazine}</i></span>` : ''}
      ${w.mana ? `<span class="wp-mana">${w.mana}</span>` : ''}
    </div>`;
  }).join('');
}

/** Only the volatile bits, so the frame loop never rebuilds the strip's DOM. */
export function syncWeapons(game, host) {
  const p = game.player;
  if (!p?.weaponInfo || !host.children.length) return;
  const info = p.weaponInfo();
  for (let i = 0; i < host.children.length && i < info.length; i++) {
    const el = host.children[i];
    const w = info[i];
    el.classList.toggle('on', w.selected);
    el.classList.toggle('reloading', w.reloading > 0);
    el.classList.toggle('dry', !!w.mana && p.mana < w.mana);
    const ammo = el.querySelector('.wp-ammo');
    if (ammo) ammo.firstChild.nodeValue = String(w.ammo);
  }
}

// -------------------------------------------------------------------- spells
export function renderSpells(game) {
  const p = game.player;
  if (!p?.spellInfo) return '';
  return p.spellInfo().map((s) => `
    <div class="sp" data-spell="${s.id}" title="${esc(s.name)}">
      <span class="sp-cd"></span>
      <span class="sp-ico">${spellIcon(s.id, s.icon)}</span>
      <span class="sp-key">${esc(s.key ?? '')}</span>
    </div>`).join('');
}

export function syncSpells(game, host) {
  const p = game.player;
  if (!p?.spellInfo || !host.children.length) return;
  const info = p.spellInfo();
  for (let i = 0; i < host.children.length && i < info.length; i++) {
    const el = host.children[i];
    const s = info[i];
    const f = s.cooldown ? Math.max(0, Math.min(1, s.remaining / s.cooldown)) : 0;
    el.classList.toggle('ready', !!s.ready);
    // A vertical wipe rather than a radial sweep: at 34px a conic gradient is mush, and
    // "how much is left" reads faster off a straight edge anyway.
    el.style.setProperty('--cd', `${f * 100}%`);
  }
}

// ---------------------------------------------------------------- skill tree
/**
 * Eight lines, 2-3 ranks each, one point per level cleared and a second for four skulls.
 * Respec is free and prominent — a tree nobody dares open the first point on is a tree
 * that may as well not exist.
 */
export function renderSkills(game, { context = 'menu' } = {}) {
  const prog = game.player?.progression;
  if (!prog) return '<div class="sheet"><p class="empty">No hero loaded.</p></div>';
  const points = prog.points ?? 0;
  const lines = prog.available() ?? [];

  const cards = lines.map((u) => `
    <div class="sk-card ${u.rank ? 'owned' : ''} ${u.maxed ? 'maxed' : ''}">
      <div class="sk-ico" aria-hidden="true">${esc(u.icon ?? '✦')}</div>
      <div class="sk-body">
        <div class="sk-name">${esc(u.name)}</div>
        <div class="sk-blurb">${esc(u.blurb)}</div>
        <div class="sk-pips">${rankPips(u.rank, u.ranks)}
          <span class="sk-rank">${u.rank} / ${u.ranks}</span></div>
      </div>
      ${u.maxed
        ? '<div class="sk-buy maxed">MAXED</div>'
        : `<button class="btn tiny sk-buy ${u.affordable ? '' : 'poor'}" data-action="sk-buy"
             data-up="${esc(u.id)}" ${u.affordable ? '' : 'disabled'}>${u.cost} PT${u.cost > 1 ? 'S' : ''}</button>`}
    </div>`).join('');

  return `
    <div class="sheet wide skills-sheet">
      <div class="sheet-head">
        <h2 class="ornate">THE HERO</h2>
        <p class="sheet-sub">One point for every level you clear, and a second for clearing it at four skulls.
          Ten levels will not max everything — that is the choice.</p>
      </div>
      <div class="sb-purse">
        <span class="sb-count">${points}</span>
        <span class="sb-of">skill point${points === 1 ? '' : 's'} unspent</span>
        <button class="btn tiny ghost" data-action="sk-respec">REFUND ALL</button>
      </div>
      <div class="sk-grid scroll-y">${cards || '<p class="empty">No upgrades.</p>'}</div>
      <div class="menu">
        <button class="btn primary" data-action="${context === 'results' ? 'next' : 'back'}">
          ${context === 'results' ? 'ONWARD' : 'BACK'}</button>
      </div>
    </div>`;
}

function rankPips(rank, ranks) {
  let s = '';
  for (let i = 1; i <= ranks; i++) s += `<i class="pip ${i <= rank ? 'on' : ''}"></i>`;
  return s;
}
