/**
 * Tiny painting DSL for level maps. Hand-writing 24x18 ASCII blocks is error-prone and
 * impossible to tweak; painting rooms and corridors is both readable and editable.
 *
 *   makeMap(28, 20, [
 *     ['room', 2, 2, 10, 6],
 *     ['hall', 12, 5, 22, 5, 3],      // x0,z0 -> x1,z1 with width
 *     ['ring', 6, 6, 22, 16, 3],      // hollow loop corridor
 *     ['pillars', 8, 8, 20, 14, 3, 3],// hypostyle grid inside a hall
 *     ['spawn', 3, 3], ['rift', 24, 14],
 *     ['torch', 6, 1],
 *   ])
 *
 * Returns an array of strings consumable by Level._parseMap.
 *
 * Legend: '#' wall  '.' floor  'x' floor/no-build  '=' ledge  '~' pit
 *         'S' spawn 'R' rift   'T' torch wall      'C' floor/chokepoint
 */
export function makeMap(w, h, ops) {
  const g = Array.from({ length: h }, () => new Array(w).fill('#'));
  const set = (x, z, ch) => { if (x >= 0 && z >= 0 && x < w && z < h) g[z][x] = ch; };
  const get = (x, z) => (x >= 0 && z >= 0 && x < w && z < h ? g[z][x] : '#');
  const rect = (x0, z0, x1, z1, fn) => {
    for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
      for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++) fn(x, z);
  };

  for (const op of ops) {
    const [kind, ...a] = op;
    switch (kind) {
      case 'room': {
        const [x0, z0, x1, z1, ch = '.'] = a;
        rect(x0, z0, x1, z1, (x, z) => set(x, z, ch));
        break;
      }
      case 'hall': {
        const [x0, z0, x1, z1, width = 3, ch = '.'] = a;
        const half = Math.floor(width / 2);
        // L-shaped: horizontal leg then vertical leg.
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
          for (let d = -half; d <= half; d++) set(x, z0 + d, ch);
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
          for (let d = -half; d <= half; d++) set(x1 + d, z, ch);
        break;
      }
      case 'vhall': {
        const [x0, z0, x1, z1, width = 3, ch = '.'] = a;
        const half = Math.floor(width / 2);
        // Vertical leg first, then horizontal — the mirror of 'hall'.
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z++)
          for (let d = -half; d <= half; d++) set(x0 + d, z, ch);
        for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x++)
          for (let d = -half; d <= half; d++) set(x, z1 + d, ch);
        break;
      }
      /**
       * A hollow loop of corridor around a rectangle. This is the single most useful op
       * for making a map feel like Orcs Must Die rather than a hose: a ring gives the horde
       * two ways round and gives you a reason to pick which side to fortify.
       */
      case 'ring': {
        const [x0, z0, x1, z1, width = 3, ch = '.'] = a;
        const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
        const az = Math.min(z0, z1), bz = Math.max(z0, z1);
        rect(ax, az, bx, az + width - 1, (x, z) => set(x, z, ch));
        rect(ax, bz - width + 1, bx, bz, (x, z) => set(x, z, ch));
        rect(ax, az, ax + width - 1, bz, (x, z) => set(x, z, ch));
        rect(bx - width + 1, az, bx, bz, (x, z) => set(x, z, ch));
        break;
      }
      /**
       * Hypostyle grid of freestanding blocks inside an already-carved hall. Every block
       * is four buildable wall faces next to the route, which is what makes wall and
       * ceiling traps actually placeable in a big room instead of only in corridors.
       */
      case 'pillars': {
        const [x0, z0, x1, z1, stepX = 3, stepZ = 3, size = 1] = a;
        for (let z = Math.min(z0, z1); z <= Math.max(z0, z1); z += stepZ)
          for (let x = Math.min(x0, x1); x <= Math.max(x0, x1); x += stepX)
            rect(x, z, x + size - 1, z + size - 1, (px, pz) => set(px, pz, '#'));
        break;
      }
      case 'block': {
        const [x0, z0, x1, z1] = a;
        rect(x0, z0, x1, z1, (x, z) => set(x, z, '#'));
        break;
      }
      case 'pit': {
        const [x0, z0, x1, z1] = a;
        rect(x0, z0, x1, z1, (x, z) => set(x, z, '~'));
        break;
      }
      case 'nobuild': {
        const [x0, z0, x1, z1] = a;
        rect(x0, z0, x1, z1, (x, z) => { if (get(x, z) === '.') set(x, z, 'x'); });
        break;
      }
      case 'ledge': {
        const [x0, z0, x1, z1] = a;
        rect(x0, z0, x1, z1, (x, z) => set(x, z, '='));
        break;
      }
      /** Mark a tile the level designer considers the killbox. Cosmetic + hints only. */
      case 'choke': {
        const [x0, z0, x1 = x0, z1 = z0] = a;
        rect(x0, z0, x1, z1, (x, z) => { if (get(x, z) === '.' ) set(x, z, 'C'); });
        break;
      }
      case 'spawn': set(a[0], a[1], 'S'); break;
      case 'rift':  set(a[0], a[1], 'R'); break;
      case 'torch': set(a[0], a[1], 'T'); break;
      case 'wall':  set(a[0], a[1], '#'); break;
      case 'floor': set(a[0], a[1], '.'); break;
      default: console.warn('makeMap: unknown op', kind);
    }
  }

  // Border is always solid: nothing should ever path off the edge of the world.
  for (let x = 0; x < w; x++) { set(x, 0, '#'); set(x, h - 1, '#'); }
  for (let z = 0; z < h; z++) { set(0, z, '#'); set(w - 1, z, '#'); }

  autoTorch(g, w, h, get);
  return g.map((row) => row.join(''));
}

/**
 * Sprinkle torch walls on faces that front open floor, with a minimum spacing so a long
 * corridor gets a rhythm instead of a stripe. Corners are preferred: light at a turn is
 * what makes a route readable from the top-down camera.
 */
function autoTorch(g, w, h, get) {
  const placed = [];
  const MIN2 = 25;
  const score = (x, z) => {
    let open = 0, corner = 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (get(x + dx, z + dz) === '.') open++;
    // A wall block with floor on two perpendicular sides is an inside corner.
    if ((get(x + 1, z) === '.' || get(x - 1, z) === '.') && (get(x, z + 1) === '.' || get(x, z - 1) === '.')) corner = 1;
    return open ? open + corner * 2 : 0;
  };
  const cands = [];
  for (let z = 1; z < h - 1; z++)
    for (let x = 1; x < w - 1; x++)
      if (g[z][x] === '#') { const s = score(x, z); if (s) cands.push([s, x, z, (x * 37 + z * 91) % 17]); }
  cands.sort((a, b) => (b[0] - a[0]) || (a[3] - b[3]));
  for (const [, x, z] of cands) {
    let ok = true;
    for (const [px, pz] of placed) { const dx = px - x, dz = pz - z; if (dx * dx + dz * dz < MIN2) { ok = false; break; } }
    if (!ok) continue;
    placed.push([x, z]);
    g[z][x] = 'T';
  }
}
