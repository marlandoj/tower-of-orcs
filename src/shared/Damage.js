import { clamp } from './rng.js';

/**
 * The single funnel for all damage in the game. Traps, weapons, spells, guardians and
 * environment all call this so resistances, shields, armour, crits, combo and the
 * kill feed stay consistent.
 *
 * @param {object} target  an Enemy (or the Player, which implements the same three fields)
 * @param {object} spec    { amount, type, source, crit, knockback, statuses, position }
 * @param {object} game
 * @returns {number} damage actually dealt (after mitigation, before overkill clamp)
 */
export function applyDamage(target, spec, game) {
  if (!target || target.dead || target.invulnerable) return 0;

  const type = spec.type || 'physical';
  let amount = spec.amount;

  // --- Resistances (multiplier; 0 = immune, 1 = normal, >1 = vulnerable) ---
  const resist = target.resist || target.def?.resist;
  if (resist && resist[type] !== undefined) amount *= resist[type];
  if (amount <= 0) {
    // Statuses must land even when the hit deals nothing. Two whole categories of
    // effect are zero-damage by design — tar, springs, webs — and an immune target
    // should still get slowed or oiled. Returning before this silently disabled the
    // Tar Pit, which is the trap every other combo in the game is built on.
    if (spec.statuses && target.addStatus) {
      for (const s of spec.statuses) target.addStatus(s, game);
    }
    if (spec.knockback && target.applyImpulse && !target.has?.('unstoppable')) {
      const m = target.mass || 1;
      target.applyImpulse(spec.knockback.x / m, (spec.knockback.y || 0) / m, spec.knockback.z / m);
    }
    game?.bus.emit('enemy:damaged', {
      enemy: target, amount: 0, source: spec.source, crit: false,
      position: spec.position, immune: true,
    });
    return 0;
  }

  // --- Vulnerability / weaken status stacks ---
  if (target.statusMods) amount *= target.statusMods.damageTaken ?? 1;

  // --- Directional shield: heavy reduction inside the frontal arc ---
  // Crush comes down from above, over the top of a held shield: "flank them, or crush
  // through" is the documented answer to Shieldbearers.
  if (target.shield && target.shield.hp > 0 && spec.position && type !== 'crush') {
    const dx = spec.position.x - target.position.x;
    const dz = spec.position.z - target.position.z;
    const fx = Math.sin(target.facing), fz = Math.cos(target.facing);
    const len = Math.hypot(dx, dz) || 1;
    const dot = (dx / len) * fx + (dz / len) * fz;
    if (dot > target.shield.arcCos) {
      const absorbed = Math.min(target.shield.hp, amount * target.shield.absorb);
      target.shield.hp -= absorbed;
      amount -= absorbed;
      if (target.shield.hp <= 0) {
        target.shield.hp = 0;
        game?.bus.emit('enemy:shield-broken', { enemy: target, position: spec.position });
      }
    }
  }

  // --- Flat armour, physical only, floored at 15% so armour is never a hard wall ---
  // Crush ignores armour: it is the advertised answer to Ironhides and the Orc King.
  if (target.armor && type === 'physical') {
    amount = Math.max(amount * 0.15, amount - target.armor);
  }

  amount = Math.max(0, amount);
  target.hp -= amount;
  target.lastHitAt = game?.clock.elapsed ?? 0;
  target.lastHitType = type;

  // --- Statuses ---
  if (spec.statuses && target.addStatus) {
    for (const s of spec.statuses) target.addStatus(s, game);
  }

  // --- Knockback (unstoppable ignores it) ---
  if (spec.knockback && target.applyImpulse && !target.has?.('unstoppable')) {
    const m = target.mass || 1;
    target.applyImpulse(spec.knockback.x / m, (spec.knockback.y || 0) / m, spec.knockback.z / m);
  }

  game?.bus.emit('enemy:damaged', {
    enemy: target, amount, source: spec.source, crit: !!spec.crit,
    position: spec.position, type,
  });

  if (target.hp <= 0 && !target.dead) {
    target.hp = 0;
    target.kill?.(spec, game);
  }
  return amount;
}

/** Status effect factory — every status is a plain, poolable record. */
export function status(kind, duration, power = 1, extra = null) {
  return { kind, duration, power, extra };
}

/** Recompute a target's aggregate status modifiers. Called by the entity, not by callers. */
export function recomputeStatusMods(target) {
  const m = target.statusMods || (target.statusMods = {});
  m.speed = 1; m.damageTaken = 1; m.damageDealt = 1; m.rooted = false; m.stunned = false;
  for (const s of target.statuses) {
    switch (s.kind) {
      case 'slow':      m.speed *= clamp(1 - s.power, 0.05, 1); break;
      case 'haste':     m.speed *= 1 + s.power; break;
      case 'tar':       m.speed *= 0.45; break;
      case 'freeze':    m.rooted = true; m.speed = 0; m.damageTaken *= 1.5; break;
      case 'stun':      m.stunned = true; m.speed = 0; break;
      case 'web':       m.speed *= 0.25; break;
      case 'vulnerable':m.damageTaken *= 1 + s.power; break;
      case 'weaken':    m.damageDealt *= clamp(1 - s.power, 0, 1); break;
      case 'rage':      m.speed *= 1.35; m.damageDealt *= 1.5; break;
      case 'oiled':     m.damageTaken *= 1.0; break; // fire interaction handled by fire traps
    }
  }
  return m;
}
