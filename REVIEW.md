# Tower of Orcs: Consolidated Review

Lead review of four specialist reports, all present: `reviews/bugs.md` (20 findings), `reviews/perf.md` (21), `reviews/architecture.md` (~30), `reviews/gameplay.md` (24). No reviewer failed.

> **How this review was produced.** A multi-model workshop campaign (`ws-2026-11-07-733e1db5`) ran four read-only specialist reviews in parallel: bugs by Codex, performance by Claude Code, architecture by Gemini, and gameplay/UX by Claude Code. A Claude Code lead reviewer then merged them, checked the claims against the code, and wrote this file. The four specialist reports are kept in the campaign workspace and are not committed here; references like "gameplay #24" or "architecture 1.8" point into them.
>
> These top findings were spot-checked a second time against commit `7d101fd` before committing, and the code matches:
> - Top-10 #1, #2, #3, #4, #5 and #8.
> - The watchdog double-count.
> - The Stalker reveal ordering.

Every critical and high finding was checked against the source at commit `7d101fd`, plus a sample of medium findings. Nothing was run or profiled. "Verified" means the mechanism was confirmed by reading the code.

Status labels:
- **CONFIRMED**: the code does what the finding says.
- **PLAUSIBLE**: the mechanism is in the code, but the cost or impact is an estimate, or I only partly traced it.
- **UNVERIFIED**: taken from the report and not opened by me (low or medium items only).
- **REJECTED**: see the [Rejected findings](#rejected-findings) section.

## Executive summary

**Overall health: Fair (amber).** The game is playable, and the core loop and code are carefully built. It needs a stabilization pass before it can be called polished.

- **Simulation bugs.** There are real correctness bugs in enemy simulation:
  - Enemies keep running after Quit or defeat.
  - Gargoyles can never enter the rift.
  - Archers do invisible 15 m melee through walls.
  - Stun and freeze don't stop pending attacks.
- **Rendering performance.** The two worst costs are self-inflicted and cheap to fix:
  - Trap point lights change the scene's light count, which forces shader recompiles.
  - The third-person camera raycasts every triangle of the merged level geometry every frame.
- **Gameplay.** Several purchases or claims don't do what they promise:
  - Spellbook tier 3.
  - The Spring Trap's level-3 ogre throw.
  - "Crush ignores armour".
  - Ceiling Pounder and Wall Blades as anti-air.
  - Controller support: a pad can't build or pause.
- **Balance.** Blood Shaman heals stack without limit, and Level 3 has the leanest economy in the campaign. That combination is the most likely place for players to bounce off.
- **Architecture.** Mostly sound, with documentation drift from `ARCHITECTURE.md`, a debug console shipped in production, and very large mixed-responsibility files. These raise maintenance cost but don't break the game.
- **Tests.** There are none, so every fix below should come with at least a headless unit test where it touches pure logic (`Damage.js`, `Scoring.js`, `Flow.js`, `Save.js`).

## Top 10 fixes

| # | Sev | Area | file:line | Issue | Fix | Status |
|---|---|---|---|---|---|---|
| 1 | High | Bugs | `src/entities/enemies/EnemyManager.js:272` (with `src/ui/index.js:339`, `src/Game.js:58`) | Enemy update only skips the `paused` state. After Quit (`state='menu'`) or defeat/victory, enemies keep moving and attacking and can reach the rift, which emits `game:defeat` over the title screen. Player (`Player.js:222`) and traps (`TrapManager.js:133`) guard `menu` only, so combat continues behind the results screen. | Whitelist simulation states (`build` and `wave`) in every system. Make Quit go through a `game.returnToMenu()` that clears enemies and traps. | CONFIRMED |
| 2 | Critical | Perf | `src/traps/roster.js:437`, `:979`, `:1239`, `:1441`; `src/traps/ghost.js:88-98`; `src/entities/player/projectiles.js:136-150` | Boom Barrel, Brimstone, Lightning Rod and Obelisk each create a `PointLight` in `build()`. The ghost preview keeps the light, because its traverse only swaps mesh materials. Projectile glow lights toggle `visible`. Every change in light count makes every lit material rebuild its shader program, causing hitches. | Use a fixed pool of trap lights created at level load, and turn lights off with `intensity=0`, never `visible`. Strip lights from ghost models. | CONFIRMED (hitch size PLAUSIBLE) |
| 3 | Critical | Perf | `src/core/CameraRig.js:454`; `src/core/Engine.js:186` | `intersectObjects(level.root.children, true)` runs every frame in third-person (`Player.js:331` always passes `viewHeading`). The merged floor, wall and decor meshes span the whole map, so the bounding-volume checks never skip anything and every triangle is tested in JS. | March the camera boom through the grid with a DDA over wall cells, or raycast a low-poly collision proxy. | CONFIRMED (ms cost PLAUSIBLE) |
| 4 | High | Bugs | `src/entities/enemies/Enemy.js:586-588`, `:290-293`; `src/entities/enemies/roster.js:371` | The archer's `attackRange: 15` is reused as melee reach (about 16 m). Its AI returns `false`, so the generic `_tryAttack` runs and `_resolveAttack` calls `takeDamage` directly, with no line-of-sight check, through walls. | Add a separate `meleeRange`. Ranged archetypes skip generic melee, or line of sight is required. | CONFIRMED |
| 5 | High | Bugs | `src/entities/enemies/Enemy.js:514`; `src/entities/enemies/roster.js:309`, `:328` | Rift contact uses a 3-unit 3D sphere at ground height. A cruising Gargoyle is at 3.4 ± 0.35, so it can never leak. It hovers until the watchdog culls it, and the wave stalls. | Test rift contact in the XZ plane, or use a vertical cylinder. | CONFIRMED |
| 6 | High | Gameplay | `src/entities/enemies/roster.js:144`; `src/entities/enemies/abilities.js:571-579`; `src/director/campaign.js:218-229` | Each Blood Shaman heals 18% of max HP to every ally within 9 m every 4.5 s. Heals stack, `pulse` excludes only the caster (so shamans heal each other), and nothing reduces healing. Level 3 waves 4–5 field 12–14 shamans in one lane. | Make heals non-stacking (a per-target `healedAt` lockout), heal other healers for half, and add an anti-heal status. | CONFIRMED (the ~16%/s figure is PLAUSIBLE) |
| 7 | High | Gameplay/Input | `src/core/Input.js:237-240`, `:206-215`; `src/ui/index.js:384-404` | The README advertises controller play, but nothing calls `pressed('build')` or `pressed('pause')`. Build mode, pause and trap selection are hard-coded DOM key checks. Start is bound to both `pause` and `startWave`. Gamepad edge state only updates when queried, so presses go stale. | Sample all pad buttons once per frame, route Tab, Esc and Digit keys through `Input` actions, and give `startWave` its own button. | CONFIRMED |
| 8 | High | Gameplay | `src/traps/TrapManager.js:410`; `src/ui/spellbook.js:19`, `:79`, `:115`; `src/traps/roster.js:63` | Spellbook tier 3 ("Mastered", 3 skulls) is clamped to tier 2 at placement, so it does nothing. The UI says +35% per tier, but `power()` gives +45%. | Set `MAX_TIER=2` or give tier 3 a real effect, and derive `tierBonus` from `power()`. | CONFIRMED |
| 9 | High | Gameplay | `src/traps/roster.js:71`, `:104` (hit helpers), `:481-626` (Pounder), `:840-942` (Blades) | The README names wall and ceiling traps as the answer to Gargoyles. Pounder and Blades never pass `airborne:true` or `sense.air`, so they can't hit or even trigger on flyers. Gargoyle `resist.crush` is unused data. | Give the Pounder an airborne hit radius and Blades reduced damage against air, or correct the README and threat text. | CONFIRMED |
| 10 | Med | Bugs/Gameplay | `src/traps/combos.js:182`; `src/traps/roster.js:827` | The Spring Trap's level-3 "throws ogres too" is a no-op: `onTrigger` lets unstoppable enemies through, but `launch()` immediately returns `false` for them. `counters: ['unstoppable']` is also false. (Reported by both bugs #9 and gameplay #5.) | Pass a `force` flag from a level-3 spring into `launch()`, or drop the counter and rewrite the upgrade note. | CONFIRMED |

## Bugs

| Sev | file:line | Issue | Fix | Status |
|---|---|---|---|---|
| Med | `src/entities/enemies/Enemy.js:270-273`, `:282-284` | Pending hits resolve, and archetype AI runs, before the `stunned`/`rooted` early return. Stunned grunts finish their swing, stunned archers fire, and Sappers keep chewing. | Apply crowd control first, and cancel `pendingHit` on stun or freeze. | CONFIRMED |
| Med | `src/core/Save.js:10`, `:30` | The save is shallow-merged with no validation. `{"best":null}` makes `best()` and `recordResult()` throw. Partial `settings` or `player` objects survive, and `upgrades.js:84-87` patches only some fields. Downgraded from High: it needs corrupted or tampered storage. | Normalize the full schema on load with deep defaults and finite-number checks. | CONFIRMED |
| Med | `src/entities/player/spells.js:128` (with `src/core/Pool.js:38-43`) | Arcane Lance iterates the swap-remove `ActiveList` forwards while kills remove entries, so the enemy swapped into a killed enemy's slot is skipped. | Snapshot victims before applying damage, or iterate backwards. | CONFIRMED |
| Med | `src/entities/enemies/abilities.js:247`, `:277`; `Enemy.spawn` (`src/entities/enemies/Enemy.js:46-90`) | `slamT` is never reset on spawn, so a pooled Ogre that died mid-windup resumes the old slam in its next life. | Reset ability-owned transient fields in `spawn()`, or add archetype reset hooks. | CONFIRMED (grep shows no reset) |
| Med | `src/traps/TrapManager.js:880-895`, `:759` | Guardians lose HP to a synthetic proximity DPS from nearby melee orcs and from ranged orcs within 14 m, including through walls and from stunned orcs. They also take the real hits from `_resolveAttack` and arrows (`EnemyManager.js:347`), so damage is counted twice. Overlaps architecture 1.8: this path also bypasses `wreck()` and never emits `trap:damaged`. | Keep one authoritative damage path and route it through `wreck()` or `damageGuardian`. | CONFIRMED |
| Med | `src/traps/TrapManager.js:153-157`; `src/traps/roster.js:563-568` | A frozen trap still calls `rig.tick`, and the Pounder's tick calls `def.impact()` when the block lands. A frozen Pounder that was mid-drop still deals damage. | Skip gameplay-bearing ticks while frozen, or move impact into the trap state machine. | CONFIRMED |
| Med | `src/traps/TrapManager.js:1007` | For wall traps, `_existingFor` falls back to any wall trap on the tile. Clicking a free second wall mount upgrades the existing trap instead of placing a new one. | Only fall back in sell or inspect contexts. | CONFIRMED |
| Med | `src/director/WaveDirector.js:411`, `:433` | The watchdog adds `dt` between probes and another `+1.0` at each failed probe, so stall time runs about 2× real time. The 20 s nudge and 45 s cull fire at about 10 s and 23 s. | Accumulate time only once. | CONFIRMED |
| Med | `src/entities/player/weapons.js:247-255` | The Blunderbuss cone ignores walls, so it can hit through cover. | Reuse the crossbow's grid ray test. | CONFIRMED |
| Med | `src/traps/combos.js:190-208` (with `src/entities/enemies/Enemy.js:491-495`) | Spring-into-pit kills are decided at launch from an unobstructed trajectory. If a wall bounces the enemy, it still takes 100,000 damage on safe floor. | Resolve pit entry from the actual landing cell. | CONFIRMED |
| Med | `src/entities/enemies/roster.js:507` (with `Enemy.js:609`) | The Stalker's 2.5× ambush needs `stealthed && pendingHit>0`, but `_tryAttack` reveals the Stalker in the same call that sets `pendingHit`. The bonus never applies. | Snapshot the multiplier when the attack is committed. | CONFIRMED |
| Med | `src/traps/roster.js:70-71` (with `src/entities/enemies/roster.js:228-234`) | Floor traps check only the permanent `airborne` flag, so a leaping Gnoll mid-jump still takes tar, burn and spike damage. | Require ground contact (`position.y` or a `leapT` check) for floor traps. | PLAUSIBLE |
| Low | `src/traps/TrapManager.js:939-943` | `damageGuardian` doesn't reject a destroyed guardian, so a second pending blow re-runs `_guardianDeath`. | Return early if `trap.destroyed`, and make death idempotent. | CONFIRMED |
| Low | `src/director/Scoring.js:231-233` | The "three different traps" chain bonus only resets on an immediate repeat, so A-B-A pays it. | Track distinct trap IDs in the chain. | CONFIRMED |
| Low | `src/entities/player/upgrades.js:98-104` | `_award` returns early once a level is claimed, so a 4-skull bonus point can't be earned on a replay (gameplay #9). | Track the clear point and the skull point separately per level. | CONFIRMED |
| Low | `src/core/Input.js:238` | `interact` and `reload` share pad button 2, and `R` is bound to both reload and rotate (gameplay #22). Rotating a trap mid-wave starts a reload. | Gate reload while in build mode, and dedupe the bindings. | CONFIRMED |

## Performance

| Sev | file:line | Issue | Fix | Status |
|---|---|---|---|---|
| High | `src/entities/enemies/models.js:1168-1219`; `EnemyManager.js:73-80` | Each orc is 5–8 meshes (torso, arms, legs, wings, far LOD). `ARCHITECTURE.md` records about 1,594 draw calls for 250 orcs. | Render through one `InstancedMesh` or `BatchedMesh` per archetype and node, and use a per-instance attribute for hit flash. | CONFIRMED (structure); a large refactor |
| High | `src/entities/enemies/EnemyManager.js:78`, `:128-131` | Pooled and retired orcs stay in the scene with `visible=false`, so `updateMatrixWorld` still walks them every frame. Pools are never trimmed. | Remove from the scene on retire and re-add on take, or disable `matrixAutoUpdate`. Trim pools on `level:load`. | CONFIRMED (ms cost PLAUSIBLE) |
| High | `src/fx/Particles.js:126-131`; `src/fx/index.js:28-29` | Any emit marks all four attributes dirty with no update range, so the full 6k or 4k slot buffer re-uploads. Brimstone emits almost every frame. | Upload only the written min–max range, interleave the attributes, and cap `instanceCount`. | CONFIRMED |
| Med-High | `src/ui/index.js:587`, `:600` | `void el.offsetWidth` on every coin or combo change forces a synchronous layout per kill, so multi-kills thrash layout. | Coalesce updates into `ui.update()` and restart animations with the Web Animations API. | CONFIRMED |
| Med | `src/traps/TrapManager.js:401` | Every trap mesh casts and receives shadows, including additive glow quads. Rings and pips are created per trap. | Cast shadows only from opaque meshes, and instance rings and pips. | UNVERIFIED |
| Med | `src/entities/enemies/EnemyManager.js:218-228` | `queryRadius`, the main trap-damage query, does an O(N) scan, sorts, and allocates. It ignores the spatial hash beside it. | Build it on `queryNear`, sort only when needed, and take an out-array. | CONFIRMED |
| Med | `src/entities/enemies/EnemyManager.js:152-159` | Spatial hash buckets are re-allocated every frame. | Reuse the arrays, or use a flat counting-sort grid. | CONFIRMED |
| Med | `src/entities/enemies/Enemy.js:591-597` | `_pickTarget` scans the whole trap list for guardians for every idle orc, every frame. | Keep a `traps.guardians` array. | CONFIRMED |
| Med | `src/traps/TrapManager.js:889` | Each guardian runs a 14 m `queryNear` (225 buckets) every frame, plus closures in `nearest()`. Fixing the guardian-damage bug above removes most of this. | Throttle the query and keep a per-frame list of ranged enemies. | CONFIRMED (code at :889) |
| Med | `src/core/Engine.js:21-29` | `antialias:true` and `preserveDrawingBuffer:true` on the default framebuffer, though the composer has its own MSAA target. The comment says it exists for review capture. | Turn both on only under a debug or capture flag. | CONFIRMED |
| Med | `src/ui/index.js:1007`, `:975-981`; `src/ui/loadout.js:45-83` | HUD `innerHTML` and style writes happen every frame whether or not values changed. Overlaps architecture 2.2 and 3.1: the HUD polls the player instead of using the `player:*` events. | Diff against the last written value, or drive updates from events. | UNVERIFIED |
| Med | `src/world/Level.js:814-822`, `:617-621` | The shadow map re-renders the whole level every frame because the sun follows the player. `wall-occluder` duplicates the wall-tops silhouette and is drawn in the colour pass. | Snap the shadow camera to texel steps and update shadows on demand; use layers for the occluder. | UNVERIFIED |
| Low-Med | `src/world/Textures.js:17-22`, `:661` | The palette-keyed texture cache is never released, and `disposeTextureCache` has no callers. That is about 5 MB of GPU memory per distinct level palette. (Also architecture 4.4.) | Reference-count the cache or evict palette-specific entries on `loadLevel`. Keep the palette-free textures. | CONFIRMED |
| Low-Med | `src/fx/index.js:959-960` | Damage numbers read `clientWidth` and `clientHeight` every frame, and write two style strings per number. | Cache the size on `engine:resize`. | UNVERIFIED |
| Low | `src/ui/minimap.js:109-111` | `getComputedStyle` is called at 20 Hz, plus allocations per point drawn. | Read the box size on resize only. | UNVERIFIED |
| Low | `src/entities/enemies/EnemyManager.js:137`, `:318`, `:368` | `splice` in per-frame loops, and an object literal per enemy arrow. | Swap-remove and add a free list. | CONFIRMED |
| Low | `src/shared/EventBus.js:26` | `Array.from(set)` on every emit. | Cache the listener array with copy-on-write. | UNVERIFIED |
| Low | `src/traps/ghost.js:117-121` | The build ghost traverses its model and reassigns materials every frame. | Only reassign when the mode changes. | UNVERIFIED |
| Low | `src/entities/enemies/rig.js:82` | `reset()` allocates a node array on every spawn. | Iterate `this.limbs`. | UNVERIFIED |

## Architecture

| Sev | file:line | Issue | Fix | Status |
|---|---|---|---|---|
| Med | `src/Game.js:15`, `:61`; `src/core/Debug.js:412`; `src/main.js:8` | `installDebug` and `window.__GAME__` ship unconditionally (cheats, automation, a `fetch('/__shot')` to a dev-only endpoint). Downgraded from High; see the rejected "security" framing below. | Guard with `import.meta.env.DEV` and a dynamic import. | CONFIRMED |
| Med | `src/entities/enemies/abilities.js:189` (comment at `:172-187`; `src/traps/TrapManager.js:574`) | `wreckTrap` still clamps blocker damage to `hp-1`, a workaround for `destroy()` skipping barricade collapse. `destroy()` now routes blockers to `_barricadeCollapse`, so the clamp and its comment are stale. Enemy hits can never deal the killing blow to a barricade. (Also gameplay #23.) | Delete the clamp and call `traps.wreck()` directly. | CONFIRMED |
| Med | `src/entities/player/Player.js:184`, `:200`; `src/entities/player/spells.js:204` | `player:damaged`, `player:died` and `player:spell` are emitted but have no listeners, while the UI polls the same data every frame (`src/ui/index.js:974-985`). | Have the HUD and loadout subscribe to the events. | CONFIRMED |
| Med | `src/ui/index.js:339`; `src/ui/settings.js:52`; `src/ui/spellbook.js:15` | The UI mutates `game.state` and raw `save.data` directly. That direct `state` write is the root cause of top-10 #1. | Add `Game.returnToMenu()` and domain methods on `Save`. | CONFIRMED (`:339`) |
| Low | `ARCHITECTURE.md:86` vs `src/Game.js:89-96` | The canonical `level:start` event is never emitted. Nothing listens for it either. | Emit it, or remove it from the contract. | CONFIRMED |
| Low | `ARCHITECTURE.md` §3 vs `src/shared/Damage.js:57`, `src/traps/TrapManager.js:580`, `:502`, `src/core/Engine.js:128` | Undocumented events: `enemy:shield-broken`, `trap:destroyed`, `trap:upgraded`, `engine:resize`. | Document them. | CONFIRMED (`:580`) |
| Low | `ARCHITECTURE.md:102-103` vs `src/entities/player/spells.js:204`, `src/entities/player/upgrades.js:105` | Payload drift: `cooldown` is emitted instead of `remaining`, and `bought` is missing from `player:progression`. | Align the code or the document. | CONFIRMED (upgrades) |
| Low | `ARCHITECTURE.md:51`, `:54` vs `src/entities/enemies/roster.js`, `src/traps/roster.js:125-1513` | The documentation says 17 archetypes and 16 traps. The code has 17 traps (14 traps plus 3 guardians), and the review counts 21 enemy archetypes. | Update the document. | CONFIRMED (traps); PLAUSIBLE (enemy count) |
| Low | `src/entities/enemies/EnemyManager.js:185`, `:363`; `src/entities/enemies/Enemy.js:491`; `src/director/WaveDirector.js:421`; `src/traps/combos.js:194` (and others) | Cell coordinates are hand-rolled as `Math.floor(x/4)` instead of `grid.toCell()`, against `ARCHITECTURE.md` §1. Downgraded from High: `TILE` is a frozen constant. | Add a `grid.cellOf(x,z)` helper and replace the call sites over time. | CONFIRMED |
| Low | `src/world/Grid.js:2` and `src/world/Flow.js:11` | Circular import between `Grid.js` and `Flow.js`. It's harmless today because `TILE` is only read inside functions (`Flow.js:106`). Downgraded from High. | Move `TILE`, `DIRS` and the other shared constants into `src/world/constants.js`. | CONFIRMED |
| Low | `src/traps/roster.js` (1,529 lines), `src/fx/index.js` (1,155), `src/ui/index.js` (1,041), `src/entities/enemies/models.js` (1,234), `src/world/Decor.js` (1,106) | Large files that mix data, mesh building, rigs and behaviour. Trap and enemy stats can't be loaded headlessly without Three.js (architecture 5.x and 6.1). | Split data from models and behaviour, starting with `src/traps/roster.js` so balance numbers can be tested. | CONFIRMED (sizes); this is a maintainability opinion, not a defect |
| Low | `src/director/WaveDirector.js:4`; `src/director/WaveComposer.js:2` | The director imports the full enemy `ROSTER`, which pulls in the model builders. | Extract an enemy stats module. | PLAUSIBLE |
| Low | `src/shared/EventBus.js:1-33` | Event names are raw strings with no typo safety. | Add a frozen `EVENTS` map and a dev-time assertion. | CONFIRMED |
| Info | the repo as a whole (no test files) | There are no automated tests. | Add Vitest. Start with `src/shared/Damage.js`, `src/director/Scoring.js`, `src/world/Flow.js`, `src/core/Save.js` and `TrapManager._wouldSeal`. | CONFIRMED |

## Gameplay & UX

| Sev | file:line | Issue | Fix | Status |
|---|---|---|---|---|
| Med | `src/shared/Damage.js:62-64`; `src/traps/roster.js:21`; `src/ui/threat.js:20`, `:126` | "Crush ignores armour" appears in three places, but flat armour applies to `crush`. The code comment at `:62` even says "physical only". The Pounder loses 21% against the Orc King. | Exempt crush from flat armour, or fix the text. | CONFIRMED |
| Med | `src/director/campaign.js` (L3 `:218-229`); `src/world/LevelDefs.js:515-877` | The difficulty curve isn't monotonic. Level 3 has the lowest coin per enemy HP (0.19 start coin / 0.68 total coin per HP), and total HP falls from level 3 to 5. This compounds the shaman problem (top-10 #6). | Trim Level 3 waves 4–5 or raise its `startCoin` to about 5,000. | PLAUSIBLE (numbers come from the reviewer's script) |
| Med | `src/shared/Damage.js:45-60`; `src/traps/roster.js:79` (`position: w`) | Directional shields measure the hit origin from the tile centre, so a Shieldbearer that hasn't reached the centre blocks 90% of Pounder and floor-trap damage. | Let vertical and crush hits bypass directional shields. | PLAUSIBLE |
| Med | `src/director/WaveDirector.js:214-230`, `:86` | The early-start bonus is never shown before it pays out. The wave-1 clock starts at level load, against a 16 s par, so the wave-1 bonus is effectively always 0. | Add a draining bonus meter next to START WAVE, and start the clock on the first trap placed. | PLAUSIBLE |
| Med | `src/ui/index.js:400-404`; `src/traps/TrapManager.js:99-102` | Digit keys 1–9 reach only the first 9 of 17 traps, leaving every late-game trap mouse-only. | Add a pre-level loadout, or Shift+digit and wheel cycling. | CONFIRMED (`:400-404`) |
| Med | `src/traps/TrapManager.js:976-990`, `:514` | Left-click on an existing trap upgrades it instantly and right-click sells at 70%, with no undo, even for a trap placed seconds ago. | Full refund during the same build phase, a confirm or separate key for upgrades, and Ctrl+Z. | PLAUSIBLE |
| Med | `src/traps/TrapManager.js:410-416`, `:473` | HP is only restored by `upgrade()`, so level-3 traps (including every spellbook tier-2 trap) can never be repaired. | Heal traps on `phase:build`, or add a paid repair. | PLAUSIBLE |
| Med | `src/traps/roster.js:125-197`, `:1017-1088` | Spike Floor does about 12.6 DPS per 100 coin, roughly 2× any other trap. Grinder is worse until level 3. | Raise Spike's cost to about 550, and give Grinder a level-1 niche. | PLAUSIBLE (the arithmetic checks against the costs at `:126`, `:1018`) |
| Med | `src/entities/player/weapons.js:211-223` | The crossbow sustains about 195 DPS (38 × 1.234 / 0.24) for free, with infinite ammo, hits air, and outclasses the early traps. | Bring it down to about 110–130 DPS, or add damage falloff beyond about 18 m. | CONFIRMED (arithmetic) |
| Med | `src/traps/TrapManager.js:410`; `src/ui/spellbook.js` | Spellbook tier 2 places a 400-coin Spike at level 3 (normally 1,240 coin), which flattens the in-level economy. | Make tiers modest, or have them discount in-level upgrades instead of granting levels. | CONFIRMED (mechanism) |
| Med | `src/ui/settings.js:7-15`; `src/core/Input.js:69`, `:88`; `src/traps/ghost.js:23-25` | Missing accessibility options: no remap UI (and hard-coded keys would bypass one anyway), no colourblind cues for placement (green/red), no reduce-flashes, no camera sensitivity, and no auto-pause on window blur. Blur only clears input. | Route hotkeys through `Input.binds` and add these settings. | CONFIRMED (blur at `:88`) |
| Low | `src/traps/roster.js:944`, `:1093`; `src/director/campaign.js:303` | Brimstone and Ice Vent unlock on the same level that introduces the enemy immune to them. | Unlock each one a level earlier. | CONFIRMED (`unlockLevel` 5 and 7) |
| Low | `src/ui/tutorial.js:14-49` | The tutorial never covers camera orbit, spells, upgrading, or the early-start bonus. | Add those steps. | UNVERIFIED |
| Low | `src/ui/threat.js:20`, `:27-29`, `:51`, `:141` | Threat-panel text is wrong in places: the Sapper eats every floor trap it stands on, not just the first, and the `buffer` flag is labelled "Warchanter". | Fix the strings. | UNVERIFIED |
| Low | `src/traps/roster.js:206`, `:289-292`, `:408`, `:474`, `:306`, `:384` | Several upgrade notes overpromise: Tar levels 2 and 3, Boom Barrel upgrades lost on detonation, Arrow Wall level 3 "pierce armour". | Make the notes match the code, or the code match the notes. | UNVERIFIED |
| Low | `src/director/campaign.js:710`, `:745`; `src/director/Difficulty.js:373`; `src/traps/TrapManager.js:53` | Stale tuning comments: "twelve rift", "+95% income", "Sappers from level 5". | Update the comments. | UNVERIFIED |
| Low | `README.md:26` controls table vs `src/core/Input.js:8-31` | The README omits F/C/V, M, Shift+wheel and Alt+wheel. `KeyE` (`interact`) is bound but nothing reads it. | Complete the table, and use E for upgrade. | PLAUSIBLE |

## Rejected findings

| Source | file:line | Claim | Why rejected |
|---|---|---|---|
| gameplay #24 | `src/entities/enemies/roster.js:230` | "Leapers don't jump tar" | The reviewer's own evidence shows the hazard test includes `c.floorTrap`, and Tar is a floor trap, so leapers do hop it. There's no behavioural defect, only a design note about native terrain cost. |
| arch 4.2 | `src/director/devHarness.js:1-4` | The orphaned harness "fails with 404 in production" | The file header says it's dev-only and loaded from the console on the dev server, so this is working as designed. Moving it to `tools/` is optional tidying. |
| arch 4.1 (part) | `src/Game.js:61` | `window.dbg` is a security issue | The game is single-player with localStorage saves, no server scoring and no leaderboard, so a player could get the same result by editing localStorage. The bundle-hygiene part is kept (Medium, above). |
| arch 4.4 (fix) | `src/world/Textures.js:661` | "Call `disposeTextureCache()` in `Level.dispose()`" | That would also dispose the palette-free shared textures (glow, web, portal, runes) every level. The finding is kept, but with the targeted eviction fix from perf #15. |
| arch 3.2 (part) | `src/core/Engine.js:128`; `src/traps/TrapManager.js:502` | Dead events "incur dispatch overhead" | Emitting to an event with no listeners costs one Map lookup, which is negligible. The documentation-drift part is kept. |
| arch 1.7 (part) | `src/fx/index.js:203` | Passing an enemy to `fx.gib` "triggers runtime exceptions" | `pos.x` on an enemy object is just `undefined`, which gives NaN positions rather than an exception, and every caller passes a Vector3 anyway. This is documentation drift only. |
| arch 2.1, 1.3, 5.x, 6.1 (severity) | `src/world/Grid.js:2`; `src/world/Flow.js:11`; others above | Rated High | The cycle is harmless: Flow only reads `TILE` inside functions (`Flow.js:106`). `TILE` is a frozen constant, and file size is a maintainability preference. All four are kept at Low. |
| bugs #4 (severity) | `src/core/Save.js:10` | Rated High | It only triggers on corrupted or hand-edited storage. Kept at Medium. |
| arch §7 Priority 1 sample | `src/shared/Damage.js:62-64` | The test example `expect(dealt).toBe(15)` | It doesn't match the funnel's real order (shield first, then armour with a 15% floor). It's illustrative only and shouldn't be copied into a real test. |

## Suggested next steps

1. **Stabilization patch** for top-10 items 1, 4 and 5, plus the stun ordering (`src/entities/enemies/Enemy.js:270-284`) and the watchdog double-count (`src/director/WaveDirector.js:411`). These are small and local, and fixing them removes the wave-stalling and unfair-damage reports.
2. **Performance quick wins**, each roughly a one-file change:
   - Fixed trap-light pool: `src/traps/roster.js:437` and the three other light sites.
   - Grid-DDA camera boom: `src/core/CameraRig.js:454`.
   - Particle update ranges: `src/fx/Particles.js:126`.
   - Coalesced HUD bumps: `src/ui/index.js:587`.
   - Renderer flags: `src/core/Engine.js:21-29`.

   Then profile a 250-orc wave before starting the instancing refactor (`src/entities/enemies/models.js:1168`).
3. **"Promises kept" pass**:
   - Spellbook tier 3 (`src/traps/TrapManager.js:410`).
   - Spring `force` launch (`src/traps/combos.js:182`).
   - Crush vs armour (`src/shared/Damage.js:63`).
   - Anti-air for the Pounder and Blades (`src/traps/roster.js:481`, `:840`).
   - Threat and upgrade text.
4. **Balance**: non-stacking shaman heals (`src/entities/enemies/abilities.js:571`), retune Level 3, then re-run `src/director/devHarness.js` with realistic spellbook tiers.
5. **Input layer**:
   - Route all gameplay keys and pad buttons through `src/core/Input.js` (per-frame pad sampling at `:206`, a dedicated `startWave` button at `:239`).
   - Add a rebind UI and auto-pause on blur.
6. **Hygiene**:
   - Gate `installDebug` behind DEV (`src/Game.js:61`).
   - Delete the stale barricade clamp (`src/entities/enemies/abilities.js:189`).
   - Wire up the `player:*` events.
   - Reconcile `ARCHITECTURE.md`.
   - Add Vitest suites for `src/shared/Damage.js`, `src/director/Scoring.js`, `src/core/Save.js` and `src/world/Flow.js`.
