const KEY = 'tower-of-orcs.save.v1';

/** LocalStorage progression: unlocked levels, skull ratings, spellbook, settings. */
export class Save {
  constructor() { this.data = this._load(); }

  _load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) return { ...defaults(), ...JSON.parse(raw) };
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
