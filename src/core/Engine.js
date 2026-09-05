import * as THREE from 'three';
import { Input } from './Input.js';
import { EventBus } from '../shared/EventBus.js';
import { makeRng } from '../shared/rng.js';
import { CameraRig } from './CameraRig.js';
import { PostFX, DEFAULT_GRADE } from './PostFX.js';

/**
 * Owns the WebGL context, the frame loop, and global time. Systems register themselves
 * with `engine.addSystem({ order, update(dt, game) })` and are ticked in order.
 *
 * Time model:
 *   raw dt -> clamped to 1/20s -> multiplied by timeScale -> handed to systems as `game.clock.dt`
 *   `game.clock.rawDt` stays real for UI animation and audio.
 * Hitstop is a short timeScale dip, not a freeze, so audio and particles keep breathing.
 */
export class Engine {
  constructor(canvas) {
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      // Lets automated review capture the exact frame that was rendered, even when the
      // page is not compositing (headless verification, CI screenshots).
      preserveDrawingBuffer: true,
    });
    this._maxPixelRatio = Math.min(devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this._maxPixelRatio);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // Only used on the `postfx: off` path — with the composer running, materials render to
    // a target and three deliberately skips tone mapping there (PostFX does it instead).
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = DEFAULT_GRADE.exposure;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x07080c, 1);
    // `info` resets itself at the top of every renderer.render(). The composer calls render
    // once per pass, so anything reading info afterwards saw only the final fullscreen quad
    // ("1 draw call"). Reset once per frame instead and the counters cover the whole chain.
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.FogExp2(0x0a0b12, 0.010);

    // 42° rather than 48°: a longer lens keeps an orc the same size at the top of the frame
    // as at the bottom, which is what makes a crowd readable. The lost coverage is bought
    // back with distance instead of with distortion.
    this.camera = new THREE.PerspectiveCamera(42, 1.7778, 0.5, 600);
    this.rig = new CameraRig(this.camera);

    this.input = new Input(canvas);
    this.bus = new EventBus();
    this.rng = makeRng(0xC0FFEE);

    this.postfx = new PostFX(this.renderer, this.scene, this.camera);

    this.clock = { dt: 0, rawDt: 0, elapsed: 0, frame: 0, fps: 60, timeScale: 1 };
    this._hitstop = 0;
    this._slowmo = { scale: 1, time: 0 };
    this._systems = [];
    this._last = performance.now();
    this._running = false;
    this._acc = 0;
    this._fpsAcc = 0; this._fpsFrames = 0;

    // Adaptive resolution: drop pixel ratio before we drop frames.
    this._quality = 1;
    this._slowFrames = 0;
    this._qualityHold = 0;

    // Fog is authored per level in world/LevelDefs.js against the old, much closer camera.
    // Re-fit it to whatever distance the rig actually settles at, or the far half of every
    // arena disappears into flat grey the moment we pull back.
    this._fogBase = new THREE.Color(0x0a0b12);
    this._clear = new THREE.Color();
    this.bus.on('level:load', ({ level }) => {
      this._fogBase.copy(this.scene.fog?.color ?? this._fogBase);
      // Camera before fog: `refitAtmosphere` fits the density to the distance the rig has
      // settled on, so it has to run after that distance is the new level's, not the old.
      this.applyLevelCamera(level);
      this.refitAtmosphere();
      this.applyLevelGrade(level?.def);
    });

    // Bosses the camera has to make room for. Kept as a set fed by the event bus rather
    // than found by scanning `game.enemies` every frame — there can be 250 of those and at
    // most one of these.
    this._bosses = new Map();   // enemy -> cached height in units
    this.bus.on('enemy:spawn', ({ enemy }) => {
      if (enemy?.has?.('boss')) this._bosses.set(enemy, 0);
    });
    this.bus.on('enemy:killed', ({ enemy }) => this._bosses.delete(enemy));
    this.bus.on('enemy:leaked', ({ enemy }) => this._bosses.delete(enemy));
    this.bus.on('level:load', () => this._bosses.clear());
    this._bossBox = new THREE.Box3();

    addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._last = performance.now();
    });
    this.resize();
  }

  addSystem(sys) {
    this._systems.push(sys);
    this._systems.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return sys;
  }
  removeSystem(sys) {
    const i = this._systems.indexOf(sys);
    if (i >= 0) this._systems.splice(i, 1);
  }

  resize() {
    // A zero-sized canvas (first frame, hidden tab, detached preview) gives aspect = NaN,
    // which unprojects the cursor to NaN, which poisons the camera focus permanently.
    // There is no recovery from NaN through a lerp, so never let it in.
    const w = Math.max(1, this.canvas.clientWidth || innerWidth || 1);
    const h = Math.max(1, this.canvas.clientHeight || innerHeight || 1);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.postfx?.setSize(w, h, this.renderer.getPixelRatio());
    this.rig.invalidate();   // aspect changed, so the ground footprint the rig clamps to did too
    this.bus.emit('engine:resize', { w, h });
  }

  /**
   * Fog that reads as depth rather than as a dirty lens: ~12% at the focus plane, ~45% at
   * the far edge of the visible ground, and tinted a little toward the level's torch colour
   * so distance warms instead of turning to slate.
   */
  refitAtmosphere() {
    const fog = this.scene.fog;
    if (!fog?.isFogExp2) return;
    const d = Math.max(20, this.rig.distanceTarget);
    fog.density = 0.39 / d;
    // From the level's authored colour every time — lerping in place would let repeated
    // calls (every wheel click) walk the fog all the way to the haze colour.
    fog.color.copy(this._fogBase).lerp(TORCH_HAZE, 0.22);
    // The void past the arena edge is not sky — it is the inside of a mountain. Clearing to
    // the fog colour made it read as a lavender horizon above every level's back wall.
    this._clear.copy(fog.color).multiplyScalar(0.2);
    this.renderer.setClearColor(this._clear, 1);
  }

  /**
   * Per-level grade trim.
   *
   * The campaign palettes span roughly two stops: a snowfield lit by a white sun and a
   * basalt throne room lit by witchfire are not the same picture, and one global exposure
   * cannot serve both — at the setting that makes the Gatehouse read, Frostwatch clips to
   * paper and the Black Throne loses its orcs in the purple.
   *
   * The trim is an explicit table rather than something derived from the palette numbers,
   * because a derived estimate cannot see emissives (lava pits, witchfire, the rift) and
   * silently overrules mood the WORLD owner authored on purpose. A level def may override
   * with `exposure` (a multiplier) and/or a partial `grade` object.
   */
  applyLevelGrade(def) {
    this.postfx.setGrade(DEFAULT_GRADE);
    if (!def) return;
    if (def.grade) this.postfx.setGrade(def.grade);
    const base = def.grade?.exposure ?? DEFAULT_GRADE.exposure;
    const trim = def.exposure ?? THEME_EXPOSURE[def.palette?.theme] ?? 1;
    this.postfx.exposure = base * trim;
    this.renderer.toneMappingExposure = this.postfx.exposure;   // keeps the `postfx: off` path matched
  }

  /**
   * Per-level camera default, and the geometry the rig collides against.
   *
   * Runs on `level:load`, which is emitted *after* `Game.loadLevel` has handed the rig the
   * level's authored `camera.distance`, so this is where the framing policy gets the last
   * word — see `CameraRig.fromAuthored()` for why the authored number is treated as a hint.
   *
   * A level def may author `camera.pitch` (degrees, clamped to the player band) and
   * `camera.playDistance` (an exact distance, bypassing the compression) when a particular
   * arena wants something the campaign-wide default does not give it — a long approach
   * corridor that wants a lower angle, a vertical throne room that wants a higher one.
   */
  applyLevelCamera(level) {
    this.rig.obstacles = level?.root.children.filter(child => child !== level.rift?.object) ?? [];
    this._riftMaterials = [];
    const materials = new Set();
    level?.rift?.object.traverse(object => {
      if (object.material) {
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
      }
    });
    for (const material of materials) {
      this._riftMaterials.push({ material, opacity: material.opacity,
        transparent: material.transparent, depthWrite: material.depthWrite });
    }
    const cam = level?.def?.camera || {};
    if (Number.isFinite(cam.pitch)) this.rig.setPitch(cam.pitch, true);
    else this.rig.resetPitch();
    if (Number.isFinite(cam.playDistance)) this.rig.setZoom(cam.playDistance);
    else this.rig.setZoom(this.rig.fromAuthored(cam.distance));

    // Camera-vs-geometry, as a floor under the boom rather than a per-frame collision query —
    // see `CameraRig.minHeight`. `ceilingHeight` lets a level with taller-than-contract
    // architecture raise it; nothing in the campaign needs to today.
    this.rig.minHeight = (level?.def?.ceilingHeight ?? WALL_TOP) + 1.5;
  }

  /** 'high' | 'medium' | 'low' | 'off'. `off` bypasses the composer entirely. */
  setPostQuality(q) { this.postfx.setQuality(q); }

  /** Freeze-frame on impact. Additive so a chain of kills feels heavier, capped so it never drags. */
  hitstop(seconds) {
    // 5 frames is the contract (ARCHITECTURE §5). The old 0.18s cap was 11 frames, which
    // during a trap chain reads as the game hitching, not as the orc being hit hard.
    this._hitstop = Math.min(0.085, this._hitstop + seconds);
  }
  /** Sustained slow motion (boss death, last-orc kill). */
  slowmo(scale, seconds) { this._slowmo.scale = scale; this._slowmo.time = seconds; }

  start(game) {
    this.game = game;
    this._running = true;
    this._last = performance.now();
    const tick = (now) => {
      if (!this._running) return;
      requestAnimationFrame(tick);
      this._frame(now, game);
    };
    requestAnimationFrame(tick);
  }
  stop() { this._running = false; }

  _frame(now, game) {
    // Clamp both ends. `min` alone lets a backwards clock through, and a negative dt is not
    // a small mistake: `damp()` extrapolates instead of interpolating, so the camera focus
    // slingshots and trauma *grows* instead of decaying. Debug stepping, a restored tab and
    // a clock adjustment can all hand us `now < _last`.
    const raw = Math.max(0, Math.min((now - this._last) / 1000, 0.05));
    this._last = now;

    // --- time scaling -------------------------------------------------------
    let scale = 1;
    if (this._hitstop > 0) { this._hitstop -= raw; scale *= 0.06; }
    if (this._slowmo.time > 0) { this._slowmo.time -= raw; scale *= this._slowmo.scale; }
    if (game.state === 'paused') scale = 0;
    scale *= this.clock.timeScale;

    const c = this.clock;
    c.rawDt = raw;
    c.dt = raw * scale;
    c.elapsed += c.dt;
    c.frame++;

    // --- fps + adaptive resolution -----------------------------------------
    this._fpsAcc += raw; this._fpsFrames++;
    if (this._fpsAcc > 0.5) {
      c.fps = this._fpsFrames / this._fpsAcc;
      this._fpsAcc = 0; this._fpsFrames = 0;
      this._adapt(c.fps);
    }

    this.renderer.info.reset();   // see autoReset in the constructor

    // --- camera zoom --------------------------------------------------------
    // Consumed here rather than in a system so it applies even while the shop is open.
    if (this.input.mouse.zoomWheel) {
      this.rig.zoom(this.input.mouse.zoomWheel * 0.9);
      this.refitAtmosphere();
    }

    // --- camera tilt --------------------------------------------------------
    // Same reasoning as zoom: consumed here, not in a system, so it still works with the
    // shop open. Driven off rawDt so hitstop does not make the camera crawl mid-tilt.
    const tilt = (this.input.down('tiltUp') ? 1 : 0) - (this.input.down('tiltDown') ? 1 : 0);
    if (tilt) this.rig.tilt(tilt * this.rig.tiltRate * raw);
    if (this.input.mouse.tiltWheel) this.rig.tilt(this.input.mouse.tiltWheel * -2.2);

    // --- input aim ----------------------------------------------------------
    // Deliberately before rig.update: the cursor is projected through the camera the
    // player was actually looking at last frame, so aim never lags a moving camera.
    this.camera.updateMatrixWorld();
    this.input.updateAim(this.camera, 0);

    // --- systems ------------------------------------------------------------
    for (const s of this._systems) {
      if (s.enabled === false) continue;
      s.update(c.dt, game);
    }

    this._frameBoss(game);
    this.rig.update(c.rawDt);
    if (game.level?.rift && game.player) {
      const separation = game.player.position.distanceTo(game.level.rift.object.position);
      const opacity = Math.max(0.06, Math.min(1, (separation - 2) / 6));
      for (const entry of this._riftMaterials ?? []) {
        entry.material.opacity = entry.opacity * opacity;
        entry.material.transparent = opacity < 1 || entry.transparent;
        entry.material.depthWrite = opacity < 1 ? false : entry.depthWrite;
      }
    }
    // The composer is a nice-to-have; the frame is not. Anything that throws inside the
    // chain retires it for the session rather than taking the game down with it.
    if (this.postfx.enabled) {
      try {
        this.postfx.render(c.rawDt);
      } catch (err) {
        console.warn('[Engine] post-processing failed, falling back to direct render.', err);
        this.postfx.setQuality('off');
        this.renderer.setRenderTarget(null);
        this.renderer.render(this.scene, this.camera);
      }
    } else {
      this.renderer.render(this.scene, this.camera);
    }
    this.input.endFrame();
  }

  /**
   * Keep a live boss in frame.
   *
   * The rig follows the player and nothing else, which is right for 249 of the 250 things on
   * screen and wrong for the one that is ten times their size: at level 10 the Orc King —
   * 10.8 units tall against a grub's 1.0 — is cropped in half by the framing that fits the
   * player. That scale difference is the entire read of a boss fight, so the camera has to
   * spend frame on it rather than throw it away.
   *
   * Only while he is close enough to matter (1.4 half-views), so the camera does not pull
   * back for a boss that is still marching down a corridor the player cannot see.
   */
  _frameBoss(game) {
    if (!this._bosses.size || !game.player) return;
    const p = game.player.position;
    const v = this.rig.view;
    const reach = Math.max(v.halfW, v.halfD) * 1.4;
    let best = null, bestD = Infinity, bestH = 0;
    for (const [e, h] of this._bosses) {
      if (!e.object || e.state === 'dead') continue;
      const dx = e.position.x - p.x, dz = e.position.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > reach || d >= bestD) continue;
      let hh = h;
      if (!hh) {
        // Measured once per boss, not per frame: setFromObject walks the whole hierarchy.
        this._bossBox.setFromObject(e.object);
        hh = Math.max(1, this._bossBox.max.y - Math.min(0, this._bossBox.min.y));
        this._bosses.set(e, hh);
      }
      best = e; bestD = d; bestH = hh;
    }
    if (best) this.rig.frame(best.position, best.radius ?? 1, bestH);
  }

  /**
   * Two-stage degradation, resolution last. Bloom is a pure fill cost and the cheapest
   * thing to lose; dropping pixel ratio is visible, so it needs a hold timer or the frame
   * rate hovering around the threshold makes the whole image pulse in and out of focus.
   */
  _adapt(fps) {
    if (this._qualityHold > 0) { this._qualityHold--; return; }

    if (fps < 50) this._slowFrames++;
    else if (fps > 58) this._slowFrames = Math.max(0, this._slowFrames - 1);

    const post = this._slowFrames > 8 ? 'low' : this._slowFrames > 4 ? 'medium' : 'high';
    if (post !== this.postfx.quality && this.postfx.quality !== 'off') {
      this.postfx.setQuality(post);
      this._qualityHold = 6;   // ~3s before we are allowed to change anything again
      return;
    }

    const target = this._slowFrames > 12 ? 0.6 : this._slowFrames > 10 ? 0.78 : 1;
    if (target !== this._quality) {
      this._quality = target;
      this.renderer.setPixelRatio(this._maxPixelRatio * target);
      this.resize();
      this._qualityHold = 6;
    }
  }
}

// Warm dust hanging in torchlight. Blended into the level's own fog colour, not replacing
// it, so an ice or dungeon palette stays cold — it just stops being black.
const TORCH_HAZE = new THREE.Color(0x2a1c14);

/**
 * Top of the tallest thing a level can contain. `CEIL_H = 6` is frozen in ARCHITECTURE §1;
 * duplicated as a number rather than imported because `src/core` must not depend on
 * `src/world`. If the contract ever moves, this moves with it.
 */
const WALL_TOP = 6;

/**
 * Exposure trim per palette theme. Keyed on `palette.theme` so a new variant of an existing
 * theme inherits it for free.
 *
 * **This table is a technical backstop, not a normaliser, and round 4 is where that stopped
 * being a lie.** Round 3 solved each entry for a per-theme *target* mean luma — 46 to 54, a
 * band eight luma wide — and the result was a campaign with a standard deviation of 2.7
 * against the reference's 23.6. Deliberately converging ten hand-authored palettes onto one
 * number is normalising past the reference: OMD's own campaign runs 30.8 to 112.9 and the
 * range is the point of having ten levels. The targets are gone; per-level mood belongs to
 * the palette WORLD authors, and this table's only job is to keep a theme inside the range
 * the transfer curve can actually resolve.
 *
 * Which leaves one non-neutral entry. `throne` is basalt lit by witchfire and lands at 26.3
 * mean luma untrimmed — below the darkest frame in the reference set (30.8), which is where
 * shadow detail stops being dark and starts being absent. 1.05 puts The Black Throne at 27.1
 * and Sundered Halls at 36.9, still the campaign's dark end by 14 luma, and it *widens* the
 * campaign spread rather than closing it: stdev 15.0 -> 16.5 against the round-3 table.
 *
 * The other four were 0.98-1.01, which is under half an 8-bit code of trim. They were noise
 * dressed as intent, and carrying them made the table look like it was still doing something.
 *
 * Measured campaign at the values below, quiet build frame, one per level: 66.7 / 59.7 /
 * 55.8 / 41.7 / 61.5 / 49.3 / 71.9 / 85.3 / 36.9 / 27.1.
 */
const THEME_EXPOSURE = {
  keep: 1.00,
  dungeon: 1.00,
  forge: 1.00,
  ice: 1.00,      // the campaign's bright end, and nothing here needs to argue with that
  throne: 1.05,   // the one real trim; see above. Was 1.55 in round 2, 1.15 in round 3.
};
