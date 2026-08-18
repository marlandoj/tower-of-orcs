/**
 * The tactical map, and the route preview drawn on it.
 *
 * Why this exists: the arena runs to 42×32 tiles and the default camera shows a fraction
 * of it. Without a map the build phase is "walk to every tile and look", and the single
 * most important build-phase decision — *which doors open this wave, and where does the
 * horde walk* — is invisible until the orcs are already walking. A review of the shipped
 * build ranked "no path preview and no minimap" among its top complaints, and DIRECTOR's
 * own bot lost level 10 three times over before it was allowed to read the gate list.
 *
 * So this draws four things, in the order they matter:
 *
 *   1. THE ROUTE. Traced by steepest descent on the very flow field the horde steers by
 *      (`grid.riftFlow()`), from each *live* gate to the rift. It is not an approximation
 *      of the path — it is the path, and it re-traces the moment a barricade edits it.
 *      That makes the Barricade legible: you can see the detour you just bought.
 *   2. LIVE GATES vs dormant ones. A wave that opens two of six doors is a completely
 *      different build problem from one that opens all six.
 *   3. What you have built, where — including barricades, which are drawn as wall.
 *   4. You, and the horde, live.
 *
 * Cost control: the terrain is rasterised once into an offscreen canvas and reused until
 * the map actually changes; the dynamic layer redraws at 20 Hz, not 60. Both canvases are
 * a few hundred pixels square.
 */

/** Map palette. Deliberately desaturated so the route and the gates are the only things
 *  on it with chroma. */
const C = {
  void: 'rgba(0,0,0,0)',
  wall: '#241c14',
  wallEdge: '#3a2c1c',
  floor: '#0f0d12',
  ledge: '#171320',
  rift: '#5cd4ff',
  gateLive: '#ff6a3a',
  gateIdle: '#5c4a33',
  route: 'rgba(255,150,60,0.85)',
  trap: '#d9a441',
  blocker: '#b98a52',
  guardian: '#7fd08a',
  player: '#eafcff',
  enemy: '#ff3826',
};

export class Minimap {
  constructor(game, host) {
    this.game = game;
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'mm-canvas';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.terrain = document.createElement('canvas');
    this.tctx = this.terrain.getContext('2d');

    this.enabled = true;
    this.routes = [];
    this._terrainDirty = true;
    this._geomKey = '';
    this._t = 0;
    this._cell = 4;
    this._quarter = 0;

    const dirty = () => { this._terrainDirty = true; this.markRoutes(); };
    game.bus.on('level:load', () => { this._geomKey = ''; dirty(); });
    game.bus.on('phase:build', () => this.markRoutes());
    game.bus.on('wave:start', () => this.markRoutes());
    game.bus.on('trap:placed', dirty);
    game.bus.on('trap:sold', dirty);
    game.bus.on('trap:destroyed', dirty);
  }

  setEnabled(on) {
    this.enabled = on;
    this.host.classList.toggle('hidden', !on);
    if (on) { this._terrainDirty = true; this.markRoutes(); }
  }

  markRoutes() { this._routesDirty = true; }

  // ------------------------------------------------------------------ geometry
  /**
   * Grid cell -> map pixel, rotated by the level's authored camera yaw so that "up" on
   * the minimap is always "away from you" on screen. Yaw is quarter turns only, which is
   * why this is four cases rather than a matrix.
   */
  _project(gx, gz, w, h) {
    // Screen right is (cos yaw, -sin yaw) and screen down is (sin yaw, cos yaw) in world
    // (X, Z); at yaw 0 that is +X right and +Z down, which is what the camera shows.
    switch (this._quarter) {
      case 1: return { x: h - 1 - gz, y: gx };
      case 2: return { x: w - 1 - gx, y: h - 1 - gz };
      case 3: return { x: gz, y: w - 1 - gx };
      default: return { x: gx, y: gz };
    }
  }
  _mapSize(w, h) { return this._quarter % 2 ? { mw: h, mh: w } : { mw: w, mh: h }; }

  _fit() {
    const grid = this.game.grid;
    if (!grid) return false;
    const yaw = this.game.rig?.yaw ?? 0;
    this._quarter = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
    const { mw, mh } = this._mapSize(grid.w, grid.h);

    // Box is set in CSS custom properties so the responsive rules own the size, not JS.
    const cs = getComputedStyle(this.host);
    const boxW = parseFloat(cs.getPropertyValue('--mm-w')) || 190;
    const boxH = parseFloat(cs.getPropertyValue('--mm-h')) || 150;
    const cell = Math.max(2, Math.floor(Math.min(boxW / mw, boxH / mh) * 2) / 2);
    const key = `${grid.w}x${grid.h}:${this._quarter}:${cell}`;
    if (key !== this._geomKey) {
      this._geomKey = key;
      this._cell = cell;
      const dpr = Math.min(2, devicePixelRatio || 1);
      const pw = Math.round(mw * cell), ph = Math.round(mh * cell);
      for (const c of [this.canvas, this.terrain]) {
        c.width = Math.round(pw * dpr); c.height = Math.round(ph * dpr);
      }
      this.canvas.style.width = `${pw}px`;
      this.canvas.style.height = `${ph}px`;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.tctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this._terrainDirty = true;
    }
    return true;
  }

  // ------------------------------------------------------------------- terrain
  _drawTerrain() {
    const grid = this.game.grid;
    const c = this.tctx;
    const s = this._cell;
    const { mw, mh } = this._mapSize(grid.w, grid.h);
    c.clearRect(0, 0, mw * s, mh * s);

    for (let gz = 0; gz < grid.h; gz++) {
      for (let gx = 0; gx < grid.w; gx++) {
        const cell = grid.cell(gx, gz);
        if (!cell || cell.kind === 'void') continue;
        // A barricade sets `kind = 'wall'`; it is drawn on the dynamic layer in its own
        // colour so the player can tell what they built from what the level gave them.
        const fill = cell.blocker ? null
          : cell.kind === 'wall' ? C.wall
            : cell.kind === 'ledge' ? C.ledge
              : C.floor;
        if (!fill) continue;
        const p = this._project(gx, gz, grid.w, grid.h);
        c.fillStyle = fill;
        c.fillRect(p.x * s, p.y * s, s, s);
      }
    }
    this._terrainDirty = false;
  }

  // -------------------------------------------------------------------- routes
  /**
   * Steepest descent on the horde's own flow field. Any cell the field cannot reach
   * simply yields a short stub instead of an infinite loop.
   */
  _traceRoutes(gates) {
    const grid = this.game.grid;
    const out = [];
    if (!grid || !gates?.length) return out;
    let flow;
    try { flow = grid.riftFlow(); } catch { return out; }
    const limit = grid.w * grid.h;

    for (const gate of gates) {
      const path = [{ gx: gate.gx, gz: gate.gz }];
      let { gx, gz } = gate;
      let best = flow.distAt(gx, gz);
      if (!isFinite(best)) continue;
      for (let i = 0; i < limit; i++) {
        let nx = -1, nz = -1, nd = best;
        for (let dz = -1; dz <= 1; dz++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dz) continue;
            const d = flow.distAt(gx + dx, gz + dz);
            if (d < nd) { nd = d; nx = gx + dx; nz = gz + dz; }
          }
        }
        if (nx < 0) break;
        gx = nx; gz = nz; best = nd;
        path.push({ gx, gz });
        if (best <= 0) break;
      }
      out.push(path);
    }
    return out;
  }

  /** The gates this wave will actually open — build phase looks ahead, wave phase looks at now. */
  liveGates() {
    const d = this.game.director;
    if (!d) return { gates: [], laneCount: 0, index: 0 };
    const idx = d.running ? d.waveIndex : d.waveIndex + 1;
    const p = d.preview(idx);
    if (!p) return { gates: [], laneCount: 0, index: idx };
    return { gates: p.gates ?? [], laneCount: p.laneCount ?? p.gates?.length ?? 0, index: idx };
  }

  // --------------------------------------------------------------------- frame
  update(dt) {
    if (!this.enabled || this.host.classList.contains('hidden')) return;
    this._t -= dt;
    if (this._t > 0) return;
    this._t = 0.05;                    // 20 Hz is plenty for a 190px map
    this.draw();
  }

  draw() {
    const g = this.game;
    if (!g.grid || !this._fit()) return;
    if (this._terrainDirty) this._drawTerrain();

    const live = this.liveGates();
    if (this._routesDirty || !this.routes.length) {
      this.routes = this._traceRoutes(live.gates);
      this._routesDirty = false;
    }

    const grid = g.grid;
    const s = this._cell;
    const c = this.ctx;
    const { mw, mh } = this._mapSize(grid.w, grid.h);
    const px = (gx, gz) => {
      const p = this._project(gx, gz, grid.w, grid.h);
      return { x: p.x * s + s / 2, y: p.y * s + s / 2 };
    };

    c.clearRect(0, 0, mw * s, mh * s);
    c.drawImage(this.terrain, 0, 0, mw * s, mh * s);

    // --- the route the horde will walk ---------------------------------------
    c.lineWidth = Math.max(1.5, s * 0.5);
    c.lineJoin = 'round';
    c.lineCap = 'round';
    c.strokeStyle = C.route;
    for (const path of this.routes) {
      if (path.length < 2) continue;
      c.beginPath();
      const a = px(path[0].gx, path[0].gz);
      c.moveTo(a.x, a.y);
      for (let i = 1; i < path.length; i++) {
        const p = px(path[i].gx, path[i].gz);
        c.lineTo(p.x, p.y);
      }
      c.stroke();
    }

    // --- what you built -------------------------------------------------------
    for (const t of g.traps?.list ?? []) {
      if (t.destroyed) continue;
      const p = this._project(t.gx, t.gz, grid.w, grid.h);
      c.fillStyle = t.def.blocker ? C.blocker : t.def.guardian ? C.guardian : C.trap;
      const k = t.def.blocker ? s : Math.max(2, s * 0.62);
      c.fillRect(p.x * s + (s - k) / 2, p.y * s + (s - k) / 2, k, k);
    }

    // --- gates: live ones pulse, dormant ones sit ----------------------------
    const liveSet = new Set(live.gates.map((x) => `${x.gx},${x.gz}`));
    const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 260);
    for (const sp of grid.spawns ?? []) {
      const p = this._project(sp.gx, sp.gz, grid.w, grid.h);
      const on = liveSet.has(`${sp.gx},${sp.gz}`);
      c.fillStyle = on ? C.gateLive : C.gateIdle;
      c.globalAlpha = on ? pulse : 0.5;
      c.fillRect(p.x * s - s * 0.2, p.y * s - s * 0.2, s * 1.4, s * 1.4);
      c.globalAlpha = 1;
    }

    // --- rift -----------------------------------------------------------------
    for (const r of grid.rifts ?? []) {
      const p = px(r.gx, r.gz);
      c.fillStyle = C.rift;
      c.beginPath(); c.arc(p.x, p.y, Math.max(2.5, s * 0.85), 0, Math.PI * 2); c.fill();
      c.globalAlpha = 0.3;
      c.beginPath(); c.arc(p.x, p.y, Math.max(4, s * 1.6), 0, Math.PI * 2); c.fill();
      c.globalAlpha = 1;
    }

    // --- the horde ------------------------------------------------------------
    const cellOut = { gx: 0, gz: 0 };
    for (const e of g.enemies?.list ?? []) {
      if (e.dead || !e.position) continue;
      grid.toCell(e.position, cellOut);
      const p = px(cellOut.gx, cellOut.gz);
      c.fillStyle = C.enemy;
      c.fillRect(p.x - 1.4, p.y - 1.4, 2.8, 2.8);
    }

    // --- you ------------------------------------------------------------------
    const pl = g.player;
    if (pl?.position) {
      grid.toCell(pl.position, cellOut);
      const p = px(cellOut.gx, cellOut.gz);
      c.save();
      c.translate(p.x, p.y);
      c.rotate((pl.facing ?? 0) + this._quarter * (Math.PI / 2) + Math.PI);
      c.fillStyle = C.player;
      c.beginPath();
      c.moveTo(0, -5); c.lineTo(3.6, 4); c.lineTo(0, 2); c.lineTo(-3.6, 4);
      c.closePath(); c.fill();
      c.restore();
    }
  }
}
