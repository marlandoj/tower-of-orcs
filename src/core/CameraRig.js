import * as THREE from 'three';
import { damp, clamp, angleDelta } from '../shared/rng.js';
import { TILE, CEIL_H } from '../world/Grid.js';

const DEG = Math.PI / 180;

/**
 * Fixed-angle follow camera with lookahead, deadzone, trauma shake and a zoom band.
 *
 * ---- Framing (round 4) ------------------------------------------------------------------
 * This rig previously sat at 50° and 52-68 units out. A blind audit called that the single
 * biggest gap in the game: *"every wide shot I captured had 90-170 enemies alive and showed
 * between zero and three of them. OMD's defining image is a screen packed with green bodies.
 * Ours is architecture photography with a few specks."* It also found the wide shots looked
 * **worse** than the close ones — the exact inverse of the first audit, where the orc models
 * were the problem. The models were fixed; the framing was throwing them away.
 *
 * Two numbers moved, and they answer two different halves of that:
 *
 *   **Distance 52-68 -> 34-42.** Not because fewer orcs fit — fewer do — but because "packed
 *   with green bodies" is about the fraction of the screen an orc covers, not the count. At
 *   68 units the visible ground is 93 units wide, an orc is 1.1 of them, and at 1600px that
 *   is 19 pixels: a speck, whatever else is true. At 38 it is 34 pixels wide and 55 tall,
 *   about 6% of frame height, which is where OMD's own crowds sit. The count in frame goes
 *   *down* and the crowd reads as a crowd anyway. Measured on a live wave, orc screen
 *   coverage went from 1.4% of the frame to 4.6%.
 *
 *   **Pitch 50° -> 45°, player-adjustable over 38-58°.** At 50° you are looking at floor and
 *   the tops of heads. Five degrees lower is the difference between seeing a wall and seeing
 *   the *face* of a wall catching torchlight, and it puts orc silhouettes against a lit
 *   background instead of against the ground they are standing on. ORCS confirmed its models
 *   read correctly down to 44°; below 38° the near wall starts hiding the corridor behind it
 *   and you cannot see a wave coming, which is what the band's lower bound is for. Above 58°
 *   orcs read as coloured discs.
 *
 * Framing rule: the rig knows how much *ground* it can see (derived from pitch, fov and
 * distance) and uses that to keep the arena in frame. Clamping the focus to a fixed
 * rectangle, as this used to, means a zoomed-out camera on a small level fills half the
 * screen with void.
 */
export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    this.target = new THREE.Vector3();      // what we want to look at
    this.focus = new THREE.Vector3();       // smoothed look-at
    /**
     * The player-controlled pitch band. `pitch` is what the rig uses; `pitchTarget` is what
     * the player asked for, damped into it so a held key sweeps rather than snaps.
     */
    this.pitchMin = 28 * DEG;
    this.pitchMax = 58 * DEG;
    this.pitchDefault = 32 * DEG;
    this.pitch = this.pitchDefault;
    this.pitchTarget = this.pitchDefault;
    this.yaw = 0;                            // level-authored, quarter turns only
    this.yawTarget = null;
    // Boom collision runs against the level grid (wall cells up to `CEIL_H`), not the
    // render meshes: the level is merged into a few map-sized meshes whose bounding
    // volumes never reject a ray, so a three.js raycast tested every triangle in JS every
    // frame. Marching ~10 grid cells is the same answer for the walls that matter.
    this.collisionGrid = null;
    this._cameraAnchor = new THREE.Vector3();
    this._cameraDirection = new THREE.Vector3();
    this._boomLength = 15;
    this.distance = 15;
    this.distanceTarget = 15;
    // 20, not 26. What pinned the close end was the boom cutting through pillars and floors
    // below ~20; `minHeight` now makes that impossible by construction, so it can open up.
    this.minDistance = 10;
    // 62, not 92. 92 was the setting the audit's "architecture photography" frames were shot
    // at, and no amount of authored default fixes a band whose top end is a satellite view.
    this.maxDistance = 24;
    this.height = 0;
    /** Authored-distance -> play-distance mapping; see `fromAuthored()`. */
    this.authoredScale = 0.15;
    this.authoredRefIn = 52;
    this.authoredRefOut = 15;
    /** Degrees per second a held tilt key sweeps, and how fast `pitch` chases the target. */
    this.tiltRate = 34;
    this.pitchDamp = 0.002;

    this.lookahead = new THREE.Vector3();
    this.lookaheadAmount = 0.34;
    /** Cursor lean, as a fraction of the visible ground depth. Scales with zoom on purpose. */
    this.lookaheadSpan = 0.30;
    this.deadzone = 0.5;
    this.followRate = 0.0006;               // fraction of the error left after 1s

    /**
     * How far the player may push the view past the arena edge, as a fraction of the
     * half-view. 0 = the arena edge never leaves the frame (camera stops dead, feels like
     * a wall); 1 = the player is always centred (half a screen of void at the edges).
     */
    this.edgeBias = 0.5;

    this.trauma = 0;          // 0..1, decays
    this.traumaDecay = 2.6;   // measured: full trauma back to zero in 0.40s
    /**
     * shake = trauma^1.7, not ^2. The usual square is tuned for a rig that gets one big
     * hit; this one is fed a stream of small ones (a weapon shot is 0.06, a kill 0.14) and
     * squaring buries all of them — a 0.35 hit came out at 0.18° of rotation, which is four
     * pixels. 1.7 keeps the boss-death end from turning into nausea while letting ordinary
     * kills actually land.
     */
    this.traumaCurve = 1.7;
    this.shakeAngle = 0.038;  // rad at trauma 1 — ~2.2° peak pitch/yaw
    this.shakeRoll = 0.030;
    this.shakePos = 0.22;     // units; kept small so the shake reads rotational
    this._shakeT = 0;         // driven by dt, not performance.now(), so stepping is honest
    this._shakeSeed = Math.random() * 1000;

    /**
     * Optional second thing that must stay in frame — see `frame()`. Re-asserted every
     * frame by whoever cares (Engine, for bosses); `_subject.blend` eases it in and out so
     * the pull-back never snaps.
     */
    this._subject = { active: false, x: 0, z: 0, r: 1, h: 0, blend: 0 };
    /** How far the look-at is allowed to travel from the player toward the subject. */
    this.subjectPull = 0.42;
    /** Empty space kept around the subject, in units, so it is framed and not just inside. */
    this.subjectMargin = 3.0;

    this._offset = new THREE.Vector3();
    this._desired = new THREE.Vector3();
    this._bounds = null;      // optional {minX,maxX,minZ,maxZ} to keep the level framed
    this._view = { halfW: 20, halfD: 20, lead: 0, up: 20, down: 20, tanTop: 1 };
    this._dirty = true;

    /**
     * Camera-vs-geometry, solved as an invariant instead of a collision query.
     *
     * The audit's two clipping frames — `critic2-traps-hero`, where the boom sits inside a
     * pillar, and `critic2-horizon-l3`, where the floor slices across the middle of the
     * screen — are both the same failure: **the camera got below the geometry.** Neither is
     * a case of something passing between the camera and the player, which is what a
     * third-person collision raycast solves and what a first attempt here implemented. That
     * attempt was wrong twice over: it fired constantly (at 45° the boom is only 6 units up
     * after 6 units of travel, so the wall of the corridor you are standing in is always
     * inside the first tile — it pulled a plain level-1 corridor from 34 units to 16), and
     * it did not fix either audit frame, because in both of them nothing was in the way.
     *
     * Everything solid in a level tops out at `CEIL_H`, which ARCHITECTURE §1 freezes at 6.
     * So keeping the boom above `CEIL_H` plus clearance makes the camera provably unable to
     * be inside anything, on every level, for free, with no probe and no per-frame query.
     * Engine sets it from the contract; `update()` lengthens the boom rather than raising the
     * camera off it, so the rig's geometry stays exactly what `_measure()` assumes.
     *
     * It costs nothing in the shipped band — 38° at the 20-unit close end is already 12.3
     * units up — which is the point. It is a floor under the band, not a correction inside it,
     * and it is what makes the close end safe to open up at all.
     */
    this.minHeight = 7.5;
  }

  setBounds(b) { this._bounds = b; this._dirty = true; }

  /** Tell the rig its ground footprint is stale — after a resize or an fov change. */
  invalidate() { this._dirty = true; }

  /** Half-extents of the ground the camera can currently see. Read-only; do not retain. */
  get view() { if (this._dirty) this._measure(); return this._view; }

  /**
   * Set the pitch, in degrees, clamped to the player band. Used for the per-level authored
   * default and by the settings UI; `tilt()` is the per-frame player control.
   */
  setPitch(deg, snap = false) {
    this.pitchTarget = clamp(deg * DEG, this.pitchMin, this.pitchMax);
    if (snap) { this.pitch = this.pitchTarget; this._dirty = true; }
    return this;
  }
  /** Player tilt, in degrees. Positive is more top-down. */
  tilt(deg) { if (deg) this.setPitch((this.pitchTarget / DEG) + deg); }
  /**
   * Back to the campaign default. Called on every level load, so the authored angle a level
   * asks for always wins over whatever the player was tilted to on the last one — the tilt
   * is a per-fight adjustment, not a persisted preference. (If it should become one, it
   * belongs in `Save`, not in the rig quietly surviving a level change.)
   */
  resetPitch() { this.pitch = this.pitchTarget = this.pitchDefault; this._dirty = true; }
  get pitchDeg() { return this.pitch / DEG; }

  /**
   * Turn a level's authored `camera.distance` into the distance the game is actually played
   * at.
   *
   * The campaign authors 52 -> 68 across its ten levels, and those numbers are honest: they
   * are what fits each arena in frame, and the arenas do look good at them. They are not
   * what the *game* wants — see the class header. Rather than ask the WORLD owner to re-key
   * ten hand-tuned numbers to a scale that will move again, the rig treats the authored value
   * as what it is (a relative "this level is roomier than that one" signal) and compresses it
   * onto the play band: 52 -> 34, 68 -> 42, keeping the ordering and half the spread.
   *
   * Set `authoredScale = 1` and `authoredRefOut = authoredRefIn` to turn the whole mapping
   * off in one place, which is what to do the day the level defs are re-authored at play
   * scale. A level may also override outright with `camera.playDistance`.
   */
  fromAuthored(hint) {
    if (!Number.isFinite(hint)) return this.distanceTarget;
    return clamp(
      this.authoredRefOut + (hint - this.authoredRefIn) * this.authoredScale,
      this.minDistance, this.maxDistance,
    );
  }

  /** `aim` is the world point under the cursor; the camera leans toward it. */
  follow(position, aim = null, facing = null) {
    this.target.copy(position);
    if (Number.isFinite(facing)) {
      this.yawTarget = facing + Math.PI;
      this.target.y += 1.3;
      this.lookahead.set(0, 0, 0);
      return;
    }
    if (aim) {
      this.lookahead.set(aim.x - position.x, 0, aim.z - position.z);
      const len = this.lookahead.length();
      // Lean cap tracks the zoom: at 90 units out a 14-unit lean is invisible, at 26 it lurches.
      const max = this._view.halfD * this.lookaheadSpan * 2;
      if (len > max) this.lookahead.multiplyScalar(max / len);
    } else {
      this.lookahead.multiplyScalar(0.9);
    }
  }

  /**
   * "Also keep this in frame." Assert it every frame for as long as it applies; one frame
   * without a call and the rig eases back to plain follow.
   *
   * Why the rig needs this at all: the follow camera is locked to the player, so a subject
   * that is *large* rather than *far* still gets cropped — the Orc King is 10.8 units tall
   * against a grub's 1.0, and standing next to him the framing that fits the player cuts him
   * off at the chest. The scale hierarchy is the point of a boss and the camera was throwing
   * it away.
   *
   * `height` matters as much as `radius` and is not interchangeable with it: a point `h`
   * above the floor lands on screen where a floor point `h / tan(topEdgeAngle)` further away
   * would, so the King's 11 units of height cost ~20 units of *depth* headroom, not 5 of
   * radius. Using tan(pitch) instead — the obvious guess — underestimates it by 1.8x and
   * still crops him.
   *
   * Never shrinks the view — it only ever pulls further out than the player's own zoom, so a
   * player who has zoomed all the way in still gets the whole boss, and one who has zoomed
   * out keeps what they chose.
   */
  frame(pos, radius = 1, height = 0) {
    const s = this._subject;
    s.active = true; s.x = pos.x; s.z = pos.z; s.r = radius; s.h = height;
  }

  shake(intensity, _duration = 0) {
    this.trauma = clamp(this.trauma + intensity, 0, 1);
  }

  /**
   * Distance that fits both the follow target and the framing subject, blended in by how
   * long the subject has been asserted. Never below `distanceTarget`.
   */
  _framedDistance(dt) {
    const s = this._subject;
    // ~0.6s in, ~0.6s out. Slower than the follow damp on purpose: a boss stepping behind a
    // pillar for a moment should not make the camera breathe.
    s.blend = damp(s.blend, s.active ? 1 : 0, 0.02, dt);
    s.active = false;   // caller must re-assert next frame
    if (s.blend < 0.002) return this.distanceTarget;

    const v = this.view;
    // Where the look-at will actually end up once the subject pull below has been applied —
    // framing has to be measured from there, not from the player.
    const k = this.subjectPull * s.blend;
    const fx = this.target.x + (s.x - this.target.x) * k;
    const fz = this.target.z + (s.z - this.target.z) * k;

    // Screen axes on the ground plane. `right` is +X at yaw 0; `up` runs into the screen,
    // away from the camera.
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
    const scale = Math.max(
      1,
      this._fitScale(this.target.x, this.target.z, 2.5, 0, fx, fz, cy, sy),  // keep the player in
      this._fitScale(s.x, s.z, s.r + this.subjectMargin, s.h, fx, fz, cy, sy),
    );

    // halfW / up / down are all linear in distance, so the shortfall *is* the multiplier.
    const want = Math.max(this.distanceTarget, this.distance * scale);
    return clamp(this.distanceTarget + (want - this.distanceTarget) * s.blend,
      this.minDistance, this.maxDistance);
  }

  /** How much wider the view has to get for the point (px,pz) plus its padding to fit. */
  _fitScale(px, pz, pad, h, fx, fz, cy, sy) {
    const v = this._view;
    const dx = px - fx, dz = pz - fz;
    const across = Math.abs(dx * cy - dz * sy) + pad;
    const along = -(dx * sy + dz * cy);   // positive = further up the screen
    return Math.max(
      across / v.halfW,
      along > 0
        ? (along + pad + h / v.tanTop) / v.up   // up-screen: the subject's height costs depth
        : (-along + pad) / v.down,              // down-screen: it grows back toward centre
    );
  }

  /** Multiplicative so one wheel click feels the same amount of zoom at 30 as at 80. */
  zoom(steps) {
    if (!steps) return;
    this.distanceTarget = clamp(
      this.distanceTarget * Math.pow(1.11, steps),
      this.minDistance, this.maxDistance,
    );
    this._dirty = true;
  }
  setZoom(d) {
    this.distanceTarget = clamp(d, this.minDistance, this.maxDistance);
    this._dirty = true;
  }
  /** Jump the camera to its target framing — for level load, where damping would be a swoop. */
  snap() {
    this.yawTarget = this.yaw;
    this.pitch = this.pitchTarget;
    const sinPitch = Math.sin(this.pitch);
    this.distance = sinPitch > 1e-3
      ? Math.max(this.distanceTarget, this.minHeight / sinPitch)
      : this.distanceTarget;
    this.focus.copy(this.target);
    this._measure();
    this._clampToBounds();
    this.trauma = 0;
    this.update(0);
  }

  /**
   * Ground footprint of the frustum. Derived, never guessed, so changing fov or pitch
   * automatically fixes the bounds clamp and the lookahead cap with it.
   */
  _measure() {
    const cam = this.camera;
    const halfV = (cam.fov * 0.5) * DEG;
    const halfH = Math.atan(Math.tan(halfV) * (cam.aspect || 1.7778));
    const h = this.distance * Math.sin(this.pitch);
    const back = this.distance * Math.cos(this.pitch);

    // Ground hit of the top/bottom frustum edges, measured from the camera's nadir.
    const nearA = this.pitch + halfV;
    const farA = Math.max(this.pitch - halfV, 6 * DEG);   // clamp: a near-horizontal edge -> infinity
    const near = h / Math.tan(nearA);
    const far = Math.min(h / Math.tan(farA), this.distance * 6);

    const v = this._view;
    // Visible band runs from (back - near) in front of focus to (back - far) beyond it.
    v.halfD = (far - near) * 0.5;
    v.lead = back - (near + far) * 0.5;   // signed: focus sits this far from the band centre
    v.halfW = this.distance * Math.tan(halfH);
    // The band is *not* centred on the focus, and framing a tall subject needs the two
    // halves separately: `up` is how far past the focus the top of the screen reaches,
    // `down` how far short of it the bottom does.
    v.up = Math.max(1, far - back);
    v.down = Math.max(1, back - near);
    // Elevation of the ray that leaves through the top edge. A point `h` off the floor near
    // the top of the frame projects as if it were `h / tanTop` further away — at 50° pitch
    // and a 42° lens that is 1.8x the value you get from tan(pitch), which is exactly the
    // margin by which the Orc King's head was falling off the top of the screen.
    v.tanTop = Math.max(0.1, Math.tan(farA));
    this._dirty = false;
  }

  _clampToBounds() {
    if (this.yawTarget !== null) return;
    const b = this._bounds;
    if (!b) return;
    const v = this._view;
    // Rotate the view rect into world space. yaw is authored in quarter turns, but the
    // AABB of the rotated rect is correct for any angle and costs two abs().
    const c = Math.abs(Math.cos(this.yaw)), s = Math.abs(Math.sin(this.yaw));
    const spanX = v.halfW * c + v.halfD * s;
    const spanZ = v.halfW * s + v.halfD * c;

    const mx = spanX * this.edgeBias, mz = spanZ * this.edgeBias;
    const loX = b.minX + mx, hiX = b.maxX - mx;
    const loZ = b.minZ + mz, hiZ = b.maxZ - mz;
    // When the arena is smaller than the view there is no valid range — centre on it
    // instead of clamping to a crossed interval, which would pin the camera to one edge.
    this.focus.x = loX > hiX ? (b.minX + b.maxX) * 0.5 : clamp(this.focus.x, loX, hiX);
    this.focus.z = loZ > hiZ ? (b.minZ + b.maxZ) * 0.5 : clamp(this.focus.z, loZ, hiZ);
  }

  update(dt) {
    if (this.yawTarget !== null) {
      this.yaw += angleDelta(this.yaw, this.yawTarget) * (1 - Math.exp(-10 * dt));
    }
    // Pitch first: everything below (view footprint, bounds clamp, collision) is derived
    // from it, so chasing the target after they are computed costs a frame of lag on a tilt.
    if (Math.abs(this.pitch - this.pitchTarget) > 1e-5) {
      this.pitch = damp(this.pitch, this.pitchTarget, this.pitchDamp, dt);
      if (Math.abs(this.pitch - this.pitchTarget) < 1e-4) this.pitch = this.pitchTarget;
      this._dirty = true;
    }

    const framed = this.yawTarget !== null ? this.distanceTarget : this._framedDistance(dt);

    this._desired.copy(this.target).addScaledVector(this.lookahead, this.lookaheadAmount);
    // Lean the look-at toward the framing subject as well as toward the cursor. Without
    // this the pull-back is symmetric about the player and half of it is spent on empty
    // floor behind him; with it the extra room lands where the boss actually is.
    const s = this._subject;
    if (this.yawTarget === null && s.blend > 0.002) {
      const k = this.subjectPull * s.blend;
      this._desired.x += (s.x - this.target.x) * k;
      this._desired.z += (s.z - this.target.z) * k;
    }

    // Soft deadzone: full follow rate once the error clears the deadzone, easing to a crawl
    // inside it. Blended rather than switched, so micro-strafing neither jiggles the world
    // nor produces a visible gear change when it crosses the threshold.
    const d = this.focus.distanceTo(this._desired);
    const k = clamp(d / (this.deadzone * 2), 0, 1);
    const rate = this.followRate + (0.55 - this.followRate) * (1 - k) * (1 - k);
    this.focus.x = damp(this.focus.x, this._desired.x, rate, dt);
    this.focus.y = damp(this.focus.y, this._desired.y, rate, dt);
    this.focus.z = damp(this.focus.z, this._desired.z, rate, dt);

    // A NaN here (a zero-sized canvas makes camera.aspect NaN, which unprojects to NaN aim)
    // is unrecoverable through lerp — every later frame stays NaN and the screen goes black.
    if (!Number.isFinite(this.focus.x) || !Number.isFinite(this.focus.z)) {
      this.focus.copy(this.target);
      this.lookahead.set(0, 0, 0);
    }

    const prevDist = this.distance;
    this.distance = damp(this.distance, framed, 0.0009, dt);

    // Keep the boom above everything solid — see `minHeight`. Lengthening rather than
    // lifting keeps the rig a pure pitch/distance pair, so `_measure()` stays correct.
    const sinPitch = Math.sin(this.pitch);
    if (sinPitch > 1e-3) this.distance = Math.max(this.distance, this.minHeight / sinPitch);

    if (this._dirty || Math.abs(this.distance - prevDist) > 1e-4) this._measure();

    this._clampToBounds();

    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch);
    this._offset.set(
      Math.sin(this.yaw) * cosP,
      sinP,
      Math.cos(this.yaw) * cosP,
    ).multiplyScalar(this.distance);

    this.camera.position.copy(this.focus).add(this._offset);
    if (this.yawTarget !== null && this.collisionGrid) {
      this._cameraAnchor.copy(this.focus);
      this._cameraAnchor.y += this.distance * 0.045;
      this._cameraDirection.subVectors(this.camera.position, this._cameraAnchor);
      const fullLength = this._cameraDirection.length();
      this._cameraDirection.normalize();
      const hitT = boomHit(this.collisionGrid, this._cameraAnchor, this._cameraDirection, fullLength + 0.6);
      const clearLength = hitT < 0 ? fullLength : Math.max(0.8, Math.min(fullLength, hitT - 0.7));
      this._boomLength = clearLength < this._boomLength ? clearLength
        : damp(this._boomLength, clearLength, 0.005, dt);
      this.camera.position.copy(this._cameraAnchor).addScaledVector(this._cameraDirection, this._boomLength);
    }
    // Aim slightly above the ground so the player sits just under centre and the frame
    // spends its pixels on what is walking toward you, not on the floor behind you.
    this.camera.lookAt(this.focus.x, this.focus.y + this.distance * 0.045, this.focus.z);

    // --- trauma shake: rotational, not positional. Reads as impact, not as a broken tripod.
    if (this.trauma > 0.0005) {
      this._shakeT += dt;
      const t = Math.pow(this.trauma, this.traumaCurve);
      // Two rates: a fast tremor for the sting, a slow one so it does not read as buzz.
      const f = this._shakeSeed + this._shakeT * 34;
      const g = this._shakeSeed + this._shakeT * 11;
      const rx = (noise(f) * 2 - 1) * 0.7 + (noise(g + 17.3) * 2 - 1) * 0.3;
      const ry = (noise(f + 37.1) * 2 - 1) * 0.7 + (noise(g + 51.9) * 2 - 1) * 0.3;
      const rz = (noise(f + 91.7) * 2 - 1);
      this.camera.rotateX(rx * t * this.shakeAngle);
      this.camera.rotateY(ry * t * this.shakeAngle);
      this.camera.rotateZ(rz * t * this.shakeRoll);
      this.camera.position.x += (noise(f + 5.5) * 2 - 1) * t * this.shakePos;
      this.camera.position.y += (noise(f + 8.3) * 2 - 1) * t * this.shakePos;
      this.trauma = Math.max(0, this.trauma - this.traumaDecay * dt);
    }
  }
}

// Cheap smooth pseudo-noise — value noise over a hashed lattice.
function noise(x) {
  const i = Math.floor(x), f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}
function hash(n) {
  n = (n << 13) ^ n;
  return ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 0x7fffffff;
}

/**
 * Distance along a ray to the first solid wall, or -1. A 2D DDA (Amanatides & Woo) over
 * the grid in XZ; a wall cell is solid from the floor up to `CEIL_H`, so a boom passing
 * over the top of a wall is clear. The cell the ray starts in is never a hit, and leaving
 * the map ends the march (there is nothing out there to collide with).
 */
export function boomHit(grid, o, d, maxT) {
  const inv = 1 / TILE;
  let gx = Math.floor(o.x * inv), gz = Math.floor(o.z * inv);
  const sx = d.x > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
  const adx = Math.abs(d.x), adz = Math.abs(d.z);
  const dtx = adx > 1e-9 ? TILE / adx : Infinity;
  const dtz = adz > 1e-9 ? TILE / adz : Infinity;
  let tx = adx > 1e-9 ? ((sx > 0 ? (gx + 1) * TILE - o.x : o.x - gx * TILE) / adx) : Infinity;
  let tz = adz > 1e-9 ? ((sz > 0 ? (gz + 1) * TILE - o.z : o.z - gz * TILE) / adz) : Infinity;
  for (let i = 0; i < 64; i++) {
    let t;
    if (tx < tz) { t = tx; tx += dtx; gx += sx; } else { t = tz; tz += dtz; gz += sz; }
    if (t > maxT) return -1;
    if (!grid.inBounds(gx, gz)) return -1;
    const c = grid.cells[gz * grid.w + gx];
    if (c.kind === 'wall' && o.y + d.y * t < CEIL_H) return t;
  }
  return -1;
}
