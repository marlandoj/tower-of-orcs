/**
 * Spellbook tuning, shared by the trap simulation (TrapManager, combos) and the UI
 * (spellbook.js) so the number the player reads is the number the game applies.
 *
 * Tiers are a permanent bonus *on top of* a trap's in-level upgrades, not extra starting
 * levels. Granting levels capped out at tier 2 (a 3-level trap cannot start at level 4),
 * which left tier 3 doing nothing, and handed out level-3 traps at level-1 prices, which
 * flattened the in-level economy.
 */
export const MAX_SPELLBOOK_TIER = 3;

/** Damage bonus per spellbook tier: Mastered (tier 3) is +60%. */
export const SPELLBOOK_DAMAGE_PER_TIER = 0.2;

/** Hit-point bonus per spellbook tier (barricades scale harder; see TrapManager.hpFor). */
export const SPELLBOOK_HP_PER_TIER = 0.4;

export const clampTier = (t) =>
  (Number.isFinite(t) ? Math.max(0, Math.min(MAX_SPELLBOOK_TIER, Math.floor(t))) : 0);

/** Multiplier on all damage a trap deals at spellbook tier `t`. */
export const tierDamageMult = (t) => 1 + clampTier(t) * SPELLBOOK_DAMAGE_PER_TIER;
