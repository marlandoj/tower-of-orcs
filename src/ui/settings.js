/**
 * Settings, wired straight to `game.save.data.settings` — the object FX already holds a
 * live reference to, so shake/blood/damage-number changes take effect on the next frame
 * with no plumbing. Audio needs a nudge because its gain nodes are already built.
 */

export const SETTINGS = [
  { key: 'master', label: 'Master volume', kind: 'range', min: 0, max: 1, step: 0.05, def: 0.8 },
  { key: 'sfx', label: 'Effects', kind: 'range', min: 0, max: 1, step: 0.05, def: 1.0 },
  { key: 'music', label: 'Music', kind: 'range', min: 0, max: 1, step: 0.05, def: 0.45 },
  { key: 'shake', label: 'Screen shake', kind: 'range', min: 0, max: 1.5, step: 0.05, def: 1.0,
    hint: 'How hard the camera kicks on impacts.' },
  { key: 'blood', label: 'Blood & gore', kind: 'range', min: 0, max: 1.5, step: 0.05, def: 1.0 },
  { key: 'damageNumbers', label: 'Damage numbers', kind: 'toggle', def: true },
];

export function readSetting(game, key) {
  const s = game.save?.setting ?? {};
  const d = SETTINGS.find((x) => x.key === key);
  return s[key] ?? d?.def;
}

export function writeSetting(game, key, value) {
  game.save?.setSetting?.(key, value);
  applySetting(game, key, value);
}

/** Push a value into the live subsystem that owns it. */
export function applySetting(game, key, value) {
  if (key === 'master' || key === 'sfx' || key === 'music') {
    game.audio?.setVolume?.(key, Number(value));
    // The UI bus rides on 'ui' and has no slider of its own; keep it tied to effects so
    // muting the game actually mutes everything.
    if (key === 'sfx') game.audio?.setVolume?.('ui', Number(value) * 0.8);
  }
  // shake / blood / damageNumbers are read live by FX from the same settings object.
}

/** Called once at boot so a reloaded save sounds like it did when the player left. */
export function applyAllSettings(game) {
  for (const s of SETTINGS) applySetting(game, s.key, readSetting(game, s.key));
}

export function renderSettings(game) {
  const rows = SETTINGS.map((s) => {
    const v = readSetting(game, s.key);
    if (s.kind === 'toggle') {
      return `
        <div class="set-row">
          <label class="set-label" for="set-${s.key}">${s.label}${s.hint ? `<span class="set-hint">${s.hint}</span>` : ''}</label>
          <button class="toggle ${v ? 'on' : ''}" id="set-${s.key}" role="switch" aria-checked="${!!v}"
                  data-action="set-toggle" data-key="${s.key}"><span class="knob"></span></button>
        </div>`;
    }
    return `
      <div class="set-row">
        <label class="set-label" for="set-${s.key}">${s.label}${s.hint ? `<span class="set-hint">${s.hint}</span>` : ''}</label>
        <div class="set-slider">
          <input type="range" id="set-${s.key}" data-key="${s.key}" min="${s.min}" max="${s.max}" step="${s.step}" value="${v}">
          <output data-out="${s.key}">${pct(v, s)}</output>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="sheet settings-sheet">
      <div class="sheet-head"><h2 class="ornate">SETTINGS</h2></div>
      <div class="set-list">${rows}</div>
      <div class="menu">
        <button class="btn" data-action="wipe">ERASE PROGRESS</button>
        <button class="btn primary" data-action="back">BACK</button>
      </div>
    </div>`;
}

export function pct(v, s) {
  if (s.kind === 'toggle') return v ? 'On' : 'Off';
  const max = s.max ?? 1;
  return `${Math.round((Number(v) / max) * 100)}%`;
}
