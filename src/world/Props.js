import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * The clutter library. Every prop is a *canonical* BufferGeometry with baked vertex
 * colours, authored with its origin on the floor and +Y up, at real metres (TILE = 4).
 *
 * Why vertex colours instead of materials: it lets Decor.js merge two hundred barrels,
 * crates, bones and braziers of five different woods and metals into **one** mesh with
 * **one** material — one draw call for the entire dressing pass. Instancing would need
 * a mesh per prop type and would forbid per-instance tinting; merging gives both.
 *
 * Geometries are cached per (name, themeKey) because ten levels share five palettes.
 */

// --- primitive cache --------------------------------------------------------
const _prim = new Map();
function prim(key, make) {
  let g = _prim.get(key);
  if (!g) { g = make(); _prim.set(key, g); }
  return g;
}
/** Unit box with its origin on the floor, so `scale` reads as (width, height, depth). */
const box = () => prim('box', () => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0));
const cyl = (seg, rTop = 0.5, rBot = 0.5, open = false) =>
  prim(`cyl${seg}|${rTop}|${rBot}|${open}`, () => new THREE.CylinderGeometry(rTop, rBot, 1, seg, 1, open).translate(0, 0.5, 0));
const cone = (seg) => prim(`cone${seg}`, () => new THREE.ConeGeometry(0.5, 1, seg).translate(0, 0.5, 0));
const ico = (d = 0) => prim(`ico${d}`, () => new THREE.IcosahedronGeometry(0.5, d).translate(0, 0.5, 0));
const plane = () => prim('plane', () => new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0));
const ring = (seg) => prim(`ring${seg}`, () => new THREE.TorusGeometry(0.5, 0.06, 4, seg).rotateX(Math.PI / 2));

// --- tiny builder -----------------------------------------------------------
const _c = new THREE.Color();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

class Acc {
  /** `name` is only used to make a merge failure name the prop that caused it. */
  constructor(name = 'prop') { this.parts = []; this.name = name; }
  /**
   * @param g   base geometry (one of the primitives above)
   * @param col hex colour baked into every vertex
   * @param t   { x,y,z, sx,sy,sz, rx,ry,rz } — all optional
   */
  add(g, col, t = {}) {
    const c = g.clone();
    _e.set(t.rx || 0, t.ry || 0, t.rz || 0);
    _q.setFromEuler(_e);
    _v.set(t.x || 0, t.y || 0, t.z || 0);
    _s.set(t.sx ?? 1, t.sy ?? t.sx ?? 1, t.sz ?? t.sx ?? 1);
    _m.compose(_v, _q, _s);
    c.applyMatrix4(_m);
    paint(c, col, t.shadeY ?? 0);
    this.parts.push(c);
    return this;
  }
  /**
   * `mergeGeometries` returns null (not throws) when the parts disagree about attributes
   * or indexing, and dereferencing that null used to take `loadLevel` down with it — a
   * decoration bug must never be able to stop a level from loading. `paint()` normalises
   * every part on the way in; this is the belt to that pair of braces, and it names the
   * prop instead of failing as an anonymous null.
   */
  build() {
    let merged = null;
    if (this.parts.length) {
      merged = mergeGeometries(this.parts, false);
      if (!merged) console.error(`[world] prop "${this.name}" failed to merge; parts disagree on attributes or indexing`);
    }
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    if (!merged) return emptyGeometry();
    merged.computeBoundingSphere();
    return merged;
  }
}

/**
 * Scale a hex's value, clamped. This is the whole vocabulary for course-to-course value
 * variation: one substance colour, many shades of it, still one draw call.
 */
export function shadeHex(hex, k) {
  const m = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
  return (m((hex >> 16) & 255) << 16) | (m((hex >> 8) & 255) << 8) | m(hex & 255);
}
const sh = shadeHex;

/** A valid, drawable, zero-triangle geometry. The safe thing to return when a merge fails. */
function emptyGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([0, 1, 0]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(2), 2));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array([1, 1, 1]), 3));
  g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 0, 0]), 1));
  g.computeBoundingSphere();
  return g;
}

/**
 * Bakes a flat colour into the vertex-colour attribute, optionally with a vertical
 * gradient (`shadeY`) so tall props darken toward the floor. Free contact shadow.
 */
function paint(geo, col, shadeY = 0) {
  _c.set(col);
  const pos = geo.attributes.position;
  const n = pos.count;
  const arr = new Float32Array(n * 3);
  let minY = Infinity, maxY = -Infinity;
  if (shadeY) {
    for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  for (let i = 0; i < n; i++) {
    let k = 1;
    if (shadeY && maxY > minY) k = 1 - shadeY * (1 - (pos.getY(i) - minY) / (maxY - minY));
    arr[i * 3] = _c.r * k; arr[i * 3 + 1] = _c.g * k; arr[i * 3 + 2] = _c.b * k;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  // mergeGeometries is strict about attribute sets, so normalise every part.
  if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  for (const k of Object.keys(geo.attributes)) {
    if (k !== 'position' && k !== 'normal' && k !== 'uv' && k !== 'color') geo.deleteAttribute(k);
  }
  // Polyhedra (Icosahedron/Octahedron) ship non-indexed while boxes and cylinders are
  // indexed; merging refuses to mix the two, so give the odd ones out a trivial index.
  if (!geo.index) {
    const idx = new (n > 65535 ? Uint32Array : Uint16Array)(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
  }
  return geo;
}

// ---------------------------------------------------------------------------
// PALETTE-DRIVEN MATERIAL COLOURS
// ---------------------------------------------------------------------------
/**
 * Per-theme substance colours. This is where "the forge is not the ice keep" lives.
 *
 * `pal` overrides the two light-emitting entries from the palette, because a fire has to
 * be the same colour as the light it casts. Without this, level 10 burned pink flames
 * while its torchlight bake was green.
 */
export function propColors(theme, pal = null) {
  const c = themeColors(theme);
  if (pal) {
    if (pal.torch !== undefined) {
      c.glow = pal.torch;
      c.ember = new THREE.Color(pal.torch).lerp(new THREE.Color(0xff4a10), 0.45).getHex();
    }
    if (pal.pitGlow !== undefined) c.lava = pal.pitGlow;
    /**
     * **Masonry is cut from the wall it stands against.**
     *
     * `stone`/`stoneDark` were pure theme constants — one hex per theme, never touched by
     * the palette and never run through the tone contract. Everything made of stone
     * inherits them: pillars, broken pillars, obelisks, rubble, plinths, the rift dais.
     * So on the Gatehouse a near-neutral grey column stood against a saturated tan wall,
     * and a blind critic called it exactly right: *"pale blue pillar against warm tan wall,
     * reads as pasted from another game."* It is the same failure `Decor.archStone` was
     * created to fix for arches and vault ribs, which never got applied to the prop set.
     *
     * The wall colours arriving here are already on the campaign's luminance ladder, so
     * quoting them fixes the value as well as the hue. Mixed at 0.72 rather than copied:
     * a column is dressed ashlar standing against rubble masonry, so it should still be a
     * *slightly* different stone — just not one from a different game.
     */
    if (pal.wallA !== undefined) c.stone = _mixHex(c.stone, pal.wallA, 0.72);
    if (pal.wallB !== undefined) c.stoneDark = _mixHex(c.stoneDark, pal.wallB, 0.72);
  }
  return c;
}

const _mixA = new THREE.Color(); const _mixB = new THREE.Color();
function _mixHex(a, b, t) {
  _mixA.set(a); _mixB.set(b);
  return _mixA.lerp(_mixB, t).getHex();
}

function themeColors(theme) {
  const base = {
    wood: 0x6b4a2c, woodDark: 0x40291a, iron: 0x4a4a52, ironDark: 0x2a2a30,
    stone: 0x6a6258, stoneDark: 0x413b34, rope: 0x9a7f4e, cloth: 0x8a2230,
    gold: 0xc8a24a, bone: 0xd6cdb4, growth: 0x4f6b34, ember: 0xff7a26, glow: 0xffb347,
  };
  switch (theme) {
    case 'dungeon': return { ...base, wood: 0x4e3a26, woodDark: 0x2c2016, stone: 0x585264, stoneDark: 0x35303f,
      growth: 0x53703a, cloth: 0x3f2c5a, glow: 0x76d0ff, ember: 0x5fe0c0, bone: 0xcfc7ae };
    case 'forge': return { ...base, wood: 0x5c3a20, woodDark: 0x2e1c10, iron: 0x5a4038, ironDark: 0x2e1a14,
      stone: 0x6c4a35, stoneDark: 0x3b2418, growth: 0x7a3a18, cloth: 0x9a2410, glow: 0xff8a2a, ember: 0xff5410, gold: 0xd8952c };
    case 'ice': return { ...base, wood: 0x6a5a48, woodDark: 0x3c3126, iron: 0x6e7d8c, ironDark: 0x3d4854,
      stone: 0x8ea2b6, stoneDark: 0x566a7e, growth: 0xbfe4f4, cloth: 0x2f5f8f, glow: 0x9fe8ff, ember: 0x7fd4ff, bone: 0xe6eef4 };
    case 'throne': return { ...base, wood: 0x4a3350, woodDark: 0x2a1c30, iron: 0x3e3648, ironDark: 0x241e2c,
      stone: 0x5f4f6a, stoneDark: 0x362a40, growth: 0x7a3a8c, cloth: 0x6a1038, glow: 0xff7ad0, ember: 0xc04ae0, gold: 0xd8b45a };
    default: return base;
  }
}

// ---------------------------------------------------------------------------
// SOLID PROPS — merged into the lit, shadow-casting dressing mesh.
// ---------------------------------------------------------------------------
const SOLID = {
  /** Iron-banded barrel. The single most Orcs-Must-Die object there is. */
  barrel(c) {
    const a = new Acc('barrel');
    a.add(cyl(8, 0.5, 0.44), c.wood, { sx: 0.86, sy: 1.15, shadeY: 0.45 });
    a.add(cyl(8, 0.53, 0.53, true), c.iron, { sx: 0.9, sy: 0.1, y: 0.24, shadeY: 0.2 });
    a.add(cyl(8, 0.53, 0.53, true), c.iron, { sx: 0.9, sy: 0.1, y: 0.82, shadeY: 0.2 });
    a.add(cyl(8, 0.44, 0.44), c.woodDark, { sx: 0.8, sy: 0.06, y: 1.14 });
    return a.build();
  },
  /** Crate with a nailed plank cross — reads instantly even at 12 pixels. */
  crate(c) {
    const a = new Acc('crate');
    a.add(box(), c.wood, { sx: 1.05, sy: 1.0, sz: 1.05, shadeY: 0.45 });
    a.add(box(), c.woodDark, { sx: 1.1, sy: 0.1, sz: 0.16, y: 0.62, z: 0.5 });
    a.add(box(), c.woodDark, { sx: 0.16, sy: 0.1, sz: 1.1, y: 0.62, x: 0.5 });
    a.add(box(), c.woodDark, { sx: 1.08, sy: 0.14, sz: 1.08, y: 0.98 });
    return a.build();
  },
  /** Sack of grain, slumped. Breaks up the hard right angles of crates. */
  sack(c) {
    const a = new Acc('sack');
    a.add(ico(0), c.rope, { sx: 0.8, sy: 1.0, sz: 0.72, shadeY: 0.4 });
    a.add(cyl(6, 0.2, 0.32), c.rope, { sx: 0.5, sy: 0.3, y: 0.72 });
    return a.build();
  },
  /** Standing brazier: tripod, bowl, coals. The glow half lives in GLOW.flame. */
  brazier(c) {
    const a = new Acc('brazier');
    for (let i = 0; i < 3; i++) {
      const ang = (i / 3) * Math.PI * 2;
      a.add(box(), c.ironDark, { sx: 0.13, sy: 1.5, sz: 0.13, x: Math.cos(ang) * 0.34, z: Math.sin(ang) * 0.34, rx: Math.sin(ang) * 0.22, rz: -Math.cos(ang) * 0.22, shadeY: 0.5 });
    }
    a.add(cyl(10, 0.72, 0.36), c.iron, { sy: 0.44, y: 1.36, shadeY: 0.25 });
    a.add(cyl(10, 0.74, 0.74, true), c.ironDark, { sy: 0.1, y: 1.74 });
    a.add(ico(0), c.ember, { sx: 0.9, sy: 0.3, y: 1.6 });
    return a.build();
  },
  /**
   * Load-bearing column. Placed on wall corners, it makes a room read as *built*.
   *
   * **Drums, not a post.** The dressing mesh carries no texture map — it is one merged
   * vertex-coloured mesh, which is what makes two hundred props cost one draw call — so a
   * four-metre untextured cylinder has literally nothing in it, and being the tallest
   * sunlit object standing on the play floor it becomes the brightest blank shape in
   * frame. Five stacked drums with a recessed dark bed joint between each and a lit arris
   * on the collar give the same silhouette a shadow line every 0.9 units and a different
   * value in every course.
   */
  pillar(c) {
    const a = new Acc('pillar');
    const D = 5, HS = 4.6;
    a.add(box(), sh(c.stoneDark, 0.92), { sx: 1.62, sy: 0.22, sz: 1.62 });
    a.add(box(), sh(c.stoneDark, 1.10), { sx: 1.46, sy: 0.16, sz: 1.46, y: 0.20 });   // plinth lip
    for (let i = 0; i < D; i++) {
      const y = 0.36 + (i / D) * HS;
      const h = HS / D;
      const v = 0.80 + ((i * 7) % 5) / 5 * 0.30;      // course-to-course value variation
      const w = 1.90 - i * 0.08;                       // gentle entasis
      a.add(cyl(8, 0.50, 0.53), sh(c.stone, v), { sx: w, sy: h - 0.08, y, shadeY: 0.34 });
      a.add(cyl(8, 0.545, 0.545), sh(c.stoneDark, 0.9), { sx: w, sy: 0.08, y: y + h - 0.08 });
    }
    a.add(cyl(8, 0.56, 0.50), sh(c.stone, 1.22), { sx: 1.62, sy: 0.18, y: 0.30 + HS });  // lit collar
    a.add(box(), sh(c.stoneDark, 0.95), { sx: 1.66, sy: 0.42, sz: 1.66, y: 0.48 + HS });
    a.add(box(), sh(c.stone, 1.16), { sx: 1.40, sy: 0.14, sz: 1.40, y: 0.90 + HS });     // abacus lip
    a.add(box(), sh(c.stone, 0.86), { sx: 1.32, sy: 0.44, sz: 1.32, y: 1.04 + HS });
    return a.build();
  },
  /** A pillar the horde already broke. Same silhouette, different story. */
  pillarBroken(c) {
    const a = new Acc('pillarBroken');
    a.add(box(), sh(c.stoneDark, 0.92), { sx: 1.55, sy: 0.35, sz: 1.55, shadeY: 0.3 });
    for (let i = 0; i < 3; i++) {
      const y = 0.35 + i * 0.70;
      const v = 0.78 + ((i * 5) % 4) / 4 * 0.34;
      a.add(cyl(8, 0.50, 0.55), sh(c.stone, v), { sx: 1.9 - i * 0.06, sy: 0.62, y, shadeY: 0.34 });
      a.add(cyl(8, 0.565, 0.565), sh(c.stoneDark, 0.92), { sx: 1.9 - i * 0.06, sy: 0.08, y: y + 0.62 });
    }
    // Snapped top: a jagged cap with a bright fresh-break face, so the fracture reads.
    a.add(ico(0), sh(c.stone, 1.14), { sx: 1.5, sy: 0.7, y: 2.28, ry: 0.6 });
    a.add(ico(0), sh(c.stoneDark, 1.0), { sx: 1.1, sy: 0.4, y: 2.44, x: 0.2, ry: 1.4 });
    // The fallen drum, lying where it landed.
    a.add(cyl(8, 0.5, 0.5), sh(c.stone, 0.86), { sx: 1.7, sy: 0.7, y: 0.2, x: 1.5, z: 0.7, rz: 1.5, ry: 0.4 });
    a.add(cyl(8, 0.52, 0.52), sh(c.stoneDark, 0.95), { sx: 1.7, sy: 0.08, y: 0.2, x: 1.85, z: 0.7, rz: 1.5, ry: 0.4 });
    a.add(cyl(8, 0.5, 0.5), sh(c.stone, 1.06), { sx: 1.66, sy: 0.62, y: 0.2, x: 2.28, z: 0.72, rz: 1.5, ry: 0.9 });
    return a.build();
  },
  /** Rubble heap — the cheapest way to say "something happened here". */
  rubble(c) {
    const a = new Acc('rubble');
    a.add(ico(0), c.stone, { sx: 0.9, sy: 0.5, sz: 0.8, ry: 0.4 });
    a.add(ico(0), c.stoneDark, { sx: 0.6, sy: 0.4, sz: 0.6, x: 0.55, z: 0.3, ry: 1.1 });
    a.add(ico(0), c.stone, { sx: 0.45, sy: 0.3, sz: 0.5, x: -0.4, z: 0.45, ry: 2.2 });
    return a.build();
  },
  /** Skull and ribs. Placed near spawns and killboxes; it is a warning sign. */
  bones(c) {
    const a = new Acc('bones');
    a.add(ico(0), c.bone, { sx: 0.42, sy: 0.4, sz: 0.46 });
    a.add(box(), c.bone, { sx: 0.3, sy: 0.1, sz: 0.16, y: 0.12, z: 0.26 });
    for (let i = 0; i < 3; i++)
      a.add(box(), c.bone, { sx: 0.7, sy: 0.07, sz: 0.07, x: 0.6 + i * 0.22, y: 0.05, rz: 0.1, ry: 0.3 - i * 0.25 });
    return a.build();
  },
  /** Spear rack against a wall — says "garrison", gives a vertical accent. */
  weaponRack(c) {
    const a = new Acc('weaponRack');
    a.add(box(), c.woodDark, { sx: 0.16, sy: 1.7, sz: 0.16, x: -0.7, shadeY: 0.4 });
    a.add(box(), c.woodDark, { sx: 0.16, sy: 1.7, sz: 0.16, x: 0.7, shadeY: 0.4 });
    a.add(box(), c.woodDark, { sx: 1.7, sy: 0.14, sz: 0.16, y: 1.5 });
    for (let i = 0; i < 4; i++) {
      const x = -0.55 + i * 0.36;
      a.add(box(), c.wood, { sx: 0.07, sy: 2.3, sz: 0.07, x, rz: (i - 1.5) * 0.05, shadeY: 0.3 });
      a.add(cone(4), c.iron, { sx: 0.16, sy: 0.34, y: 2.28, x });
    }
    return a.build();
  },
  /** Anvil on a stump. Forge signature. */
  anvil(c) {
    const a = new Acc('anvil');
    a.add(cyl(7, 0.42, 0.48), c.woodDark, { sx: 1.5, sy: 0.7, shadeY: 0.4 });
    a.add(box(), c.iron, { sx: 0.5, sy: 0.22, sz: 0.34, y: 0.7 });
    a.add(box(), c.iron, { sx: 1.15, sy: 0.3, sz: 0.5, y: 0.9 });
    a.add(cone(4), c.iron, { sx: 0.4, sy: 0.6, y: 1.05, x: 0.78, rz: -1.57 });
    return a.build();
  },
  /** Frozen spike growing out of the floor, or a cave stalagmite. */
  spike(c) {
    const a = new Acc('spike');
    a.add(cone(6), c.stone, { sx: 0.7, sy: 2.4, shadeY: 0.55 });
    a.add(cone(6), c.stone, { sx: 0.42, sy: 1.4, x: 0.42, z: 0.24, rz: 0.16, shadeY: 0.55 });
    a.add(cone(6), c.stone, { sx: 0.3, sy: 0.9, x: -0.36, z: -0.2, rz: -0.2, shadeY: 0.55 });
    return a.build();
  },
  /** Iron cage, empty and swinging. Dungeon signature. */
  cage(c) {
    const a = new Acc('cage');
    a.add(ring(8), c.ironDark, { sx: 1.5, sy: 1, sz: 1.5, y: 0.02 });
    a.add(ring(8), c.ironDark, { sx: 1.5, sy: 1, sz: 1.5, y: 1.5 });
    for (let i = 0; i < 6; i++) {
      const ang = (i / 6) * Math.PI * 2;
      a.add(box(), c.ironDark, { sx: 0.08, sy: 1.55, sz: 0.08, x: Math.cos(ang) * 0.72, z: Math.sin(ang) * 0.72, shadeY: 0.35 });
    }
    a.add(cone(4), c.ironDark, { sx: 0.9, sy: 0.5, y: 1.5 });
    return a.build();
  },
  /** Coal heap / ore pile. */
  heap(c) {
    const a = new Acc('heap');
    a.add(cone(7), c.stoneDark, { sx: 1.7, sy: 0.75, shadeY: 0.35 });
    a.add(ico(0), c.stoneDark, { sx: 0.5, sy: 0.35, x: 0.7, z: 0.4 });
    a.add(ico(0), c.ember, { sx: 0.24, sy: 0.16, x: -0.2, z: 0.5, y: 0.1 });
    return a.build();
  },
  /** Broken supply cart, wheels off. Sells "the road was busy before the war". */
  cart(c) {
    const a = new Acc('cart');
    a.add(box(), c.wood, { sx: 2.1, sy: 0.22, sz: 1.2, y: 0.55, rz: 0.12, shadeY: 0.3 });
    a.add(box(), c.woodDark, { sx: 2.1, sy: 0.5, sz: 0.12, y: 0.68, z: 0.58, rz: 0.12 });
    a.add(box(), c.woodDark, { sx: 2.1, sy: 0.5, sz: 0.12, y: 0.68, z: -0.58, rz: 0.12 });
    a.add(cyl(9, 0.5, 0.5), c.woodDark, { sx: 1.5, sy: 0.16, sz: 1.5, z: 0.72, y: 0.62, rx: 1.57, rz: 0.12 });
    a.add(cyl(9, 0.5, 0.5), c.woodDark, { sx: 1.4, sy: 0.16, sz: 1.4, z: -1.1, x: 1.3, y: 0.08, rx: 0.4 });
    a.add(box(), c.wood, { sx: 1.4, sy: 0.14, sz: 0.14, x: -1.6, y: 0.5, rz: -0.3 });
    return a.build();
  },
  /** Wall sconce: the bracket half of a torch. Hangs off a wall face. */
  sconce(c) {
    const a = new Acc('sconce');
    a.add(box(), c.ironDark, { sx: 0.34, sy: 0.9, sz: 0.20, shadeY: 0.3 });
    a.add(box(), c.iron, { sx: 0.16, sy: 0.16, sz: 0.9, y: 0.62, z: 0.42, rx: -0.55 });
    a.add(cyl(8, 0.44, 0.20), c.iron, { sy: 0.42, y: 0.92, z: 0.74 });
    a.add(cyl(8, 0.46, 0.46, true), c.ironDark, { sy: 0.09, y: 1.30, z: 0.74 });
    a.add(cyl(6, 0.11, 0.13), c.woodDark, { sy: 0.5, y: 1.05, z: 0.74 });
    return a.build();
  },
  /** Hanging chain with a hook. Vertical detail against big flat walls. */
  chain(c) {
    const a = new Acc('chain');
    for (let i = 0; i < 5; i++)
      a.add(ring(5), c.ironDark, { sx: 0.22, sy: 1, sz: 0.22, y: -i * 0.3, rx: 1.57, rz: (i % 2) * 1.57 });
    a.add(cone(4), c.ironDark, { sx: 0.2, sy: 0.35, y: -1.65, rz: 3.14 });
    return a.build();
  },
  /** Obsidian obelisk — the throne set's vertical punctuation. */
  obelisk(c) {
    const a = new Acc('obelisk');
    a.add(box(), sh(c.stoneDark, 0.92), { sx: 1.42, sy: 0.30, sz: 1.42, shadeY: 0.3 });
    a.add(box(), sh(c.stoneDark, 1.12), { sx: 1.28, sy: 0.14, sz: 1.28, y: 0.28 });   // plinth lip
    // Four tapering courses with a cut band between each: an untextured 4-metre spike is
    // one flat value, and at this camera that is a blank white needle.
    const H = 4.2;
    for (let i = 0; i < 4; i++) {
      const t0 = i / 4, t1 = (i + 1) / 4;
      const y = 0.42 + t0 * H;
      const v = 0.76 + ((i * 3) % 4) / 4 * 0.32;
      a.add(cyl(4, 0.5 - t1 * 0.16, 0.5 - t0 * 0.16), sh(c.stone, v), { sx: 1.6, sy: H / 4 - 0.07, y, ry: 0.785, shadeY: 0.30 });
      a.add(cyl(4, 0.53 - t1 * 0.16, 0.53 - t1 * 0.16), sh(c.stoneDark, 0.95), { sx: 1.6, sy: 0.07, y: y + H / 4 - 0.07, ry: 0.785 });
    }
    a.add(cone(4), sh(c.stone, 1.12), { sx: 0.85, sy: 1.0, y: 4.62, ry: 0.785, shadeY: 0.22 });
    return a.build();
  },
  /** Skull pile. Level 10 is paved with these. */
  skullPile(c) {
    const a = new Acc('skullPile');
    for (let i = 0; i < 7; i++) {
      const ang = i * 2.4, r = (i % 3) * 0.3;
      a.add(ico(0), c.bone, { sx: 0.36, sy: 0.34, sz: 0.4, x: Math.cos(ang) * r, z: Math.sin(ang) * r, y: (i > 4 ? 0.32 : 0), ry: ang });
    }
    return a.build();
  },
};

// ---------------------------------------------------------------------------
// GLOW PROPS — merged into an unlit additive mesh so they punch through the fog.
// ---------------------------------------------------------------------------
/**
 * One shell of a flame: a teardrop surface of revolution with the emissive value baked
 * per vertex, twisted and wobbled so it is not a perfect lathe.
 *
 * `bright` may exceed 1 — vertex colours are floats, and a flame core is *supposed* to
 * clip. It is written straight into the attribute rather than through `paint()`, which
 * can only carry a colour a hex can express.
 */
function flameShell(colHex, rBase, hBase, bright, phase) {
  const SEG = 7, RING = 7;
  const col = new THREE.Color(colHex);
  const pos = [], nrm = [], uvs = [], cols = [], idx = [];
  // Radius up the flame: pinched at the fuel, widest at a fifth of the height, then a
  // long taper to a point. This is the silhouette; the value profile below is the heat.
  const rProf = (t) => (0.30 + 0.86 * Math.sin(Math.PI * Math.pow(t, 0.52))) * Math.pow(1 - t, 0.55);
  // Heat up the flame: hottest just above the fuel, falling off toward the tip, with the
  // very base held down because it is sitting *inside* the cup and is shaded by it.
  const vProf = (t) => (0.30 + 0.95 * Math.pow(1 - t, 1.35)) * (0.52 + 0.48 * Math.min(1, t / 0.14));
  for (let r = 0; r <= RING; r++) {
    const t = r / RING;
    const rad = rProf(t) * rBase;
    const v = vProf(t) * bright;
    for (let s = 0; s < SEG; s++) {
      const a = (s / SEG) * Math.PI * 2 + phase + t * 0.9;            // twist up the height
      const wob = 1 + 0.17 * Math.sin(s * 2.3 + phase * 3) * (0.35 + t);
      pos.push(Math.cos(a) * rad * wob, t * hBase, Math.sin(a) * rad * wob);
      nrm.push(Math.cos(a), 0.35, Math.sin(a));
      uvs.push(s / SEG, t);
      cols.push(col.r * v, col.g * v, col.b * v);
    }
  }
  for (let r = 0; r < RING; r++) {
    for (let s = 0; s < SEG; s++) {
      const a0 = r * SEG + s, a1 = r * SEG + ((s + 1) % SEG);
      idx.push(a0, a0 + SEG, a1, a1, a0 + SEG, a1 + SEG);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
  g.setIndex(idx);
  return g;
}

const GLOW = {
  /**
   * Flame body for braziers, sconces and chandeliers.
   *
   * **Four nested shells, not one cone.** A flame drawn as a single additive cone is
   * near-uniformly emissive across its own surface: every fragment of it gets the same
   * value, the peak sails past the top of the tone curve, and *all* of the structure you
   * then see — the hot middle, the soft edge — is manufactured downstream by the tone
   * response and the bloom halo. Grade the picture harder and you get a bigger white
   * blob, never a better flame.
   *
   * Nesting fixes it in the geometry, where it belongs. Additive blending accumulates,
   * so a ray through the middle of the flame passes through all four shells and a ray
   * near the silhouette passes through only the dimmest, widest one: the core reads about
   * 8x the edge. The shells also *shift hue* inward — deep ember red on the envelope,
   * flame colour in the body, near-white at the core — so the gradient survives being
   * tone-mapped even where the top of it clips. Only the core is authored to clip, and it
   * is a fifth of the width.
   */
  flame(c) {
    const glow = new THREE.Color(c.glow);
    const ember = new THREE.Color(c.ember);
    const core = glow.clone().lerp(new THREE.Color(0xffffff), 0.62).getHex();
    const body = glow.clone().lerp(ember, 0.30).getHex();
    const outer = ember.clone().lerp(new THREE.Color(0xff3a08), 0.34).getHex();
    /**
     * The four brightnesses are a *redistribution*, not a reduction. Integrated over the
     * silhouette the flame emits about what the old single cone did — pull them down and
     * every level in the campaign loses several points of mean luma, because torches are
     * most of the light in a dungeon. What changed is where the energy sits: the envelope
     * runs at roughly 40% of the old flat value so the edges have somewhere to fall to,
     * and the core is authored well past clipping over a fifth of the width.
     */
    const parts = [
      flameShell(outer, 0.42, 1.34, 0.49, 0.0),   // envelope: widest, coolest, dimmest
      flameShell(body, 0.28, 1.08, 0.65, 1.7),   // body
      flameShell(core, 0.145, 0.76, 1.36, 3.1),   // core: the only part meant to clip
      flameShell(ember.getHex(), 0.40, 0.30, 0.62, 2.2),   // coals sitting in the cup
    ];
    const g = mergeGeometries(parts, false);
    for (const p of parts) p.dispose();
    if (!g) { console.error('[world] prop "flame" failed to merge'); return emptyGeometry(); }
    g.computeBoundingSphere();
    return g;
  },
  /** Free-standing crystal — rift shards, forge cinder-glass, frost spires. */
  crystal(c) {
    const a = new Acc('crystal');
    a.add(cone(5), c.glow, { sx: 0.5, sy: 1.7, ry: 0.4 });
    a.add(cone(5), c.glow, { sx: 0.3, sy: 1.0, x: 0.32, z: 0.2, rz: 0.3 });
    a.add(cone(5), c.ember, { sx: 0.24, sy: 0.7, x: -0.28, z: -0.18, rz: -0.35 });
    return a.build();
  },
  /**
   * Glowing seam in the floor — lava vent, frozen fissure, arcane bleed.
   * Built as a fan from a bright centre out to a *black* rim: under additive blending
   * black is transparent, so the edges dissolve. A flat textured quad here read as a
   * glowing playing card lying on the flagstones.
   */
  vent(c) {
    const N = 22;
    const pos = [0, 0.04, 0], col = [1, 1, 1], idx = [], uv = [0.5, 0.5];
    const hot = new THREE.Color(c.ember);
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      const rx = Math.cos(a) * 1.5 * (0.88 + 0.14 * Math.sin(a * 2.3));
      const rz = Math.sin(a) * 1.0 * (0.88 + 0.14 * Math.cos(a * 1.7));
      pos.push(rx, 0.04, rz);
      col.push(0, 0, 0);
      uv.push(0, 0);
      if (i > 0) idx.push(0, i, i + 1 > N ? 1 : i + 1);
    }
    for (let i = 0; i < 3; i++) col[i] = [hot.r, hot.g, hot.b][i];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  },
};

// ---------------------------------------------------------------------------
export function propGeo(name, colors) {
  const f = SOLID[name];
  return f ? f(colors) : null;
}
export function glowGeo(name, colors) {
  const f = GLOW[name];
  return f ? f(colors) : null;
}
export const SOLID_NAMES = Object.keys(SOLID);
export const GLOW_NAMES = Object.keys(GLOW);
export { Acc as GeoAcc, paint as paintGeo };
