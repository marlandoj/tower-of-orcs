/**
 * Turning a wave composition into *threat intel*.
 *
 * A list of names tells the player nothing they can act on. What they need in the build
 * phase is the one sentence that changes what they build: "flyers are coming, floor traps
 * miss". So every ability flag in the enemy contract gets a name and a counter-plan, and
 * the preview panel leads with the abilities rather than the roster.
 *
 * Flags come from another module's roster and that roster grows — anything unknown still
 * renders, with a neutral label, instead of vanishing.
 */

export const FLAGS = {
  flying: {
    label: 'Flying', severity: 3,
    counter: 'Floor traps miss entirely. Answer with arrow walls, pounders, blades, rods or an archer.',
  },
  armored: {
    label: 'Armoured', severity: 2,
    counter: 'Shrugs off physical. Crush, lightning and acid go straight through plate.',
  },
  shielded: {
    label: 'Shielded', severity: 3,
    counter: 'Blocks damage from the front. Hit the flank, or crush it from above.',
  },
  'trap-disarm': {
    label: 'Sappers', severity: 3,
    counter: 'Chews through every floor trap it stands on. Layer wall and ceiling traps behind it.',
  },
  'fire-immune': {
    label: 'Fire-immune', severity: 2,
    counter: 'Brimstone and barrels do nothing. Bring physical, ice or arcane.',
  },
  'frost-immune': {
    label: 'Frost-immune', severity: 2,
    counter: 'Ice will not hold it. Slow it with tar instead.',
  },
  leaper: {
    label: 'Leapers', severity: 2,
    counter: 'Jumps pits and floor traps. Catch it mid-air with wall blades or arrows.',
  },
  unstoppable: {
    label: 'Unstoppable', severity: 2,
    counter: 'Immune to knockback and stun. Only a level 3 Spring Trap (Catapult) can throw it.',
  },
  healer: {
    label: 'Healers', severity: 3,
    counter: 'Heals the whole pack. Make it die first: burst the chokepoint.',
  },
  buffer: {
    label: 'Support', severity: 2,
    counter: 'Strengthens the pack around it — heals, shields or haste. Kill it first.',
  },
  ranged: {
    label: 'Ranged', severity: 2,
    counter: 'Outranges your guardians and shoots them down. Screen them with a blocker.',
  },
  summoner: {
    label: 'Summoner', severity: 3,
    counter: 'Calls in more orcs for as long as it lives. Focus it above everything.',
  },
  shielder: {
    label: 'Shielder', severity: 3,
    counter: 'Grants the horde a damage shield. Strip it with acid.',
  },
  regen: {
    label: 'Regenerating', severity: 2,
    counter: 'Heals back up unless it is burning. Keep fire on it.',
  },
  splitter: {
    label: 'Splitter', severity: 2,
    counter: 'Breaks into smaller orcs on death. Keep a sustained trap behind the kill zone.',
  },
  stealth: {
    label: 'Stealth', severity: 2,
    counter: 'Guardians cannot see it until it strikes. You will have to.',
  },
  boss: {
    label: 'Boss', severity: 4,
    counter: 'Enormous health and an aura on the pack. Everything you own, on one tile.',
  },
};

export function flagInfo(flag) {
  return FLAGS[flag] ?? {
    label: String(flag).replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
    severity: 2,
    counter: 'An ability the campaign has not taught yet. Watch it closely.',
  };
}

/**
 * Collapse a director preview into { count, tiers, threats } where `threats` is the
 * de-duplicated ability list, sorted worst-first and annotated with who brings it.
 */
export function readThreat(preview) {
  const entries = (preview?.entries ?? []).filter((e) => e && e.count > 0);
  let count = 0;
  const byFlag = new Map();

  for (const e of entries) {
    count += e.count;
    const flags = e.def?.flags ?? [];
    for (const f of flags) {
      const cur = byFlag.get(f) ?? { flag: f, ...flagInfo(f), from: [], count: 0 };
      if (!cur.from.includes(e.def?.name)) cur.from.push(e.def?.name ?? '?');
      cur.count += e.count;
      byFlag.set(f, cur);
    }
  }

  const threats = [...byFlag.values()].sort(
    (a, b) => b.severity - a.severity || b.count - a.count,
  );
  return { index: preview?.index ?? 0, total: preview?.total ?? 0, boss: !!preview?.boss, count, entries, threats };
}

// ------------------------------------------------------------------- traps
/**
 * What a trap is *for*, derived from its tags rather than a hand-written table, so a
 * trap added to the roster gets a sensible tooltip without anyone editing this file.
 */
const ANSWERS = [
  ['anti-air', 'Hits flyers'],
  ['anti-armour', 'Cuts through armour'],
  ['crush', 'Cuts through armour'],
  ['lightning', 'Ignores armour, chains through packs'],
  ['anti-shield', 'Strips shields and armour'],
  ['true-damage', 'Nothing in the horde resists it'],
  ['control', 'Slows and bunches the horde for everything else'],
  ['setup', 'Moves them where you want them'],
  ['sustained', 'Constant damage — good on a chokepoint'],
  ['burst', 'One huge hit where they bunch up'],
  ['sweep', 'Hits the whole tile at once'],
  ['ally', 'Holds a lane without you'],
];

const WEAKNESSES = [
  ['fire', 'Wasted on fire-immune orcs'],
  ['ice', 'Wasted on frost-immune orcs'],
  ['physical', 'Blunted by armour'],
];

export function trapAnswers(def) {
  const tags = def?.tags ?? [];
  const good = [];
  const bad = [];
  for (const [tag, text] of ANSWERS) if (tags.includes(tag) && !good.includes(text)) good.push(text);
  for (const [tag, text] of WEAKNESSES) if (tags.includes(tag)) bad.push(text);
  return { good, bad };
}

/** Human-readable cadence for the trap bar: traps are not all "cooldown" shaped. */
export function trapCadence(def) {
  if (!def) return '';
  if (def.passive) return 'Always on';
  if (def.oneShot) return 'One shot';
  if (def.guardian) return `Every ${fmt(def.cooldown)}s`;
  if (!def.cooldown) return 'Instant';
  return `${fmt(def.cooldown)}s`;
}

const fmt = (n) => (Number.isFinite(n) ? String(+n.toFixed(2)) : '—');
