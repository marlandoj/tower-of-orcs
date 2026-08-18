import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';

/**
 * The look. Three passes, no more: scene -> bloom -> grade/vignette/encode.
 *
 * Why this shape:
 *   Materials only run three's tone mapping when they draw straight to the default
 *   framebuffer (see WebGLPrograms: `currentRenderTarget === null`). Rendering through a
 *   composer therefore hands us *linear HDR*, which is exactly what we want — the bloom
 *   threshold can live above 1.0 so it catches emissives (rift, torches, spawn portals,
 *   muzzle flashes) and nothing else, instead of smearing every lit stone wall.
 *   Tone mapping then happens once, at the very end, inside the grade pass, so the grade
 *   can shape the curve instead of fighting an already-crushed image.
 *
 * The grade is the whole reason the scene stops being mud: ACES alone maps torch-lit brown
 * stone into a narrow midtone band. Pushing contrast around a low pivot, then split-toning
 * (warm highlights / cool-blue shadows) re-separates floor from wall from orc from trap.
 *
 * ---- Highlights (round 2) -------------------------------------------------------------
 * A blind pixel audit against 21 Orcs Must Die! press frames found ours had ~25x too few
 * pixels above 240 luma (0.00-0.05% against their 0.57% average). Two separate causes, both
 * here, neither of them "ACES is crushing the top end" — measured, a neutral linear 0.5
 * already lands at 243 out of 255:
 *
 *   1. `bloomThreshold` was 1.2 in scene-referred linear. A `MeshBasicMaterial` at full
 *      white writes exactly 1.0, so *every* unlit emissive in the game — torch flames, spell
 *      cores, muzzle flashes, trap fire — sat below the threshold by construction and the
 *      bloom pass ran on nothing but the rift and the molten pit floor.
 *   2. Saturated emissives never reach 240 luma no matter how bright they get, because 72%
 *      of luma is green: a torch at linear (1.0, 0.33, 0.05) grades out to 224. The old
 *      highlight desaturation was keyed on *output luma*, which for that pixel is 0.88 — so
 *      it never engaged, and `saturation: 1.28` actively pushed the core further from white.
 *
 * The fix for (2) is `bleach`: a scene-referred desaturation toward the max channel, applied
 * after exposure and before ACES. It is what a sensor does when one channel saturates and a
 * real fire keeps getting brighter — the core goes white-hot and the falloff stays orange,
 * which is precisely the OMD read. It is keyed on radiance, not on output, so it cannot
 * touch a midtone: a lit stone wall at linear 0.3 moves by one 8-bit code.
 *
 * `bloomThreshold` and `bleachLo/Hi` are both specified in POST-EXPOSURE units and divided
 * by `exposure` on the way to the pass. "What counts as glowing" then means the same thing
 * on a level we push two stops as on one we do not, and stays put when the WORLD owner
 * re-lights a level and the exposure trim follows it.
 *
 * ---- The white point (round 4) ---------------------------------------------------------
 * Round 3 fixed a clipped transfer curve by bending a shoulder onto (1,1) and took blown
 * white from 0.71% to 0.12%. That was the wrong target and this reverses it. A second audit
 * measured **0.00% pure white across 36 frames**, including an explosion where 14% of the
 * screen cleared 0.90 luma and not one pixel reached 255. Its verdict — "they moved the
 * ceiling, they didn't remove it" — was exactly right, and measurement here found the
 * ceiling was a hard number: every frame in the game topped out at luma 252.7-252.8.
 *
 * 252.8/255 = 0.9914 = 0.2126 + 0.7152 + 0.0722 x 0.88, and 0.88 is `highlightTint.b`.
 * **The split-tone was the wall.** A neutral pixel that graded to 1.0 came out (1.0, 1.0,
 * 0.88) = a pale cream, so the game had no white in it anywhere by construction — and
 * because `highlightTint.r` is 1.10, red clamped at c = 0.909 and the whole top decade was
 * squeezed into what was left. 9.3% of an explosion frame sat inside the 2.8 codes between
 * 250 and the wall.
 *
 * Two changes, both narrow:
 *
 *   1. `tintWhite` rolls the split-tone back to neutral as *luma* approaches white. Keyed on
 *      luma and not on the max channel on purpose: a saturated orange fire has luma ~0.6 even
 *      with its red channel at 1.0, so it keeps every bit of its warmth, while a genuinely
 *      near-white pixel — an explosion core, a boom-barrel detonation — stops being tinted
 *      cream and becomes white. This is what a sensor does; nothing clips to a hue.
 *   2. `whitePoint` terminates the round-3 shoulder at a finite radiance instead of letting
 *      it asymptote. The old knee reached 1.0 only at post-ACES sRGB 1.0, which needs ~15.4
 *      of scene-linear radiance (ACES' own fit saturates at 25.67 in its working space); the
 *      brightest thing in the game is a bloom-fed core around 5. So the curve was always
 *      going to stop one code short of white no matter what was fed to it. The knee is the
 *      same quadratic with the same C1 join at the shoulder — only its endpoint moves.
 *
 * `whitePoint` is in post-exposure linear, like `bleachLo/Hi`, and is converted to the
 * post-ACES sRGB domain on the CPU by `_toDisplay()`, a scalar mirror of the shader's own
 * ACES + OETF. The mirror is exact for a neutral value: both ACES matrices have row sums of
 * 1.0, so a grey passes through them untouched, and the bleach has already pulled anything
 * this bright most of the way to neutral before it gets there.
 *
 * Setting `whitePoint` to 0 (or anything that maps to display 1.0) restores the round-3
 * curve bit-for-bit.
 */
export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    this.quality = 'high';
    this._w = 1; this._h = 1; this._pr = 1;
    this._checks = 0;   // link-status probes remaining; see render()

    // HalfFloat so the HDR range survives into the bloom threshold. `samples` gives us MSAA
    // back — the renderer's own `antialias:true` does nothing once we render to a target.
    this._rt = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      samples: 2,
      depthBuffer: true,
      stencilBuffer: false,
    });
    this._rt.texture.name = 'PostFX.scene';

    this.composer = new EffectComposer(renderer, this._rt);
    this.composer.renderToScreen = true;

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // strength / radius / threshold. The threshold is re-derived from exposure in
    // _applyBloomThreshold(); this constructor value is overwritten by the setGrade() below.
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(1, 1), DEFAULT_GRADE.bloom, DEFAULT_GRADE.bloomRadius, DEFAULT_GRADE.bloomThreshold);
    this.composer.addPass(this.bloomPass);
    this._bloomThreshold = DEFAULT_GRADE.bloomThreshold;
    this._bloomKnee = DEFAULT_GRADE.bloomKnee;
    this._whitePoint = DEFAULT_GRADE.whitePoint;

    // RawShaderMaterial, not ShaderMaterial: this pass writes the final sRGB bytes itself,
    // so it must not have three's colour-space/tone-mapping chunks injected on top of it.
    const gradeMat = new THREE.RawShaderMaterial({
      name: 'PostFX.grade',
      uniforms: THREE.UniformsUtils.clone(GradeShader.uniforms),
      vertexShader: GradeShader.vertexShader,
      fragmentShader: GradeShader.fragmentShader,
      depthTest: false,
      depthWrite: false,
    });
    this.gradePass = new ShaderPass(gradeMat);
    this.composer.addPass(this.gradePass);

    this.u = this.gradePass.uniforms;
    this.setGrade(DEFAULT_GRADE);
  }

  /** Runtime knobs. Partial — anything omitted keeps its current value. */
  setGrade(g) {
    const u = this.u;
    if (g.exposure !== undefined) u.exposure.value = g.exposure;
    if (g.balance) u.balance.value.set(g.balance[0], g.balance[1], g.balance[2]);
    if (g.contrast !== undefined) u.contrast.value = g.contrast;
    if (g.pivot !== undefined) u.pivot.value = g.pivot;
    if (g.shoulder !== undefined) u.shoulder.value = g.shoulder;
    if (g.whitePoint !== undefined) { this._whitePoint = g.whitePoint; this._applyWhitePoint(); }
    if (g.tintWhite) { u.tintWhiteLo.value = g.tintWhite[0]; u.tintWhiteHi.value = g.tintWhite[1]; }
    if (g.lift !== undefined) u.lift.value = g.lift;
    if (g.punch !== undefined) u.punch.value = g.punch;
    if (g.saturation !== undefined) u.saturation.value = g.saturation;
    if (g.highlightDesat !== undefined) u.highlightDesat.value = g.highlightDesat;
    if (g.bleach !== undefined) u.bleach.value = g.bleach;
    if (g.bleachLo !== undefined) u.bleachLo.value = g.bleachLo;
    if (g.bleachHi !== undefined) u.bleachHi.value = g.bleachHi;
    if (g.shadowTint) u.shadowTint.value.set(g.shadowTint[0], g.shadowTint[1], g.shadowTint[2]);
    if (g.highlightTint) u.highlightTint.value.set(g.highlightTint[0], g.highlightTint[1], g.highlightTint[2]);
    if (g.vignette !== undefined) u.vignette.value = g.vignette;
    if (g.vignetteSoft !== undefined) u.vignetteSoft.value = g.vignetteSoft;
    if (g.vignetteHighlight !== undefined) u.vignetteHighlight.value = g.vignetteHighlight;
    if (g.bloom !== undefined) this.bloomPass.strength = g.bloom;
    if (g.bloomThreshold !== undefined) this._bloomThreshold = g.bloomThreshold;
    if (g.bloomKnee !== undefined) this._bloomKnee = g.bloomKnee;
    if (g.bloomRadius !== undefined) this.bloomPass.radius = g.bloomRadius;
    this._applyBloomThreshold();
    return this;
  }

  /**
   * Push the post-exposure threshold down into the pass, which works in raw scene linear.
   *
   * `smoothWidth` is a fraction of the threshold rather than an absolute, so the knee stays
   * the same *ratio* wide at every exposure. Without a knee the high-pass is a hard step and
   * anything hovering at the threshold — a flickering torch, an orc walking through a light
   * pool — pops its whole bloom halo on and off between frames.
   *
   * Measured proof that dividing by exposure is the right coupling and not just the tidy
   * one: Frostwatch (exposure 1.05) is bright in linear — 10.5% of its pixels clear 0.12 —
   * and gets a 0.38 threshold. The Black Throne (exposure 2.09) is dark in linear, only 1.2%
   * over 0.12, and gets 0.19. Two levels three quarters of a stop apart, and both end up
   * feeding the bloom pass the same ~0.5% of the frame. A fixed threshold cannot do that.
   */
  _applyBloomThreshold() {
    const t = this._bloomThreshold / Math.max(0.05, this.u.exposure.value);
    this.bloomPass.threshold = t;
    const sw = this.bloomPass.highPassUniforms?.smoothWidth;
    if (sw) sw.value = t * this._bloomKnee;
  }

  /**
   * `whitePoint` is authored in post-exposure radiance ("an explosion core at 7 is white"),
   * but the knee that has to land on 1.0 lives after ACES and the sRGB encode. Convert once,
   * on the CPU, through a scalar mirror of the shader's own curve.
   *
   * Not divided by exposure, unlike `bloomThreshold`: the shader applies exposure before
   * this point in the chain, so a post-exposure number is already the right one, and the
   * white point deliberately does *not* follow a per-level exposure trim. A level graded a
   * third of a stop darker should have less of its frame clipping, not the same amount.
   */
  _applyWhitePoint() {
    this.u.white.value = toDisplay(this._whitePoint ?? 0);
  }

  get exposure() { return this.u.exposure.value; }
  set exposure(v) { this.u.exposure.value = v; this._applyBloomThreshold(); }

  /**
   * 'high' full chain + MSAA, 'medium' drops MSAA, 'low' drops bloom too, 'off' bypasses
   * the composer entirely so Engine falls back to a plain renderer.render — the escape
   * hatch for a machine that simply cannot afford any of it.
   *
   * 2 samples, not 4: measured at 1600x900 with 220 orcs, 4x cost ~2.8ms of a 16.6ms frame
   * for edges this art style barely has. 2x keeps most of the benefit for about half that.
   */
  setQuality(q) {
    if (q === this.quality) return;
    this.quality = q;
    this.bloomPass.enabled = q === 'high' || q === 'medium';
    const samples = q === 'high' ? 2 : 0;
    // renderTarget2 is a clone of renderTarget1, so both need it or every other frame aliases.
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples === samples) continue;
      rt.samples = samples;
      rt.dispose(); // forces reallocation with the new sample count on next bind
    }
  }

  get enabled() { return this.quality !== 'off'; }

  setSize(w, h, pixelRatio) {
    if (w <= 0 || h <= 0) return;
    this._w = w; this._h = h; this._pr = pixelRatio;
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(w, h);
    // Bloom at half resolution, after the composer has sized it to full. Its mip chain is
    // the most expensive thing in the chain and a soft glow has no detail to lose; halving
    // the input makes it ~4x cheaper and is indistinguishable at this radius.
    this.bloomPass.setSize(Math.max(1, w * pixelRatio * 0.5), Math.max(1, h * pixelRatio * 0.5));
    // Vignette must be measured in screen space, not UV space, or it turns into an oval.
    const a = w / h;
    this.u.aspect.value.set(a > 1 ? a : 1, a > 1 ? 1 : 1 / a);
    this.u.texel.value.set(1 / (w * pixelRatio), 1 / (h * pixelRatio));
  }

  render(dt) {
    this.composer.render(dt);
    // A shader that fails to link renders nothing, and since the grade pass is what draws
    // to the screen, "nothing" means a black game. Cheaper to notice on frame one and turn
    // the whole chain off than to ship a black screen: a broken grade costs the grade.
    if (this._checks < 3) {
      this._checks++;
      const bad = this._brokenProgram();
      if (bad) {
        console.warn(`[PostFX] "${bad}" failed to link; disabling post-processing.`);
        this.setQuality('off');
      }
    }
  }

  /** Name of the first of our own programs that failed to link, or null. */
  _brokenProgram() {
    const gl = this.renderer.getContext();
    for (const p of this.renderer.info.programs || []) {
      if (!p.name || !p.name.startsWith('PostFX.')) continue;
      if (!gl.getProgramParameter(p.program, gl.LINK_STATUS)) return p.name;
    }
    return null;
  }

  dispose() {
    this.composer.dispose?.();
    this._rt.dispose();
  }
}

/** Tuned against the level palettes in `world/LevelDefs.js` at the rig's default framing. */
export const DEFAULT_GRADE = {
  exposure: 1.35,
  // Only a nudge. A bigger warm push looks great on the stone levels and turns the Forge
  // (whose key *and* fill are both orange) into a single flat red.
  balance: [1.02, 1.0, 0.95],
  // Pivot low and contrast gently. Nearly every pixel in a torch-lit dungeon is a midtone,
  // so the black point matters more than the slope: at pivot 0.34 / contrast 1.3 everything
  // below sRGB 0.074 clipped to solid black and the corridors disappeared.
  contrast: 1.16,
  pivot: 0.30,
  // Where the contrast line bends onto (1,1) instead of clipping there; post-ACES sRGB.
  // The join is C1 continuous, so this is really a *rate* control — just above the knee the
  // curve is second-order identical to the straight line, and it only diverges far up. Swept
  // 0.46-0.70 on levels 2, 3 and 9: mean luma moves by under 0.6 across that whole range
  // while the share of the frame at 250+ nearly doubles, so it is very close to a pure
  // highlight-structure knob. 0.48 lands blown-to-hot at ~0.40 (it was 0.75 when the curve
  // clipped), which is a highlight that rolls off rather than one that hits a wall.
  shoulder: 0.48,
  /**
   * Post-exposure radiance that grades to exactly 255,255,255. See the header.
   *
   * 9.0 was swept, not guessed. The emissive ladder in scene linear is: light pools and pit
   * floors 0.36-0.65, the additive glow mesh (flames, crystals, the rift) 1.10-1.43,
   * bloom-fed emissive cores 3.3-4.1, and an explosion core — three overlapping
   * full-brightness spark shells plus its own bloom — well past 6. At the campaign exposure
   * (x1.35) that puts the glow family at 1.5-1.9 and an explosion core past 8.
   *
   * Swept 6 -> 15 on levels 1, 5 and 10, measuring pure white (r=g=b=255) on a build-phase
   * frame against a Boom Barrel detonation frame:
   *
   *      wp        6       7       8       9      10      12      15
   *      quiet   .026    .017    .007    .000    .000    .000    .000     (L1, worst case)
   *      boom    .947    .948    .865    .891    .853    .718    .654
   *
   * 9.0 is the knee of the quiet column: the first value at which *nothing in the ambience*
   * — no torch, no brazier, no rift, no pit floor, on any level — reaches white, while the
   * detonation column barely moves. That is the distinction the whole change is for. It
   * should be events that clip, not the room.
   *
   * The measured curve either side of it: post-exposure 2.7 -> 250, 5.4 -> 253, 9.0+ -> 255.
   * The top decade keeps the range round 3 won for it *and* terminates on white, instead of
   * asymptoting one code short of it.
   */
  whitePoint: 9.0,
  /**
   * Luma band over which the split-tone below fades back to neutral. Nothing clips to a
   * hue; a sensor with all three channels saturated reads white. Below 0.86 luma the tint
   * is untouched, which is every fire, every torch and every lit wall in the game — a
   * saturated orange at full red is only ~0.6 luma and never enters this band at all.
   */
  tintWhite: [0.86, 0.99],
  lift: 0.012,                    // keeps the deepest shadows off pure black so shapes read
  punch: 0.12,                    // extra S-curve on top of the linear contrast
  saturation: 1.28,
  highlightDesat: 0.42,
  // Scene-referred highlight bleach — see the header. Re-derived (round 3) off an HDR
  // readback of the composer's own buffer rather than off estimates: the emissive families
  // WORLD authors are, in scene linear max-channel, ambient bounce 0.011-0.031, light pools
  // and pit floors 0.36-0.65, the additive glow mesh (flames, crystals, rift) 1.10-1.43 with
  // bloom-fed cores reaching 3.3-4.1.
  //
  // `Lo` was 0.50 post-exposure, which is 0.37 scene linear at the campaign exposure — under
  // the *foot* of the glow family, so the whole flame quad was 30-70% desaturated and the
  // fire had no orange left anywhere but its outermost pixel. At 1.00 it sits above the pit
  // floors and below the glow peak on every level, so the flame body keeps its hue and only
  // the bloom-fed core goes white.
  bleach: 0.9,
  bleachLo: 1.00,
  bleachHi: 3.20,
  shadowTint: [0.74, 0.89, 1.26], // cool blue shadows...
  highlightTint: [1.10, 1.02, 0.88], // ...against warm highlights. The OMD separation.
  vignette: 0.52,
  vignetteSoft: 0.66,
  vignetteHighlight: 1.0,   // 0 = classic flat multiply, 1 = clipped highlights ignore it
  // 0.75, up from 0.55. With the threshold where it now is, strength is the one knob that
  // trades hot pixels against veiling glare, and it is close to linear in both: 1.1 put a
  // typical level at 0.6-0.75% hot but also added 12 points of mean luma, which is the WORLD
  // owner's budget, not mine. 0.75 lands the campaign at ~0.6% hot on a lit frame, which is
  // OMD's own average, with the brightest levels near 1.2% and the darkest near 0.3%.
  bloom: 0.75,
  // Post-exposure, so 0.40 is ~0.30 in scene linear at the campaign default. Chosen off a
  // histogram of the composer's own HDR buffer, in the same 0.299/0.587/0.114 luma the
  // high-pass uses. That histogram has an unmistakable knee: on level 5, 14.8% of pixels
  // clear 0.12, 2.5% clear 0.18, and then it goes flat — 0.58% at 0.32 and still 0.48% at
  // 0.50. Everything below the knee is lit geometry; everything above it is an emissive.
  // Sitting at 0.30 puts the threshold in the flat part with 2x margin below and lets the
  // knee absorb a re-light, instead of tracking any one level's palette.
  //
  // The old 1.2 was *above* an unlit white emissive, which writes exactly 1.0, and above a
  // saturated orange flame twice over — a torch at linear (1.0, 0.33, 0.05) has a bloom luma
  // of 0.50. The pass was switched off for everything but the rift and the molten pit floor.
  bloomThreshold: 0.40,
  bloomKnee: 0.7,     // smoothWidth as a fraction of the threshold: knee runs 0.30 -> 0.50
  // `radius` in UnrealBloomPass re-weights the mip chain — at 0.7 the widest (1/32-res) mip
  // dominates and the rift paints a flat pink haze over the whole frame instead of a glow
  // around itself, so this still has a ceiling.
  //
  // 0.45, up from 0.20. Round 2 measured 0.5 as costing 4 points of mean luma and *losing*
  // hot pixels, and rejected it on that basis. Both halves of that measurement were an
  // artefact of the clipped transfer curve: with everything above 0.8 linear pinned to byte
  // 255, spreading energy outward could only move pixels off the ceiling. Re-measured
  // against the shoulder, radius is very nearly free — L1 at strength 0.75 reads mean luma
  // 47.45 at 0.20 and 47.50 at 0.50, while hot falls 0.78% -> 0.61% and blown 0.37% -> 0.27%.
  // Same energy, spread over a halo with falloff instead of piled onto a core that clips:
  // a smaller white centre and a wider, softer glow, which is the read we were missing.
  //
  // Strength is *not* the knob to cut here, and this is why it stayed at 0.75: it is the one
  // that trades hot pixels against mean luma nearly one-for-one (0.75 -> 0.60 costs 4.2 luma
  // on L1), and mean luma is WORLD's budget, not mine.
  bloomRadius: 0.45,
};

/**
 * Scalar mirror of the shader's `aces()` + `srgbOetf()`, for turning a radiance into the
 * display-referred value the knee works in.
 *
 * Exact for a neutral input, which is the only kind this is ever asked about: both ACES
 * matrices have row sums of 1.0 (0.59719 + 0.35458 + 0.04823 = 1, and so on for all six
 * rows), so a grey passes through them unchanged and only the RRT/ODT rational fit applies.
 * Anything bright enough to be near the white point has already been pulled ~90% of the way
 * to neutral by the bleach.
 *
 * Returns 1.0 for radiances at or above ACES' own saturation point (25.67 in its working
 * space, ~15.4 of scene linear), which is the "no white point" case.
 */
export function toDisplay(radiance) {
  const v = Math.max(0, radiance) / 0.6;
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.4329510) + 0.238081;
  const t = Math.min(1, Math.max(0, a / b));
  // 0.41666, not 1/2.4, so this agrees with the shader's own OETF to the last bit.
  return t <= 0.0031308 ? t * 12.92 : 1.055 * Math.pow(t, 0.41666) - 0.055;
}

const GradeShader = {
  name: 'GradeShader',
  uniforms: {
    tDiffuse: { value: null },
    exposure: { value: 1.15 },
    balance: { value: new THREE.Vector3(1, 1, 1) },
    contrast: { value: 1.2 },
    pivot: { value: 0.36 },
    shoulder: { value: 0.55 },
    white: { value: 1.0 },
    tintWhiteLo: { value: 0.86 },
    tintWhiteHi: { value: 0.99 },
    lift: { value: 0.01 },
    punch: { value: 0.2 },
    saturation: { value: 1.18 },
    highlightDesat: { value: 0.55 },
    bleach: { value: 0.0 },
    bleachLo: { value: 0.5 },
    bleachHi: { value: 2.5 },
    shadowTint: { value: new THREE.Vector3(1, 1, 1) },
    highlightTint: { value: new THREE.Vector3(1, 1, 1) },
    vignette: { value: 0.4 },
    vignetteSoft: { value: 0.6 },
    vignetteHighlight: { value: 1.0 },
    aspect: { value: new THREE.Vector2(1, 1) },
    texel: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    precision highp float;
    uniform mat4 modelViewMatrix;
    uniform mat4 projectionMatrix;
    attribute vec3 position;
    attribute vec2 uv;
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */`
    precision highp float;

    uniform sampler2D tDiffuse;
    uniform float exposure, contrast, pivot, lift, punch, saturation, highlightDesat, vignette, vignetteSoft;
    uniform float bleach, bleachLo, bleachHi, vignetteHighlight, shoulder;
    uniform float white, tintWhiteLo, tintWhiteHi;
    uniform vec3 balance, shadowTint, highlightTint;
    uniform vec2 aspect, texel;
    varying vec2 vUv;

    const vec3 LUMA = vec3( 0.2126, 0.7152, 0.0722 );

    // Same ACES fit three.js uses, so switching post-processing off is a brightness change,
    // not a completely different image.
    vec3 rrtOdt( vec3 v ) {
      vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
      vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
      return a / b;
    }
    vec3 aces( vec3 c ) {
      const mat3 IN = mat3( 0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777 );
      const mat3 OUT = mat3( 1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602 );
      c *= 1.0 / 0.6;
      c = IN * c;
      c = rrtOdt( c );
      c = OUT * c;
      return clamp( c, 0.0, 1.0 );
    }

    vec3 srgbOetf( vec3 c ) {
      return mix( c * 12.92, 1.055 * pow( max( c, vec3( 0.0 ) ), vec3( 0.41666 ) ) - 0.055, step( 0.0031308, c ) );
    }

    void main() {
      vec3 c = texture2D( tDiffuse, vUv ).rgb;

      // --- scene-referred ----------------------------------------------------
      c = max( c, vec3( 0.0 ) ) * exposure * balance;

      // Highlight bleach. A saturated emissive can never reach 240 luma on its own — 72% of
      // luma is green, so a torch at (1.0, 0.33, 0.05) tops out at 224 — and the harder you
      // drive it the more saturated it gets, not the whiter. Pull the dim channels up toward
      // the bright one as radiance climbs and the core blows out to white while the falloff
      // stays orange, which is the whole reason an OMD frame reads as lit rather than tinted.
      // Applied here, on radiance, so no amount of contrast or saturation downstream can
      // undo it and no midtone is ever affected.
      float m = max( c.r, max( c.g, c.b ) );
      c = mix( c, vec3( m ), bleach * smoothstep( bleachLo, bleachHi, m ) );

      c = aces( c );

      // --- display-referred: grading is far more predictable after the encode --
      c = srgbOetf( c );

      // Contrast about a low pivot, with an endpoint-preserving highlight knee.
      //
      // The straight line (c - pivot) * contrast + pivot + lift reaches 1.0 at c = 0.893,
      // and ACES puts scene-linear 0.8 (at the campaign exposure) at exactly 0.900. So the
      // old clamp was not a safety net, it was the operator: *every* value from 0.8 linear
      // to infinity graded to byte 255. The entire emissive family — torch and brazier
      // flames, crystals, the rift, all of which peak at 1.10-1.43 linear — landed on one
      // code with no range between them, which is why a torch rendered as a flat white disc
      // in the shape of its own quad instead of a fire with a falloff.
      //
      // Above the shoulder the line is bent onto (W, 1) by a quadratic that leaves the knee
      // at slope contrast, so nothing below it moves by even one code (verified: linear 0.05 /
      // 0.1 / 0.2 grade bit-identical to before) and the top decade gets its range back.
      //
      // W is the white point (uniform 'white'), and it is the round-4 correction: with W = 1
      // the knee only reaches 1.0 where the *post-ACES* value does, which needs ~15 units of
      // scene-linear radiance — more than anything in this game emits — so the curve always
      // stopped one code short of white. Terminating it at a reachable radiance instead
      // leaves the join and everything below it untouched and lets an explosion core clip.
      // Measured post-exposure -> byte at W = display(7.0): 1.35 -> 242, 2.7 -> 250,
      // 5.4 -> 254, 7.0 and up -> 255.
      float W = max( white, shoulder + 0.02 );
      vec3 line = ( c - pivot ) * contrast + pivot + lift;
      float yK = ( shoulder - pivot ) * contrast + pivot + lift;
      // Clamped to 2 because that is the largest start slope a quadratic can have and still
      // land on (W,1) monotonically; past it the knee would fold back on itself.
      float ka = clamp( contrast * ( W - shoulder ) / max( 1.0e-4, 1.0 - yK ), 0.0, 2.0 );
      vec3 u = clamp( ( c - shoulder ) / max( 1.0e-4, W - shoulder ), 0.0, 1.0 );
      vec3 knee = yK + ( 1.0 - yK ) * ( ka * u + ( 1.0 - ka ) * u * u );
      c = clamp( mix( line, knee, step( vec3( shoulder ), c ) ), 0.0, 1.0 );

      c = mix( c, smoothstep( vec3( 0.0 ), vec3( 1.0 ), c ), punch );

      float l = dot( c, LUMA );
      // Roll saturation off in the highlights. Without it a single-hue level (the Forge is
      // lit orange by both key *and* fill) saturates to flat red and the orcs standing in
      // it lose their silhouette entirely; with it, hot areas bleach toward white and the
      // green of an orc still reads against them.
      // Keyed on the *max channel*, not on luma: a clipped-red fire pixel has luma 0.88 and
      // so never engaged the roll-off, which meant the one place this was written to protect
      // was the one place it did nothing.
      float hi = max( c.r, max( c.g, c.b ) );
      float sat = mix( saturation, saturation * highlightDesat, smoothstep( 0.55, 1.0, hi ) );
      c = mix( vec3( l ), c, sat );

      // Split-tone, rolled back to neutral at the very top. highlightTint.b is 0.88, so
      // before this line a pixel that graded to 1.0 came out (1.0, 1.0, 0.88) and the game
      // had a hard luma ceiling of 252.8 with *zero* pure-white pixels in any frame — and
      // highlightTint.r of 1.10 clamped red from c = 0.909 up, which crushed the whole top
      // decade into what was left. Keyed on luma, so only near-white pixels neutralise: a
      // saturated orange flame sits around 0.6 luma with its red channel already at 1.0 and
      // never enters the band, which is why the fires keep their hue.
      float toWhite = smoothstep( tintWhiteLo, tintWhiteHi, l );
      c *= mix( mix( shadowTint, highlightTint, smoothstep( 0.15, 0.85, l ) ), vec3( 1.0 ), toWhite );

      // --- vignette ----------------------------------------------------------
      // Highlights punch through it. A flat multiply is what a lens does, but it was also
      // quietly the single biggest destroyer of hot pixels in the frame: at 0.52 a torch
      // two thirds of the way to the edge lost 12% of its value and a 252 core graded out
      // at 223, so whether a level had any blown-out pixels at all came down to whether its
      // rift happened to sit near frame centre. Exempting the top end keeps the dark corners
      // that make the arena feel enclosed while letting a fire at the edge still read as fire.
      vec2 d = ( vUv - 0.5 ) * aspect * 2.0;
      float r = length( d ) * vignetteSoft;
      float vig = 1.0 - vignette * clamp( r * r, 0.0, 1.0 );
      float vhot = smoothstep( 0.72, 0.99, max( c.r, max( c.g, c.b ) ) );
      c *= mix( vig, 1.0, vignetteHighlight * vhot );

      // Ordered dither. The fog gradients here are long and near-black; without this they
      // band into visible rings on 8-bit output.
      //
      // Faded out at the top, which is not cosmetic: half a code of noise on a pixel sitting
      // at exactly 1.0 can only ever push it *down*, so a clean white core came out as a
      // 50/50 speckle of 255 and 254 and the pure-white count halved for nothing. There is
      // no banding to hide up there — it is one value — so the dither has no work to do.
      float n = fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
      c += ( n - 0.5 ) * ( 1.0 / 255.0 ) * ( 1.0 - smoothstep( 0.965, 0.999, max( c.r, max( c.g, c.b ) ) ) );

      gl_FragColor = vec4( clamp( c, 0.0, 1.0 ), 1.0 );
    }`,
};
