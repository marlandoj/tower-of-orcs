/**
 * Between-level progression. Small on purpose: eight lines, three ranks each, one
 * currency. The campaign is ten levels, so a player who clears everything and does it
 * well ends up with roughly twelve points — enough to max three lines, not enough to
 * max everything. That is the choice.
 *
 * Nothing here touches the balance of a single level in isolation; it is the answer to
 * "wave 5 of level 9 has 3200-HP warlords and my crossbow is still a level-1 crossbow".
 *
 * Persistence rides on `game.save.data` (localStorage), under its own `player` key so
 * it cannot collide with the level/skull records the campaign already stores.
 */

export const UPGRADES = [
  {
    id: 'marksman', name: 'Marksman', ranks: 3, icon: '🏹',
    blurb: 'Crossbow damage +14% and crit chance +5% per rank.',
    apply(m, r) { m.dmg.crossbow += 0.14 * r; m.critChance += 0.05 * r; },
  },
  {
    id: 'scattershot', name: 'Scattershot', ranks: 3, icon: '💥',
    blurb: 'Blunderbuss damage +15% and knockback +20% per rank.',
    apply(m, r) { m.dmg.blunderbuss += 0.15 * r; m.knockback += 0.20 * r; },
  },
  {
    id: 'pyromancy', name: 'Pyromancy', ranks: 3, icon: '🔥',
    blurb: 'Fireball damage +15%, blast radius +8%, burn +30% per rank.',
    apply(m, r) { m.dmg.staff += 0.15 * r; m.blast += 0.08 * r; m.burn += 0.30 * r; },
  },
  {
    id: 'conduction', name: 'Conduction', ranks: 3, icon: '⚡',
    blurb: 'Lightning damage +12% and one extra chain per rank.',
    apply(m, r) { m.dmg.lightning += 0.12 * r; m.chains += r; },
  },
  {
    id: 'vitality', name: 'Vitality', ranks: 3, icon: '❤',
    blurb: '+30 max health and +3 health regen per rank.',
    apply(m, r) { m.hpMax += 30 * r; m.regen += 3 * r; },
  },
  {
    id: 'swiftness', name: 'Swiftness', ranks: 2, icon: '👟',
    blurb: '+7% move speed and a 0.14s shorter dodge cooldown per rank.',
    apply(m, r) { m.speed += 0.07 * r; m.dodgeCd -= 0.14 * r; },
  },
  {
    id: 'arcane-focus', name: 'Arcane Focus', ranks: 3, icon: '🔮',
    blurb: '+30 max mana and +4 mana regen per rank.',
    apply(m, r) { m.manaMax += 30 * r; m.manaRegen += 4 * r; },
  },
  {
    id: 'spellcraft', name: 'Spellcraft', ranks: 3, icon: '✦',
    blurb: 'Spell cooldowns -13% and spell damage +12% per rank.',
    apply(m, r) { m.spellCd *= Math.pow(0.87, r); m.dmg.spell += 0.12 * r; },
  },
];

export const UPGRADE_BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

/** Rank N costs N points, so the third rank of anything is a real commitment. */
export const rankCost = (rank) => rank + 1;

function baseMods() {
  return {
    dmg: { crossbow: 1, blunderbuss: 1, staff: 1, lightning: 1, melee: 1, spell: 1 },
    critChance: 0, critMul: 0, knockback: 1, burn: 1, blast: 1, chains: 0,
    hpMax: 0, regen: 0, speed: 1, dodgeCd: 0,
    manaMax: 0, manaRegen: 0, spellCd: 1,
  };
}

export class Progression {
  constructor(game) {
    this.game = game;
    this.mods = baseMods();
    this._load();
    this.recompute();

    // A cleared level is worth a point; clearing it *well* is worth two. Levels are
    // recorded once so replaying level 1 forever is not a farm.
    game.bus.on('game:victory', (p) => this._award(p));
  }

  // --- persistence ----------------------------------------------------------
  get _store() {
    const d = this.game.save.data;
    if (!d.player) d.player = { points: 0, spent: 0, ranks: {}, claimed: [] };
    d.player.ranks ||= {};
    d.player.claimed ||= [];
    return d.player;
  }

  _load() { this._store; }
  _save() { this.game.save.flush(); }

  get points() { return this._store.points; }
  rank(id) { return this._store.ranks[id] ?? 0; }

  _award({ levelIndex, skulls = 0 } = {}) {
    const s = this._store;
    const key = String(levelIndex ?? this.game.levelIndex);
    if (s.claimed.includes(key)) return;
    s.claimed.push(key);
    const gained = 1 + (skulls >= 4 ? 1 : 0);
    s.points += gained;
    this._save();
    this.game.bus.emit('player:progression', { points: s.points, gained, ranks: { ...s.ranks } });
    this.game.ui?.toast(
      `+${gained} skill point${gained > 1 ? 's' : ''} — ${s.points} unspent`, 'info', 5000);
  }

  /** Everything a shop screen needs to draw itself. */
  available() {
    return UPGRADES.map((u) => {
      const r = this.rank(u.id);
      const maxed = r >= u.ranks;
      return {
        id: u.id, name: u.name, icon: u.icon, blurb: u.blurb,
        rank: r, ranks: u.ranks, maxed,
        cost: maxed ? null : rankCost(r),
        affordable: !maxed && this.points >= rankCost(r),
      };
    });
  }

  buy(id) {
    const def = UPGRADE_BY_ID.get(id);
    if (!def) return { ok: false, reason: 'unknown upgrade' };
    const s = this._store;
    const r = this.rank(id);
    if (r >= def.ranks) return { ok: false, reason: 'maxed' };
    const cost = rankCost(r);
    if (s.points < cost) return { ok: false, reason: 'not enough points' };
    s.points -= cost;
    s.spent = (s.spent ?? 0) + cost;
    s.ranks[id] = r + 1;
    this._save();
    this.recompute();
    this.game.audio?.play('ui.click', { pitch: 1.5 });
    this.game.bus.emit('player:progression', { points: s.points, ranks: { ...s.ranks }, bought: id });
    return { ok: true, id, rank: r + 1, points: s.points };
  }

  /** Refund everything for free. Cheap to offer, and it makes experimenting safe. */
  respec() {
    const s = this._store;
    s.points += s.spent ?? 0;
    s.spent = 0;
    s.ranks = {};
    this._save();
    this.recompute();
    this.game.bus.emit('player:progression', { points: s.points, ranks: {} });
    return s.points;
  }

  /** Rebuild the flat multiplier bag the weapons and the player read every frame. */
  recompute() {
    const m = baseMods();
    for (const u of UPGRADES) {
      const r = this.rank(u.id);
      if (r > 0) u.apply(m, r);
    }
    // Mutate in place: weapons captured `player.mods` at import time in a few spots.
    Object.assign(this.mods, m);
    this.mods.dmg = m.dmg;
    this.game.player?.onModsChanged?.();
    return this.mods;
  }
}
