/**
 * Generic free-list pool. Objects are never GC'd during play.
 *   const pool = new Pool(() => new Thing(), t => t.reset());
 *   const t = pool.take(); ... pool.give(t);
 */
export class Pool {
  constructor(factory, reset = null, prewarm = 0) {
    this.factory = factory;
    this.reset = reset;
    this.free = [];
    this.liveCount = 0;
    for (let i = 0; i < prewarm; i++) this.free.push(factory());
  }

  take() {
    const o = this.free.pop() ?? this.factory();
    this.liveCount++;
    return o;
  }

  give(o) {
    if (this.reset) this.reset(o);
    this.liveCount--;
    this.free.push(o);
  }

  get size() { return this.free.length + this.liveCount; }
}

/**
 * Swap-remove active list. Iterate backwards when removing during traversal.
 * Used for enemies, projectiles, particles — anything with churn.
 */
export class ActiveList {
  constructor() { this.items = []; }
  get length() { return this.items.length; }
  add(o) { o.__idx = this.items.length; this.items.push(o); return o; }
  remove(o) {
    const i = o.__idx;
    if (i === undefined || this.items[i] !== o) return false;
    const last = this.items.pop();
    if (last !== o) { this.items[i] = last; last.__idx = i; }
    o.__idx = undefined;
    return true;
  }
  clear() { for (const o of this.items) o.__idx = undefined; this.items.length = 0; }
  [Symbol.iterator]() { return this.items[Symbol.iterator](); }
}
