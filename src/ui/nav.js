/**
 * Menu navigation for keyboard and gamepad.
 *
 * Input.js swallows key defaults for the game, which means a focused <button> never
 * fires on Enter by itself — so activation is synthesised here. Movement is geometric
 * rather than DOM-order: the level-select grid and the spellbook grid both need
 * left/right to mean *left/right on screen*, and that falls out of comparing rects
 * instead of maintaining a hand-written focus graph per screen.
 */

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), [tabindex="0"]';

export class MenuNav {
  constructor(root, onBack) {
    this.root = root;
    this.onBack = onBack;
    this._padPrev = {};
    this._repeat = 0;
  }

  /** The topmost visible overlay — the only place focus is allowed to live. */
  scope() {
    const open = [...this.root.querySelectorAll('.overlay')].filter((o) => !o.classList.contains('hidden'));
    return open.length ? open[open.length - 1] : null;
  }

  items(scope = this.scope()) {
    if (!scope) return [];
    return [...scope.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  }

  /**
   * DOM order, skipping the destructive and secondary controls — a screen should open
   * with the thing you came for under the cursor (the first level, the first upgrade),
   * never with "erase progress" or "refund all".
   */
  focusFirst() {
    const items = this.items();
    if (!items.length) return;
    const safe = items.filter((el) => !el.classList.contains('ghost') && !el.classList.contains('danger'));
    (safe[0] ?? items[0]).focus({ preventScroll: true });
  }

  blur() {
    if (document.activeElement && this.root.contains(document.activeElement)) {
      document.activeElement.blur();
    }
  }

  move(dir) {
    const scope = this.scope();
    const items = this.items(scope);
    if (!items.length) return false;
    const cur = items.includes(document.activeElement) ? document.activeElement : null;
    if (!cur) { this.focusFirst(); return true; }

    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    const axis = dir === 'left' || dir === 'right' ? 'x' : 'y';
    const sign = dir === 'right' || dir === 'down' ? 1 : -1;

    let best = null, bestScore = Infinity;
    for (const el of items) {
      if (el === cur) continue;
      const r = el.getBoundingClientRect();
      const bx = r.left + r.width / 2, by = r.top + r.height / 2;
      const along = (axis === 'x' ? bx - ax : by - ay) * sign;
      const off = axis === 'x' ? Math.abs(by - ay) : Math.abs(bx - ax);
      if (along <= 1) continue;                       // must actually be in that direction
      const score = along + off * 2.2;                // heavily penalise sideways drift
      if (score < bestScore) { bestScore = score; best = el; }
    }
    // Wrap to the far edge so a list is a loop, not a dead end.
    if (!best) {
      const sorted = items.slice().sort((p, q) => {
        const rp = p.getBoundingClientRect(), rq = q.getBoundingClientRect();
        return axis === 'x' ? rp.left - rq.left : rp.top - rq.top;
      });
      best = sign > 0 ? sorted[0] : sorted[sorted.length - 1];
    }
    if (best && best !== cur) { best.focus({ preventScroll: true }); return true; }
    return false;
  }

  activate() {
    const el = document.activeElement;
    if (!el || !this.root.contains(el)) { this.focusFirst(); return; }
    if (el.tagName === 'INPUT') return;
    el.click();
  }

  /** Arrow keys / Enter inside an open overlay. Returns true when it consumed the key. */
  handleKey(e) {
    if (!this.scope()) return false;
    const el = document.activeElement;
    // Sliders keep their own left/right handling.
    if (el?.tagName === 'INPUT' && el.type === 'range' && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
      const step = Number(el.step || 0.05) * (e.code === 'ArrowRight' ? 1 : -1);
      el.value = String(Math.min(Number(el.max), Math.max(Number(el.min), Number(el.value) + step)));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    switch (e.code) {
      case 'ArrowUp': case 'KeyW': return this.move('up');
      case 'ArrowDown': case 'KeyS': return this.move('down');
      case 'ArrowLeft': case 'KeyA': return this.move('left');
      case 'ArrowRight': case 'KeyD': return this.move('right');
      case 'Enter': case 'Space': case 'NumpadEnter': this.activate(); return true;
      default: return false;
    }
  }

  /** Polled from UI.update so a pad can drive every screen without a keyboard. */
  pollPad(pad, dt) {
    if (!pad || !this.scope()) return;
    const b = pad.buttons ?? [];
    const held = (i) => !!b[i] && (b[i].pressed || b[i].value > 0.5);
    const ax = pad.axes?.[0] ?? 0, ay = pad.axes?.[1] ?? 0;
    const dir =
      held(12) || ay < -0.55 ? 'up' :
      held(13) || ay > 0.55 ? 'down' :
      held(14) || ax < -0.55 ? 'left' :
      held(15) || ax > 0.55 ? 'right' : null;

    if (!dir) this._repeat = 0;
    else {
      this._repeat -= dt;
      if (this._repeat <= 0) { this.move(dir); this._repeat = this._padPrev.dir === dir ? 0.16 : 0.34; }
    }
    this._padPrev.dir = dir;

    const a = held(0), back = held(1);
    if (a && !this._padPrev.a) this.activate();
    if (back && !this._padPrev.b) this.onBack?.();
    this._padPrev.a = a;
    this._padPrev.b = back;
  }
}
