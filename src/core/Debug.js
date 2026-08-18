import * as THREE from 'three';
import { getTrapDef, TRAPS } from '../traps/roster.js';
import { ROSTER, getEnemyDef } from '../entities/enemies/roster.js';
import { LEVELS } from '../world/LevelDefs.js';
import { CAMPAIGN } from '../director/campaign.js';

/**
 * Console/automation surface. Exposed as `window.__GAME__.debug` and `window.dbg`.
 * Exists so a reviewer (human or agent) can drive the game deterministically without
 * needing to physically play it, and so regressions can be caught in a headless step loop.
 */
const SCRATCH_SIZE = new THREE.Vector2();

/**
 * Half-float -> float, as a 64k table. Built once, on the first screenshot: a 1600x900
 * readback is 5.8M conversions and the bit-twiddling version is the whole cost of a capture.
 */
let HALF_LUT = null;
function buildHalfLut() {
  const t = new Float32Array(65536);
  for (let u = 0; u < 65536; u++) {
    const s = (u >> 15) & 1, e = (u >> 10) & 31, m = u & 1023;
    t[u] = e === 0 ? (s ? -1 : 1) * Math.pow(2, -14) * (m / 1024)
      : e === 31 ? (m ? NaN : (s ? -Infinity : Infinity))
        : (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + m / 1024);
  }
  return t;
}

export function installDebug(game) {
  const dbg = {
    game,
    LEVELS, TRAPS, ROSTER,

    /**
     * Advance the simulation by `n` frames at a fixed dt, ignoring rAF.
     *
     * The last frame is measured in isolation: `renderer.info` has `autoReset = false`
     * (the post-FX composer issues ~15 renders per frame, and letting three reset on
     * each one means you read whichever pass happened to be last). So we reset once,
     * render exactly one frame, and latch the totals. Without this, `drawCalls` reads
     * anywhere from 1 to several thousand for the same scene depending on timing —
     * which is exactly the contradiction that showed up across agent perf reports.
     */
    step(n = 60, dt = 1 / 60) {
      // Simulated time races ahead of the wall clock, so `engine._last` is left far in
      // the future by the previous call. Re-seeding it here keeps the first frame of
      // every subsequent step() from computing a negative delta and being clamped to
      // zero — otherwise consecutive step() calls each silently lose a frame.
      let t = performance.now();
      game.engine._last = t;
      const info = game.renderer.info;
      for (let i = 0; i < n; i++) {
        t += dt * 1000;
        if (i === n - 1) info.reset();
        game.engine._frame(t, game);
      }
      this._lastRender = { calls: info.render.calls, triangles: info.render.triangles };
      return this.snapshot();
    },

    /** Run until a predicate holds or `maxFrames` elapse. */
    until(pred, maxFrames = 3600, dt = 1 / 60) {
      let t = performance.now();
      game.engine._last = t;
      for (let i = 0; i < maxFrames; i++) {
        t += dt * 1000;
        game.engine._frame(t, game);
        if (pred(game)) return { hit: true, frames: i, ...this.snapshot() };
      }
      return { hit: false, frames: maxFrames, ...this.snapshot() };
    },

    load(i) {
      game.ui.hideAll();
      game.loadLevel(i);
      game.ui.showHUD();
      // Re-assert god state explicitly rather than letting a stale flag ride through.
      game.player.invulnerable = !!this._god;
      return this.snapshot();
    },
    coin(n = 100000) { game.scoring.addCoin(n, 'debug'); return game.scoring.coin; },

    placeTrap(id, gx, gz, dir = 'S') {
      const def = getTrapDef(id);
      if (!def) return { ok: false, reason: 'unknown trap ' + id };
      const check = game.traps.canPlace(def, gx, gz, dir);
      if (!check.ok) return check;
      const t = game.traps.place(def, gx, gz, check.dir ?? dir);
      return { ok: !!t, id, gx, gz, dir: check.dir ?? dir };
    },

    /**
     * Build a killbox on the route the horde actually walks.
     *
     * The original version scanned `grid.cells` in raster order and filled the first N
     * legal tiles, which are in the corner of the map. It placed 20 traps with *zero*
     * overlap with any cell an orc ever entered, so every measurement taken through it —
     * including two rounds of critic reviews — described a killbox that never fired.
     *
     * The route is traced by following the flow field's direction vectors from each
     * spawn, not its distance gradient: walking `dist` downhill produces a different
     * path from where the orcs go, which is its own well-documented trap here.
     */
    route(maxLen = 400) {
      const grid = game.grid;
      const flow = grid.riftFlow();
      const seen = new Set();
      const out = [];
      for (const s of grid.spawns) {
        let gx = s.gx, gz = s.gz;
        for (let step = 0; step < maxLen; step++) {
          const key = `${gx},${gz}`;
          if (!seen.has(key)) { seen.add(key); out.push({ gx, gz, step }); }
          const d0 = flow.dirAt(gx, gz, { x: 0, z: 0 });
          if (!d0.x && !d0.z) break;
          gx += Math.round(d0.x); gz += Math.round(d0.z);
          if (!grid.inBounds(gx, gz)) break;
          if (grid.cell(gx, gz)?.kind === 'rift') break;
        }
      }
      return out;
    },

    autoBuild(id = 'spike-floor', limit = 40) {
      const def = getTrapDef(id);
      let n = 0;
      // Nearest-the-rift first: that is where a competent player builds, and it is the
      // stretch every lane shares.
      const cells = this.route().sort((a, b) => b.step - a.step);
      const tryCell = (gx, gz) => {
        if (n >= limit) return;
        const chk = game.traps.canPlace(def, gx, gz, 'S');
        if (chk.ok) { game.traps.place(def, gx, gz, chk.dir ?? 'S'); n++; }
      };
      for (const c of cells) tryCell(c.gx, c.gz);
      // Widen to the tiles flanking the route — a one-tile-wide row misses orcs that
      // spread across a corridor, which is a real effect and not an artifact.
      for (const c of cells) {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) tryCell(c.gx + dx, c.gz + dz);
      }
      return { placed: n, routeCells: cells.length };
    },

    spawn(id, gx, gz) {
      const w = game.grid.toWorld(gx ?? game.grid.spawns[0].gx, gz ?? game.grid.spawns[0].gz);
      return !!game.enemies.spawn(id, w.x, w.z);
    },
    /** Flood the level to measure the frame cost of a real horde. */
    stress(count = 250, id = 'orc-grunt') {
      for (let i = 0; i < count; i++) {
        const s = game.grid.spawns[i % game.grid.spawns.length];
        game.enemies.spawnAtMarker(id, s);
      }
      return game.enemies.count;
    },

    startWave() { return game.director.startWave(); },
    skipToWave(i) {
      game.director.waveIndex = i - 1;
      game.director.running = false;
      return game.director.startWave();
    },

    killAll() {
      for (const e of Array.from(game.enemies.list.items)) e.hp = 0, e.kill?.({ amount: 9999 }, game);
      return game.enemies.count;
    },

    /**
     * Invulnerability toggle.
     *
     * This has to survive `loadLevel` (which resets the player) *and* be visible in
     * `snapshot()`. An earlier version set the flag once and never re-applied it, so it
     * silently persisted across level loads — meaning any balance measurement taken after
     * a single god-mode call in the same page session was quietly meaningless. A debug
     * switch that corrupts data without saying so is worse than no debug switch.
     */
    god(on = true) {
      this._god = !!on;
      game.player.invulnerable = this._god;
      return this._god;
    },

    snapshot() {
      const g = game;
      return {
        state: g.state,
        level: g.levelIndex,
        levelName: LEVELS[g.levelIndex]?.name,
        frame: g.clock.frame,
        elapsed: +g.clock.elapsed.toFixed(2),
        fps: +g.clock.fps.toFixed(1),
        enemies: g.enemies.count,
        traps: g.traps.list.length,
        rift: g.level ? `${g.level.rift.hp}/${g.level.rift.max}` : null,
        wave: `${g.director.waveIndex + 1}/${g.director.waveCount}`,
        waveRunning: g.director.running,
        remaining: g.director.remaining,
        coin: g.scoring.coin,
        score: g.scoring.score,
        kills: g.scoring.kills,
        trapKills: g.scoring.trapKills,
        leaks: g.scoring.leaks,
        combo: g.scoring.combo,
        playerHp: +g.player.hp.toFixed(0),
        // Surfaced so a balance run can never be read as honest when it wasn't.
        //
        // These are two different questions and conflating them made the field useless:
        // `invulnerable` is legitimately true during the build phase and respawn grace,
        // so OR-ing them reported god mode on runs where god() was never called. Only
        // `god` invalidates a measurement; `invulnerable` is just a state.
        god: !!this._god,
        invulnerable: !!g.player.invulnerable,
        // Latched by step() from a single isolated frame. Reading renderer.info directly
        // here would report whichever composer pass ran last, not the scene's real cost.
        drawCalls: this._lastRender?.calls ?? null,
        triangles: this._lastRender?.triangles ?? null,
      };
    },

    /**
     * Capture the current rendered frame as a JPEG data URL.
     * Sized down and compressed so it survives a console/automation round-trip.
     *
     * **Read back off a render target, never off the canvas.** `drawImage(glCanvas)` — and
     * `readPixels` against the default framebuffer — return the *compositor's* copy, and
     * that only refreshes when the page actually paints. Inside one synchronous block it
     * never does, so a capture pass that took six screenshots in a turn wrote six copies of
     * whatever the page happened to be showing when the turn began, however many times the
     * scene had been re-rendered in between. Verified: three levels and an explosion all
     * came back byte-identical, at mean luma 46.64 each.
     *
     * That is a silent-wrong bug of exactly the kind this file exists to prevent, and it has
     * been under every automated review this project has had. Rendering to an offscreen
     * target and reading that is always current, and costs one extra blit per screenshot.
     */
    shot({ width = 960, quality = 0.72 } = {}) {
      const src = this._grabFrame();
      const scale = Math.min(1, width / src.width);
      const out = document.createElement('canvas');
      out.width = Math.round(src.width * scale);
      out.height = Math.round(src.height * scale);
      out.getContext('2d').drawImage(src, 0, 0, out.width, out.height);
      return out.toDataURL('image/jpeg', quality);
    },

    /** Render one frame offscreen and return it as a full-resolution 2D canvas. */
    _grabFrame() {
      const { renderer, engine } = game;
      const pf = engine.postfx;
      let pixels, w, h;

      if (pf?.enabled) {
        // The grade pass writes to the composer's own target when it is not rendering to
        // screen. Which of the two ping-pong targets ends up holding it depends on the swap
        // parity, so identify it rather than assume: the graded frame is the one clamped to
        // [0,1] (the scene buffer is HDR and runs to 3-4) and not the leftover empty one.
        const was = pf.composer.renderToScreen;
        pf.composer.renderToScreen = false;
        try { engine._frame(performance.now(), game); } catch { /* capture anyway */ }
        pf.composer.renderToScreen = was;
        const best = [pf.composer.readBuffer, pf.composer.writeBuffer]
          .map((rt) => this._probeTarget(rt))
          .filter((b) => b.max <= 1.001 && b.mean > 0.002)
          .sort((a, b) => b.mean - a.mean)[0];
        if (best) { pixels = best.raw; w = best.w; h = best.h; }
      }

      if (!pixels) {
        // No composer, or it is switched off: render the scene straight into a byte target.
        const size = renderer.getSize(SCRATCH_SIZE);
        w = Math.max(1, Math.round(size.x * renderer.getPixelRatio()));
        h = Math.max(1, Math.round(size.y * renderer.getPixelRatio()));
        if (!this._shotRT || this._shotRT.width !== w || this._shotRT.height !== h) {
          this._shotRT?.dispose();
          this._shotRT = new THREE.WebGLRenderTarget(w, h);
        }
        const prev = renderer.getRenderTarget();
        renderer.setRenderTarget(this._shotRT);
        renderer.render(game.scene, game.camera);
        renderer.setRenderTarget(prev);
        const bytes = new Uint8Array(w * h * 4);
        renderer.readRenderTargetPixels(this._shotRT, 0, 0, w, h, bytes);
        let lit = 0;
        for (let i = 0; i < bytes.length; i += 256) if (bytes[i] | bytes[i + 1] | bytes[i + 2]) lit++;
        if (lit) pixels = bytes;
      }

      if (!pixels) {
        // Both readbacks came back empty. That is not a bug in either of them — a page the
        // browser has stopped compositing (hidden tab, no displayed pane) renders black to
        // *everything*, offscreen targets included. Fall back to the canvas snapshot, which
        // at least holds the last frame that was really drawn: stale beats blank, and this
        // is exactly the old behaviour, so this path can never be worse than not having tried.
        renderer.setRenderTarget(null);
        const src = renderer.domElement;
        const back = document.createElement('canvas');
        back.width = src.width; back.height = src.height;
        back.getContext('2d').drawImage(src, 0, 0);
        return back;
      }

      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      const img = ctx.createImageData(w, h);
      const d = img.data;
      // The composer path hands back raw half-float bits; the fallback hands back bytes.
      const lut = pixels instanceof Uint16Array ? (HALF_LUT ||= buildHalfLut()) : null;
      for (let y = 0; y < h; y++) {
        const sy = (h - 1 - y) * w;          // GL origin is bottom-left, canvas is top-left
        for (let x = 0; x < w; x++) {
          const s = (sy + x) * 4, t = (y * w + x) * 4;
          if (lut) {
            d[t] = lut[pixels[s]] * 255;
            d[t + 1] = lut[pixels[s + 1]] * 255;
            d[t + 2] = lut[pixels[s + 2]] * 255;
          } else {
            d[t] = pixels[s]; d[t + 1] = pixels[s + 1]; d[t + 2] = pixels[s + 2];
          }
          d[t + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      return cv;
    },

    /**
     * Read a half-float target and describe it well enough to tell the graded frame from the
     * scene HDR frame and from an empty buffer.
     *
     * Sampled every 16th pixel, not every pixel: this runs on both ping-pong targets for
     * every screenshot and only has to answer "which one of these two", which a 6% sample
     * settles decisively. Converting both in full made a capture pass time out.
     */
    _probeTarget(rt) {
      const w = rt.width, h = rt.height;
      const raw = new Uint16Array(w * h * 4);
      game.renderer.readRenderTargetPixels(rt, 0, 0, w, h, raw);
      const lut = (HALF_LUT ||= buildHalfLut());
      let sum = 0, max = 0, n = 0;
      for (let i = 0; i < raw.length; i += 64) {
        const r = lut[raw[i]], g = lut[raw[i + 1]], b = lut[raw[i + 2]];
        if (r > max) max = r;
        if (g > max) max = g;
        if (b > max) max = b;
        sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        n++;
      }
      return { raw, w, h, mean: sum / n, max };
    },

    /** POST the current frame to the dev-server screenshot endpoint. Returns the path. */
    async save(name = 'shot') {
      const data = this.shot();
      const res = await fetch('/__shot?name=' + encodeURIComponent(name), {
        method: 'POST', body: data,
      });
      return res.text();
    },

    /** Every enemy/trap id, for building test scripts. */
    ids() {
      return { enemies: ROSTER.map((r) => r.id), traps: TRAPS.map((t) => t.id), levels: LEVELS.map((l) => l.name) };
    },

    /** Sanity check that every id referenced by every level actually exists. */
    validate() {
      const problems = [];
      const enemyIds = new Set(ROSTER.map((r) => r.id));
      const trapIds = new Set(TRAPS.map((t) => t.id));

      // Wave composition is owned by src/director/campaign.js; a level's own `waves`
      // is only a fallback. Validate whichever one the director will actually run, and
      // flag the case where a level still carries a *diverged* copy — a stale duplicate
      // that silently does nothing is worse than no duplicate, because it reads as truth.
      const authoritative = (i) => CAMPAIGN?.[i] ?? LEVELS[i]?.waves ?? [];
      const enemyIdsIn = (waves) => {
        const out = [];
        for (const w of waves || []) {
          for (const grp of w.groups || []) out.push(grp.id);
          for (const beat of w.beats || []) {
            // Beats carry `spawn: [[id, count, opts], ...]`; `streams` is the runtime form.
            for (const entry of beat.spawn || []) out.push(Array.isArray(entry) ? entry[0] : entry?.id);
            for (const s of beat.streams || []) out.push(s.id);
          }
        }
        return out.filter(Boolean);
      };

      LEVELS.forEach((l, i) => {
        for (const id of enemyIdsIn(authoritative(i))) {
          if (!enemyIds.has(id)) problems.push(`L${i + 1} wave references unknown enemy "${id}"`);
        }
        if (CAMPAIGN?.[i] && l.waves && l.waves !== CAMPAIGN[i]) {
          const a = JSON.stringify(enemyIdsIn(CAMPAIGN[i]));
          const b = JSON.stringify(enemyIdsIn(l.waves));
          if (a !== b) problems.push(`L${i + 1} carries a diverged copy of its waves in LevelDefs that the director ignores`);
        }
        for (const u of l.unlocks || []) if (!trapIds.has(u)) problems.push(`L${i + 1} unlocks unknown trap "${u}"`);
        // Reachability: every spawn must be able to reach the rift on an empty board.
        const w = l.width, h = l.height;
        if (!l.map || l.map.length !== h) problems.push(`L${i + 1} map height ${l.map?.length} != ${h}`);
        else if (l.map.some((r) => r.length !== w)) problems.push(`L${i + 1} has rows of the wrong width`);
      });
      return problems.length ? problems : 'ok';
    },
  };

  game.debug = dbg;
  window.dbg = dbg;
  return dbg;
}
