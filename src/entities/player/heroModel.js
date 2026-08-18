import * as THREE from 'three';

/**
 * The War Mage, built for one specific viewing condition: a 52-degree camera 32-38
 * units away, where the whole character is about forty pixels tall and is standing in
 * a crowd of two hundred orcs that are roughly the same size and the same colour as
 * the floor.
 *
 * At that size, anatomy is worthless. What actually reads is:
 *
 *   1. A ground plate.  A dark vignette band under the hero separates him from the floor
 *      tiles, and a bright rim (drawn with depth-test off, so a scrum cannot bury it)
 *      makes him findable instantly. Nothing else on the field has one.
 *   2. An aim lance.    A tinted wedge painted on the floor from the hero toward the
 *      cursor, scaled to the equipped weapon's reach. This — not the body — is how you
 *      know where you are shooting, and it is how you learn that the blunderbuss is a
 *      stub and the crossbow is a lance.
 *   3. The hat.         From above the hero is basically a hat. So it is a wide gold
 *      brim with a hard forward point, and the point is the facing.
 *   4. The cloak.       Crimson, wide, and it flares when you move. The only saturated
 *      red on the field that is not blood.
 *   5. A gauge ring.    Sixteen ticks around the plate carry ammo (or mana), and three
 *      lamps behind the hero carry spell readiness. State without a HUD glance.
 *
 * States are read from the same silhouette: dodging flattens and streaks, firing flashes
 * the muzzle and pulses the plate, hurt washes the whole model red, dead leaves a
 * filling respawn ring on the floor.
 *
 * All animation runs on `game.clock.elapsed` / `dt`, never `performance.now()`, so the
 * hero freezes with everything else during pause and hitstop.
 */

const GOLD = 0xe0a83a;
const NAVY = 0x27406e;
const CRIMSON = 0xc4203c;
const BODY_SCALE = 1.12;
const BODY_Y = 1.14;

export function buildHero() {
  const group = new THREE.Group();

  const mats = {
    cloth: new THREE.MeshStandardMaterial({ color: NAVY, roughness: 0.85 }),
    trim: new THREE.MeshStandardMaterial({ color: GOLD, roughness: 0.3, metalness: 0.75 }),
    skin: new THREE.MeshStandardMaterial({ color: 0xd2a582, roughness: 0.8 }),
    leather: new THREE.MeshStandardMaterial({ color: 0x4a3626, roughness: 0.9 }),
    cloak: new THREE.MeshStandardMaterial({ color: CRIMSON, roughness: 0.8, side: THREE.DoubleSide }),
    steel: new THREE.MeshStandardMaterial({ color: 0xb6bcc6, roughness: 0.35, metalness: 0.85 }),
    wood: new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 0.9 }),
  };
  // Every lit material gets washed on hit; collect them once so the flash is one loop.
  const tintMats = Object.values(mats);
  for (const m of tintMats) m.emissive = new THREE.Color(0, 0, 0);

  const glow = new THREE.MeshStandardMaterial({
    color: 0x8fe8ff, emissive: 0x40d8ff, emissiveIntensity: 3.5, roughness: 0.2, toneMapped: false,
  });

  // A personal key light. The levels are torch-lit and mostly dark, and a hero who
  // walks into an unlit corridor and vanishes is not a hero you can play. It also lights
  // the orcs immediately around him, which is exactly where you are looking.
  const keyLight = new THREE.PointLight(0xffe4bc, 2.6, 13, 2);
  keyLight.position.set(0, 3.4, -0.6);
  group.add(keyLight);

  // ---------------------------------------------------------------- ground plate
  // Counter-rotated against the body every frame so it stays world-aligned: the aim
  // lance points at the cursor and the spell lamps stay at the bottom of the screen
  // regardless of which way the hero is facing.
  const ground = new THREE.Group();
  ground.position.y = 0.03;
  group.add(ground);

  // A dark vignette band, drawn with normal blending, is what actually separates the
  // hero from a brightly lit floor. An additive ring alone just washes out on stone.
  const plate = new THREE.Mesh(
    new THREE.RingGeometry(0.62, 1.5, 30).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x05070d, transparent: true, opacity: 0.42, depthWrite: false }),
  );
  plate.renderOrder = 3;
  ground.add(plate);

  const rim = new THREE.Mesh(
    new THREE.RingGeometry(1.0, 1.13, 34).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0x50e0ff, transparent: true, opacity: 0.85, depthTest: false,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
  );
  // depthTest off: in a twenty-orc scrum the ring is the only thing guaranteed to tell
  // you where you are standing, so it draws over the bodies piled on top of it.
  rim.position.y = 0.012;
  rim.renderOrder = 4;
  ground.add(rim);

  // Aim lance ------------------------------------------------------------------
  const aimPivot = new THREE.Group();
  aimPivot.position.y = 0.02;
  ground.add(aimPivot);
  const lanceTex = makeLanceTexture();
  // Normal blending, not additive: additive cyan over a torch-lit orange floor turns
  // white, and then the lance no longer tells you which weapon is up.
  const lance = new THREE.Mesh(makeWedgeGeometry(), new THREE.MeshBasicMaterial({
    map: lanceTex, transparent: true, depthWrite: false,
    color: 0x2ec8ff, opacity: 0.85, toneMapped: false, side: THREE.DoubleSide,
  }));
  lance.renderOrder = 5;
  aimPivot.add(lance);

  // Ammo / mana gauge ----------------------------------------------------------
  // Small and quiet. An earlier pass used sixteen fat spokes and the hero read as a
  // cog rather than a person; the gauge only earns space when there is something to say.
  const gaugeGeo = new THREE.PlaneGeometry(0.07, 0.15).rotateX(-Math.PI / 2);
  const ticks = [];
  const TICKS = 16;
  const gaugeGroup = new THREE.Group();
  ground.add(gaugeGroup);
  for (let i = 0; i < TICKS; i++) {
    // Start behind the hero and sweep clockwise, so a draining magazine visibly empties
    // from one end rather than jittering symmetrically.
    const a = Math.PI + (i / TICKS) * Math.PI * 2;
    const m = new THREE.Mesh(gaugeGeo, new THREE.MeshBasicMaterial({
      color: 0x40d8ff, transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    m.position.set(Math.sin(a) * 1.26, 0.015, Math.cos(a) * 1.26);
    m.rotation.y = a;
    m.renderOrder = 5;
    gaugeGroup.add(m);
    ticks.push(m);
  }

  // Spell lamps ----------------------------------------------------------------
  const lampGeo = new THREE.CircleGeometry(0.155, 14).rotateX(-Math.PI / 2);
  const lampBackGeo = new THREE.CircleGeometry(0.25, 14).rotateX(-Math.PI / 2);
  const lamps = [];
  for (let i = 0; i < 3; i++) {
    const a = (i - 1) * 0.46;   // a shallow arc at the bottom of the screen (+Z)
    const x = Math.sin(a) * 1.75, z = Math.cos(a) * 1.75;
    const back = new THREE.Mesh(lampBackGeo, new THREE.MeshBasicMaterial({
      color: 0x05070d, transparent: true, opacity: 0.6, depthWrite: false,
    }));
    back.position.set(x, 0.014, z);
    back.renderOrder = 5;
    ground.add(back);
    const m = new THREE.Mesh(lampGeo, new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false,
    }));
    m.position.set(x, 0.016, z);
    m.renderOrder = 6;
    ground.add(m);
    lamps.push(m);
  }

  // Dodge streak ---------------------------------------------------------------
  const streak = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 6.0).rotateX(-Math.PI / 2).translate(0, 0, -3.1),
    new THREE.MeshBasicMaterial({
      map: makeLanceTexture(), color: 0x9fe8ff, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    }),
  );
  streak.position.y = 0.05;
  streak.renderOrder = 5;
  streak.visible = false;
  ground.add(streak);

  // Respawn ring ---------------------------------------------------------------
  const respawn = new THREE.Mesh(
    new THREE.RingGeometry(1.3, 1.75, 40).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({
      color: 0xff4030, transparent: true, opacity: 0.9, depthWrite: false,
      blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide,
    }),
  );
  respawn.position.y = 0.06;
  respawn.renderOrder = 7;
  respawn.visible = false;
  ground.add(respawn);

  // ---------------------------------------------------------------- body
  // The hero reads as "the one who is not an orc" partly by being physically bigger
  // than everything below tier 5. Orcs are 1.7-2.15 units; BODY_SCALE puts him at ~2.2.
  const body = new THREE.Group();
  body.position.y = BODY_Y;
  body.scale.setScalar(BODY_SCALE);
  group.add(body);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.95, 0.54), mats.cloth);
  torso.castShadow = true;
  body.add(torso);

  const sash = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.14, 0.58), mats.trim);
  sash.position.y = -0.4;
  body.add(sash);
  // A gold chest chevron pointing forward: the second facing cue after the hat point.
  const chevron = new THREE.Mesh(new THREE.ConeGeometry(0.3, 0.42, 3), mats.trim);
  chevron.rotation.set(Math.PI / 2, 0, Math.PI);
  chevron.position.set(0, 0.12, 0.3);
  body.add(chevron);

  // The cloak is the biggest coloured area from above — deliberately oversized.
  const cloak = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 1.02, 1.55, 10, 1, true, Math.PI * 0.28, Math.PI * 1.44),
    mats.cloak,
  );
  cloak.position.set(0, -0.32, -0.1);
  cloak.rotation.x = 0.12;
  cloak.castShadow = true;
  body.add(cloak);
  const cloakTrim = new THREE.Mesh(
    new THREE.TorusGeometry(0.44, 0.045, 5, 12, Math.PI * 1.44).rotateX(Math.PI / 2),
    mats.trim,
  );
  cloakTrim.rotation.z = -Math.PI * 0.28 - Math.PI * 1.44 + Math.PI / 2;
  cloakTrim.position.set(0, 0.44, -0.1);
  body.add(cloakTrim);

  // Head + hat -----------------------------------------------------------------
  const neck = new THREE.Group();
  neck.position.y = 0.6;
  body.add(neck);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.44, 0.4), mats.skin);
  head.position.y = 0.08;
  head.castShadow = true;
  neck.add(head);

  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.82, 0.86, 0.07, 14), mats.trim);
  brim.position.y = 0.3;
  brim.castShadow = true;
  neck.add(brim);
  // The point. From straight above this triangle is the whole facing read — so it is
  // deliberately steel against the gold brim: same shape in one colour reads as a blob.
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.36, 0.78, 3), mats.steel);
  beak.rotation.set(Math.PI / 2, 0, Math.PI);
  beak.position.set(0, 0.32, 0.78);
  neck.add(beak);
  const crown = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.75, 8), mats.cloth);
  crown.position.y = 0.68;
  crown.castShadow = true;
  neck.add(crown);
  const crownTip = new THREE.Mesh(new THREE.IcosahedronGeometry(0.11, 0), glow);
  crownTip.position.y = 1.08;
  neck.add(crownTip);

  // Arms -----------------------------------------------------------------------
  const arms = [];
  for (const sx of [-1, 1]) {
    const shoulder = new THREE.Group();
    shoulder.position.set(sx * 0.48, 0.36, 0);
    body.add(shoulder);
    // Bright pauldrons widen the silhouette; from above they frame the hat.
    const pauldron = new THREE.Mesh(new THREE.SphereGeometry(0.26, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), mats.steel);
    pauldron.scale.set(1.15, 0.8, 1.0);
    pauldron.castShadow = true;
    shoulder.add(pauldron);
    const upper = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.48, 0.22), mats.cloth);
    upper.position.y = -0.26;
    shoulder.add(upper);
    const forearm = new THREE.Group();
    forearm.position.y = -0.48;
    shoulder.add(forearm);
    const lower = new THREE.Mesh(new THREE.BoxGeometry(0.21, 0.44, 0.21), mats.leather);
    lower.position.y = -0.2;
    forearm.add(lower);
    arms.push({ shoulder, forearm, side: sx });
  }

  // Weapons --------------------------------------------------------------------
  const weaponRoot = new THREE.Group();
  weaponRoot.position.set(0, -0.4, 0.14);
  arms[1].forearm.add(weaponRoot);
  const weapons = buildWeaponModels(mats, glow);
  for (const k in weapons) weaponRoot.add(weapons[k].group);

  const muzzle = new THREE.PointLight(0x40d8ff, 0, 5.5, 2);
  muzzle.position.set(0, 0, 1.0);
  weaponRoot.add(muzzle);

  // Legs -----------------------------------------------------------------------
  const legs = [];
  for (const sx of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(sx * 0.2, -0.5, 0);
    body.add(hip);
    const thigh = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.48, 0.25), mats.cloth);
    thigh.position.y = -0.24;
    thigh.castShadow = true;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.48;
    hip.add(knee);
    const shin = new THREE.Mesh(new THREE.BoxGeometry(0.23, 0.44, 0.23), mats.leather);
    shin.position.y = -0.22;
    knee.add(shin);
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.29, 0.16, 0.42), mats.leather);
    boot.position.set(0, -0.44, 0.07);
    knee.add(boot);
    legs.push({ hip, knee, side: sx });
  }

  const rig = new HeroRig({
    group, body, neck, arms, legs, weaponRoot, weapons, muzzle, cloak, crownTip, keyLight,
    ground, plate, rim, aimPivot, lance, ticks, gaugeGroup, lamps, streak, respawn,
    mats, tintMats, glow,
  });
  return { group, rig };
}

// --- weapon models ----------------------------------------------------------

function buildWeaponModels(mats, glow) {
  const out = {};

  // Crossbow: wide limbs read as a "T" from above.
  {
    const g = new THREE.Group();
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.15, 0.95), mats.wood);
    stock.position.z = 0.25;
    g.add(stock);
    const limbs = new THREE.Mesh(new THREE.BoxGeometry(1.05, 0.07, 0.11), mats.trim);
    limbs.position.z = 0.62;
    g.add(limbs);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.13, 0), glow);
    core.position.z = 0.2;
    g.add(core);
    out.crossbow = { group: g, core };
  }

  // Blunderbuss: a fat flared bell. Unmistakably a different shape to the crossbow.
  {
    const g = new THREE.Group();
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.5), mats.wood);
    stock.position.z = -0.02;
    g.add(stock);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.1, 0.55, 8).rotateX(Math.PI / 2), mats.steel);
    barrel.position.z = 0.42;
    g.add(barrel);
    const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.13, 0.34, 10, 1, true).rotateX(Math.PI / 2), mats.trim);
    bell.position.z = 0.82;
    g.add(bell);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.1, 0), glow.clone());
    core.material.color.setHex(0xffb060); core.material.emissive.setHex(0xff7a20);
    core.position.z = 0.78;
    g.add(core);
    out.blunderbuss = { group: g, core };
  }

  // Staff: long shaft, orb held out front.
  {
    const g = new THREE.Group();
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 1.7, 6).rotateX(Math.PI / 2), mats.wood);
    shaft.position.z = 0.35;
    g.add(shaft);
    const claw = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.045, 5, 10).rotateY(Math.PI / 2), mats.trim);
    claw.position.z = 1.06;
    g.add(claw);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), glow.clone());
    core.material.color.setHex(0xffb060); core.material.emissive.setHex(0xff5a10);
    core.position.z = 1.06;
    g.add(core);
    out.staff = { group: g, core };
  }

  // Lightning ring: a floating torus, no handle. Spins when equipped.
  {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.06, 6, 14), mats.steel);
    ring.position.z = 0.5;
    g.add(ring);
    const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.15, 1), glow.clone());
    core.material.color.setHex(0xcfe8ff); core.material.emissive.setHex(0x60b0ff);
    core.position.z = 0.5;
    g.add(core);
    out.lightning = { group: g, core, ring };
  }

  return out;
}

// --- textures / geometry helpers --------------------------------------------

/** Soft ramp used by the aim lance and the dodge streak: bright at v=0, gone at v=1. */
function makeLanceTexture() {
  const cv = document.createElement('canvas');
  cv.width = 8; cv.height = 128;
  const g = cv.getContext('2d');
  const grd = g.createLinearGradient(0, 128, 0, 0);
  grd.addColorStop(0.0, 'rgba(255,255,255,0.0)');
  grd.addColorStop(0.06, 'rgba(255,255,255,0.85)');
  grd.addColorStop(0.35, 'rgba(255,255,255,0.40)');
  grd.addColorStop(0.85, 'rgba(255,255,255,0.10)');
  grd.addColorStop(1.0, 'rgba(255,255,255,0.0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 8, 128);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A flat quad tapering from 0.9 wide at z=0 to 0.28 wide at z=1, UV.v along its length. */
function makeWedgeGeometry() {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([
    -0.45, 0, 0, 0.45, 0, 0, 0.14, 0, 1, -0.14, 0, 1,
  ], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.computeVertexNormals();
  return g;
}

const damp2 = (a, b, r, dt) => a + (b - a) * (1 - Math.pow(r, dt));

// --- rig --------------------------------------------------------------------

class HeroRig {
  constructor(p) {
    Object.assign(this, p);
    this.phase = 0;
    this._recoil = 0;
    this._swing = 0;
    this._swapSpin = 0;
    this._plateFlash = 0;
    this._weaponId = null;
    this._readiness = [];
    this.setWeapon('crossbow');
  }

  recoil(amount) { this._recoil = amount; this._plateFlash = 1; }
  swing() { this._swing = 0.5; this._plateFlash = 0.6; }

  /** Called by the player on every weapon change; also spins the hand for the swap tell. */
  setWeapon(id) {
    if (id === this._weaponId) return;
    this._weaponId = id;
    for (const k in this.weapons) this.weapons[k].group.visible = (k === id);
    this._swapSpin = 1;
    this._plateFlash = 0.5;
  }

  reset() {
    this._recoil = 0; this._swing = 0; this._swapSpin = 0; this._plateFlash = 0;
    this.respawn.visible = false;
    this.body.visible = true;
    this.group.visible = true;
  }

  /**
   * @param {Player} player
   * @param {number} dt   already time-scaled — the hero freezes during hitstop, on purpose
   * @param {number} speed horizontal speed in m/s
   */
  animate(player, dt, speed) {
    const t = player.game.clock.elapsed;
    const weapon = player.weapon?.def;
    const col = weapon?.color ?? [0.4, 0.85, 1];

    // ---------------------------------------------------------------- ground plate
    // Undo the body's facing so the plate, lance and lamps live in world space.
    this.ground.rotation.y = -player.facing;
    this.aimPivot.rotation.y = player.aimAngle;

    this._plateFlash = Math.max(0, this._plateFlash - dt * 5);
    const hpFrac = Math.max(0, player.hp / player.hpMax);
    const danger = hpFrac < 0.35 ? (Math.sin(t * 9) * 0.5 + 0.5) : 0;

    // Dodging blows the ring out to white and expands it — the clearest possible "you
    // are invulnerable right now" signal, readable even behind three orcs.
    const roll = player.dodgeT > 0 ? player.dodgeT / player.dodgeTime : 0;
    this.rim.material.color.setRGB(
      col[0] * (1 - danger) + danger * 1.0 + roll * 0.9,
      col[1] * (1 - danger) + danger * 0.15 + roll * 0.9,
      col[2] * (1 - danger) + danger * 0.12 + roll * 0.9,
    );
    this.rim.material.opacity = 0.55 + Math.sin(t * 2.2) * 0.08 + this._plateFlash * 0.6
      + danger * 0.3 + roll * 0.45;
    this.rim.scale.setScalar(1 + this._plateFlash * 0.22 + roll * 0.55);

    // Aim lance: length tracks the equipped weapon's useful reach, capped so it stays a
    // direction cue and not a map-spanning laser.
    // Proportional to reach rather than a flat cap, so the blunderbuss's stub (6) and the
    // crossbow's lance (11) are visibly different weapons before you pull the trigger.
    const len = Math.max(5, Math.min(11, (weapon?.range ?? 12) * 0.5));
    this.lance.scale.set(1, 1, len);
    this.lance.position.z = 1.1;
    this.lance.material.color.setRGB(col[0], col[1], col[2]);
    const canFire = player.weapon && player.weapon.reloading <= 0
      && (player.weapon.ammo > 0) && player.mana >= (weapon?.mana ?? 0);
    this.lance.material.opacity = (canFire ? 0.85 : 0.28) + this._plateFlash * 0.5;
    this.lance.visible = !player.dead;

    this._updateGauge(player, col, t);
    this._updateLamps(player, dt);

    // ---------------------------------------------------------------- dead
    if (player.dead) {
      this.body.visible = false;
      this.lance.visible = false;
      this.rim.material.opacity = 0.25;
      this.respawn.visible = true;
      // Closes in on the corpse as the respawn timer runs down. Scaling a static ring
      // rather than rebuilding a partial one keeps this allocation-free.
      const k = 1 - Math.max(0, player.respawnT) / Math.max(0.001, player.respawnTime);
      this.respawn.scale.setScalar(2.2 - k * 1.3);
      this.respawn.material.opacity = 0.35 + k * 0.55;
      this.respawn.material.color.setRGB(1, 0.25 + k * 0.5, 0.18);
      return;
    }
    this.body.visible = true;
    this.respawn.visible = false;

    // ---------------------------------------------------------------- locomotion
    const run = Math.min(1, speed / 9);
    this.phase += dt * (5 + run * 7);

    for (const l of this.legs) {
      const ph = this.phase + (l.side > 0 ? 0 : Math.PI);
      l.hip.rotation.x = Math.sin(ph) * 0.85 * run;
      l.knee.rotation.x = Math.max(0, -Math.sin(ph - 0.5)) * 1.0 * run;
    }

    const off = this.arms[0];
    off.shoulder.rotation.x = Math.sin(this.phase + Math.PI) * 0.5 * run;
    off.shoulder.rotation.z = -0.2;

    // The weapon arm holds the line of the aim lance, so the model and the floor cue agree.
    const main = this.arms[1];
    main.shoulder.rotation.x = -1.3 + this._recoil * 0.55;
    main.shoulder.rotation.z = 0.24;
    main.forearm.rotation.x = 0.3;

    if (this._swapSpin > 0) {
      this._swapSpin = Math.max(0, this._swapSpin - dt * 4.5);
      this.weaponRoot.rotation.z = this._swapSpin * Math.PI * 2;
      this.weaponRoot.scale.setScalar(1 + this._swapSpin * 0.35);
    } else {
      this.weaponRoot.rotation.z = 0;
      this.weaponRoot.scale.setScalar(1);
    }

    // Melee cleave overrides the arm entirely and twists the torso for follow-through.
    if (this._swing > 0) {
      this._swing -= dt;
      const k = 1 - this._swing / 0.5;
      const s = k < 0.3 ? -1.9 * (k / 0.3) : 2.1 * ((k - 0.3) / 0.7) - 1.9;
      main.shoulder.rotation.x = s;
      main.shoulder.rotation.z = 0.65;
      this.body.rotation.y = -s * 0.32;
    } else {
      this.body.rotation.y = damp2(this.body.rotation.y, 0, 0.0005, dt);
    }

    // ---------------------------------------------------------------- dodge
    const dodging = player.dodgeT > 0;
    const B = BODY_SCALE;
    if (dodging) {
      const k = 1 - player.dodgeT / player.dodgeTime;
      this.body.rotation.x = 0.55 * (1 - k * 0.6);
      this.body.position.y = BODY_Y - 0.26 * Math.sin(k * Math.PI);
      this.body.scale.set(B * 1.05, B * 0.84, B * 1.18);
      this.streak.visible = true;
      this.streak.material.opacity = 1.0 * (1 - k * 0.7);
      this.streak.rotation.y = Math.atan2(player.dodgeDir.x, player.dodgeDir.z);
      this.cloak.rotation.x = 0.12 + 0.85;
    } else {
      this.body.rotation.x = damp2(this.body.rotation.x, 0, 0.0002, dt);
      this.body.position.y = BODY_Y + Math.abs(Math.sin(this.phase)) * 0.07 * run;
      this.body.scale.setScalar(B);
      this.streak.visible = false;
      this.cloak.rotation.x = 0.12 + run * 0.42;
    }
    this.body.rotation.z = Math.sin(this.phase) * 0.05 * run;

    // ---------------------------------------------------------------- muzzle / cores
    const wm = this.weapons[this._weaponId];
    if (this._recoil > 0) {
      this._recoil = Math.max(0, this._recoil - dt * 6);
      this.muzzle.color.setRGB(col[0], col[1], col[2]);
      this.muzzle.intensity = this._recoil * 4.5;
      wm?.core.scale.setScalar(1 + this._recoil * 0.9);
    } else {
      this.muzzle.intensity = 0;
      wm?.core.scale.setScalar(1 + Math.sin(t * 3.4) * 0.07);
    }
    if (this.weapons.lightning.group.visible) this.weapons.lightning.ring.rotation.z += dt * 4;
    this.crownTip.material.emissiveIntensity = 3.0 + Math.sin(t * 4) * 0.8;

    // ---------------------------------------------------------------- damage state
    // A red wash over the whole model, then i-frame strobing. Both read at 40px where a
    // hit-flash on a single limb would not.
    const hurt = Math.max(0, 1 - (t - (player.hurtAt ?? -10)) / 0.28);
    const blink = player.blinkFlash > 0 ? player.blinkFlash / 0.35 : 0;
    for (const m of this.tintMats) {
      m.emissive.setRGB(hurt * 0.75 + blink * 0.35, blink * 0.12, blink * 0.6);
      m.emissiveIntensity = 1;
    }
    // The key light carries the state too: it flares on every shot and goes red when hit.
    this.keyLight.intensity = 2.6 + this._plateFlash * 1.6 + hurt * 3.5;
    this.keyLight.color.setRGB(1, 0.9 - hurt * 0.7, 0.74 - hurt * 0.66);
    if (player.iframes > 0 && !dodging) {
      // Strobe on the game clock, so it stops during pause instead of flickering forever.
      this.body.visible = Math.floor(t * 16) % 2 === 0;
    }
  }

  _updateGauge(player, col, t) {
    const w = player.weapon;
    const def = w?.def;
    const n = this.ticks.length;
    let frac = 1, r = col[0], g = col[1], b = col[2], pulse = 0;

    // The crossbow has infinite ammo and costs nothing: showing a permanently full
    // gauge for it is noise, and noise on the hero is the expensive kind.
    const hasGauge = !!def && (def.magazine !== Infinity || def.mana > 0);
    this.gaugeGroup.visible = hasGauge && !player.dead;
    if (!hasGauge) return;

    if (w && w.reloading > 0) {
      // Sweep white around the ring while reloading — the clearest "wait" signal there is.
      frac = 1 - w.reloading / (def.reloadTime ?? 1);
      r = 1; g = 1; b = 1; pulse = 1;
    } else if (def && def.magazine !== Infinity) {
      frac = w.ammo / def.magazine;
      if (w.ammo === 0) { r = 1; g = 0.2; b = 0.15; }
    } else if (def && def.mana > 0) {
      frac = player.mana / player.manaMax;
      if (player.mana < def.mana) { r = 1; g = 0.35; b = 0.2; }
    } else {
      frac = 1;
    }

    const lit = Math.round(frac * n);
    for (let i = 0; i < n; i++) {
      const m = this.ticks[i];
      const on = i < lit;
      m.material.color.setRGB(r, g, b);
      m.material.opacity = on ? 0.95 : 0.10;
      const s = on ? 1 + pulse * 0.4 * Math.max(0, Math.sin(t * 12 - i * 0.4)) : 0.7;
      m.scale.set(1, 1, s);
    }
  }

  _updateLamps(player, dt) {
    const ready = player.spells ? player.spells.readiness(this._readiness) : null;
    for (let i = 0; i < this.lamps.length; i++) {
      const m = this.lamps[i];
      const k = ready ? ready[i] : 1;
      const def = player.spells?.list[i]?.def;
      const c = def?.color ?? [1, 1, 1];
      m.material.color.setRGB(c[0], c[1], c[2]);
      m.material.opacity = k >= 1 ? 0.8 : 0.10 + k * 0.22;
      m.scale.setScalar(k >= 1 ? 1 : 0.55 + k * 0.35);
    }
  }
}
