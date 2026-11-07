import * as THREE from 'three';
import { TILE } from '../world/Grid.js';

/**
 * The procedural part kit every trap is assembled from.
 *
 * Why a kit instead of ad-hoc primitives per trap: the traps have to read as *machines
 * from the same workshop* — same rivets, same steel, same hazard paint — while still
 * being instantly distinguishable from a 52° top-down camera. A shared kit gets both,
 * and it keeps the draw-call budget honest because every repeated part (spikes, teeth,
 * chain links, rivets) becomes one InstancedMesh instead of nine meshes.
 *
 * Rules enforced here:
 *  - Geometry is created once at module scope and shared by every trap instance.
 *  - Materials in `M` are shared and MUST NOT be mutated. Anything that animates its
 *    colour/emissive builds its own material through `lamp()` / `M.clone()`.
 */

const std = (o) => new THREE.MeshStandardMaterial(o);

// Metalness is kept deliberately low: the level has no environment map, and a fully
// metallic surface with nothing to reflect renders as a black hole. These read as metal
// through colour and specular highlight from the single directional light instead.
export const M = {
  steel:     std({ color: 0xb8c0cc, roughness: 0.34, metalness: 0.45 }),
  darkSteel: std({ color: 0x5c636f, roughness: 0.5, metalness: 0.4 }),
  iron:      std({ color: 0x40444d, roughness: 0.75, metalness: 0.3 }),
  rust:      std({ color: 0x8a4f2c, roughness: 0.92, metalness: 0.2 }),
  brass:     std({ color: 0xd8b25a, roughness: 0.38, metalness: 0.5 }),
  gold:      std({ color: 0xffd870, roughness: 0.3, metalness: 0.55, emissive: 0x3a2600, emissiveIntensity: 0.6 }),
  copper:    std({ color: 0xc87a48, roughness: 0.35, metalness: 0.5 }),
  wood:      std({ color: 0x5a4028, roughness: 0.95, metalness: 0.05 }),
  darkWood:  std({ color: 0x3a2818, roughness: 0.95, metalness: 0.05 }),
  stone:     std({ color: 0x6a625a, roughness: 0.95, metalness: 0.05 }),
  darkStone: std({ color: 0x3c382f, roughness: 0.95, metalness: 0.05 }),
  bone:      std({ color: 0xcfc4a8, roughness: 0.85, metalness: 0.05 }),
  tar:       std({ color: 0x100d0b, roughness: 0.12, metalness: 0.35 }),
  glass:     std({ color: 0x9fe4ff, roughness: 0.08, metalness: 0.10, transparent: true, opacity: 0.42 }),
};

/** A fresh emissive material. Every animated lamp owns its own — never share, never mutate. */
export function lamp(color, intensity = 2.4) {
  return new THREE.MeshStandardMaterial({
    color, emissive: color, emissiveIntensity: intensity, roughness: 0.35, metalness: 0.2,
  });
}
/**
 * A light *request*, not a light. Traps animate `intensity` exactly as they would a
 * PointLight, but nothing is added to the renderer: the TrapManager hands a small fixed
 * pool of real lights to whichever requests matter most this frame (TrapLightPool).
 *
 * Why: three.js keys every lit shader program on the scene's point-light count, so a
 * trap that owned a PointLight recompiled every lit material in the scene each time one
 * was placed, sold, previewed by the build ghost, or blew up — a visible hitch each time.
 */
export class TrapLight extends THREE.Object3D {
  constructor(color, intensity = 1, distance = 10, decay = 2) {
    super();
    this.isTrapLight = true;
    this.color = new THREE.Color(color);
    this.intensity = intensity;
    this.distance = distance;
    this.decay = decay;
  }
}

/**
 * The real lights behind every TrapLight. Fixed count for the life of the game, so the
 * light count (and therefore every program key) never changes; unused slots sit at
 * intensity 0, never `visible = false`, which would change the count just the same.
 */
export class TrapLightPool {
  constructor(parent, size = 4) {
    this.lights = [];
    this._pick = [];
    this._score = [];
    this._w = new THREE.Vector3();
    for (let i = 0; i < size; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.name = 'trap-light-' + i;
      parent.add(l);
      this.lights.push(l);
    }
  }

  /** Give the pool to the brightest requests nearest `focus`. Allocation-free. */
  assign(traps, focus) {
    const n = this.lights.length;
    const pick = this._pick, score = this._score;
    pick.length = 0; score.length = 0;
    for (let i = 0; i < traps.length; i++) {
      const t = traps[i];
      if (t.destroyed || !t.lights) continue;
      for (let j = 0; j < t.lights.length; j++) {
        const req = t.lights[j];
        if (!(req.intensity > 0.01)) continue;
        req.getWorldPosition(this._w);
        const dx = this._w.x - focus.x, dz = this._w.z - focus.z;
        const s = req.intensity / (1 + (dx * dx + dz * dz) / 400);
        // Insertion into a top-n list; n is tiny.
        let k = pick.length;
        if (k === n && s <= score[n - 1]) continue;
        if (k < n) { pick.push(req); score.push(s); } else { k = n - 1; }
        while (k > 0 && score[k - 1] < s) { pick[k] = pick[k - 1]; score[k] = score[k - 1]; k--; }
        pick[k] = req; score[k] = s;
      }
    }
    for (let i = 0; i < n; i++) {
      const l = this.lights[i];
      const req = pick[i];
      if (!req) { l.intensity = 0; continue; }
      req.getWorldPosition(l.position);
      l.color.copy(req.color);
      l.intensity = req.intensity;
      l.distance = req.distance;
      l.decay = req.decay;
    }
  }

  off() { for (const l of this.lights) l.intensity = 0; }
}

/** Fresh unlit additive material for glows and markers. */
export function glow(color, opacity = 0.6) {
  return new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

// --- shared geometry -------------------------------------------------------
const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 12),
  cyl8: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  cone: new THREE.ConeGeometry(0.5, 1, 8),
  cone5: new THREE.ConeGeometry(0.5, 1, 5),
  sphere: new THREE.SphereGeometry(0.5, 8, 6),
  rivet: new THREE.SphereGeometry(0.5, 6, 4),
  link: new THREE.TorusGeometry(0.34, 0.1, 4, 8),
  ico: new THREE.IcosahedronGeometry(0.5, 0),
  ico1: new THREE.IcosahedronGeometry(0.5, 1),
  quad: new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
};
export { G as GEO };

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

/**
 * One InstancedMesh from a list of `{ p:[x,y,z], r:[rx,ry,rz], s:[sx,sy,sz] }` transforms.
 * This is the single reason a 40-trap corridor still fits the draw-call budget.
 */
export function instance(geo, mat, list) {
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    _p.set(t.p?.[0] ?? 0, t.p?.[1] ?? 0, t.p?.[2] ?? 0);
    _e.set(t.r?.[0] ?? 0, t.r?.[1] ?? 0, t.r?.[2] ?? 0);
    _q.setFromEuler(_e);
    _s.set(t.s?.[0] ?? 1, t.s?.[1] ?? 1, t.s?.[2] ?? 1);
    im.setMatrixAt(i, _m.compose(_p, _q, _s));
  }
  im.instanceMatrix.needsUpdate = true;
  return im;
}

/** Simple box helper — `box(w,h,d, mat, x,y,z)`. */
export function box(w, h, d, mat, x = 0, y = 0, z = 0) {
  const m = new THREE.Mesh(G.box, mat);
  m.scale.set(w, h, d); m.position.set(x, y, z);
  return m;
}
export function cyl(r, h, mat, x = 0, y = 0, z = 0, seg = 12) {
  const m = new THREE.Mesh(seg <= 8 ? G.cyl8 : G.cyl, mat);
  m.scale.set(r * 2, h, r * 2); m.position.set(x, y, z);
  return m;
}

/** A bolted iron plate: the shared visual grammar that says "this is a machine". */
export function boltedPlate(w, h, d, mat = M.iron, boltMat = M.steel, inset = 0.28) {
  const g = new THREE.Group();
  g.add(box(w, h, d, mat));
  const hw = w / 2 - inset, hd = d / 2 - inset;
  const bolts = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    bolts.push({ p: [sx * hw, h / 2, sz * hd], s: [0.17, 0.13, 0.17] });
  }
  g.add(instance(G.rivet, boltMat, bolts));
  return g;
}

/** A toothed gear. Teeth are instanced, so a gear costs two draw calls, not twelve. */
export function gear(radius, teeth, thickness, mat = M.steel, toothMat = mat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(G.cyl, mat);
  body.scale.set(radius * 2, thickness, radius * 2);
  body.rotation.x = Math.PI / 2;
  g.add(body);
  const list = [];
  for (let i = 0; i < teeth; i++) {
    const a = (i / teeth) * Math.PI * 2;
    list.push({
      p: [Math.cos(a) * radius, Math.sin(a) * radius, 0],
      r: [0, 0, a],
      s: [radius * 0.34, radius * 0.3, thickness],
    });
  }
  // The hub rides in the same instanced batch as the teeth: one more box, no more calls.
  list.push({ p: [0, 0, 0], s: [radius * 0.5, radius * 0.5, thickness * 1.4] });
  g.add(instance(G.box, toothMat, list));
  return g;
}

/** A hanging chain of instanced links, origin at the top, hanging down -Y. */
export function chain(length, mat = M.darkSteel, links = 8) {
  const step = length / links;
  const list = [];
  for (let i = 0; i < links; i++) {
    list.push({ p: [0, -step * (i + 0.5), 0], r: [i % 2 ? 0 : Math.PI / 2, 0, Math.PI / 2], s: [step * 1.5, step * 1.5, step * 1.5] });
  }
  return instance(G.link, mat, list);
}

/** Spikes on a grid. `rows`×`rows` cones filling `span`. */
export function spikeBed(rows, span, height, mat = M.steel, jitter = 0) {
  const list = [];
  const stepv = span / rows;
  for (let i = 0; i < rows; i++) for (let j = 0; j < rows; j++) {
    const x = (i - (rows - 1) / 2) * stepv;
    const z = (j - (rows - 1) / 2) * stepv;
    const h = height * (1 - jitter * ((i * 3 + j) % 3) / 3);
    list.push({ p: [x, h / 2, z], s: [stepv * 0.42, h, stepv * 0.42] });
  }
  return instance(G.cone5, mat, list);
}

/** Yellow/black hazard paint as a single shared canvas texture. */
let _stripeTex = null;
export function stripeTexture() {
  if (_stripeTex) return _stripeTex;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  c.fillStyle = '#1a1712'; c.fillRect(0, 0, 64, 64);
  c.strokeStyle = '#d8a028'; c.lineWidth = 10;
  for (let i = -64; i < 128; i += 22) {
    c.beginPath(); c.moveTo(i, 0); c.lineTo(i + 64, 64); c.stroke();
  }
  // Scuffs: a clean warning stripe looks like a decal, a worn one looks used.
  c.fillStyle = 'rgba(20,18,14,0.55)';
  for (let i = 0; i < 26; i++) c.fillRect(Math.random() * 64, Math.random() * 64, 3 + Math.random() * 7, 2 + Math.random() * 4);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  _stripeTex = t;
  return t;
}
let _stripeMat = null;
export function stripeMat() {
  if (!_stripeMat) {
    _stripeMat = new THREE.MeshStandardMaterial({ map: stripeTexture(), roughness: 0.8, metalness: 0.2 });
    _stripeMat.userData.shared = true;
  }
  return _stripeMat;
}

/**
 * The frame every floor trap sits in: a sunken stone kerb with hazard paint on two edges.
 * Gives all floor traps a common footprint so the player reads "trap tile" instantly.
 */
export function floorFrame(size = TILE * 0.94, lip = 0.34, painted = true) {
  const g = new THREE.Group();
  const h = 0.18;
  const mat = painted ? stripeMat() : M.darkStone;
  // One instanced mesh for the four kerb pieces: a corridor of forty traps cannot afford
  // four draw calls each just for the frame.
  const kerb = [];
  for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    kerb.push({
      p: [ax * (size / 2 - lip / 2), h / 2, az * (size / 2 - lip / 2)],
      s: [ax ? lip : size, h, az ? lip : size],
    });
  }
  g.add(instance(G.box, mat, kerb));
  const corners = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    corners.push({ p: [sx * (size / 2 - lip * 0.5), h, sz * (size / 2 - lip * 0.5)], s: [0.2, 0.16, 0.2] });
  }
  g.add(instance(G.rivet, M.steel, corners));
  return g;
}

/** A ground-level emissive quad — lane markers, target squares, blast rings. */
export function marker(w, d, color, opacity = 0.4, y = 0.05) {
  const m = new THREE.Mesh(G.quad, glow(color, opacity));
  m.scale.set(w, 1, d);
  m.position.y = y;
  m.renderOrder = 3;
  return m;
}

/** A flat ring on the floor. Used for cooldown state and AoE footprints. */
export function ringMesh(inner, outer, color, opacity = 0.5, seg = 28) {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(inner, outer, seg).rotateX(-Math.PI / 2),
    glow(color, opacity),
  );
  m.position.y = 0.06;
  m.renderOrder = 3;
  return m;
}

/**
 * Status bulb for wall-mounted traps. A ring on the floor is the primary state read, but
 * a wall trap seen from a 52° camera is mostly its top face — so it gets a lamp up there
 * too, green when loaded, amber while winding, red while it refills.
 */
export function statusBulb(y = 2.6, z = 0) {
  const mat = lamp(0x40ff90, 1.1);
  const m = new THREE.Mesh(G.sphere, mat);
  m.scale.setScalar(0.3);
  m.position.set(0, y, z);
  m.userData.set = (hex, intensity) => {
    mat.color.setHex(hex); mat.emissive.setHex(hex); mat.emissiveIntensity = intensity;
  };
  return m;
}

/** Carved rune band — cheap arcane detail that still reads at distance. */
export function runeBand(radius, count, color) {
  const list = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    list.push({ p: [Math.cos(a) * radius, 0, Math.sin(a) * radius], r: [0, -a, 0], s: [0.12, 0.3, 0.06] });
  }
  return instance(G.box, lamp(color, 3), list);
}

/** Random greeble bolts/pipes bolted to a face — sells "built, not spawned". */
export function greebles(n, w, h, d, mat = M.darkSteel, seed = 1) {
  const list = [];
  let s = seed * 9301;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < n; i++) {
    list.push({
      p: [(rnd() - 0.5) * w, (rnd() - 0.5) * h, (rnd() - 0.5) * d],
      r: [0, rnd() * 3, 0],
      s: [0.1 + rnd() * 0.2, 0.08 + rnd() * 0.3, 0.1 + rnd() * 0.2],
    });
  }
  return instance(G.box, mat, list);
}

/**
 * Level pips: 3 small studs on the trap frame, lit up to `level`. The cheapest possible
 * "how upgraded is this thing" read, and it works from the top-down camera.
 */
export function levelPips(x = 0, z = -TILE * 0.42) {
  const g = new THREE.Group();
  // Three studs in one instanced mesh; `count` is the level, so an unspent pip simply
  // does not exist and the whole indicator costs a single draw call.
  const lit = lamp(0xffcc50, 1.4);
  const list = [];
  for (let i = 0; i < 3; i++) list.push({ p: [x + (i - 1) * 0.34, 0.22, z], s: [0.22, 0.1, 0.22] });
  const im = instance(G.box, lit, list);
  g.add(im);
  g.userData.set = (level) => { im.count = Math.max(0, Math.min(3, level)); };
  g.userData.set(1);
  return g;
}

/** Text/number-free billboard bar (guardian health). Two quads, no DOM. */
export function bar(width = 1.3, color = 0x50e070) {
  const g = new THREE.Group();
  const bg = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.14),
    new THREE.MeshBasicMaterial({ color: 0x11080a, transparent: true, opacity: 0.8, depthTest: false }));
  const fgMat = new THREE.MeshBasicMaterial({ color, depthTest: false });
  const fg = new THREE.Mesh(new THREE.PlaneGeometry(width, 0.1), fgMat);
  fg.position.z = 0.01;
  g.add(bg); g.add(fg);
  g.renderOrder = 22;
  bg.renderOrder = 22; fg.renderOrder = 23;
  g.userData.set = (frac) => {
    const f = Math.max(0, Math.min(1, frac));
    fg.scale.x = f || 0.0001;
    fg.position.x = -width * (1 - f) / 2;
    fgMat.color.setRGB(f > 0.5 ? 1 - (f - 0.5) * 0.6 : 1, f > 0.25 ? f * 0.9 : 0.2, 0.2);
  };
  g.userData.set(1);
  return g;
}

/** Lerp helper used by every rig; kept here so rigs stay one-liners. */
export const approach = (cur, want, rate, dt) => cur + (want - cur) * Math.min(1, rate * dt);

// Everything in `M` and `GEO` is shared by every trap in the level. Selling one trap
// must never dispose the geometry the other thirty are still drawing with, so the shared
// assets are stamped and `disposeTrap()` skips them.
for (const k of Object.keys(M)) M[k].userData.shared = true;
for (const k of Object.keys(G)) G[k].userData.shared = true;

/** Tear down a trap's object tree without touching anything shared. */
export function disposeTrap(obj) {
  obj.traverse((o) => {
    if (o.geometry && o.geometry.userData?.shared !== true) o.geometry.dispose();
    const m = o.material;
    if (!m) return;
    if (Array.isArray(m)) { for (const mm of m) if (mm?.userData?.shared !== true) mm.dispose?.(); }
    else if (m.userData?.shared !== true) m.dispose?.();
  });
}
