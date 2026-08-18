import * as THREE from 'three';
import { TILE, CEIL_H } from '../world/Grid.js';
import { GEO, glow, disposeTrap } from './parts.js';
import { OPPOSITE } from './roster.js';

const DIR_TO_VEC = { N: { x: 0, z: -1 }, E: { x: 1, z: 0 }, S: { x: 0, z: 1 }, W: { x: -1, z: 0 } };

/**
 * Build-mode preview.
 *
 * A flat tinted mesh tells you *where* a trap goes and nothing else. To place a trap
 * well you need four more things before you commit coin: which tiles it will actually
 * cover, which way it shoots, what it costs, and — when it is illegal — why. All four
 * are drawn in world space so they survive a screenshot and never fight the HUD.
 */
export class BuildGhost {
  constructor(game, root) {
    this.game = game;
    this.group = new THREE.Group();
    this.group.name = 'build-ghost';
    root.add(this.group);

    this.legalMat = new THREE.MeshBasicMaterial({ color: 0x50ffa0, transparent: true, opacity: 0.5, depthWrite: false });
    this.illegalMat = new THREE.MeshBasicMaterial({ color: 0xff3648, transparent: true, opacity: 0.5, depthWrite: false });
    this.upgradeMat = new THREE.MeshBasicMaterial({ color: 0xffd050, transparent: true, opacity: 0.5, depthWrite: false });
    // The ghost body borrows these, so swapping the ghost model must not dispose them.
    for (const m of [this.legalMat, this.illegalMat, this.upgradeMat]) m.userData.shared = true;

    // Tile under the cursor.
    this.tile = new THREE.Mesh(GEO.quad, this.legalMat.clone());
    this.tile.scale.set(TILE * 0.96, 1, TILE * 0.96);
    this.tile.position.y = 0.07;
    this.tile.renderOrder = 4;
    this.group.add(this.tile);
    this.tileEdge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(TILE * 0.98, 0.02, TILE * 0.98)),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    this.tileEdge.position.y = 0.09;
    this.group.add(this.tileEdge);

    // Every tile the trap will actually reach. 25 is more than any trap covers.
    this.fpMat = glow(0xffc040, 0.22);
    this.footprint = new THREE.InstancedMesh(GEO.quad, this.fpMat, 25);
    this.footprint.frustumCulled = false;
    this.footprint.count = 0;
    this.footprint.renderOrder = 3;
    this.group.add(this.footprint);

    // Firing direction.
    this.arrow = new THREE.Group();
    const shaft = new THREE.Mesh(GEO.box, glow(0xffe090, 0.85));
    shaft.scale.set(0.3, 0.02, TILE * 0.8);
    shaft.position.z = TILE * 0.45;
    const headMat = glow(0xffe090, 0.9);
    const head = new THREE.Mesh(GEO.cone5, headMat);
    head.scale.set(0.85, 0.9, 0.85);
    head.rotation.x = Math.PI / 2;
    head.position.z = TILE * 0.95;
    this.arrow.add(shaft); this.arrow.add(head);
    this.arrow.position.y = 0.12;
    this.group.add(this.arrow);

    // Surface hint: a slab on the wall / ceiling so you can see what it mounts to.
    this.surfaceHint = new THREE.Mesh(GEO.box, glow(0x80d0ff, 0.3));
    this.group.add(this.surfaceHint);

    this.label = new Label();
    this.group.add(this.label.sprite);

    this.model = null;
    this._modelId = null;
    this._m = new THREE.Matrix4();
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3(TILE * 0.9, 1, TILE * 0.9);
    this.group.visible = false;
  }

  setVisible(v) { this.group.visible = v; }

  /** Swap in the ghost body for a new trap type. */
  setModel(def, buildFn) {
    if (this._modelId === def?.id) return;
    if (this.model) { this.group.remove(this.model); disposeTrap(this.model); this.model = null; }
    this._modelId = def?.id ?? null;
    if (!def) return;
    const obj = buildFn(def);
    // Freeze the ghost in its *fired* pose — spikes up, blades out, block dropped. You
    // are buying the moment the trap kills something, so that is what you should see.
    const rig = obj.userData.rig;
    const stub = { level: 1, phase: 'fire', gx: 0, gz: 0, _t: 0 };
    try { rig?.charge?.(1, stub); rig?.wind?.(1, stub); rig?.fire?.(stub, this.game); } catch (e) { /* pose is cosmetic */ }
    obj.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = false; o.receiveShadow = false;
      o.material = this.legalMat;
    });
    this.model = obj;
    this.group.add(obj);
  }

  /**
   * @param {object} p { def, gx, gz, dir, check, world, existing }
   */
  update(p) {
    const { def, dir, check, world, existing } = p;
    const ok = check.ok;
    const mode = existing ? 'upgrade' : ok ? 'legal' : 'illegal';
    const mat = mode === 'upgrade' ? this.upgradeMat : ok ? this.legalMat : this.illegalMat;
    const color = mode === 'upgrade' ? 0xffd050 : ok ? 0x50ffa0 : 0xff3648;

    this.group.position.set(world.x, 0, world.z);
    this.tile.material.color.setHex(color);
    this.tile.material.opacity = 0.28;

    if (this.model) {
      this.model.visible = !existing;
      this.model.rotation.y = angleFor(def, check.dir ?? dir);
      this.model.traverse((o) => { if (o.isMesh) o.material = mat; });
    }

    // --- footprint ---------------------------------------------------------
    const cells = footprint(def, check.dir ?? dir);
    this.fpMat.color.setHex(color);
    this.fpMat.opacity = ok || existing ? 0.2 : 0.1;
    for (let i = 0; i < cells.length && i < 25; i++) {
      this._p.set(cells[i][0] * TILE, 0.055, cells[i][1] * TILE);
      this.footprint.setMatrixAt(i, this._m.compose(this._p, this._q, this._s));
    }
    this.footprint.count = Math.min(cells.length, 25);
    this.footprint.instanceMatrix.needsUpdate = true;

    // --- direction ---------------------------------------------------------
    const aimed = def.surface === 'wall' || def.id === 'spring-trap';
    this.arrow.visible = aimed && !existing;
    if (aimed) {
      const d = def.surface === 'wall' ? OPPOSITE[check.dir ?? dir] : (check.dir ?? dir);
      const v = DIR_TO_VEC[d] || DIR_TO_VEC.S;
      this.arrow.rotation.y = Math.atan2(v.x, v.z);
    }

    // --- surface hint ------------------------------------------------------
    const sh = this.surfaceHint;
    if (def.surface === 'wall' && check.dir) {
      const v = DIR_TO_VEC[check.dir];
      sh.visible = true;
      sh.scale.set(v.x ? 0.3 : TILE * 0.9, 3.0, v.z ? 0.3 : TILE * 0.9);
      sh.position.set(v.x * TILE * 0.5, 1.6, v.z * TILE * 0.5);
      sh.material.color.setHex(color);
    } else if (def.surface === 'ceiling') {
      sh.visible = true;
      sh.scale.set(TILE * 0.9, 0.2, TILE * 0.9);
      sh.position.set(0, CEIL_H - 0.2, 0);
      sh.material.color.setHex(color);
    } else {
      sh.visible = false;
    }

    // --- label -------------------------------------------------------------
    if (existing) {
      const next = existing.level + 1;
      const cost = existing.def.upgrade?.costs?.[existing.level - 1];
      if (existing.level >= 3) this.label.set(`${existing.def.name}  ·  LVL 3 MAX`, 'RIGHT-CLICK TO SELL', 0xffd050);
      else if (cost === undefined) this.label.set(existing.def.name, 'RIGHT-CLICK TO SELL', 0xffd050);
      else this.label.set(`UPGRADE → LVL ${next}`, `${cost} COIN  ·  ${existing.def.upgrade.notes[existing.level - 1]}`, check.ok ? 0xffd050 : 0xff6a5a);
    } else if (ok) {
      this.label.set(def.name, `${def.cost} COIN`, 0x8affc0);
    } else {
      this.label.set(def.name, check.reason || 'Cannot build here', 0xff6a5a);
    }
    this.label.sprite.position.set(0, def.surface === 'ceiling' ? 4.2 : 2.9, 0);
  }

  dispose() {
    if (this.model) disposeTrap(this.model);
    this.label.dispose();
    this.group.parent?.remove(this.group);
  }
}

/** Which tiles (relative to the trap tile) a trap actually affects. */
export function footprint(def, dir = 'S') {
  const out = [[0, 0]];
  const s = def.sense || {};
  if (def.surface === 'guardian') {
    const r = Math.round((def.guardian?.range ?? 8) / TILE);
    for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dz === 0) continue;
      if (dx * dx + dz * dz <= r * r && out.length < 25) out.push([dx, dz]);
    }
    return out;
  }
  if (s.kind === 'lane') {
    const d = def.surface === 'wall' ? OPPOSITE[dir] : dir;
    const v = DIR_TO_VEC[d] || DIR_TO_VEC.S;
    for (let i = 1; i <= (s.length ?? 1); i++) out.push([v.x * i, v.z * i]);
    return out;
  }
  const r = (s.radius ?? TILE * 0.5) / TILE;
  const n = Math.ceil(r - 0.5);
  for (let dz = -n; dz <= n; dz++) for (let dx = -n; dx <= n; dx++) {
    if (dx === 0 && dz === 0) continue;
    if (Math.hypot(dx, dz) <= r + 0.15) out.push([dx, dz]);
  }
  return out;
}

/** Ghost rotation: wall traps face away from the wall they mount on. */
export function angleFor(def, dir) {
  const ANG = { N: Math.PI, E: -Math.PI / 2, S: 0, W: Math.PI / 2 };
  if (def.surface === 'wall') return ANG[OPPOSITE[dir] || 'N'];
  if (def.surface === 'floor') return ANG[dir] ?? 0;
  return 0;
}

/** World-space text panel. Canvas texture, redrawn only when the text changes. */
class Label {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = 512; this.canvas.height = 128;
    this.ctx = this.canvas.getContext('2d');
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.tex, transparent: true, depthTest: false, depthWrite: false,
    }));
    this.sprite.scale.set(6.4, 1.6, 1);
    this.sprite.renderOrder = 30;
    this._key = '';
  }

  set(title, sub, color = 0x8affc0) {
    const key = `${title}|${sub}|${color}`;
    if (key === this._key) return;
    this._key = key;
    const c = this.ctx;
    c.clearRect(0, 0, 512, 128);
    c.fillStyle = 'rgba(8,9,14,0.78)';
    roundRect(c, 6, 10, 500, 108, 12);
    c.fill();
    c.strokeStyle = '#' + color.toString(16).padStart(6, '0');
    c.lineWidth = 3;
    roundRect(c, 6, 10, 500, 108, 12);
    c.stroke();
    c.textAlign = 'center';
    c.fillStyle = '#fff';
    // Upgrade notes are long; shrink to fit rather than letting the panel clip them.
    fit(c, title.toUpperCase(), 700, 40, 470, 256, 60);
    c.fillStyle = '#' + color.toString(16).padStart(6, '0');
    fit(c, sub.toUpperCase(), 600, 28, 470, 256, 100);
    this.tex.needsUpdate = true;
  }

  dispose() { this.tex.dispose(); this.sprite.material.dispose(); }
}

/** Draw `text` centred at (x,y), shrinking the font until it fits `maxW`. */
function fit(c, text, weight, size, maxW, x, y) {
  let s = size;
  do {
    c.font = `${weight} ${s}px system-ui, sans-serif`;
    if (c.measureText(text).width <= maxW) break;
    s -= 2;
  } while (s > 12);
  c.fillText(text, x, y);
}

function roundRect(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

