/** Deterministic RNG so waves and crits can be replayed/debugged. mulberry32. */
export function makeRng(seed = 0xC0FFEE) {
  let a = seed >>> 0;
  const fn = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  fn.range = (lo, hi) => lo + fn() * (hi - lo);
  fn.int = (lo, hi) => Math.floor(lo + fn() * (hi - lo + 1));
  fn.pick = (arr) => arr[Math.floor(fn() * arr.length)];
  fn.chance = (p) => fn() < p;
  fn.sign = () => (fn() < 0.5 ? -1 : 1);
  fn.reseed = (s) => { a = s >>> 0; };
  return fn;
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => (b === a ? 0 : (x - a) / (b - a));
export const smoothstep = (t) => t * t * (3 - 2 * t);
/** Frame-rate independent exponential smoothing. `rate` ~ how much remains after 1s. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.pow(rate, dt));
export const TAU = Math.PI * 2;
/** Shortest signed angular difference b - a, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}
