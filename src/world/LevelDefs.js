import { makeMap } from './MapPaint.js';

/**
 * The 10-level campaign. Each level escalates on three independent axes so the
 * difficulty curve never feels like "same fight, bigger numbers":
 *
 *   1. Geometry   — one lane -> branching lanes -> multi-floor -> open arena
 *   2. Roster     — which orc abilities are in play (armour, flight, disarm, shields)
 *   3. Pressure   — wave size, spawn concurrency, and the coin you get to answer it
 *
 * `waves[i].groups` is a list of { id, count, delay, interval, spawn } where `spawn`
 * indexes into the level's spawn markers (or 'all' / 'random').
 */

/* ==========================================================================
 * THE CAMPAIGN TONE CONTRACT
 * ==========================================================================
 *
 * Every palette below is authored as *mood*. The contract's job is to make sure the ten
 * moods form a deliberate ladder instead of ten unrelated guesses — not to flatten them.
 *
 * ### What this fixed the first time, and must keep fixing
 *
 * `sky`/`ground` used to be picked by eye per level, so the hemisphere ambient swung 4x
 * across the campaign while `bakeStrength` swung the *same* way instead of compensating.
 * The two knobs compounded: eight levels crushed to a mean screen luma in the twenties
 * with up to 27% of the frame at pure black and saturation pushed to 0.93 to fake the
 * missing contrast. `tone()` re-maps every colour a palette hands the rig onto a shared
 * luminance ladder, preserving hue and rolling chroma off if it would clip. That
 * mechanism is right and stays.
 *
 * ### What it got wrong, and what changed here
 *
 * The ladder had **one rung**. Every level was driven to the same mean (46-55), measured
 * across-campaign stdev **2.7**, and the campaign read as one room repainted ten times.
 * Orcs Must Die's own levels run **30.8 to 112.9 mean luma, across-campaign stdev 23.6**:
 * a snowfield is genuinely bright and a basalt throne room is genuinely dark, and that
 * difference is most of what makes ten levels feel like ten places.
 *
 * So the ladder now has ten rungs. Each palette declares an `exposure` — one scalar, the
 * level's place on the campaign's brightness ladder — and the contract still owns
 * *everything else*: hue caps, the shape of the response, the black point, the relation
 * between ambient, albedo and key. A palette may be brighter or darker than its
 * neighbours; it still may not author its own tone response.
 *
 * `exposure` is applied with a *different gamma per quantity*, because the five things it
 * moves are not the same kind of quantity at all:
 *
 *   - **the hemisphere ambient** (sky/ground) moves 1:1. This is the light level in the room.
 *   - **albedo** (floor/wall stone) moves at `albedoGamma`. Snow really is a brighter
 *     material than basalt, but a dark level's stone must not go to literal black or the
 *     texture detail dies with it.
 *   - **the key and fill colours** barely move at all (`keyGamma`). A sun is a sun. Making
 *     a dark level's key dim as well as its ambient is how you get a flat dark level
 *     rather than a dramatic one — the dungeons are *key-dominant*, which is the whole
 *     reason they can be dark and still readable.
 *   - **emitters** (torches, pits, portals, the rift) move at `glowGamma`, i.e. hardly.
 *     A torch in a black crypt and a torch in a courtyard put out the same fire; that gap
 *     *is* the drama on the dark rungs.
 *   - **fog and the sky bounce** are the black-point guard and move deliberately *against*
 *     exposure (`fogGamma`, `bounceGamma`). Without them a real brightness ladder puts the
 *     bottom three rungs straight back into crushed black — measured 12-33% of the frame
 *     at pure black on the first attempt, which is the exact failure this contract exists
 *     to prevent. It does not get back in through the exposure door.
 *
 * ### The second thing it got wrong: one hue per level
 *
 * Measured hue spread — the fraction of the frame sitting more than 60 degrees off the
 * frame's own dominant hue — was **0.005 to 0.053** against OMD's **0.297**. Eight of ten
 * levels had over 80% of the frame in a single hue family with under 4% in the opposing
 * one. A level lit by one hue at one brightness has nowhere to put contrast.
 *
 * The fix has three parts and all three were needed; any one alone moved the number by
 * almost nothing.
 *
 *   1. **Polarity, authored in the palettes: the ambient and the key must disagree.**
 *      Every level now runs a cool ambient against warm fire, or a cool key against warm
 *      sconces — never a warm room lit by warm light and fogged in warm haze, which is what
 *      the Forge and the Gatehouse both were.
 *   2. **A chroma hierarchy, not five independent caps.** The two sources that touch every
 *      pixel (hemisphere, fog) are held well under the directional lights, which are held
 *      under the emitters. See the note on the caps below. A key capped at 0.16 saturation
 *      is a white light, and a white key cannot oppose anything.
 *   3. **Albedo must not repeat the ambient.** Blue snow under a blue sky, and violet
 *      basalt under a violet sky, are the same mistake: the level's hue gets counted twice
 *      and there is nothing left for the fire to contrast against. The snowfields and the
 *      throne rooms both now use near-neutral stone and take their colour from the light.
 *      This was worth more than 1 and 2 combined on levels 7 and 8.
 *
 * And a fourth thing that is not about colour at all: `poolMul()` in Level.js. A
 * multiplicative torch bake *cannot* change which hue wins on a surface, only how bright it
 * is, so every torch pool in the campaign was a pale patch rather than a warm one. See the
 * long note there.
 *
 * Targets: across-campaign mean-luma stdev **15-25** with levels ordered by authored mood,
 * pure black under 2% on every level, mean saturation inside 0.31-0.67, hue spread as
 * high as the arena will carry. Retune by editing TONE, not by editing a palette.
 */
export const TONE = {
  // --- ambient ladder (sRGB byte luma, 0-255), at exposure 1.0 ---------------
  // These are the campaign *mid-point*, not the campaign value. A level's own rung is
  // this times its `exposure`.
  skyLuma: 82,       // hemisphere up: the play floor and every wall cap
  groundLuma: 84,    // hemisphere down: bounce onto undersides and wall sides
  fogLuma: 42,       // what the far half of the frame fades into; sets the black floor
  // The key came down from 236, and that is a *chroma* decision, not a brightness one.
  // `atLuma` cannot deliver both a high target luminance and real saturation: to reach 236
  // it has to pull the colour toward the grey of the same luminance, so on the bright rungs
  // the key came out white and a white key cannot oppose anything. At 216 there is room
  // under the clip for the sun to actually be gold.
  sunLuma: 216,      // key
  fillLuma: 142,     // counter-light
  // --- chroma ceilings ------------------------------------------------------
  // (max-min)/max on the source colour. These were roughly half these values, which is
  // what made every level monochrome: with the key at 0.16 and the sky at 0.30, the two
  // largest light sources in the frame were both effectively white, so nothing in the
  // room could disagree with anything else. Ambient chroma is still capped *below* the
  // emitters' — it multiplies every surface at once — but it is no longer capped away.
  // Read these as a *hierarchy*, not five independent numbers, because the ordering is
  // the thing that decides whether a level is monochrome.
  //
  // The hemisphere and the fog are the two sources that touch every pixel in the frame,
  // so their chroma is a tint applied to the whole image — it cannot create contrast, it
  // can only destroy it. Held at 0.46 they were what kept Sundered Halls and the Black
  // Throne measuring 0.75 cool / 0.02 warm with saturation at 0.79: not a dark level with
  // firelight in it, a violet level. They are now well under the emitters.
  //
  // The key and the fill are *directional*, so their chroma buys a lit side and a shadow
  // side rather than a cast over everything, and they are allowed more of it. And the
  // emitters (torch 0.66) are allowed the most, because a torch pool is the one coloured
  // thing in the frame that occupies a bounded, readable region.
  skySat: 0.28, groundSat: 0.40, fogSat: 0.36, sunSat: 0.50, fillSat: 0.62,
  // --- exposure response ----------------------------------------------------
  // See the block comment. `exposureBand` is the hard clamp on what a palette may ask for.
  exposureBand: [0.40, 2.40],
  albedoGamma: 0.40,   // stone albedo tracks exposure this much
  keyGamma: 0.08,      // the key and fill barely move: a sun is a sun
  glowGamma: 0.30,     // emitters read as emitters at every exposure
  // Fog is the *black floor* of the frame — it is what the far half fades into — so it
  // deliberately does not follow exposure all the way down. Left at gamma 1.0, the bottom
  // three rungs measured 12-33% of the frame at pure black, which is the exact failure the
  // first version of this contract was written to kill. It is not allowed back in through
  // the exposure door.
  fogGamma: 0.68,
  // The sky-coloured bounce term (floor emissive, dressing emissive, wall-cap emissive)
  // is the other half of that guard, and it is held near *constant in absolute terms*
  // across the campaign: `bounceGain` is the reciprocal of most of the exposure move, so a
  // dark level is dark in its mid-tones without any face in it reaching zero.
  bounceGamma: -0.80, bounceGainBand: [0.72, 2.60],
  // --- lighting scalars, one campaign value + the band a level may move inside
  hemi: 1.02, hemiBand: 0.10,
  sunPower: 2.05, sunBand: 0.30,
  // The fill gets a *wide* band on purpose, and it is the one scalar that does.
  // The key-to-fill ratio is the level's, because that ratio is *direction*, not exposure —
  // it is the difference between a hall with a sun in it and a hall with a light box in it.
  fillPower: 0.80, fillBand: 0.40,
  // Widened. The bake is now the campaign's main hue-contrast tool rather than a warmth
  // garnish, and the levels that need it hardest are the dark ones, where the sconces are
  // the only light with a colour in it.
  bake: 0.96, bakeBand: 0.26,
  fogDensity: 0.0090, fogDensityBand: 0.0032,
  // --- material ladder ------------------------------------------------------
  floorALuma: 112, floorBLuma: 68, wallALuma: 94, wallBLuma: 58, stoneSat: 0.46,
  accentLuma: 150, accentSat: 0.46,
  torchLuma: 200, torchSat: 0.66,
  glowLuma: 178, glowSat: 0.52,
  // Pits and portals are the two things that used to escape the contract entirely: they
  // are unlit additive surfaces, so they sit *above* the tone curve and go straight into
  // the bloom threshold. Held here, they read as light sources instead of as exposure.
  pitLuma: 130, pitSat: 0.52,
  pitPower: 0.50, pitPowerBand: 0.12,
  // --- the rift -------------------------------------------------------------
  // The last emissive surface outside the contract, and the one a blind critic ranked as
  // the single worst element in the game: an additive stack whose planes summed to a
  // translucent screen-space veil that fogged and *desaturated* everything behind it.
  // Held here it is a light source with a colour, like every other emitter.
  riftLuma: 186, riftSat: 0.60,
  riftPower: 1.0, riftPowerBand: 0.35,
  // How hard a torch pool may take over the surface it falls on. See `poolMul()` in
  // Level.js — this is the number that lets a warm pool sit on a cool floor and still
  // read warm, which a purely multiplicative bake can never do.
  poolGain: 2.75,
};

// --- contract plumbing -------------------------------------------------------
const _rgb = (h) => (typeof h === 'number'
  ? [(h >> 16) & 255, (h >> 8) & 255, h & 255]
  : [(parseInt(String(h).replace('#', ''), 16) >> 16) & 255,
     (parseInt(String(h).replace('#', ''), 16) >> 8) & 255,
      parseInt(String(h).replace('#', ''), 16) & 255]);
const _q = (v) => Math.max(0, Math.min(255, Math.round(v)));
const _hex = (r, g, b, asString) => (asString
  ? '#' + [r, g, b].map((v) => _q(v).toString(16).padStart(2, '0')).join('')
  : (_q(r) << 16) | (_q(g) << 8) | _q(b));

/**
 * Re-map a colour onto a target luminance, keeping its hue.
 *
 * Chroma is capped first (so a 0.85-saturated forge orange cannot paint the whole level
 * one hue), then the triple is scaled to hit the target luma. If scaling would clip a
 * channel past 255 the colour is pulled toward the grey of the same luminance and the
 * scale retried — that is what lets a near-white ice sky and a near-black basalt sky land
 * on exactly the same brightness without either of them turning into the other's hue.
 */
function atLuma(hex, targetIn, satCap = 1) {
  const asString = typeof hex !== 'number';
  const target = Math.max(2, Math.min(248, targetIn));
  let [r, g, b] = _rgb(hex);
  const lum = () => 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const mx = Math.max(r, g, b);
  if (mx > 0) {
    const s = (mx - Math.min(r, g, b)) / mx;
    if (s > satCap) { const k = satCap / s; r = mx - (mx - r) * k; g = mx - (mx - g) * k; b = mx - (mx - b) * k; }
  }
  for (let i = 0; i < 10; i++) {
    const L = lum() || 1;
    const k = target / L;
    r *= k; g *= k; b *= k;
    if (Math.max(r, g, b) <= 255) break;
    const L2 = lum();
    r += (L2 - r) * 0.34; g += (L2 - g) * 0.34; b += (L2 - b) * 0.34;
  }
  return _hex(r, g, b, asString);
}

const _band = (v, mid, half, fallback) => {
  const x = v === undefined || v === null ? (fallback ?? mid) : v;
  return Math.max(mid - half, Math.min(mid + half, x));
};

/**
 * Apply the contract to one authored palette. Pure: never mutates its input.
 *
 * `pal.exposure` is the level's rung on the campaign brightness ladder — 1.0 is the
 * campaign mid-point, Frostwatch is near 2, the Black Throne near 0.5. It rides the three
 * gammas described in the block comment above so that a dark level comes out dark *and
 * key-dominant* rather than dark and flat.
 */
export function tone(pal) {
  const T = TONE;
  const p = { ...pal };
  const [eLo, eHi] = T.exposureBand;
  const E = Math.max(eLo, Math.min(eHi, pal.exposure ?? 1));
  p.exposure = E;
  const eAlb = Math.pow(E, T.albedoGamma);
  const eKey = Math.pow(E, T.keyGamma);
  const eGlow = Math.pow(E, T.glowGamma);
  const [bLo, bHi] = T.bounceGainBand;
  p.bounceGain = Math.max(bLo, Math.min(bHi, Math.pow(E, T.bounceGamma)));

  p.sky = atLuma(pal.sky ?? 0x5a6a8c, T.skyLuma * E, T.skySat);
  p.ground = atLuma(pal.ground ?? 0x2a1f18, T.groundLuma * E, T.groundSat);
  p.fog = atLuma(pal.fog ?? 0x0a0b12, T.fogLuma * Math.pow(E, T.fogGamma), T.fogSat);
  p.sun = atLuma(pal.sun ?? 0xffe6c0, T.sunLuma * eKey, T.sunSat);
  p.fill = atLuma(pal.fill ?? 0x4a6fa8, T.fillLuma * eKey, T.fillSat);

  p.hemi = _band(pal.hemi, T.hemi, T.hemiBand);
  p.sunPower = _band(pal.sunPower, T.sunPower, T.sunBand);
  p.fillPower = _band(pal.fillPower, T.fillPower, T.fillBand);
  p.bakeStrength = _band(pal.bakeStrength, T.bake, T.bakeBand);
  p.fogDensity = _band(pal.fogDensity, T.fogDensity, T.fogDensityBand);
  p.poolGain = T.poolGain;

  p.floorA = atLuma(pal.floorA, T.floorALuma * eAlb, T.stoneSat);
  p.floorB = atLuma(pal.floorB, T.floorBLuma * eAlb, T.stoneSat);
  p.wallA = atLuma(pal.wallA, T.wallALuma * eAlb, T.stoneSat);
  p.wallB = atLuma(pal.wallB, T.wallBLuma * eAlb, T.stoneSat);
  p.floorAccent = atLuma(pal.floorAccent, T.accentLuma * eAlb, T.accentSat);
  p.wallAccent = atLuma(pal.wallAccent, T.accentLuma * eAlb, T.accentSat);

  // Emitters barely track exposure: a torch in a bright courtyard and a torch in a black
  // crypt put out the same light. That gap *is* the drama on the dark levels — it is what
  // makes a sconce on level 10 a pool of fire and a sconce on level 7 a warm detail.
  p.torch = atLuma(pal.torch, T.torchLuma * eGlow, T.torchSat);
  p.riftGlow = atLuma(pal.riftGlow, T.glowLuma * eGlow, T.glowSat);
  p.spawnGlow = atLuma(pal.spawnGlow, T.glowLuma * eGlow, T.glowSat);
  p.pitGlow = atLuma(pal.pitGlow, T.pitLuma * eGlow, T.pitSat);
  p.pitPower = _band(pal.pitPower, T.pitPower, T.pitPowerBand);

  // The rift's own ladder. `riftGlow` above is the *hue* every rift surface quotes; these
  // two are what stop the additive stack from becoming an exposure problem.
  p.riftColor = atLuma(pal.riftGlow, T.riftLuma * eGlow, T.riftSat);
  p.riftPower = _band(pal.riftPower, T.riftPower, T.riftPowerBand);
  return p;
}

/**
 * Five places, not five tints.
 *
 * `theme` is the important field: Textures.js and Decor.js switch on it to change the
 * *material* (mossy slabs vs scorched brick vs frozen-over flagstones), the prop set
 * (anvils vs cages vs icicles vs skull piles) and the dressing density. The colour
 * fields then dress that structure. Lighting knobs still appear here, but they are now
 * *requests*: `tone()` clamps each one into the campaign band before it reaches the rig.
 * A palette says where it sits on the brightness ladder with one number — `exposure` —
 * and everything else about its tone response is the contract's.
 *
 * The one rule that is not negotiable is **polarity**: a level's ambient and its key must
 * not be the same hue family. Read down the `sky`/`fill` column and then the `sun`/`torch`
 * column; if they ever agree, that level will measure monochrome no matter what its
 * materials do.
 */
const PALETTES = {
  /**
   * The Gatehouse. A bright afternoon, and the campaign's second-brightest rung.
   *
   * The polarity change: the sky is now *blue*. It was 0xb8a288 — a warm tan skylight over
   * warm sandstone lit by a warm sun and fogged in warm haze, which measured 81% of the
   * frame in one hue family with 0.6% opposing it. Daylight is a warm key against a cool
   * skydome; making the hemisphere do what a real sky does splits the frame into sunlit
   * warm stone and blue-shadowed stone without touching a single material.
   */
  keep:   { theme: 'keep', exposure: 1.35,
            sky: 0x7ea6dc, ground: 0x9a7048, sun: 0xffd08a, fill: 0x6f9ad8, fog: 0x2c3a4a,
            hemi: 0.96, sunPower: 2.20, fillPower: 0.46, bakeStrength: 0.72,
            // Warm sandstone, not grey. The Gatehouse was the one level measuring *under*
            // the campaign's saturation floor, because its stone was authored a near-neutral
            // #7a736a and the contract only ever caps chroma, never invents it.
            // Warmed again in round 3. The Gatehouse still sits closest to the saturation
            // floor of any level, and a brighter, more neutral ambient eats chroma: the
            // stone has to carry more of its own to keep the margin.
            floorA: '#947d52', floorB: '#5f5034', floorAccent: '#b09460',
            wallA: '#a08659', wallB: '#615132', wallAccent: '#c8a24a',
            banner: '#8c2230', bannerTrim: '#d8b45a',
            pitGlow: 0x3a2c18, pitPower: 0.49, fogDensity: 0.0085,
            torch: 0xff9b3d, riftGlow: 0x53d0ff, spawnGlow: 0xff4a22 },

  /**
   * The dungeon. A dark rung, and deliberately *key-dominant* rather than dim: the ambient
   * comes down with exposure, the sun does not, so the shafts of light that reach the
   * stairs are the brightest thing in the level and the amber sconces own everything else.
   */
  dungeon:{ theme: 'dungeon', exposure: 0.77,
            sky: 0x5a72b4, ground: 0x342f44, sun: 0xa8c0f0, fill: 0x4a6ec0, fog: 0x0a0d1e,
            hemi: 0.96, sunPower: 2.10, fillPower: 0.58, bakeStrength: 0.92,
            floorA: '#5f5a6c', floorB: '#37333f', floorAccent: '#53703a',
            wallA: '#635a70', wallB: '#3b3546', wallAccent: '#76d0ff',
            banner: '#3f2c5a', bannerTrim: '#8fa6c8',
            pitGlow: 0x2fa88c, pitPower: 0.73, fogDensity: 0.0105,
            torch: 0xffa32a, riftGlow: 0x7affd0, spawnGlow: 0xb03bff },

  /**
   * The Forge. **The worst monochrome offender in the campaign** — 87% of the frame warm,
   * 0.1% cool, hue spread 0.005 — and it got that way honestly: warm sky over warm stone
   * lit by a warm sun through warm fog with orange lava under it. Every channel agreed.
   *
   * A forge does not actually look like that. What makes a forge read *hot* is the cold
   * blue-steel ambient it sits in — daylight down the vent shafts, the blue of quenched
   * iron — against which the fire is the only warm thing in the room. So the ambient goes
   * cold and the fires stay exactly as hot as they were. Nothing about the level's
   * materials changed; the fire simply has something to be hotter than now.
   */
  forge:  { theme: 'forge', exposure: 1.12,
            sky: 0x5c7ba8, ground: 0x6a3c18, sun: 0x9fbde8, fill: 0x4a78d8, fog: 0x141d2a,
            hemi: 1.10, sunPower: 2.30, fillPower: 0.86, bakeStrength: 1.00,
            floorA: '#8f6a4e', floorB: '#4e3226', floorAccent: '#ff7a26',
            wallA: '#9c6f4a', wallB: '#573426', wallAccent: '#ff8a2a',
            banner: '#9a2410', bannerTrim: '#e8a83c',
            pitGlow: 0xff7a1a, pitPower: 0.98, fogDensity: 0.0110,
            torch: 0xff6a14, riftGlow: 0xffc255, spawnGlow: 0xff3510 },

  /**
   * Frostwatch. **The brightest place in the campaign, and now allowed to be.**
   *
   * Its earlier problem was a white sky at hemi 1.19 with a fill at 0.70, leaving nothing
   * for the key to do. The answer then was to drag it down to the campaign mean, which was
   * the wrong lever: a snowfield's brightness is not an exposure error, it is the level.
   * It gets a high `exposure` and keeps spending its allowance on *direction* — key at the
   * top of the band, fill at the bottom, low raking winter sun.
   *
   * The sun is now a warm gold rather than the near-white 0xfff2dc it was. A low winter
   * sun is the warmest light in the game and snow is the best surface there is for showing
   * it: sunlit snow goes amber, shadowed snow goes hard blue, and that split is where a
   * white level gets its colour contrast from.
   */
  ice:    { theme: 'ice', exposure: 1.72,
            sky: 0x9cc6f4, ground: 0x5d7a96, sun: 0xffcf8a, fill: 0x7ab0e8, fog: 0x5c7d9e,
            sunDir: [42, 34, 28],
            hemi: 0.92, sunPower: 2.35, fillPower: 0.58, bakeStrength: 1.20,
            // Snow is a near-neutral material. Authoring it blue was double-counting the
            // sky: the ambient already tints it, so a blue albedo under a blue ambient left
            // *sunlit* snow reading as blue as shadowed snow and the level measured 83% cool
            // against 1.4% warm. Held near neutral, the chroma comes from the lighting —
            // gold where the raking sun lands, hard blue where it does not.
            floorA: '#bcbdb8', floorB: '#7e858a', floorAccent: '#e8f2ff',
            wallA: '#c0c1bd', wallB: '#7b858e', wallAccent: '#d8f0ff',
            banner: '#2f5f8f', bannerTrim: '#cfe6f8',
            pitGlow: 0x6fd8ff, pitPower: 0.63, fogDensity: 0.0090,
            torch: 0xff9c30, riftGlow: 0x2fc8ff, spawnGlow: 0x8f3aff },

  /** Sundered Halls. Cold violet ambient, warm gold sconces — 150 degrees apart. */
  throne: { theme: 'throne', exposure: 1.06,
            sky: 0x6a5aa8, ground: 0x3a2038, sun: 0xc0b0ff, fill: 0x5a8ae0, fog: 0x140a24,
            hemi: 0.94, sunPower: 1.90, fillPower: 0.44, bakeStrength: 1.02,
            // Near-neutral basalt, not violet basalt. Levels 9 and 10 were the last two
            // measuring monochrome (hue spread 0.038 / 0.027, saturation 0.60 / 0.75) and
            // the cause was the same double-count the snowfields had: violet stone lit by a
            // violet ambient and glazed in violet fog, so every channel agreed everywhere.
            // The ambient still carries the violet; the stone no longer repeats it, which
            // leaves the gold sconces somewhere to be gold.
            floorA: '#6a6168', floorB: '#3b3539', floorAccent: '#c04ae0',
            wallA: '#746a70', wallB: '#403a3e', wallAccent: '#ff7ad0',
            banner: '#6a1038', bannerTrim: '#d8b45a',
            pitGlow: 0xc04ae0, pitPower: 0.42, fogDensity: 0.0092,
            torch: 0xffa022, riftGlow: 0x62f0ff, spawnGlow: 0xff2a80 },
};

/**
 * Second-pass variants. Two levels share a theme's *materials* but never its *weather*:
 * the gatehouse is a bright afternoon and Twin Approach is the same keep at night; the
 * forge gets hotter as you descend; Frostwatch is a clear day and the Warcamp is a
 * whiteout. This is what stops levels 1-10 reading as one map with a hue slider.
 */
const variant = (base, over) => ({ ...base, ...over });

const KEEP_DAY = PALETTES.keep;
/**
 * Twin Approach: the same keep after dark, and the campaign's first real drop in exposure.
 * Moonlight is a cold key; the sconces are the only warm light on the map and the bake is
 * pushed hard so they own the ground they fall on rather than tinting it.
 */
const KEEP_NIGHT = variant(PALETTES.keep, {
  exposure: 0.84,
  sky: 0x4460a8, ground: 0x3a3450, sun: 0xa8c4ff, fill: 0x3f5c94, fog: 0x0b1020,
  hemi: 0.94, sunPower: 1.80, fillPower: 0.52, bakeStrength: 0.98, fogDensity: 0.0068,
  torch: 0xff9a2e,
});
const DUNGEON = PALETTES.dungeon;
/**
 * Chasm Bridge. **The one level that had to be re-authored for hue, not for exposure.**
 *
 * It measured 0.69 mean saturation against a 0.31–0.67 band — the campaign's only
 * out-of-band level — and the tone contract could not fix it, because the contract only
 * ever *caps* chroma and this level's problem was that it had no second hue to cap
 * against. Every emitter in it was the same teal: floor accent, wall accent, torches,
 * rift glow, the chasm glow itself, and a cyan sun and teal fill lighting all of them.
 * Per-pixel saturation is `(max-min)/max`, so lighting a teal surface with a teal light
 * and glazing it with teal fog compounds instead of cancelling; every channel agreed and
 * nothing pulled the frame back toward neutral.
 *
 * The fix is four hues on screen at once, arranged so the *pit* keeps the signature:
 *
 *   - the chasm stays teal and is now the only teal thing — it reads as the hazard again
 *   - **fire is fire**: amber sconces, the complementary of the pit, and the one emitter
 *     that touches most of the play floor, so it is what actually pulls the mean back
 *   - the rift goes cold blue-white, distinct from the chasm it hangs over
 *   - spawn gates keep their violet, and the floor accent goes to a warm bronze so the
 *     bridge deck is masonry rather than more glow
 *
 * Ambient follows: a blue-grey sun and a blue (not teal) fill, so the light in the room
 * disagrees with the light in the pit.
 */
const DUNGEON_DEEP = variant(PALETTES.dungeon, {
  // The darkest rung short of the finale. Nothing but the chasm, the sconces and the rift.
  exposure: 0.72,
  sky: 0x3f5ea8, ground: 0x2c3444, sun: 0xc8d4e0, fill: 0x3f6cb4, fog: 0x060a14,
  hemi: 0.96, sunPower: 1.85, fillPower: 0.66, bakeStrength: 1.00,
  floorA: '#5e5a66', floorB: '#37343c',
  floorAccent: '#a8834a', wallAccent: '#5fe0c0',
  banner: '#7a2a1c', bannerTrim: '#d8b45a',
  pitGlow: 0x39e8b0, pitPower: 0.84, fogDensity: 0.0105,
  torch: 0xffa02e, riftGlow: 0xbcd8ff, spawnGlow: 0x9a3bff,
});
const FORGE = PALETTES.forge;
const FORGE_DEEP = variant(PALETTES.forge, {
  // Deeper, so less daylight down the shafts and more fire — darker room, hotter fires.
  exposure: 0.99,
  sky: 0x4e6c98, ground: 0x6a3410, sun: 0x9ab6e0, fill: 0x3a6ad0, fog: 0x101828,
  hemi: 1.08, sunPower: 2.20, fillPower: 0.84, bakeStrength: 1.02,
  floorA: '#9a6a48', floorB: '#553122',
  pitGlow: 0xff9a1a, pitPower: 1.03, fogDensity: 0.0125,
  torch: 0xff5410, spawnGlow: 0xff2400,
});
const ICE_CLEAR = PALETTES.ice;
const ICE_STORM = variant(PALETTES.ice, {
  // The brightest place in the campaign. A whiteout is not an exposure fault; it is the
  // level, and driving it to the campaign mean is what made levels 7 and 8 the same place.
  exposure: 1.86,
  sky: 0xbcdcf8, ground: 0x74909f, sun: 0xffc880, fill: 0x9fcaf0, fog: 0x93aec4,
  // A whiteout still needs a sun behind it, just a softer one than the clear day.
  sunDir: [36, 36, 32],
  hemi: 0.92, sunPower: 2.30, fillPower: 0.86, bakeStrength: 1.18,
  floorA: '#adb8c2', floorB: '#76828c', fogDensity: 0.0118,
  torch: 0xff9c2a, spawnGlow: 0x7f4aff,
});
const THRONE = PALETTES.throne;
/**
 * Level 10 gets its own palette, not a variant. The Black Throne must not look like
 * Sundered Halls with the lights turned down: black basalt, witchfire green torches,
 * arterial-red gates, and a cold white rift — four separate hues on screen at once, so
 * the finale reads as the loudest place in the campaign.
 */
const BLACK_THRONE = variant(PALETTES.throne, {
  // The darkest rung in the campaign, and the bottom of the ladder by design: you arrive
  // here from a whiteout four levels earlier, and the drop is the point.
  exposure: 0.88,
  sky: 0x4258a0, ground: 0x2e1a34, sun: 0x9fb8e8, fill: 0x38a0d0, fog: 0x070a16,
  hemi: 0.92, sunPower: 1.90, fillPower: 0.44, bakeStrength: 1.02,
  floorA: '#5a5458', floorB: '#2e2a2c', floorAccent: '#7ef0a0',
  wallA: '#615a5e', wallB: '#332e31', wallAccent: '#7ef0a0',
  banner: '#12100f', bannerTrim: '#c8a24a',
  pitGlow: 0x7ef0a0, pitPower: 0.42, fogDensity: 0.0092,
  torch: 0x6cf090, riftGlow: 0xbfe8ff, spawnGlow: 0xff2a12,
});
// Wave composition lives in src/director/campaign.js (ARCHITECTURE §2 — DIRECTOR owns it).
// A copy used to live here and silently diverged; dbg.validate() now fails if one returns.

export const LEVELS = [
  // ---------------------------------------------------------------- 1
  {
    name: 'The Gatehouse',
    subtitle: 'One road in. Hold it.',
    palette: KEEP_DAY,
    width: 26, height: 18,
    riftHp: 20, startCoin: 2700,
    camera: { distance: 52, yaw: 0 },
    unlocks: ['spike-floor', 'arrow-wall'],
    brief: 'A single corridor. Learn the loop: place traps, hold the line, kill what leaks.',
    // One road in — but it forks at the well and rejoins at the gate, so even the
    // tutorial map asks "which of the two lanes do I make expensive?".
    map: makeMap(26, 18, [
      ['room', 2, 2, 7, 6],                 // gate yard
      ['hall', 6, 4, 19, 4, 3],             // upper road
      ['vhall', 12, 4, 12, 11, 3],          // the fork, south
      ['hall', 12, 11, 19, 11, 3],          // lower road
      ['vhall', 19, 4, 19, 11, 3],          // the two roads rejoin here
      ['room', 8, 6, 10, 8],                // side cellar off the upper road
      ['room', 15, 1, 17, 2],               // murder-hole alcove above the road
      ['room', 15, 9, 23, 15],              // rift hall
      ['block', 16, 12, 17, 12], ['block', 21, 12, 22, 12],
      ['choke', 19, 8, 19, 8],
      ['spawn', 4, 4],
      ['rift', 19, 13],
      ['nobuild', 2, 2, 7, 6],
    ]),
    playerSpawn: [19, 14],
  },

  // ---------------------------------------------------------------- 2
  {
    name: 'Twin Approach',
    subtitle: 'Two doors, one you.',
    palette: KEEP_NIGHT,
    width: 30, height: 22,
    riftHp: 20, startCoin: 3380,
    camera: { distance: 56, yaw: 0 },
    unlocks: ['tar-pit', 'boom-barrel'],
    brief: 'Two lanes converge. You cannot stand in both — let the traps hold one.',
    /**
     * Twin Approach is the campaign's hot-pixel outlier — 0.88% of the frame above 240
     * luma against ~0.6% for its neighbours — and it was reported as torch density in the
     * night keep. Thinning the sconces here is right on its own terms (this is the
     * wall-densest keep map, so the recipe's flat 0.55 roll hangs more fire per square
     * metre of floor than anywhere else) and it does take the number down.
     *
     * But it is not where the heat is, and the measurement should be on the record.
     * Occluding one object at a time and re-counting the hot pixels on levels 1-5, the
     * split on this level is **rift 0.65pp, torches 0.15pp** of a 0.81pp total, and the
     * torch share here is *not* an outlier — level 3 burns more (0.18pp) at a higher
     * sconce density and measures cooler overall. Every level in the campaign is
     * rift-dominated in the same way; this one's rift is simply 1.6x hotter than level
     * 1's for the same geometry, the same toned `riftGlow` and the same camera distance.
     *
     * **Resolved.** The rift's additive stack was the last emissive surface outside the
     * tone contract, and it is inside it now (`riftLuma`/`riftSat`/`riftPower` above, and
     * the long note in Rift.js on why the fix was area rather than alpha). Measured on this
     * level, the stack's screen footprint went from 7.95% of the frame to 2.09% and its
     * contribution to mean luma from 1.82 to 0.34, while the peak stayed above 40 — it is a
     * light source now rather than an exposure. The sconce thinning here stands on its own
     * terms and stays.
     */
    torchDensity: 0.60,
    // Each gate has two ways down: the direct road over the top, or the long flank round
    // the outside. Four route combinations, one of you.
    map: makeMap(30, 22, [
      ['room', 2, 2, 7, 6], ['room', 22, 2, 27, 6],
      ['hall', 6, 4, 15, 4, 3], ['hall', 23, 4, 15, 4, 3],
      ['vhall', 15, 4, 15, 10, 3],
      ['room', 8, 9, 21, 16],               // muster hall
      ['pillars', 10, 11, 19, 14, 4, 3],
      ['vhall', 4, 6, 4, 12, 3], ['hall', 4, 12, 9, 12, 3],
      ['vhall', 25, 6, 25, 12, 3], ['hall', 25, 12, 20, 12, 3],
      ['vhall', 15, 16, 15, 19, 3],
      ['room', 11, 17, 19, 20],             // rift chamber
      ['choke', 15, 8, 15, 8],
      ['spawn', 4, 4], ['spawn', 25, 4],
      ['rift', 15, 19],
      ['nobuild', 2, 2, 7, 6], ['nobuild', 22, 2, 27, 6],
    ]),
    playerSpawn: [15, 18],
  },

  // ---------------------------------------------------------------- 3
  {
    name: 'The Long Descent',
    subtitle: 'Armour comes down the stairs.',
    palette: DUNGEON,
    width: 32, height: 24,
    riftHp: 18, startCoin: 4060,
    camera: { distance: 58, yaw: 0 },
    unlocks: ['arrow-wall', 'ceiling-pounder'],
    brief: 'Armoured orcs shrug off arrows. Crushing damage does not care about plate.',
    // A switchback staircase: four legs, three hairpins. Two shortcut shafts let the
    // horde skip a leg, so the "safe" hairpin is only safe if you pay for the shortcut too.
    map: makeMap(32, 24, [
      ['room', 2, 2, 7, 6],
      ['hall', 6, 4, 27, 4, 3],             // leg 1, east
      ['vhall', 27, 4, 27, 9, 3],
      ['hall', 27, 9, 5, 9, 3],             // leg 2, west
      ['vhall', 5, 9, 5, 14, 3],
      ['hall', 5, 14, 26, 14, 3],           // leg 3, east
      ['vhall', 26, 14, 26, 19, 3],
      ['hall', 26, 19, 9, 19, 3],           // leg 4, west
      ['vhall', 20, 4, 20, 9, 3],           // shortcut: leg 1 -> leg 2
      ['vhall', 11, 9, 11, 14, 3],          // shortcut: leg 2 -> leg 3
      ['room', 5, 16, 14, 22],              // undercroft / rift hall
      ['pillars', 7, 17, 12, 21, 4, 3],
      ['room', 22, 6, 25, 7],               // gallery alcove over leg 1
      ['choke', 27, 6, 27, 7], ['choke', 5, 11, 5, 12],
      ['spawn', 4, 4],
      ['rift', 9, 20],
      ['nobuild', 2, 2, 7, 6],
    ]),
    playerSpawn: [11, 20],
  },

  // ---------------------------------------------------------------- 4
  {
    name: 'Chasm Bridge',
    subtitle: 'Mind the gap. They will not.',
    palette: DUNGEON_DEEP,
    width: 34, height: 24,
    riftHp: 18, startCoin: 4740,
    camera: { distance: 60, yaw: 0 },
    unlocks: ['spring-trap', 'wall-blades'],
    brief: 'Pits flank the road. Springs turn a gap into a grave — if you aim them right.',
    // Four pits carve the great hall into a cross of catwalks. Every crossing is a
    // chokepoint and a spring trap turns any of them into a grave.
    map: makeMap(34, 24, [
      ['room', 2, 3, 7, 9],
      ['hall', 6, 6, 13, 6, 5],
      ['room', 10, 3, 25, 15],              // chasm hall
      ['pit', 12, 4, 15, 8], ['pit', 18, 4, 21, 8],
      ['pit', 12, 11, 15, 14], ['pit', 18, 11, 21, 14],
      ['hall', 25, 6, 30, 6, 3],
      ['vhall', 30, 6, 30, 18, 3],
      ['vhall', 11, 15, 11, 20, 3],
      ['hall', 11, 20, 26, 20, 3],
      ['room', 24, 15, 32, 21],             // rift terrace
      ['pillars', 26, 16, 31, 20, 4, 4],
      ['choke', 17, 9, 17, 10], ['choke', 23, 6, 24, 6],
      ['spawn', 4, 6],
      ['rift', 28, 18],
      ['nobuild', 2, 3, 7, 9],
    ]),
    playerSpawn: [28, 20],
  },

  // ---------------------------------------------------------------- 5
  {
    name: 'The Forge',
    subtitle: 'Fire will not save you here.',
    palette: FORGE,
    width: 34, height: 26,
    riftHp: 20, startCoin: 5420,
    camera: { distance: 60, yaw: 0 },
    unlocks: ['brimstone', 'guardian-archer'],
    brief: 'Fire-immune orcs walk through brimstone laughing. Diversify or die.',
    // A working foundry: a hypostyle casting floor threaded with magma channels, two
    // outer flanks for the traffic that will not take the front door.
    map: makeMap(34, 26, [
      ['room', 2, 2, 8, 8], ['room', 25, 2, 31, 8],
      ['hall', 7, 5, 17, 5, 3], ['hall', 26, 5, 17, 5, 3],
      ['vhall', 17, 5, 17, 11, 5],
      ['room', 5, 10, 28, 19],              // casting floor
      ['pillars', 9, 12, 24, 17, 4, 3],
      ['pit', 12, 13, 13, 16], ['pit', 20, 13, 21, 16],
      ['vhall', 4, 8, 4, 15, 3], ['hall', 4, 15, 7, 15, 3],
      ['vhall', 29, 8, 29, 15, 3], ['hall', 29, 15, 26, 15, 3],
      ['vhall', 17, 19, 17, 23, 3],
      ['room', 12, 20, 22, 24],             // rift vault
      ['choke', 17, 9, 17, 10],
      ['spawn', 4, 4], ['spawn', 29, 4],
      ['rift', 17, 22],
      // DIRECTOR re-derived the curve and levels 5 and 7 are now the campaign's peak, not
      // 9 and 10. The layout lever that eases a level without touching its shape is where
      // the player is *allowed to build*: these spawn rooms were no-build in their
      // entirety, so the horde walked seven clear tiles before it met anything. Cut back
      // to a three-tile apron around the gate — still no camping the doorstep, but the
      // approach is now trappable, which is worth several seconds of trap uptime per wave.
      ['nobuild', 3, 3, 5, 5], ['nobuild', 28, 3, 30, 5],
    ]),
    playerSpawn: [17, 23],
  },

  // ---------------------------------------------------------------- 6
  {
    name: 'Sappers' + '’' + ' Run',
    subtitle: 'They came for your traps.',
    palette: FORGE_DEEP,
    width: 36, height: 26,
    riftHp: 20, startCoin: 6100,
    camera: { distance: 62, yaw: 0 },
    unlocks: ['grinder', 'guardian-paladin'],
    brief: 'Sappers disarm the first trap they touch. Layer your defences or lose them.',
    // One gate, but the great loop round the magazine gives four ways to the rift.
    // A sapper eats your first trap; here the horde can eat four different first traps.
    map: makeMap(36, 26, [
      ['room', 2, 11, 8, 17],
      ['hall', 7, 14, 14, 14, 5],
      ['ring', 11, 4, 27, 22, 4],           // the great loop
      ['pillars', 12, 6, 26, 20, 6, 6],
      ['room', 15, 12, 20, 14],             // magazine: a dead end hanging off the west leg
      ['hall', 27, 8, 32, 8, 3], ['hall', 27, 18, 32, 18, 3],
      ['vhall', 32, 8, 32, 18, 3],
      ['room', 28, 11, 34, 16],             // rift bay
      ['choke', 27, 8, 27, 8], ['choke', 27, 18, 27, 18],
      ['spawn', 4, 14],
      ['rift', 31, 14],
      ['nobuild', 2, 11, 8, 17],
    ]),
    playerSpawn: [31, 15],
  },

  // ---------------------------------------------------------------- 7
  {
    name: 'Frostwatch',
    torchDensity: 1.25,
    subtitle: 'The sky is not safe either.',
    palette: ICE_CLEAR,
    width: 36, height: 28,
    riftHp: 20, startCoin: 6780,
    camera: { distance: 62, yaw: 0 },
    unlocks: ['ice-vent'],
    brief: 'Gargoyles fly clean over your floor traps. Look up.',
    /**
     * A walled courtyard with only three doors. The gallery ring outside is where you
     * fight; the doors are where you decide the level.
     *
     * **The rift is in a bay off the courtyard, not standing in the middle of it.** That is
     * a gameplay fix, not a dressing one, and it is the difference between this level being
     * winnable and not. A gameplay critic found that the strategy which comfortably clears
     * levels 9 and 10 loses on 7 and 8, and correctly identified the cause as the shape of
     * the ground around the rift rather than anything about the waves: 9 and 10 have
     * alcove rifts that two or three barricades convert into a one-tile spine, while 7 and
     * 8 had rifts standing in open rooms with all four orthogonal neighbours walkable. Five
     * barricades bought on The Warcamp made that level *worse* — it lost a wave earlier —
     * because 29% of the purse bought a corridor there was then no money to stock.
     *
     * That means the level was deciding whether the barricade was worth buying, not the
     * player, and the barricade is the one object that lets a player author the path. So
     * the shrine is now recessed into the wall band south of the courtyard with a single
     * three-tile mouth. Three lanes still converge on it, but they converge on *one place*,
     * and two barricades there genuinely make a spine. The mouth is deliberately three wide
     * and not one: at one there is no decision left to make, and `_wouldSeal` would be the
     * only thing standing between the player and a sealed level.
     */
    map: makeMap(36, 28, [
      ['room', 2, 2, 8, 8], ['room', 27, 2, 33, 8], ['room', 2, 19, 8, 25],
      ['hall', 7, 5, 17, 5, 3], ['hall', 28, 5, 22, 5, 3], ['hall', 7, 22, 17, 22, 3],
      ['vhall', 17, 5, 17, 9, 3], ['vhall', 22, 5, 22, 9, 3],
      ['ring', 9, 8, 29, 23, 3],            // gallery
      ['pillars', 10, 9, 28, 22, 6, 6],
      ['room', 14, 13, 24, 18],             // inner courtyard
      ['room', 12, 15, 13, 16],             // west door
      ['room', 25, 15, 26, 16],             // east door
      ['room', 18, 11, 20, 12],             // north door
      // The shrine bay, cut south out of the courtyard's back wall. Its own back is sealed
      // against the gallery's south leg, which drops that leg from three tiles to two
      // across five cells — the ring is still a ring, and the bay is a genuine dead end.
      ['room', 18, 19, 20, 20],             // rift bay
      ['block', 17, 21, 21, 21],
      ['choke', 12, 15, 13, 16], ['choke', 25, 15, 26, 16], ['choke', 18, 11, 20, 12],
      ['choke', 18, 19, 20, 19],            // the bay mouth: where barricades are worth money
      ['spawn', 4, 4], ['spawn', 31, 4], ['spawn', 4, 22],
      ['rift', 19, 20],
      // DIRECTOR re-derived the curve and levels 5 and 7 are now the campaign's peak, not
      // 9 and 10. The layout lever that eases a level without touching its shape is where
      // the player is *allowed to build*: these spawn rooms were no-build in their
      // entirety, so the horde walked seven clear tiles before it met anything. Cut back
      // to a three-tile apron around the gate — still no camping the doorstep, but the
      // approach is now trappable, which is worth several seconds of trap uptime per wave.
      ['nobuild', 3, 3, 5, 5], ['nobuild', 30, 3, 32, 5], ['nobuild', 3, 21, 5, 23],
    ]),
    playerSpawn: [19, 18],
  },

  // ---------------------------------------------------------------- 8
  {
    name: 'The Warcamp',
    torchDensity: 1.25,
    subtitle: 'Shields up, ranks tight.',
    palette: ICE_STORM,
    width: 38, height: 28,
    riftHp: 20, startCoin: 12248,
    camera: { distance: 64, yaw: 0 },
    unlocks: ['lightning-rod', 'acid-sprayer'],
    brief: 'Shieldbearers block everything in front of them. Hit them from the side.',
    /**
     * Four camps at the corners feed a ring road; the great hall in the middle has one door
     * on each side. Shieldbearers funnel through those doors facing exactly one way.
     *
     * **The rift now sits in a shrine bay inside the great hall rather than in the open
     * middle of it** — see the long note on Frostwatch for why, which applies here harder.
     * This was the level where a hand-built five-barricade funnel measurably made things
     * *worse*: four doors into a twelve-by-eight hall meant no affordable number of
     * barricades ever converged the lanes, so the money was pure loss.
     *
     * The bay's two fins run the full depth of the hall, so the hall keeps its shape as a
     * fighting floor — a west aisle, an east aisle and a north and south band — and all
     * four doors still open into it facing one way, which is the whole point of the level's
     * shieldbearers. What changed is that every one of those four routes now ends at the
     * same three-tile mouth. That is the alcove property levels 9 and 10 already had.
     */
    map: makeMap(38, 28, [
      ['room', 2, 2, 8, 8], ['room', 29, 2, 35, 8], ['room', 2, 19, 8, 25], ['room', 29, 19, 35, 25],
      ['ring', 8, 6, 29, 21, 3],            // ring road
      ['pillars', 9, 7, 28, 20, 6, 6],
      ['room', 13, 10, 24, 17],             // great hall
      ['pillars', 15, 11, 22, 16, 4, 4],
      ['room', 11, 12, 12, 15],             // west door
      ['room', 25, 12, 26, 15],             // east door
      ['room', 16, 8, 21, 9],               // north door
      ['room', 16, 18, 21, 19],             // south door
      // The shrine bay. `room` first so it clears the hypostyle blocks that would otherwise
      // stand inside it, then the two fins and the back wall.
      ['room', 17, 11, 19, 14],
      ['block', 16, 11, 16, 15], ['block', 20, 11, 20, 15], ['block', 17, 15, 19, 15],
      ['choke', 11, 12, 12, 15], ['choke', 25, 12, 26, 15],
      ['choke', 17, 11, 19, 11],            // the bay mouth
      ['rift', 18, 13],
      ['spawn', 5, 5], ['spawn', 32, 5], ['spawn', 5, 22], ['spawn', 32, 22],
      ['nobuild', 2, 2, 8, 8], ['nobuild', 29, 2, 35, 8], ['nobuild', 2, 19, 8, 25], ['nobuild', 29, 19, 35, 25],
    ]),
    playerSpawn: [18, 14],
  },

  // ---------------------------------------------------------------- 9
  {
    name: 'Sundered Halls',
    torchDensity: 1.2,
    subtitle: 'Everything at once.',
    palette: THRONE,
    width: 40, height: 30,
    riftHp: 22, startCoin: 13431,
    camera: { distance: 66, yaw: 0 },
    unlocks: ['arcane-obelisk', 'guardian-hunter'],
    brief: 'Every ability in the roster is on the field. Layer everything you own.',
    // The great hall is a colonnade broken by four chasms; outside it, two side galleries
    // link the northern gates to the southern ones. Everything connects to everything.
    map: makeMap(40, 30, [
      ['room', 2, 2, 9, 8], ['room', 30, 2, 37, 8], ['room', 2, 21, 9, 27], ['room', 30, 21, 37, 27],
      ['hall', 8, 5, 20, 5, 3], ['hall', 31, 5, 20, 5, 3],
      ['hall', 8, 24, 20, 24, 3], ['hall', 31, 24, 20, 24, 3],
      ['vhall', 20, 5, 20, 10, 5], ['vhall', 20, 24, 20, 19, 5],
      ['room', 10, 9, 29, 20],              // great hall
      ['pillars', 16, 11, 24, 18, 4, 4],
      ['pit', 12, 11, 14, 14], ['pit', 25, 11, 27, 14],
      ['pit', 12, 16, 14, 19], ['pit', 25, 16, 27, 19],
      ['vhall', 5, 8, 5, 21, 3], ['hall', 5, 14, 10, 14, 3],
      ['vhall', 34, 8, 34, 21, 3], ['hall', 34, 15, 29, 15, 3],
      ['choke', 20, 9, 20, 10], ['choke', 20, 19, 20, 20],
      ['rift', 20, 15],
      ['spawn', 5, 5], ['spawn', 34, 5], ['spawn', 5, 24], ['spawn', 34, 24],
      ['nobuild', 2, 2, 9, 8], ['nobuild', 30, 2, 37, 8], ['nobuild', 2, 21, 9, 27], ['nobuild', 30, 21, 37, 27],
    ]),
    playerSpawn: [20, 18],
  },

  // ---------------------------------------------------------------- 10
  {
    name: 'The Black Throne',
    torchDensity: 1.2,
    subtitle: 'The Orc King comes for the rift.',
    palette: BLACK_THRONE,
    width: 42, height: 32,
    riftHp: 25, startCoin: 14615,
    camera: { distance: 68, yaw: 0 },
    unlocks: [],
    brief: 'Six gates. One rift. The Orc King calls the horde and it answers.',
    // Six gates open onto a processional gallery that rings the throne hall. Inside, a
    // moat of four chasms leaves a cross of causeways with the Black Throne at its heart —
    // every approach is a bridge, and there are four of them.
    map: makeMap(42, 32, [
      ['room', 2, 2, 9, 8], ['room', 32, 2, 39, 8],
      ['room', 2, 13, 8, 19], ['room', 33, 13, 39, 19],
      ['room', 2, 24, 9, 30], ['room', 32, 24, 39, 30],
      ['ring', 8, 5, 33, 27, 3],            // processional gallery
      ['pillars', 9, 6, 32, 26, 7, 7],
      ['room', 12, 9, 29, 23],              // throne hall
      ['pillars', 14, 10, 27, 22, 5, 6],
      ['pit', 15, 12, 18, 14], ['pit', 23, 12, 26, 14],
      ['pit', 15, 18, 18, 20], ['pit', 23, 18, 26, 20],
      ['room', 11, 14, 11, 18],             // west gate of the hall
      ['room', 30, 14, 30, 18],             // east gate
      ['room', 18, 8, 23, 8],               // north gate
      ['room', 18, 24, 23, 24],             // south gate
      ['choke', 11, 14, 11, 18], ['choke', 30, 14, 30, 18],
      ['choke', 18, 8, 23, 8], ['choke', 18, 24, 23, 24],
      ['rift', 20, 16],
      ['spawn', 5, 5], ['spawn', 36, 5], ['spawn', 4, 16], ['spawn', 37, 16], ['spawn', 5, 27], ['spawn', 36, 27],
      ['nobuild', 2, 2, 9, 8], ['nobuild', 32, 2, 39, 8],
      ['nobuild', 2, 13, 8, 19], ['nobuild', 33, 13, 39, 19],
      ['nobuild', 2, 24, 9, 30], ['nobuild', 32, 24, 39, 30],
    ]),
    playerSpawn: [20, 21],
  },
];

/**
 * Back-compat projection of the beats onto the old flat `groups` shape.
 *
 * `WaveDirector` reads `beats` and ignores this, but tooling still walks `wave.groups` —
 * `dbg.validate()` uses it to prove every enemy id a level references actually exists in
 * the roster, and losing that check would be a real regression: a typo in a beat table is
 * exactly the kind of thing that only shows up as a missing wave three levels in. Kept
 * non-enumerable so nothing can mistake it for authored data.
 */
// (The projection that used to live here is gone with the wave tables. `dbg.validate()`
// now reads beat streams directly from the authoritative source in src/director/.)

/**
 * Freeze the authored (mood) palettes and hand the rig the contracted ones.
 *
 * Kept as a re-runnable step rather than a one-shot at definition time so the whole
 * campaign's tone response can be retuned from a single object: edit `TONE`, call
 * `retone()`, reload the level, re-measure. Every level moves together or none does,
 * which is precisely the discipline that was missing.
 */
for (const L of LEVELS) L.rawPalette = L.rawPalette || L.palette;
export function retone() {
  for (const L of LEVELS) L.palette = tone(L.rawPalette);
  return LEVELS.length;
}
retone();

export const LEVEL_COUNT = LEVELS.length;
