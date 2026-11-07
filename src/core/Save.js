const KEY = 'tower-of-orcs.save.v1';

/** LocalStorage progression: unlocked levels, skull ratings, spellbook, settings. */
export class Save {
  constructor() { this.data = this._load(); }

  _load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return normalizeSave(JSON.parse(raw));
    } catch {}
    return defaults();
  }

  flush() {
    try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch {}
  }

  get unlockedLevel() { return this.data.unlockedLevel; }
  unlockLevel(i) {
    if (i > this.data.unlockedLevel) { this.data.unlockedLevel = i; this.flush(); }
  }
  recordResult(levelIndex, { score, skulls }) {
    const b = this.data.best[levelIndex] || { score: 0, skulls: 0 };
    this.data.best[levelIndex] = { score: Math.max(b.score, score), skulls: Math.max(b.skulls, skulls) };
    this.data.totalSkulls = Object.values(this.data.best).reduce((s, r) => s + r.skulls, 0);
    this.unlockLevel(levelIndex + 1);
    this.flush();
  }
  best(levelIndex) { return this.data.best[levelIndex] || null; }

  get setting() { return this.data.settings; }
  setSetting(k, v) { this.data.settings[k] = v; this.flush(); }

  reset() { this.data = defaults(); this.flush(); }
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v, fallback, min = -Infinity, max = Infinity) =>
  (typeof v === 'number' && Number.isFinite(v)) ? Math.min(max, Math.max(min, v)) : fallback;

/**
 * Coerce whatever came out of localStorage into a well-formed save.
 *
 * A shallow `{ ...defaults(), ...parsed }` let syntactically valid but malformed data
 * through — `{"best":null}` made level select throw, a partial `player` record leaked NaN
 * into skill points. Every field is checked and anything unusable falls back to its
 * default, so a damaged save degrades to a partial reset instead of a broken game.
 */
export function normalizeSave(raw) {
  const d = defaults();
  if (!isObj(raw)) return d;

  d.unlockedLevel = Math.floor(num(raw.unlockedLevel, 0, 0, 999));
  d.seenTutorial = raw.seenTutorial === true;

  if (isObj(raw.best)) {
    for (const [k, r] of Object.entries(raw.best)) {
      if (!isObj(r)) continue;
      d.best[k] = { score: num(r.score, 0, 0), skulls: Math.floor(num(r.skulls, 0, 0, 5)) };
    }
  }
  d.totalSkulls = Object.values(d.best).reduce((s, r) => s + r.skulls, 0);

  if (isObj(raw.spellbook)) {
    for (const [k, t] of Object.entries(raw.spellbook)) {
      const tier = num(t, null, 0, 9);
      if (tier !== null) d.spellbook[k] = Math.floor(tier);
    }
  }

  if (isObj(raw.settings)) {
    for (const [k, def] of Object.entries(d.settings)) {
      const v = raw.settings[k];
      if (typeof def === 'number') d.settings[k] = num(v, def, 0, 4);
      else if (typeof def === 'boolean' && typeof v === 'boolean') d.settings[k] = v;
    }
    // Settings added later (keybinds etc.) that this version does not know about are
    // carried through untouched rather than silently dropped.
    for (const [k, v] of Object.entries(raw.settings)) if (!(k in d.settings)) d.settings[k] = v;
  }

  if (isObj(raw.player)) {
    const p = raw.player;
    const ranks = {};
    if (isObj(p.ranks)) {
      for (const [k, v] of Object.entries(p.ranks)) {
        const r = num(v, null, 0, 99);
        if (r !== null) ranks[k] = Math.floor(r);
      }
    }
    d.player = {
      points: Math.floor(num(p.points, 0, 0)),
      spent: Math.floor(num(p.spent, 0, 0)),
      ranks,
      claimed: Array.isArray(p.claimed) ? p.claimed.filter((c) => typeof c === 'string') : [],
    };
  }

  // Unknown top-level keys from newer builds survive a round trip.
  for (const [k, v] of Object.entries(raw)) if (!(k in d)) d[k] = v;
  return d;
}

function defaults() {
  return {
    unlockedLevel: 0,
    best: {},
    totalSkulls: 0,
    spellbook: {},        // trapId -> upgrade tier
    seenTutorial: false,
    settings: { master: 0.8, sfx: 1.0, music: 0.45, shake: 1.0, damageNumbers: true, blood: 1.0 },
  };
}
