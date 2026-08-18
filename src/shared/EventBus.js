/** Tiny synchronous event bus. Listeners must never throw; we catch and warn. */
export class EventBus {
  constructor() { this.map = new Map(); }

  on(type, fn) {
    let set = this.map.get(type);
    if (!set) { set = new Set(); this.map.set(type, set); }
    set.add(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const un = this.on(type, (p) => { un(); fn(p); });
    return un;
  }

  off(type, fn) {
    const set = this.map.get(type);
    if (set) set.delete(fn);
  }

  emit(type, payload) {
    const set = this.map.get(type);
    if (!set || set.size === 0) return;
    // Copy so handlers can subscribe/unsubscribe during dispatch.
    for (const fn of Array.from(set)) {
      try { fn(payload); }
      catch (e) { console.warn(`[bus] handler for "${type}" threw:`, e); }
    }
  }

  clear() { this.map.clear(); }
}
