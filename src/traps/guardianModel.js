import * as THREE from 'three';
import { M, GEO, lamp, glow, instance, box, cyl, bar, approach } from './parts.js';

/**
 * Hired allies. Deliberately human-shaped, brightly lit and ringed so they never read as
 * orcs, and so different from each other that you can tell your line-holder from your
 * marksman at a glance from the top-down camera:
 *
 *   paladin — widest silhouette, tower shield out front, planted feet. He is a wall.
 *   archer  — narrow, hooded, longbow held across the body, quiver on the back.
 *   hunter  — crouched, cloaked, crossbow low, vials of poison on the belt.
 *
 * Each returns `userData.rig` with attack/tick/hurt/die/setLevel and `userData.bar`
 * (a billboard health bar TrapManager keeps facing the camera).
 */
export function buildGuardian(spec = {}) {
  const { kind = 'archer', color = 0x3a6a3a, blocker = false } = spec;
  const g = new THREE.Group();

  const cloth = new THREE.MeshStandardMaterial({ color, roughness: 0.8 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x2a2a30, roughness: 0.85 });
  const skin = new THREE.MeshStandardMaterial({ color: 0xc99a76, roughness: 0.85 });
  const plate = kind === 'paladin' ? M.steel : M.darkSteel;
  const trim = lamp(kind === 'paladin' ? 0xffd870 : color, 0.55);

  const body = new THREE.Group();
  body.position.y = 1.0;
  g.add(body);

  const wide = blocker ? 1.0 : 0.72;
  const torso = new THREE.Mesh(GEO.box, blocker ? plate : cloth);
  torso.scale.set(wide, 0.98, 0.52);
  body.add(torso);
  // Tabard / belt: a horizontal band breaks the box up and reads as clothing.
  const tabard = box(wide * 0.55, 0.7, 0.56, trim, 0, -0.16, 0.01);
  body.add(tabard);

  const head = box(0.4, 0.44, 0.4, skin, 0, 0.74, 0);
  body.add(head);

  const legs = new THREE.Group();
  body.add(legs);
  for (const sx of [-1, 1]) {
    const leg = box(0.26, 0.92, 0.28, blocker ? plate : dark, sx * (blocker ? 0.28 : 0.2), -0.94, 0);
    legs.add(leg);
  }

  const arms = [];
  for (const sx of [-1, 1]) {
    const sh = new THREE.Group();
    sh.position.set(sx * (blocker ? 0.62 : 0.46), 0.34, 0);
    body.add(sh);
    const upper = box(0.24, 0.82, 0.24, blocker ? plate : cloth, 0, -0.42, 0);
    sh.add(upper);
    arms.push(sh);
  }

  let helm, shield, weapon, bowString, hood, quiver;

  if (kind === 'paladin') {
    // Great helm with a plume — the tallest, loudest guardian on the field.
    helm = new THREE.Mesh(GEO.box, plate);
    helm.scale.set(0.48, 0.5, 0.48);
    helm.position.y = 0.78;
    body.add(helm);
    body.add(box(0.1, 0.34, 0.12, trim, 0, 1.12, -0.05));
    body.add(box(0.42, 0.08, 0.06, dark, 0, 0.8, 0.22));   // visor slit
    // Pauldrons.
    for (let i = 0; i < 2; i++) {
      const p = new THREE.Mesh(GEO.sphere, plate);
      p.scale.set(0.42, 0.3, 0.42);
      p.position.y = 0.02;
      arms[i].add(p);
    }
    shield = new THREE.Group();
    shield.position.set(0, -0.75, 0.34);
    arms[0].add(shield);
    const face = box(0.14, 1.5, 1.05, plate, 0, 0, 0);
    shield.add(face);
    shield.add(box(0.06, 0.9, 0.3, trim, 0.09, 0.05, 0));   // heraldry
    shield.add(instance(GEO.rivet, M.gold, [
      { p: [0.1, 0.6, 0.38], s: [0.14, 0.1, 0.14] }, { p: [0.1, 0.6, -0.38], s: [0.14, 0.1, 0.14] },
      { p: [0.1, -0.6, 0.38], s: [0.14, 0.1, 0.14] }, { p: [0.1, -0.6, -0.38], s: [0.14, 0.1, 0.14] },
    ]));
    weapon = new THREE.Group();
    weapon.position.set(0, -0.85, 0.1);
    arms[1].add(weapon);
    weapon.add(cyl(0.07, 1.1, M.darkWood, 0, 0.1, 0));
    weapon.add(box(0.42, 0.5, 0.42, plate, 0, -0.5, 0));
    weapon.add(box(0.5, 0.16, 0.16, M.gold, 0, -0.5, 0));
  } else if (kind === 'archer') {
    hood = new THREE.Mesh(GEO.sphere, cloth);
    hood.scale.set(0.58, 0.56, 0.62);
    hood.position.set(0, 0.8, -0.04);
    body.add(hood);
    body.add(box(0.3, 0.16, 0.1, dark, 0, 0.72, 0.2));    // shadowed face
    quiver = cyl(0.13, 0.75, M.darkWood, -0.3, 0.1, -0.3);
    quiver.rotation.x = 0.5; quiver.rotation.z = 0.35;
    body.add(quiver);
    body.add(instance(GEO.cone5, lamp(0xffd070, 0.5), [
      { p: [-0.3, 0.52, -0.42], r: [0.5, 0, 0.35], s: [0.09, 0.28, 0.09] },
      { p: [-0.36, 0.5, -0.38], r: [0.5, 0, 0.35], s: [0.09, 0.28, 0.09] },
    ]));
    weapon = new THREE.Group();
    weapon.position.set(0, -0.8, 0.2);
    arms[1].add(weapon);
    const bow = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 4, 14, Math.PI * 1.25), M.darkWood);
    bow.rotation.y = Math.PI / 2;
    bow.rotation.z = Math.PI * 0.375;
    weapon.add(bow);
    bowString = box(0.02, 1.05, 0.02, M.bone, 0, 0, -0.28);
    weapon.add(bowString);
  } else {
    // hunter: crouched, cloaked, crossbow low. Reads instantly as "the other archer".
    hood = new THREE.Mesh(GEO.cone, cloth);
    hood.scale.set(0.7, 0.7, 0.7);
    hood.position.set(0, 0.92, -0.02);
    body.add(hood);
    const cape = box(0.9, 1.3, 0.1, cloth, 0, -0.2, -0.3);
    body.add(cape);
    body.add(instance(GEO.cyl8, lamp(0x8aff40, 0.8), [
      { p: [0.34, -0.18, 0.26], s: [0.13, 0.26, 0.13] },
      { p: [0.16, -0.2, 0.3], s: [0.11, 0.22, 0.11] },
    ]));
    weapon = new THREE.Group();
    weapon.position.set(0, -0.86, 0.28);
    arms[1].add(weapon);
    weapon.add(box(0.12, 0.12, 0.9, M.darkWood, 0, 0, 0.1));
    weapon.add(box(0.95, 0.08, 0.12, M.darkSteel, 0, 0.02, 0.42));
    bowString = box(0.9, 0.02, 0.02, M.bone, 0, 0.02, 0.3);
    weapon.add(bowString);
    body.position.y = 0.94;
  }

  // Ally ring — instantly distinguishes hired help from the horde, and its brightness
  // doubles as "this one has a target".
  const ringMat = glow(color, 0.26);
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.8, 1.02, 24).rotateX(-Math.PI / 2), ringMat,
  );
  ring.position.y = 0.05;
  g.add(ring);
  // A paladin's ring is a full disc: it marks the tile nothing may walk through.
  const blockDisc = blocker
    ? new THREE.Mesh(new THREE.CircleGeometry(1.85, 22).rotateX(-Math.PI / 2), glow(0xffd870, 0.07))
    : null;
  if (blockDisc) { blockDisc.position.y = 0.045; g.add(blockDisc); }

  const hp = bar(blocker ? 1.7 : 1.3);
  hp.position.y = blocker ? 2.85 : 2.5;
  g.add(hp);

  let hurtT = 0;

  const rig = {
    _swing: 0, _draw: 0,
    attack() {
      if (kind === 'paladin') this._swing = 0.4;
      else this._draw = 0.3;
    },
    hurt() { hurtT = 0.14; },
    tick(dt, st = {}) {
      const t = performance.now() * 0.001;
      if (this._swing > 0) {
        this._swing -= dt;
        const p = this._swing / 0.4;
        arms[1].rotation.x = -2.1 * Math.sin(p * Math.PI);
        body.rotation.y = -0.35 * Math.sin(p * Math.PI);
      } else {
        arms[1].rotation.x = approach(arms[1].rotation.x, kind === 'paladin' ? 0 : -0.15, 8, dt);
        body.rotation.y = approach(body.rotation.y, 0, 8, dt);
      }
      if (this._draw > 0) {
        this._draw -= dt;
        const p = this._draw / 0.3;
        // Draw and release: the string snaps forward, the shoulder recoils.
        if (bowString) bowString.position.z = (kind === 'archer' ? -0.28 : 0.3) - p * 0.22 * (kind === 'archer' ? 1 : -1);
        arms[0].rotation.x = -0.9 - p * 0.5;
      } else {
        if (bowString) bowString.position.z = kind === 'archer' ? -0.28 : 0.3;
        arms[0].rotation.x = approach(arms[0].rotation.x, blocker ? -0.5 : -0.85, 7, dt);
      }

      // Idle breathing, and a braced stance while a blocker is actually holding bodies.
      const base = kind === 'hunter' ? 0.94 : 1.0;
      body.position.y = base + Math.sin(t * 2) * 0.03 - (st.blocking ? 0.06 : 0);
      if (blockDisc) blockDisc.material.opacity = st.blocking ? 0.2 : 0.07;
      ringMat.opacity = st.hasTarget ? 0.4 : 0.22;
      hp.userData.set(st.hpFrac ?? 1);
      hp.visible = (st.hpFrac ?? 1) < 0.999;

      // Hit reaction: a short body-wide swell. Scaling the whole rig avoids touching
      // the individually-scaled parts (and their shared materials) at all.
      if (hurtT > 0) hurtT -= dt;
      const f = Math.max(0, hurtT / 0.14);
      body.scale.setScalar(1 + f * 0.07);
    },
    setLevel(n) {
      trim.emissiveIntensity = 0.4 + n * 0.35;
      if (n >= 2) g.scale.setScalar(1 + (n - 1) * 0.06);
      if (n >= 3) {
        trim.color.setHex(0xffe9a0); trim.emissive.setHex(0xffe9a0);
        ringMat.color.setHex(0xffd870);
      }
    },
  };
  g.userData.rig = rig;
  g.userData.bar = hp;
  return g;
}
