/**
 * Fully procedural WebAudio mixer — no asset downloads, no loading screen.
 *
 * Signal path:
 *   sfx  ─┐
 *   ui   ─┼─> master -> compressor -> soft limiter -> destination
 *   music ┤
 *   prio ─┘
 *
 * `sfx` and `music` are duckable; `prio` is not. Anything that must never be lost in a
 * 40-trap volley (rift damage, boss abilities, wave start) lives on `prio` and ducks the
 * rest for a beat, which is the whole trick to keeping a busy mix readable.
 *
 * Sounds are synthesised on demand from short recipes so we get infinite pitch/timbre
 * variation for free, and identical sounds fired in the same instant *stack* (quieter and
 * detuned) instead of being dropped — 20 spikes firing should sound like 20 spikes.
 */
export class Audio {
  constructor(game) {
    this.game = game;
    this.ctx = null;
    this.enabled = true;
    const s = game.save?.setting ?? {};
    this.volumes = {
      master: s.master ?? 0.8,
      sfx: s.sfx ?? 1.0,
      music: s.music ?? 0.45,
      ui: s.ui ?? 0.8,
      prio: 1.0,
    };
    this._noiseBuf = null;
    this._voices = 0;
    this._maxVoices = 56;
    this._lastAt = new Map();    // per-sound throttle so 40 simultaneous hits don't clip
    this._stack = new Map();     // per-sound stack depth inside the throttle window
    this.peak = 0;               // rolling output peak, read by the mixing stress test
    const resume = () => this._ensure();
    addEventListener('pointerdown', resume, { once: true });
    addEventListener('keydown', resume, { once: true });
  }

  _ensure() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return this.ctx; }
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) { this.enabled = false; return null; }
    this.ctx = new C();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volumes.master;

    // Gentle bus compression so trap volleys stay punchy without pumping...
    this.comp = this.ctx.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.ratio.value = 8;
    this.comp.knee.value = 8;
    this.comp.attack.value = 0.003; this.comp.release.value = 0.16;
    // ...then a tanh soft-clip as a brickwall, because a compressor alone still lets
    // twenty coincident transients punch through 0 dBFS and crackle.
    this.limiter = this.ctx.createWaveShaper();
    this.limiter.curve = softClipCurve();
    this.limiter.oversample = '2x';

    this.master.connect(this.comp).connect(this.limiter).connect(this.ctx.destination);

    this.buses = {};
    for (const k of ['sfx', 'music', 'ui', 'prio']) {
      const g = this.ctx.createGain();
      g.gain.value = this.volumes[k];
      g.connect(this.master);
      this.buses[k] = g;
    }

    // Shared noise buffer for impacts, fire, wind.
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this._noiseBuf = buf;

    // Cheap output meter — only used by the debug/mixing harness, costs one analyser.
    this._meter = this.ctx.createAnalyser();
    this._meter.fftSize = 512;
    this._meterBuf = new Float32Array(this._meter.fftSize);
    this.limiter.connect(this._meter);

    return this.ctx;
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }

  setVolume(bus, v) {
    this.volumes[bus] = v;
    if (!this.ctx) return;
    const node = bus === 'master' ? this.master : this.buses[bus];
    if (!node) return;
    // Cancel any duck automation, otherwise a settings change fights the sidechain.
    node.gain.cancelScheduledValues(this.ctx.currentTime);
    node.gain.value = v;
  }

  /**
   * Sidechain dip on the duckable buses. Called automatically by `prio` recipes, so a
   * rift hit or a boss roar carves its own space out of the horde.
   */
  duck(depth = 0.45, hold = 0.12, release = 0.35) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    for (const k of ['sfx', 'music']) {
      const p = this.buses[k].gain;
      const full = this.volumes[k];
      const target = full * (1 - depth);
      if (p.value <= target + 0.001 && this._duckUntil > now) continue; // already deeper
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(target, now + 0.02);
      p.setValueAtTime(target, now + 0.02 + hold);
      p.linearRampToValueAtTime(full, now + 0.02 + hold + release);
    }
    this._duckUntil = now + 0.02 + hold + release;
  }

  /** 3D-ish attenuation: distance from the camera focus, cheap and stable. */
  _spatial(position) {
    if (!position) return { gain: 1, pan: 0 };
    const f = this.game.rig.focus;
    const dx = position.x - f.x, dz = position.z - f.z;
    const d = Math.hypot(dx, dz);
    if (!Number.isFinite(d)) return { gain: 1, pan: 0 };
    const gain = Math.max(0, 1 - d / 46) ** 1.6;
    const pan = Math.max(-1, Math.min(1, dx / 26));
    return { gain, pan };
  }

  play(name, opts = {}) {
    if (!this.enabled) return;
    const ctx = this._ensure();
    if (!ctx) return;
    const recipe = RECIPES[name];
    if (!recipe) return;
    const prio = recipe.bus === 'prio';
    if (!prio && this._voices > this._maxVoices) return;

    const now = ctx.currentTime;
    const gap = recipe.minGap ?? 0.02;
    const last = this._lastAt.get(name) ?? -1;
    let stack = 0;
    if (now - last < gap) {
      // Same sound, same instant: stack it quieter and detuned rather than dropping it.
      // Three voices is enough to read as "a volley" and still fits under the limiter.
      stack = (this._stack.get(name) ?? 0) + 1;
      if (stack >= (recipe.stack ?? 3)) return;
      this._stack.set(name, stack);
    } else {
      this._stack.set(name, 0);
      this._lastAt.set(name, now);
    }

    const sp = this._spatial(opts.position);
    let gain = (opts.gain ?? 1) * sp.gain * (recipe.gain ?? 1) * (1 / (1 + stack * 1.4));
    if (!Number.isFinite(gain)) gain = 0;
    if (gain < 0.008) return;

    const bus = this.buses[recipe.bus || 'sfx'];
    const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    const out = ctx.createGain();
    out.gain.value = gain;
    if (pan) { pan.pan.value = sp.pan; out.connect(pan).connect(bus); }
    else out.connect(bus);

    let pitch = (opts.pitch ?? 1) * (1 + (Math.random() * 2 - 1) * (recipe.vary ?? 0.08));
    if (stack) pitch *= 1 + stack * 0.055;   // detune the stack so it thickens, not phases
    if (!Number.isFinite(pitch) || pitch <= 0) pitch = 1;

    if (recipe.duck) this.duck(recipe.duck[0], recipe.duck[1], recipe.duck[2]);

    this._voices++;
    const dur = recipe.render(this, ctx, out, pitch, opts);
    setTimeout(() => { this._voices--; try { out.disconnect(); } catch {} }, (dur + 0.3) * 1000);
  }

  /** Instantaneous output peak in the last analyser window. Debug/mixing only. */
  measurePeak() {
    if (!this._meter) return 0;
    this._meter.getFloatTimeDomainData(this._meterBuf);
    let p = 0;
    for (let i = 0; i < this._meterBuf.length; i++) {
      const v = Math.abs(this._meterBuf[i]);
      if (v > p) p = v;
    }
    this.peak = Math.max(this.peak * 0.94, p);
    return p;
  }

  // --- primitives used by recipes -------------------------------------------
  _osc(ctx, type, f0, f1, t0, dur, out, g0 = 1, curve = 'exp') {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(20, f0), t0);
    if (f1 !== null) o.frequency[curve === 'exp' ? 'exponentialRampToValueAtTime' : 'linearRampToValueAtTime'](Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(g0, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(out);
    o.start(t0); o.stop(t0 + dur + 0.02);
    return o;
  }
  _noise(ctx, t0, dur, out, g0 = 1, filter = null) {
    const s = ctx.createBufferSource();
    s.buffer = this._noiseBuf;
    s.loop = true;
    s.playbackRate.value = 0.8 + Math.random() * 0.5;
    const g = ctx.createGain();
    g.gain.setValueAtTime(g0, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    let node = s;
    if (filter) {
      const f = ctx.createBiquadFilter();
      f.type = filter.type || 'lowpass';
      f.frequency.setValueAtTime(filter.f0, t0);
      if (filter.f1) f.frequency.exponentialRampToValueAtTime(Math.max(40, filter.f1), t0 + dur);
      f.Q.value = filter.q ?? 1;
      node = s.connect(f);
    }
    node.connect(g).connect(out);
    s.start(t0); s.stop(t0 + dur + 0.02);
    return s;
  }
  /** A struck metal body: a few inharmonic partials ringing out. Bells, coins, chains. */
  _metal(ctx, t0, out, f, dur, g0 = 0.2, partials = [1, 2.41, 3.86]) {
    for (let i = 0; i < partials.length; i++) {
      this._osc(ctx, 'sine', f * partials[i], f * partials[i] * 0.995, t0, dur * (1 - i * 0.22), out, g0 / (1 + i * 1.4));
    }
  }
}

/** tanh soft-clip lookup — a brickwall that distorts musically instead of crackling. */
function softClipCurve(n = 2048, k = 1.7) {
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(x * k) / norm;
  }
  return c;
}

/**
 * Sound recipes. Each returns its duration in seconds.
 * Keep them short and transient-heavy — that is what makes combat read as crunchy.
 * `bus:'prio'` = never dropped, never ducked; `duck:[depth,hold,release]` = ducks the rest.
 */
const RECIPES = {
  'ui.click':   { bus: 'ui', gain: 0.5, render(a, c, o, p) { a._osc(c, 'square', 900 * p, 620 * p, c.currentTime, 0.05, o, 0.3); return 0.06; } },
  'ui.hover':   { bus: 'ui', gain: 0.25, minGap: 0.05, render(a, c, o, p) { a._osc(c, 'sine', 1400 * p, 1400 * p, c.currentTime, 0.03, o, 0.2); return 0.04; } },
  'ui.confirm': { bus: 'ui', gain: 0.6, render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'triangle', 520 * p, 780 * p, t, 0.12, o, 0.35); a._osc(c, 'triangle', 780 * p, 1040 * p, t + 0.06, 0.12, o, 0.25); return 0.2; } },
  'ui.error':   { bus: 'ui', gain: 0.6, render(a, c, o, p) { a._osc(c, 'sawtooth', 220 * p, 130 * p, c.currentTime, 0.16, o, 0.3); return 0.18; } },

  'bow.shot':   { gain: 0.55, vary: 0.12, minGap: 0.01, render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.09, o, 0.5, { type: 'bandpass', f0: 2200 * p, f1: 700 * p, q: 1.5 }); a._osc(c, 'triangle', 340 * p, 150 * p, t, 0.07, o, 0.25); return 0.12; } },
  'gun.shot':   { gain: 0.9, vary: 0.1, render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.22, o, 0.9, { type: 'lowpass', f0: 4200 * p, f1: 220, q: 0.8 }); a._osc(c, 'sawtooth', 180 * p, 45, t, 0.18, o, 0.5); return 0.26; } },
  'magic.shot': { gain: 0.5, vary: 0.14, render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'sine', 900 * p, 1800 * p, t, 0.12, o, 0.25); a._osc(c, 'sine', 1350 * p, 2600 * p, t, 0.1, o, 0.15); return 0.16; } },

  'hit.flesh':  { gain: 0.7, vary: 0.16, minGap: 0.012, render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.07, o, 0.8, { type: 'lowpass', f0: 1400 * p, f1: 200, q: 0.7 }); a._osc(c, 'sine', 140 * p, 60, t, 0.08, o, 0.4); return 0.1; } },
  'hit.armor':  { gain: 0.7, vary: 0.14, minGap: 0.012, render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.1, o, 0.6, { type: 'bandpass', f0: 3200 * p, f1: 1600 * p, q: 3 }); a._osc(c, 'square', 620 * p, 300 * p, t, 0.06, o, 0.2); return 0.12; } },
  'hit.crit':   { gain: 1.0, vary: 0.1, render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.12, o, 1.0, { type: 'lowpass', f0: 2600 * p, f1: 260, q: 1 }); a._osc(c, 'sine', 200 * p, 70, t, 0.14, o, 0.6); a._osc(c, 'triangle', 1600 * p, 700 * p, t, 0.09, o, 0.2); return 0.18; } },
  // Still the trap-destruction sound; quieter than it was because a *kill* now gets a
  // dedicated death.* recipe layered on top and two wet bursts is one too many.
  'gib':        { gain: 0.5, vary: 0.2, minGap: 0.03, render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.16, o, 0.9, { type: 'lowpass', f0: 900 * p, f1: 120, q: 0.6 }); a._osc(c, 'sine', 90, 40, t, 0.2, o, 0.5); return 0.24; } },
  'immune':     { gain: 0.5, vary: 0.06, minGap: 0.08, render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'square', 380 * p, 380 * p, t, 0.05, o, 0.18); a._noise(c, t, 0.06, o, 0.25, { type: 'highpass', f0: 3000, q: 2 }); return 0.08; } },

  // --- death by damage type: the kill has to *say* what killed it ------------
  /** Wet burst + a bone snap on top. The default, physical obliteration. */
  'death.gib':     { gain: 0.95, vary: 0.18, minGap: 0.025, stack: 4, render(a, c, o, p) {
    const t = c.currentTime;
    a._noise(c, t, 0.19, o, 1.0, { type: 'lowpass', f0: 1100 * p, f1: 110, q: 0.7 });
    a._noise(c, t + 0.012, 0.06, o, 0.55, { type: 'bandpass', f0: 3400 * p, f1: 1500 * p, q: 5 }); // bone snap
    a._osc(c, 'sine', 105 * p, 38, t, 0.22, o, 0.6);
    return 0.28; } },
  /** Steam and a dying crackle: fat sizzling off a charred orc. */
  'death.burn':    { gain: 0.85, vary: 0.16, minGap: 0.04, render(a, c, o, p) {
    const t = c.currentTime;
    a._noise(c, t, 0.5, o, 0.6, { type: 'bandpass', f0: 4200 * p, f1: 900 * p, q: 0.6 });
    a._noise(c, t + 0.03, 0.34, o, 0.35, { type: 'highpass', f0: 5200, q: 0.8 });
    a._osc(c, 'sawtooth', 190 * p, 55, t, 0.16, o, 0.28);
    return 0.55; } },
  /** Glass. High partials that ring and a scatter of shards. */
  'death.shatter': { gain: 0.9, vary: 0.12, minGap: 0.035, render(a, c, o, p) {
    const t = c.currentTime;
    a._noise(c, t, 0.11, o, 0.8, { type: 'highpass', f0: 3800 * p, q: 1.2 });
    a._metal(c, t, o, 1750 * p, 0.5, 0.16, [1, 2.76, 4.13, 5.9]);
    for (let i = 0; i < 5; i++) a._noise(c, t + 0.06 + i * 0.045, 0.05, o, 0.16, { type: 'bandpass', f0: (2600 + Math.random() * 3000) * p, q: 8 });
    return 0.6; } },
  /** Flattened. A stone thud with the wet part squeezed out sideways. */
  'death.crush':   { gain: 1.0, vary: 0.12, minGap: 0.03, render(a, c, o, p) {
    const t = c.currentTime;
    a._osc(c, 'sine', 130 * p, 28, t, 0.3, o, 0.85);
    a._noise(c, t, 0.1, o, 0.7, { type: 'lowpass', f0: 700 * p, f1: 90, q: 1.4 });
    a._noise(c, t + 0.05, 0.22, o, 0.4, { type: 'bandpass', f0: 500 * p, f1: 200, q: 1.1 });
    return 0.35; } },
  /** Arc discharge then a body dropping. */
  'death.zap':     { gain: 0.9, vary: 0.14, minGap: 0.03, render(a, c, o, p) {
    const t = c.currentTime;
    for (let i = 0; i < 7; i++) a._noise(c, t + i * 0.018, 0.03, o, 0.45, { type: 'bandpass', f0: (1800 + Math.random() * 5200) * p, q: 12 });
    a._osc(c, 'square', 2600 * p, 320 * p, t, 0.13, o, 0.14);
    a._osc(c, 'sine', 120, 44, t + 0.1, 0.18, o, 0.4);
    return 0.32; } },
  /** Bubbling collapse. */
  'death.melt':    { gain: 0.8, vary: 0.2, minGap: 0.04, render(a, c, o, p) {
    const t = c.currentTime;
    a._noise(c, t, 0.4, o, 0.45, { type: 'lowpass', f0: 900 * p, f1: 150, q: 2.4 });
    for (let i = 0; i < 5; i++) a._osc(c, 'sine', (240 + Math.random() * 260) * p, (90 + Math.random() * 60) * p, t + i * 0.06, 0.09, o, 0.16);
    return 0.48; } },
  /** Unmade rather than killed: an inrush and a chime. */
  'death.arcane':  { gain: 0.8, vary: 0.1, minGap: 0.04, render(a, c, o, p) {
    const t = c.currentTime;
    a._noise(c, t, 0.24, o, 0.4, { type: 'bandpass', f0: 400 * p, f1: 4200 * p, q: 1.2 });
    a._metal(c, t + 0.16, o, 880 * p, 0.5, 0.2, [1, 1.5, 2.02]);
    return 0.6; } },
  /** A boss dying should stop the room. Prio bus + a deep duck. */
  'death.boss':    { bus: 'prio', gain: 1.0, vary: 0.05, duck: [0.7, 0.5, 1.0], render(a, c, o, p) {
    const t = c.currentTime;
    a._noise(c, t, 1.5, o, 1.0, { type: 'lowpass', f0: 3000 * p, f1: 50, q: 0.6 });
    a._osc(c, 'sine', 90 * p, 24, t, 1.4, o, 0.95);
    a._osc(c, 'sawtooth', 220 * p, 46, t, 0.7, o, 0.35);
    a._metal(c, t + 0.05, o, 320 * p, 1.6, 0.22, [1, 1.63, 2.71, 4.2]);
    for (let i = 0; i < 8; i++) a._noise(c, t + 0.1 + i * 0.07, 0.08, o, 0.3, { type: 'lowpass', f0: 800, f1: 120 });
    return 2.0; } },

  // --- payout ---------------------------------------------------------------
  /** The scatter as coins leave the corpse. */
  'coin.spray': { gain: 0.5, vary: 0.15, minGap: 0.05, render(a, c, o, p) {
    const t = c.currentTime;
    for (let i = 0; i < 4; i++) a._metal(c, t + i * 0.022, o, (1500 + Math.random() * 900) * p, 0.16, 0.09, [1, 2.7]);
    return 0.28; } },
  /** The ka-ching. `pitch` climbs with the collect chain — this is the slot machine. */
  'coin.get':   { gain: 0.6, vary: 0.03, minGap: 0.012, stack: 5, render(a, c, o, p) {
    const t = c.currentTime;
    a._metal(c, t, o, 1180 * p, 0.16, 0.3, [1, 2.02, 3.01]);
    a._metal(c, t + 0.035, o, 1760 * p, 0.22, 0.2, [1, 2.02]);
    return 0.3; } },
  // Legacy one-shot kept for existing call sites; the real payout is coin.spray/coin.get.
  'coin':       { gain: 0.28, vary: 0.1, minGap: 0.03, render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'triangle', 1500 * p, 2100 * p, t, 0.07, o, 0.22); a._osc(c, 'triangle', 2300 * p, 3000 * p, t + 0.03, 0.06, o, 0.12); return 0.11; } },

  // --- combo escalation -----------------------------------------------------
  /** One rung up the ladder. Pitch is set by the tier. */
  'combo.up':  { bus: 'ui', gain: 0.55, vary: 0.02, minGap: 0.1, render(a, c, o, p) {
    const t = c.currentTime;
    a._osc(c, 'triangle', 660 * p, 990 * p, t, 0.1, o, 0.3);
    a._metal(c, t + 0.02, o, 1320 * p, 0.4, 0.16, [1, 1.5, 2.0]);
    return 0.45; } },
  /** Top of the ladder. Loud, prio, ducks everything for a beat. */
  'combo.max': { bus: 'prio', gain: 0.8, vary: 0.02, minGap: 1.0, duck: [0.4, 0.1, 0.4], render(a, c, o, p) {
    const t = c.currentTime;
    [0, 4, 7, 12].forEach((s, i) => a._osc(c, 'sawtooth', 330 * p * Math.pow(2, s / 12), 330 * p * Math.pow(2, s / 12), t + i * 0.055, 0.5, o, 0.16));
    a._noise(c, t, 0.3, o, 0.25, { type: 'highpass', f0: 6000, q: 0.7 });
    return 0.8; } },

  // --- trap signatures ------------------------------------------------------
  'trap.spike': { gain: 0.85, vary: 0.12, stack: 4, render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.05, o, 0.8, { type: 'bandpass', f0: 5200 * p, f1: 2600 * p, q: 4 }); a._metal(c, t, o, 1900 * p, 0.24, 0.16, [1, 2.7, 4.2]); a._osc(c, 'sawtooth', 260 * p, 90, t, 0.09, o, 0.3); return 0.28; } },
  'trap.arrow': { gain: 0.7, vary: 0.14, render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'triangle', 180 * p, 90, t, 0.07, o, 0.22); for (let i = 0; i < 4; i++) a._noise(c, t + i * 0.028, 0.09, o, 0.42, { type: 'bandpass', f0: (2400 + i * 300) * p, f1: 800 * p, q: 2.4 }); return 0.24; } },
  'trap.boom':  { gain: 1.0, vary: 0.1, duck: [0.35, 0.14, 0.3], render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.6, o, 1.0, { type: 'lowpass', f0: 3800 * p, f1: 60, q: 0.7 }); a._osc(c, 'sine', 120 * p, 30, t, 0.55, o, 0.9); a._noise(c, t + 0.02, 0.12, o, 0.5, { type: 'highpass', f0: 2600, q: 0.8 }); return 0.7; } },
  'trap.arm':   { gain: 0.45, vary: 0.06, minGap: 0.05, render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'square', 1200 * p, 1600 * p, t, 0.05, o, 0.15); return 0.07; } },
  'trap.place': { gain: 0.7, render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.14, o, 0.5, { type: 'lowpass', f0: 1600, f1: 300 }); a._osc(c, 'triangle', 300 * p, 520 * p, t, 0.12, o, 0.3); return 0.18; } },
  'trap.fire':  { gain: 0.7, vary: 0.12, render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.35, o, 0.6, { type: 'bandpass', f0: 700 * p, f1: 2200 * p, q: 0.8 }); return 0.4; } },
  'trap.tar':   { gain: 0.6, vary: 0.15, render(a, c, o, p) { const t = c.currentTime; a._noise(c, t, 0.3, o, 0.45, { type: 'lowpass', f0: 500 * p, f1: 120, q: 1 }); return 0.34; } },
  /** Chain rattle, then a ton of stone landing. */
  'trap.pound': { gain: 1.0, vary: 0.08, duck: [0.3, 0.1, 0.25], render(a, c, o, p) {
    const t = c.currentTime;
    a._osc(c, 'sine', 78 * p, 26, t, 0.42, o, 0.95);
    a._noise(c, t, 0.16, o, 0.75, { type: 'lowpass', f0: 1100 * p, f1: 90, q: 1.2 });
    for (let i = 0; i < 4; i++) a._metal(c, t + 0.02 + i * 0.03, o, (900 + Math.random() * 700) * p, 0.2, 0.07, [1, 2.4]);
    return 0.5; } },
  /** A sprung steel plate. Comedy is allowed. */
  'trap.spring': { gain: 0.8, vary: 0.1, render(a, c, o, p) {
    const t = c.currentTime;
    a._osc(c, 'triangle', 180 * p, 1500 * p, t, 0.16, o, 0.4);
    a._osc(c, 'square', 120 * p, 900 * p, t + 0.01, 0.13, o, 0.12);
    a._metal(c, t, o, 640 * p, 0.5, 0.12, [1, 3.1, 5.4]);
    return 0.55; } },
  /** Whirring steel and a shing across the tile. */
  'trap.blades': { gain: 0.85, vary: 0.12, stack: 4, render(a, c, o, p) {
    const t = c.currentTime;
    a._noise(c, t, 0.34, o, 0.5, { type: 'bandpass', f0: 1500 * p, f1: 4200 * p, q: 2.2 });
    a._metal(c, t + 0.04, o, 2350 * p, 0.4, 0.16, [1, 2.31, 3.5]);
    a._osc(c, 'sawtooth', 420 * p, 180 * p, t, 0.12, o, 0.16);
    return 0.5; } },
  /** Motor under load. Short so it can retrigger every 0.35 s without smearing. */
  'trap.grind': { gain: 0.7, vary: 0.16, minGap: 0.09, render(a, c, o, p) {
    const t = c.currentTime;
    a._noise(c, t, 0.24, o, 0.7, { type: 'bandpass', f0: 380 * p, f1: 900 * p, q: 1.6 });
    a._osc(c, 'sawtooth', 74 * p, 92 * p, t, 0.22, o, 0.3, 'lin');
    return 0.3; } },
  /** Pressurised frost, then the crack of everything going solid. */
  'trap.ice':   { gain: 0.8, vary: 0.1, render(a, c, o, p) {
    const t = c.currentTime;
    a._noise(c, t, 0.3, o, 0.65, { type: 'highpass', f0: 2600 * p, q: 0.9 });
    a._metal(c, t + 0.08, o, 2100 * p, 0.55, 0.15, [1, 2.9, 4.6]);
    a._osc(c, 'sine', 900 * p, 240 * p, t + 0.06, 0.25, o, 0.16);
    return 0.6; } },
  /** Capacitive discharge with a chain of secondary arcs. */
  'trap.zap':   { gain: 0.9, vary: 0.1, render(a, c, o, p) {
    const t = c.currentTime;
    a._osc(c, 'square', 3200 * p, 240 * p, t, 0.1, o, 0.16);
    for (let i = 0; i < 9; i++) a._noise(c, t + i * 0.021, 0.035, o, 0.4, { type: 'bandpass', f0: (2200 + Math.random() * 6000) * p, q: 14 });
    a._osc(c, 'sine', 150, 50, t, 0.2, o, 0.35);
    return 0.35; } },
  /** Hiss of a pressurised nozzle plus the fizz of metal dissolving. */
  'trap.acid':  { gain: 0.75, vary: 0.14, render(a, c, o, p) {
    const t = c.currentTime;
    a._noise(c, t, 0.28, o, 0.6, { type: 'bandpass', f0: 3400 * p, f1: 1200 * p, q: 1.1 });
    a._noise(c, t + 0.1, 0.42, o, 0.3, { type: 'highpass', f0: 5200 * p, q: 0.7 });
    return 0.55; } },
  /** A struck resonator: pure tone, long tail, no noise at all. */
  'trap.obelisk': { gain: 0.85, vary: 0.05, render(a, c, o, p) {
    const t = c.currentTime;
    a._osc(c, 'sine', 220 * p, 220 * p, t, 0.8, o, 0.3);
    a._metal(c, t, o, 660 * p, 1.1, 0.22, [1, 1.5, 2.24, 3.0]);
    a._osc(c, 'sine', 1760 * p, 1320 * p, t, 0.3, o, 0.1);
    return 1.2; } },

  'shield.break': { gain: 0.85, vary: 0.1, minGap: 0.05, render(a, c, o, p) {
    const t = c.currentTime;
    a._metal(c, t, o, 780 * p, 0.6, 0.24, [1, 2.4, 3.9, 5.1]);
    a._noise(c, t, 0.14, o, 0.6, { type: 'bandpass', f0: 2800 * p, f1: 900 * p, q: 2 });
    return 0.7; } },

  'orc.growl':  { gain: 0.5, vary: 0.22, minGap: 0.14, render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'sawtooth', 130 * p, 82 * p, t, 0.3, o, 0.18); a._noise(c, t, 0.3, o, 0.16, { type: 'bandpass', f0: 420 * p, f1: 220 * p, q: 1.4 }); return 0.35; } },
  'orc.death':  { gain: 0.7, vary: 0.24, minGap: 0.04, stack: 4, render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'sawtooth', 240 * p, 70 * p, t, 0.38, o, 0.3); a._noise(c, t, 0.34, o, 0.25, { type: 'bandpass', f0: 900 * p, f1: 260 * p, q: 1.1 }); return 0.42; } },
  'horde':      { gain: 0.7, vary: 0.05, render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'sawtooth', 90, 60, t, 1.2, o, 0.22); a._noise(c, t, 1.2, o, 0.3, { type: 'bandpass', f0: 300, f1: 140, q: 0.8 }); return 1.4; } },

  // The rift taking damage is the one thing the player must never miss.
  'rift.hit':   { bus: 'prio', gain: 1.0, vary: 0.05, duck: [0.6, 0.25, 0.5], render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'sine', 300 * p, 55, t, 0.8, o, 0.7); a._osc(c, 'sawtooth', 150 * p, 40, t, 0.4, o, 0.25); a._noise(c, t, 0.5, o, 0.5, { type: 'lowpass', f0: 1200, f1: 90 }); return 0.9; } },
  'wave.start': { bus: 'prio', gain: 0.9, duck: [0.5, 0.5, 0.9], render(a, c, o, p) { const t = c.currentTime; a._osc(c, 'sawtooth', 110, 220, t, 0.9, o, 0.3); a._osc(c, 'sawtooth', 165, 330, t + 0.1, 0.8, o, 0.2); return 1.1; } },
  'victory':    { bus: 'prio', gain: 1.0, duck: [0.7, 1.0, 1.0], render(a, c, o, p) { const t = c.currentTime; [523, 659, 784, 1047].forEach((f, i) => a._osc(c, 'triangle', f, f, t + i * 0.11, 0.4, o, 0.3)); return 1.0; } },
  'defeat':     { bus: 'prio', gain: 1.0, duck: [0.8, 1.2, 1.2], render(a, c, o, p) { const t = c.currentTime; [392, 349, 294, 196].forEach((f, i) => a._osc(c, 'sawtooth', f, f * 0.98, t + i * 0.16, 0.5, o, 0.28)); return 1.2; } },
};

export const SOUND_NAMES = Object.keys(RECIPES);
