/** A game stub where every unknown member is a callable no-op, so systems can be built headless. */
export function stubGame(overrides = {}) {
  const listeners = new Map();
  const bus = {
    on(ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn); return () => {}; },
    off() {},
    emit(ev, p) { for (const fn of listeners.get(ev) || []) fn(p); },
  };
  const noop = new Proxy(function () {}, { get: () => noop, apply: () => noop });
  const base = { bus, clock: { elapsed: 0, dt: 1 / 60 }, engine: { addSystem() {} }, state: 'wave', ...overrides };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : noop) });
}

/** A minimal enemy-shaped damage target. */
export function target(opts = {}) {
  return {
    hp: 1000, hpMax: 1000, dead: false, armor: 0, resist: null, shield: null,
    position: { x: 0, y: 0, z: 0 }, facing: 0, statuses: [], statusMods: { damageTaken: 1 },
    flags: new Set(opts.flags || []),
    has(f) { return this.flags.has(f); },
    addStatus(s) { this.statuses.push(s); },
    kill() { this.dead = true; },
    ...opts,
  };
}
