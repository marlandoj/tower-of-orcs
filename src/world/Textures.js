import * as THREE from 'three';
import { makeRng } from '../shared/rng.js';

/**
 * Every surface in the game is drawn here, at load time, into a 2D canvas.
 * No external image files: the whole fortress ships as a few hundred lines of
 * canvas calls, which also means a palette swap genuinely changes the *material*
 * and not just a tint multiplier.
 *
 * Two rules keep this cheap and non-repetitive:
 *  1. Everything is cached by key — ten levels sharing a palette share one GPU texture.
 *  2. Floor and wall maps are 2x2 **atlases**: four hand-different variants in one
 *     texture. Level.js picks a quadrant per cell from a hash of (gx,gz), so a
 *     40x32 flagstone floor never shows the same tile twice in a row.
 */

const _cache = new Map();
function cached(key, make) {
  let t = _cache.get(key);
  if (!t) { t = make(); _cache.set(key, t); }
  return t;
}

function canvas(w, h = w) {
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  return { cv, g: cv.getContext('2d') };
}

function finish(cv, { srgb = true, repeat = true, aniso = 8 } = {}) {
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// --- colour helpers ---------------------------------------------------------
export function hexToRgb(h) {
  if (typeof h === 'number') return [(h >> 16) & 255, (h >> 8) & 255, h & 255];
  const n = parseInt(String(h).replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbStr = (c, a = 1) =>
  a >= 1 ? `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})` : `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
export const mixRgb = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
/** amt<0 darkens toward black, amt>0 lightens toward white. */
export function shade(h, amt) {
  return rgbStr(mixRgb(hexToRgb(h), amt < 0 ? [0, 0, 0] : [255, 255, 255], Math.abs(amt)));
}

/** Monochrome grain plus soft blotches — the cheapest cure for "flat colour". */
function grain(g, w, h, amount = 22, clumps = 0, rng = makeRng(7)) {
  const img = g.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = (rng() - 0.5) * amount;
    d[i] += v; d[i + 1] += v; d[i + 2] += v;
  }
  g.putImageData(img, 0, 0);
  for (let i = 0; i < clumps; i++) {
    const x = rng() * w, y = rng() * h, rad = 8 + rng() * (w * 0.12);
    const grd = g.createRadialGradient(x, y, 0, x, y, rad);
    const dark = rng() < 0.55;
    grd.addColorStop(0, dark ? 'rgba(0,0,0,0.20)' : 'rgba(255,255,255,0.11)');
    grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd;
    g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
}

/** A jagged polyline — used for every crack, vein and icicle edge in the game. */
function crack(g, x, y, len, ang, width, rng, branch = 2) {
  g.beginPath();
  g.moveTo(x, y);
  let cx = x, cy = y, a = ang;
  const steps = 6 + (rng() * 5) | 0;
  for (let i = 0; i < steps; i++) {
    a += (rng() - 0.5) * 0.9;
    cx += Math.cos(a) * (len / steps);
    cy += Math.sin(a) * (len / steps);
    g.lineTo(cx, cy);
  }
  g.lineWidth = width;
  g.stroke();
  if (branch > 0 && rng() < 0.7) {
    crack(g, x + (cx - x) * 0.5, y + (cy - y) * 0.5, len * 0.45, ang + (rng() - 0.5) * 2, width * 0.6, rng, branch - 1);
  }
}

// ---------------------------------------------------------------------------
// FLOOR — a 2x2 atlas of four flagstone variants.
// ---------------------------------------------------------------------------
export function floorAtlas(pal) {
  const key = `floor|${pal.theme}|${pal.floorA}|${pal.floorB}`;
  return cached(key, () => {
    const S = 512, Q = S / 2;
    const { cv, g } = canvas(S);
    const rng = makeRng(0xF100 + S);
    const A = hexToRgb(pal.floorA), B = hexToRgb(pal.floorB);
    const accent = hexToRgb(pal.floorAccent ?? pal.floorA);

    for (let q = 0; q < 4; q++) {
      const ox = (q % 2) * Q, oy = ((q / 2) | 0) * Q;
      g.save();
      g.beginPath(); g.rect(ox, oy, Q, Q); g.clip();
      g.translate(ox, oy);

      // Mortar bed.
      g.fillStyle = rgbStr(mixRgb(B, [0, 0, 0], 0.35));
      g.fillRect(0, 0, Q, Q);

      // Slabs: variant 0 is a tidy 2x2, 1 a running bond, 2 broken cobbles, 3 one big cracked slab.
      const layouts = [
        [[0, 0, 1, 1], [1, 0, 1, 1], [0, 1, 1, 1], [1, 1, 1, 1]],
        [[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1]],
        [[0, 0, 1, 1], [1, 0, 1, 2], [0, 1, 1, 1]],
        [[0, 0, 2, 2]],
      ][q];
      const u = Q / 2;
      for (const [sx, sy, sw, sh] of layouts) {
        const pad = 2.5 + rng() * 2;
        const t = rng() * 0.72;
        g.fillStyle = rgbStr(mixRgb(A, B, t));
        g.fillRect(sx * u + pad, sy * u + pad, sw * u - pad * 2, sh * u - pad * 2);
        // Bevel: a light top-left edge and a dark bottom-right sells depth at 52 degrees.
        g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 2;
        g.beginPath();
        g.moveTo(sx * u + pad, sy * u + sh * u - pad); g.lineTo(sx * u + pad, sy * u + pad);
        g.lineTo(sx * u + sw * u - pad, sy * u + pad); g.stroke();
        g.strokeStyle = 'rgba(0,0,0,0.28)';
        g.beginPath();
        g.moveTo(sx * u + sw * u - pad, sy * u + pad); g.lineTo(sx * u + sw * u - pad, sy * u + sh * u - pad);
        g.lineTo(sx * u + pad, sy * u + sh * u - pad); g.stroke();
      }

      // Wear: cracks on every variant, heaviest on the big slab.
      g.strokeStyle = 'rgba(0,0,0,0.42)';
      const nCracks = q === 3 ? 4 : 2;
      for (let i = 0; i < nCracks; i++) crack(g, rng() * Q, rng() * Q, Q * 0.55, rng() * 6.283, 1.6, rng);

      // Theme dressing on the floor itself, so the *material* changes with the palette.
      if (pal.theme === 'dungeon') {
        // Moss creeping out of the mortar.
        g.fillStyle = rgbStr(accent, 0.30);
        for (let i = 0; i < 26; i++) {
          const x = rng() * Q, y = rng() * Q, r = 3 + rng() * 9;
          g.beginPath(); g.ellipse(x, y, r, r * 0.6, rng() * 3, 0, 6.283); g.fill();
        }
      } else if (pal.theme === 'forge') {
        // Soot around the cracks and a few glowing cinders in them.
        g.strokeStyle = 'rgba(20,8,4,0.5)';
        for (let i = 0; i < 3; i++) crack(g, rng() * Q, rng() * Q, Q * 0.5, rng() * 6.283, 4, rng, 0);
        g.strokeStyle = rgbStr(accent, 0.55);
        for (let i = 0; i < 2; i++) crack(g, rng() * Q, rng() * Q, Q * 0.35, rng() * 6.283, 1.4, rng, 0);
      } else if (pal.theme === 'ice') {
        // Frost bloom + hairline fractures reading as a frozen-over floor.
        g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 1;
        for (let i = 0; i < 6; i++) crack(g, rng() * Q, rng() * Q, Q * 0.4, rng() * 6.283, 1, rng, 1);
        g.fillStyle = 'rgba(230,245,255,0.16)';
        for (let i = 0; i < 10; i++) {
          const x = rng() * Q, y = rng() * Q, r = 8 + rng() * 22;
          g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
        }
      } else if (pal.theme === 'throne') {
        // Polished obsidian: bright specular streaks and a bleeding vein of arcane light.
        g.strokeStyle = rgbStr(accent, 0.30); g.lineWidth = 2;
        for (let i = 0; i < 2; i++) crack(g, rng() * Q, rng() * Q, Q * 0.6, rng() * 6.283, 2, rng, 1);
        g.fillStyle = 'rgba(255,255,255,0.045)';
        for (let i = 0; i < 5; i++) g.fillRect(rng() * Q, rng() * Q, Q * 0.5, 2);
      } else {
        // keep: scuffed boot traffic down the middle.
        g.fillStyle = 'rgba(0,0,0,0.10)';
        for (let i = 0; i < 8; i++) {
          const x = rng() * Q, y = rng() * Q, r = 10 + rng() * 26;
          g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
        }
      }
      g.restore();
    }
    grain(g, S, S, 20, 26, makeRng(3));
    return finish(cv, { repeat: false, aniso: 16 });
  });
}

// ---------------------------------------------------------------------------
// WALL — 2x2 atlas of four masonry variants, all sharing a course height so
// neighbouring cells line up.
// ---------------------------------------------------------------------------
export function wallAtlas(pal) {
  const key = `wall|${pal.theme}|${pal.wallA}|${pal.wallB}`;
  return cached(key, () => {
    const S = 512, Q = S / 2;
    const { cv, g } = canvas(S);
    const rng = makeRng(0xBA51C);
    const A = hexToRgb(pal.wallA), B = hexToRgb(pal.wallB);
    const accent = hexToRgb(pal.wallAccent ?? pal.torch ?? pal.wallA);

    for (let q = 0; q < 4; q++) {
      const ox = (q % 2) * Q, oy = ((q / 2) | 0) * Q;
      g.save();
      g.beginPath(); g.rect(ox, oy, Q, Q); g.clip();
      g.translate(ox, oy);

      g.fillStyle = rgbStr(mixRgb(B, [0, 0, 0], 0.45));
      g.fillRect(0, 0, Q, Q);

      const rows = 5, bh = Q / rows;
      for (let r = 0; r < rows; r++) {
        const off = ((r + q) % 2) * (Q / 6);
        for (let c = -1; c < 4; c++) {
          const bw = Q / 3 * (1 + (rng() - 0.5) * 0.18);
          const x = c * (Q / 3) + off + 2, y = r * bh + 2;
          g.fillStyle = rgbStr(mixRgb(A, B, rng() * 0.8));
          g.fillRect(x, y, bw - 4, bh - 4);
          g.strokeStyle = 'rgba(255,255,255,0.09)'; g.lineWidth = 2;
          g.beginPath(); g.moveTo(x, y + bh - 4); g.lineTo(x, y); g.lineTo(x + bw - 4, y); g.stroke();
          g.strokeStyle = 'rgba(0,0,0,0.34)';
          g.beginPath(); g.moveTo(x + bw - 4, y); g.lineTo(x + bw - 4, y + bh - 4); g.lineTo(x, y + bh - 4); g.stroke();
        }
      }

      // Damage: variant 3 is a battered wall with a hole punched through the courses.
      g.strokeStyle = 'rgba(0,0,0,0.45)';
      for (let i = 0; i < (q === 3 ? 4 : 1); i++) crack(g, rng() * Q, rng() * Q, Q * 0.5, rng() * 6.283, 2, rng);

      if (pal.theme === 'dungeon') {
        g.fillStyle = rgbStr(accent, 0.22);
        for (let i = 0; i < 20; i++) {
          const x = rng() * Q, y = rng() * Q;
          g.beginPath(); g.ellipse(x, y, 4 + rng() * 12, 3 + rng() * 6, 0, 0, 6.283); g.fill();
        }
        // Damp streaks running down from the mortar.
        g.fillStyle = 'rgba(0,0,0,0.16)';
        for (let i = 0; i < 6; i++) g.fillRect(rng() * Q, 0, 3 + rng() * 6, Q);
      } else if (pal.theme === 'forge') {
        // Heat scorching climbing the wall + glowing seams.
        const grd = g.createLinearGradient(0, Q, 0, 0);
        grd.addColorStop(0, 'rgba(30,10,4,0.55)'); grd.addColorStop(1, 'rgba(30,10,4,0)');
        g.fillStyle = grd; g.fillRect(0, 0, Q, Q);
        g.strokeStyle = rgbStr(accent, 0.42); g.lineWidth = 1.5;
        for (let i = 0; i < 2; i++) crack(g, rng() * Q, rng() * Q, Q * 0.4, rng() * 6.283, 1.5, rng, 0);
      } else if (pal.theme === 'ice') {
        // Rime collecting on the upward-facing edge of every course.
        g.fillStyle = 'rgba(226,244,255,0.30)';
        for (let r = 0; r <= rows; r++) g.fillRect(0, r * bh - 3, Q, 3 + rng() * 3);
        g.fillStyle = 'rgba(200,232,255,0.14)';
        for (let i = 0; i < 12; i++) g.fillRect(rng() * Q, 0, 2 + rng() * 5, rng() * Q);
      } else if (pal.theme === 'throne') {
        // Carved fluting and a vein of arcane light in the mortar.
        g.strokeStyle = 'rgba(0,0,0,0.30)'; g.lineWidth = 3;
        for (let i = 0; i < 4; i++) { const x = rng() * Q; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, Q); g.stroke(); }
        g.strokeStyle = rgbStr(accent, 0.35); g.lineWidth = 1.5;
        crack(g, rng() * Q, rng() * Q, Q * 0.7, rng() * 6.283, 1.5, rng, 1);
      }
      g.restore();
    }
    grain(g, S, S, 18, 22, makeRng(11));
    return finish(cv, { repeat: false, aniso: 16 });
  });
}

/**
 * Wall *tops*. From a fixed 52-degree camera you stare at these constantly, so they get
 * their own material: dust, rubble chips and moss/rime, not the same brick as the sides.
 */
export function wallTopTex(pal) {
  const key = `walltop|${pal.theme}|${pal.wallA}`;
  return cached(key, () => {
    const S = 256;
    const { cv, g } = canvas(S);
    const rng = makeRng(0x70B);
    const A = hexToRgb(pal.wallA), B = hexToRgb(pal.wallB);
    const top = mixRgb(A, [255, 255, 255], 0.12);

    g.fillStyle = rgbStr(mixRgb(top, B, 0.35));
    g.fillRect(0, 0, S, S);
    // Big irregular capstones.
    for (let i = 0; i < 9; i++) {
      const x = rng() * S, y = rng() * S, w = 40 + rng() * 70, h = 34 + rng() * 60;
      g.fillStyle = rgbStr(mixRgb(top, B, rng() * 0.6));
      g.beginPath(); g.roundRect(x, y, w, h, 5); g.fill();
      g.strokeStyle = 'rgba(0,0,0,0.32)'; g.lineWidth = 2; g.stroke();
    }
    // Chips and dust.
    for (let i = 0; i < 90; i++) {
      g.fillStyle = rgbStr(mixRgb(top, [255, 255, 255], rng() * 0.4), 0.5);
      g.fillRect(rng() * S, rng() * S, 1 + rng() * 4, 1 + rng() * 4);
    }
    const dress = { dungeon: 'rgba(96,140,72,0.30)', ice: 'rgba(236,250,255,0.55)', forge: 'rgba(28,12,6,0.18)', throne: 'rgba(150,70,190,0.20)', keep: 'rgba(120,124,90,0.16)' }[pal.theme] || 'rgba(0,0,0,0)';
    g.fillStyle = dress;
    for (let i = 0; i < 34; i++) {
      const x = rng() * S, y = rng() * S;
      g.beginPath(); g.ellipse(x, y, 5 + rng() * 22, 4 + rng() * 14, rng() * 3, 0, 6.283); g.fill();
    }
    grain(g, S, S, 26, 12, makeRng(13));
    return finish(cv, { aniso: 16 });
  });
}

// ---------------------------------------------------------------------------
// FLOOR DECALS — 2x2 RGBA atlas laid over the floor: crack, stain, growth, scuff.
// ---------------------------------------------------------------------------
export function decalAtlas(pal) {
  const key = `decal|${pal.theme}`;
  return cached(key, () => {
    const S = 512, Q = S / 2;
    const { cv, g } = canvas(S);
    const rng = makeRng(0xDECA1);
    g.clearRect(0, 0, S, S);

    const stain = { forge: '20,8,3', ice: '150,190,220', dungeon: '30,40,22', throne: '40,10,50', keep: '38,26,16' }[pal.theme] || '30,25,20';
    const growth = { forge: '255,110,30', ice: '235,250,255', dungeon: '104,148,74', throne: '190,90,230', keep: '110,120,80' }[pal.theme] || '110,120,80';

    // 0 — a fracture in the flagstones. Deliberately *few* and thin: a dense radial
    // starburst reads as a spider on the floor, not as damage.
    g.save(); g.beginPath(); g.rect(0, 0, Q, Q); g.clip();
    g.lineCap = 'round';
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * 6.283 + rng() * 0.8;
      // Light lip on one side, dark gap on the other — that is what reads as depth.
      g.strokeStyle = 'rgba(255,255,255,0.13)';
      crack(g, Q / 2 + 1.5, Q / 2 + 1.5, Q * 0.42, a, 2.2, makeRng(100 + i), 0);
      g.strokeStyle = 'rgba(0,0,0,0.40)';
      crack(g, Q / 2, Q / 2, Q * 0.42, a, 2.0, makeRng(100 + i), 0);
    }
    g.restore();

    // 1 — a spreading stain (soot / meltwater / algae depending on theme).
    g.save(); g.translate(Q, 0);
    for (let i = 0; i < 14; i++) {
      const x = Q / 2 + (rng() - 0.5) * Q * 0.7, y = Q / 2 + (rng() - 0.5) * Q * 0.7, r = 16 + rng() * 52;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(${stain},0.26)`); grd.addColorStop(1, `rgba(${stain},0)`);
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, 6.283); g.fill();
    }
    g.restore();

    // 2 — growth: moss, frost bloom, cinder crust or arcane bleed.
    g.save(); g.translate(0, Q);
    for (let i = 0; i < 40; i++) {
      const x = rng() * Q, y = rng() * Q, r = 5 + rng() * 20;
      g.fillStyle = `rgba(${growth},${0.10 + rng() * 0.30})`;
      g.beginPath(); g.ellipse(x, y, r, r * (0.5 + rng() * 0.5), rng() * 3, 0, 6.283); g.fill();
    }
    g.restore();

    // 3 — rubble scatter: small chips that break up a big empty floor.
    g.save(); g.translate(Q, Q);
    for (let i = 0; i < 46; i++) {
      const x = rng() * Q, y = rng() * Q, s = 2 + rng() * 9;
      g.fillStyle = `rgba(${rng() < 0.5 ? '20,18,16' : '190,186,178'},${0.20 + rng() * 0.4})`;
      g.beginPath(); g.ellipse(x, y, s, s * 0.7, rng() * 3, 0, 6.283); g.fill();
    }
    g.restore();

    return finish(cv, { repeat: false, aniso: 8 });
  });
}

/** Soft radial falloff — light pools, glow cards, portal haze. */
export function glowTex() {
  return cached('glow', () => {
    const S = 128;
    const { cv, g } = canvas(S);
    const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, S, S);
    return finish(cv, { repeat: false, aniso: 2 });
  });
}

/**
 * The rift's floor pool. **Structure, not haze.**
 *
 * The rift used to lay `glowTex()` — a plain radial gaussian — across a 14-metre square of
 * floor at low alpha. Additively, that is a translucent sheet: it lifts the black point of
 * everything under it, pulls every channel toward the glow colour, and therefore *lowers*
 * measured saturation across a large region of the frame. A blind critic ranked it the
 * single worst element in the game and described exactly that — a milky slab fogging half
 * the shot. Additive alpha spread over area is fog; the same light concentrated into edges
 * is an object.
 *
 * So this texture spends its light on features instead: a hard-edged inner disc, two
 * concentric rings with real falloff on each side, and sixteen tapering rays that die well
 * before the border. Between the features it goes to *zero*, which is the part that
 * matters — the floor between the rays is the untouched floor, so the pool reads as light
 * cast on stone rather than as a pane held in front of it.
 */
export function riftPoolTex() {
  return cached('riftpool', () => {
    const S = 256, c = S / 2;
    const { cv, g } = canvas(S);
    g.clearRect(0, 0, S, S);
    g.globalCompositeOperation = 'lighter';

    // Rays: bright at the hub, gone by 70% of the radius. Tapered with a width ramp
    // rather than an alpha ramp so the edges stay crisp against the dark floor.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * 6.283 + (i % 2) * 0.09;
      const len = c * (i % 2 ? 0.70 : 0.52);
      const steps = 22;
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        const r0 = c * 0.16 + t * len;
        const w = (1 - t) * (i % 2 ? 5.2 : 3.4) + 0.6;
        g.strokeStyle = `rgba(255,255,255,${(1 - t) * (1 - t) * 0.5})`;
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(c + Math.cos(a) * r0, c + Math.sin(a) * r0);
        g.lineTo(c + Math.cos(a) * (r0 + len / steps + 0.6), c + Math.sin(a) * (r0 + len / steps + 0.6));
        g.stroke();
      }
    }
    // Two rings. These are the feature that makes it read as a *cast* shape from above.
    for (const [rad, wid, al] of [[0.44, 5.5, 0.62], [0.74, 3.0, 0.34]]) {
      g.strokeStyle = `rgba(255,255,255,${al})`;
      g.lineWidth = wid;
      g.beginPath(); g.arc(c, c, c * rad, 0, 6.283); g.stroke();
    }
    // Hub: small, hot, hard-shouldered. Everything outside 0.22 falls to nothing fast.
    const hub = g.createRadialGradient(c, c, 0, c, c, c * 0.30);
    hub.addColorStop(0, 'rgba(255,255,255,1)');
    hub.addColorStop(0.55, 'rgba(255,255,255,0.72)');
    hub.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hub; g.fillRect(0, 0, S, S);

    // Hard vignette to zero at the border: no part of this may bleed to the quad's edge,
    // because an additive quad with a non-zero edge is precisely the veil being removed.
    g.globalCompositeOperation = 'destination-in';
    const mask = g.createRadialGradient(c, c, c * 0.55, c, c, c * 0.99);
    mask.addColorStop(0, 'rgba(0,0,0,1)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = mask; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'source-over';
    return finish(cv, { repeat: false, aniso: 4 });
  });
}

/** Cobweb: strung corners for dungeon/keep, hung as a quad in wall corners. */
export function webTex() {
  return cached('web', () => {
    const S = 256;
    const { cv, g } = canvas(S);
    const rng = makeRng(0xC0B);
    g.strokeStyle = 'rgba(228,232,238,0.62)';
    g.lineWidth = 1.2;
    const spokes = 9;
    for (let i = 0; i < spokes; i++) {
      const a = (i / (spokes - 1)) * (Math.PI / 2);
      g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * S * 1.4, Math.sin(a) * S * 1.4); g.stroke();
    }
    for (let r = 26; r < S * 1.3; r += 20 + rng() * 16) {
      g.beginPath();
      for (let i = 0; i < spokes; i++) {
        const a = (i / (spokes - 1)) * (Math.PI / 2);
        const rr = r * (0.9 + rng() * 0.2);
        const x = Math.cos(a) * rr, y = Math.sin(a) * rr;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.stroke();
    }
    return finish(cv, { repeat: false, aniso: 4 });
  });
}

/** Banner cloth with a woven border and a themed sigil. */
export function bannerTex(pal) {
  const key = `banner|${pal.theme}`;
  return cached(key, () => {
    const W = 128, H = 256;
    const { cv, g } = canvas(W, H);
    const rng = makeRng(0xBA9);
    const base = hexToRgb(pal.banner ?? '#8a2230');
    const trim = hexToRgb(pal.bannerTrim ?? '#d8b45a');

    g.fillStyle = rgbStr(base); g.fillRect(0, 0, W, H);
    // Vertical weave shading so it reads as hanging cloth, not a painted plane.
    for (let x = 0; x < W; x += 4) {
      g.fillStyle = rgbStr(mixRgb(base, [0, 0, 0], 0.10 + 0.16 * Math.abs(Math.sin(x * 0.13))), 0.5);
      g.fillRect(x, 0, 4, H);
    }
    g.fillStyle = rgbStr(trim);
    g.fillRect(0, 0, W, 10); g.fillRect(0, 6, 6, H); g.fillRect(W - 6, 6, 6, H);

    // Sigil: a simple heraldic mark, distinct per theme.
    g.save();
    g.translate(W / 2, H * 0.42);
    g.fillStyle = rgbStr(trim);
    g.strokeStyle = rgbStr(trim); g.lineWidth = 5; g.lineCap = 'round';
    if (pal.theme === 'forge') {           // hammer
      g.fillRect(-8, -34, 16, 68); g.fillRect(-30, -36, 60, 22);
    } else if (pal.theme === 'ice') {      // six-point star
      for (let i = 0; i < 6; i++) { const a = i * Math.PI / 3; g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * 34, Math.sin(a) * 34); g.stroke(); }
    } else if (pal.theme === 'throne') {   // crown
      g.beginPath(); g.moveTo(-32, 20); g.lineTo(-32, -14); g.lineTo(-16, 4); g.lineTo(0, -24); g.lineTo(16, 4); g.lineTo(32, -14); g.lineTo(32, 20); g.closePath(); g.fill();
    } else if (pal.theme === 'dungeon') {  // key
      g.beginPath(); g.arc(0, -20, 15, 0, 6.283); g.stroke();
      g.fillRect(-4, -8, 8, 46); g.fillRect(0, 24, 18, 7); g.fillRect(0, 12, 14, 7);
    } else {                               // keep: tower
      g.fillRect(-22, -8, 44, 44);
      for (let i = -22; i < 22; i += 15) g.fillRect(i, -22, 9, 16);
    }
    g.restore();

    // Frayed lower hem — cut alpha out in a ragged line.
    g.globalCompositeOperation = 'destination-out';
    g.beginPath(); g.moveTo(0, H);
    for (let x = 0; x <= W; x += 16) g.lineTo(x, H - 6 - rng() * 22);
    g.lineTo(W, H); g.closePath(); g.fill();
    g.globalCompositeOperation = 'source-over';

    grain(g, W, H, 16, 0, makeRng(19));
    return finish(cv, { repeat: false, aniso: 8 });
  });
}

/** Swirling breach membrane for spawn gates and the rift. */
export function portalTex() {
  return cached('portal', () => {
    const S = 256, c = S / 2;
    const { cv, g } = canvas(S);
    const rng = makeRng(0x9012);
    g.clearRect(0, 0, S, S);
    // Spiral arms drawn as tapering strokes, brightest at the eye.
    g.lineCap = 'round';
    for (let arm = 0; arm < 5; arm++) {
      const a0 = (arm / 5) * 6.283;
      for (let i = 0; i < 60; i++) {
        const t = i / 60;
        const a = a0 + t * 4.2;
        const r = t * c * 0.96;
        const x = c + Math.cos(a) * r, y = c + Math.sin(a) * r;
        g.strokeStyle = `rgba(255,255,255,${(1 - t) * 0.55})`;
        g.lineWidth = (1 - t) * 9 + 1;
        if (i === 0) { g.beginPath(); g.moveTo(x, y); } else { g.lineTo(x, y); g.stroke(); g.beginPath(); g.moveTo(x, y); }
      }
    }
    const grd = g.createRadialGradient(c, c, 0, c, c, c);
    grd.addColorStop(0, 'rgba(255,255,255,0.95)');
    grd.addColorStop(0.5, 'rgba(255,255,255,0.28)');
    grd.addColorStop(0.92, 'rgba(255,255,255,0.10)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = grd; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'destination-in';
    const mask = g.createRadialGradient(c, c, c * 0.1, c, c, c);
    mask.addColorStop(0, 'rgba(0,0,0,1)'); mask.addColorStop(0.86, 'rgba(0,0,0,1)'); mask.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = mask; g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < 40; i++) {
      g.fillStyle = `rgba(255,255,255,${rng() * 0.4})`;
      const a = rng() * 6.283, r = rng() * c * 0.9;
      g.fillRect(c + Math.cos(a) * r, c + Math.sin(a) * r, 2, 2);
    }
    return finish(cv, { repeat: false, srgb: true, aniso: 4 });
  });
}

/** Rune ring carved into the rift dais — the "this is sacred ground" cue. */
export function runeRingTex() {
  return cached('runes', () => {
    const S = 256, c = S / 2;
    const { cv, g } = canvas(S);
    g.clearRect(0, 0, S, S);
    g.strokeStyle = 'rgba(255,255,255,0.9)';
    g.lineWidth = 3;
    g.beginPath(); g.arc(c, c, c * 0.86, 0, 6.283); g.stroke();
    g.lineWidth = 2;
    g.beginPath(); g.arc(c, c, c * 0.70, 0, 6.283); g.stroke();
    // Glyphs around the band: three or four strokes each, angular, no curves.
    const n = 16;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * 6.283;
      g.save();
      g.translate(c + Math.cos(a) * c * 0.78, c + Math.sin(a) * c * 0.78);
      g.rotate(a + Math.PI / 2);
      g.lineWidth = 2.4;
      const strokes = 3 + ((i * 7) % 3);
      for (let s = 0; s < strokes; s++) {
        const x0 = -5 + ((i * 13 + s * 5) % 10), y0 = -6 + ((i * 5 + s * 3) % 12);
        g.beginPath(); g.moveTo(x0, y0);
        g.lineTo(x0 + ((s % 2) ? 8 : 0), y0 + ((s % 2) ? 0 : 9));
        g.stroke();
      }
      g.restore();
    }
    // Radial spokes from the centre out to the band.
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * 6.283 + 0.2;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * c * 0.18, c + Math.sin(a) * c * 0.18);
      g.lineTo(c + Math.cos(a) * c * 0.68, c + Math.sin(a) * c * 0.68);
      g.stroke();
    }
    return finish(cv, { repeat: false, aniso: 8 });
  });
}

/** What you see at the bottom of a pit: magma, black water or a starless void. */
export function pitFloorTex(pal) {
  const key = `pitfloor|${pal.theme}`;
  return cached(key, () => {
    const S = 512;
    const { cv, g } = canvas(S);
    const rng = makeRng(0x9117);
    const hot = { forge: ['#ffb14a', '#3a0a00'], ice: ['#8fe4ff', '#08202f'], dungeon: ['#4fd8b0', '#03110c'], throne: ['#d867f0', '#0e0318'], keep: ['#c08a3a', '#0b0703'] }[pal.theme] || ['#c08a3a', '#0b0703'];
    const A = hexToRgb(hot[0]), B = hexToRgb(hot[1]);

    // Molten base.
    g.fillStyle = rgbStr(mixRgb(A, B, 0.22)); g.fillRect(0, 0, S, S);
    for (let i = 0; i < 26; i++) {
      const x = rng() * S, y = rng() * S, r = 40 + rng() * 120;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, rgbStr(mixRgb(A, [255, 255, 255], 0.22), 0.55));
      grd.addColorStop(1, rgbStr(A, 0));
      g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
    }

    // Cooled crust floating on it. Overlapping irregular plates leave glowing seams
    // between them — that reads as magma. Drawing bright cracks on a dark base instead
    // reads as line art scribbled on black, which is what this used to look like.
    const plate = (x, y, r) => {
      g.beginPath();
      const n = 7 + ((rng() * 4) | 0);
      for (let k = 0; k <= n; k++) {
        const a = (k / n) * 6.283;
        const rr = r * (0.62 + rng() * 0.55);
        const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr * 0.8;
        k ? g.lineTo(px, py) : g.moveTo(px, py);
      }
      g.closePath(); g.fill();
    };
    for (let i = 0; i < 150; i++) {
      g.fillStyle = rgbStr(mixRgb(B, A, rng() * 0.22), 0.94);
      plate(rng() * S, rng() * S, 16 + rng() * 40);
    }
    // A second, smaller layer of even darker slag on top of the plates.
    for (let i = 0; i < 90; i++) {
      g.fillStyle = rgbStr(mixRgb(B, [0, 0, 0], 0.45), 0.8);
      plate(rng() * S, rng() * S, 10 + rng() * 24);
    }
    // Faint bloom where the seams are widest, so the glow feels volumetric.
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 14; i++) {
      const x = rng() * S, y = rng() * S, r = 30 + rng() * 60;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, rgbStr(A, 0.18)); grd.addColorStop(1, rgbStr(A, 0));
      g.fillStyle = grd; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    g.globalCompositeOperation = 'source-over';
    grain(g, S, S, 16, 10, makeRng(23));
    return finish(cv, { aniso: 8 });
  });
}

export function disposeTextureCache() {
  for (const t of _cache.values()) t.dispose?.();
  _cache.clear();
}
