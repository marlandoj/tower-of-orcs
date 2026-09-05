import * as THREE from 'three';
import { plane0, ray0 } from '../shared/scratch.js';

/**
 * Keyboard + mouse + gamepad, normalised.
 * Actions are polled (`input.down('fire')`) or edge-tested (`input.pressed('dodge')`).
 * Edge state is cleared once per frame by Engine after all systems update.
 */
const DEFAULT_BINDS = {
  up: ['KeyW', 'ArrowUp'],
  down: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  dodge: ['Space'],
  interact: ['KeyE'],
  reload: ['KeyR'],
  build: ['Tab'],
  swapWeapon: ['KeyQ'],
  spell1: ['Digit1'], spell2: ['Digit2'], spell3: ['Digit3'], spell4: ['Digit4'],
  spell5: ['Digit5'], spell6: ['Digit6'], spell7: ['Digit7'], spell8: ['Digit8'],
  pause: ['Escape'],
  rotate: ['KeyR'],
  /**
   * Camera tilt. `tiltUp` raises the camera toward top-down, `tiltDown` drops it toward the
   * horizon. On the bracket keys because every letter worth having is taken and because they
   * sit next to the wheel hand; PageUp/PageDown are there for players who reach for those.
   */
  tiltUp: ['BracketRight', 'PageUp'],
  tiltDown: ['BracketLeft', 'PageDown'],
  startWave: ['Enter'],
  debug: ['Backquote'],
};

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.binds = { ...DEFAULT_BINDS };
    this.keys = new Set();
    this.keysPressed = new Set();
    this.keysReleased = new Set();
    /**
     * `wheel` is the discrete weapon-swap channel (shift + wheel); `zoomWheel` is the
     * continuous camera channel (plain wheel). They are split because the bare wheel is
     * the only gesture a player will ever try for zoom, and having it also cycle weapons
     * mid-fight is worse than losing wheel-swap — Q still swaps.
     */
    this.mouse = { x: 0, y: 0, ndc: new THREE.Vector2(), buttons: 0, wheel: 0, zoomWheel: 0, tiltWheel: 0 };
    this.mousePressed = 0;
    this.turnDelta = 0;
    this.mouseReleased = 0;
    this.pointerLocked = false;
    /** World-space point under the cursor on the y=0 plane. Updated by Engine each frame. */
    this.aimWorld = new THREE.Vector3();
    /** Aim point raised to chest height for weapon direction. */
    this.aimHeight = 1.0;
    this.gamepadIndex = null;
    this.usingGamepad = false;
    this.lastInputKind = 'kbm';
    /** Every bound code, plus the ones with a page-level default we cannot live with. */
    this._swallow = new Set(['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backquote']);
    for (const codes of Object.values(this.binds)) for (const c of codes) this._swallow.add(c);
    this._padPrev = Object.create(null);
    this._padFrame = Object.create(null);
    this._frameId = 0;
    this._install();
  }

  /** Re-derive the swallow set after a rebind, so a newly bound key stops scrolling the page. */
  rebind(action, codes) {
    this.binds[action] = codes;
    for (const c of codes) this._swallow.add(c);
  }

  _install() {
    const c = this.canvas;
    addEventListener('keydown', (e) => {
      // Never steal keys from a text field — settings, seed entry, and the browser's own
      // find bar all live in the same document as the canvas.
      if (isEditable(e.target)) return;
      if (e.repeat) return;
      this.keys.add(e.code); this.keysPressed.add(e.code); this.lastInputKind = 'kbm';
      // Only swallow the keys the game actually binds, plus the ones whose default would
      // move focus or scroll the page out from under the canvas. Blanket preventDefault
      // was eating every browser shortcut the player might reasonably want.
      if (!e.ctrlKey && !e.metaKey && !e.altKey && this._swallow.has(e.code)) e.preventDefault();
    }, { passive: false });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); this.keysReleased.add(e.code); });
    addEventListener('blur', () => { this.keys.clear(); this.mouse.buttons = 0; });

    c.addEventListener('contextmenu', (e) => e.preventDefault());
    c.addEventListener('pointerdown', (e) => {
      if (e.button === 1) e.preventDefault();
      c.setPointerCapture?.(e.pointerId);
      this.mouse.buttons |= 1 << e.button;
      this.mousePressed |= 1 << e.button;
      this.lastInputKind = 'kbm';
      this._setMouse(e);
    });
    addEventListener('pointerup', (e) => {
      this.mouse.buttons &= ~(1 << e.button);
      this.mouseReleased |= 1 << e.button;
    });
    addEventListener('pointermove', (e) => {
      if (this.mouse.buttons & 2) this.turnDelta += e.movementX;
      this._setMouse(e);
      this.lastInputKind = 'kbm';
    });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.shiftKey) { this.mouse.wheel += Math.sign(e.deltaY); return; }
      // Normalise the three deltaMode units to "notches" so a trackpad and a ratchet wheel
      // zoom at comparable speed, then clamp: some drivers emit 300px in one event.
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      // Alt + wheel tilts. The keys are the discoverable control; this is the one a player
      // who already found wheel-zoom will try next, and it costs nothing to honour.
      if (e.altKey) { this.mouse.tiltWheel += clampNum(px / 100, -3, 3); return; }
      this.mouse.zoomWheel += clampNum(px / 100, -3, 3);
    }, { passive: false });

    addEventListener('gamepadconnected', (e) => { this.gamepadIndex = e.gamepad.index; });
    addEventListener('gamepaddisconnected', () => { this.gamepadIndex = null; this.usingGamepad = false; });
  }

  _setMouse(e) {
    const r = this.canvas.getBoundingClientRect();
    this.mouse.x = e.clientX - r.left;
    this.mouse.y = e.clientY - r.top;
    this.mouse.ndc.set((this.mouse.x / r.width) * 2 - 1, -(this.mouse.y / r.height) * 2 + 1);
  }

  // --- action queries -------------------------------------------------------
  down(action) {
    const codes = this.binds[action];
    if (codes) for (const c of codes) if (this.keys.has(c)) return true;
    return this._padDown(action);
  }
  pressed(action) {
    const codes = this.binds[action];
    if (codes) for (const c of codes) if (this.keysPressed.has(c)) return true;
    return this._padPressed(action);
  }
  released(action) {
    const codes = this.binds[action];
    if (codes) for (const c of codes) if (this.keysReleased.has(c)) return true;
    return false;
  }

  mouseDown(btn = 0) { return (this.mouse.buttons & (1 << btn)) !== 0 || (btn === 0 && this._padDown('fire')) || (btn === 2 && this._padDown('altFire')); }
  mouseClicked(btn = 0) { return (this.mousePressed & (1 << btn)) !== 0 || (btn === 0 && this._padPressed('fire')) || (btn === 2 && this._padPressed('altFire')); }
  mouseUp(btn = 0) { return (this.mouseReleased & (1 << btn)) !== 0; }

  /** Normalised move vector in screen space; x = right, y = forward. Length ≤ 1. */
  moveVector(out = { x: 0, y: 0 }) {
    let x = 0, y = 0;
    if (this.down('right')) x += 1;
    if (this.down('left')) x -= 1;
    if (this.down('up')) y += 1;
    if (this.down('down')) y -= 1;
    const pad = this._pad();
    if (pad) {
      const ax = dz(pad.axes[0]), ay = dz(pad.axes[1]);
      if (ax || ay) { x = ax; y = -ay; this.usingGamepad = true; this.lastInputKind = 'pad'; }
    }
    const len = Math.hypot(x, y);
    if (len > 1) { x /= len; y /= len; }
    out.x = x; out.y = y;
    return out;
  }

  /** Right-stick aim, or null when the player is on mouse. */
  aimStick(out = { x: 0, y: 0 }) {
    const pad = this._pad();
    if (!pad) return null;
    const ax = dz(pad.axes[2]), ay = dz(pad.axes[3]);
    if (!ax && !ay) return null;
    this.usingGamepad = true; this.lastInputKind = 'pad';
    out.x = ax; out.y = -ay;
    return out;
  }

  /** Project the cursor onto the y=`h` plane. Called by Engine once per frame. */
  updateAim(camera, h = 0) {
    plane0.constant = -h;
    ray0.origin.setFromMatrixPosition(camera.matrixWorld);
    ray0.direction.set(this.mouse.ndc.x, this.mouse.ndc.y, 0.5)
      .unproject(camera).sub(ray0.origin).normalize();
    if (!ray0.intersectPlane(plane0, this.aimWorld)) {
      this.aimWorld.copy(ray0.origin).addScaledVector(ray0.direction, 60);
    }
  }

  _pad() {
    if (this.gamepadIndex === null || !navigator.getGamepads) return null;
    return navigator.getGamepads()[this.gamepadIndex] || null;
  }
  _padDown(action) {
    const pad = this._pad(); if (!pad) return false;
    const b = PAD_MAP[action]; if (b === undefined) return false;
    const btn = pad.buttons[b];
    return !!btn && (btn.pressed || btn.value > 0.4);
  }
  /**
   * Edge state has to be latched once per frame: `pressed()` is queried by more than one
   * system per action, and the old version consumed the edge on whichever asked first.
   */
  _padPressed(action) {
    if (this._padFrame[action] !== this._frameId) {
      const now = this._padDown(action);
      this._padFrame[action] = this._frameId;
      this._padEdge ||= Object.create(null);
      this._padEdge[action] = now && !this._padPrev[action];
      this._padPrev[action] = now;
    }
    return this._padEdge[action];
  }

  endFrame() {
    this.keysPressed.clear();
    this.keysReleased.clear();
    this.mousePressed = 0;
    this.mouseReleased = 0;
    this.mouse.wheel = 0;
    this.mouse.zoomWheel = 0;
    this.mouse.tiltWheel = 0;
    this.turnDelta = 0;
    this._frameId++;
  }
}

const clampNum = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
function isEditable(el) {
  if (!el || !el.tagName) return false;
  const t = el.tagName;
  return t === 'INPUT' || t === 'TEXTAREA' || t === 'SELECT' || el.isContentEditable === true;
}

const PAD_MAP = {
  fire: 7, altFire: 6, dodge: 0, interact: 2, build: 3, reload: 2,
  swapWeapon: 5, pause: 9, startWave: 9, rotate: 4,
};
const dz = (v, t = 0.18) => (Math.abs(v) < t ? 0 : (v - Math.sign(v) * t) / (1 - t));
