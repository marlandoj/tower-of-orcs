/**
 * Procedural layered score on the `music` bus. No files, no loops, no novelty.
 *
 * Five layers, each on its own gain node, cross-faded by game phase:
 *
 *   air    a two-voice drone with a slow filter sweep      — always present
 *   pulse  a plucked minor arpeggio                        — build phase
 *   drum   kick / snare / hat                              — wave phase
 *   bass   filtered saw following the root                 — wave phase
 *   horn   stacked fifths with a minor-second bite         — boss waves
 *
 * Everything is scheduled ahead of the audio clock in `update()`, which FX calls once a
 * frame. A frame hitch therefore cannot make the music stutter — the notes for the next
 * quarter-second are already committed to the WebAudio graph.
 *
 * Harmony is a four-bar i–VI–VII–i in D minor. It loops forever and is deliberately
 * static: this is a bed for combat, not a song competing with it.
 */

const SEMI = (n) => Math.pow(2, n / 12);
const D2 = 73.416;
// i (Dm) — VI (B♭) — VII (C) — i (Dm). Root per bar, in Hz at octave 2.
const BAR_ROOT = [D2, D2 * SEMI(-4), D2 * SEMI(-2), D2];
// Natural-minor pentatonic degrees, in semitones from the bar root.
const ARP = [0, 3, 7, 10, 12, 10, 7, 3];

const MODES = {
  menu:  { bpm: 76,  air: 0.55, pulse: 0.00, drum: 0.0, bass: 0.0,  horn: 0.0, fade: 2.5 },
  build: { bpm: 84,  air: 0.70, pulse: 0.75, drum: 0.0, bass: 0.25, horn: 0.0, fade: 2.2 },
  wave:  { bpm: 126, air: 0.45, pulse: 0.22, drum: 0.9, bass: 0.85, horn: 0.0, fade: 0.7 },
  boss:  { bpm: 138, air: 0.35, pulse: 0.10, drum: 1.0, bass: 1.0,  horn: 0.85, fade: 0.9 },
  quiet: { bpm: 84,  air: 0.18, pulse: 0.00, drum: 0.0, bass: 0.0,  horn: 0.0, fade: 1.4 },
};

export class Music {
  constructor(audio) {
    this.audio = audio;
    this.started = false;
    this.mode = 'menu';
    this.intensity = 0;      // 0..1, driven by the combo tier — adds drive, not notes
    this.bpm = MODES.menu.bpm;
    this._step = 0;          // 16th-note counter, wraps every 4 bars (64 steps)
    this._nextAt = 0;
    this._lookahead = 0.3;
  }

  /** Safe to call every frame; only does anything once the context is actually running. */
  ensure() {
    if (this.started) return true;
    const a = this.audio;
    if (!a.running || !a.buses?.music) return false;
    const ctx = a.ctx;

    const mk = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    this.out = mk(1); this.out.connect(a.buses.music);

    // A short feedback delay gives the melodic layers depth without a reverb impulse.
    this.delay = ctx.createDelay(1.0);
    this.delay.delayTime.value = 60 / this.bpm * 0.75;
    this.fb = mk(0.3);
    this.wet = mk(0.28);
    this.delay.connect(this.fb).connect(this.delay);
    this.delay.connect(this.wet).connect(this.out);

    this.layers = {
      air: mk(0), pulse: mk(0), drum: mk(0), bass: mk(0), horn: mk(0),
    };
    for (const k of Object.keys(this.layers)) this.layers[k].connect(this.out);
    this.layers.pulse.connect(this.delay);
    this.layers.horn.connect(this.delay);

    this._buildAir(ctx);

    this._nextAt = ctx.currentTime + 0.12;
    this.started = true;
    this.setMode(this.mode, 0.4);
    return true;
  }

  /** The drone is continuous, so it is built once and never re-scheduled. */
  _buildAir(ctx) {
    const g = this.layers.air;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 420; lp.Q.value = 3.5;
    lp.connect(g);
    this.airFilter = lp;

    for (const [f, type, gain, det] of [
      [D2 * 0.5, 'sawtooth', 0.09, 0],
      [D2 * 0.5, 'sawtooth', 0.07, 7],       // beating pair — the drone breathes on its own
      [D2 * 0.75, 'triangle', 0.05, -4],
    ]) {
      const o = ctx.createOscillator();
      o.type = type; o.frequency.value = f; o.detune.value = det;
      const og = ctx.createGain(); og.gain.value = gain;
      o.connect(og).connect(lp);
      o.start();
    }

    // Slow filter LFO: the difference between "ambience" and "a held chord".
    const lfo = ctx.createOscillator();
    lfo.type = 'sine'; lfo.frequency.value = 0.055;
    const lfoAmt = ctx.createGain(); lfoAmt.gain.value = 260;
    lfo.connect(lfoAmt).connect(lp.frequency);
    lfo.start();
  }

  setMode(mode, fade = null) {
    if (!MODES[mode]) return;
    this.mode = mode;
    if (!this.started) return;
    const m = MODES[mode];
    const t = this.audio.ctx.currentTime;
    const f = fade ?? m.fade;
    this.bpm = m.bpm;
    this.delay.delayTime.linearRampToValueAtTime(60 / this.bpm * 0.75, t + f);
    for (const k of Object.keys(this.layers)) {
      const p = this.layers[k].gain;
      p.cancelScheduledValues(t);
      p.setValueAtTime(p.value, t);
      p.linearRampToValueAtTime(m[k], t + f);
    }
  }

  /** 0..1 — combo drive. Opens the drone filter and thickens the hats. */
  setIntensity(v) { this.intensity = Math.max(0, Math.min(1, v)); }

  stop() {
    if (!this.started) return;
    this.setMode('quiet', 1.2);
  }

  update() {
    if (!this.ensure()) return;
    const ctx = this.audio.ctx;
    const stepDur = 60 / this.bpm / 4;
    const until = ctx.currentTime + this._lookahead;
    // Long tab-out or a suspended context leaves _nextAt far in the past; resync rather
    // than schedule thousands of catch-up notes.
    if (this._nextAt < ctx.currentTime - 1) this._nextAt = ctx.currentTime + 0.05;

    let guard = 0;
    while (this._nextAt < until && guard++ < 64) {
      this._schedule(ctx, this._step, this._nextAt, stepDur);
      this._step = (this._step + 1) % 64;
      this._nextAt += stepDur;
    }

    if (this.airFilter) {
      // Combo drive is a mix move, not a new layer: the bed just gets brighter.
      const want = 420 + this.intensity * 900;
      this.airFilter.frequency.value += (want - this.airFilter.frequency.value) * 0.02;
    }
  }

  _schedule(ctx, step, t, stepDur) {
    const m = MODES[this.mode];
    const bar = (step / 16) | 0;
    const root = BAR_ROOT[bar];
    const beat = step % 16;

    if (m.pulse > 0.01) {
      // Plucked arpeggio: one note per 8th, with a bell an octave up on the bar.
      if (beat % 2 === 0) {
        const n = ARP[(step / 2) % ARP.length];
        this._pluck(ctx, this.layers.pulse, root * 4 * SEMI(n), t, 0.42, 0.055);
      }
      if (beat === 0) this._pluck(ctx, this.layers.pulse, root * 8, t, 1.1, 0.026, 'sine');
    }

    if (m.bass > 0.01) {
      // Root on the downbeats, octave stab on the "and" of 3 — enough to push, not busy.
      if (beat === 0 || beat === 6 || beat === 11) this._bass(ctx, root, t, stepDur * (beat === 0 ? 5 : 3));
    }

    if (m.drum > 0.01) {
      if (beat === 0 || beat === 6 || beat === 10) this._kick(ctx, t);
      if (beat === 4 || beat === 12) this._snare(ctx, t);
      const hatEvery = this.intensity > 0.5 ? 1 : 2;
      if (beat % hatEvery === 0) this._hat(ctx, t, beat % 4 === 0 ? 0.10 : 0.055);
      // Boss waves get a tom fill on the last bar so the loop has a horizon.
      if (this.mode === 'boss' && bar === 3 && beat >= 12) this._tom(ctx, t, 120 - (beat - 12) * 14);
    }

    if (m.horn > 0.01 && beat === 0) {
      this._horn(ctx, root * 2, t, stepDur * 15);
    }
  }

  // --- voices ---------------------------------------------------------------
  _pluck(ctx, out, f, t, dur, g0, type = 'triangle') {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = f;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(g0, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(out);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _bass(ctx, f, t, dur) {
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.Q.value = 6;
    lp.frequency.setValueAtTime(240 + this.intensity * 500, t);
    lp.frequency.exponentialRampToValueAtTime(110, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.11, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(lp).connect(g).connect(this.layers.bass);
    o.start(t); o.stop(t + dur + 0.02);
  }

  _kick(ctx, t) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.11);
    const g = ctx.createGain();
    // Levels below are set so the bed sits *under* combat: measured RMS of the music bus
    // stays roughly half that of a busy fight, which is where a score stops competing.
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    o.connect(g).connect(this.layers.drum);
    o.start(t); o.stop(t + 0.26);
  }

  _snare(ctx, t) {
    const s = ctx.createBufferSource(); s.buffer = this.audio._noiseBuf; s.loop = true;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1900; f.Q.value = 0.9;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.14, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    s.connect(f).connect(g).connect(this.layers.drum);
    s.start(t); s.stop(t + 0.2);
    this._pluck(ctx, this.layers.drum, 190, t, 0.09, 0.06, 'triangle');
  }

  _hat(ctx, t, g0) {
    const s = ctx.createBufferSource(); s.buffer = this.audio._noiseBuf; s.loop = true;
    s.playbackRate.value = 1.4;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7200;
    const g = ctx.createGain();
    g.gain.setValueAtTime(g0, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.045);
    s.connect(f).connect(g).connect(this.layers.drum);
    s.start(t); s.stop(t + 0.08);
  }

  _tom(ctx, t, f) {
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * 0.6, t + 0.16);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    o.connect(g).connect(this.layers.drum);
    o.start(t); o.stop(t + 0.24);
  }

  /** Root + fifth + a minor second above the root: consonant, with a splinter in it. */
  _horn(ctx, f, t, dur) {
    for (const [mul, gain] of [[1, 0.055], [1.5, 0.038], [SEMI(13), 0.016]]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f * mul;
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass';
      lp.frequency.setValueAtTime(500, t);
      lp.frequency.linearRampToValueAtTime(1800, t + dur * 0.5);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(gain, t + dur * 0.25);
      g.gain.linearRampToValueAtTime(0.0001, t + dur);
      o.connect(lp).connect(g).connect(this.layers.horn);
      o.start(t); o.stop(t + dur + 0.05);
    }
  }
}
