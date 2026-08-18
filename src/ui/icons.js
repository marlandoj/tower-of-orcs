/**
 * Every glyph in the UI, as inline SVG.
 *
 * Why inline SVG and not image files or an icon font: the game ships with zero network
 * requests (theme.css has no webfont either), icons stay crisp at any DPI, and they can
 * be recoloured per trap element straight from CSS custom properties.
 *
 * Drawing convention, so a new icon slots in without touching CSS:
 *   class "s"  — stroked with the inherited text colour (structure: wood, stone, mounts)
 *   class "d"  — filled, dimmed (background masses)
 *   class "a"  — filled with --acc, the element accent (the part that says *what it does*)
 *   class "as" — stroked with --acc
 * Everything is drawn in a 32×32 box so icons optically match at any size.
 */

const svg = (body) =>
  `<svg class="icon" viewBox="0 0 32 32" aria-hidden="true" focusable="false">${body}</svg>`;

// --------------------------------------------------------------------- traps
/**
 * Per-trap art. Keyed by id, but never *only* by id: the roster is another module's
 * file and it changes, so anything unknown falls through to a tag/surface icon rather
 * than rendering an empty box.
 */
const TRAP_ART = {
  'spike-floor': `
    <path class="d" d="M3 25h26v4H3z"/>
    <path class="a" d="M6 25 8.5 9 11 25zM13.5 25 16 5l2.5 20zM21 25l2.5-13L26 25z"/>`,

  'tar-pit': `
    <ellipse class="d" cx="16" cy="21" rx="13" ry="7"/>
    <ellipse class="a" cx="16" cy="21" rx="8" ry="4"/>
    <path class="a" d="M11 4c0 3-2.6 4.2-2.6 6.6a2.6 2.6 0 0 0 5.2 0C13.6 8.2 11 7 11 4z"/>
    <circle class="a" cx="21" cy="11" r="2"/>`,

  'arrow-wall': `
    <path class="d" d="M2 3h6v26H2z"/>
    <g class="as">
      <path d="M9 8h13m-4-3.2L22.2 8 18 11.2"/>
      <path d="M9 16h16m-4-3.2L25.2 16 21 19.2"/>
      <path d="M9 24h13m-4-3.2L22.2 24 18 27.2"/>
    </g>`,

  'boom-barrel': `
    <path class="d" d="M9 11c0-2.2 14-2.2 14 0v14c0 2.2-14 2.2-14 0z"/>
    <g class="as"><path d="M8.6 15.5h14.8M8.6 20.6h14.8"/></g>
    <path class="s" d="M16 11V7c0-1.6 2-1.6 2-3"/>
    <circle class="a" cx="19" cy="3.2" r="2.6"/>`,

  'ceiling-pounder': `
    <path class="d" d="M4 2h24v3.4H4z"/>
    <path class="s" d="M16 5.4v8"/>
    <path class="a" d="M8 13.4h16v10H8z"/>
    <path class="d" d="M5 28h22v3H5z"/>`,

  'spring-trap': `
    <path class="d" d="M5 25h22v4H5z"/>
    <path class="as" d="M9 24.5 23 21l-14-3.4L23 14"/>
    <path class="as" d="M16 12V3m0 0-4.2 4.4M16 3l4.2 4.4"/>`,

  'wall-blades': `
    <circle class="as" cx="16" cy="16" r="10" stroke-dasharray="3.2 3.2"/>
    <circle class="a" cx="16" cy="16" r="6.4"/>
    <circle class="d" cx="16" cy="16" r="2.6"/>
    <path class="d" d="M1 2h4v28H1z"/>`,

  brimstone: `
    <path class="d" d="M3 25h26v4H3z"/>
    <g class="s"><path d="M9 25v4M16 25v4M23 25v4"/></g>
    <path class="a" d="M16 2c.6 4.4 5.6 6.4 5.6 12.2A5.6 5.6 0 0 1 16 20a5.6 5.6 0 0 1-5.6-5.8c0-2.6 1.4-4 2.8-5.4-.2 2.6 1 3.6 1.9 3.6 1.3 0 1.8-1.6 1.1-3.9C15.6 6.4 15.2 4.4 16 2z"/>`,

  grinder: `
    <path class="d" d="M2 8h28v18H2z"/>
    <circle class="as" cx="10" cy="16" r="6" stroke-dasharray="2.8 2.8"/>
    <circle class="as" cx="22" cy="16" r="6" stroke-dasharray="2.8 2.8"/>
    <circle class="a" cx="10" cy="16" r="2"/>
    <circle class="a" cx="22" cy="16" r="2"/>`,

  'ice-vent': `
    <path class="d" d="M3 25h26v4H3z"/>
    <g class="as">
      <path d="M16 3v18M8 8l16 10M24 8 8 18"/>
      <path d="M13 5.4 16 8l3-2.6M13 18.6 16 16l3 2.6"/>
    </g>`,

  'lightning-rod': `
    <path class="d" d="M10 2h12v3.4H10z"/>
    <path class="s" d="M16 5.4v3"/>
    <circle class="a" cx="16" cy="12.6" r="4.4"/>
    <path class="a" d="M17.6 17.4 10 30h5.2L13.8 38 22 22h-5.4z"/>`,

  'acid-sprayer': `
    <rect class="d" x="3" y="6" width="10" height="20" rx="5"/>
    <path class="s" d="M13 13h4l3.4 3-3.4 3h-4z"/>
    <g class="a">
      <path d="M23 10c0 2.6-2.4 3.4-2.4 5.4a2.4 2.4 0 0 0 4.8 0C25.4 13.4 23 12.6 23 10z"/>
      <circle cx="28" cy="21" r="2.2"/><circle cx="22" cy="24" r="1.6"/>
    </g>`,

  'arcane-obelisk': `
    <path class="d" d="M7 27h18v4H7z"/>
    <path class="a" d="M16 2l5.4 10.4L18.6 27h-5.2L10.6 12.4z"/>
    <g class="s"><path d="M13.8 13h4.4M14.4 18h3.2"/></g>
    <path class="a" d="M27 4l1 3 3 1-3 1-1 3-1-3-3-1 3-1zM5 9l.8 2.2L8 12l-2.2.8L5 15l-.8-2.2L2 12l2.2-.8z"/>`,

  'guardian-archer': `
    <path class="as" d="M22 3a17 17 0 0 1 0 26"/>
    <path class="s" d="M22 3 22 29"/>
    <path class="a" d="M4 16h16l-4.4-4M20 16l-4.4 4"/>
    <path class="as" d="M4 16h16m-4.4-4L20 16l-4.4 4"/>`,

  'guardian-paladin': `
    <path class="a" d="M16 2l12 4.2v9.4C28 23 22.6 27.6 16 30 9.4 27.6 4 23 4 15.6V6.2z"/>
    <g class="s"><path d="M16 9v12M11 13.4h10"/></g>`,

  'guardian-hunter': `
    <path class="as" d="M4 28 24 8M18 6h8v8"/>
    <path class="as" d="M28 28 8 8M14 6H6v8"/>
    <circle class="a" cx="16" cy="18" r="3.4"/>`,

  // The Barricade reads as *timber across the tile*, not as a weapon: crossed baulks on
  // two posts, iron-banded. It must not look like anything that deals damage, because
  // the one thing a player has to learn about it is that it closes a tile and nothing else.
  barricade: `
    <path class="d" d="M3 6h4v22H3zM25 6h4v22h-4z"/>
    <path class="a" d="M2 10h28v5H2zM2 19h28v5H2z"/>
    <g class="s"><path d="M9 10v14M16 10v14M23 10v14"/></g>`,
};

/** Fallbacks, in priority order, when a trap id is not in TRAP_ART. */
const TAG_ART = {
  blocker: TRAP_ART.barricade,
  structure: TRAP_ART.barricade,
  fire: TRAP_ART.brimstone,
  ice: TRAP_ART['ice-vent'],
  lightning: TRAP_ART['lightning-rod'],
  poison: TRAP_ART['acid-sprayer'],
  arcane: TRAP_ART['arcane-obelisk'],
  ally: TRAP_ART['guardian-paladin'],
  'anti-air': TRAP_ART['arrow-wall'],
  crush: TRAP_ART['ceiling-pounder'],
  control: TRAP_ART['tar-pit'],
  ranged: TRAP_ART['arrow-wall'],
  physical: TRAP_ART['spike-floor'],
};

const SURFACE_ART = {
  floor: TRAP_ART['spike-floor'],
  wall: TRAP_ART['arrow-wall'],
  ceiling: TRAP_ART['ceiling-pounder'],
  guardian: TRAP_ART['guardian-paladin'],
  blocker: TRAP_ART.barricade,
};

/** Which colour a trap reads as. Purely from tags, so new traps theme themselves. */
const TAG_ACCENT = [
  ['fire', '#ff8b3a'], ['ice', '#8fe0ff'], ['lightning', '#a9d4ff'], ['poison', '#9ee863'],
  ['arcane', '#c79bff'], ['ally', '#7fd08a'], ['crush', '#e0c08a'],
  // Before `control`, which the Barricade does not carry but a future blocker might:
  // a blocker is timber and iron, and it should never read as an elemental trap.
  ['blocker', '#b98a52'], ['structure', '#b98a52'],
  ['control', '#c9a06a'], ['physical', '#c8d2dc'],
];

export function trapAccent(def) {
  const tags = def?.tags ?? [];
  for (const [tag, color] of TAG_ACCENT) if (tags.includes(tag)) return color;
  return '#d9a441';
}

export function trapIcon(def) {
  const art = TRAP_ART[def?.id]
    ?? (def?.tags ?? []).map((t) => TAG_ART[t]).find(Boolean)
    ?? SURFACE_ART[def?.surface]
    ?? `<path class="a" d="M16 3l13 13-13 13L3 16z"/>`;
  return svg(art);
}

// ------------------------------------------------------------------ surfaces
const SURFACE_GLYPH = {
  floor: `<path class="d" d="M2 20h28v8H2z"/><path class="a" d="M2 17h28v3H2z"/>`,
  wall: `<path class="d" d="M4 3h9v26H4z"/><path class="a" d="M13 3h3v26h-3z"/><path class="s" d="M20 10h8M20 16h8M20 22h8"/>`,
  ceiling: `<path class="a" d="M2 4h28v3H2z"/><path class="d" d="M2 7h28v6H2z"/><path class="s" d="M16 13v10M11 23h10"/>`,
  guardian: `<path class="a" d="M16 3l10 3.6v7.8C26 20.6 21.6 24.6 16 27c-5.6-2.4-10-6.4-10-12.6V6.6z"/><path class="s" d="M16 9v10"/>`,
  // A tile seen from above with a bar laid across it: the surface glyph has to say
  // "this is the whole tile", not "this sits on the floor of it".
  blocker: `<path class="s" d="M4 8h24v16H4z"/><path class="a" d="M2 13h28v6H2z"/>`,
};
export function surfaceIcon(surface) {
  return svg(SURFACE_GLYPH[surface] ?? SURFACE_GLYPH.floor);
}

// ------------------------------------------------------- weapons and spells
/**
 * PLAYER's weapon and spell defs already carry an emoji `icon`. Emoji are the one glyph
 * in the build whose shape is the *operating system's* choice, so the HUD draws its own
 * and keeps the emoji only as the fallback for anything added later.
 */
const WEAPON_ART = {
  crossbow: `<path class="as" d="M7 5a15 15 0 0 1 0 22"/><path class="s" d="M7 5v22"/>
    <path class="a" d="M7 16h17l-4.6-4.4M24 16l-4.6 4.4"/><path class="s" d="M24 16h6"/>`,
  blunderbuss: `<path class="d" d="M3 17h16v5H3z"/><path class="a" d="M19 13h6l5-4v18l-5-4h-6z"/>
    <path class="s" d="M6 22c0 4 4 5 6 4"/>`,
  staff: `<path class="s" d="M9 30 22 8"/><path class="d" d="M8 28l4 2-3 2z"/>
    <path class="a" d="M22 2c.5 3.6 4.6 5.2 4.6 10a4.6 4.6 0 1 1-9.2 0c0-2.2 1.2-3.4 2.4-4.6-.2 2.2.8 3 1.6 3 1 0 1.4-1.4.9-3.2C21.7 5.6 21.4 4 22 2z"/>`,
  lightning: `<circle class="s" cx="16" cy="16" r="11"/><circle class="as" cx="16" cy="16" r="7"/>
    <path class="a" d="M17.4 6 9 18h5l-1.4 8L23 13h-5.6z"/>`,
};
const SPELL_ART = {
  'frost-nova': `<g class="as"><path d="M16 3v26M5 9.5l22 13M27 9.5l-22 13"/>
    <path d="M12.6 5.4 16 8.6l3.4-3.2M12.6 26.6 16 23.4l3.4 3.2"/></g><circle class="a" cx="16" cy="16" r="3"/>`,
  blink: `<path class="a" d="M16 2l3.4 9.2L28 14l-8.6 2.8L16 26l-3.4-9.2L4 14l8.6-2.8z"/>
    <g class="s"><path d="M25 22.5l1.2 3.3L29 27l-2.8 1.2L25 31l-1.2-2.8L21 27l2.8-1.2z"/></g>`,
  'arcane-lance': `<path class="a" d="M2 14h20v-5l9 7-9 7v-5H2z"/><g class="s"><path d="M4 22h9M4 9h9"/></g>`,
};

const emojiGlyph = (ch) =>
  `<span class="emoji-ico" aria-hidden="true">${String(ch ?? '◈')}</span>`;

export function weaponIcon(id, fallback) {
  return WEAPON_ART[id] ? svg(WEAPON_ART[id]) : emojiGlyph(fallback);
}
export function spellIcon(id, fallback) {
  return SPELL_ART[id] ? svg(SPELL_ART[id]) : emojiGlyph(fallback);
}

/** A spawn door, for the lane readout and the minimap legend. */
export const GATE = svg(`
  <path class="d" d="M5 4h22v25H5z"/>
  <path class="a" d="M9 8h14v21H9z"/>
  <path class="s" d="M3 29h26"/>
  <circle class="k" cx="20" cy="19" r="1.6"/>`);

// ------------------------------------------------------------------- threats
/** Ability-flag glyphs for the wave threat panel. Legible at 18px. */
const THREAT_GLYPH = {
  flying: `<path class="a" d="M2 12c8-6 14-4 17 1 3-6 9-7 11-2-4 0-6 3-8 6-3 4-8 6-12 3 3-1 5-3 6-5-4 1-9 0-14-3z"/>`,
  armored: `<path class="a" d="M16 2l12 4.2v9.4C28 23 22.6 27.6 16 30 9.4 27.6 4 23 4 15.6V6.2z"/><path class="s" d="M10 13h12M10 19h12"/>`,
  shielded: `<path class="a" d="M16 2l12 4.2v9.4C28 23 22.6 27.6 16 30 9.4 27.6 4 23 4 15.6V6.2z"/><path class="s" d="M22 16h7M25 12.6 28.6 16 25 19.4"/>`,
  'trap-disarm': `<path class="a" d="M20 2a7 7 0 0 0-6.6 9.4L3 21.8 6.2 25l10.4-10.4A7 7 0 1 0 20 2z"/><circle class="s" cx="20" cy="9" r="2.4"/>`,
  'fire-immune': `<path class="a" d="M16 2c.6 4.4 5.6 6.4 5.6 12.2A5.6 5.6 0 0 1 16 20a5.6 5.6 0 0 1-5.6-5.8c0-2.6 1.4-4 2.8-5.4-.2 2.6 1 3.6 1.9 3.6 1.3 0 1.8-1.6 1.1-3.9C15.6 6.4 15.2 4.4 16 2z"/><path class="s" d="M4 28 28 4"/>`,
  'frost-immune': `<g class="as"><path d="M16 4v20M7 9l18 10M25 9 7 19"/></g><path class="s" d="M4 29 29 4"/>`,
  leaper: `<path class="as" d="M3 26C7 8 25 8 29 26"/><circle class="a" cx="16" cy="7" r="3.4"/>`,
  unstoppable: `<path class="a" d="M16 2l4 6h-3v9h9v-3l6 4-6 4v-3h-9v9h3l-4 6-4-6h3v-9H6v3l-6-4 6-4v3h9V8h-3z"/>`,
  healer: `<path class="a" d="M13 3h6v10h10v6H19v10h-6V19H3v-6h10z"/>`,
  buffer: `<path class="a" d="M16 3l10 11h-6v5h-8v-5H6zM16 17l10 11h-6v3h-8v-3H6z"/>`,
  ranged: `<path class="as" d="M23 4a18 18 0 0 1 0 24M23 4v24"/><path class="as" d="M4 16h16m-4.4-4L20 16l-4.4 4"/>`,
  summoner: `<path class="a" d="M16 4c-6 0-10 4-10 9 0 3 1.6 5 3 6v5h14v-5c1.4-1 3-3 3-6 0-5-4-9-10-9z"/><g class="s"><circle cx="12" cy="14" r="2"/><circle cx="20" cy="14" r="2"/></g>`,
  shielder: `<path class="d" d="M10 4l9 3.2v7C19 19 15 22.4 10 24 5 22.4 1 19 1 14.2v-7z"/><path class="a" d="M22 8l9 3.2v7C31 23 27 26.4 22 28c-5-1.6-9-5-9-9.8v-7z"/>`,
  regen: `<path class="as" d="M27 16A11 11 0 1 1 20 5.6"/><path class="a" d="M28 2v9h-9z"/>`,
  splitter: `<path class="a" d="M16 2l5 8h-10z"/><path class="a" d="M8 18l5 8H3zM24 18l5 8H19z"/><g class="s"><path d="M16 11 9 17M16 11l7 6"/></g>`,
  stealth: `<path class="as" d="M2 16s5-8 14-8 14 8 14 8-5 8-14 8S2 16 2 16z"/><circle class="a" cx="16" cy="16" r="3.6"/><path class="s" d="M4 28 28 4"/>`,
  boss: `<path class="a" d="M3 24 5 7l7 6 4-9 4 9 7-6 2 17z"/><path class="d" d="M3 25h26v4H3z"/>`,
  default: `<path class="a" d="M16 3l13 13-13 13L3 16z"/>`,
};
export function threatIcon(flag) {
  return svg(THREAT_GLYPH[flag] ?? THREAT_GLYPH.default);
}

// ---------------------------------------------------------------- ui glyphs
export const SKULL = svg(`
  <path class="a" d="M16 2C9 2 4 7 4 14c0 4 1.6 6.6 3.6 8.4V27h4v-3h2v3h4.8v-3h2v3h4v-4.6C26.4 20.6 28 18 28 14c0-7-5-12-12-12z"/>
  <g class="k"><circle cx="11.4" cy="14" r="3.2"/><circle cx="20.6" cy="14" r="3.2"/><path d="M16 17.6l-2 4h4z"/></g>`);

export const COIN = svg(`
  <circle class="a" cx="16" cy="16" r="12"/>
  <circle class="k" cx="16" cy="16" r="8.4"/>
  <path class="a" d="M16 9.6l2 4.4 4.4 2-4.4 2-2 4.4-2-4.4-4.4-2 4.4-2z"/>`);

/** Horizontal filigree used as a section divider on the overlays. */
export const DIVIDER = `<svg class="divider" viewBox="0 0 240 12" preserveAspectRatio="none" aria-hidden="true">
  <path d="M0 6h96M144 6h96" stroke="currentColor" stroke-width="1" fill="none" opacity=".55"/>
  <path d="M104 6 112 1.5 120 6 112 10.5zM120 6l8-4.5L136 6l-8 4.5z" fill="currentColor" opacity=".8"/>
</svg>`;

/** Rating row: `n` lit skulls out of `of`. */
export function skullRow(n, of = 5) {
  let out = '';
  for (let i = 0; i < of; i++) out += `<span class="skull ${i < n ? 'lit' : ''}">${SKULL}</span>`;
  return out;
}

export const LOCK = svg(`
  <path class="s" d="M10 14V9.6a6 6 0 0 1 12 0V14"/>
  <rect class="a" x="6" y="14" width="20" height="15" rx="2.4"/>
  <circle class="k" cx="16" cy="21" r="2.6"/>`);
