import * as THREE from 'three';
import { OrcRig } from './rig.js';

/**
 * Procedural orc models.
 *
 * Three constraints drive this file, in this order:
 *
 * 1. **Draw calls, not triangles, are the budget.** Every part is *baked* into one of five
 *    animated nodes (torso, two arms, two legs) in a merged buffer with vertex colours, so
 *    one orc is 5 draw calls near and 1 far, whatever it is made of. Geometry is cached per
 *    archetype, so 250 grunts share the same five buffers. Measured on a full 250-orc wave
 *    with every body in frame at once: 1594 draw calls, 494k triangles, 9.1 ms/frame. The
 *    triangles are close to free; the draw calls are the whole cost. **Spend triangles.**
 *
 * 2. **Silhouette is the identity, but detail is not optional.** At a 50° camera and the
 *    closest legal zoom a standard orc is only ~50px tall, so footprint, shoulder mass and
 *    whatever breaks the outline above the shoulder line (banners, wings, horns, tusks,
 *    ears, weapon heads) still carry the read in a crowd. What changed is the other end:
 *    these models are also inspected at 200–400px, and there they have to reward it. The
 *    previous build did the opposite — it looked better far away, because distance hid the
 *    fact that there was nothing there. Faceless boxes were the problem, not low-poly.
 *
 * 3. **Nothing is a plain rectangular prism.** Limbs are 6-gons, skulls and boots are
 *    hip-roofed, fists and bellies are chamfered at both ends, blades carry a bright edge
 *    strip. `bake()` adds a vertical gradient and a normal bias on top, so form is visible
 *    even when the scene lighting is doing nothing for it.
 *
 * Cost today: ~1180 triangles for a standard orc near, ~660 far, 1506 for the Orc King.
 * The far LOD drops every part flagged `det: 1`, so the distant crowd — which is most of a
 * big wave — is cheaper than it was before the detail pass, not more expensive.
 *
 * Frame convention: origin at the feet, +Y up, +Z forward (facing), 1 unit = 1 metre.
 */

/* ============================ shared materials ============================ */

/**
 * Everything renders from one standard material with vertex colours. `aMat` carries two
 * extra per-vertex floats — emissive strength and "metalness-ness" — so glowing eyes and
 * steel plate can live in the same merged buffer as skin without a second draw call.
 */
function patchShader(s) {
  s.vertexShader = s.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec2 aMat;\nvarying vec2 vMat;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvMat = aMat;');
  s.fragmentShader = s.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vMat;')
    // Metalness stays low on purpose: the level has no environment map, so a truly
    // metallic surface has nothing to reflect and renders black. 0.35 + low roughness
    // gives the specular kick of steel while keeping the diffuse colour readable.
    .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n\troughnessFactor = mix(roughnessFactor, 0.28, vMat.y);')
    .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\n\tmetalnessFactor = mix(metalnessFactor, 0.35, vMat.y);')
    .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += vColor.rgb * vMat.x * 2.2;');
}

function makeMat(params, key) {
  const m = new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 0.86, metalness: 0.0, ...params,
  });
  m.onBeforeCompile = patchShader;
  m.customProgramCacheKey = () => 'orc' + key;
  return m;
}

/** The default skin. One instance for the entire horde. */
export const ORC_MAT = makeMat({}, 'base');

/**
 * Hit flash. Swapping to a whole different material is free (no clone, no per-frame
 * allocation) and reads far better than tinting one emissive channel: the orc becomes a
 * solid slug of light for two frames, which is the clearest damage feedback there is.
 */
const FLASH_MATS = {
  default: makeMat({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 2.4 }, 'f0'),
  fire: makeMat({ color: 0x000000, emissive: 0xff7a22, emissiveIntensity: 2.6 }, 'f1'),
  ice: makeMat({ color: 0x000000, emissive: 0x7fd4ff, emissiveIntensity: 2.4 }, 'f2'),
  poison: makeMat({ color: 0x000000, emissive: 0x88ff44, emissiveIntensity: 2.4 }, 'f3'),
  lightning: makeMat({ color: 0x000000, emissive: 0xbfd8ff, emissiveIntensity: 2.8 }, 'f4'),
  arcane: makeMat({ color: 0x000000, emissive: 0xc06aff, emissiveIntensity: 2.4 }, 'f5'),
  crush: makeMat({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 2.4 }, 'f0'),
};
/** Stealth units render as a dim ghost until they commit to an attack. */
const STEALTH_MAT = makeMat({ transparent: true, opacity: 0.26, depthWrite: false, color: 0x5a6a8a }, 'st');

/* ============================ primitive sources ============================ */

/**
 * A prism whose *flats* — not its corners — span one unit, so `w`/`d` mean the same thing
 * for a 4-gon as for a box and an authored part can be swapped between them without
 * re-tuning. `rTop`/`rBot` taper it. Triangle cost is `4n - 4`: a 4-gon is 12 (the price of
 * a box, but it can taper), a 6-gon 20, an 8-gon 28.
 *
 * Round-ish limbs are the cheapest cure for the "Lego brick" read there is. A box limb
 * shows the camera two tones; a 6-gon shows five, so the arm has a highlight, a body and a
 * terminator on it at all times and reads as a cylinder of muscle instead of a batten.
 */
function prism(n, rTop = 1, rBot = 1, phase = 0) {
  const g = new THREE.CylinderGeometry(0.5 * rTop, 0.5 * rBot, 1, n);
  if (phase) g.rotateY(phase);
  const k = 1 / Math.cos(Math.PI / n);   // circumradius -> apothem, so flat-to-flat is 1
  g.scale(k, 1, k);
  return g;
}

/**
 * A stack of rectangular rings lofted into a solid. This is what turns a cube into a
 * *form*: three levels gives a hip-roofed block whose top is four sloping facets plus a
 * cap, so from a 50° camera — which sees mostly the tops of things — one part reads as five
 * different tones instead of one flat lid. That single change is most of the difference
 * between a head and a brick.
 */
function loft(levels) {
  const pos = [], idx = [];
  const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
  for (const L of levels) for (const [sx, sz] of CORNERS) pos.push(sx * L.hx, L.y, sz * L.hz);
  for (let l = 0; l < levels.length - 1; l++) {
    for (let c = 0; c < 4; c++) {
      const a = l * 4 + c, b = l * 4 + (c + 1) % 4;
      idx.push(a, a + 4, b + 4, a, b + 4, b);
    }
  }
  idx.push(0, 1, 2, 0, 2, 3);                       // bottom cap (faces -Y)
  const t = (levels.length - 1) * 4;
  idx.push(t, t + 2, t + 1, t, t + 3, t + 2);       // top cap (faces +Y)
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Flat shading derives its normals from screen-space derivatives, so vertices can be shared
// freely — every primitive here is indexed and none of them pays for a split seam.
const SRC = {
  box: new THREE.BoxGeometry(1, 1, 1),
  oct: new THREE.OctahedronGeometry(0.5, 0),
  pyr: new THREE.ConeGeometry(0.5, 1, 4),        // 6 tris — tusks, claws, spikes, ears
  spike: new THREE.ConeGeometry(0.5, 1, 5),      // 8 tris
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 5),
  ico: new THREE.IcosahedronGeometry(0.5, 0),
  p4: prism(4, 0.78, 1, Math.PI / 4),            // 12 — tapered block, narrow at the top
  p4up: prism(4, 1, 0.74, Math.PI / 4),          // 12 — tapered block, wide at the top
  p6: prism(6, 0.86, 1),                         // 20 — limb segment
  p8: prism(8, 1, 1, Math.PI / 8),               // 28 — chamfered block: helms, pauldrons
  // Axis along +Z, wide at the back: muzzles, jaws, boot toes, blade tips.
  snout: prism(4, 0.68, 1, Math.PI / 4).rotateX(Math.PI / 2),
  // 20 tris. Skulls, boots, shoulders, anything whose top face the camera stares at.
  roof: loft([{ y: -0.5, hx: 0.5, hz: 0.5 }, { y: 0.14, hx: 0.5, hz: 0.5 }, { y: 0.5, hx: 0.33, hz: 0.33 }]),
  // 28 tris. Chamfered top *and* bottom — fists, bellies, gems, drums.
  gem: loft([
    { y: -0.5, hx: 0.33, hz: 0.33 }, { y: -0.28, hx: 0.5, hz: 0.5 },
    { y: 0.28, hx: 0.5, hz: 0.5 }, { y: 0.5, hx: 0.33, hz: 0.33 },
  ]),
};
for (const g of Object.values(SRC)) if (!g.attributes.normal) g.computeVertexNormals();

/** Multiply a hex colour. The whole palette system is this one function. */
function shade(hex, k) {
  const r = Math.min(255, Math.round(((hex >> 16) & 255) * k));
  const g = Math.min(255, Math.round(((hex >> 8) & 255) * k));
  const b = Math.min(255, Math.round((hex & 255) * k));
  return (r << 16) | (g << 8) | b;
}

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

const NODES = ['torso', 'armL', 'armR', 'legL', 'legR', 'wingL', 'wingR'];

/**
 * Part collector. Parts are authored in *body space* (origin at the feet) whatever node
 * they belong to — the kit subtracts the node pivot — so a whole orc can be laid out in
 * one coordinate frame instead of five nested ones.
 */
class Kit {
  /**
   * `flat` routes every part into one buffer — that is the distant LOD, one draw call.
   * It also raises `lod`, which drops every part authored with `det: 1`. Detail parts are
   * the ones that only exist for the close camera (rivets, nostrils, knuckles, edge
   * highlights); the silhouette — horns, tusks, ears, weapon heads, banners — always
   * survives, because that is the only thing a 20-pixel orc has left to be recognised by.
   */
  constructor(flat = false) {
    this.flat = flat;
    this.lod = flat ? 1 : 0;
    this.href = 1.8;          // model height, for the baked vertical light gradient
    this.pivots = {};
    this.buf = {};
    for (const n of NODES) this.buf[n] = { pos: [], nor: [], col: [], mat: [], idx: [], v: 0 };
  }

  /** State a joint explicitly. Must precede the first part on that node. */
  pivot(node, p) { if (!this.flat) this.pivots[node] = p; return this; }

  /** o: { x,y,z, w,h,d, rx,ry,rz, c, e, m, det } — position/size in body space, c = hex. */
  add(node, src, o) {
    if (this.lod && o.det) return this;
    if (this.flat) node = 'torso';
    // A node with no stated pivot falls back to inferring one from its first part, so the
    // gear helpers can attach to an arm without knowing where its shoulder ended up.
    const p = this.pivots[node] || (this.pivots[node] = pivotFor(node, o));
    _e.set(o.rx || 0, o.ry || 0, o.rz || 0);
    _q.setFromEuler(_e);
    _v.set((o.x || 0) - p.x, (o.y || 0) - p.y, (o.z || 0) - p.z);
    _s.set(o.w ?? 1, o.h ?? o.w ?? 1, o.d ?? o.w ?? 1);
    _m.compose(_v, _q, _s);
    bake(this.buf[node], src, _m, o.c ?? 0x808080, o.e || 0, o.m || 0, this.href);
    return this;
  }

  box(n, o) { return this.add(n, SRC.box, o); }
  oct(n, o) { return this.add(n, SRC.oct, o); }
  pyr(n, o) { return this.add(n, SRC.pyr, o); }
  spike(n, o) { return this.add(n, SRC.spike, o); }
  cyl(n, o) { return this.add(n, SRC.cyl, o); }
  ico(n, o) { return this.add(n, SRC.ico, o); }
  p4(n, o) { return this.add(n, SRC.p4, o); }
  p4up(n, o) { return this.add(n, SRC.p4up, o); }
  p6(n, o) { return this.add(n, SRC.p6, o); }
  p8(n, o) { return this.add(n, SRC.p8, o); }
  roof(n, o) { return this.add(n, SRC.roof, o); }
  gem(n, o) { return this.add(n, SRC.gem, o); }
  snout(n, o) { return this.add(n, SRC.snout, o); }
  /** Mirrored pair — `fn(side)` is called with +1 then -1. */
  pair(fn) { fn(1); fn(-1); return this; }
}

const ZERO = { x: 0, y: 0, z: 0 };

/**
 * Bake one part into a node buffer, tinting it as it goes.
 *
 * The tint is the cheapest lighting in the project and it is doing real work. Two terms,
 * both free (they are vertex colours the material already multiplies into albedo):
 *
 *  - **vertical gradient** — 0.80 at the feet rising to 1.04 at the crown. Reads as
 *    ambient occlusion pooling in the legs and sky light landing on the head, which
 *    grounds the orc and stops the body being one continuous slab of the same green.
 *  - **normal bias** — up-facing faces gain, down-facing faces lose a fifth. This is what
 *    makes a chamfer visible: the roof facets of a skull now differ from its walls even
 *    when the scene light is doing nothing at all, which was the exact failure mode when
 *    close-up frames came back looking like untextured blocks.
 *
 * Emissive parts opt out — the shader multiplies `vColor` by the emissive strength, so
 * shading an eye chip would shade the light coming out of it.
 */
function bake(dst, src, m, color, emis, metal, href = 1.8) {
  const pa = src.attributes.position, na = src.attributes.normal;
  const n = pa.count, base = dst.v;
  _nm.getNormalMatrix(m);
  _c.setHex(color);
  for (let i = 0; i < n; i++) {
    _v.fromBufferAttribute(pa, i).applyMatrix4(m);
    dst.pos.push(_v.x, _v.y, _v.z);
    _n.fromBufferAttribute(na, i).applyMatrix3(_nm).normalize();
    dst.nor.push(_n.x, _n.y, _n.z);
    let k = 1;
    if (!emis) {
      k = (0.80 + 0.24 * clamp01(_v.y / href)) * (1 + (_n.y > 0 ? 0.07 * _n.y : 0.21 * _n.y));
    }
    dst.col.push(_c.r * k, _c.g * k, _c.b * k);
    dst.mat.push(emis, metal);
  }
  const idx = src.index;
  if (idx) for (let i = 0; i < idx.count; i++) dst.idx.push(base + idx.getX(i));
  else for (let i = 0; i < n; i++) dst.idx.push(base + i);
  dst.v += n;
}

function finish(buf) {
  if (!buf.v) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
  g.setAttribute('aMat', new THREE.Float32BufferAttribute(buf.mat, 2));
  g.setIndex(buf.idx);
  g.computeBoundingSphere();
  return g;
}

/* ============================ the common frame ============================ */

/**
 * The shared orc skeleton. Proportions are deliberately *not* human: legs are 45% of the
 * height, the torso is a wedge that widens at the shoulders, and the head is oversized and
 * sunk between them. That top-heavy read is the thing that says "orc" from above.
 */
function humanoid(K, o) {
  const {
    h = 1.8, bulk = 1, skin = 0x6f8f4c, cloth = 0x5a4632, dark = 0x2e2620,
    bone = 0xd8cfb4, glow = 0xffcf3a, hunch = 0.22, headScale = 1,
    tusks = 2, browRidge = true, digitigrade = false, legThick = 1, plain = false,
    armLen = 1, ears = 1, hair = 'topknot', tuskLen = 1, kilt = true,
  } = o;
  K.href = h;
  // Crown of the skull, for anything that needs to float above the *body* — health bars,
  // status icons. Deliberately not the mesh bounding box: a war chanter's banner and a
  // warlord's greatsword are two metres of the bounding box that nothing should hang off.
  K.bodyTop = h * 1.02;
  const s = h / 1.8, hs = headScale;

  // One palette, five values, derived from two authored colours. Archetypes state a skin
  // and a cloth; every highlight, crease and strap tone falls out of them, which is what
  // keeps twenty-one models looking like one army instead of twenty-one experiments.
  const skinLit = shade(skin, 1.22), skinDk = shade(skin, 0.74), skinDp = shade(skin, 0.5);
  const clothDk = shade(cloth, 0.72);
  const leather = shade(dark, 1.5), leatherDk = shade(dark, 0.95);

  const hipY = h * (digitigrade ? 0.46 : 0.44);
  const dy = hipY - 0.44 * h;          // torso rides with the hips on digitigrade legs
  const shoulderY = h * 0.79 + dy;
  const shoulderX = 0.255 * h * bulk;
  const hipX = 0.108 * h * bulk;
  const headY = h * 0.925 + dy;
  const armAt = (f) => shoulderY - f * armLen * h;

  K.pivot('torso', { x: 0, y: hipY + 0.02 * h, z: 0 });
  K.pivot('armR', { x: shoulderX, y: shoulderY, z: 0 });
  K.pivot('armL', { x: -shoulderX, y: shoulderY, z: 0 });
  K.pivot('legR', { x: hipX, y: hipY, z: 0 });
  K.pivot('legL', { x: -hipX, y: hipY, z: 0 });

  // --- torso: pelvis, belt, gut, ribcage, yoke — five masses, not one box -------------
  // The belt is the important one. A single unbroken column from hip to neck is what makes
  // a low-poly humanoid read as furniture; one hard dark band across the middle at a
  // different width to everything above and below it reads as a waist from any distance.
  K.p4('torso', { x: 0, y: 0.47 * h + dy, z: 0.005 * h, w: 0.295 * h * bulk, h: 0.125 * h, d: 0.21 * h * bulk, rx: hunch * 0.3, c: clothDk });
  if (kilt && !plain) {
    // Three hanging panels of different lengths. Costs 36 triangles and buys an irregular,
    // slightly asymmetric hem — the outline stops being a machined rectangle.
    const panel = [[-0.105, 0.155], [0.0, 0.19], [0.105, 0.14]];
    for (const [px, len] of panel) {
      K.box('torso', { x: px * h * bulk, y: (0.44 - len * 0.5) * h + dy, z: 0.1 * h * bulk, w: 0.1 * h * bulk, h: len * h, d: 0.045 * h, rx: hunch * 0.2, c: cloth, det: 1 });
    }
    K.box('torso', { x: 0, y: (0.44 - 0.09) * h + dy, z: -0.1 * h * bulk, w: 0.24 * h * bulk, h: 0.17 * h, d: 0.04 * h, c: clothDk, det: 1 });
  }
  K.box('torso', { x: 0, y: 0.535 * h + dy, z: 0.005 * h, w: 0.322 * h * bulk, h: 0.05 * h, d: 0.228 * h * bulk, c: leather });
  K.box('torso', { x: 0, y: 0.535 * h + dy, z: 0.12 * h * bulk, w: 0.072 * h, h: 0.058 * h, d: 0.028 * h, c: 0xb8a25a, m: 0.9, det: 1 });
  K.gem('torso', { x: 0, y: 0.60 * h + dy, z: 0.015 * h, w: 0.285 * h * bulk, h: 0.105 * h, d: 0.205 * h * bulk, rx: hunch * 0.6, c: plain ? clothDk : skinDk, det: 1 });
  // Ribcage flares upward into the shoulders: the classic top-heavy orc wedge.
  K.p4up('torso', { x: 0, y: 0.715 * h + dy, z: 0.025 * h, w: 0.39 * h * bulk, h: 0.155 * h, d: 0.26 * h * bulk, rx: hunch, c: plain ? cloth : skin });
  if (!plain) {
    K.pair((sx) => K.p4('torso', { x: sx * 0.098 * h * bulk, y: 0.752 * h + dy, z: 0.115 * h * bulk, w: 0.155 * h * bulk, h: 0.075 * h, d: 0.07 * h, rx: hunch - 0.3, c: skinLit, det: 1 }));
    // Crossed bandoliers. Two thin angled boxes; the value break they put across a big
    // flat chest is worth far more than the 24 triangles they cost.
    K.box('torso', { x: 0.01 * h, y: 0.70 * h + dy, z: 0.105 * h * bulk, w: 0.45 * h, h: 0.05 * h, d: 0.28 * h, rz: 0.6, rx: hunch, c: leather, det: 1 });
    K.box('torso', { x: -0.01 * h, y: 0.665 * h + dy, z: 0.105 * h * bulk, w: 0.43 * h, h: 0.04 * h, d: 0.27 * h, rz: -0.46, rx: hunch, c: leatherDk, det: 1 });
  }
  K.p4('torso', { x: 0, y: 0.72 * h + dy, z: -0.105 * h * bulk, w: 0.33 * h * bulk, h: 0.18 * h, d: 0.07 * h, rx: hunch, c: plain ? clothDk : skinDk, det: 1 });
  // Trapezius wedges. From directly above these are the whole upper body: two sloping
  // masses with the neck sunk in the notch between them. Without them the camera sees a
  // rectangle with a head glued to it.
  K.pair((sx) => K.p4('torso', {
    x: sx * 0.135 * h * bulk, y: 0.80 * h + dy, z: 0.0, w: 0.185 * h * bulk, h: 0.075 * h,
    d: 0.205 * h * bulk, rz: -sx * 0.38, rx: hunch * 0.7, c: skinLit,
  }));

  // --- head ---------------------------------------------------------------------------
  // Built as cranium + brow + muzzle + jaw rather than one block. The point is the top
  // view: a keyhole (wide skull, narrow snout) with two tusks and two ears breaking the
  // outline is legible at 40 pixels, and a rectangle is not.
  K.p6('torso', { x: 0, y: 0.848 * h + dy, z: 0.015 * h, w: 0.115 * h * hs, h: 0.055 * h, d: 0.12 * h * hs, c: skinDk, det: 1 });
  K.roof('torso', { x: 0, y: headY, z: 0.03 * h * hs, w: 0.205 * h * hs, h: 0.15 * h * hs, d: 0.195 * h * hs, rx: -0.08, c: skin });
  if (browRidge) {
    K.box('torso', { x: 0, y: headY + 0.028 * h * hs, z: 0.10 * h * hs, w: 0.215 * h * hs, h: 0.048 * h * hs, d: 0.08 * h * hs, rx: -0.34, c: skinDk, det: 1 });
  }
  // Eye sockets and chips are pitched back 0.55 rad so their faces point up-and-forward,
  // straight into a 50° camera. Flat-on-the-front eyes are invisible from this angle,
  // which is why the orcs have been reading as faceless.
  K.pair((sx) => {
    K.box('torso', { x: sx * 0.055 * h * hs, y: headY - 0.004 * h * hs, z: 0.122 * h * hs, w: 0.078 * h * hs, h: 0.055 * h * hs, d: 0.05 * h * hs, rx: -0.55, c: skinDp, det: 1 });
    // e: 0.45, not the 2.6 this used to run at. The shader multiplies the vertex colour by
    // 2.2, and bloom multiplies whatever comes out of that, so a bright chip at the old
    // strength stopped being an eye and became a white blob with a head somewhere behind
    // it. The face was there the whole time; the glow was erasing it.
    //
    // 0.3 was a stopgap taken while the bloom pass was over-hot; ENGINE has since retuned
    // it (blown pixels 0.71% -> 0.18% of frame) and measured that moving this value across
    // 0.30–0.55 shifts campaign blown pixels by 0.025pp — i.e. the eyes are not a
    // highlight-budget item and this is purely a legibility call. 0.45 puts the max channel
    // at 0.99 linear, deliberately just *under* the 1.10 floor the torch/rune glow family
    // sits at: an eye is a ~2px chip inside a ~15px head and has no quad to fall off
    // across, so it must stay below bloom threshold or it re-erases the brow and tusks
    // that were the whole point of round 2. Verified on an 80-orc crowd at gameplay zoom.
    K.box('torso', { x: sx * 0.055 * h * hs, y: headY - 0.002 * h * hs, z: 0.145 * h * hs, w: 0.056 * h * hs, h: 0.036 * h * hs, d: 0.025 * h * hs, rx: -0.55, c: glow, e: 0.45 });
    K.box('torso', { x: sx * 0.055 * h * hs, y: headY - 0.004 * h * hs, z: 0.158 * h * hs, w: 0.016 * h * hs, h: 0.03 * h * hs, d: 0.012 * h * hs, rx: -0.55, c: 0x140a06, det: 1 });
  });
  K.snout('torso', { x: 0, y: headY - 0.05 * h * hs, z: 0.155 * h * hs, w: 0.145 * h * hs, h: 0.10 * h * hs, d: 0.15 * h * hs, rx: 0.1, c: skin });
  K.box('torso', { x: 0, y: headY - 0.012 * h * hs, z: 0.222 * h * hs, w: 0.082 * h * hs, h: 0.022 * h * hs, d: 0.03 * h * hs, c: skinDp, det: 1 });
  K.p4('torso', { x: 0, y: headY - 0.107 * h * hs, z: 0.142 * h * hs, w: 0.152 * h * hs, h: 0.062 * h * hs, d: 0.15 * h * hs, rx: 0.1, c: skinDk, det: 1 });
  // Tusks grow *up* from the lower jaw, splayed outward. Upward is the whole trick: a
  // downward fang is hidden under the muzzle from above, an upward one breaks the head's
  // outline on both sides and is the single clearest "orc" signal in the silhouette.
  for (let i = 0; i < tusks; i++) {
    const sx = i % 2 === 0 ? 1 : -1;
    const row = i < 2 ? 0 : 1;
    K.pyr('torso', {
      x: sx * (0.062 + row * 0.028) * h * hs, y: headY - (0.072 + row * 0.012) * h * hs,
      z: (0.175 - row * 0.055) * h * hs, w: (0.042 - row * 0.012) * h * hs,
      h: (0.115 - row * 0.04) * h * hs * tuskLen, d: (0.042 - row * 0.012) * h * hs,
      rz: sx * (0.3 + row * 0.15), rx: -0.14, c: bone,
    });
  }
  // Ears: thin blades angled out and back. Two triangles poking past the skull is what
  // stops the top view being a box, and it costs six triangles each.
  if (ears) {
    K.pair((sx) => K.pyr('torso', {
      x: sx * 0.108 * h * hs, y: headY + 0.012 * h * hs, z: -0.012 * h * hs,
      w: 0.055 * h * hs, h: (0.115 + 0.07 * (ears - 1)) * h * hs, d: 0.018 * h * hs,
      rz: sx * 1.32, ry: -sx * 0.34, rx: -0.1, c: skinDk,
    }));
  }
  headHair(K, { h, hs, dy, headY, hair, dark, skinDk, bone, cloth });

  // --- arms: deltoid, taper, elbow, flared forearm, fist -------------------------------
  // Short and thick on purpose: a long arm on a rigid rig reads as a hanging tube. What is
  // new is that none of the five segments is a rectangular prism — the shoulder is an
  // octahedron, the two long bones are 6-gons that taper into each other, and the joint
  // between them is a band in a different value, so the arm has an elbow you can find.
  K.pair((sx) => {
    const node = sx > 0 ? 'armR' : 'armL';
    const ax = sx * shoulderX;
    K.oct(node, { x: ax, y: shoulderY - 0.005 * h, z: 0, w: 0.185 * h * bulk, h: 0.155 * h, d: 0.185 * h * bulk, c: skinLit });
    K.p6(node, { x: ax + sx * 0.006 * h, y: armAt(0.09), z: 0.004 * h, w: 0.142 * h * bulk, h: 0.17 * h * armLen, d: 0.142 * h * bulk, rz: sx * 0.09, c: skin });
    K.box(node, { x: ax + sx * 0.011 * h, y: armAt(0.175), z: 0.018 * h, w: 0.152 * h * bulk, h: 0.05 * h, d: 0.155 * h * bulk, c: leather, det: 1 });
    K.p6(node, { x: ax + sx * 0.013 * h, y: armAt(0.245), z: 0.042 * h, w: 0.134 * h * bulk, h: 0.16 * h * armLen, d: 0.134 * h * bulk, rx: -0.3, c: skin });
    K.box(node, { x: ax + sx * 0.014 * h, y: armAt(0.315), z: 0.075 * h, w: 0.142 * h * bulk, h: 0.032 * h, d: 0.145 * h * bulk, rx: -0.3, c: leatherDk, det: 1 });
    K.gem(node, { x: ax + sx * 0.014 * h, y: armAt(0.362), z: 0.098 * h, w: 0.148 * h * bulk, h: 0.115 * h, d: 0.142 * h, c: skin });
    K.box(node, { x: ax - sx * 0.06 * h * bulk, y: armAt(0.352), z: 0.108 * h, w: 0.045 * h, h: 0.058 * h, d: 0.075 * h, rz: sx * 0.5, c: skinLit, det: 1 });
  });

  // --- legs: thigh, knee, shin, and a boot with toes -----------------------------------
  const legLen = hipY;
  K.pair((sx) => {
    const node = sx > 0 ? 'legR' : 'legL';
    const lx = sx * hipX;
    K.p6(node, { x: lx, y: hipY - legLen * 0.27, z: digitigrade ? -0.025 * h : 0, w: 0.158 * h * bulk * legThick, h: legLen * 0.56, d: 0.175 * h * legThick, rx: digitigrade ? 0.5 : 0.05, c: cloth });
    K.box(node, { x: lx, y: hipY - legLen * 0.16, z: digitigrade ? -0.03 * h : 0.005 * h, w: 0.168 * h * bulk * legThick, h: 0.042 * h, d: 0.185 * h * legThick, rx: digitigrade ? 0.5 : 0.05, c: leather, det: 1 });
    K.oct(node, { x: lx, y: legLen * 0.47, z: 0.012 * h, w: 0.142 * h * legThick, h: 0.1 * h, d: 0.145 * h * legThick, c: leatherDk, det: 1 });
    K.p6(node, { x: lx, y: legLen * 0.25, z: digitigrade ? 0.035 * h : -0.004 * h, w: 0.126 * h * legThick, h: legLen * 0.46, d: 0.135 * h * legThick, rx: digitigrade ? -0.55 : -0.05, c: skin });
    // Boot: a roofed block, so its top is four facets rather than one grey lid, plus a
    // separate toe box and three claws. Feet are the part of an orc a top-down camera sees
    // most completely, and until now they were a flat slab.
    K.roof(node, { x: lx, y: 0.048 * h, z: 0.02 * h, w: 0.16 * h * legThick, h: 0.096 * h, d: 0.2 * h, c: leatherDk });
    K.snout(node, { x: lx, y: 0.032 * h, z: 0.135 * h, w: 0.148 * h * legThick, h: 0.064 * h, d: 0.1 * h, c: leather, det: 1 });
    for (let i = -1; i <= 1; i++) {
      K.pyr(node, { x: lx + i * 0.045 * h * legThick, y: 0.026 * h, z: 0.185 * h, w: 0.032 * h, h: 0.055 * h, d: 0.032 * h, rx: 1.5, rz: i * 0.25, c: bone, det: 1 });
    }
  });

  return { s, hipY, shoulderY, shoulderX, headY, skinLit, skinDk, skinDp, leather, leatherDk, dy };
}

/**
 * Hair, and the reason it exists: from directly overhead the crown of the skull is the
 * largest single surface on the model. Leaving it bare wastes the most-seen pixels an orc
 * has, and every archetype sharing the same bare crown is a large part of why a crowd used
 * to read as one repeated object.
 */
function headHair(K, { h, hs, headY, hair, dark, skinDk, bone, cloth }) {
  if (!hair || hair === 'bald') return;
  if (hair === 'topknot') {
    K.box('torso', { x: 0, y: headY + 0.082 * h * hs, z: -0.005 * h, w: 0.115 * h * hs, h: 0.045 * h, d: 0.115 * h * hs, c: dark });
    K.p4('torso', { x: 0, y: headY + 0.15 * h * hs, z: -0.06 * h, w: 0.075 * h * hs, h: 0.17 * h, d: 0.075 * h * hs, rx: -0.5, c: shade(dark, 1.3) });
    K.pyr('torso', { x: 0, y: headY + 0.24 * h * hs, z: -0.115 * h, w: 0.06 * h * hs, h: 0.09 * h, d: 0.06 * h * hs, rx: -0.5, c: dark, det: 1 });
  } else if (hair === 'mohawk') {
    for (let i = -2; i <= 2; i++) {
      K.pyr('torso', {
        x: 0, y: headY + 0.085 * h * hs, z: (-0.055 + i * 0.033) * h * hs,
        w: 0.035 * h * hs, h: (0.16 - Math.abs(i) * 0.035) * h * hs, d: 0.05 * h * hs,
        rx: -0.22, c: i % 2 ? dark : shade(dark, 1.35),
      });
    }
  } else if (hair === 'mane') {
    for (let i = 0; i < 4; i++) {
      K.pyr('torso', {
        x: 0, y: headY + (0.06 - i * 0.035) * h * hs, z: (-0.06 - i * 0.05) * h * hs,
        w: (0.13 - i * 0.02) * h * hs, h: (0.15 - i * 0.02) * h * hs, d: 0.05 * h * hs,
        rx: -0.75, c: i % 2 ? dark : shade(dark, 1.3),
      });
    }
  } else if (hair === 'braids') {
    K.box('torso', { x: 0, y: headY + 0.075 * h * hs, z: -0.02 * h, w: 0.2 * h * hs, h: 0.04 * h, d: 0.18 * h * hs, c: dark });
    K.pair((sx) => {
      K.p4('torso', { x: sx * 0.105 * h * hs, y: headY - 0.05 * h * hs, z: -0.05 * h * hs, w: 0.05 * h * hs, h: 0.18 * h * hs, d: 0.05 * h * hs, rz: sx * 0.2, c: dark });
      K.oct('torso', { x: sx * 0.125 * h * hs, y: headY - 0.14 * h * hs, z: -0.06 * h * hs, w: 0.055 * h * hs, c: bone, det: 1 });
    });
  } else if (hair === 'hood') {
    K.roof('torso', { x: 0, y: headY + 0.035 * h * hs, z: -0.005 * h * hs, w: 0.245 * h * hs, h: 0.19 * h * hs, d: 0.235 * h * hs, rx: -0.06, c: cloth });
    K.pyr('torso', { x: 0, y: headY + 0.12 * h * hs, z: -0.1 * h * hs, w: 0.11 * h * hs, h: 0.16 * h * hs, d: 0.09 * h * hs, rx: -0.9, c: shade(cloth, 0.8), det: 1 });
  } else if (hair === 'wraps') {
    K.box('torso', { x: 0, y: headY + 0.05 * h * hs, z: 0.01 * h, w: 0.215 * h * hs, h: 0.055 * h, d: 0.2 * h * hs, rz: 0.12, c: cloth });
    K.box('torso', { x: 0, y: headY + 0.005 * h * hs, z: -0.02 * h, w: 0.21 * h * hs, h: 0.05 * h, d: 0.19 * h * hs, rz: -0.1, c: shade(cloth, 0.8), det: 1 });
  }
}

/* ============================ weapons & gear ============================ */

/**
 * Weapons are carried *up*, over the shoulder, not hanging at the hip. From a top-down
 * camera a lowered weapon disappears behind the body; a shouldered one breaks the
 * outline above the shoulder line, which is where all the readable silhouette lives.
 * The hand sits at roughly (±0.48, 0.68, 0.2) on a 1.8m orc, so hafts run up and back
 * from there.
 */
/**
 * Every blade in this file gets a **bright edge strip**: a thin box in a lighter metal laid
 * along the cutting edge. It is the single highest-value trick here. Flat-shaded steel in a
 * dim room is a grey quadrilateral and reads as cardboard; a hard bright line down one side
 * of that quadrilateral reads as a sharpened edge at any distance and under any light,
 * because it does not depend on the light at all. Twelve triangles, and it is the
 * difference between "carrying something" and "carrying an axe".
 */
function edgeStrip(K, node, o) { K.box(node, { ...o, m: 1, det: 1 }); }

/** A wrapped grip: two dark bands. Breaks a plain shaft into a handle and a haft. */
function grip(K, node, hx, y0, z0, w, rx, c) {
  for (let i = 0; i < 2; i++) {
    K.box(node, { x: hx, y: y0 - i * 0.09, z: z0 + i * 0.032, w: w * 1.22, h: 0.045, d: w * 1.22, rx, c, det: 1 });
  }
}

function axe(K, o, side = 1) {
  const { h = 1.8, metal = 0x9aa2ad } = o;
  const node = side > 0 ? 'armR' : 'armL';
  const hx = side * 0.285 * h;
  const wood = 0x4a3524, woodDk = 0x2b1e13, steelDk = shade(metal, 0.62), edge = shade(metal, 1.5);
  // Haft over the shoulder. A 6-gon, so it is a pole and not a batten.
  K.p6(node, { x: hx, y: h * 0.565, z: -0.005 * h, w: 0.052 * h, h: 0.64 * h, d: 0.052 * h, rx: 0.34, c: wood });
  grip(K, node, hx, h * 0.40, 0.055 * h, 0.052 * h, 0.34, woodDk);
  K.pyr(node, { x: hx, y: h * 0.235, z: 0.12 * h, w: 0.05 * h, h: 0.1 * h, d: 0.05 * h, rx: Math.PI + 0.34, c: steelDk, m: 1, det: 1 });
  // Head: socket, a broad cheek, two horns and a bright arc down the outer edge.
  K.p8(node, { x: hx, y: h * 0.80, z: -0.085 * h, w: 0.082 * h, h: 0.17 * h, d: 0.082 * h, rx: 0.34, c: steelDk, m: 1 });
  const bx = hx + side * 0.125 * h;
  K.p4(node, { x: bx, y: h * 0.80, z: -0.085 * h, w: 0.25 * h, h: 0.19 * h, d: 0.042 * h, rz: side * Math.PI / 2, rx: 0.34, c: metal, m: 1 });
  K.pyr(node, { x: bx + side * 0.045 * h, y: h * 0.885, z: -0.115 * h, w: 0.14 * h, h: 0.12 * h, d: 0.042 * h, rz: -side * 0.85, rx: 0.34, c: metal, m: 1 });
  K.pyr(node, { x: bx + side * 0.045 * h, y: h * 0.715, z: -0.055 * h, w: 0.14 * h, h: 0.12 * h, d: 0.042 * h, rz: side * (Math.PI - 0.85), rx: 0.34, c: metal, m: 1 });
  edgeStrip(K, node, { x: hx + side * 0.235 * h, y: h * 0.80, z: -0.085 * h, w: 0.038 * h, h: 0.30 * h, d: 0.048 * h, rx: 0.34, c: edge });
  // Rear spike, so the head is a silhouette and not a paddle.
  K.pyr(node, { x: hx - side * 0.085 * h, y: h * 0.80, z: -0.085 * h, w: 0.055 * h, h: 0.11 * h, d: 0.055 * h, rz: -side * 1.57, rx: 0.34, c: steelDk, m: 1, det: 1 });
}

function cleaver(K, o, side = 1) {
  const { h = 1.8, metal = 0xb0b6bd } = o;
  const node = side > 0 ? 'armR' : 'armL';
  const hx = side * 0.3 * h;
  const edge = shade(metal, 1.5), dk = shade(metal, 0.55);
  // Held out to the side, blade forward: two of these read instantly as a dual-wielder.
  K.p6(node, { x: hx, y: h * 0.4, z: 0.155 * h, w: 0.04 * h, h: 0.16 * h, d: 0.04 * h, rx: Math.PI / 2, c: 0x38281c });
  K.oct(node, { x: hx, y: h * 0.4, z: 0.088 * h, w: 0.06 * h, h: 0.06 * h, d: 0.05 * h, c: dk, m: 1, det: 1 });
  K.box(node, { x: hx, y: h * 0.405, z: 0.235 * h, w: 0.05 * h, h: 0.115 * h, d: 0.06 * h, c: dk, m: 1 });   // guard
  K.p4(node, { x: hx, y: h * 0.425, z: 0.365 * h, w: 0.038 * h, h: 0.165 * h, d: 0.27 * h, rx: 0.15, c: metal, m: 1 });
  edgeStrip(K, node, { x: hx, y: h * 0.345, z: 0.375 * h, w: 0.042 * h, h: 0.032 * h, d: 0.26 * h, rx: 0.15, c: edge });
  K.pyr(node, { x: hx, y: h * 0.44, z: 0.51 * h, w: 0.15 * h, h: 0.1 * h, d: 0.04 * h, rx: -1.42, c: metal, m: 1, det: 1 });
}

function club(K, o, side = 1) {
  const { h = 1.8, dark = 0x2e2620 } = o;
  const node = side > 0 ? 'armR' : 'armL';
  const hx = side * 0.3 * h;
  const wood = shade(dark, 1.45), woodDk = shade(dark, 0.8);
  K.p6(node, { x: hx, y: h * 0.585, z: -0.03 * h, w: 0.062 * h, h: 0.62 * h, d: 0.062 * h, rx: 0.3, c: wood });
  grip(K, node, hx, h * 0.4, 0.03 * h, 0.062 * h, 0.3, woodDk);
  // Three stacked lumps of decreasing width: a knot of wood, not a rectangle.
  K.p4up(node, { x: hx, y: h * 0.845, z: -0.115 * h, w: 0.17 * h, h: 0.13 * h, d: 0.17 * h, rx: 0.3, c: wood });
  K.gem(node, { x: hx, y: h * 0.945, z: -0.147 * h, w: 0.225 * h, h: 0.16 * h, d: 0.225 * h, rx: 0.3, c: dark });
  K.roof(node, { x: hx, y: h * 1.045, z: -0.178 * h, w: 0.185 * h, h: 0.1 * h, d: 0.185 * h, rx: 0.3, c: woodDk });
  // Six nails around the head. Iron, spread in a ring, so the lump becomes a weapon.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    K.spike(node, {
      x: hx + Math.cos(a) * 0.105 * h, y: h * 0.945 + Math.sin(a) * 0.052 * h,
      z: -0.147 * h + Math.sin(a) * 0.09 * h,
      w: 0.055 * h, h: 0.11 * h, d: 0.055 * h, rz: -a + Math.PI / 2, rx: 0.3, c: 0xa8a094, m: 1,
    });
  }
}

function greatsword(K, o, side = 1) {
  const { h = 1.8, metal = 0xb8bec6 } = o;
  const node = side > 0 ? 'armR' : 'armL';
  const hx = side * 0.3 * h;
  const edge = shade(metal, 1.45), dk = shade(metal, 0.5), grim = 0x3a2a22;
  K.p6(node, { x: hx, y: h * 0.45, z: 0.07 * h, w: 0.05 * h, h: 0.3 * h, d: 0.05 * h, rx: 0.3, c: grim });
  grip(K, node, hx, h * 0.50, 0.055 * h, 0.05 * h, 0.3, shade(grim, 0.7));
  K.gem(node, { x: hx, y: h * 0.315, z: 0.115 * h, w: 0.105 * h, h: 0.08 * h, d: 0.105 * h, rx: 0.3, c: dk, m: 1 });   // pommel
  // Crossguard with upturned quillons — the thing that says "sword" and not "plank".
  K.box(node, { x: hx, y: h * 0.60, z: 0.0, w: 0.2 * h, h: 0.055 * h, d: 0.07 * h, rx: 0.3, c: dk, m: 1 });
  K.pair((sx) => K.pyr(node, { x: hx + sx * 0.115 * h, y: h * 0.625, z: -0.01 * h, w: 0.05 * h, h: 0.1 * h, d: 0.05 * h, rz: sx * 0.6, rx: 0.3, c: dk, m: 1, det: 1 }));
  // Blade: bright flats either side of a dark fuller groove, then a clipped point.
  K.box(node, { x: hx, y: h * 0.95, z: -0.16 * h, w: 0.155 * h, h: 0.7 * h, d: 0.052 * h, rx: 0.3, c: metal, m: 1 });
  K.box(node, { x: hx, y: h * 0.95, z: -0.148 * h, w: 0.045 * h, h: 0.66 * h, d: 0.05 * h, rx: 0.3, c: dk, m: 1, det: 1 });
  K.pair((sx) => edgeStrip(K, node, { x: hx + sx * 0.072 * h, y: h * 0.95, z: -0.16 * h, w: 0.026 * h, h: 0.7 * h, d: 0.056 * h, rx: 0.3, c: edge }));
  K.pyr(node, { x: hx, y: h * 1.335, z: -0.283 * h, w: 0.155 * h, h: 0.22 * h, d: 0.052 * h, rx: 0.3, c: metal, m: 1 });
}

function bow(K, o, side = -1) {
  const { h = 1.8, cloth = 0x4a3a2a, bone = 0xd8cfb4 } = o;
  const node = side > 0 ? 'armR' : 'armL';
  const hx = side * 0.32 * h;
  const horn = shade(bone, 0.72);
  // Held flat across the body so the arc is visible from directly above. Recurved: each
  // limb is two segments at different angles, which is what separates a bow from a stick.
  K.p6(node, { x: hx, y: h * 0.6, z: 0.14 * h, w: 0.042 * h, h: 0.2 * h, d: 0.042 * h, rx: Math.PI / 2, c: cloth });
  K.pair((sz) => {
    K.p6(node, { x: hx, y: h * 0.6 - sz * 0.008 * h, z: 0.14 * h + sz * 0.2 * h, w: 0.036 * h, h: 0.24 * h, d: 0.036 * h, rx: Math.PI / 2 + sz * 0.28, c: horn });
    K.p6(node, { x: hx, y: h * 0.6 - sz * 0.04 * h, z: 0.14 * h + sz * 0.38 * h, w: 0.03 * h, h: 0.2 * h, d: 0.03 * h, rx: Math.PI / 2 - sz * 0.4, c: bone });
    K.pyr(node, { x: hx, y: h * 0.6 - sz * 0.035 * h, z: 0.14 * h + sz * 0.49 * h, w: 0.032 * h, h: 0.06 * h, d: 0.032 * h, rx: Math.PI / 2, c: horn, det: 1 });
  });
  // String and a nocked arrow. The string is 12 triangles and it is what makes the two
  // curved limbs read as one object under tension rather than as two loose sticks.
  K.box(node, { x: hx - side * 0.052 * h, y: h * 0.6, z: 0.14 * h, w: 0.012 * h, h: 0.012 * h, d: 0.94 * h, c: 0xd8d2c0, det: 1 });
  K.p6(node, { x: hx + side * 0.14 * h, y: h * 0.6, z: 0.14 * h, w: 0.02 * h, h: 0.38 * h, d: 0.02 * h, rz: side * Math.PI / 2, c: 0x6a5636, det: 1 });
  K.pyr(node, { x: hx + side * 0.34 * h, y: h * 0.6, z: 0.14 * h, w: 0.035 * h, h: 0.075 * h, d: 0.035 * h, rz: -side * Math.PI / 2, c: 0x9aa2ad, m: 1, det: 1 });
}

function staff(K, o, side = 1) {
  const { h = 1.8, cloth = 0x4a3a2a, glow = 0xff3b7a, bone = 0xd8cfb4 } = o;
  const node = side > 0 ? 'armR' : 'armL';
  const hx = side * 0.32 * h;
  const woodDk = shade(cloth, 0.65);
  // Gnarled: three shaft segments at slightly different angles instead of one straight
  // pole. Costs 40 triangles and removes the "broom handle" read entirely.
  K.p6(node, { x: hx, y: h * 0.2, z: 0.145 * h, w: 0.042 * h, h: 0.42 * h, d: 0.042 * h, rx: 0.06, rz: side * 0.03, c: cloth });
  K.p6(node, { x: hx + side * 0.012 * h, y: h * 0.56, z: 0.185 * h, w: 0.046 * h, h: 0.34 * h, d: 0.046 * h, rx: 0.16, rz: -side * 0.05, c: woodDk });
  K.p6(node, { x: hx, y: h * 0.83, z: 0.225 * h, w: 0.04 * h, h: 0.24 * h, d: 0.04 * h, rx: 0.1, rz: side * 0.04, c: cloth });
  grip(K, node, hx, h * 0.42, 0.16 * h, 0.046 * h, 0.12, woodDk);
  // A three-pronged claw gripping the gem — the prongs are the read, the gem is the light.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + 0.5;
    K.pyr(node, {
      x: hx + Math.cos(a) * 0.072 * h, y: h * 0.955, z: 0.245 * h + Math.sin(a) * 0.072 * h,
      w: 0.042 * h, h: 0.155 * h, d: 0.042 * h, rz: -Math.cos(a) * 0.55, rx: Math.sin(a) * 0.55, c: bone,
    });
  }
  K.ico(node, { x: hx, y: h * 0.945, z: 0.245 * h, w: 0.135 * h, c: glow, e: 0.55 });
  K.oct(node, { x: hx, y: h * 0.86, z: 0.235 * h, w: 0.09 * h, h: 0.07 * h, d: 0.09 * h, c: shade(bone, 0.7), det: 1 });
  // A fetish hanging off the shaft: asymmetry, and it swings in the silhouette.
  K.box(node, { x: hx + side * 0.055 * h, y: h * 0.7, z: 0.2 * h, w: 0.012 * h, h: 0.12 * h, d: 0.012 * h, c: 0x2a1c14, det: 1 });
  K.box(node, { x: hx + side * 0.055 * h, y: h * 0.615, z: 0.2 * h, w: 0.058 * h, h: 0.06 * h, d: 0.05 * h, c: bone, det: 1 });
}

function towerShield(K, o, side = -1) {
  const { h = 1.8, metal = 0xa8adb6, dark = 0x3a3038 } = o;
  const node = side > 0 ? 'armR' : 'armL';
  const hx = side * 0.34 * h;
  const rim = shade(metal, 1.25), dkm = shade(metal, 0.55);
  // A shield is the biggest flat surface an orc can carry and it was a plain grey slab.
  // Now it is a face + a raised rim + a boss + rivets + a painted band: five values across
  // one panel, which is what stops a wall of shieldbearers looking like a wall of doors.
  K.box(node, { x: hx, y: h * 0.5, z: 0.3 * h, w: 0.42 * h, h: 0.7 * h, d: 0.05 * h, c: metal, m: 0.8 });
  K.pair((sx) => K.box(node, { x: hx + sx * 0.205 * h, y: h * 0.5, z: 0.315 * h, w: 0.045 * h, h: 0.72 * h, d: 0.045 * h, c: rim, m: 1 }));
  K.box(node, { x: hx, y: h * 0.845, z: 0.315 * h, w: 0.45 * h, h: 0.045 * h, d: 0.045 * h, c: rim, m: 1 });
  K.box(node, { x: hx, y: h * 0.5, z: 0.335 * h, w: 0.09 * h, h: 0.64 * h, d: 0.035 * h, c: dark });
  K.box(node, { x: hx, y: h * 0.66, z: 0.33 * h, w: 0.36 * h, h: 0.07 * h, d: 0.03 * h, c: dark, det: 1 });
  K.oct(node, { x: hx, y: h * 0.5, z: 0.375 * h, w: 0.155 * h, h: 0.13 * h, d: 0.13 * h, c: rim, m: 1 });
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.78;
    K.box(node, { x: hx + Math.cos(a) * 0.16 * h, y: h * 0.5 + Math.sin(a) * 0.26 * h, z: 0.34 * h, w: 0.045 * h, h: 0.045 * h, d: 0.035 * h, c: dkm, m: 1, det: 1 });
  }
  K.pyr(node, { x: hx, y: h * 0.11, z: 0.315 * h, w: 0.42 * h, h: 0.16 * h, d: 0.055 * h, rx: Math.PI, c: metal, m: 0.9 });
  K.pyr(node, { x: hx, y: h * 0.03, z: 0.325 * h, w: 0.075 * h, h: 0.11 * h, d: 0.055 * h, rx: Math.PI, c: rim, m: 1, det: 1 });
}

/** A pole on the back — the single most legible "look at me" shape from a top-down camera. */
function banner(K, o, colorA, colorB, height = 1.0) {
  const { h = 1.8, dark = 0x2e2620 } = o;
  const px = -0.1 * h;
  K.p6('torso', { x: px, y: h * (0.55 + height * 0.35), z: -0.16 * h, w: 0.038 * h, h: h * height * 1.25, d: 0.038 * h, rx: -0.18, c: dark });
  K.box('torso', { x: px, y: h * (0.72 + height * 0.4), z: -0.03 * h, w: 0.3 * h, h: 0.42 * h, d: 0.02 * h, rx: -0.18, c: colorA });
  K.box('torso', { x: px, y: h * (0.55 + height * 0.4), z: 0.0 * h, w: 0.3 * h, h: 0.1 * h, d: 0.02 * h, rx: -0.18, c: colorB });
  // Crossbar, trim and three tails. A rectangle of cloth is a flag; a rectangle of cloth
  // with a ragged hem and a finial is a *standard*, and that difference survives at 30px.
  K.box('torso', { x: px, y: h * (0.94 + height * 0.4), z: -0.07 * h, w: 0.34 * h, h: 0.035 * h, d: 0.035 * h, rx: -0.18, c: colorB, m: 0.8 });
  K.pyr('torso', { x: px, y: h * (1.03 + height * 0.4), z: -0.09 * h, w: 0.07 * h, h: 0.16 * h, d: 0.07 * h, rx: -0.18, c: colorB, m: 0.9 });
  for (let i = -1; i <= 1; i++) {
    K.pyr('torso', { x: px + i * 0.1 * h, y: h * (0.46 + height * 0.4), z: 0.02 * h, w: 0.085 * h, h: (0.16 - Math.abs(i) * 0.05) * h, d: 0.02 * h, rx: Math.PI - 0.18, c: colorA, det: 1 });
  }
}

function cape(K, o, color, len = 0.55) {
  const { h = 1.8 } = o;
  const dk = shade(color, 0.68);
  // Three panels at slightly different angles instead of one board, plus a fur collar of
  // five lumps. The collar is what makes a boss read as wearing something rather than
  // having a plank strapped to its back.
  K.box('torso', { x: 0, y: h * (0.78 - len * 0.4), z: -0.165 * h, w: 0.3 * h, h: h * len, d: 0.03 * h, rx: 0.12, c: color });
  K.pair((sx) => K.box('torso', {
    x: sx * 0.2 * h, y: h * (0.79 - len * 0.36), z: -0.15 * h,
    w: 0.16 * h, h: h * len * 0.86, d: 0.028 * h, rx: 0.12, rz: sx * 0.14, c: dk,
  }));
  for (let i = -2; i <= 2; i++) {
    K.oct('torso', { x: i * 0.115 * h, y: h * 0.815, z: -0.09 * h, w: 0.15 * h, h: 0.13 * h, d: 0.16 * h, c: i % 2 ? color : dk });
  }
}

function horns(K, o, len = 1, spread = 1, color = 0x2b2620) {
  const { h = 1.8, headScale = 1 } = o;
  const hy = h * 0.9;
  // Two segments per horn at different angles, so it curves. A straight cone is a party
  // hat; a curved one is a horn, and the bend costs six triangles.
  K.pair((sx) => {
    K.p4('torso', {
      x: sx * 0.1 * h * headScale, y: hy + 0.055 * h, z: -0.015 * h,
      w: 0.075 * h, h: 0.16 * h * len, d: 0.075 * h, rz: sx * (0.5 * spread), rx: -0.24, c: color,
    });
    K.pyr('torso', {
      x: sx * (0.1 + 0.085 * spread * len) * h * headScale, y: hy + 0.175 * h * len, z: -0.055 * h,
      w: 0.058 * h, h: 0.2 * h * len, d: 0.058 * h, rz: sx * (0.95 * spread), rx: -0.4, c: shade(color, 1.3),
    });
  });
}

/**
 * Layered pauldrons. Three lames of decreasing size stacked down the arm, with a trim edge
 * on each, instead of one dome. A top-down camera sees a pauldron more completely than any
 * other piece of armour on the model, so it is worth the eighty triangles: layered plate
 * reads as *armour*, a single dome reads as a shoulder-shaped blob.
 */
function pauldrons(K, o, size = 1, color = 0x9aa2ad, metal = 1, spikes = 0) {
  const { h = 1.8, bulk = 1 } = o;
  const sy = h * 0.79, sx0 = 0.255 * h * bulk;
  const trim = shade(color, 1.3), dk = shade(color, 0.7);
  K.pair((sx) => {
    const node = sx > 0 ? 'armR' : 'armL';
    K.oct(node, { x: sx * sx0, y: sy + 0.035 * h, z: 0, w: 0.255 * h * size, h: 0.2 * h * size, d: 0.255 * h * size, c: color, m: metal });
    K.box(node, { x: sx * (sx0 + 0.035 * h * size), y: sy - 0.025 * h, z: 0, w: 0.19 * h * size, h: 0.05 * h * size, d: 0.235 * h * size, rz: sx * 0.42, c: dk, m: metal });
    K.box(node, { x: sx * (sx0 + 0.065 * h * size), y: sy - 0.085 * h, z: 0, w: 0.155 * h * size, h: 0.045 * h * size, d: 0.2 * h * size, rz: sx * 0.5, c: color, m: metal, det: 1 });
    K.box(node, { x: sx * (sx0 + 0.09 * h * size), y: sy - 0.135 * h, z: 0, w: 0.12 * h * size, h: 0.04 * h * size, d: 0.165 * h * size, rz: sx * 0.55, c: trim, m: metal, det: 1 });
    for (let i = 0; i < spikes; i++) {
      K.spike(node, {
        x: sx * (sx0 + 0.02 * h), y: sy + 0.12 * h, z: (i - (spikes - 1) / 2) * 0.1 * h,
        w: 0.055 * h, h: 0.19 * h, rz: sx * 0.35, c: trim, m: metal,
      });
    }
  });
}

/**
 * Bright trim lines down a boss's armour, plus a belt of studs.
 *
 * This is the specific answer to "the Orc King reads as a heap of coloured bricks". A boss
 * is mostly a few very large plates, and large plates in flat shading are large flat
 * colours — the eye gets no edges to follow and reads the whole thing as one lump. Running
 * a thin bright line along the *boundaries* between plates gives the eye the edges the
 * lighting is not providing, and the shape resolves into armour with panels.
 */
function trim(K, o, color, y0, w) {
  const { h = 1.8 } = o;
  const bright = shade(color, 1.35);
  K.pair((sx) => {
    K.box('torso', { x: sx * w * 0.5 * h * 0.5, y: y0 * 0.5 * h * 0.5 + h * 0.34, z: 0.13 * h, w: 0.035 * h, h: 0.34 * h, d: 0.05 * h, rz: sx * 0.16, rx: 0.14, c: bright, m: 1, det: 1 });
  });
  K.box('torso', { x: 0, y: h * 0.52, z: 0.1 * h, w: w * h * 0.46, h: 0.05 * h, d: 0.19 * h, c: bright, m: 1, det: 1 });
  for (let i = -2; i <= 2; i++) {
    K.oct('torso', { x: i * 0.09 * w * h, y: h * 0.52, z: 0.19 * h, w: 0.05 * h, c: color, m: 1, det: 1 });
  }
}

/* ============================ archetype models ============================ */

/**
 * Each entry returns the parts for one archetype plus its animation profile.
 * `profile` tunes the rig: stride length/rate, how much the torso lags the hips, how heavy
 * the footfall is. A brute and a runner must not walk the same way.
 */
export const MODELS = {
  'orc-grunt': (K) => {
    const o = { h: 1.8, bulk: 1, skin: 0x6f8f4c, cloth: 0x59452f, dark: 0x2e2620, glow: 0xffcf3a, hair: 'topknot' };
    humanoid(K, o);
    axe(K, o, 1);
    // Shoulder strap and a hip pouch. The baseline soldier: no gimmick, so what has to
    // carry it is the head, the axe and the fact that nothing on it is a plain cuboid.
    K.box('torso', { x: 0.02, y: 1.42, z: 0.06, w: 0.52, h: 0.08, d: 0.38, rz: 0.45, c: 0x3d2f22, det: 1 });
    K.gem('torso', { x: -0.22, y: 0.79, z: 0.1, w: 0.17, h: 0.16, d: 0.12, c: 0x3d2f22, det: 1 });
    return { profile: { stride: 1, weight: 1, lumber: 1 } };
  },

  'kobold-runner': (K) => {
    const o = { h: 1.15, bulk: 0.72, skin: 0xa8935a, cloth: 0x6a3b2c, dark: 0x2a1c14, glow: 0xff7a2a, hunch: 0.5, headScale: 1.25, tusks: 2, armLen: 1.1, ears: 0, hair: 'none' };
    humanoid(K, o);
    cleaver(K, { ...o, metal: 0xc0b8a8 }, 1);
    // Huge swept-back ears and a tail: tiny, twitchy, nothing like an orc's mass. The ears
    // are authored here rather than through `ears:` because their size *is* the character.
    K.pair((sx) => {
      K.pyr('torso', { x: sx * 0.155, y: 1.055, z: -0.02, w: 0.1, h: 0.32, d: 0.03, rz: sx * 1.2, rx: -0.4, c: 0x8a7a4a });
      K.pyr('torso', { x: sx * 0.15, y: 1.05, z: -0.005, w: 0.06, h: 0.2, d: 0.02, rz: sx * 1.2, rx: -0.4, c: 0xc4a882, det: 1 });
    });
    for (let i = 0; i < 3; i++) {
      K.p4('torso', { x: 0, y: 0.62 - i * 0.03, z: -0.2 - i * 0.13, w: 0.055 - i * 0.01, h: 0.15, d: 0.055 - i * 0.01, rx: 1.35 + i * 0.2, c: 0x8a7a4a, det: i ? 1 : 0 });
    }
    return { profile: { stride: 1.35, rate: 1.5, weight: 0.35, lumber: 0.5, bob: 1.3 } };
  },

  'orc-brute': (K) => {
    const o = { h: 2.1, bulk: 1.5, skin: 0x5d7a3f, cloth: 0x40331f, dark: 0x241d16, glow: 0xffb03a, hunch: 0.4, headScale: 0.8, armLen: 1.25, hair: 'mohawk', tuskLen: 1.35, tusks: 4 };
    humanoid(K, o);
    club(K, o, 1);
    // The read: shoulders like boulders, head almost buried between them. Four tusks and a
    // ridge of back-plates so it is unmistakable next to a grunt even in silhouette.
    K.pair((sx) => K.oct(sx > 0 ? 'armR' : 'armL', { x: sx * 0.78, y: 1.7, z: -0.02, w: 0.62, h: 0.44, d: 0.56, c: 0x6a8a4a }));
    K.roof('torso', { x: 0, y: 1.5, z: -0.2, w: 0.7, h: 0.42, d: 0.24, rx: 0.35, c: 0x546f38 });
    for (let i = -1; i <= 1; i++) {
      K.pyr('torso', { x: i * 0.2, y: 1.72, z: -0.24, w: 0.13, h: 0.26 - Math.abs(i) * 0.06, d: 0.09, rz: i * 0.3, rx: -0.55, c: 0x3a2f24, det: 1 });
    }
    horns(K, o, 0.7, 1.3, 0x3a2f24);
    return { profile: { stride: 0.85, rate: 0.72, weight: 2.2, lumber: 1.8, bob: 1.5 } };
  },

  'orc-armored': (K) => {
    const o = { h: 1.9, bulk: 1.15, skin: 0x67853f, cloth: 0x3d4048, dark: 0x22242a, metal: 0x9aa2ad, glow: 0xff6a3a, headScale: 0.9, plain: true, hair: 'bald', ears: 0 };
    humanoid(K, o);
    axe(K, o, 1);
    pauldrons(K, o, 1.1, 0x9aa2ad, 1, 0);
    // Plated everything: a plated orc must read as *architecture* next to a bare one. The
    // chest is a cuirass with a raised centre ridge and a skirt of tassets, and the head is
    // fully enclosed — so it is the one archetype where a hard rectangle is the point.
    K.roof('torso', { x: 0, y: 1.4, z: 0.06, w: 0.66, h: 0.38, d: 0.46, rx: 0.2, c: 0x8f97a2, m: 1 });
    K.box('torso', { x: 0, y: 1.42, z: 0.26, w: 0.09, h: 0.36, d: 0.07, rx: 0.2, c: 0xc0c8d2, m: 1, det: 1 });
    K.pair((sx) => K.box('torso', { x: sx * 0.19, y: 1.09, z: 0.13, w: 0.24, h: 0.2, d: 0.16, rz: sx * 0.12, c: 0x7d848e, m: 1, det: 1 }));
    K.p8('torso', { x: 0, y: 1.74, z: 0.04, w: 0.42, h: 0.28, d: 0.43, c: 0x8f97a2, m: 1 });      // helm
    K.box('torso', { x: 0, y: 1.7, z: 0.245, w: 0.31, h: 0.05, d: 0.06, c: 0x0e1014 });           // visor slit
    K.box('torso', { x: 0, y: 1.62, z: 0.2, w: 0.34, h: 0.11, d: 0.16, rx: 0.25, c: 0x7d848e, m: 1, det: 1 });  // beaver
    K.box('torso', { x: 0, y: 1.92, z: 0.02, w: 0.07, h: 0.15, d: 0.36, c: 0xb54a2a });           // crest
    K.pair((sx) => K.pyr('torso', { x: sx * 0.2, y: 1.85, z: 0.03, w: 0.07, h: 0.17, d: 0.07, rz: sx * 0.5, c: 0xc0c8d2, m: 1, det: 1 }));
    return { profile: { stride: 0.92, rate: 0.85, weight: 1.6, lumber: 1.2 } };
  },

  'orc-shaman': (K) => {
    const o = { h: 1.86, bulk: 0.86, skin: 0x7b6a9a, cloth: 0x3a2a52, dark: 0x241832, glow: 0xff3b7a, hunch: 0.34, headScale: 0.95, hair: 'braids', ears: 2 };
    humanoid(K, o);
    staff(K, o, 1);
    // A wide bone headdress — from above it is a fan, unmistakable in a crowd.
    for (let i = -2; i <= 2; i++) {
      K.spike('torso', { x: i * 0.09, y: 1.78, z: -0.02, w: 0.05, h: 0.26 + Math.abs(i) * 0.06, rz: i * 0.32, rx: -0.35, c: 0xd8cfb4 });
    }
    K.box('torso', { x: 0, y: 1.5, z: 0.16, w: 0.34, h: 0.3, d: 0.05, c: 0x2a1c3a });            // fetish bib
    K.pair((sx) => K.box('torso', { x: sx * 0.13, y: 1.36, z: 0.19, w: 0.1, h: 0.1, d: 0.06, rz: 0.6, c: 0xff3b7a, e: 1.4 }));
    return { profile: { stride: 0.95, rate: 0.95, weight: 0.8, lumber: 0.9, attack: 'cast', guardR: true } };
  },

  'orc-leaper': (K) => {
    const o = { h: 1.72, bulk: 0.9, skin: 0x8a7a4a, cloth: 0x4a2a2a, dark: 0x261a14, glow: 0xffd23a, hunch: 0.62, headScale: 1.05, digitigrade: true, armLen: 1.15, hair: 'mane', ears: 2, tuskLen: 0.7 };
    humanoid(K, o);
    cleaver(K, { ...o, metal: 0xc0b0a0 }, 1);
    cleaver(K, { ...o, metal: 0xc0b0a0 }, -1);
    // Hyena mane along the spine + the deep forward crouch of something about to jump.
    for (let i = 0; i < 4; i++) {
      K.spike('torso', { x: 0, y: 1.5 - i * 0.1, z: -0.12 - i * 0.03, w: 0.09, h: 0.22 - i * 0.02, rx: -0.5, c: 0x2e2318 });
    }
    K.box('torso', { x: 0, y: 1.44, z: 0.26, w: 0.16, h: 0.12, d: 0.16, c: 0x8a7a4a });          // snout
    return { profile: { stride: 1.2, rate: 1.25, weight: 0.6, lumber: 0.7, bob: 1.25 } };
  },

  'orc-firewalker': (K) => {
    const o = { h: 1.86, bulk: 1.06, skin: 0x9c4a2a, cloth: 0x3a1a12, dark: 0x1e0e08, glow: 0xff5a1a, headScale: 0.95, hair: 'mohawk', tuskLen: 1.15 };
    humanoid(K, o);
    axe(K, { ...o, metal: 0x6a2a1a }, 1);
    // A coal brazier strapped to the back, throwing light up past the shoulders.
    K.box('torso', { x: 0, y: 1.52, z: -0.24, w: 0.34, h: 0.3, d: 0.22, rx: 0.2, c: 0x241008 });
    K.box('torso', { x: 0, y: 1.68, z: -0.24, w: 0.26, h: 0.06, d: 0.16, c: 0xff6a1a, e: 2.4 });
    K.pair((sx) => K.spike('torso', { x: sx * 0.24, y: 1.7, z: -0.2, w: 0.07, h: 0.3, rz: sx * 0.4, rx: -0.3, c: 0x2a1208 }));
    // Lava seams down the chest.
    K.box('torso', { x: 0, y: 1.36, z: 0.2, w: 0.05, h: 0.3, d: 0.03, c: 0xff5a1a, e: 1.8 });
    return { profile: { stride: 1, rate: 0.95, weight: 1.2, lumber: 1.1 } };
  },

  'orc-sapper': (K) => {
    const o = { h: 1.62, bulk: 0.92, skin: 0x7a8a5a, cloth: 0x2a3a4a, dark: 0x1c2028, glow: 0x4affc0, hunch: 0.42, headScale: 1.05, hair: 'wraps', tuskLen: 0.8 };
    humanoid(K, o);
    // Crowbar, not a sword — this one is here for your traps, not for you.
    K.box('armR', { x: 0.28, y: 0.58, z: 0.22, w: 0.05, h: 0.5, d: 0.05, rx: 0.7, c: 0x8a5a2a });
    K.box('armR', { x: 0.28, y: 0.78, z: 0.4, w: 0.05, h: 0.14, d: 0.12, rx: 1.4, c: 0xb0b6bd, m: 1 });
    // A backpack bristling with tools: the tallest thing on it, visible over any crowd.
    K.box('torso', { x: 0, y: 1.24, z: -0.22, w: 0.42, h: 0.36, d: 0.24, c: 0x3a2f22 });
    K.pair((sx) => K.box('torso', { x: sx * 0.12, y: 1.52, z: -0.24, w: 0.05, h: 0.3, d: 0.05, rz: sx * 0.3, c: 0x9aa2ad, m: 1 }));
    K.ico('torso', { x: 0, y: 1.5, z: -0.3, w: 0.16, c: 0x4affc0, e: 1.2 });
    K.box('torso', { x: 0, y: 1.5, z: 0.16, w: 0.3, h: 0.08, d: 0.06, c: 0x22262c });            // goggles
    return { profile: { stride: 1.05, rate: 1.15, weight: 0.7, lumber: 0.8 } };
  },

  gargoyle: (K) => {
    const o = { h: 1.7, bulk: 0.95, skin: 0x5a5a68, cloth: 0x33333d, dark: 0x22222a, glow: 0xff2a2a, hunch: 0.5, headScale: 1, digitigrade: true, legThick: 0.75, hair: 'none', ears: 2, tuskLen: 1.3, tusks: 4, kilt: false };
    humanoid(K, o);
    horns(K, o, 1.2, 1.5, 0x3a3a46);
    // Wings are the whole silhouette: a wide horizontal X nothing else on the field makes.
    K.pair((sx) => {
      const node = sx > 0 ? 'wingR' : 'wingL';
      K.box(node, { x: sx * 0.5, y: 1.5, z: -0.1, w: 0.9, h: 0.05, d: 0.5, rz: sx * 0.12, c: 0x3a3040 });
      K.box(node, { x: sx * 1.0, y: 1.46, z: -0.28, w: 0.7, h: 0.04, d: 0.42, rz: sx * 0.2, ry: sx * 0.3, c: 0x2e2634 });
      K.spike(node, { x: sx * 0.95, y: 1.55, z: 0.12, w: 0.07, h: 0.24, rz: -sx * 1.2, c: 0x4a4452 });
    });
    K.box('torso', { x: 0, y: 0.9, z: -0.3, w: 0.06, h: 0.06, d: 0.5, rx: 0.6, c: 0x4a4452 });   // tail
    return { profile: { stride: 0.4, rate: 0.8, weight: 0.4, lumber: 0.4, flying: true } };
  },

  'orc-frostling': (K) => {
    const o = { h: 1.8, bulk: 1, skin: 0x5a8aa8, cloth: 0x24384a, dark: 0x162430, glow: 0x8fe0ff, headScale: 0.95, hair: 'braids', tuskLen: 1.2 };
    humanoid(K, o);
    cleaver(K, { ...o, metal: 0xbfe8ff }, 1);
    cleaver(K, { ...o, metal: 0xbfe8ff }, -1);
    // A cluster of ice shards growing out of the back — jagged, asymmetric, cold.
    const shards = [[0.16, 1.62, -0.14, 0.4, 0.5], [-0.1, 1.7, -0.18, 0.5, -0.4], [0.02, 1.5, -0.22, 0.34, 0.1]];
    for (const [x, y, z, len, tilt] of shards) {
      K.spike('torso', { x, y, z, w: 0.13, h: len, d: 0.13, rz: tilt, rx: -0.4, c: 0x9fe4ff, e: 0.55 });
    }
    return { profile: { stride: 0.95, rate: 0.9, weight: 1.2, lumber: 1.1 } };
  },

  'orc-shieldbearer': (K) => {
    const o = { h: 1.95, bulk: 1.2, skin: 0x64803e, cloth: 0x3a3a44, dark: 0x22242a, metal: 0xa8adb6, glow: 0xffd23a, headScale: 0.85, hunch: 0.3, plain: true, hair: 'bald', ears: 0 };
    humanoid(K, o);
    towerShield(K, o, -1);
    // Short stabbing sword: the shield is the character, the weapon is an afterthought.
    K.p6('armR', { x: 0.34, y: 0.9, z: 0.22, w: 0.05, h: 0.16, d: 0.05, rx: 1.2, c: 0x2a2018 });
    K.box('armR', { x: 0.34, y: 1.0, z: 0.26, w: 0.07, h: 0.3, d: 0.05, rx: 1.2, c: 0xa8adb6, m: 1 });
    K.pyr('armR', { x: 0.34, y: 1.17, z: 0.32, w: 0.07, h: 0.12, d: 0.05, rx: 1.2, c: 0xd0d6de, m: 1, det: 1 });
    pauldrons(K, o, 0.9, 0xa8adb6, 1, 0);
    K.p8('torso', { x: 0, y: 1.78, z: 0.04, w: 0.4, h: 0.26, d: 0.41, c: 0x9098a2, m: 1 });
    K.box('torso', { x: 0, y: 1.74, z: 0.255, w: 0.28, h: 0.05, d: 0.05, c: 0x0e1014 });
    K.box('torso', { x: 0, y: 1.66, z: 0.21, w: 0.32, h: 0.1, d: 0.15, rx: 0.25, c: 0x7f8791, m: 1, det: 1 });
    K.box('torso', { x: 0, y: 1.94, z: 0.03, w: 0.3, h: 0.06, d: 0.34, c: 0xd0d6de, m: 1, det: 1 });
    return { profile: { stride: 0.8, rate: 0.72, weight: 2.0, lumber: 1.4, guardL: true } };
  },

  'orc-archer': (K) => {
    const o = { h: 1.76, bulk: 0.88, skin: 0x76914e, cloth: 0x4a5a3a, dark: 0x241c14, glow: 0xffe07a, hunch: 0.26, headScale: 0.95, hair: 'hood', ears: 0, tuskLen: 0.85 };
    humanoid(K, o);
    bow(K, o, -1);
    // A fanned quiver over the shoulder — reads as "ranged" before it ever shoots.
    for (let i = -1; i <= 1; i++) {
      K.box('torso', { x: 0.16 + i * 0.04, y: 1.62, z: -0.16, w: 0.025, h: 0.42, d: 0.025, rz: 0.4 + i * 0.12, rx: -0.3, c: 0xbfae86 });
    }
    K.box('torso', { x: 0.16, y: 1.4, z: -0.16, w: 0.16, h: 0.24, d: 0.14, rz: 0.35, c: 0x3a2c1e });
    return { profile: { stride: 1, rate: 1.05, weight: 0.7, lumber: 0.8, attack: 'shoot', guardL: true } };
  },

  ogre: (K) => {
    const o = { h: 2.5, bulk: 1.8, skin: 0x8a6a4a, cloth: 0x4a3020, dark: 0x2a1c10, glow: 0xff5a2a, hunch: 0.34, headScale: 0.62, armLen: 1.3, hair: 'none', ears: 2, tusks: 4, tuskLen: 1.4 };
    humanoid(K, o);
    // Asymmetry is the point: one tree-trunk arm with a stone maul, one stunted arm.
    K.box('armR', { x: 1.0, y: 1.5, z: 0.05, w: 0.4, h: 0.7, d: 0.4, rz: 0.16, c: 0x8a6a4a });
    K.box('armR', { x: 1.05, y: 0.95, z: 0.3, w: 0.36, h: 0.6, d: 0.36, rx: -0.4, c: 0x8a6a4a });
    K.box('armR', { x: 1.05, y: 0.5, z: 0.5, w: 0.28, h: 0.9, d: 0.28, rx: 0.4, c: 0x4a3a2a });
    K.box('armR', { x: 1.05, y: 0.15, z: 0.75, w: 0.5, h: 0.44, d: 0.5, rx: 0.4, c: 0x6a6258 });
    // Gut and a slab of shoulder meat; the head is tiny and sunk forward.
    K.box('torso', { x: 0, y: 1.15, z: 0.16, w: 0.95, h: 0.6, d: 0.7, c: 0x9a7a58 });
    K.oct('torso', { x: -0.55, y: 2.0, z: -0.05, w: 0.7, h: 0.5, d: 0.6, c: 0x7a5c40 });
    horns(K, o, 0.8, 1.2, 0x3a2a1a);
    K.box('torso', { x: 0, y: 1.7, z: 0.1, w: 0.9, h: 0.14, d: 0.5, rz: 0.1, c: 0x5a4530 });     // chain
    return { profile: { stride: 0.7, rate: 0.55, weight: 3.2, lumber: 2.4, bob: 1.8, guardR: true } };
  },

  troll: (K) => {
    const o = { h: 2.45, bulk: 1.45, skin: 0x4a7a58, cloth: 0x2a3a28, dark: 0x1a2418, glow: 0x8aff6a, hunch: 0.62, headScale: 0.75, armLen: 1.6, legThick: 0.85, hair: 'mane', ears: 2, tusks: 4, tuskLen: 1.5 };
    humanoid(K, o);
    club(K, o, 1);
    // Knuckle-dragger: a huge shoulder hump, long arms, head thrust out low and forward.
    K.oct('torso', { x: 0, y: 2.0, z: -0.22, w: 0.95, h: 0.65, d: 0.8, c: 0x3f6a4c });
    for (let i = 0; i < 5; i++) {
      K.spike('torso', { x: (i - 2) * 0.16, y: 2.2 - Math.abs(i - 2) * 0.1, z: -0.22, w: 0.1, h: 0.3 - Math.abs(i - 2) * 0.05, rz: (i - 2) * 0.2, c: 0x2a3a28 });
    }
    K.box('torso', { x: 0, y: 1.9, z: 0.3, w: 0.3, h: 0.2, d: 0.28, rx: 0.3, c: 0x4a7a58 });     // jutting snout
    return { profile: { stride: 0.8, rate: 0.62, weight: 2.8, lumber: 2.2, bob: 1.6 } };
  },

  'orc-warchanter': (K) => {
    const o = { h: 1.88, bulk: 1.05, skin: 0x6f8f4c, cloth: 0x5a2a3a, dark: 0x2a141c, glow: 0xffc94a, headScale: 0.95, hunch: 0.18, hair: 'topknot' };
    humanoid(K, o);
    banner(K, o, 0xc8383a, 0xe8c04a, 1.15);
    // A war drum on the hip and a beater instead of a blade.
    K.cyl('armR', { x: 0.36, y: 0.95, z: 0.1, w: 0.34, h: 0.26, d: 0.34, rx: Math.PI / 2, c: 0x6a4a2a });
    K.box('armR', { x: 0.32, y: 1.1, z: 0.28, w: 0.04, h: 0.3, d: 0.04, rx: 0.9, c: 0x3a2a1a });
    K.pair((sx) => K.spike('torso', { x: sx * 0.1, y: 1.84, z: 0.02, w: 0.05, h: 0.22, rz: sx * 0.5, c: 0xe8c04a }));
    return { profile: { stride: 0.95, rate: 0.9, weight: 1.1, lumber: 1.0, guardR: true } };
  },

  'orc-bloater': (K) => {
    const o = { h: 1.72, bulk: 1.25, skin: 0x8aa04a, cloth: 0x4a4a2a, dark: 0x2a2a18, glow: 0xaaff3a, hunch: 0.2, headScale: 0.72, armLen: 0.85, legThick: 0.8, hair: 'none', ears: 0, tuskLen: 0.7, kilt: false };
    humanoid(K, o);
    // A walking sack: round, over-inflated, with sacs that will burst into children.
    K.ico('torso', { x: 0, y: 1.02, z: 0.06, w: 1.0, h: 0.95, d: 0.95, c: 0x8aa04a });
    K.pair((sx) => K.ico('torso', { x: sx * 0.34, y: 1.42, z: -0.18, w: 0.36, c: 0xaaff3a, e: 0.7 }));
    K.ico('torso', { x: 0, y: 1.5, z: -0.26, w: 0.3, c: 0xaaff3a, e: 0.7 });
    K.box('torso', { x: 0, y: 1.02, z: 0.4, w: 0.34, h: 0.2, d: 0.14, c: 0x6a7a3a });
    return { profile: { stride: 0.85, rate: 0.8, weight: 1.5, lumber: 1.4, bob: 1.4 } };
  },

  'blight-grub': (K) => {
    const o = { h: 0.95, bulk: 0.9, skin: 0x8aa04a, cloth: 0x4a4a2a, dark: 0x2a2a18, glow: 0xaaff3a, hunch: 0.6, headScale: 1.3, tusks: 2, legThick: 0.8, hair: 'none', ears: 2, tuskLen: 1.2, kilt: false };
    humanoid(K, o);
    K.ico('torso', { x: 0, y: 0.55, z: 0.04, w: 0.44, c: 0x9ab04a, e: 0.25 });
    return { profile: { stride: 1.3, rate: 1.6, weight: 0.3, lumber: 0.4, bob: 1.3 } };
  },

  'shadow-stalker': (K) => {
    const o = { h: 1.82, bulk: 0.8, skin: 0x54607a, cloth: 0x232838, dark: 0x12141c, glow: 0x9a6aff, hunch: 0.55, headScale: 0.9, armLen: 1.1, legThick: 0.85, hair: 'hood', ears: 0, tuskLen: 0.6 };
    humanoid(K, o);
    // Low crouch, hooded, and the face in shadow behind a mask band.
    K.box('torso', { x: 0, y: 1.66, z: 0.16, w: 0.26, h: 0.1, d: 0.06, c: 0x0c0e14 });
    cape(K, o, 0x1c2030, 0.5);
    // Twin daggers held reversed. A crossguard, a bright edge and a pommel each — reversed
    // grip is the whole silhouette tell for an assassin and it needs to be legible.
    K.pair((sx) => {
      const node = sx > 0 ? 'armR' : 'armL';
      K.box(node, { x: sx * 0.3, y: 0.74, z: 0.14, w: 0.038, h: 0.34, d: 0.055, rx: 1.9, c: 0xb0b6c8, m: 1 });
      K.box(node, { x: sx * 0.3, y: 0.735, z: 0.115, w: 0.042, h: 0.34, d: 0.016, rx: 1.9, c: 0xe0e6f2, m: 1, det: 1 });
      K.box(node, { x: sx * 0.3, y: 0.6, z: 0.185, w: 0.11, h: 0.032, d: 0.045, rx: 1.9, c: 0x2a2e3a, m: 1, det: 1 });
      K.oct(node, { x: sx * 0.3, y: 0.555, z: 0.2, w: 0.055, c: 0x2a2e3a, m: 1, det: 1 });
    });
    return { profile: { stride: 1.1, rate: 1.1, weight: 0.55, lumber: 0.6 } };
  },

  'orc-warlord': (K) => {
    const o = { h: 2.8, bulk: 1.9, skin: 0x5a3a2a, cloth: 0x2a1a1a, dark: 0x1a1010, metal: 0xc0a040, glow: 0xff2a10, headScale: 0.8, hunch: 0.22, plain: true, hair: 'bald', ears: 0, tusks: 4, tuskLen: 1.3 };
    humanoid(K, o);
    greatsword(K, { ...o, metal: 0xc8b070 }, 1);
    pauldrons(K, o, 1.25, 0xc0a040, 1, 2);
    cape(K, o, 0x7a1a1a, 0.7);
    banner(K, o, 0x8a1010, 0xc0a040, 1.3);
    trim(K, o, 0xc0a040, 2.0, 0.72);
    // Horned crown-helm with an open face: the tallest, widest head shape in the game bar
    // the King, and the open face is deliberate — a fully enclosed helm on something this
    // size reads as a statue, and the player needs to see it snarling at them.
    K.p8('torso', { x: 0, y: 2.55, z: 0.06, w: 0.58, h: 0.34, d: 0.56, c: 0xa8903a, m: 1 });
    K.box('torso', { x: 0, y: 2.44, z: 0.06, w: 0.62, h: 0.06, d: 0.6, c: 0xe0c060, m: 1, det: 1 });
    K.box('torso', { x: 0, y: 2.63, z: 0.3, w: 0.09, h: 0.24, d: 0.16, rx: -0.2, c: 0xe0c060, m: 1, det: 1 });   // nasal bar
    horns(K, { ...o, headScale: 1.5 }, 1.6, 1.5, 0x2a1a10);
    K.box('torso', { x: 0, y: 2.5, z: 0.34, w: 0.42, h: 0.07, d: 0.06, c: 0xff2a10, e: 0.55 });
    K.roof('torso', { x: 0, y: 2.0, z: 0.24, w: 0.7, h: 0.5, d: 0.18, rx: 0.15, c: 0xb09838, m: 1 });
    return { profile: { stride: 0.9, rate: 0.72, weight: 3.0, lumber: 2.0, bob: 1.4 } };
  },

  'frost-warlord': (K) => {
    const o = { h: 2.8, bulk: 1.85, skin: 0x3a6a8a, cloth: 0x1a2a3a, dark: 0x101820, metal: 0xa8d8f0, glow: 0x8fe8ff, headScale: 0.8, hunch: 0.2, plain: true, hair: 'bald', ears: 0, tusks: 4, tuskLen: 1.4 };
    humanoid(K, o);
    greatsword(K, { ...o, metal: 0xc8ecff }, 1);
    pauldrons(K, o, 1.2, 0xa8d8f0, 0.9, 0);
    cape(K, o, 0x24405a, 0.75);
    trim(K, o, 0x8fe8ff, 2.0, 0.7);
    // A spread of glacial antlers instead of a banner — same "big and above the crowd"
    // job, opposite shape, so the two warlords are never confused. Two segments each so
    // they fork rather than radiating like a hedgehog.
    for (let i = -2; i <= 2; i++) {
      if (!i) continue;
      const s = Math.sign(i), n = Math.abs(i);
      K.p4('torso', { x: i * 0.15, y: 2.6, z: -0.02, w: 0.13, h: 0.34 + n * 0.1, d: 0.13, rz: i * 0.42, rx: -0.2, c: 0x9fd0ea });
      K.spike('torso', { x: i * (0.26 + n * 0.07), y: 2.86 + n * 0.06, z: -0.1, w: 0.1, h: 0.34 + n * 0.12, d: 0.1, rz: i * 0.72, rx: -0.35, c: 0xbfe8ff, e: 0.3 });
      K.pyr('torso', { x: i * (0.22 + n * 0.05), y: 2.9 + n * 0.05, z: 0.06, w: 0.07, h: 0.2, d: 0.07, rz: i * 0.3, rx: -0.55, c: 0xd8f2ff, e: 0.22, det: 1 });
    }
    K.p8('torso', { x: 0, y: 2.5, z: 0.06, w: 0.56, h: 0.32, d: 0.54, c: 0x8fb8d8, m: 0.7 });
    K.box('torso', { x: 0, y: 2.4, z: 0.06, w: 0.6, h: 0.055, d: 0.58, c: 0xd8f2ff, m: 0.9, det: 1 });
    return { profile: { stride: 0.9, rate: 0.7, weight: 3.0, lumber: 2.0, bob: 1.4 } };
  },

  /**
   * The finale. Its problem was never scale — the hierarchy from grub to King is a genuine
   * 10:1 — it was that a 3.1m stack of large flat plates reads as *a heap of coloured
   * bricks* rather than as a king. The fixes are all about giving the eye edges to follow:
   * a gold trim line on every plate boundary, real skulls on the pauldrons instead of
   * spheres, a crown whose points differ in height, and a face you can find under it.
   */
  'orc-king': (K) => {
    const o = { h: 3.1, bulk: 2.1, skin: 0x4a3448, cloth: 0x1a0a14, dark: 0x120810, metal: 0xd0b050, glow: 0xff2a80, headScale: 0.85, hunch: 0.16, plain: true, hair: 'bald', ears: 0, tusks: 4, tuskLen: 1.5 };
    humanoid(K, o);
    greatsword(K, { ...o, metal: 0xd8c070 }, 1);
    cape(K, o, 0x3a0a24, 0.85);
    trim(K, o, 0xd0b050, 2.2, 0.8);
    // Skull-crowned pauldrons. An actual skull — cranium, brow, two sockets, a jaw — not a
    // pale sphere. At boss framing the player is looking straight down at these, so they
    // are the most-seen 120 triangles on the model.
    K.pair((sx) => {
      const node = sx > 0 ? 'armR' : 'armL';
      K.oct(node, { x: sx * 0.62, y: 2.46, z: 0, w: 0.78, h: 0.5, d: 0.72, c: 0xd0b050, m: 1 });
      K.box(node, { x: sx * 0.62, y: 2.3, z: 0, w: 0.72, h: 0.07, d: 0.66, c: 0xf0dc90, m: 1, det: 1 });
      K.roof(node, { x: sx * 0.72, y: 2.74, z: 0.02, w: 0.29, h: 0.24, d: 0.28, c: 0xe8e0c8 });
      K.snout(node, { x: sx * 0.72, y: 2.66, z: 0.16, w: 0.19, h: 0.13, d: 0.16, c: 0xd8d0b4, det: 1 });
      K.pair((ex) => K.box(node, { x: sx * 0.72 + ex * 0.075, y: 2.75, z: 0.13, w: 0.09, h: 0.075, d: 0.06, rx: -0.5, c: 0x2a1a24, det: 1 }));
      for (let i = -1; i <= 1; i += 2) {
        K.spike(node, { x: sx * 0.66, y: 2.7, z: i * 0.22, w: 0.11, h: 0.38, rz: sx * 0.4, rx: i * 0.2, c: 0xd0b050, m: 1 });
      }
    });
    // Crown-helm: an open-faced gold band with five points of differing height, so the
    // topmost shape on the model is a jagged crown and not another rectangle.
    K.p8('torso', { x: 0, y: 2.82, z: 0.05, w: 0.62, h: 0.3, d: 0.6, c: 0x2a1a2a, m: 0.6 });
    K.box('torso', { x: 0, y: 2.69, z: 0.05, w: 0.66, h: 0.075, d: 0.64, c: 0xd0b050, m: 1 });
    for (let i = -2; i <= 2; i++) {
      K.spike('torso', { x: i * 0.15, y: 3.03, z: 0.04, w: 0.1, h: 0.42 - Math.abs(i) * 0.09, rz: i * 0.22, c: i % 2 ? 0xf0dc90 : 0xd0b050, m: 1 });
    }
    K.box('torso', { x: 0, y: 2.78, z: 0.32, w: 0.44, h: 0.08, d: 0.06, c: 0xff2a80, e: 0.6 });
    K.roof('torso', { x: 0, y: 2.2, z: 0.28, w: 0.8, h: 0.62, d: 0.2, rx: 0.12, c: 0x4a2a44, m: 0.5 });
    K.pair((sx) => K.box('torso', { x: sx * 0.28, y: 2.2, z: 0.37, w: 0.05, h: 0.56, d: 0.07, rx: 0.12, c: 0xd0b050, m: 1, det: 1 }));
    K.box('torso', { x: 0, y: 2.34, z: 0.38, w: 0.2, h: 0.2, d: 0.07, rx: 0.12, c: 0xff2a80, e: 0.4 });
    return { profile: { stride: 0.85, rate: 0.65, weight: 3.4, lumber: 2.2, bob: 1.3 } };
  },
};

/* ============================ assembly ============================ */

const CACHE = new Map();
/** Near-LOD triangle counts per archetype, for the perf budget check in the console. */
export const MODEL_STATS = {};
/** Far-LOD triangle counts. Should be roughly a third of the near count. */
export const MODEL_FAR_STATS = {};
/**
 * Measured height of each archetype, crown of the head (or the tip of its banner) included.
 * Health bars used to float at a hard-coded 2.35 units, which is fine for a 1.8m grunt and
 * puts a red line straight through the Orc King's face — it is 3.1m before its crown. A
 * boss whose head is crossed out by its own UI cannot read no matter how good the model is.
 */
export const MODEL_HEIGHT = {};

function buildGeometry(id) {
  let entry = CACHE.get(id);
  if (entry) return entry;

  const spec = MODELS[id];
  if (!spec) throw new Error('no model for ' + id);

  const K = new Kit();
  const meta = spec(K) || {};

  const geos = {};
  let tris = 0, top = 0;
  for (const n of NODES) {
    const g = finish(K.buf[n]);
    if (g) {
      geos[n] = g; tris += g.index.count / 3;
      // Node geometry is authored in body space *minus its pivot*, so add the pivot back
      // to recover the real height above the feet. Only used as a fallback.
      g.computeBoundingBox();
      const y = g.boundingBox.max.y + (K.pivots[n]?.y || 0);
      if (y > top) top = y;
    }
  }
  MODEL_STATS[id] = tris;
  MODEL_HEIGHT[id] = K.bodyTop || top;

  // Distant LOD: the silhouette parts only, baked into a single buffer in the rest pose.
  // Once an orc is under ~25px the limb animation is invisible but still costs four extra
  // draw calls, so far away it becomes one mesh that only bobs and leans — and now it also
  // drops every `det` part, because rivets and knuckles are sub-pixel out there. That is
  // what pays for the close-range detail: the near model roughly tripled in triangles, and
  // the far model, which is what most of a 250-orc wave actually is, got *cheaper*.
  const flat = new Kit(true);
  spec(flat);
  const far = finish(flat.buf.torso);
  MODEL_FAR_STATS[id] = far ? far.index.count / 3 : 0;

  entry = { geos, far, pivots: K.pivots, profile: meta.profile || {} };
  CACHE.set(id, entry);
  return entry;
}

/**
 * Build one orc instance. Geometry and materials are shared across every orc of the same
 * archetype; only the five Object3D nodes are per-instance.
 */
export function buildEnemyModel(id) {
  const { geos, far, pivots, profile } = buildGeometry(id);
  const group = new THREE.Group();
  const root = pivots.torso || ZERO;

  // Hips carry the whole body: bob, roll and the counter-rotation the torso lags behind.
  const hips = new THREE.Group();
  hips.position.set(root.x, root.y, root.z);
  group.add(hips);

  const meshes = [];
  const mk = (node, parent) => {
    if (!geos[node]) return null;
    const m = new THREE.Mesh(geos[node], ORC_MAT);
    const p = pivots[node];
    m.position.set(p.x - root.x, p.y - root.y, p.z - root.z);
    m.frustumCulled = false;   // the enemy root owns culling; per-node tests are wasted work
    parent.add(m);
    meshes.push(m);
    return m;
  };

  const torso = mk('torso', hips);
  // Only the torso casts a shadow. Limb shadows are invisible under the body from a 52°
  // camera but would double the shadow-pass draw calls.
  if (torso) { torso.castShadow = true; torso.position.set(0, 0, 0); }

  const parent = torso || hips;
  const nodes = {
    armL: mk('armL', parent), armR: mk('armR', parent),
    legL: mk('legL', hips), legR: mk('legR', hips),
    wingL: mk('wingL', parent), wingR: mk('wingR', parent),
  };

  let farMesh = null;
  if (far) {
    farMesh = new THREE.Mesh(far, ORC_MAT);
    farMesh.frustumCulled = false;
    // No shadow at LOD distance: it would be a handful of pixels, and the shadow pass is
    // the second draw call this LOD exists to remove.
    farMesh.castShadow = false;
    farMesh.visible = false;
    hips.add(farMesh);
    meshes.push(farMesh);
  }

  const rig = new OrcRig({
    group, hips, torso, farMesh, ...nodes,
    meshes, pivots, profile, base: ORC_MAT, flash: FLASH_MATS, stealth: STEALTH_MAT,
  });
  return { group, rig };
}

/**
 * Where a node hinges. The torso pivots at the waist (bottom of its first box); limbs
 * pivot at the top of their first segment, which is exactly the shoulder or hip joint.
 */
function pivotFor(node, o) {
  const x = o.x || 0, y = o.y || 0;
  switch (node) {
    case 'torso': return { x: 0, y: y - (o.h || 0) * 0.5, z: 0 };
    case 'armL': case 'armR': return { x, y: y + (o.h || 0) * 0.5, z: 0 };
    case 'legL': case 'legR': return { x, y: y + (o.h || 0) * 0.5, z: 0 };
    case 'wingL': case 'wingR': return { x: x * 0.25, y, z: (o.z || 0) };
    default: return { x: 0, y: 0, z: 0 };
  }
}
