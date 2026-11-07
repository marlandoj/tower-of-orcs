# Tower of Orcs — Architecture Contract

**Read this file before touching any code.** Every module owner writes only to the files they own.
Shared contracts below are frozen: if you need to change one, say so in your report instead of
editing another owner's file.

Target: a top-down 3D action tower-defense in the spirit of *Orcs Must Die!* — you are a character
on the field, you place traps between waves, and you fight alongside them during waves.

Stack: Three.js `^0.169` + Vite. Plain ES modules, no TypeScript, no build magic.
Run with `npm run dev` → http://127.0.0.1:5173

---

## 1. Coordinate system & units

- **World units**: 1 unit = 1 metre. Grid cell = `TILE = 4` units.
- **Y is up.** Floor sits at `y = 0`. Ceiling at `y = CEIL_H = 6`.
- Grid coordinate `(gx, gz)` maps to world centre `(gx * TILE + TILE/2, 0, gz * TILE + TILE/2)`
  via `Grid.toWorld()`. Never hand-roll this conversion.
- Camera is a third-person perspective rig following the player's position with independently controlled orbit heading, smooth yaw, adjustable zoom/pitch, and a collision-shortened camera boom. Movement turns the character without rotating the camera; deliberate aiming faces camera-forward.

## 2. Module ownership

| Path | Owner module | Responsibility |
|---|---|---|
| `src/core/**` | ENGINE | renderer, loop, camera, input, audio, pooling, math |
| `src/world/**` | WORLD | grid, level geometry/art, tilesets, pathfinding, rift |
| `src/entities/enemies/**` | ORCS | enemy roster, AI, abilities, models, animation |
| `src/entities/player/**` | PLAYER | player controller, weapons, spells, feel |
| `src/traps/**` | TRAPS | all traps + guardians, placement mode, upgrades |
| `src/director/**` | DIRECTOR | wave composition, 10 levels of difficulty, scoring/combo |
| `src/ui/**` | UI | HUD, menus, shop, results, level select, tutorial |
| `src/fx/**` | JUICE | particles, decals, gibs, screenshake, hitstop, audio design |

Shared, read-only for everyone: `src/core/**`, `src/shared/**`.

## 3. Core contracts (frozen)

### `Game` — the root context object

Every subsystem receives the single `game` object. It exposes:

```js
game.scene        // THREE.Scene
game.camera       // THREE.PerspectiveCamera
game.renderer     // THREE.WebGLRenderer
game.clock        // { dt, elapsed, frame }  dt is clamped, already time-scaled
game.input        // Input instance (see below)
game.audio        // Audio instance
game.grid         // Grid instance for the current level
game.level        // Level instance
game.player       // Player instance
game.enemies      // EnemyManager
game.traps        // TrapManager
game.director     // WaveDirector
game.fx           // FX facade
game.ui           // UI facade
game.bus          // EventBus
game.state        // 'menu' | 'build' | 'wave' | 'paused' | 'defeat' | 'victory'
game.simulating   // true only in 'build' | 'wave'. Simulation systems (player, enemies,
                  // traps, director) gate on this whitelist, never on a blacklist of states.
game.returnToMenu() // abandon the run (clears enemies, leaves build mode, shows the title)
game.rng          // seeded RNG: game.rng() -> [0,1)
```

### `EventBus`

```js
game.bus.on('enemy:killed', fn)   // fn(payload) -> void ; returns unsubscribe fn
game.bus.emit('enemy:killed', payload)
game.bus.off('enemy:killed', fn)
```

**Canonical events** (do not invent near-duplicates):

| Event | Payload |
|---|---|
| `level:load` | `{ levelIndex, level }` |
| `level:start` | `{ levelIndex }` |
| `wave:start` | `{ waveIndex, waveCount, composition }` |
| `wave:clear` | `{ waveIndex }` |
| `phase:build` | `{ nextWaveIndex }` |
| `enemy:spawn` | `{ enemy }` |
| `enemy:damaged` | `{ enemy, amount, source, crit, position }` |
| `enemy:killed` | `{ enemy, killer, position, byTrap, trapId }` |
| `enemy:leaked` | `{ enemy, cost }` — reached the rift |
| `rift:damaged` | `{ remaining, max }` |
| `trap:placed` | `{ trap }` |
| `trap:sold` | `{ trap, refund }` |
| `trap:triggered` | `{ trap, victims }` |
| `build:mode` | `{ on, selected }` — build mode toggled |
| `build:select` | `{ id }` — a different trap became the active brush |
| `trap:damaged` | `{ trap, amount, source, remaining }` |
| `trap:upgraded` | `{ trap, level, cost }` |
| `trap:destroyed` | `{ trap }` — wrecked by the horde, felled guardian, or collapsed barricade |
| `enemy:shield-broken` | `{ enemy, position }` |
| `engine:resize` | `{ w, h }` — canvas size in CSS pixels |
| `trap:combo` | `{ name, trap, enemy, bonus, position }` |
| `player:damaged` | `{ amount, remaining }` |
| `player:died` | `{}` |
| `player:weapon` | `{ id, index }` — active weapon changed |
| `player:spell` | `{ id, cooldown }` — spell cast; `cooldown` is the seconds until it is ready |
| `player:progression` | `{ points, ranks, gained?, bought? }` — points granted (`gained`), spent (`bought`), or reset |
| `combo:changed` | `{ combo, multiplier }` |
| `coin:changed` | `{ coin, delta, reason }` |
| `score:changed` | `{ score, delta }` |
| `game:victory` | `{ levelIndex, score, skulls }` |
| `game:defeat` | `{ levelIndex, reason }` |

### `Grid` (`src/world/Grid.js`)

```js
grid.w, grid.h                 // cells
grid.toWorld(gx, gz, out?)     // -> THREE.Vector3 at cell centre, y=0
grid.toCell(worldVec)          // -> { gx, gz } (may be out of bounds)
grid.inBounds(gx, gz)          // bool
grid.cell(gx, gz)              // -> Cell | null
grid.isWalkable(gx, gz)        // bool — floor and not blocked
grid.surfaces(gx, gz)          // -> { floor:bool, wall:[dirs], ceiling:bool }
grid.flowTo(gx, gz)            // -> flow field object for a target cell (cached)
```

`Cell` shape (frozen):

```js
{ gx, gz, kind: 'floor'|'wall'|'void'|'spawn'|'rift'|'ledge',
  height: 0,             // floor height in units
  cost: 1,               // pathing cost multiplier (tar = 3, etc.)
  floorTrap: Trap|null, wallTraps: {N,E,S,W}, ceilTrap: Trap|null,
  blocker: Trap|null,    // a placed Barricade; see below
  flags: Set<string> }   // 'no-build', 'lava', 'water', 'chokepoint'
```

**`blocker`** holds a placed Barricade. Placing one also sets `kind = 'wall'`, so every
pathing, collision and buildability query in the game treats the tile as solid without
needing to know barricades exist; removing it restores the previous `kind`. This is the
one object that lets the player *author the path* — see the Barricade note under §3 traps.

### Pathfinding

`src/world/Flow.js` exports `buildFlowField(grid, targets, opts)` returning
`{ dirAt(gx,gz) -> {x,z}, distAt(gx,gz) -> number }`. Enemies steer by sampling the flow field
plus local separation. **Never A*-per-enemy.** Flow field is rebuilt only when the walkable set or
cell costs change (`grid.markDirty()`), at most once per frame.

### Damage

All damage flows through `applyDamage(target, spec)` in `src/shared/Damage.js`:

```js
spec = { amount, type: 'physical'|'fire'|'ice'|'arcane'|'poison'|'lightning'|'crush',
         source, crit:false, knockback:{x,z,y}|null, statuses:[StatusSpec], position }
```

Resistances/immunities live on the enemy archetype (`resist: { fire: 0.5, crush: 0 }` where the
number is the *multiplier*, 0 = immune, 1 = normal, >1 = vulnerable).

Order inside the funnel: resistance → status multipliers → directional shield (skipped by
`crush`, which comes from above) → flat armour (`physical` only, floored at 15%). Trap damage
first passes through `trapDamage` in `src/traps/combos.js`, which applies combo multipliers and
the spellbook tier bonus (`src/shared/progression.js`) exactly once.

### Enemy archetype contract (`src/entities/enemies/roster.js`)

```js
{
  id: 'orc-grunt',
  name: 'Orc Grunt',
  tier: 1,
  hp: 60, speed: 3.2, radius: 0.55, mass: 1,
  damageToRift: 1,            // rift HP lost on leak
  coin: 25, score: 100,
  resist: {},                 // partial map, defaults to 1
  flags: [],                  // see below
  build(ctx) -> THREE.Object3D // procedural low-poly model, +Z forward, origin at feet
  ai: { update(enemy, game, dt) }   // optional override; defaults to flow-follow + melee
}
```

**Ability flags** (the "avoid traps and defenses" requirement):

`flying` (ignores floor traps & ground blockers), `leaper` (jumps gaps/tar and over floor traps),
`shielded` (frontal arc damage reduction, breakable), `armored` (flat reduction vs physical),
`trap-disarm` (destroys the floor trap it steps on), `fire-immune`, `frost-immune`,
`unstoppable` (immune to knockback/webs), `healer`, `buffer`, `ranged`, `summoner`,
`splitter` (spawns children on death), `stealth` (untargetable by guardians until it attacks),
`shielder` (grants team shield), `boss`.

### Trap contract (`src/traps/roster.js`)

```js
{
  id: 'spike-floor', name: 'Spike Floor',
  surface: 'floor'|'wall'|'ceiling'|'guardian'|'blocker',
  cost: 400, cooldown: 1.2, unlockLevel: 1,
  tags: ['physical','damage'],
  counters: ['armored','flying'],   // which enemy flags this answers — must be true, not aspirational
  cap: 12,                          // optional hard limit on simultaneous placements
  build(ctx) -> THREE.Object3D,
  onArm(trap, game), onTrigger(trap, game, victims), onTick(trap, game, dt)
}
```

**The Barricade is the genre's load-bearing object.** Non-blocking traps plus exactly one
scarce, expensive, destructible blocker is what keeps the player character necessary: if
you can freely wall the path off, the hero has nothing to do. It is therefore gated four
ways — late unlock, high cost, a hard cap, and destructibility — and `_wouldSeal` must
always keep every spawn able to reach the rift. Sappers and `unstoppable` units are its
counters and must stay able to break it.

**Damaging a trap from outside `src/traps/`:** call `TrapManager.wreck(trap, amount, source)`.
`TrapManager.destroy(trap)` means *"this is gone"*, not *"an orc hit it"* — calling it from
an enemy ability deletes a trap for free and bypasses its hp entirely.

Trap instances carry `{ def, gx, gz, dir, level, cooldownLeft, kills, enabled }`.

### FX facade (`src/fx/index.js`)

```js
fx.hit(position, normal, opts)     fx.blood(position, dir, amount)
fx.gib(enemy)                      fx.dust(position, r)
fx.shake(intensity, duration)      fx.hitstop(seconds)
fx.damageNumber(position, amount, kind)
fx.flash(color, duration)          fx.trail(obj, opts)
```

### UI facade (`src/ui/index.js`)

```js
ui.showHUD() ui.hideHUD() ui.toast(text, kind) ui.openShop() ui.closeShop()
ui.showResults(payload) ui.showLevelSelect() ui.setPhase(phase)
```

## 4. Performance budget

- 60 fps with **250 active enemies** on a mid laptop iGPU.
- Enemy meshes: merged geometry per archetype, shared materials.
  **≤ 1,300 tris standard / ≤ 1,600 boss at near LOD, ≤ 900 at far LOD; ≤ 5 draw calls near, 1 far.**

  > This budget was raised from a flat ≤400 tris after measurement. The original number was
  > the direct cause of a failed review: at 400 tris the orcs were featureless boxes, and a
  > blind critic comparing us to *Orcs Must Die!* found our models *punish* proximity —
  > the game looked better far away because distance hid the missing detail. Measured
  > worst case at the new budget is 1,594 draw calls / 494k tris / 9.14 ms with 250 orcs
  > all in frame, comfortably inside 16.6 ms.
  >
  > **Triangles are nearly free here; draw calls are the entire cost.** Spend polygons on
  > silhouette and face structure. Do not spend draw calls.
- No per-frame allocation in hot paths. Use `src/core/Pool.js` and the scratch vectors in
  `src/shared/scratch.js`.
- One `THREE.InstancedMesh` per repeated static prop (bricks, torches, banners).
- Shadows: a single directional light with a tight cascade box around the player.
- **The point-light count must never change during play.** three.js keys every lit program on
  it, so adding, removing or toggling `visible` on a light recompiles every lit material.
  Traps request light through `TrapLight` proxies served by a fixed `TrapLightPool`
  (`src/traps/parts.js`); pooled lights go dark with `intensity = 0`.
- Never raycast the merged level meshes per frame. They span the whole map, so bounding
  volumes reject nothing. Camera collision marches the grid instead (`boomHit` in
  `src/core/CameraRig.js`).
- Debug tooling (`src/core/Debug.js`, `window.__GAME__`, `window.dbg`) is installed only under
  `import.meta.env.DEV` and is absent from production builds.

## 5. Feel targets (the bar)

- Input → visible response ≤ 2 frames. Weapons fire on `pointerdown`, not on animation event.
- Every kill produces: hitstop (2–5 frames scaled by damage), blood, gibs or ragdoll, a sound with
  ±8% pitch variation, a floating number, and combo increment.
- Traps must read clearly *before* firing (arm tell) and *after* (spent state + cooldown ring).
- Camera: follow with lookahead toward the aim point, deadzone, and shake on impact.
